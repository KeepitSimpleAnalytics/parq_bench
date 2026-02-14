use arrow_array::{ArrayRef, Int64Array, RecordBatch, StringArray};
use arrow_ipc::writer::StreamWriter;
use arrow_schema::{DataType, Field, Schema};
use duckdb::Connection;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::fs;
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use sysinfo::System;
use tauri::Manager;
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[derive(Serialize)]
struct SmokeRow {
    id: i64,
    label: String,
}

#[derive(Serialize)]
struct SmokeQueryResponse {
    duckdb_version: String,
    rows: Vec<SmokeRow>,
}

#[derive(Serialize)]
struct SocketServerInfo {
    url: String,
    payload_bytes: usize,
}

#[derive(Serialize)]
struct ParquetSchemaColumn {
    name: String,
    duckdb_type: String,
}

#[derive(Serialize)]
struct ParquetPreviewResponse {
    file_path: String,
    file_size_bytes: u64,
    total_rows: u64,
    row_offset: u64,
    row_limit: u32,
    schema: Vec<ParquetSchemaColumn>,
    rows: Vec<Vec<Option<String>>>,
}

#[derive(Serialize)]
struct ParquetRowsPage {
    row_offset: u64,
    row_limit: u32,
    rows: Vec<Vec<Option<String>>>,
}

#[derive(Serialize)]
struct ParquetRowsTransportResponse {
    row_offset: u64,
    row_limit: u32,
    row_count: usize,
    payload_bytes: usize,
    mode: String,
    ipc_payload: Option<Vec<u8>>,
    socket_url: Option<String>,
}

const INLINE_IPC_MAX_BYTES: usize = 1_000_000;
const PANIC_RSS_RATIO: f64 = 0.85;
const DUCKDB_MEMORY_CAP_BYTES: u64 = 24 * 1024 * 1024 * 1024;
const BYTES_PER_MIB: u64 = 1024 * 1024;

struct AppRuntimeState {
    memory_guard_tripped: AtomicBool,
    process_rss_bytes: AtomicU64,
    total_memory_bytes: AtomicU64,
}

impl AppRuntimeState {
    fn new() -> Self {
        Self {
            memory_guard_tripped: AtomicBool::new(false),
            process_rss_bytes: AtomicU64::new(0),
            total_memory_bytes: AtomicU64::new(0),
        }
    }
}

#[derive(Serialize)]
struct RuntimeHealthResponse {
    memory_guard_tripped: bool,
    process_rss_bytes: u64,
    total_memory_bytes: u64,
    usage_ratio: f64,
    message: Option<String>,
}

fn compute_duckdb_threads(cpu_cores: usize) -> usize {
    let scaled = ((cpu_cores as f64) * 0.6).floor() as usize;
    scaled.max(2)
}

fn compute_duckdb_memory_limit_bytes(total_memory_bytes: u64) -> u64 {
    if total_memory_bytes == 0 {
        return 1024 * 1024 * 1024;
    }
    (((total_memory_bytes as f64) * 0.75) as u64)
        .max(512 * 1024 * 1024)
        .min(DUCKDB_MEMORY_CAP_BYTES)
}

fn detect_total_memory_bytes() -> u64 {
    let mut system = System::new();
    system.refresh_memory();
    system.total_memory()
}

fn log_perf(event: &str, details: &str) {
    eprintln!("event={event} {details}");
}

fn open_configured_duckdb(state: &AppRuntimeState) -> Result<Connection, String> {
    let conn = Connection::open_in_memory().map_err(|e| format!("open DuckDB: {e}"))?;
    let cpu_cores = thread::available_parallelism()
        .map(|parallelism| parallelism.get())
        .unwrap_or(2);
    let threads = compute_duckdb_threads(cpu_cores);

    let observed_total = state.total_memory_bytes.load(Ordering::Relaxed);
    let total_memory_bytes = if observed_total > 0 {
        observed_total
    } else {
        detect_total_memory_bytes()
    };
    let memory_limit_bytes = compute_duckdb_memory_limit_bytes(total_memory_bytes);
    let memory_limit_mib = (memory_limit_bytes / BYTES_PER_MIB).max(1);

    conn.execute_batch(&format!(
        "PRAGMA threads = {threads}; PRAGMA memory_limit = '{memory_limit_mib}MiB';"
    ))
    .map_err(|e| format!("configure DuckDB pragmas: {e}"))?;

    log_perf(
        "duckdb_config",
        &format!(
            "threads={} cpu_cores={} memory_limit_mib={} total_memory_bytes={}",
            threads, cpu_cores, memory_limit_mib, total_memory_bytes
        ),
    );

    Ok(conn)
}

fn escape_sql_string_literal(value: &str) -> String {
    value.replace('\\', "/").replace('\'', "''")
}

fn escape_sql_ident(value: &str) -> String {
    value.replace('"', "\"\"")
}

fn parquet_schema(conn: &Connection, source: &str) -> Result<Vec<ParquetSchemaColumn>, String> {
    let schema_sql = format!("DESCRIBE SELECT * FROM {source}");
    let mut schema_stmt = conn
        .prepare(&schema_sql)
        .map_err(|e| format!("prepare schema query: {e}"))?;
    let schema_iter = schema_stmt
        .query_map([], |row| {
            Ok(ParquetSchemaColumn {
                name: row.get(0)?,
                duckdb_type: row.get(1)?,
            })
        })
        .map_err(|e| format!("run schema query: {e}"))?;
    schema_iter
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect schema rows: {e}"))
}

fn parquet_total_rows(conn: &Connection, normalized_path: &str, source: &str) -> u64 {
    let metadata_sql = format!(
        "SELECT COALESCE(SUM(num_rows), 0)::UBIGINT FROM parquet_metadata('{normalized_path}')"
    );
    if let Ok(rows) = conn.query_row(&metadata_sql, [], |row| row.get::<_, u64>(0)) {
        return rows;
    }

    let fallback_sql = format!("SELECT COUNT(*)::UBIGINT FROM {source}");
    conn.query_row(&fallback_sql, [], |row| row.get::<_, u64>(0))
        .unwrap_or(0)
}

fn parquet_rows_page(
    conn: &Connection,
    source: &str,
    schema: &[ParquetSchemaColumn],
    row_offset: u64,
    row_limit: u32,
) -> Result<Vec<Vec<Option<String>>>, String> {
    let projection = schema
        .iter()
        .map(|col| {
            let ident = escape_sql_ident(&col.name);
            format!("CAST(\"{ident}\" AS VARCHAR) AS \"{ident}\"")
        })
        .collect::<Vec<_>>()
        .join(", ");

    let preview_sql = format!(
        "SELECT {projection} FROM {source} LIMIT {} OFFSET {}",
        row_limit.max(1),
        row_offset
    );
    let mut preview_stmt = conn
        .prepare(&preview_sql)
        .map_err(|e| format!("prepare preview query: {e}"))?;

    let col_count = schema.len();
    let preview_iter = preview_stmt
        .query_map([], |row| {
            let mut values = Vec::with_capacity(col_count);
            for idx in 0..col_count {
                let value: Option<String> = row.get(idx)?;
                values.push(value);
            }
            Ok(values)
        })
        .map_err(|e| format!("run preview query: {e}"))?;
    preview_iter
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect preview rows: {e}"))
}

fn rows_to_arrow_ipc(
    schema: &[ParquetSchemaColumn],
    rows: &[Vec<Option<String>>],
) -> Result<Vec<u8>, String> {
    let arrow_schema = Arc::new(Schema::new(
        schema
            .iter()
            .map(|col| Field::new(&col.name, DataType::Utf8, true))
            .collect::<Vec<_>>(),
    ));

    let mut columns: Vec<ArrayRef> = Vec::with_capacity(schema.len());
    for col_idx in 0..schema.len() {
        let values = rows.iter().map(|row| row.get(col_idx).and_then(|value| value.as_deref()));
        let array = StringArray::from_iter(values);
        columns.push(Arc::new(array) as ArrayRef);
    }

    let batch = RecordBatch::try_new(Arc::clone(&arrow_schema), columns)
        .map_err(|e| format!("build parquet arrow batch: {e}"))?;

    let mut cursor = Cursor::new(Vec::<u8>::new());
    let mut writer = StreamWriter::try_new(&mut cursor, &arrow_schema)
        .map_err(|e| format!("create parquet IPC writer: {e}"))?;
    writer
        .write(&batch)
        .map_err(|e| format!("write parquet IPC batch: {e}"))?;
    writer
        .finish()
        .map_err(|e| format!("finish parquet IPC stream: {e}"))?;

    Ok(cursor.into_inner())
}

fn ensure_memory_guard_clear(state: &AppRuntimeState) -> Result<(), String> {
    if state.memory_guard_tripped.load(Ordering::Relaxed) {
        return Err(
            "Memory protection active: process RSS exceeded 85% of physical memory. Query blocked."
                .to_string(),
        );
    }
    Ok(())
}

fn spawn_memory_monitor(state: Arc<AppRuntimeState>) {
    thread::spawn(move || {
        let mut system = System::new_all();
        let pid = sysinfo::get_current_pid().ok();

        loop {
            system.refresh_memory();
            system.refresh_processes(sysinfo::ProcessesToUpdate::All, false);

            let total = system.total_memory();
            let process_rss = pid
                .and_then(|proc_pid| system.process(proc_pid))
                .map(|process| process.memory())
                .unwrap_or(0);

            state.total_memory_bytes.store(total, Ordering::Relaxed);
            state
                .process_rss_bytes
                .store(process_rss, Ordering::Relaxed);

            let ratio = if total > 0 {
                process_rss as f64 / total as f64
            } else {
                0.0
            };
            state
                .memory_guard_tripped
                .store(ratio >= PANIC_RSS_RATIO, Ordering::Relaxed);

            thread::sleep(Duration::from_secs(1));
        }
    });
}

#[tauri::command]
fn runtime_health(state: tauri::State<'_, Arc<AppRuntimeState>>) -> RuntimeHealthResponse {
    let process_rss_bytes = state.process_rss_bytes.load(Ordering::Relaxed);
    let total_memory_bytes = state.total_memory_bytes.load(Ordering::Relaxed);
    let memory_guard_tripped = state.memory_guard_tripped.load(Ordering::Relaxed);
    let usage_ratio = if total_memory_bytes > 0 {
        process_rss_bytes as f64 / total_memory_bytes as f64
    } else {
        0.0
    };

    RuntimeHealthResponse {
        memory_guard_tripped,
        process_rss_bytes,
        total_memory_bytes,
        usage_ratio,
        message: if memory_guard_tripped {
            Some(
                "Memory panic circuit engaged: active operations blocked because RSS exceeded 85%."
                    .to_string(),
            )
        } else {
            None
        },
    }
}

fn build_arrow_ipc_payload(size_mb: u32) -> Result<Vec<u8>, String> {
    let target_bytes = (size_mb.max(1) as usize) * 1024 * 1024;
    let rows = ((target_bytes as f64) / 1032.0).ceil() as usize;
    let label = "x".repeat(1024);
    let id_values = Int64Array::from_iter_values(0..rows as i64);
    let label_values = StringArray::from_iter_values((0..rows).map(|_| label.as_str()));

    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("label", DataType::Utf8, false),
    ]));

    let batch = RecordBatch::try_new(
        Arc::clone(&schema),
        vec![Arc::new(id_values), Arc::new(label_values)],
    )
    .map_err(|e| format!("build record batch: {e}"))?;

    let mut cursor = Cursor::new(Vec::<u8>::new());
    let mut writer = StreamWriter::try_new(&mut cursor, &schema)
        .map_err(|e| format!("create IPC writer: {e}"))?;
    writer
        .write(&batch)
        .map_err(|e| format!("write IPC batch: {e}"))?;
    writer.finish().map_err(|e| format!("finish IPC stream: {e}"))?;

    Ok(cursor.into_inner())
}

#[tauri::command]
fn duckdb_smoke_query(state: tauri::State<'_, Arc<AppRuntimeState>>) -> Result<SmokeQueryResponse, String> {
    ensure_memory_guard_clear(state.as_ref())?;
    let started = Instant::now();
    let conn = open_configured_duckdb(state.as_ref())?;
    let duckdb_version: String = conn
        .query_row("SELECT version()", [], |row| row.get(0))
        .map_err(|e| format!("query DuckDB version: {e}"))?;

    let mut stmt = conn
        .prepare("SELECT id, label FROM (VALUES (1, 'alpha'), (2, 'beta'), (3, 'gamma')) t(id, label)")
        .map_err(|e| format!("prepare smoke query: {e}"))?;

    let mapped_rows = stmt
        .query_map([], |row| {
            Ok(SmokeRow {
                id: row.get(0)?,
                label: row.get(1)?,
            })
        })
        .map_err(|e| format!("run smoke query: {e}"))?;

    let rows = mapped_rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect smoke rows: {e}"))?;
    log_perf(
        "duckdb_smoke_query",
        &format!(
            "duration_ms={} rows={}",
            started.elapsed().as_millis(),
            rows.len()
        ),
    );

    Ok(SmokeQueryResponse {
        duckdb_version,
        rows,
    })
}

#[tauri::command]
fn arrow_ipc_smoke_batch(state: tauri::State<'_, Arc<AppRuntimeState>>) -> Result<Vec<u8>, String> {
    ensure_memory_guard_clear(state.as_ref())?;
    let started = Instant::now();
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("label", DataType::Utf8, false),
    ]));
    let batch = RecordBatch::try_new(
        Arc::clone(&schema),
        vec![
            Arc::new(Int64Array::from(vec![1_i64, 2, 3])),
            Arc::new(StringArray::from(vec!["alpha", "beta", "gamma"])),
        ],
    )
    .map_err(|e| format!("build smoke batch: {e}"))?;

    let mut cursor = Cursor::new(Vec::<u8>::new());
    let mut writer = StreamWriter::try_new(&mut cursor, &schema)
        .map_err(|e| format!("create IPC writer: {e}"))?;

    writer
        .write(&batch)
        .map_err(|e| format!("write IPC batch: {e}"))?;
    writer.finish().map_err(|e| format!("finish IPC stream: {e}"))?;
    let payload = cursor.into_inner();
    log_perf(
        "arrow_ipc_smoke_batch",
        &format!(
            "duration_ms={} payload_bytes={}",
            started.elapsed().as_millis(),
            payload.len()
        ),
    );

    Ok(payload)
}

#[tauri::command]
fn arrow_ipc_payload(
    size_mb: u32,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<Vec<u8>, String> {
    ensure_memory_guard_clear(state.as_ref())?;
    let started = Instant::now();
    let payload = build_arrow_ipc_payload(size_mb)?;
    log_perf(
        "arrow_ipc_payload",
        &format!(
            "duration_ms={} size_mb={} payload_bytes={}",
            started.elapsed().as_millis(),
            size_mb,
            payload.len()
        ),
    );
    Ok(payload)
}

#[tauri::command]
fn preview_parquet(
    file_path: String,
    row_limit: u32,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<ParquetPreviewResponse, String> {
    ensure_memory_guard_clear(state.as_ref())?;
    let started = Instant::now();
    let file_size_bytes = fs::metadata(&file_path)
        .map_err(|e| format!("read file metadata: {e}"))?
        .len();
    let normalized = escape_sql_string_literal(&file_path);
    let source = format!("read_parquet('{normalized}')");
    let conn = open_configured_duckdb(state.as_ref())?;
    let total_rows = parquet_total_rows(&conn, &normalized, &source);
    let schema = parquet_schema(&conn, &source)?;
    let row_offset = 0_u64;
    let row_limit = row_limit.max(1);
    let rows = parquet_rows_page(&conn, &source, &schema, row_offset, row_limit)?;
    log_perf(
        "preview_parquet",
        &format!(
            "duration_ms={} file_size_bytes={} schema_cols={} rows={}",
            started.elapsed().as_millis(),
            file_size_bytes,
            schema.len(),
            rows.len()
        ),
    );

    Ok(ParquetPreviewResponse {
        file_path,
        file_size_bytes,
        total_rows,
        row_offset,
        row_limit,
        schema,
        rows,
    })
}

#[tauri::command]
fn fetch_parquet_rows(
    file_path: String,
    row_offset: u64,
    row_limit: u32,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<ParquetRowsPage, String> {
    ensure_memory_guard_clear(state.as_ref())?;
    let started = Instant::now();
    let normalized = escape_sql_string_literal(&file_path);
    let source = format!("read_parquet('{normalized}')");
    let conn = open_configured_duckdb(state.as_ref())?;
    let schema = parquet_schema(&conn, &source)?;
    let rows = parquet_rows_page(&conn, &source, &schema, row_offset, row_limit.max(1))?;
    log_perf(
        "fetch_parquet_rows",
        &format!(
            "duration_ms={} row_offset={} row_limit={} rows={}",
            started.elapsed().as_millis(),
            row_offset,
            row_limit.max(1),
            rows.len()
        ),
    );

    Ok(ParquetRowsPage {
        row_offset,
        row_limit: row_limit.max(1),
        rows,
    })
}

async fn start_socket_server_for_payload(payload: Vec<u8>) -> Result<SocketServerInfo, String> {
    let payload_bytes = payload.len();
    let chunk_size = 1024 * 1024;
    let chunk_count = payload_bytes.div_ceil(chunk_size);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind websocket listener: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("read listener addr: {e}"))?
        .port();
    let url = format!("ws://127.0.0.1:{port}");
    log_perf(
        "socket_payload_server_start",
        &format!(
            "url={} payload_bytes={} chunk_count={}",
            url, payload_bytes, chunk_count
        ),
    );

    tauri::async_runtime::spawn(async move {
        let send_started = Instant::now();
        let accept_result = listener.accept().await;
        let (stream, _) = match accept_result {
            Ok(ok) => ok,
            Err(err) => {
                eprintln!("socket accept error: {err}");
                return;
            }
        };

        let ws_stream = match accept_async(stream).await {
            Ok(ws) => ws,
            Err(err) => {
                eprintln!("websocket handshake error: {err}");
                return;
            }
        };

        let (mut write, _) = ws_stream.split();
        for chunk in payload.chunks(chunk_size) {
            if let Err(err) = write.send(Message::Binary(chunk.to_vec().into())).await {
                eprintln!("websocket send error: {err}");
                return;
            }
        }

        if let Err(err) = write.close().await {
            eprintln!("websocket close error: {err}");
        }
        log_perf(
            "socket_payload_server_complete",
            &format!(
                "duration_ms={} payload_bytes={} chunk_count={}",
                send_started.elapsed().as_millis(),
                payload_bytes,
                chunk_count
            ),
        );
    });

    Ok(SocketServerInfo { url, payload_bytes })
}

#[tauri::command]
async fn fetch_parquet_rows_transport(
    file_path: String,
    row_offset: u64,
    row_limit: u32,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<ParquetRowsTransportResponse, String> {
    ensure_memory_guard_clear(state.as_ref())?;
    let started = Instant::now();
    let normalized = escape_sql_string_literal(&file_path);
    let source = format!("read_parquet('{normalized}')");
    let conn = open_configured_duckdb(state.as_ref())?;
    let safe_limit = row_limit.max(1);
    let schema = parquet_schema(&conn, &source)?;
    let rows = parquet_rows_page(&conn, &source, &schema, row_offset, safe_limit)?;
    let row_count = rows.len();
    let payload = rows_to_arrow_ipc(&schema, &rows)?;
    let payload_bytes = payload.len();

    if payload_bytes < INLINE_IPC_MAX_BYTES {
        log_perf(
            "fetch_parquet_rows_transport",
            &format!(
                "duration_ms={} mode=ipc row_offset={} row_limit={} row_count={} payload_bytes={}",
                started.elapsed().as_millis(),
                row_offset,
                safe_limit,
                row_count,
                payload_bytes
            ),
        );
        Ok(ParquetRowsTransportResponse {
            row_offset,
            row_limit: safe_limit,
            row_count,
            payload_bytes,
            mode: "ipc".to_string(),
            ipc_payload: Some(payload),
            socket_url: None,
        })
    } else {
        let socket = start_socket_server_for_payload(payload).await?;
        log_perf(
            "fetch_parquet_rows_transport",
            &format!(
                "duration_ms={} mode=socket row_offset={} row_limit={} row_count={} payload_bytes={}",
                started.elapsed().as_millis(),
                row_offset,
                safe_limit,
                row_count,
                payload_bytes
            ),
        );
        Ok(ParquetRowsTransportResponse {
            row_offset,
            row_limit: safe_limit,
            row_count,
            payload_bytes,
            mode: "socket".to_string(),
            ipc_payload: None,
            socket_url: Some(socket.url),
        })
    }
}

#[tauri::command]
async fn start_arrow_socket_server(
    size_mb: u32,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<SocketServerInfo, String> {
    ensure_memory_guard_clear(state.as_ref())?;
    let started = Instant::now();
    let payload = build_arrow_ipc_payload(size_mb)?;
    let payload_bytes = payload.len();
    let result = start_socket_server_for_payload(payload).await;
    if result.is_ok() {
        log_perf(
            "start_arrow_socket_server",
            &format!(
                "duration_ms={} size_mb={} payload_bytes={}",
                started.elapsed().as_millis(),
                size_mb,
                payload_bytes
            ),
        );
    }
    result
}

#[tauri::command]
fn write_text_report(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents).map_err(|e| format!("write report file: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{
        compute_duckdb_memory_limit_bytes, compute_duckdb_threads, escape_sql_string_literal,
        open_configured_duckdb, parquet_rows_page, parquet_schema, parquet_total_rows,
        start_socket_server_for_payload, AppRuntimeState, DUCKDB_MEMORY_CAP_BYTES,
    };
    use futures_util::StreamExt;
    use std::fs;
    use std::io::ErrorKind;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::runtime::Builder;

    #[test]
    fn thread_formula_matches_spec() {
        assert_eq!(compute_duckdb_threads(1), 2);
        assert_eq!(compute_duckdb_threads(2), 2);
        assert_eq!(compute_duckdb_threads(8), 4);
        assert_eq!(compute_duckdb_threads(16), 9);
    }

    #[test]
    fn memory_limit_respects_fraction_and_cap() {
        let eight_gib = 8_u64 * 1024 * 1024 * 1024;
        assert_eq!(compute_duckdb_memory_limit_bytes(eight_gib), six_gib());
        let one_hundred_gib = 100_u64 * 1024 * 1024 * 1024;
        assert_eq!(
            compute_duckdb_memory_limit_bytes(one_hundred_gib),
            DUCKDB_MEMORY_CAP_BYTES
        );
    }

    fn six_gib() -> u64 {
        6_u64 * 1024 * 1024 * 1024
    }

    #[test]
    fn parquet_read_path_returns_expected_schema_rows_and_total() {
        let state = AppRuntimeState::new();
        let conn = open_configured_duckdb(&state).expect("open configured duckdb");
        let temp_file = unique_test_parquet_path();
        let escaped_path = escape_sql_string_literal(&temp_file);

        conn.execute_batch(&format!(
            "COPY (
                SELECT 1::BIGINT AS id, 'alpha'::VARCHAR AS label
                UNION ALL
                SELECT 2::BIGINT AS id, 'beta'::VARCHAR AS label
                UNION ALL
                SELECT 3::BIGINT AS id, 'gamma'::VARCHAR AS label
            ) TO '{escaped_path}' (FORMAT PARQUET);"
        ))
        .expect("write parquet fixture");

        let source = format!("read_parquet('{escaped_path}')");
        let schema = parquet_schema(&conn, &source).expect("load parquet schema");
        assert_eq!(schema.len(), 2);
        assert_eq!(schema[0].name, "id");
        assert_eq!(schema[1].name, "label");

        let total_rows = parquet_total_rows(&conn, &escaped_path, &source);
        assert_eq!(total_rows, 3);

        let rows = parquet_rows_page(&conn, &source, &schema, 0, 10).expect("load parquet rows");
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0][0].as_deref(), Some("1"));
        assert_eq!(rows[0][1].as_deref(), Some("alpha"));
        assert_eq!(rows[2][0].as_deref(), Some("3"));
        assert_eq!(rows[2][1].as_deref(), Some("gamma"));

        let _ = fs::remove_file(&temp_file);
    }

    #[test]
    fn socket_transport_delivers_full_payload_integrity() {
        let payload_size = 3 * 1024 * 1024 + 17;
        let payload: Vec<u8> = (0..payload_size).map(|idx| (idx % 251) as u8).collect();

        let runtime = Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build tokio runtime");

        runtime.block_on(async {
            let server = start_socket_server_for_payload(payload.clone())
                .await
                .expect("start socket payload server");
            assert_eq!(server.payload_bytes, payload.len());

            let (mut ws_stream, _) = tokio_tungstenite::connect_async(&server.url)
                .await
                .expect("connect websocket");

            let mut received = Vec::<u8>::new();
            while let Some(message) = ws_stream.next().await {
                let message = match message {
                    Ok(msg) => msg,
                    Err(tokio_tungstenite::tungstenite::Error::Io(err))
                        if err.kind() == ErrorKind::ConnectionAborted
                            || err.kind() == ErrorKind::ConnectionReset
                            || err.kind() == ErrorKind::BrokenPipe =>
                    {
                        break;
                    }
                    Err(err) => panic!("read websocket message: {err}"),
                };
                if message.is_binary() {
                    received.extend_from_slice(&message.into_data());
                }
            }

            assert_eq!(received.len(), payload.len());
            assert_eq!(received, payload);
        });
    }

    fn unique_test_parquet_path() -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let thread_id = format!("{:?}", std::thread::current().id());
        let mut path = std::env::temp_dir();
        path.push(format!("parq_bench_test_{nanos}_{thread_id}.parquet"));
        path.to_string_lossy().to_string()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let runtime_state = Arc::new(AppRuntimeState::new());

    tauri::Builder::default()
        .manage(Arc::clone(&runtime_state))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state = app.state::<Arc<AppRuntimeState>>().inner().clone();
            spawn_memory_monitor(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            duckdb_smoke_query,
            arrow_ipc_smoke_batch,
            arrow_ipc_payload,
            runtime_health,
            preview_parquet,
            fetch_parquet_rows,
            fetch_parquet_rows_transport,
            start_arrow_socket_server,
            write_text_report
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
