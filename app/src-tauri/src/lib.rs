use arrow_array::{ArrayRef, Int64Array, RecordBatch, StringArray};
use arrow_ipc::writer::StreamWriter;
use arrow_schema::{DataType, Field, Schema};
use duckdb::Connection;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
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

#[derive(Clone)]
struct FlattenedColumn {
    name: String,
    duckdb_type: String,
    select_expr: String,
}

#[derive(Clone)]
struct WorkspaceTableRegistration {
    alias: String,
    file_path: String,
    is_glob: bool,
}

#[derive(Serialize)]
struct WorkspaceTableInfo {
    alias: String,
    file_path: String,
    is_glob: bool,
    file_size_bytes: Option<u64>,
}

#[derive(Serialize)]
struct WorkspaceQueryResponse {
    sql: String,
    row_limit: u32,
    row_count: usize,
    truncated: bool,
    elapsed_ms: u128,
    schema: Vec<ParquetSchemaColumn>,
    rows: Vec<Vec<Option<String>>>,
}

#[derive(Serialize)]
struct WorkspaceExportResponse {
    sql: String,
    format: String,
    output_path: String,
    file_size_bytes: u64,
    elapsed_ms: u128,
}

#[derive(Serialize)]
struct WorkspaceSchemaDiffColumn {
    name: String,
    left_type: Option<String>,
    right_type: Option<String>,
    change: String,
}

#[derive(Serialize)]
struct WorkspaceSchemaDiffResponse {
    left_alias: String,
    right_alias: String,
    added_count: usize,
    removed_count: usize,
    type_changed_count: usize,
    unchanged_count: usize,
    columns: Vec<WorkspaceSchemaDiffColumn>,
}

const INLINE_IPC_MAX_BYTES: usize = 1_000_000;
const PANIC_RSS_RATIO: f64 = 0.85;
const DUCKDB_MEMORY_CAP_BYTES: u64 = 24 * 1024 * 1024 * 1024;
const BYTES_PER_MIB: u64 = 1024 * 1024;

struct AppRuntimeState {
    memory_guard_tripped: AtomicBool,
    process_rss_bytes: AtomicU64,
    total_memory_bytes: AtomicU64,
    workspace_tables: Mutex<Vec<WorkspaceTableRegistration>>,
}

impl AppRuntimeState {
    fn new() -> Self {
        Self {
            memory_guard_tripped: AtomicBool::new(false),
            process_rss_bytes: AtomicU64::new(0),
            total_memory_bytes: AtomicU64::new(0),
            workspace_tables: Mutex::new(Vec::new()),
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

fn escape_sql_literal(value: &str) -> String {
    value.replace('\'', "''")
}

fn is_struct_duckdb_type(duckdb_type: &str) -> bool {
    duckdb_type
        .trim()
        .to_ascii_uppercase()
        .starts_with("STRUCT(")
}

fn is_collection_duckdb_type(duckdb_type: &str) -> bool {
    let upper = duckdb_type.trim().to_ascii_uppercase();
    upper.starts_with("LIST(")
        || upper.starts_with("MAP(")
        || upper.starts_with("ARRAY(")
        || upper.starts_with("UNION(")
        || upper.contains("[]")
}

fn split_top_level(input: &str, separator: char) -> Vec<String> {
    let mut parts = Vec::<String>::new();
    let mut current = String::new();
    let mut paren_depth = 0_i32;
    let mut angle_depth = 0_i32;
    let mut bracket_depth = 0_i32;
    let mut in_quotes = false;
    let chars = input.chars().peekable();

    for ch in chars {
        if in_quotes {
            current.push(ch);
            if ch == '"' {
                in_quotes = false;
            }
            continue;
        }

        match ch {
            '"' => {
                in_quotes = true;
                current.push(ch);
            }
            '(' => {
                paren_depth += 1;
                current.push(ch);
            }
            ')' => {
                paren_depth -= 1;
                current.push(ch);
            }
            '<' => {
                angle_depth += 1;
                current.push(ch);
            }
            '>' => {
                angle_depth -= 1;
                current.push(ch);
            }
            '[' => {
                bracket_depth += 1;
                current.push(ch);
            }
            ']' => {
                bracket_depth -= 1;
                current.push(ch);
            }
            _ if ch == separator && paren_depth == 0 && angle_depth == 0 && bracket_depth == 0 => {
                parts.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(ch),
        }
    }

    if !current.trim().is_empty() {
        parts.push(current.trim().to_string());
    }
    parts
}

fn parse_struct_fields(duckdb_type: &str) -> Option<Vec<(String, String)>> {
    let trimmed = duckdb_type.trim();
    let upper = trimmed.to_ascii_uppercase();
    if !upper.starts_with("STRUCT(") || !trimmed.ends_with(')') {
        return None;
    }
    let inner = &trimmed[7..trimmed.len() - 1];
    let parts = split_top_level(inner, ',');
    let mut fields = Vec::<(String, String)>::new();

    for part in parts {
        if part.is_empty() {
            continue;
        }
        let part_trimmed = part.trim();
        if part_trimmed.starts_with('"') {
            let mut name = String::new();
            let mut chars = part_trimmed[1..].chars().peekable();
            let mut consumed = 1_usize;
            while let Some(ch) = chars.next() {
                consumed += ch.len_utf8();
                if ch == '"' {
                    if chars.peek() == Some(&'"') {
                        name.push('"');
                        chars.next();
                        consumed += 1;
                        continue;
                    }
                    break;
                }
                name.push(ch);
            }
            if consumed >= part_trimmed.len() {
                return None;
            }
            let field_type = part_trimmed[consumed..].trim();
            if field_type.is_empty() {
                return None;
            }
            fields.push((name, field_type.to_string()));
            continue;
        }

        let split_idx = part_trimmed
            .find(char::is_whitespace)
            .unwrap_or(part_trimmed.len());
        if split_idx == part_trimmed.len() {
            return None;
        }
        let field_name = part_trimmed[..split_idx].trim();
        let field_type = part_trimmed[split_idx..].trim();
        if field_name.is_empty() || field_type.is_empty() {
            return None;
        }
        fields.push((field_name.to_string(), field_type.to_string()));
    }

    Some(fields)
}

fn describe_columns(conn: &Connection, describe_sql: &str, context: &str) -> Result<Vec<ParquetSchemaColumn>, String> {
    let mut schema_stmt = conn
        .prepare(describe_sql)
        .map_err(|e| format!("prepare {context}: {e}"))?;
    let schema_iter = schema_stmt
        .query_map([], |row| {
            Ok(ParquetSchemaColumn {
                name: row.get(0)?,
                duckdb_type: row.get(1)?,
            })
        })
        .map_err(|e| format!("run {context}: {e}"))?;
    schema_iter
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect {context}: {e}"))
}

fn append_flattened_column(
    conn: &Connection,
    source: &str,
    column_expr: &str,
    column_name: &str,
    duckdb_type: &str,
    flattened: &mut Vec<FlattenedColumn>,
) -> Result<(), String> {
    if is_struct_duckdb_type(duckdb_type) {
        let Some(children) = parse_struct_fields(duckdb_type) else {
            flattened.push(FlattenedColumn {
                name: column_name.to_string(),
                duckdb_type: "VARCHAR".to_string(),
                select_expr: format!("CAST({column_expr} AS VARCHAR)"),
            });
            return Ok(());
        };

        for (child_name, child_type) in children {
            let child_literal = escape_sql_literal(&child_name);
            let child_expr = format!("struct_extract({column_expr}, '{child_literal}')");
            let child_qualified_name = format!("{column_name}.{child_name}");
            append_flattened_column(
                conn,
                source,
                &child_expr,
                &child_qualified_name,
                &child_type,
                flattened,
            )?;
        }
        return Ok(());
    }

    if is_collection_duckdb_type(duckdb_type) {
        flattened.push(FlattenedColumn {
            name: column_name.to_string(),
            duckdb_type: "VARCHAR".to_string(),
            select_expr: format!("CAST({column_expr} AS VARCHAR)"),
        });
        return Ok(());
    }

    flattened.push(FlattenedColumn {
        name: column_name.to_string(),
        duckdb_type: duckdb_type.to_string(),
        select_expr: column_expr.to_string(),
    });
    Ok(())
}

fn flattened_columns_for_source(conn: &Connection, source: &str) -> Result<Vec<FlattenedColumn>, String> {
    let root_describe_sql = format!("DESCRIBE SELECT * FROM {source}");
    let root_schema = describe_columns(conn, &root_describe_sql, "source schema query")?;
    let mut flattened = Vec::<FlattenedColumn>::new();
    for column in root_schema {
        let root_ident = escape_sql_ident(&column.name);
        let root_expr = format!("\"{root_ident}\"");
        append_flattened_column(
            conn,
            source,
            &root_expr,
            &column.name,
            &column.duckdb_type,
            &mut flattened,
        )?;
    }
    Ok(flattened)
}

fn flattened_projection_sql(columns: &[FlattenedColumn], cast_to_varchar: bool) -> String {
    columns
        .iter()
        .map(|column| {
            let ident = escape_sql_ident(&column.name);
            if cast_to_varchar {
                format!("CAST({} AS VARCHAR) AS \"{ident}\"", column.select_expr)
            } else {
                format!("{} AS \"{ident}\"", column.select_expr)
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn parquet_schema(conn: &Connection, source: &str) -> Result<Vec<ParquetSchemaColumn>, String> {
    let flattened = flattened_columns_for_source(conn, source)?;
    Ok(flattened
        .into_iter()
        .map(|column| ParquetSchemaColumn {
            name: column.name,
            duckdb_type: column.duckdb_type,
        })
        .collect::<Vec<_>>())
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
    let flattened = flattened_columns_for_source(conn, source)?;
    let flattened_map = flattened
        .iter()
        .map(|column| (column.name.clone(), column.select_expr.clone()))
        .collect::<BTreeMap<_, _>>();
    let projection = schema
        .iter()
        .map(|col| {
            let ident = escape_sql_ident(&col.name);
            let expr = flattened_map
                .get(&col.name)
                .cloned()
                .unwrap_or_else(|| format!("\"{ident}\""));
            format!("CAST({expr} AS VARCHAR) AS \"{ident}\"")
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

fn normalize_single_sql_statement(sql: &str) -> Result<String, String> {
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return Err("SQL query is required.".to_string());
    }

    let normalized = trimmed.trim_end_matches(';').trim().to_string();
    if normalized.is_empty() {
        return Err("SQL query is required.".to_string());
    }
    if normalized.contains(';') {
        return Err("Only a single SQL statement is supported.".to_string());
    }
    Ok(normalized)
}

fn is_valid_workspace_alias(alias: &str) -> bool {
    let mut chars = alias.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first == '_' || first.is_ascii_alphabetic()) {
        return false;
    }
    chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn workspace_table_info(entry: &WorkspaceTableRegistration) -> WorkspaceTableInfo {
    let file_size_bytes = if entry.is_glob {
        None
    } else {
        fs::metadata(&entry.file_path).ok().map(|meta| meta.len())
    };
    WorkspaceTableInfo {
        alias: entry.alias.clone(),
        file_path: entry.file_path.clone(),
        is_glob: entry.is_glob,
        file_size_bytes,
    }
}

fn apply_workspace_tables(
    conn: &Connection,
    tables: &[WorkspaceTableRegistration],
) -> Result<(), String> {
    for table in tables {
        let ident = escape_sql_ident(&table.alias);
        let path = escape_sql_string_literal(&table.file_path);
        let source = format!("read_parquet('{path}')");
        let flattened = flattened_columns_for_source(conn, &source)?;
        let projection = flattened_projection_sql(&flattened, false);
        conn.execute_batch(&format!(
            "CREATE OR REPLACE VIEW \"{ident}\" AS SELECT {projection} FROM {source};"
        ))
        .map_err(|e| format!("register workspace table '{}': {e}", table.alias))?;
    }
    Ok(())
}

fn query_schema(conn: &Connection, sql: &str) -> Result<Vec<ParquetSchemaColumn>, String> {
    let describe_sql = format!("DESCRIBE SELECT * FROM ({sql}) AS _q");
    let mut schema_stmt = conn
        .prepare(&describe_sql)
        .map_err(|e| format!("prepare workspace schema query: {e}"))?;
    let schema_iter = schema_stmt
        .query_map([], |row| {
            Ok(ParquetSchemaColumn {
                name: row.get(0)?,
                duckdb_type: row.get(1)?,
            })
        })
        .map_err(|e| format!("run workspace schema query: {e}"))?;
    schema_iter
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect workspace schema rows: {e}"))
}

fn query_rows_with_limit(
    conn: &Connection,
    sql: &str,
    schema: &[ParquetSchemaColumn],
    row_limit: u32,
) -> Result<(Vec<Vec<Option<String>>>, bool), String> {
    let projection = schema
        .iter()
        .map(|col| {
            let ident = escape_sql_ident(&col.name);
            format!("CAST(\"{ident}\" AS VARCHAR) AS \"{ident}\"")
        })
        .collect::<Vec<_>>()
        .join(", ");

    let safe_limit = row_limit.max(1) as usize;
    let fetch_limit = safe_limit.saturating_add(1);
    let query_sql = format!("SELECT {projection} FROM ({sql}) AS _q LIMIT {fetch_limit}");
    let mut stmt = conn
        .prepare(&query_sql)
        .map_err(|e| format!("prepare workspace query rows: {e}"))?;
    let col_count = schema.len();
    let row_iter = stmt
        .query_map([], |row| {
            let mut values = Vec::with_capacity(col_count);
            for idx in 0..col_count {
                let value: Option<String> = row.get(idx)?;
                values.push(value);
            }
            Ok(values)
        })
        .map_err(|e| format!("run workspace query rows: {e}"))?;
    let mut rows = row_iter
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect workspace query rows: {e}"))?;
    let truncated = rows.len() > safe_limit;
    if truncated {
        rows.truncate(safe_limit);
    }
    Ok((rows, truncated))
}

fn export_workspace_query_to_file(
    conn: &Connection,
    sql: &str,
    output_path: &str,
    format: &str,
) -> Result<(), String> {
    let normalized_format = format.trim().to_ascii_lowercase();
    if normalized_format != "csv" && normalized_format != "parquet" {
        return Err("Unsupported export format. Use 'csv' or 'parquet'.".to_string());
    }
    let escaped_path = escape_sql_string_literal(output_path);
    let copy_sql = if normalized_format == "csv" {
        format!("COPY (SELECT * FROM ({sql}) AS _q) TO '{escaped_path}' (FORMAT CSV, HEADER TRUE);")
    } else {
        format!("COPY (SELECT * FROM ({sql}) AS _q) TO '{escaped_path}' (FORMAT PARQUET);")
    };
    conn.execute_batch(&copy_sql)
        .map_err(|e| format!("export workspace query: {e}"))?;
    Ok(())
}

fn table_schema_for_alias(conn: &Connection, alias: &str) -> Result<Vec<ParquetSchemaColumn>, String> {
    let ident = escape_sql_ident(alias);
    query_schema(conn, &format!("SELECT * FROM \"{ident}\""))
}

fn build_workspace_schema_diff(
    left_alias: &str,
    left_schema: &[ParquetSchemaColumn],
    right_alias: &str,
    right_schema: &[ParquetSchemaColumn],
) -> WorkspaceSchemaDiffResponse {
    let left_map: BTreeMap<String, String> = left_schema
        .iter()
        .map(|column| (column.name.clone(), column.duckdb_type.clone()))
        .collect();
    let right_map: BTreeMap<String, String> = right_schema
        .iter()
        .map(|column| (column.name.clone(), column.duckdb_type.clone()))
        .collect();

    let names = left_map
        .keys()
        .chain(right_map.keys())
        .cloned()
        .collect::<BTreeSet<_>>();

    let mut added_count = 0_usize;
    let mut removed_count = 0_usize;
    let mut type_changed_count = 0_usize;
    let mut unchanged_count = 0_usize;

    let columns = names
        .into_iter()
        .map(|name| {
            let left_type = left_map.get(&name).cloned();
            let right_type = right_map.get(&name).cloned();
            let change = match (&left_type, &right_type) {
                (None, Some(_)) => {
                    added_count += 1;
                    "added"
                }
                (Some(_), None) => {
                    removed_count += 1;
                    "removed"
                }
                (Some(l), Some(r)) if l != r => {
                    type_changed_count += 1;
                    "type_changed"
                }
                _ => {
                    unchanged_count += 1;
                    "unchanged"
                }
            }
            .to_string();

            WorkspaceSchemaDiffColumn {
                name,
                left_type,
                right_type,
                change,
            }
        })
        .collect::<Vec<_>>();

    WorkspaceSchemaDiffResponse {
        left_alias: left_alias.to_string(),
        right_alias: right_alias.to_string(),
        added_count,
        removed_count,
        type_changed_count,
        unchanged_count,
        columns,
    }
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

#[tauri::command]
fn register_workspace_table(
    alias: String,
    file_path: String,
    is_glob: Option<bool>,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<WorkspaceTableInfo, String> {
    ensure_memory_guard_clear(state.as_ref())?;

    let trimmed_alias = alias.trim();
    if !is_valid_workspace_alias(trimmed_alias) {
        return Err(
            "Alias must start with a letter/underscore and only contain letters, numbers, and underscores."
                .to_string(),
        );
    }
    let trimmed_path = file_path.trim();
    if trimmed_path.is_empty() {
        return Err("File path is required.".to_string());
    }

    let use_glob = is_glob.unwrap_or(false);
    if !use_glob && fs::metadata(trimmed_path).is_err() {
        return Err("Workspace file path does not exist.".to_string());
    }

    let mut tables = state
        .workspace_tables
        .lock()
        .map_err(|_| "Workspace table lock poisoned.".to_string())?;
    let next_entry = WorkspaceTableRegistration {
        alias: trimmed_alias.to_string(),
        file_path: trimmed_path.to_string(),
        is_glob: use_glob,
    };
    if let Some(existing) = tables
        .iter_mut()
        .find(|entry| entry.alias.eq_ignore_ascii_case(trimmed_alias))
    {
        *existing = next_entry.clone();
    } else {
        tables.push(next_entry.clone());
    }
    Ok(workspace_table_info(&next_entry))
}

#[tauri::command]
fn list_workspace_tables(
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<Vec<WorkspaceTableInfo>, String> {
    let tables = state
        .workspace_tables
        .lock()
        .map_err(|_| "Workspace table lock poisoned.".to_string())?;
    let mut infos = tables.iter().map(workspace_table_info).collect::<Vec<_>>();
    infos.sort_by(|a, b| a.alias.cmp(&b.alias));
    Ok(infos)
}

#[tauri::command]
fn remove_workspace_table(
    alias: String,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<(), String> {
    let mut tables = state
        .workspace_tables
        .lock()
        .map_err(|_| "Workspace table lock poisoned.".to_string())?;
    let initial = tables.len();
    tables.retain(|entry| !entry.alias.eq_ignore_ascii_case(alias.trim()));
    if tables.len() == initial {
        return Err("Workspace alias not found.".to_string());
    }
    Ok(())
}

#[tauri::command]
fn run_workspace_query(
    sql: String,
    row_limit: u32,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<WorkspaceQueryResponse, String> {
    ensure_memory_guard_clear(state.as_ref())?;
    let started = Instant::now();
    let normalized_sql = normalize_single_sql_statement(&sql)?;

    let tables = {
        let lock = state
            .workspace_tables
            .lock()
            .map_err(|_| "Workspace table lock poisoned.".to_string())?;
        lock.clone()
    };

    let conn = open_configured_duckdb(state.as_ref())?;
    apply_workspace_tables(&conn, &tables)?;
    let safe_limit = row_limit.max(1);
    let schema = query_schema(&conn, &normalized_sql)?;
    let (rows, truncated) = query_rows_with_limit(&conn, &normalized_sql, &schema, safe_limit)?;
    let elapsed_ms = started.elapsed().as_millis();
    log_perf(
        "run_workspace_query",
        &format!(
            "duration_ms={} row_limit={} row_count={} truncated={} workspace_tables={}",
            elapsed_ms,
            safe_limit,
            rows.len(),
            truncated,
            tables.len()
        ),
    );

    Ok(WorkspaceQueryResponse {
        sql: normalized_sql,
        row_limit: safe_limit,
        row_count: rows.len(),
        truncated,
        elapsed_ms,
        schema,
        rows,
    })
}

#[tauri::command]
fn describe_workspace_table(
    alias: String,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<Vec<ParquetSchemaColumn>, String> {
    ensure_memory_guard_clear(state.as_ref())?;
    let alias_trimmed = alias.trim();
    if alias_trimmed.is_empty() {
        return Err("Workspace alias is required.".to_string());
    }

    let tables = {
        let lock = state
            .workspace_tables
            .lock()
            .map_err(|_| "Workspace table lock poisoned.".to_string())?;
        lock.clone()
    };
    let exists = tables
        .iter()
        .any(|entry| entry.alias.eq_ignore_ascii_case(alias_trimmed));
    if !exists {
        return Err(format!("Workspace alias not found: {alias_trimmed}"));
    }

    let conn = open_configured_duckdb(state.as_ref())?;
    apply_workspace_tables(&conn, &tables)?;
    table_schema_for_alias(&conn, alias_trimmed)
}

#[tauri::command]
fn export_workspace_query(
    sql: String,
    output_path: String,
    format: String,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<WorkspaceExportResponse, String> {
    ensure_memory_guard_clear(state.as_ref())?;
    let started = Instant::now();
    let normalized_sql = normalize_single_sql_statement(&sql)?;
    let trimmed_path = output_path.trim();
    if trimmed_path.is_empty() {
        return Err("Output path is required.".to_string());
    }

    let tables = {
        let lock = state
            .workspace_tables
            .lock()
            .map_err(|_| "Workspace table lock poisoned.".to_string())?;
        lock.clone()
    };

    let conn = open_configured_duckdb(state.as_ref())?;
    apply_workspace_tables(&conn, &tables)?;
    export_workspace_query_to_file(&conn, &normalized_sql, trimmed_path, &format)?;

    let file_size_bytes = fs::metadata(trimmed_path).map(|meta| meta.len()).unwrap_or(0);
    let elapsed_ms = started.elapsed().as_millis();
    let normalized_format = format.trim().to_ascii_lowercase();
    log_perf(
        "export_workspace_query",
        &format!(
            "duration_ms={} format={} output_path={} file_size_bytes={} workspace_tables={}",
            elapsed_ms,
            normalized_format,
            trimmed_path,
            file_size_bytes,
            tables.len()
        ),
    );

    Ok(WorkspaceExportResponse {
        sql: normalized_sql,
        format: normalized_format,
        output_path: trimmed_path.to_string(),
        file_size_bytes,
        elapsed_ms,
    })
}

#[tauri::command]
fn diff_workspace_schema(
    left_alias: String,
    right_alias: String,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<WorkspaceSchemaDiffResponse, String> {
    ensure_memory_guard_clear(state.as_ref())?;
    let left_trimmed = left_alias.trim();
    let right_trimmed = right_alias.trim();
    if left_trimmed.is_empty() || right_trimmed.is_empty() {
        return Err("Both workspace aliases are required.".to_string());
    }
    if left_trimmed.eq_ignore_ascii_case(right_trimmed) {
        return Err("Choose two different workspace aliases for schema diff.".to_string());
    }

    let tables = {
        let lock = state
            .workspace_tables
            .lock()
            .map_err(|_| "Workspace table lock poisoned.".to_string())?;
        lock.clone()
    };
    let has_left = tables
        .iter()
        .any(|entry| entry.alias.eq_ignore_ascii_case(left_trimmed));
    let has_right = tables
        .iter()
        .any(|entry| entry.alias.eq_ignore_ascii_case(right_trimmed));
    if !has_left {
        return Err(format!("Workspace alias not found: {left_trimmed}"));
    }
    if !has_right {
        return Err(format!("Workspace alias not found: {right_trimmed}"));
    }

    let conn = open_configured_duckdb(state.as_ref())?;
    apply_workspace_tables(&conn, &tables)?;
    let left_schema = table_schema_for_alias(&conn, left_trimmed)?;
    let right_schema = table_schema_for_alias(&conn, right_trimmed)?;
    let diff = build_workspace_schema_diff(
        left_trimmed,
        &left_schema,
        right_trimmed,
        &right_schema,
    );
    log_perf(
        "diff_workspace_schema",
        &format!(
            "left_alias={} right_alias={} added={} removed={} type_changed={} unchanged={}",
            left_trimmed,
            right_trimmed,
            diff.added_count,
            diff.removed_count,
            diff.type_changed_count,
            diff.unchanged_count
        ),
    );
    Ok(diff)
}

#[cfg(test)]
mod tests {
    use super::{
        build_workspace_schema_diff,
        compute_duckdb_memory_limit_bytes, compute_duckdb_threads, escape_sql_string_literal,
        export_workspace_query_to_file,
        normalize_single_sql_statement,
        open_configured_duckdb, parquet_rows_page, parquet_schema, parquet_total_rows,
        query_rows_with_limit, query_schema, start_socket_server_for_payload,
        table_schema_for_alias,
        apply_workspace_tables, AppRuntimeState, DUCKDB_MEMORY_CAP_BYTES,
        WorkspaceTableRegistration, ParquetSchemaColumn,
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
    fn normalize_sql_trims_semicolon_and_blocks_multi_statement() {
        let normalized = normalize_single_sql_statement(" SELECT 1; ").expect("normalize sql");
        assert_eq!(normalized, "SELECT 1");
        assert!(normalize_single_sql_statement("SELECT 1; SELECT 2").is_err());
        assert!(normalize_single_sql_statement("   ").is_err());
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
    fn parquet_schema_flattens_nested_struct_and_serializes_lists() {
        let state = AppRuntimeState::new();
        let conn = open_configured_duckdb(&state).expect("open configured duckdb");
        let temp_file = unique_test_parquet_path();
        let escaped_path = escape_sql_string_literal(&temp_file);

        conn.execute_batch(&format!(
            "COPY (
                SELECT
                    {{'src_port': 443::BIGINT, 'meta': {{'duration_ms': 120::BIGINT}}}} AS flow,
                    [1, 2, 3]::INTEGER[] AS ports
            ) TO '{escaped_path}' (FORMAT PARQUET);"
        ))
        .expect("write nested parquet fixture");

        let source = format!("read_parquet('{escaped_path}')");
        let schema = parquet_schema(&conn, &source).expect("load flattened parquet schema");
        let names = schema.iter().map(|column| column.name.clone()).collect::<Vec<_>>();
        assert!(names.iter().any(|name| name == "flow.src_port"));
        assert!(names
            .iter()
            .any(|name| name == "flow.meta.duration_ms"));
        assert!(names.iter().any(|name| name == "ports"));
        let ports_col = schema
            .iter()
            .find(|column| column.name == "ports")
            .expect("ports column present");
        assert_eq!(ports_col.duckdb_type, "VARCHAR");

        let rows = parquet_rows_page(&conn, &source, &schema, 0, 10).expect("load flattened rows");
        assert_eq!(rows.len(), 1);
        let src_port_idx = names
            .iter()
            .position(|name| name == "flow.src_port")
            .expect("src_port column index");
        let duration_idx = names
            .iter()
            .position(|name| name == "flow.meta.duration_ms")
            .expect("duration column index");
        let ports_idx = names
            .iter()
            .position(|name| name == "ports")
            .expect("ports column index");
        assert_eq!(rows[0][src_port_idx].as_deref(), Some("443"));
        assert_eq!(rows[0][duration_idx].as_deref(), Some("120"));
        assert!(rows[0][ports_idx]
            .as_deref()
            .unwrap_or_default()
            .contains('1'));

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

    #[test]
    fn workspace_query_supports_cross_file_join() {
        let state = AppRuntimeState::new();
        let conn = open_configured_duckdb(&state).expect("open configured duckdb");

        let left_path = unique_test_parquet_path();
        let right_path = unique_test_parquet_path();
        let left_escaped = escape_sql_string_literal(&left_path);
        let right_escaped = escape_sql_string_literal(&right_path);

        conn.execute_batch(&format!(
            "COPY (
                SELECT 1::BIGINT AS id, 'a'::VARCHAR AS tag
                UNION ALL
                SELECT 2::BIGINT AS id, 'b'::VARCHAR AS tag
            ) TO '{left_escaped}' (FORMAT PARQUET);
            COPY (
                SELECT 1::BIGINT AS id, 10::BIGINT AS score
                UNION ALL
                SELECT 2::BIGINT AS id, 20::BIGINT AS score
            ) TO '{right_escaped}' (FORMAT PARQUET);"
        ))
        .expect("write workspace fixtures");

        let tables = vec![
            WorkspaceTableRegistration {
                alias: "left_tbl".to_string(),
                file_path: left_path.clone(),
                is_glob: false,
            },
            WorkspaceTableRegistration {
                alias: "right_tbl".to_string(),
                file_path: right_path.clone(),
                is_glob: false,
            },
        ];
        apply_workspace_tables(&conn, &tables).expect("apply workspace tables");

        let sql = "SELECT l.id, l.tag, r.score FROM left_tbl l JOIN right_tbl r USING (id) ORDER BY l.id";
        let schema = query_schema(&conn, sql).expect("workspace schema");
        let (rows, truncated) =
            query_rows_with_limit(&conn, sql, &schema, 10).expect("workspace query rows");
        assert!(!truncated);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0][0].as_deref(), Some("1"));
        assert_eq!(rows[0][1].as_deref(), Some("a"));
        assert_eq!(rows[0][2].as_deref(), Some("10"));

        let _ = fs::remove_file(&left_path);
        let _ = fs::remove_file(&right_path);
    }

    #[test]
    fn table_schema_for_alias_returns_registered_columns() {
        let state = AppRuntimeState::new();
        let conn = open_configured_duckdb(&state).expect("open configured duckdb");

        let source_path = unique_test_parquet_path();
        let source_escaped = escape_sql_string_literal(&source_path);
        conn.execute_batch(&format!(
            "COPY (
                SELECT 443::BIGINT AS destination_port, 1200::BIGINT AS flow_duration
            ) TO '{source_escaped}' (FORMAT PARQUET);"
        ))
        .expect("write schema source parquet");

        let tables = vec![WorkspaceTableRegistration {
            alias: "traffic_tbl".to_string(),
            file_path: source_path.clone(),
            is_glob: false,
        }];
        apply_workspace_tables(&conn, &tables).expect("apply workspace tables");

        let schema = table_schema_for_alias(&conn, "traffic_tbl").expect("table schema");
        let column_names: Vec<String> = schema.into_iter().map(|column| column.name).collect();
        assert_eq!(column_names, vec!["destination_port", "flow_duration"]);

        let _ = fs::remove_file(&source_path);
    }

    #[test]
    fn workspace_alias_schema_flattens_nested_columns() {
        let state = AppRuntimeState::new();
        let conn = open_configured_duckdb(&state).expect("open configured duckdb");

        let source_path = unique_test_parquet_path();
        let source_escaped = escape_sql_string_literal(&source_path);
        conn.execute_batch(&format!(
            "COPY (
                SELECT
                    {{'destination_port': 443::BIGINT, 'metrics': {{'flow_duration': 900::BIGINT}}}} AS flow,
                    [7, 8]::INTEGER[] AS tags
            ) TO '{source_escaped}' (FORMAT PARQUET);"
        ))
        .expect("write nested workspace parquet");

        let tables = vec![WorkspaceTableRegistration {
            alias: "traffic_tbl".to_string(),
            file_path: source_path.clone(),
            is_glob: false,
        }];
        apply_workspace_tables(&conn, &tables).expect("apply workspace tables");

        let schema = table_schema_for_alias(&conn, "traffic_tbl").expect("table schema");
        let names = schema.iter().map(|column| column.name.clone()).collect::<Vec<_>>();
        assert!(names
            .iter()
            .any(|name| name == "flow.destination_port"));
        assert!(names
            .iter()
            .any(|name| name == "flow.metrics.flow_duration"));
        assert!(names.iter().any(|name| name == "tags"));

        let sql = r#"SELECT "flow.destination_port", "flow.metrics.flow_duration", tags FROM traffic_tbl"#;
        let result_schema = query_schema(&conn, sql).expect("workspace flattened schema");
        let (rows, truncated) =
            query_rows_with_limit(&conn, sql, &result_schema, 10).expect("workspace flattened rows");
        assert!(!truncated);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0][0].as_deref(), Some("443"));
        assert_eq!(rows[0][1].as_deref(), Some("900"));
        assert!(rows[0][2].as_deref().unwrap_or_default().contains('7'));

        let _ = fs::remove_file(&source_path);
    }

    #[test]
    fn schema_diff_detects_added_and_type_changed_columns() {
        let left_schema = vec![
            ParquetSchemaColumn {
                name: "id".to_string(),
                duckdb_type: "BIGINT".to_string(),
            },
            ParquetSchemaColumn {
                name: "qty".to_string(),
                duckdb_type: "INTEGER".to_string(),
            },
        ];
        let right_schema = vec![
            ParquetSchemaColumn {
                name: "id".to_string(),
                duckdb_type: "BIGINT".to_string(),
            },
            ParquetSchemaColumn {
                name: "qty".to_string(),
                duckdb_type: "DOUBLE".to_string(),
            },
            ParquetSchemaColumn {
                name: "extra".to_string(),
                duckdb_type: "VARCHAR".to_string(),
            },
        ];

        let diff = build_workspace_schema_diff("left_tbl", &left_schema, "right_tbl", &right_schema);
        assert_eq!(diff.added_count, 1);
        assert_eq!(diff.removed_count, 0);
        assert_eq!(diff.type_changed_count, 1);
        assert_eq!(diff.unchanged_count, 1);
        assert_eq!(diff.columns.len(), 3);
    }

    #[test]
    fn workspace_query_export_writes_csv_and_parquet_files() {
        let state = AppRuntimeState::new();
        let conn = open_configured_duckdb(&state).expect("open configured duckdb");

        let source_path = unique_test_parquet_path();
        let source_escaped = escape_sql_string_literal(&source_path);
        conn.execute_batch(&format!(
            "COPY (
                SELECT 1::BIGINT AS id, 'alpha'::VARCHAR AS label
                UNION ALL
                SELECT 2::BIGINT AS id, 'beta'::VARCHAR AS label
            ) TO '{source_escaped}' (FORMAT PARQUET);"
        ))
        .expect("write source parquet");

        let tables = vec![WorkspaceTableRegistration {
            alias: "exp_tbl".to_string(),
            file_path: source_path.clone(),
            is_glob: false,
        }];
        apply_workspace_tables(&conn, &tables).expect("apply workspace tables");

        let sql = "SELECT id, label FROM exp_tbl ORDER BY id";
        let csv_path = unique_test_output_path("csv");
        let parquet_path = unique_test_output_path("parquet");

        export_workspace_query_to_file(&conn, sql, &csv_path, "csv").expect("export csv");
        export_workspace_query_to_file(&conn, sql, &parquet_path, "parquet").expect("export parquet");

        let csv_contents = fs::read_to_string(&csv_path).expect("read csv");
        assert!(csv_contents.contains("id,label"));
        assert!(csv_contents.contains("1,alpha"));
        assert!(fs::metadata(&parquet_path).expect("parquet metadata").len() > 0);

        let _ = fs::remove_file(&source_path);
        let _ = fs::remove_file(&csv_path);
        let _ = fs::remove_file(&parquet_path);
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

    fn unique_test_output_path(extension: &str) -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let thread_id = format!("{:?}", std::thread::current().id());
        let mut path = std::env::temp_dir();
        path.push(format!("parq_bench_test_export_{nanos}_{thread_id}.{extension}"));
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
            write_text_report,
            register_workspace_table,
            list_workspace_tables,
            remove_workspace_table,
            run_workspace_query,
            describe_workspace_table,
            export_workspace_query,
            diff_workspace_schema
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
