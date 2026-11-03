use arrow_array::{ArrayRef, Int64Array, RecordBatch, StringArray};
use arrow_ipc::writer::StreamWriter;
use arrow_schema::{DataType, Field, Schema};
use duckdb::Connection;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::{Cursor, Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use sysinfo::System;
use tauri::Manager;
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

/// Run a closure on a dedicated thread with an 8 MB stack.
/// DuckDB builds deep recursive execution trees on large datasets that
/// overflow the default ~1 MB Tauri command-thread stack.
fn on_duckdb_thread<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    thread::Builder::new()
        .name("duckdb-work".into())
        .stack_size(16 * 1024 * 1024)
        .spawn(f)
        .map_err(|e| format!("spawn duckdb thread: {e}"))?
        .join()
        .map_err(|e| {
            let msg = if let Some(s) = e.downcast_ref::<String>() {
                s.clone()
            } else if let Some(s) = e.downcast_ref::<&str>() {
                s.to_string()
            } else {
                "unknown panic".to_string()
            };
            format!("duckdb thread panicked: {msg}")
        })?
}

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

#[derive(Serialize, Debug)]
struct ParquetSchemaColumn {
    name: String,
    duckdb_type: String,
}

#[derive(Serialize)]
struct ParquetPreviewResponse {
    file_path: String,
    /// None for URLs (no local file to measure).
    file_size_bytes: Option<u64>,
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

#[derive(Clone, Copy, PartialEq)]
enum WorkspaceSourceKind {
    Parquet,
    Delimited,
    /// `.xlsx` via the on-demand `excel` extension.
    Excel,
    /// One table or view of a SQLite database via the on-demand `sqlite` extension.
    Sqlite,
    /// A Delta Lake table folder via the on-demand `delta` extension.
    Delta,
}

impl WorkspaceSourceKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Parquet => "parquet",
            Self::Delimited => "delimited",
            Self::Excel => "excel",
            Self::Sqlite => "sqlite",
            Self::Delta => "delta",
        }
    }
}

#[derive(Clone)]
struct WorkspaceTableRegistration {
    alias: String,
    file_path: String,
    is_glob: bool,
    source_kind: WorkspaceSourceKind,
    delimiter: Option<String>,
    row_count: Option<u64>,
    /// Excel sheet or SQLite table/view name.
    object_name: Option<String>,
    /// Excel only: whether the first row holds column names.
    header: Option<bool>,
}

#[derive(Serialize)]
struct WorkspaceTableInfo {
    alias: String,
    file_path: String,
    is_glob: bool,
    is_remote: bool,
    source_kind: String,
    delimiter: Option<String>,
    object_name: Option<String>,
    header: Option<bool>,
    file_size_bytes: Option<u64>,
    row_count: Option<u64>,
}

#[derive(Serialize)]
struct SourcePeekResponse {
    source_kind: String,
    detected_delimiter: Option<String>,
    has_header: Option<bool>,
    matched_files: Option<u64>,
    row_count: Option<u64>,
    schema: Vec<ParquetSchemaColumn>,
    rows: Vec<Vec<Option<String>>>,
}

#[derive(Serialize, Debug)]
struct WorkspaceQueryResponse {
    sql: String,
    row_limit: u32,
    row_count: usize,
    truncated: bool,
    elapsed_ms: u128,
    schema: Vec<ParquetSchemaColumn>,
    rows: Vec<Vec<Option<String>>>,
    /// False for DDL/DML/utility statements, whose one row is just a status message.
    returns_rows: bool,
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
    log_file: Mutex<Option<PathBuf>>,
    /// Queries that can be cancelled or polled for progress, keyed by a frontend-chosen id.
    running_queries: Mutex<HashMap<String, RunningQuery>>,
    /// Ids cancelled before their query registered (e.g. Esc right after Ctrl+Enter).
    /// Bounded; only touched while `running_queries` is locked.
    cancelled_early: Mutex<std::collections::VecDeque<String>>,
    /// Long-lived connection holding empty mirror tables for SQL autocomplete.
    completion: Mutex<CompletionEngine>,
    /// DuckDB's built-in function reference for editor hover and signature help, loaded once.
    function_docs: Mutex<Option<Arc<Vec<FunctionDoc>>>>,
    /// Serializes reads and writes of the saved-queries file.
    saved_queries_lock: Mutex<()>,
}

impl AppRuntimeState {
    fn new() -> Self {
        Self {
            memory_guard_tripped: AtomicBool::new(false),
            process_rss_bytes: AtomicU64::new(0),
            total_memory_bytes: AtomicU64::new(0),
            workspace_tables: Mutex::new(Vec::new()),
            log_file: Mutex::new(None),
            running_queries: Mutex::new(HashMap::new()),
            cancelled_early: Mutex::new(std::collections::VecDeque::new()),
            completion: Mutex::new(CompletionEngine::default()),
            function_docs: Mutex::new(None),
            saved_queries_lock: Mutex::new(()),
        }
    }
}

// ── Cancellable queries ─────────────────────────────────────────────────────

/// Error text returned for a query the user cancelled. The frontend matches it exactly.
const QUERY_CANCELLED: &str = "Query cancelled.";

struct RunningQuery {
    interrupt: Arc<duckdb::InterruptHandle>,
    progress: duckdb::ProgressHandle,
    cancelled: Arc<AtomicBool>,
}

/// Removes a query from the running registry when dropped, so finished, failed and
/// panicked queries never linger.
struct RunningQueryGuard {
    state: Arc<AppRuntimeState>,
    id: Option<String>,
    cancelled: Arc<AtomicBool>,
}

impl RunningQueryGuard {
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Call between steps (setup statements, schema, rows, COPY): DuckDB's interrupt
    /// only stops the statement running at that moment, so a cancel that lands in a
    /// gap would otherwise be ignored by the next statement.
    fn check(&self) -> Result<(), String> {
        if self.is_cancelled() {
            Err(QUERY_CANCELLED.to_string())
        } else {
            Ok(())
        }
    }

    /// Turns any outcome into `QUERY_CANCELLED` once the user has cancelled. A query
    /// that finished in the same instant is still reported as cancelled, so a
    /// cancelled run never produces a result the user asked to stop.
    fn finish<T>(&self, outcome: Result<T, String>) -> Result<T, String> {
        if self.is_cancelled() {
            Err(QUERY_CANCELLED.to_string())
        } else {
            outcome
        }
    }
}

impl Drop for RunningQueryGuard {
    fn drop(&mut self) {
        if let Some(id) = &self.id {
            if let Ok(mut map) = self.state.running_queries.lock() {
                map.remove(id);
            }
        }
    }
}

/// Registers `conn` under `query_id` so `cancel_workspace_query` and
/// `workspace_query_progress` can reach it. Without an id the query simply isn't
/// cancellable. Progress tracking is best effort: if DuckDB refuses it, the query
/// still runs and reports no percentage.
fn track_query(
    state: &Arc<AppRuntimeState>,
    query_id: Option<String>,
    conn: &Connection,
) -> Result<RunningQueryGuard, String> {
    let cancelled = Arc::new(AtomicBool::new(false));
    let id = query_id.map(|id| id.trim().to_string()).filter(|id| !id.is_empty());
    if let Some(id) = &id {
        if let Err(e) = conn.set_query_progress_tracking(true) {
            log_perf(state, "query_progress", &format!("tracking_unavailable error={e}"));
        }
        let mut map = state
            .running_queries
            .lock()
            .map_err(|_| "Running query lock poisoned.".to_string())?;
        if let Ok(mut early) = state.cancelled_early.lock() {
            if let Some(pos) = early.iter().position(|e| e == id) {
                early.remove(pos);
                cancelled.store(true, Ordering::SeqCst);
            }
        }
        map.insert(
            id.clone(),
            RunningQuery {
                interrupt: conn.interrupt_handle(),
                progress: conn.progress_handle(),
                cancelled: cancelled.clone(),
            },
        );
    }
    Ok(RunningQueryGuard { state: state.clone(), id, cancelled })
}

/// How many not-yet-registered cancels to remember.
const CANCELLED_EARLY_MAX: usize = 64;

/// Cancels a running query. Returns false when no query with that id is running:
/// it already finished, or hasn't registered yet, in which case the cancel is kept
/// and applied when it does (`track_query`).
fn cancel_running_query(state: &AppRuntimeState, query_id: &str) -> Result<bool, String> {
    let id = query_id.trim();
    let map = state
        .running_queries
        .lock()
        .map_err(|_| "Running query lock poisoned.".to_string())?;
    match map.get(id) {
        Some(query) => {
            query.cancelled.store(true, Ordering::SeqCst);
            query.interrupt.interrupt();
            Ok(true)
        }
        None => {
            if !id.is_empty() {
                let mut early = state
                    .cancelled_early
                    .lock()
                    .map_err(|_| "Running query lock poisoned.".to_string())?;
                if early.len() >= CANCELLED_EARLY_MAX {
                    early.pop_front();
                }
                early.push_back(id.to_string());
            }
            Ok(false)
        }
    }
}

#[tauri::command]
fn cancel_workspace_query(
    query_id: String,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<bool, String> {
    cancel_running_query(state.as_ref(), &query_id)
}

/// Percentage (0–100) of the running query, or None when DuckDB has no estimate
/// or the query isn't running.
#[tauri::command]
fn workspace_query_progress(
    query_id: String,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<Option<f64>, String> {
    let map = state
        .running_queries
        .lock()
        .map_err(|_| "Running query lock poisoned.".to_string())?;
    Ok(map
        .get(query_id.trim())
        .and_then(|q| q.progress.query_progress().percentage())
        .map(|p| p.clamp(0.0, 100.0)))
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

fn format_timestamp() -> String {
    let now = std::time::SystemTime::now();
    let secs = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    // Decompose epoch millis into date/time components (UTC)
    let total_secs = (secs / 1000) as i64;
    let millis_part = (secs % 1000) as u32;
    let days = total_secs.div_euclid(86400);
    let day_secs = total_secs.rem_euclid(86400);
    let h = day_secs / 3600;
    let m = (day_secs % 3600) / 60;
    let s = day_secs % 60;
    // Civil date from days since 1970-01-01 (algorithm from Howard Hinnant)
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mon = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mon <= 2 { y + 1 } else { y };
    format!("{y:04}-{mon:02}-{d:02}T{h:02}:{m:02}:{s:02}.{millis_part:03}")
}

fn log_perf(state: &AppRuntimeState, event: &str, details: &str) {
    eprintln!("event={event} {details}");

    let log_path = match state.log_file.lock() {
        Ok(guard) => guard.clone(),
        Err(_) => None,
    };
    if let Some(path) = log_path {
        let ts = format_timestamp();
        let line = format!("[{ts}] event={event} {details}\n");
        let _ = fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(&path)
            .and_then(|mut f| f.write_all(line.as_bytes()));
    }
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
        state,
        "duckdb_config",
        &format!(
            "threads={} cpu_cores={} memory_limit_mib={} total_memory_bytes={}",
            threads, cpu_cores, memory_limit_mib, total_memory_bytes
        ),
    );

    Ok(conn)
}


/// Escape a value for use inside a SQL single-quoted string literal.
/// Backslashes are converted to forward slashes for DuckDB file-path
/// compatibility on Windows. Only use this for file paths, not arbitrary strings.
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

fn describe_columns(
    conn: &Connection,
    describe_sql: &str,
    context: &str,
) -> Result<Vec<ParquetSchemaColumn>, String> {
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

fn flattened_columns_for_source(
    conn: &Connection,
    source: &str,
) -> Result<Vec<FlattenedColumn>, String> {
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

fn schema_from_flattened(flattened: &[FlattenedColumn]) -> Vec<ParquetSchemaColumn> {
    flattened
        .iter()
        .map(|column| ParquetSchemaColumn {
            name: column.name.clone(),
            duckdb_type: column.duckdb_type.clone(),
        })
        .collect()
}

fn parquet_total_rows(conn: &Connection, normalized_path: &str, source: &str) -> Result<u64, String> {
    // Footer metadata gives the count without scanning; fall back to COUNT(*) only if it fails.
    if let Ok(rows) = parquet_metadata_row_count(conn, normalized_path) {
        return Ok(rows);
    }

    let fallback_sql = format!("SELECT COUNT(*)::UBIGINT FROM {source}");
    conn.query_row(&fallback_sql, [], |row| row.get::<_, u64>(0))
        .map_err(|e| format!("failed to count rows: {e}"))
}

fn parquet_rows_page(
    conn: &Connection,
    source: &str,
    flattened: &[FlattenedColumn],
    row_offset: u64,
    row_limit: u32,
) -> Result<Vec<Vec<Option<String>>>, String> {
    let projection = flattened_projection_sql(flattened, true);

    let preview_sql = format!(
        "SELECT {projection} FROM {source} LIMIT {} OFFSET {}",
        row_limit.max(1),
        row_offset
    );
    let mut preview_stmt = conn
        .prepare(&preview_sql)
        .map_err(|e| format!("prepare preview query: {e}"))?;

    let col_count = flattened.len();
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
    let mut statements = split_sql_statements(&normalized);
    match statements.len() {
        0 => Err("SQL query is required.".to_string()),
        1 => Ok(statements.remove(0)),
        _ => Err("Only a single SQL statement is supported.".to_string()),
    }
}

/// `sql` without leading whitespace, `-- line` and `/* block */` comments.
fn skip_leading_comments(sql: &str) -> &str {
    let mut rest = sql.trim_start();
    loop {
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.find('\n').map_or("", |i| &after[i + 1..]).trim_start();
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.find("*/").map_or("", |i| &after[i + 2..]).trim_start();
        } else {
            return rest;
        }
    }
}

/// Splits SQL on `;`, ignoring semicolons inside 'strings', "identifiers",
/// $$dollar$$ strings, -- line comments and /* block comments */. Returns trimmed,
/// non-empty statements. Mirrors `splitSqlStatements` in the frontend.
fn split_sql_statements(sql: &str) -> Vec<String> {
    let chars: Vec<char> = sql.chars().collect();
    let mut statements = Vec::new();
    let mut current = String::new();
    // Whether `current` holds anything besides whitespace and comments.
    let mut has_code = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        match c {
            '\'' | '"' => {
                // Quoted text; a doubled quote is an escaped quote.
                has_code = true;
                current.push(c);
                i += 1;
                while i < chars.len() {
                    current.push(chars[i]);
                    if chars[i] == c {
                        if chars.get(i + 1) == Some(&c) {
                            current.push(c);
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
                i += 1;
            }
            '-' if next == Some('-') => {
                while i < chars.len() && chars[i] != '\n' {
                    current.push(chars[i]);
                    i += 1;
                }
            }
            '/' if next == Some('*') => {
                current.push_str("/*");
                i += 2;
                while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                    current.push(chars[i]);
                    i += 1;
                }
                if i < chars.len() {
                    current.push_str("*/");
                    i += 2;
                }
            }
            '$' => {
                // $tag$ ... $tag$ (tag may be empty). A lone `$` (e.g. `$1`) is plain text.
                let mut j = i + 1;
                while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_') {
                    j += 1;
                }
                let tag_is_valid = j < chars.len()
                    && chars[j] == '$'
                    && !chars.get(i + 1).is_some_and(|ch| ch.is_ascii_digit());
                has_code = true;
                if tag_is_valid {
                    let tag: String = chars[i..=j].iter().collect();
                    let tag_chars: Vec<char> = tag.chars().collect();
                    current.push_str(&tag);
                    i = j + 1;
                    loop {
                        if i >= chars.len() {
                            break;
                        }
                        if chars[i..].starts_with(&tag_chars) {
                            current.push_str(&tag);
                            i += tag_chars.len();
                            break;
                        }
                        current.push(chars[i]);
                        i += 1;
                    }
                } else {
                    current.push(c);
                    i += 1;
                }
            }
            ';' => {
                if has_code {
                    statements.push(skip_leading_comments(&current).trim_end().to_string());
                }
                current.clear();
                has_code = false;
                i += 1;
            }
            _ => {
                has_code |= !c.is_whitespace();
                current.push(c);
                i += 1;
            }
        }
    }
    if has_code {
        statements.push(skip_leading_comments(&current).trim_end().to_string());
    }
    statements
}

/// Returns true if the SQL is a SELECT-like statement that returns rows
/// (SELECT, WITH, VALUES, TABLE, FROM). Everything else (INSTALL, LOAD,
/// CALL, CREATE, DROP, INSERT, etc.) is a utility/DDL/DML statement.
fn is_select_like(sql: &str) -> bool {
    let upper = skip_leading_comments(sql).to_uppercase();
    upper.starts_with("SELECT ")
        || upper.starts_with("SELECT\n")
        || upper.starts_with("SELECT\t")
        || upper.starts_with("WITH ")
        || upper.starts_with("WITH\n")
        || upper.starts_with("WITH\t")
        || upper.starts_with("VALUES ")
        || upper.starts_with("VALUES(")
        || upper.starts_with("TABLE ")
        || upper.starts_with("FROM ")
        || upper.starts_with("SUMMARIZE ")
        || upper.starts_with("SUMMARIZE\n")
        || upper.starts_with("SUMMARIZE\t")
        || upper.starts_with("(")
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

fn parse_workspace_source_kind(source_kind: Option<String>) -> Result<WorkspaceSourceKind, String> {
    let normalized = source_kind
        .unwrap_or_else(|| "parquet".to_string())
        .trim()
        .to_ascii_lowercase();
    match normalized.as_str() {
        "parquet" => Ok(WorkspaceSourceKind::Parquet),
        "delimited" => Ok(WorkspaceSourceKind::Delimited),
        "excel" => Ok(WorkspaceSourceKind::Excel),
        "sqlite" => Ok(WorkspaceSourceKind::Sqlite),
        "delta" => Ok(WorkspaceSourceKind::Delta),
        _ => Err(
            "Unsupported workspace source type. Use 'parquet', 'delimited', 'excel', 'sqlite' or 'delta'."
                .to_string(),
        ),
    }
}

/// Delimiter implied by a file extension. `None` means "let DuckDB's CSV
/// sniffer detect it" (used for .csv, .txt, .data and anything unknown).
fn default_delimiter_for_path(path: &str) -> Option<char> {
    let lower = path.trim().to_ascii_lowercase();
    if lower.ends_with(".tsv") {
        Some('\t')
    } else if lower.ends_with(".psv") {
        Some('|')
    } else {
        None
    }
}

fn parse_delimiter_char(raw: &str) -> Result<char, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Delimiter cannot be empty.".to_string());
    }
    match trimmed {
        "\\t" => Ok('\t'),
        "\\n" => Ok('\n'),
        "\\r" => Ok('\r'),
        _ => {
            let mut chars = trimmed.chars();
            let Some(first) = chars.next() else {
                return Err("Delimiter cannot be empty.".to_string());
            };
            if chars.next().is_some() {
                return Err(
                    "Delimiter must be exactly one character (or escape: \\t, \\n, \\r)."
                        .to_string(),
                );
            }
            Ok(first)
        }
    }
}

fn resolve_workspace_delimiter(
    source_kind: &WorkspaceSourceKind,
    file_path: &str,
    delimiter: Option<String>,
) -> Result<Option<String>, String> {
    match source_kind {
        WorkspaceSourceKind::Parquet
        | WorkspaceSourceKind::Excel
        | WorkspaceSourceKind::Sqlite
        | WorkspaceSourceKind::Delta => Ok(None),
        WorkspaceSourceKind::Delimited => {
            let resolved = match delimiter {
                Some(raw) if !raw.trim().is_empty() => Some(parse_delimiter_char(&raw)?),
                _ => default_delimiter_for_path(file_path),
            };
            Ok(resolved.map(|c| c.to_string()))
        }
    }
}

fn workspace_source_sql(table: &WorkspaceTableRegistration) -> String {
    let path = escape_sql_string_literal(&table.file_path);
    match table.source_kind {
        WorkspaceSourceKind::Parquet => format!("read_parquet('{path}')"),
        WorkspaceSourceKind::Delimited => {
            let delimiter = table
                .delimiter
                .as_deref()
                .and_then(|value| value.chars().next())
                .or_else(|| default_delimiter_for_path(&table.file_path));
            match delimiter {
                Some(d) => {
                    let escaped_delim = escape_sql_literal(&d.to_string());
                    format!("read_csv_auto('{path}', delim='{escaped_delim}')")
                }
                // No explicit delimiter: let DuckDB's sniffer detect it.
                None => format!("read_csv_auto('{path}')"),
            }
        }
        WorkspaceSourceKind::Excel => {
            let mut args = format!("'{path}'");
            if let Some(sheet) = table.object_name.as_deref() {
                args.push_str(&format!(", sheet => '{}'", escape_sql_literal(sheet)));
            }
            if let Some(header) = table.header {
                args.push_str(&format!(", header => {header}"));
            }
            format!("read_xlsx({args})")
        }
        WorkspaceSourceKind::Sqlite => {
            let name = escape_sql_literal(table.object_name.as_deref().unwrap_or_default());
            format!("sqlite_scan('{path}', '{name}')")
        }
        WorkspaceSourceKind::Delta => format!("delta_scan('{path}')"),
    }
}

/// `http://` or `https://` source, read through the on-demand `httpfs` extension.
fn is_remote_path(path: &str) -> bool {
    let lower = path.trim_start().to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://")
}

/// Registered tables an SQL statement refers to: those whose alias appears as a whole
/// word (case-insensitive). Every command opens a fresh connection, so only these need
/// a view, and a table the statement doesn't use (an unreachable URL, an extension that
/// can't be downloaded) can't make it fail.
fn tables_referenced_by(
    sql: &str,
    tables: &[WorkspaceTableRegistration],
) -> Vec<WorkspaceTableRegistration> {
    let lower = sql.to_ascii_lowercase();
    tables
        .iter()
        .filter(|t| contains_word(&lower, &t.alias.to_ascii_lowercase()))
        .cloned()
        .collect()
}

/// The registered tables with the given aliases (case-insensitive).
fn tables_with_aliases(
    tables: &[WorkspaceTableRegistration],
    aliases: &[&str],
) -> Vec<WorkspaceTableRegistration> {
    tables
        .iter()
        .filter(|t| aliases.iter().any(|a| t.alias.eq_ignore_ascii_case(a)))
        .cloned()
        .collect()
}

/// `word` (ASCII) occurs in `haystack` with no identifier character on either side.
fn contains_word(haystack: &str, word: &str) -> bool {
    if word.is_empty() {
        return false;
    }
    let is_ident = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut from = 0;
    while let Some(found) = haystack[from..].find(word) {
        let start = from + found;
        let end = start + word.len();
        let before_ok = haystack[..start].chars().next_back().map_or(true, |c| !is_ident(c));
        let after_ok = haystack[end..].chars().next().map_or(true, |c| !is_ident(c));
        if before_ok && after_ok {
            return true;
        }
        // `word` starts with an ASCII byte, so start + 1 is a char boundary.
        from = start + 1;
    }
    false
}

/// For logs: drop a URL's query string and fragment, which can carry access tokens.
fn redact_for_log(path: &str) -> String {
    if is_remote_path(path) {
        path.split(['?', '#']).next().unwrap_or(path).to_string()
    } else {
        path.to_string()
    }
}

/// A `scheme://` path other than http(s) (s3://, gs://, hf://, …). These need
/// credentials or extensions the app doesn't manage, so they aren't accepted.
fn has_unsupported_scheme(path: &str) -> bool {
    let trimmed = path.trim_start();
    match trimmed.find("://") {
        Some(idx) => {
            let scheme = &trimmed[..idx];
            !scheme.is_empty()
                && scheme.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
                && !is_remote_path(trimmed)
        }
        None => false,
    }
}

/// Shared checks for peek and register: the path exists (local sources), the
/// source kind supports the requested mode, and required options are present.
fn validate_workspace_source(
    path: &str,
    is_glob: bool,
    kind: WorkspaceSourceKind,
    object_name: Option<&str>,
) -> Result<(), String> {
    if has_unsupported_scheme(path) {
        return Err("Only local paths and http(s):// links are supported.".to_string());
    }
    let remote = is_remote_path(path);
    if remote {
        if is_glob {
            return Err("Folders can't be read from a URL. Enter a single file's URL.".to_string());
        }
        if !matches!(kind, WorkspaceSourceKind::Parquet | WorkspaceSourceKind::Delimited) {
            return Err("Only Parquet and delimited text files can be read from a URL.".to_string());
        }
    } else if !is_glob && fs::metadata(path).is_err() {
        return Err("Workspace file path does not exist.".to_string());
    }
    if is_glob && !matches!(kind, WorkspaceSourceKind::Parquet | WorkspaceSourceKind::Delimited) {
        return Err("Folder mode supports Parquet and delimited text files only.".to_string());
    }
    if kind == WorkspaceSourceKind::Delta && !Path::new(path).is_dir() {
        return Err("A Delta table is a folder. Choose the table's folder (the one containing _delta_log).".to_string());
    }
    if kind == WorkspaceSourceKind::Sqlite && object_name.map_or(true, |n| n.trim().is_empty()) {
        return Err("Choose a table from the SQLite database.".to_string());
    }
    Ok(())
}

fn workspace_table_info(entry: &WorkspaceTableRegistration) -> WorkspaceTableInfo {
    let is_remote = is_remote_path(&entry.file_path);
    // Globs, URLs and Delta folders have no single on-disk size.
    let file_size_bytes = if entry.is_glob || is_remote || entry.source_kind == WorkspaceSourceKind::Delta {
        None
    } else {
        fs::metadata(&entry.file_path).ok().map(|meta| meta.len())
    };
    WorkspaceTableInfo {
        alias: entry.alias.clone(),
        file_path: entry.file_path.clone(),
        is_glob: entry.is_glob,
        is_remote,
        source_kind: entry.source_kind.as_str().to_string(),
        delimiter: entry.delimiter.clone(),
        object_name: entry.object_name.clone(),
        header: entry.header,
        file_size_bytes,
        row_count: entry.row_count,
    }
}

fn apply_workspace_tables(
    conn: &Connection,
    tables: &[WorkspaceTableRegistration],
) -> Result<(), String> {
    for table in tables {
        let ident = escape_sql_ident(&table.alias);
        let source = workspace_source_sql(table);
        let flattened = flattened_columns_for_source(conn, &source)
            .map_err(|e| format!("register workspace table '{}': {e}", table.alias))?;
        let projection = flattened_projection_sql(&flattened, false);
        conn.execute_batch(&format!(
            "CREATE OR REPLACE VIEW \"{ident}\" AS SELECT {projection} FROM {source};"
        ))
        .map_err(|e| format!("register workspace table '{}': {e}", table.alias))?;
    }
    Ok(())
}

fn query_schema(conn: &Connection, sql: &str) -> Result<Vec<ParquetSchemaColumn>, String> {
    // The newline ends a trailing `-- comment` before the closing parenthesis.
    let describe_sql = format!("DESCRIBE SELECT * FROM ({sql}\n) AS _q");
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
    query_rows_with_limit_cancellable(conn, sql, schema, row_limit, &AtomicBool::new(false))
}

/// Like `query_rows_with_limit`, but stops converting rows once `cancelled` is set.
/// DuckDB's interrupt stops execution; this covers a cancel that lands while the
/// finished result is still being turned into strings.
fn query_rows_with_limit_cancellable(
    conn: &Connection,
    sql: &str,
    schema: &[ParquetSchemaColumn],
    row_limit: u32,
    cancelled: &AtomicBool,
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
    let query_sql = format!("SELECT {projection} FROM ({sql}\n) AS _q LIMIT {fetch_limit}");
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
    let mut rows = Vec::new();
    for row in row_iter {
        if cancelled.load(Ordering::SeqCst) {
            return Err(QUERY_CANCELLED.to_string());
        }
        rows.push(row.map_err(|e| format!("collect workspace query rows: {e}"))?);
    }
    let truncated = rows.len() > safe_limit;
    if truncated {
        rows.truncate(safe_limit);
    }
    Ok((rows, truncated))
}

/// Files a workspace export may write: the output, the CSV staging file
/// (`<output>.tmp`), and DuckDB's own `tmp_<name>` file next to whatever it COPYs to.
fn export_artifact_paths(output_path: &str) -> Vec<PathBuf> {
    let duckdb_tmp = |target: &Path| -> Option<PathBuf> {
        let name = target.file_name()?.to_string_lossy().into_owned();
        Some(target.with_file_name(format!("tmp_{name}")))
    };
    let output = PathBuf::from(output_path);
    let staging = PathBuf::from(format!("{output_path}.tmp"));
    let mut paths = vec![output.clone(), staging.clone()];
    paths.extend(duckdb_tmp(&output));
    paths.extend(duckdb_tmp(&staging));
    paths
}

/// Snapshot of which export files already existed, so cleanup never deletes a
/// file the user had before the export started.
fn existing_export_artifacts(output_path: &str) -> Vec<PathBuf> {
    export_artifact_paths(output_path)
        .into_iter()
        .filter(|p| p.exists())
        .collect()
}

/// Removes files a failed or cancelled export created. Files that existed before
/// are left alone: CSV only replaces the output after a complete write, and DuckDB
/// writes to `tmp_<name>` first when the target already exists.
fn remove_partial_export(output_path: &str, existed_before: &[PathBuf]) {
    for path in export_artifact_paths(output_path) {
        if !existed_before.contains(&path) {
            let _ = fs::remove_file(&path);
        }
    }
}

fn export_workspace_query_to_file(
    conn: &Connection,
    sql: &str,
    output_path: &str,
    format: &str,
    query_text: Option<&str>,
    table_aliases: Option<&[String]>,
) -> Result<(), String> {
    let normalized_format = format.trim().to_ascii_lowercase();
    if !matches!(normalized_format.as_str(), "csv" | "parquet" | "xlsx") {
        return Err("Unsupported export format. Use 'csv', 'parquet' or 'xlsx'.".to_string());
    }
    let escaped_path = escape_sql_string_literal(output_path);
    let timestamp = {
        let d = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        format!("{}Z", d.as_secs())
    };

    if normalized_format == "xlsx" {
        // Excel has no place for the query/table metadata the other formats carry.
        // COPY ... (FORMAT xlsx) doesn't autoload, so load the extension first.
        ensure_extension_loaded(conn, "excel")?;
        let copy_sql = format!(
            "COPY (SELECT * FROM ({sql}\n) AS _q) TO '{escaped_path}' (FORMAT xlsx, HEADER true);"
        );
        conn.execute_batch(&copy_sql)
            .map_err(|e| format!("export workspace query: {e}"))?;
    } else if normalized_format == "csv" {
        // Write metadata comment header then COPY output
        let mut meta_header = String::new();
        if let Some(qt) = query_text {
            meta_header.push_str(&format!("# Query: {}\n", qt.replace('\n', " ")));
        }
        meta_header.push_str(&format!("# Exported: {timestamp}\n"));
        if let Some(aliases) = table_aliases {
            if !aliases.is_empty() {
                meta_header.push_str(&format!("# Tables: {}\n", aliases.join(", ")));
            }
        }
        // First export COPY to file, then prepend metadata
        let temp_path = format!("{output_path}.tmp");
        let escaped_temp = escape_sql_string_literal(&temp_path);
        let copy_sql = format!(
            "COPY (SELECT * FROM ({sql}\n) AS _q) TO '{escaped_temp}' (FORMAT CSV, HEADER TRUE);"
        );
        conn.execute_batch(&copy_sql)
            .map_err(|e| format!("export workspace query: {e}"))?;
        let csv_content = fs::read_to_string(&temp_path)
            .map_err(|e| format!("read temp csv: {e}"))?;
        let _ = fs::remove_file(&temp_path);
        fs::write(output_path, format!("{meta_header}{csv_content}"))
            .map_err(|e| format!("write csv with metadata: {e}"))?;
    } else {
        // Parquet with KV_METADATA
        let mut kv_pairs = Vec::new();
        if let Some(qt) = query_text {
            let escaped_qt = escape_sql_literal(&qt.replace('\n', " "));
            kv_pairs.push(format!("'query' : '{escaped_qt}'"));
        }
        let escaped_ts = escape_sql_literal(&timestamp);
        kv_pairs.push(format!("'exported_at' : '{escaped_ts}'"));
        if let Some(aliases) = table_aliases {
            if !aliases.is_empty() {
                let escaped_aliases = escape_sql_literal(&aliases.join(", "));
                kv_pairs.push(format!("'tables' : '{escaped_aliases}'"));
            }
        }
        let kv_metadata = kv_pairs.join(", ");
        let copy_sql = format!(
            "COPY (SELECT * FROM ({sql}\n) AS _q) TO '{escaped_path}' (FORMAT PARQUET, KV_METADATA {{{kv_metadata}}});"
        );
        conn.execute_batch(&copy_sql)
            .map_err(|e| format!("export workspace query: {e}"))?;
    }
    Ok(())
}

fn table_schema_for_alias(
    conn: &Connection,
    alias: &str,
) -> Result<Vec<ParquetSchemaColumn>, String> {
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
        let values = rows
            .iter()
            .map(|row| row.get(col_idx).and_then(|value| value.as_deref()));
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
    writer
        .finish()
        .map_err(|e| format!("finish IPC stream: {e}"))?;

    Ok(cursor.into_inner())
}

#[tauri::command]
fn duckdb_smoke_query(
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<SmokeQueryResponse, String> {
    ensure_memory_guard_clear(state.as_ref())?;
    let st = state.inner().clone();
    on_duckdb_thread(move || {
        let conn = open_configured_duckdb(&st)?;
        let conn = &conn;
        let started = Instant::now();
        let duckdb_version: String = conn
            .query_row("SELECT version()", [], |row| row.get(0))
            .map_err(|e| format!("query DuckDB version: {e}"))?;

        let mut stmt = conn
            .prepare(
                "SELECT id, label FROM (VALUES (1, 'alpha'), (2, 'beta'), (3, 'gamma')) t(id, label)",
            )
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
            &st,
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
    writer
        .finish()
        .map_err(|e| format!("finish IPC stream: {e}"))?;
    let payload = cursor.into_inner();
    log_perf(
        state.as_ref(),
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
        state.as_ref(),
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

#[tauri::command(async)]
fn preview_parquet(
    file_path: String,
    row_limit: u32,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<ParquetPreviewResponse, String> {
    ensure_memory_guard_clear(state.as_ref())?;
    let st = state.inner().clone();
    on_duckdb_thread(move || {
        let conn = open_configured_duckdb(&st)?;
        let conn = &conn;
        let started = Instant::now();
        let file_size_bytes = if is_remote_path(&file_path) {
            None
        } else {
            Some(
                fs::metadata(&file_path)
                    .map_err(|e| format!("read file metadata: {e}"))?
                    .len(),
            )
        };
        let normalized = escape_sql_string_literal(&file_path);
        let source = format!("read_parquet('{normalized}')");
        let total_rows = parquet_total_rows(conn, &normalized, &source)?;
        let flattened = flattened_columns_for_source(conn, &source)?;
        let schema = schema_from_flattened(&flattened);
        let row_offset = 0_u64;
        let row_limit = row_limit.max(1);
        let rows = parquet_rows_page(conn, &source, &flattened, row_offset, row_limit)?;
        log_perf(
            &st,
            "preview_parquet",
            &format!(
                "duration_ms={} file_size_bytes={} schema_cols={} rows={}",
                started.elapsed().as_millis(),
                file_size_bytes.map_or_else(|| "remote".to_string(), |b| b.to_string()),
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
    })
}

#[tauri::command(async)]
fn fetch_parquet_rows(
    file_path: String,
    row_offset: u64,
    row_limit: u32,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<ParquetRowsPage, String> {
    ensure_memory_guard_clear(state.as_ref())?;
    let st = state.inner().clone();
    on_duckdb_thread(move || {
        let conn = open_configured_duckdb(&st)?;
        let conn = &conn;
        let started = Instant::now();
        let normalized = escape_sql_string_literal(&file_path);
        let source = format!("read_parquet('{normalized}')");
        let flattened = flattened_columns_for_source(conn, &source)?;
        let rows = parquet_rows_page(conn, &source, &flattened, row_offset, row_limit.max(1))?;
        log_perf(
            &st,
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
    })
}

async fn start_socket_server_for_payload(state: Arc<AppRuntimeState>, payload: Vec<u8>) -> Result<SocketServerInfo, String> {
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
        &state,
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
            &state,
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
    let st = state.inner().clone();
    let (row_count, payload, started) = on_duckdb_thread(move || {
        let conn = open_configured_duckdb(&st)?;
        let conn = &conn;
        let started = Instant::now();
        let normalized = escape_sql_string_literal(&file_path);
        let source = format!("read_parquet('{normalized}')");
        let safe_limit = row_limit.max(1);
        let flattened = flattened_columns_for_source(conn, &source)?;
        let schema = schema_from_flattened(&flattened);
        let rows = parquet_rows_page(conn, &source, &flattened, row_offset, safe_limit)?;
        let row_count = rows.len();
        let payload = rows_to_arrow_ipc(&schema, &rows)?;
        Ok((row_count, payload, started))
    })?;
    let safe_limit = row_limit.max(1);
    let payload_bytes = payload.len();

    if payload_bytes < INLINE_IPC_MAX_BYTES {
        log_perf(
            state.as_ref(),
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
        let socket = start_socket_server_for_payload(state.inner().clone(), payload).await?;
        log_perf(
            state.as_ref(),
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
    let result = start_socket_server_for_payload(state.inner().clone(), payload).await;
    if result.is_ok() {
        log_perf(
            state.as_ref(),
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
    let p = std::path::Path::new(&path);
    match p.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()) {
        Some(ext) if ext == "json" || ext == "csv" || ext == "txt" => {}
        _ => return Err("write_text_report: only .json, .csv, and .txt files are allowed".into()),
    }
    fs::write(&path, contents).map_err(|e| format!("write report file: {e}"))
}

fn parquet_metadata_row_count(conn: &Connection, normalized_path: &str) -> Result<u64, String> {
    let sql = format!(
        "SELECT COALESCE(SUM(num_rows), 0)::UBIGINT FROM parquet_file_metadata('{normalized_path}')"
    );
    conn.query_row(&sql, [], |row| row.get::<_, u64>(0))
        .map_err(|e| format!("read parquet metadata: {e}"))
}

// ── On-demand extensions ────────────────────────────────────────────────
//
// Parquet and JSON are statically linked. Everything below is downloaded by
// DuckDB the first time a query needs it (autoinstall/autoload), or ahead of
// time from Settings. Nothing is loaded at startup.

/// Extensions offered in Settings. Install requests are limited to this list.
const MANAGED_EXTENSIONS: [&str; 6] = ["excel", "sqlite_scanner", "httpfs", "delta", "icu", "autocomplete"];

#[derive(Serialize)]
struct ExtensionStatus {
    name: String,
    installed: bool,
    loaded: bool,
    size_bytes: Option<u64>,
}

fn managed_extension_name(name: &str) -> Result<&'static str, String> {
    let lower = name.trim().to_ascii_lowercase();
    let canonical = if lower == "sqlite" { "sqlite_scanner" } else { lower.as_str() };
    MANAGED_EXTENSIONS
        .iter()
        .copied()
        .find(|ext| *ext == canonical)
        .ok_or_else(|| format!("Unknown extension: {name}"))
}

fn extension_statuses(conn: &Connection) -> Result<Vec<ExtensionStatus>, String> {
    MANAGED_EXTENSIONS
        .iter()
        .map(|&name| {
            let (installed, loaded, install_path) = conn
                .query_row(
                    "SELECT installed, loaded, install_path FROM duckdb_extensions() WHERE extension_name = ?",
                    [name],
                    |r| Ok((r.get::<_, bool>(0)?, r.get::<_, bool>(1)?, r.get::<_, Option<String>>(2)?)),
                )
                .map_err(|e| format!("read extension status for {name}: {e}"))?;
            let size_bytes = if installed {
                install_path
                    .filter(|p| !p.is_empty())
                    .and_then(|p| fs::metadata(p).ok())
                    .map(|m| m.len())
            } else {
                None
            };
            Ok(ExtensionStatus { name: name.to_string(), installed, loaded, size_bytes })
        })
        .collect()
}

/// LOAD a managed extension, installing it first if needed. Needed where
/// DuckDB doesn't autoload (e.g. `COPY ... (FORMAT xlsx)`).
fn ensure_extension_loaded(conn: &Connection, name: &str) -> Result<(), String> {
    let ext = managed_extension_name(name)?;
    let load_err = match conn.execute_batch(&format!("LOAD {ext};")) {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    // Not installed yet (or broken): install, then load. Report both errors if that fails too.
    conn.execute_batch(&format!("INSTALL {ext}; LOAD {ext};"))
        .map_err(|e| format!("load {ext} extension: {e} (first attempt: {load_err})"))
}

#[tauri::command(async)]
fn list_extensions(
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<Vec<ExtensionStatus>, String> {
    let st = state.inner().clone();
    on_duckdb_thread(move || extension_statuses(&open_configured_duckdb(&st)?))
}

#[tauri::command(async)]
fn install_extension(
    name: String,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<Vec<ExtensionStatus>, String> {
    let ext = managed_extension_name(&name)?;
    let st = state.inner().clone();
    on_duckdb_thread(move || {
        let conn = open_configured_duckdb(&st)?;
        let started = Instant::now();
        conn.execute_batch(&format!("INSTALL {ext};"))
            .map_err(|e| format!("install extension: {e}"))?;
        log_perf(
            &st,
            "extension_install",
            &format!("name={ext} duration_ms={}", started.elapsed().as_millis()),
        );
        extension_statuses(&conn)
    })
}

// ── SQL autocomplete ────────────────────────────────────────────────────────

/// A workspace table as the completion engine sees it: a name and typed columns.
#[derive(Clone, Debug, serde::Deserialize)]
struct CompletionTable {
    alias: String,
    columns: Vec<CompletionColumn>,
}

#[derive(Clone, Debug, serde::Deserialize)]
struct CompletionColumn {
    name: String,
    duckdb_type: String,
}

/// DuckDB's `sql_auto_complete` runs against a connection's catalog. This connection
/// holds *empty* tables shaped like the workspace tables, so completion never reads
/// user files and a broken table can't affect it.
#[derive(Default)]
struct CompletionEngine {
    conn: Option<Connection>,
    tables: Vec<CompletionTable>,
    /// The autocomplete extension is installed and loaded on `conn`.
    ready: bool,
}

#[derive(Serialize, Debug)]
struct SqlCompletion {
    text: String,
    /// Where the replaced word starts, in UTF-16 code units from the start of the input
    /// (the unit Monaco and JavaScript strings use).
    start: usize,
    kind: String,
    /// Lower is better.
    score: u64,
    /// Text DuckDB suggests appending after the completion, e.g. a space after a keyword.
    extra: Option<String>,
}

/// Creates the mirror tables. A table whose column types DuckDB can't parse is
/// created with VARCHAR columns instead; types only show up as completion
/// details, so the names are what matters.
fn create_completion_tables(conn: &Connection, tables: &[CompletionTable]) {
    for table in tables.iter().filter(|t| !t.columns.is_empty()) {
        let name = escape_sql_ident(&table.alias);
        let typed = table
            .columns
            .iter()
            .map(|c| format!("\"{}\" {}", escape_sql_ident(&c.name), c.duckdb_type))
            .collect::<Vec<_>>()
            .join(", ");
        if conn.execute_batch(&format!("CREATE TABLE \"{name}\" ({typed});")).is_ok() {
            continue;
        }
        let untyped = table
            .columns
            .iter()
            .map(|c| format!("\"{}\" VARCHAR", escape_sql_ident(&c.name)))
            .collect::<Vec<_>>()
            .join(", ");
        let _ = conn.execute_batch(&format!("CREATE OR REPLACE TABLE \"{name}\" ({untyped});"));
    }
}

/// Opens a fresh completion connection with the given tables. Loads autocomplete
/// when it's installed; never downloads it (that's `prepare_sql_completions`).
fn build_completion_engine(tables: Vec<CompletionTable>) -> Result<CompletionEngine, String> {
    let conn = Connection::open_in_memory().map_err(|e| format!("open completion DuckDB: {e}"))?;
    // One thread is plenty for catalog lookups, and the engine stays tiny.
    conn.execute_batch("PRAGMA threads = 1;")
        .map_err(|e| format!("configure completion DuckDB: {e}"))?;
    let ready = conn.execute_batch("LOAD autocomplete;").is_ok();
    create_completion_tables(&conn, &tables);
    Ok(CompletionEngine { conn: Some(conn), tables, ready })
}

/// Byte offset → UTF-16 offset within `text`. Offsets inside a character round down.
fn utf16_offset(text: &str, byte_offset: usize) -> usize {
    let mut end = byte_offset.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].encode_utf16().count()
}

fn sql_completions_for(conn: &Connection, text: &str, limit: usize) -> Result<Vec<SqlCompletion>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT suggestion, suggestion_start, suggestion_type, suggestion_score, extra_char \
             FROM sql_auto_complete(?) ORDER BY suggestion_score LIMIT ?",
        )
        .map_err(|e| format!("prepare completion: {e}"))?;
    let rows = stmt
        .query_map(duckdb::params![text, limit as i64], |row| {
            let start: i64 = row.get(1)?;
            Ok(SqlCompletion {
                text: row.get(0)?,
                start: utf16_offset(text, start.max(0) as usize),
                kind: row.get(2)?,
                score: row.get::<_, Option<u64>>(3)?.unwrap_or(0),
                extra: row.get(4)?,
            })
        })
        .map_err(|e| format!("run completion: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect completions: {e}"))
}

/// Downloads (first use only) and loads the autocomplete extension. The download runs
/// on its own connection so completion requests aren't blocked behind it.
#[tauri::command(async)]
fn prepare_sql_completions(state: tauri::State<'_, Arc<AppRuntimeState>>) -> Result<(), String> {
    let st = state.inner().clone();
    on_duckdb_thread(move || {
        let started = Instant::now();
        let installer = Connection::open_in_memory().map_err(|e| format!("open DuckDB: {e}"))?;
        ensure_extension_loaded(&installer, "autocomplete")?;
        drop(installer);
        // Rebuild under the lock so a concurrent table sync can't be overwritten.
        let mut engine = st.completion.lock().map_err(|_| "Completion lock poisoned.".to_string())?;
        let rebuilt = build_completion_engine(engine.tables.clone())?;
        if !rebuilt.ready {
            return Err("load autocomplete extension: installed but failed to load".to_string());
        }
        *engine = rebuilt;
        drop(engine);
        log_perf(&st, "sql_completions_prepare", &format!("duration_ms={}", started.elapsed().as_millis()));
        Ok(())
    })
}

/// Replaces the completion engine's mirror tables (called when workspace schemas change).
#[tauri::command(async)]
fn sync_completion_tables(
    tables: Vec<CompletionTable>,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<(), String> {
    let mut engine = state.completion.lock().map_err(|_| "Completion lock poisoned.".to_string())?;
    *engine = build_completion_engine(tables)?;
    Ok(())
}

/// Completions for `text`, which ends at the cursor. Errors when autocomplete isn't
/// loaded yet, so the frontend can keep its basic suggestions.
#[tauri::command(async)]
fn sql_completions(
    text: String,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<Vec<SqlCompletion>, String> {
    let engine = state.completion.lock().map_err(|_| "Completion lock poisoned.".to_string())?;
    match (&engine.conn, engine.ready) {
        (Some(conn), true) => sql_completions_for(conn, &text, 200),
        _ => Err("SQL autocomplete is not ready.".to_string()),
    }
}

// ── Function reference (hover + signature help) ─────────────────────────────

#[derive(Serialize, Debug, Clone, PartialEq)]
struct FunctionParam {
    name: String,
    /// None for macros, whose parameters are untyped.
    duckdb_type: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
struct FunctionSignature {
    params: Vec<FunctionParam>,
    /// Type of the trailing variadic argument (`concat(ANY, ...)`), if any.
    varargs: Option<String>,
    returns: Option<String>,
}

/// One function name with all of its overloads, from `duckdb_functions()`.
#[derive(Serialize, Debug, Clone, PartialEq)]
struct FunctionDoc {
    name: String,
    /// scalar, aggregate, window, macro, table or table_macro.
    kind: String,
    description: Option<String>,
    examples: Vec<String>,
    /// Distinct overloads, in DuckDB's order.
    signatures: Vec<FunctionSignature>,
}

fn json_string_list(raw: Option<String>) -> Vec<Option<String>> {
    raw.and_then(|r| serde_json::from_str::<Vec<Option<String>>>(&r).ok())
        .unwrap_or_default()
}

/// Reads `duckdb_functions()` into one entry per (name, kind), overloads grouped and
/// de-duplicated. Pragmas are left out: they aren't called like functions.
fn load_function_docs(conn: &Connection) -> Result<Vec<FunctionDoc>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT function_name, function_type, description, return_type, \
                    to_json(parameters)::VARCHAR, to_json(parameter_types)::VARCHAR, \
                    varargs, to_json(examples)::VARCHAR \
             FROM duckdb_functions() \
             WHERE function_type <> 'pragma' \
             ORDER BY lower(function_name), function_type, function_oid",
        )
        .map_err(|e| format!("prepare function reference: {e}"))?;
    let mut rows = stmt.query([]).map_err(|e| format!("read function reference: {e}"))?;
    let mut docs: Vec<FunctionDoc> = Vec::new();
    while let Some(row) = rows.next().map_err(|e| format!("read function reference: {e}"))? {
        let get = |i: usize| -> Result<Option<String>, String> {
            row.get::<_, Option<String>>(i).map_err(|e| format!("read function reference: {e}"))
        };
        let name = get(0)?.unwrap_or_default();
        let kind = get(1)?.unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let names = json_string_list(get(4)?);
        let types = json_string_list(get(5)?);
        let params = names
            .iter()
            .enumerate()
            .map(|(i, n)| FunctionParam {
                name: n.clone().unwrap_or_else(|| format!("arg{}", i + 1)),
                duckdb_type: types.get(i).cloned().flatten(),
            })
            .collect();
        let signature = FunctionSignature { params, varargs: get(6)?, returns: get(3)? };
        let description = get(2)?.filter(|d| !d.trim().is_empty());
        let examples: Vec<String> = json_string_list(get(7)?).into_iter().flatten().collect();

        match docs.last_mut() {
            Some(doc) if doc.name == name && doc.kind == kind => {
                if !doc.signatures.contains(&signature) {
                    doc.signatures.push(signature);
                }
                if doc.description.is_none() {
                    doc.description = description;
                }
                for example in examples {
                    if !doc.examples.contains(&example) {
                        doc.examples.push(example);
                    }
                }
            }
            _ => docs.push(FunctionDoc { name, kind, description, examples, signatures: vec![signature] }),
        }
    }
    Ok(docs)
}

/// DuckDB's function reference, read on first use and then cached for the session.
#[tauri::command(async)]
fn sql_function_docs(state: tauri::State<'_, Arc<AppRuntimeState>>) -> Result<Arc<Vec<FunctionDoc>>, String> {
    let st = state.inner().clone();
    if let Some(docs) = st.function_docs.lock().map_err(|_| "Function reference lock poisoned.".to_string())?.clone() {
        return Ok(docs);
    }
    on_duckdb_thread(move || {
        let started = Instant::now();
        let conn = Connection::open_in_memory().map_err(|e| format!("open DuckDB: {e}"))?;
        let docs = Arc::new(load_function_docs(&conn)?);
        *st.function_docs.lock().map_err(|_| "Function reference lock poisoned.".to_string())? = Some(docs.clone());
        log_perf(&st, "sql_function_docs", &format!("duration_ms={} functions={}", started.elapsed().as_millis(), docs.len()));
        Ok(docs)
    })
}

// ── Saved queries ────────────────────────────────────────────────────────────

const SAVED_QUERIES_FILE: &str = "saved_queries.json";
const SAVED_QUERY_NAME_MAX: usize = 100;
/// Format version this build reads and writes.
const SAVED_QUERIES_VERSION: u32 = 1;

#[derive(Serialize, serde::Deserialize, Debug, Clone, PartialEq)]
struct SavedQuery {
    name: String,
    sql: String,
    /// Milliseconds since the Unix epoch.
    updated_at_ms: u64,
}

#[derive(Serialize, serde::Deserialize, Debug)]
struct SavedQueriesFile {
    version: u32,
    queries: Vec<SavedQuery>,
}

/// Saved queries in `path`, newest first. A missing file is an empty list; a file
/// that can't be read or parsed is an error (never silently treated as empty, so a
/// later save can't overwrite it).
fn read_saved_queries(path: &Path) -> Result<Vec<SavedQuery>, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Saved queries file can't be read ({}): {e}", path.display())),
    };
    let file: SavedQueriesFile = serde_json::from_str(&raw)
        .map_err(|e| format!("Saved queries file is damaged ({}): {e}", path.display()))?;
    if file.version > SAVED_QUERIES_VERSION {
        // Rewriting it would drop whatever the newer format added.
        return Err(format!(
            "Saved queries file was written by a newer version of Parq-Bench ({}). Update the app to use it.",
            path.display()
        ));
    }
    let mut queries = file.queries;
    queries.sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms));
    Ok(queries)
}

/// Writes to a temporary file next to `path`, flushes it to disk, then renames it over
/// `path`, so a crash or power loss mid-write leaves the previous file intact.
fn write_saved_queries(path: &Path, queries: &[SavedQuery]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("create saved queries folder: {e}"))?;
    }
    let json = serde_json::to_string_pretty(&SavedQueriesFile { version: SAVED_QUERIES_VERSION, queries: queries.to_vec() })
        .map_err(|e| format!("encode saved queries: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    {
        let mut file = fs::File::create(&tmp).map_err(|e| format!("write saved queries: {e}"))?;
        file.write_all(json.as_bytes()).map_err(|e| format!("write saved queries: {e}"))?;
        file.sync_all().map_err(|e| format!("write saved queries: {e}"))?;
    }
    fs::rename(&tmp, path).map_err(|e| format!("replace saved queries file: {e}"))
}

fn normalized_query_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Give the query a name.".to_string());
    }
    if name.chars().count() > SAVED_QUERY_NAME_MAX {
        return Err(format!("Names can be at most {SAVED_QUERY_NAME_MAX} characters."));
    }
    Ok(name.to_string())
}

/// Adds or replaces (by name, ignoring case) a saved query. Returns the new list.
fn upsert_saved_query(path: &Path, name: &str, sql: &str, now_ms: u64) -> Result<Vec<SavedQuery>, String> {
    let name = normalized_query_name(name)?;
    let mut queries = read_saved_queries(path)?;
    queries.retain(|q| q.name.to_lowercase() != name.to_lowercase());
    queries.insert(0, SavedQuery { name, sql: sql.to_string(), updated_at_ms: now_ms });
    write_saved_queries(path, &queries)?;
    Ok(queries)
}

/// Removes the saved query with this name (ignoring case). Returns the new list.
fn remove_saved_query(path: &Path, name: &str) -> Result<Vec<SavedQuery>, String> {
    let mut queries = read_saved_queries(path)?;
    let before = queries.len();
    queries.retain(|q| q.name.to_lowercase() != name.trim().to_lowercase());
    if queries.len() != before {
        write_saved_queries(path, &queries)?;
    }
    Ok(queries)
}

fn saved_queries_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(SAVED_QUERIES_FILE))
        .map_err(|e| format!("find the app data folder: {e}"))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command(async)]
fn list_saved_queries(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<Vec<SavedQuery>, String> {
    let _guard = state.saved_queries_lock.lock().map_err(|_| "Saved queries lock poisoned.".to_string())?;
    read_saved_queries(&saved_queries_path(&app)?)
}

#[tauri::command(async)]
fn save_query(
    name: String,
    sql: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<Vec<SavedQuery>, String> {
    let _guard = state.saved_queries_lock.lock().map_err(|_| "Saved queries lock poisoned.".to_string())?;
    upsert_saved_query(&saved_queries_path(&app)?, &name, &sql, now_ms())
}

#[tauri::command(async)]
fn delete_saved_query(
    name: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<Vec<SavedQuery>, String> {
    let _guard = state.saved_queries_lock.lock().map_err(|_| "Saved queries lock poisoned.".to_string())?;
    remove_saved_query(&saved_queries_path(&app)?, &name)
}

/// Sheet names from an .xlsx (a zip archive) by reading `xl/workbook.xml`.
/// The excel extension has no function that lists sheets.
fn xlsx_sheet_names(path: &str) -> Result<Vec<String>, String> {
    let file = fs::File::open(path).map_err(|e| format!("open xlsx: {e}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("read xlsx (is it a valid .xlsx file?): {e}"))?;
    let mut xml = String::new();
    archive
        .by_name("xl/workbook.xml")
        .map_err(|e| format!("read xlsx workbook: {e}"))?
        .read_to_string(&mut xml)
        .map_err(|e| format!("read xlsx workbook: {e}"))?;
    let names = parse_workbook_sheet_names(&xml);
    if names.is_empty() {
        return Err("No sheets found in this .xlsx file.".to_string());
    }
    Ok(names)
}

fn parse_workbook_sheet_names(xml: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut rest = xml;
    while let Some(lt) = rest.find('<') {
        rest = &rest[lt + 1..];
        // `>` is legal unescaped inside attribute values, so end the tag at the first `>` outside quotes.
        let Some(end) = tag_end(rest) else { break };
        let tag = &rest[..end];
        let element_end = tag
            .find(|c: char| c.is_whitespace() || c == '/')
            .unwrap_or(tag.len());
        let element = &tag[..element_end];
        // Generators may namespace-prefix elements (e.g. `<x:sheet>`).
        if element.rsplit(':').next() == Some("sheet") {
            if let Some(name) = xml_attribute(tag, "name") {
                names.push(xml_unescape(&name));
            }
        }
        rest = &rest[end + 1..];
    }
    names
}

fn xml_attribute(tag: &str, attribute: &str) -> Option<String> {
    for quote in ['"', '\''] {
        let pattern = format!("{attribute}={quote}");
        let mut from = 0;
        while let Some(found) = tag[from..].find(&pattern) {
            let at = from + found;
            // Whole attribute name only (not e.g. `sheetname=`).
            if tag[..at].ends_with(char::is_whitespace) {
                let start = at + pattern.len();
                let len = tag[start..].find(quote)?;
                return Some(tag[start..start + len].to_string());
            }
            from = at + pattern.len();
        }
    }
    None
}

/// Byte index of the `>` that closes a tag, skipping any inside quoted attribute values.
fn tag_end(rest: &str) -> Option<usize> {
    let mut quote: Option<char> = None;
    for (i, c) in rest.char_indices() {
        match (quote, c) {
            (None, '"' | '\'') => quote = Some(c),
            (Some(q), _) if c == q => quote = None,
            (None, '>') => return Some(i),
            _ => {}
        }
    }
    None
}

/// Decodes the five named XML entities and numeric references (`&#39;`, `&#x27;`).
fn xml_unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp + 1..];
        let decoded = after.find(';').and_then(|semi| {
            let entity = &after[..semi];
            let ch = match entity {
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "amp" => Some('&'),
                _ => entity
                    .strip_prefix("#x")
                    .or_else(|| entity.strip_prefix("#X"))
                    .map(|hex| u32::from_str_radix(hex, 16))
                    .or_else(|| entity.strip_prefix('#').map(|dec| dec.parse::<u32>()))
                    .and_then(Result::ok)
                    .and_then(char::from_u32),
            };
            ch.map(|c| (c, semi))
        });
        match decoded {
            Some((c, semi)) => {
                out.push(c);
                rest = &after[semi + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

#[tauri::command(async)]
fn list_xlsx_sheets(file_path: String) -> Result<Vec<String>, String> {
    let path = file_path.trim().to_string();
    if fs::metadata(&path).is_err() {
        return Err("Workspace file path does not exist.".to_string());
    }
    xlsx_sheet_names(&path)
}

#[derive(Serialize)]
struct SqliteObject {
    name: String,
    /// "table" or "view".
    kind: String,
}

fn sqlite_objects(conn: &Connection, path: &str) -> Result<Vec<SqliteObject>, String> {
    let escaped = escape_sql_string_literal(path);
    let sql = format!(
        "SELECT name, type FROM sqlite_scan('{escaped}', 'sqlite_master') \
         WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite!_%' ESCAPE '!' \
         ORDER BY type = 'view', name"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("list sqlite tables: {e}"))?;
    let rows = stmt
        .query_map([], |r| Ok(SqliteObject { name: r.get(0)?, kind: r.get(1)? }))
        .map_err(|e| format!("list sqlite tables: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("list sqlite tables: {e}"))
}

#[tauri::command(async)]
fn list_sqlite_tables(
    file_path: String,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<Vec<SqliteObject>, String> {
    let path = file_path.trim().to_string();
    if fs::metadata(&path).is_err() {
        return Err("Workspace file path does not exist.".to_string());
    }
    let st = state.inner().clone();
    on_duckdb_thread(move || sqlite_objects(&open_configured_duckdb(&st)?, &path))
}

/// Inspect a source before it is mounted: detected delimiter/header, glob
/// match count, schema, and the first few rows.
#[tauri::command(async)]
fn peek_workspace_source(
    file_path: String,
    is_glob: Option<bool>,
    source_kind: Option<String>,
    delimiter: Option<String>,
    object_name: Option<String>,
    header: Option<bool>,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<SourcePeekResponse, String> {
    ensure_memory_guard_clear(state.as_ref())?;
    let trimmed_path = file_path.trim().to_string();
    if trimmed_path.is_empty() {
        return Err("File path is required.".to_string());
    }
    let use_glob = is_glob.unwrap_or(false);
    let kind = parse_workspace_source_kind(source_kind)?;
    let object_name = object_name.filter(|n| !n.trim().is_empty());
    validate_workspace_source(&trimmed_path, use_glob, kind, object_name.as_deref())?;
    let resolved_delimiter = resolve_workspace_delimiter(&kind, &trimmed_path, delimiter)?;
    let registration = WorkspaceTableRegistration {
        alias: "_peek".to_string(),
        file_path: trimmed_path,
        is_glob: use_glob,
        source_kind: kind,
        delimiter: resolved_delimiter,
        row_count: None,
        object_name,
        header: if kind == WorkspaceSourceKind::Excel { header } else { None },
    };
    let st = state.inner().clone();
    on_duckdb_thread(move || peek_source(&open_configured_duckdb(&st)?, &registration))
}

fn peek_source(
    conn: &Connection,
    registration: &WorkspaceTableRegistration,
) -> Result<SourcePeekResponse, String> {
    let normalized = escape_sql_string_literal(&registration.file_path);

    let (matched_files, first_file) = if registration.is_glob {
        let count: u64 = conn
            .query_row(
                &format!("SELECT COUNT(*)::UBIGINT FROM glob('{normalized}')"),
                [],
                |r| r.get(0),
            )
            .map_err(|e| format!("match glob pattern: {e}"))?;
        if count == 0 {
            return Err(format!("No files match {}", registration.file_path));
        }
        let first: String = conn
            .query_row(
                &format!("SELECT file FROM glob('{normalized}') ORDER BY file LIMIT 1"),
                [],
                |r| r.get(0),
            )
            .map_err(|e| format!("match glob pattern: {e}"))?;
        (Some(count), first)
    } else {
        (None, registration.file_path.clone())
    };

    let (detected_delimiter, has_header) =
        if registration.source_kind == WorkspaceSourceKind::Delimited {
            let sniff_path = escape_sql_string_literal(&first_file);
            let sniff_sql = match registration.delimiter.as_deref() {
                Some(d) => format!(
                    "SELECT Delimiter, HasHeader FROM sniff_csv('{sniff_path}', delim='{}')",
                    escape_sql_literal(d)
                ),
                None => format!("SELECT Delimiter, HasHeader FROM sniff_csv('{sniff_path}')"),
            };
            let (d, h): (String, bool) = conn
                .query_row(&sniff_sql, [], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(|e| format!("detect delimiter: {e}"))?;
            (Some(d), Some(h))
        } else {
            (None, None)
        };

    let source = workspace_source_sql(registration);
    let select_sql = format!("SELECT * FROM {source}");
    let schema = query_schema(conn, &select_sql)?;
    let (rows, _) = query_rows_with_limit(conn, &select_sql, &schema, 5)?;
    let row_count = if registration.source_kind == WorkspaceSourceKind::Parquet {
        Some(parquet_metadata_row_count(conn, &normalized)?)
    } else {
        None
    };

    Ok(SourcePeekResponse {
        source_kind: registration.source_kind.as_str().to_string(),
        detected_delimiter,
        has_header,
        matched_files,
        row_count,
        schema,
        rows,
    })
}

#[tauri::command(async)]
fn register_workspace_table(
    alias: String,
    file_path: String,
    is_glob: Option<bool>,
    source_kind: Option<String>,
    delimiter: Option<String>,
    object_name: Option<String>,
    header: Option<bool>,
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
    let parsed_source_kind = parse_workspace_source_kind(source_kind)?;
    let object_name = object_name.filter(|n| !n.trim().is_empty());
    validate_workspace_source(trimmed_path, use_glob, parsed_source_kind, object_name.as_deref())?;
    let resolved_delimiter =
        resolve_workspace_delimiter(&parsed_source_kind, trimmed_path, delimiter)?;

    // Row count from Parquet footer metadata (cheap; no data scan). Delimited
    // sources would need a full scan, so they report no count.
    let row_count = if parsed_source_kind == WorkspaceSourceKind::Parquet {
        let st = state.inner().clone();
        let path_for_count = trimmed_path.to_string();
        match on_duckdb_thread(move || {
            let conn = open_configured_duckdb(&st)?;
            parquet_metadata_row_count(&conn, &escape_sql_string_literal(&path_for_count))
        }) {
            Ok(count) => Some(count),
            Err(err) => {
                log_perf(
                    state.as_ref(),
                    "workspace_row_count_unavailable",
                    &format!("path={} error={err}", redact_for_log(trimmed_path)),
                );
                None
            }
        }
    } else {
        None
    };

    let mut tables = state
        .workspace_tables
        .lock()
        .map_err(|_| "Workspace table lock poisoned.".to_string())?;
    let next_entry = WorkspaceTableRegistration {
        alias: trimmed_alias.to_string(),
        file_path: trimmed_path.to_string(),
        is_glob: use_glob,
        source_kind: parsed_source_kind,
        delimiter: resolved_delimiter,
        row_count,
        object_name,
        header: if parsed_source_kind == WorkspaceSourceKind::Excel { header } else { None },
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
fn rename_workspace_table(
    old_alias: String,
    new_alias: String,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<WorkspaceTableInfo, String> {
    let trimmed_old = old_alias.trim();
    let trimmed_new = new_alias.trim();
    if trimmed_old.is_empty() || trimmed_new.is_empty() {
        return Err("Both old and new alias are required.".to_string());
    }
    if !is_valid_workspace_alias(trimmed_new) {
        return Err(
            "Alias must start with a letter/underscore and only contain letters, numbers, and underscores."
                .to_string(),
        );
    }

    let mut tables = state
        .workspace_tables
        .lock()
        .map_err(|_| "Workspace table lock poisoned.".to_string())?;

    let entry_idx = tables
        .iter()
        .position(|entry| entry.alias.eq_ignore_ascii_case(trimmed_old))
        .ok_or_else(|| format!("Workspace alias not found: {trimmed_old}"))?;

    let collides = tables.iter().enumerate().any(|(idx, entry)| {
        idx != entry_idx && entry.alias.eq_ignore_ascii_case(trimmed_new)
    });
    if collides {
        return Err(format!(
            "Workspace alias '{}' is already in use.",
            trimmed_new
        ));
    }

    tables[entry_idx].alias = trimmed_new.to_string();
    Ok(workspace_table_info(&tables[entry_idx]))
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

#[tauri::command(async)]
/// Runs one statement and returns its rows. `setup_sql` holds earlier statements
/// (from "Run all") that run first on the same connection, so the last statement
/// can use what they create. The frontend splits scripts into statements.
fn run_workspace_query(
    sql: String,
    setup_sql: Option<Vec<String>>,
    row_limit: u32,
    query_id: Option<String>,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<WorkspaceQueryResponse, String> {
    ensure_memory_guard_clear(state.as_ref())?;
    let st = state.inner().clone();
    let tables = {
        let lock = st.workspace_tables.lock()
            .map_err(|_| "Workspace table lock poisoned.".to_string())?;
        lock.clone()
    };
    on_duckdb_thread(move || {
        let conn = open_configured_duckdb(&st)?;
        let guard = track_query(&st, query_id, &conn)?;
        let outcome = run_statements(&st, &conn, &tables, &sql, setup_sql.as_deref().unwrap_or(&[]), row_limit, &guard);
        guard.finish(outcome)
    })
}

fn run_statements(
    st: &Arc<AppRuntimeState>,
    conn: &Connection,
    tables: &[WorkspaceTableRegistration],
    sql: &str,
    setup_sql: &[String],
    row_limit: u32,
    guard: &RunningQueryGuard,
) -> Result<WorkspaceQueryResponse, String> {
    let st = st.clone();
    {
        let trimmed = sql.trim().trim_end_matches(';').trim().to_string();
        if trimmed.is_empty() {
            return Err("SQL query is required.".to_string());
        }
        let mut all_sql = setup_sql.join("\n");
        all_sql.push('\n');
        all_sql.push_str(&trimmed);
        guard.check()?;
        apply_workspace_tables(conn, &tables_referenced_by(&all_sql, tables))?;
        let started = Instant::now();
        let safe_limit = row_limit.max(1);

        for (index, statement) in setup_sql.iter().enumerate() {
            let statement = statement.trim();
            if statement.is_empty() {
                continue;
            }
            guard.check()?;
            conn.execute_batch(statement)
                .map_err(|e| format!("statement {} of {}: {e}", index + 1, setup_sql.len() + 1))?;
        }

        guard.check()?;
        if is_select_like(&trimmed) {
            let schema = query_schema(conn, &trimmed)?;
            guard.check()?;
            let (rows, truncated) = query_rows_with_limit_cancellable(
                conn, &trimmed, &schema, safe_limit, &guard.cancelled,
            )?;
            let elapsed_ms = started.elapsed().as_millis();
            log_perf(
                &st,
                "run_workspace_query",
                &format!(
                    "duration_ms={} row_limit={} row_count={} truncated={}",
                    elapsed_ms,
                    safe_limit,
                    rows.len(),
                    truncated,
                ),
            );

            Ok(WorkspaceQueryResponse {
                sql: trimmed,
                row_limit: safe_limit,
                row_count: rows.len(),
                truncated,
                elapsed_ms,
                schema,
                rows,
                returns_rows: true,
            })
        } else {
            // Utility / DDL / DML statement — execute directly, no rows returned
            conn.execute_batch(&trimmed)
                .map_err(|e| format!("execute statement: {e}"))?;
            let elapsed_ms = started.elapsed().as_millis();
            log_perf(
                &st,
                "run_workspace_query",
                &format!("duration_ms={} utility_statement=true", elapsed_ms),
            );

            Ok(WorkspaceQueryResponse {
                sql: trimmed,
                row_limit: safe_limit,
                row_count: 0,
                truncated: false,
                elapsed_ms,
                schema: vec![ParquetSchemaColumn {
                    name: "result".to_string(),
                    duckdb_type: "VARCHAR".to_string(),
                }],
                rows: vec![vec![Some("Statement executed successfully.".to_string())]],
                returns_rows: false,
            })
        }
    }
}

#[tauri::command(async)]
fn describe_workspace_table(
    alias: String,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<Vec<ParquetSchemaColumn>, String> {
    ensure_memory_guard_clear(state.as_ref())?;
    let alias_trimmed = alias.trim().to_string();
    if alias_trimmed.is_empty() {
        return Err("Workspace alias is required.".to_string());
    }

    {
        let lock = state
            .workspace_tables
            .lock()
            .map_err(|_| "Workspace table lock poisoned.".to_string())?;
        if !lock
            .iter()
            .any(|entry| entry.alias.eq_ignore_ascii_case(&alias_trimmed))
        {
            return Err(format!("Workspace alias not found: {alias_trimmed}"));
        }
    }

    let st = state.inner().clone();
    let tables = {
        let lock = st.workspace_tables.lock()
            .map_err(|_| "Workspace table lock poisoned.".to_string())?;
        lock.clone()
    };
    on_duckdb_thread(move || {
        let conn = open_configured_duckdb(&st)?;
        apply_workspace_tables(&conn, &tables_with_aliases(&tables, &[alias_trimmed.as_str()]))?;
        table_schema_for_alias(&conn, &alias_trimmed)
    })
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
fn export_workspace_query(
    sql: String,
    setup_sql: Option<Vec<String>>,
    output_path: String,
    format: String,
    query_text: Option<String>,
    table_aliases: Option<Vec<String>>,
    query_id: Option<String>,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<WorkspaceExportResponse, String> {
    ensure_memory_guard_clear(state.as_ref())?;
    let normalized_sql = normalize_single_sql_statement(&sql)?;
    let setup_sql = setup_sql.unwrap_or_default();
    let trimmed_path = output_path.trim().to_string();
    if trimmed_path.is_empty() {
        return Err("Output path is required.".to_string());
    }

    let st = state.inner().clone();
    let tables = {
        let lock = st.workspace_tables.lock()
            .map_err(|_| "Workspace table lock poisoned.".to_string())?;
        lock.clone()
    };
    on_duckdb_thread(move || {
        let conn = open_configured_duckdb(&st)?;
        let guard = track_query(&st, query_id, &conn)?;
        let existed_before = existing_export_artifacts(&trimmed_path);
        let mut all_sql = setup_sql.join("\n");
        all_sql.push('\n');
        all_sql.push_str(&normalized_sql);
        let written = (|| {
            guard.check()?;
            apply_workspace_tables(&conn, &tables_referenced_by(&all_sql, &tables))?;
            for statement in setup_sql.iter().map(|s| s.trim()).filter(|s| !s.is_empty()) {
                guard.check()?;
                conn.execute_batch(statement)
                    .map_err(|e| format!("export setup statement: {e}"))?;
            }
            guard.check()?;
            let started = Instant::now();
            export_workspace_query_to_file(
                &conn,
                &normalized_sql,
                &trimmed_path,
                &format,
                query_text.as_deref(),
                table_aliases.as_deref(),
            )?;
            Ok(started)
        })();
        // A file that was written completely is kept and reported, even if Cancel
        // arrived in the same instant: deleting a finished export would lose work,
        // and an overwritten file can't be restored anyway.
        let started = match written {
            Ok(started) => started,
            Err(e) => {
                remove_partial_export(&trimmed_path, &existed_before);
                return guard.finish(Err(e));
            }
        };

        let file_size_bytes = fs::metadata(&trimmed_path)
            .map(|meta| meta.len())
            .unwrap_or(0);
        let elapsed_ms = started.elapsed().as_millis();
        let normalized_format = format.trim().to_ascii_lowercase();
        log_perf(
            &st,
            "export_workspace_query",
            &format!(
                "duration_ms={} format={} output_path={} file_size_bytes={}",
                elapsed_ms,
                normalized_format,
                trimmed_path,
                file_size_bytes
            ),
        );

        Ok(WorkspaceExportResponse {
            sql: normalized_sql,
            format: normalized_format,
            output_path: trimmed_path,
            file_size_bytes,
            elapsed_ms,
        })
    })
}

#[tauri::command(async)]
fn explain_workspace_query(
    sql: String,
    query_id: Option<String>,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<String, String> {
    ensure_memory_guard_clear(state.as_ref())?;
    let st = state.inner().clone();
    let tables = {
        let lock = st.workspace_tables.lock()
            .map_err(|_| "Workspace table lock poisoned.".to_string())?;
        lock.clone()
    };
    on_duckdb_thread(move || {
        let conn = open_configured_duckdb(&st)?;
        // EXPLAIN ANALYZE runs the query, so it can take as long as the query itself.
        let guard = track_query(&st, query_id, &conn)?;
        let outcome = (|| {
            guard.check()?;
            apply_workspace_tables(&conn, &tables_referenced_by(&sql, &tables))?;
            let normalized_sql = normalize_single_sql_statement(&sql)?;
            guard.check()?;
            let explain_sql = format!("EXPLAIN ANALYZE {normalized_sql}");
            let mut stmt = conn
                .prepare(&explain_sql)
                .map_err(|e| format!("prepare explain: {e}"))?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|e| format!("run explain: {e}"))?;
            let lines: Vec<String> = rows
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("collect explain rows: {e}"))?;
            Ok(lines.join("\n"))
        })();
        guard.finish(outcome)
    })
}

#[tauri::command(async)]
fn summarize_workspace_table(
    alias: String,
    deep: Option<bool>,
    query_id: Option<String>,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<Vec<std::collections::HashMap<String, String>>, String> {
    ensure_memory_guard_clear(state.as_ref())?;
    let alias_trimmed = alias.trim().to_string();
    if alias_trimmed.is_empty() {
        return Err("Workspace alias is required.".to_string());
    }

    let st = state.inner().clone();
    let (file_path, source_kind, tables) = {
        let lock = st
            .workspace_tables
            .lock()
            .map_err(|_| "Workspace table lock poisoned.".to_string())?;
        match lock.iter().find(|entry| entry.alias.eq_ignore_ascii_case(&alias_trimmed)) {
            Some(entry) => (entry.file_path.clone(), entry.source_kind, lock.clone()),
            None => return Err(format!("Workspace alias not found: {alias_trimmed}")),
        }
    };

    let use_fast_path = !deep.unwrap_or(false) && source_kind == WorkspaceSourceKind::Parquet;
    on_duckdb_thread(move || {
        let conn = open_configured_duckdb(&st)?;
        // Exact stats scan the whole table, so they can be cancelled.
        let guard = track_query(&st, query_id, &conn)?;
        let outcome = (|| {
            guard.check()?;
            apply_workspace_tables(&conn, &tables_with_aliases(&tables, &[alias_trimmed.as_str()]))?;
            let conn = &conn;
            let started = Instant::now();

            let (col_names, sql) = if use_fast_path {
                let escaped_path = escape_sql_string_literal(&file_path);
                let cols = vec![
                    "column_name", "column_type", "min", "max", "count", "null_percentage",
                ];
                let q = format!(
                    concat!(
                        "SELECT ",
                        "s.name AS column_name, ",
                        "s.type AS column_type, ",
                        "COALESCE(CAST(MIN(TRY_CAST(m.stats_min_value AS DOUBLE)) AS VARCHAR), MIN(m.stats_min_value)) AS min, ",
                        "COALESCE(CAST(MAX(TRY_CAST(m.stats_max_value AS DOUBLE)) AS VARCHAR), MAX(m.stats_max_value)) AS max, ",
                        "CAST(SUM(m.num_values) AS VARCHAR) AS count, ",
                        "CAST(ROUND(SUM(m.stats_null_count) * 100.0 ",
                        "/ NULLIF(SUM(m.num_values), 0), 2) AS VARCHAR) AS null_percentage ",
                        "FROM parquet_schema('{}') s ",
                        "JOIN parquet_metadata('{}') m ON s.name = m.path_in_schema ",
                        "WHERE s.name != 'duckdb_schema' ",
                        "GROUP BY s.name, m.column_id, s.type ",
                        "ORDER BY m.column_id"
                    ),
                    escaped_path, escaped_path
                );
                (cols, q)
            } else {
                let ident = escape_sql_ident(&alias_trimmed);
                let cols = vec![
                    "column_name", "column_type", "min", "max", "approx_unique",
                    "avg", "std", "q25", "q50", "q75", "count", "null_percentage",
                ];
                let q = format!(
                    concat!(
                        "SELECT ",
                        "CAST(column_name AS VARCHAR) AS column_name, ",
                        "CAST(column_type AS VARCHAR) AS column_type, ",
                        "CAST(min AS VARCHAR) AS min, ",
                        "CAST(max AS VARCHAR) AS max, ",
                        "CAST(approx_unique AS VARCHAR) AS approx_unique, ",
                        "CAST(avg AS VARCHAR) AS avg, ",
                        "CAST(std AS VARCHAR) AS std, ",
                        "CAST(q25 AS VARCHAR) AS q25, ",
                        "CAST(q50 AS VARCHAR) AS q50, ",
                        "CAST(q75 AS VARCHAR) AS q75, ",
                        "CAST(count AS VARCHAR) AS count, ",
                        "CAST(null_percentage AS VARCHAR) AS null_percentage ",
                        "FROM (SUMMARIZE \"{}\")"
                    ),
                    ident
                );
                (cols, q)
            };

            guard.check()?;
            let mut stmt = conn
                .prepare(&sql)
                .map_err(|e| format!("prepare summarize: {e}"))?;
            let row_iter = stmt
                .query_map([], |row| {
                    let mut map = std::collections::HashMap::new();
                    for (i, name) in col_names.iter().enumerate() {
                        let val: String = row.get::<_, Option<String>>(i)?.unwrap_or_default();
                        map.insert(name.to_string(), val);
                    }
                    Ok(map)
                })
                .map_err(|e| format!("run summarize: {e}"))?;
            let results: Vec<std::collections::HashMap<String, String>> = row_iter
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("collect summarize rows: {e}"))?;
            let log_label = if use_fast_path { "summarize_workspace_table_fast" } else { "summarize_workspace_table" };
            log_perf(
                &st,
                log_label,
                &format!(
                    "alias={} duration_ms={} rows={}",
                    alias_trimmed,
                    started.elapsed().as_millis(),
                    results.len(),
                ),
            );
            Ok(results)
        })();
        guard.finish(outcome)
    })
}

#[tauri::command(async)]
fn diff_workspace_schema(
    left_alias: String,
    right_alias: String,
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<WorkspaceSchemaDiffResponse, String> {
    ensure_memory_guard_clear(state.as_ref())?;
    let left_trimmed = left_alias.trim().to_string();
    let right_trimmed = right_alias.trim().to_string();
    if left_trimmed.is_empty() || right_trimmed.is_empty() {
        return Err("Both workspace aliases are required.".to_string());
    }
    if left_trimmed.eq_ignore_ascii_case(&right_trimmed) {
        return Err("Choose two different workspace aliases for schema diff.".to_string());
    }

    {
        let lock = state
            .workspace_tables
            .lock()
            .map_err(|_| "Workspace table lock poisoned.".to_string())?;
        let has_left = lock
            .iter()
            .any(|entry| entry.alias.eq_ignore_ascii_case(&left_trimmed));
        let has_right = lock
            .iter()
            .any(|entry| entry.alias.eq_ignore_ascii_case(&right_trimmed));
        if !has_left {
            return Err(format!("Workspace alias not found: {left_trimmed}"));
        }
        if !has_right {
            return Err(format!("Workspace alias not found: {right_trimmed}"));
        }
    }

    let st = state.inner().clone();
    let tables = {
        let lock = st.workspace_tables.lock()
            .map_err(|_| "Workspace table lock poisoned.".to_string())?;
        lock.clone()
    };
    on_duckdb_thread(move || {
        let conn = open_configured_duckdb(&st)?;
        apply_workspace_tables(&conn, &tables_with_aliases(&tables, &[left_trimmed.as_str(), right_trimmed.as_str()]))?;
        let conn = &conn;
        let left_schema = table_schema_for_alias(conn, &left_trimmed)?;
        let right_schema = table_schema_for_alias(conn, &right_trimmed)?;
        let diff =
            build_workspace_schema_diff(&left_trimmed, &left_schema, &right_trimmed, &right_schema);
        log_perf(
            &st,
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
    })
}

#[tauri::command]
fn get_log_path(
    state: tauri::State<'_, Arc<AppRuntimeState>>,
) -> Result<String, String> {
    let guard = state
        .log_file
        .lock()
        .map_err(|_| "Log file lock poisoned.".to_string())?;
    match guard.as_ref() {
        Some(path) => Ok(path.to_string_lossy().to_string()),
        None => Err("Log file path not initialized.".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_workspace_tables, build_workspace_schema_diff, compute_duckdb_memory_limit_bytes,
        compute_duckdb_threads, escape_sql_string_literal, export_workspace_query_to_file,
        flattened_columns_for_source, is_select_like, normalize_single_sql_statement,
        open_configured_duckdb, parquet_metadata_row_count, parquet_rows_page, parquet_total_rows, query_rows_with_limit,
        query_schema, schema_from_flattened, start_socket_server_for_payload,
        table_schema_for_alias, AppRuntimeState, ParquetSchemaColumn, WorkspaceSourceKind,
        WorkspaceTableRegistration, DUCKDB_MEMORY_CAP_BYTES, default_delimiter_for_path,
        peek_source, resolve_workspace_delimiter,
    };
    use futures_util::StreamExt;
    use duckdb::Connection;
    use std::fs;
    use std::io::ErrorKind;
    use std::sync::Arc;
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
        let flattened = flattened_columns_for_source(&conn, &source).expect("load flattened columns");
        let schema = schema_from_flattened(&flattened);
        assert_eq!(schema.len(), 2);
        assert_eq!(schema[0].name, "id");
        assert_eq!(schema[1].name, "label");

        let total_rows = parquet_total_rows(&conn, &escaped_path, &source).expect("count rows");
        assert_eq!(total_rows, 3);

        let rows = parquet_rows_page(&conn, &source, &flattened, 0, 10).expect("load parquet rows");
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0][0].as_deref(), Some("1"));
        assert_eq!(rows[0][1].as_deref(), Some("alpha"));
        assert_eq!(rows[2][0].as_deref(), Some("3"));
        assert_eq!(rows[2][1].as_deref(), Some("gamma"));

        let _ = fs::remove_file(&temp_file);
    }

    #[test]
    fn parquet_row_count_comes_from_footer_metadata() {
        let state = AppRuntimeState::new();
        let conn = open_configured_duckdb(&state).expect("open configured duckdb");
        let temp_file = unique_test_parquet_path();
        let escaped_path = escape_sql_string_literal(&temp_file);
        conn.execute_batch(&format!(
            "COPY (SELECT range AS id FROM range(1234)) TO '{escaped_path}' (FORMAT PARQUET, ROW_GROUP_SIZE 500);"
        ))
        .expect("write multi-row-group parquet fixture");

        // Must succeed on its own; parquet_total_rows only scans if this errors.
        let from_metadata =
            parquet_metadata_row_count(&conn, &escaped_path).expect("row count from metadata");
        assert_eq!(from_metadata, 1234);
        let source = format!("read_parquet('{escaped_path}')");
        assert_eq!(parquet_total_rows(&conn, &escaped_path, &source).expect("total rows"), 1234);

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
        let flattened = flattened_columns_for_source(&conn, &source).expect("load flattened columns");
        let schema = schema_from_flattened(&flattened);
        let names = schema
            .iter()
            .map(|column| column.name.clone())
            .collect::<Vec<_>>();
        assert!(names.iter().any(|name| name == "flow.src_port"));
        assert!(names.iter().any(|name| name == "flow.meta.duration_ms"));
        assert!(names.iter().any(|name| name == "ports"));
        let ports_col = schema
            .iter()
            .find(|column| column.name == "ports")
            .expect("ports column present");
        assert_eq!(ports_col.duckdb_type, "VARCHAR");

        let rows = parquet_rows_page(&conn, &source, &flattened, 0, 10).expect("load flattened rows");
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
            let state = Arc::new(AppRuntimeState::new());
            let server = start_socket_server_for_payload(state, payload.clone())
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
                source_kind: WorkspaceSourceKind::Parquet,
                delimiter: None,
                row_count: None,
                object_name: None,
                header: None,
            },
            WorkspaceTableRegistration {
                alias: "right_tbl".to_string(),
                file_path: right_path.clone(),
                is_glob: false,
                source_kind: WorkspaceSourceKind::Parquet,
                delimiter: None,
                row_count: None,
                object_name: None,
                header: None,
            },
        ];
        apply_workspace_tables(&conn, &tables).expect("apply workspace tables");

        let sql =
            "SELECT l.id, l.tag, r.score FROM left_tbl l JOIN right_tbl r USING (id) ORDER BY l.id";
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
            source_kind: WorkspaceSourceKind::Parquet,
            delimiter: None,
            row_count: None,
            object_name: None,
            header: None,
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
            source_kind: WorkspaceSourceKind::Parquet,
            delimiter: None,
            row_count: None,
            object_name: None,
            header: None,
        }];
        apply_workspace_tables(&conn, &tables).expect("apply workspace tables");

        let schema = table_schema_for_alias(&conn, "traffic_tbl").expect("table schema");
        let names = schema
            .iter()
            .map(|column| column.name.clone())
            .collect::<Vec<_>>();
        assert!(names.iter().any(|name| name == "flow.destination_port"));
        assert!(names
            .iter()
            .any(|name| name == "flow.metrics.flow_duration"));
        assert!(names.iter().any(|name| name == "tags"));

        let sql = r#"SELECT "flow.destination_port", "flow.metrics.flow_duration", tags FROM traffic_tbl"#;
        let result_schema = query_schema(&conn, sql).expect("workspace flattened schema");
        let (rows, truncated) = query_rows_with_limit(&conn, sql, &result_schema, 10)
            .expect("workspace flattened rows");
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

        let diff =
            build_workspace_schema_diff("left_tbl", &left_schema, "right_tbl", &right_schema);
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
            source_kind: WorkspaceSourceKind::Parquet,
            delimiter: None,
            row_count: None,
            object_name: None,
            header: None,
        }];
        apply_workspace_tables(&conn, &tables).expect("apply workspace tables");

        let sql = "SELECT id, label FROM exp_tbl ORDER BY id";
        let csv_path = unique_test_output_path("csv");
        let parquet_path = unique_test_output_path("parquet");

        export_workspace_query_to_file(&conn, sql, &csv_path, "csv", None, None).expect("export csv");
        export_workspace_query_to_file(&conn, sql, &parquet_path, "parquet", None, None)
            .expect("export parquet");

        let csv_contents = fs::read_to_string(&csv_path).expect("read csv");
        assert!(csv_contents.contains("id,label"));
        assert!(csv_contents.contains("1,alpha"));
        assert!(fs::metadata(&parquet_path).expect("parquet metadata").len() > 0);

        let _ = fs::remove_file(&source_path);
        let _ = fs::remove_file(&csv_path);
        let _ = fs::remove_file(&parquet_path);
    }

    #[test]
    fn workspace_query_reads_delimited_csv_with_default_comma() {
        let state = AppRuntimeState::new();
        let conn = open_configured_duckdb(&state).expect("open configured duckdb");

        let csv_path = unique_test_output_path("csv");
        fs::write(&csv_path, "id,label\n1,alpha\n2,beta\n").expect("write csv fixture");

        let tables = vec![WorkspaceTableRegistration {
            alias: "csv_tbl".to_string(),
            file_path: csv_path.clone(),
            is_glob: false,
            source_kind: WorkspaceSourceKind::Delimited,
            delimiter: None,
            row_count: None,
            object_name: None,
            header: None,
        }];
        apply_workspace_tables(&conn, &tables).expect("apply csv workspace table");

        let sql = "SELECT id, label FROM csv_tbl ORDER BY id";
        let schema = query_schema(&conn, sql).expect("csv schema");
        let (rows, truncated) =
            query_rows_with_limit(&conn, sql, &schema, 10).expect("csv query rows");
        assert!(!truncated);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0][0].as_deref(), Some("1"));
        assert_eq!(rows[0][1].as_deref(), Some("alpha"));
        assert_eq!(rows[1][0].as_deref(), Some("2"));
        assert_eq!(rows[1][1].as_deref(), Some("beta"));

        let _ = fs::remove_file(&csv_path);
    }

    #[test]
    fn workspace_query_reads_delimited_tsv_with_tab_delimiter() {
        let state = AppRuntimeState::new();
        let conn = open_configured_duckdb(&state).expect("open configured duckdb");

        let tsv_path = unique_test_output_path("tsv");
        fs::write(&tsv_path, "id\tlabel\n1\talpha\n2\tbeta\n").expect("write tsv fixture");

        let tables = vec![WorkspaceTableRegistration {
            alias: "tsv_tbl".to_string(),
            file_path: tsv_path.clone(),
            is_glob: false,
            source_kind: WorkspaceSourceKind::Delimited,
            delimiter: Some("\t".to_string()),
            row_count: None,
            object_name: None,
            header: None,
        }];
        apply_workspace_tables(&conn, &tables).expect("apply tsv workspace table");

        let sql = "SELECT id, label FROM tsv_tbl ORDER BY id";
        let schema = query_schema(&conn, sql).expect("tsv schema");
        let (rows, truncated) =
            query_rows_with_limit(&conn, sql, &schema, 10).expect("tsv query rows");
        assert!(!truncated);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0][0].as_deref(), Some("1"));
        assert_eq!(rows[0][1].as_deref(), Some("alpha"));
        assert_eq!(rows[1][0].as_deref(), Some("2"));
        assert_eq!(rows[1][1].as_deref(), Some("beta"));

        let _ = fs::remove_file(&tsv_path);
    }

    fn delimited_registration(alias: &str, path: &str, is_glob: bool) -> WorkspaceTableRegistration {
        WorkspaceTableRegistration {
            alias: alias.to_string(),
            file_path: path.to_string(),
            is_glob,
            source_kind: WorkspaceSourceKind::Delimited,
            delimiter: resolve_workspace_delimiter(&WorkspaceSourceKind::Delimited, path, None)
                .expect("resolve delimiter"),
            row_count: None,
            object_name: None,
            header: None,
        }
    }

    fn query_two_rows(conn: &Connection, sql: &str) -> Vec<Vec<Option<String>>> {
        let schema = query_schema(conn, sql).expect("schema");
        let (rows, _) = query_rows_with_limit(conn, sql, &schema, 10).expect("rows");
        rows
    }

    #[test]
    fn default_delimiter_maps_extensions() {
        assert_eq!(default_delimiter_for_path("a.tsv"), Some('\t'));
        assert_eq!(default_delimiter_for_path("A.PSV"), Some('|'));
        assert_eq!(default_delimiter_for_path("dir/*.psv"), Some('|'));
        assert_eq!(default_delimiter_for_path("a.csv"), None);
        assert_eq!(default_delimiter_for_path("a.txt"), None);
    }

    #[test]
    fn workspace_query_reads_psv_with_pipe_delimiter() {
        let state = AppRuntimeState::new();
        let conn = open_configured_duckdb(&state).expect("open configured duckdb");
        let path = unique_test_output_path("psv");
        fs::write(&path, "id|label\n1|alpha\n2|beta\n").expect("write psv fixture");

        let reg = delimited_registration("psv_tbl", &path, false);
        assert_eq!(reg.delimiter.as_deref(), Some("|"));
        apply_workspace_tables(&conn, &[reg]).expect("apply psv table");

        let rows = query_two_rows(&conn, "SELECT id, label FROM psv_tbl ORDER BY id");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0][1].as_deref(), Some("alpha"));
        assert_eq!(rows[1][1].as_deref(), Some("beta"));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn workspace_query_sniffs_pipe_delimited_txt() {
        let state = AppRuntimeState::new();
        let conn = open_configured_duckdb(&state).expect("open configured duckdb");
        let path = unique_test_output_path("txt");
        fs::write(&path, "id|label|score\n1|alpha|3.5\n2|beta|4.0\n").expect("write txt fixture");

        let reg = delimited_registration("txt_tbl", &path, false);
        assert_eq!(reg.delimiter, None, ".txt should defer to the sniffer");
        apply_workspace_tables(&conn, &[reg]).expect("apply txt table");

        let schema = query_schema(&conn, "SELECT * FROM txt_tbl").expect("txt schema");
        assert_eq!(schema.len(), 3, "pipe-delimited .txt must split into 3 columns");
        let rows = query_two_rows(&conn, "SELECT id, label FROM txt_tbl ORDER BY id");
        assert_eq!(rows[0][1].as_deref(), Some("alpha"));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn workspace_query_reads_csv_glob_folder() {
        let state = AppRuntimeState::new();
        let conn = open_configured_duckdb(&state).expect("open configured duckdb");
        let dir = std::path::PathBuf::from(unique_test_output_path("dir"));
        fs::create_dir_all(&dir).expect("create glob dir");
        fs::write(dir.join("a.csv"), "id,label\n1,alpha\n").expect("write a.csv");
        fs::write(dir.join("b.csv"), "id,label\n2,beta\n").expect("write b.csv");
        let pattern = dir.join("*.csv").to_string_lossy().to_string();

        let reg = delimited_registration("glob_tbl", &pattern, true);
        apply_workspace_tables(&conn, &[reg.clone()]).expect("apply glob table");
        let rows = query_two_rows(&conn, "SELECT id, label FROM glob_tbl ORDER BY id");
        assert_eq!(rows.len(), 2);

        let peek = peek_source(&conn, &reg).expect("peek glob");
        assert_eq!(peek.matched_files, Some(2));
        assert_eq!(peek.detected_delimiter.as_deref(), Some(","));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn peek_source_detects_psv_and_returns_sample_rows() {
        let state = AppRuntimeState::new();
        let conn = open_configured_duckdb(&state).expect("open configured duckdb");
        let path = unique_test_output_path("psv");
        let mut contents = String::from("id|label\n");
        for i in 0..8 {
            contents.push_str(&format!("{i}|row{i}\n"));
        }
        fs::write(&path, contents).expect("write psv fixture");

        let peek = peek_source(&conn, &delimited_registration("p", &path, false)).expect("peek psv");
        assert_eq!(peek.detected_delimiter.as_deref(), Some("|"));
        assert_eq!(peek.has_header, Some(true));
        assert_eq!(peek.schema.len(), 2);
        assert_eq!(peek.rows.len(), 5);
        assert_eq!(peek.matched_files, None);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn peek_source_errors_when_glob_matches_nothing() {
        let state = AppRuntimeState::new();
        let conn = open_configured_duckdb(&state).expect("open configured duckdb");
        let dir = std::path::PathBuf::from(unique_test_output_path("emptydir"));
        fs::create_dir_all(&dir).expect("create dir");
        let pattern = dir.join("*.psv").to_string_lossy().to_string();
        let err = peek_source(&conn, &delimited_registration("p", &pattern, true))
            .err()
            .expect("empty glob should error");
        assert!(err.contains("No files match"), "unexpected error: {err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn is_select_like_detects_select_statements() {
        assert!(is_select_like("SELECT 1"));
        assert!(is_select_like("  SELECT * FROM t"));
        assert!(is_select_like("WITH cte AS (SELECT 1) SELECT * FROM cte"));
        assert!(is_select_like("VALUES (1, 2), (3, 4)"));
        assert!(is_select_like("(SELECT 1 UNION SELECT 2)"));
        assert!(is_select_like("TABLE my_table"));
        assert!(is_select_like("FROM my_table SELECT *"));
        assert!(is_select_like("SUMMARIZE my_table"));
        assert!(is_select_like("SUMMARIZE SELECT * FROM t"));
    }

    #[test]
    fn is_select_like_rejects_non_select_statements() {
        assert!(!is_select_like("INSTALL tpch"));
        assert!(!is_select_like("LOAD parquet"));
        assert!(!is_select_like("CALL dbgen(sf=0.1)"));
        assert!(!is_select_like("CREATE TABLE t (id INT)"));
        assert!(!is_select_like("DROP TABLE t"));
        assert!(!is_select_like("INSERT INTO t VALUES (1)"));
        assert!(!is_select_like("UPDATE t SET x = 1"));
        assert!(!is_select_like("DELETE FROM t"));
        assert!(!is_select_like("PRAGMA memory_limit"));
        assert!(!is_select_like("ALTER TABLE t ADD COLUMN x INT"));
    }

    #[test]
    fn utility_statements_execute_without_describe() {
        let state = AppRuntimeState::new();
        let conn = open_configured_duckdb(&state).expect("open configured duckdb");

        // DDL should work via execute_batch
        conn.execute_batch("CREATE TABLE test_util (id INTEGER, name VARCHAR)")
            .expect("create table");
        conn.execute_batch("INSERT INTO test_util VALUES (1, 'alpha'), (2, 'beta')")
            .expect("insert rows");

        // SELECT on the created table should work via query_schema + query_rows
        let schema = query_schema(&conn, "SELECT * FROM test_util ORDER BY id")
            .expect("schema from created table");
        assert_eq!(schema.len(), 2);
        assert_eq!(schema[0].name, "id");
        assert_eq!(schema[1].name, "name");

        let (rows, _) = query_rows_with_limit(
            &conn,
            "SELECT * FROM test_util ORDER BY id",
            &schema,
            10,
        )
        .expect("rows from created table");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0][0].as_deref(), Some("1"));
        assert_eq!(rows[0][1].as_deref(), Some("alpha"));

        // Cleanup
        conn.execute_batch("DROP TABLE test_util").expect("drop table");
    }

    #[test]
    fn bundled_duckdb_is_v2_with_static_parquet_and_json() {
        let conn = Connection::open_in_memory().expect("open in-memory duckdb");
        // Forbid any runtime extension install/load so this only passes if the
        // extensions are statically linked into the bundled build.
        conn.execute_batch(
            "SET autoinstall_known_extensions = false; SET autoload_known_extensions = false;",
        )
        .expect("disable extension autoinstall/autoload");

        let version: String = conn
            .query_row("SELECT version()", [], |row| row.get(0))
            .expect("query version");
        assert!(version.starts_with("v2.0."), "unexpected DuckDB version {version}");

        for ext in ["parquet", "json"] {
            let (loaded, mode): (bool, String) = conn
                .query_row(
                    "SELECT loaded, install_mode FROM duckdb_extensions() WHERE extension_name = ?",
                    [ext],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap_or_else(|e| panic!("look up {ext} extension: {e}"));
            assert!(loaded, "{ext} extension not loaded");
            assert_eq!(mode, "STATICALLY_LINKED", "{ext} extension install mode");
        }

        let temp_file = unique_test_parquet_path();
        let escaped_path = escape_sql_string_literal(&temp_file);
        conn.execute_batch(&format!(
            "COPY (SELECT 42::INTEGER AS answer) TO '{escaped_path}' (FORMAT PARQUET);"
        ))
        .expect("write parquet without INSTALL");
        let answer: i32 = conn
            .query_row(
                &format!("SELECT answer FROM read_parquet('{escaped_path}')"),
                [],
                |row| row.get(0),
            )
            .expect("read parquet without INSTALL");
        assert_eq!(answer, 42);

        let _ = fs::remove_file(&temp_file);
    }

    #[test]
    fn timestamptz_round_trips_through_preview_and_query() {
        let state = AppRuntimeState::new();
        let conn = open_configured_duckdb(&state).expect("open configured duckdb");
        let temp_file = unique_test_parquet_path();
        let escaped_path = escape_sql_string_literal(&temp_file);

        conn.execute_batch(&format!(
            "COPY (
                SELECT 1::BIGINT AS id, TIMESTAMPTZ '2024-03-15 12:34:56+00' AS ts
            ) TO '{escaped_path}' (FORMAT PARQUET);"
        ))
        .expect("write timestamptz parquet fixture");

        let source = format!("read_parquet('{escaped_path}')");
        let flattened = flattened_columns_for_source(&conn, &source).expect("load flattened columns");
        let schema = schema_from_flattened(&flattened);
        let ts_col = schema.iter().find(|c| c.name == "ts").expect("ts column present");
        assert!(
            ts_col.duckdb_type.contains("TIME ZONE") || ts_col.duckdb_type == "TIMESTAMPTZ",
            "unexpected ts type {}",
            ts_col.duckdb_type
        );

        let preview = parquet_rows_page(&conn, &source, &flattened, 0, 10).expect("preview rows");
        assert_eq!(preview.len(), 1);
        let preview_ts = preview[0][1].as_deref().expect("preview ts not null");
        assert!(preview_ts.starts_with("2024-03-15"), "preview ts = {preview_ts}");

        let sql = format!("SELECT ts FROM {source}");
        let query_schema_cols = query_schema(&conn, &sql).expect("query schema");
        let (rows, _) =
            query_rows_with_limit(&conn, &sql, &query_schema_cols, 10).expect("query rows");
        let query_ts = rows[0][0].as_deref().expect("query ts not null");
        assert!(query_ts.starts_with("2024-03-15"), "query ts = {query_ts}");

        let _ = fs::remove_file(&temp_file);
    }

    #[test]
    fn untyped_null_query_renders_and_exports() {
        let state = AppRuntimeState::new();
        let conn = open_configured_duckdb(&state).expect("open configured duckdb");
        let sql = "SELECT NULL AS x";

        let schema = query_schema(&conn, sql).expect("schema for untyped NULL");
        assert_eq!(schema.len(), 1);
        assert_eq!(schema[0].name, "x");
        let (rows, _) = query_rows_with_limit(&conn, sql, &schema, 10).expect("rows for untyped NULL");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0][0], None);

        for format in ["csv", "parquet"] {
            let out = unique_test_output_path(format);
            export_workspace_query_to_file(&conn, sql, &out, format, Some(sql), None)
                .unwrap_or_else(|e| panic!("export untyped NULL to {format}: {e}"));
            assert!(fs::metadata(&out).map(|m| m.len() > 0).unwrap_or(false));
            let _ = fs::remove_file(&out);
        }
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
        path.push(format!(
            "parq_bench_test_export_{nanos}_{thread_id}.{extension}"
        ));
        path.to_string_lossy().to_string()
    }
}

#[cfg(test)]
mod extension_tests {
    use super::*;
    use std::sync::OnceLock;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Downloads the extensions these tests use, once per test run and serially, so
    /// parallel tests never race to install the same file. Needs internet the first
    /// time; DuckDB caches them in ~/.duckdb/extensions afterwards.
    fn install_test_extensions() {
        static DONE: OnceLock<()> = OnceLock::new();
        DONE.get_or_init(|| {
            Connection::open_in_memory()
                .expect("open duckdb")
                .execute_batch("INSTALL excel; INSTALL sqlite_scanner; INSTALL delta;")
                .expect("install test extensions (needs internet on first run)");
        });
    }

    fn temp_path(name: &str) -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let thread = format!("{:?}", thread::current().id()).replace(['(', ')'], "");
        let mut path = std::env::temp_dir();
        path.push(format!("parq_bench_ext_{nanos}_{thread}_{name}"));
        path.to_string_lossy().to_string()
    }

    fn reg(
        alias: &str,
        path: &str,
        kind: WorkspaceSourceKind,
        object_name: Option<&str>,
        header: Option<bool>,
    ) -> WorkspaceTableRegistration {
        WorkspaceTableRegistration {
            alias: alias.to_string(),
            file_path: path.to_string(),
            is_glob: false,
            source_kind: kind,
            delimiter: None,
            row_count: None,
            object_name: object_name.map(str::to_string),
            header,
        }
    }

    fn rows(conn: &Connection, sql: &str) -> Vec<Vec<Option<String>>> {
        let schema = query_schema(conn, sql).expect("schema");
        query_rows_with_limit(conn, sql, &schema, 100).expect("rows").0
    }

    #[test]
    fn startup_connection_loads_no_downloadable_extensions() {
        let state = AppRuntimeState::new();
        let conn = open_configured_duckdb(&state).expect("open configured duckdb");
        let loaded: Vec<String> = {
            let mut stmt = conn
                .prepare(
                    "SELECT extension_name FROM duckdb_extensions() \
                     WHERE loaded AND install_mode <> 'STATICALLY_LINKED'",
                )
                .unwrap();
            stmt.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
        };
        assert!(loaded.is_empty(), "extensions loaded at startup: {loaded:?}");
    }

    #[test]
    fn managed_extension_names_are_whitelisted() {
        assert_eq!(managed_extension_name("excel").unwrap(), "excel");
        assert_eq!(managed_extension_name(" SQLite ").unwrap(), "sqlite_scanner");
        assert_eq!(managed_extension_name("ICU").unwrap(), "icu");
        assert!(managed_extension_name("spatial").is_err());
        assert!(managed_extension_name("excel; DROP TABLE x").is_err());
        assert!(managed_extension_name("").is_err());
    }

    #[test]
    fn extension_statuses_report_installed_size_and_not_loaded() {
        install_test_extensions();
        let conn = Connection::open_in_memory().unwrap();
        let statuses = extension_statuses(&conn).expect("statuses");
        let names: Vec<&str> = statuses.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, MANAGED_EXTENSIONS.to_vec());
        let excel = statuses.iter().find(|s| s.name == "excel").unwrap();
        assert!(excel.installed);
        assert!(!excel.loaded, "listing must not load extensions");
        assert!(excel.size_bytes.unwrap_or(0) > 0);
    }

    #[test]
    fn workbook_xml_sheet_names_parse() {
        let xml = r#"<?xml version="1.0"?><workbook xmlns:r="x"><sheets>
            <sheet name="Sales &amp; Returns" sheetId="1" r:id="rId1"/>
            <sheet sheetId="2" name='Q2' r:id="rId2"/>
            <x:sheet name="Third" sheetId="3"/></sheets>
            <definedNames><definedName name="NotASheet">A1</definedName></definedNames></workbook>"#;
        assert_eq!(parse_workbook_sheet_names(xml), vec!["Sales & Returns", "Q2", "Third"]);
    }

    #[test]
    fn xlsx_sheet_names_read_from_zip_and_reject_non_xlsx() {
        // Hand-built archive with two sheets (DuckDB writes one sheet per file).
        let path = temp_path("two_sheets.xlsx");
        {
            let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            zip.start_file("xl/workbook.xml", opts).unwrap();
            zip.write_all(br#"<workbook><sheets><sheet name="Alpha" sheetId="1"/><sheet name="Beta" sheetId="2"/></sheets></workbook>"#)
                .unwrap();
            zip.finish().unwrap();
        }
        assert_eq!(xlsx_sheet_names(&path).unwrap(), vec!["Alpha", "Beta"]);
        let _ = fs::remove_file(&path);

        let bad = temp_path("not_really.xlsx");
        fs::write(&bad, b"plain text").unwrap();
        assert!(xlsx_sheet_names(&bad).is_err());
        let _ = fs::remove_file(&bad);
    }

    #[test]
    fn excel_export_then_register_and_query() {
        install_test_extensions();
        let state = AppRuntimeState::new();
        let path = temp_path("people.xlsx");
        {
            let conn = open_configured_duckdb(&state).unwrap();
            export_workspace_query_to_file(
                &conn,
                "SELECT range::INTEGER AS id, 'name_' || range AS name FROM range(3)",
                &path,
                "xlsx",
                Some("ignored for xlsx"),
                None,
            )
            .expect("export xlsx");
        }
        let sheets = xlsx_sheet_names(&path).expect("sheets of exported file");
        assert_eq!(sheets.len(), 1);

        // A fresh connection reads it back (read_xlsx autoloads the extension).
        let conn = open_configured_duckdb(&state).unwrap();
        apply_workspace_tables(
            &conn,
            &[
                reg("people", &path, WorkspaceSourceKind::Excel, Some(&sheets[0]), Some(true)),
                reg("raw", &path, WorkspaceSourceKind::Excel, Some(&sheets[0]), Some(false)),
            ],
        )
        .expect("register excel tables");
        let people = rows(&conn, "SELECT id, name FROM people ORDER BY id");
        assert_eq!(people.len(), 3);
        assert_eq!(people[2][1].as_deref(), Some("name_2"));
        // Excel stores every number as a float.
        assert_eq!(query_schema(&conn, "SELECT id FROM people").unwrap()[0].duckdb_type, "DOUBLE");
        // header => false keeps the header row as data.
        assert_eq!(rows(&conn, "SELECT * FROM raw").len(), 4);
        drop(conn);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn excel_export_handles_common_and_nested_types() {
        install_test_extensions();
        let state = AppRuntimeState::new();
        let conn = open_configured_duckdb(&state).unwrap();
        let path = temp_path("types.xlsx");
        export_workspace_query_to_file(
            &conn,
            "SELECT 1.5::DECIMAL(10,2) AS d, TIMESTAMP '2024-01-01 10:00:00' AS ts, \
             DATE '2024-02-03' AS dt, true AS b, 123456789012::HUGEINT AS h, \
             [1, 2] AS l, {'a': 1} AS s, NULL AS n",
            &path,
            "xlsx",
            None,
            None,
        )
        .expect("export mixed types to xlsx");
        assert!(fs::metadata(&path).map(|m| m.len() > 0).unwrap_or(false));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn sqlite_lists_tables_and_views_and_queries_them() {
        install_test_extensions();
        let state = AppRuntimeState::new();
        let path = temp_path("app.db");
        {
            let conn = open_configured_duckdb(&state).unwrap();
            conn.execute_batch(&format!(
                "ATTACH '{}' AS s (TYPE sqlite); \
                 CREATE TABLE s.people AS SELECT 1 AS id, 'ada' AS name; \
                 CREATE TABLE s.orders AS SELECT 7 AS id; \
                 CREATE VIEW s.v_people AS SELECT name FROM s.people; \
                 DETACH s;",
                escape_sql_string_literal(&path)
            ))
            .expect("create sqlite fixture");
        }
        let conn = open_configured_duckdb(&state).unwrap();
        let listed: Vec<(String, String)> = sqlite_objects(&conn, &path)
            .expect("list sqlite objects")
            .into_iter()
            .map(|o| (o.name, o.kind))
            .collect();
        let expected: Vec<(String, String)> = [("orders", "table"), ("people", "table"), ("v_people", "view")]
            .iter()
            .map(|(n, k)| (n.to_string(), k.to_string()))
            .collect();
        assert_eq!(listed, expected);

        apply_workspace_tables(
            &conn,
            &[
                reg("people", &path, WorkspaceSourceKind::Sqlite, Some("people"), None),
                reg("vp", &path, WorkspaceSourceKind::Sqlite, Some("v_people"), None),
            ],
        )
        .expect("register sqlite tables");
        assert_eq!(rows(&conn, "SELECT name FROM people")[0][0].as_deref(), Some("ada"));
        assert_eq!(rows(&conn, "SELECT name FROM vp").len(), 1);
        drop(conn);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn delta_table_folder_registers_and_queries() {
        install_test_extensions();
        let state = AppRuntimeState::new();
        let dir = temp_path("delta_tbl");
        {
            let conn = open_configured_duckdb(&state).unwrap();
            // An attached Delta path is a single table, created under the attached name.
            conn.execute_batch(&format!(
                "ATTACH '{}' AS dl (TYPE delta); \
                 CREATE TABLE dl.dl (id INTEGER, label VARCHAR); \
                 INSERT INTO dl.dl VALUES (1, 'a'), (2, 'b'); \
                 DETACH dl;",
                escape_sql_string_literal(&dir)
            ))
            .expect("create delta fixture");
        }
        assert!(validate_workspace_source(&dir, false, WorkspaceSourceKind::Delta, None).is_ok());
        let conn = open_configured_duckdb(&state).unwrap();
        apply_workspace_tables(&conn, &[reg("events", &dir, WorkspaceSourceKind::Delta, None, None)])
            .expect("register delta table");
        let r = rows(&conn, "SELECT id, label FROM events ORDER BY id");
        assert_eq!(r.len(), 2);
        assert_eq!(r[1][1].as_deref(), Some("b"));
        drop(conn);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remote_paths_and_source_validation() {
        assert!(is_remote_path("https://host/x.parquet"));
        assert!(is_remote_path("  HTTP://host/x.csv"));
        assert!(!is_remote_path("C:\\data\\x.parquet"));
        assert!(!is_remote_path("s3://bucket/key.parquet"));

        use WorkspaceSourceKind::*;
        // URLs skip the local existence check but only allow Parquet/delimited files.
        assert!(validate_workspace_source("https://host/x.parquet", false, Parquet, None).is_ok());
        assert!(validate_workspace_source("https://host/x.csv", false, Delimited, None).is_ok());
        assert!(validate_workspace_source("https://host/x.xlsx", false, Excel, None).is_err());
        assert!(validate_workspace_source("https://host/*.parquet", true, Parquet, None).is_err());

        let file = temp_path("db.sqlite");
        fs::write(&file, b"x").unwrap();
        assert!(validate_workspace_source(&file, false, Sqlite, None).is_err());
        assert!(validate_workspace_source(&file, false, Sqlite, Some(" ")).is_err());
        assert!(validate_workspace_source(&file, false, Sqlite, Some("people")).is_ok());
        assert!(validate_workspace_source(&file, false, Delta, None).is_err());
        assert!(validate_workspace_source(&format!("{file}*.xlsx"), true, Excel, None).is_err());
        assert!(validate_workspace_source(&temp_path("missing.parquet"), false, Parquet, None).is_err());
        let _ = fs::remove_file(&file);
    }

    #[test]
    fn broken_table_only_affects_statements_that_use_it() {
        let state = AppRuntimeState::new();
        let csv = temp_path("ok.csv");
        fs::write(&csv, "id,label\n1,a\n").unwrap();
        let tables = vec![
            WorkspaceTableRegistration {
                delimiter: None,
                ..reg("good", &csv, WorkspaceSourceKind::Delimited, None, None)
            },
            // Stands in for an unreachable URL or missing extension: building its view fails.
            reg("broken_url", &temp_path("deleted.parquet"), WorkspaceSourceKind::Parquet, None, None),
        ];
        let sql = "SELECT label FROM good";
        let referenced = tables_referenced_by(sql, &tables);
        assert_eq!(referenced.len(), 1);
        let conn = open_configured_duckdb(&state).unwrap();
        apply_workspace_tables(&conn, &referenced).expect("only the used table is built");
        assert_eq!(rows(&conn, sql)[0][0].as_deref(), Some("a"));

        // A statement that does use the broken table gets that table's error.
        let conn = open_configured_duckdb(&state).unwrap();
        let err = apply_workspace_tables(&conn, &tables_referenced_by("SELECT * FROM Broken_URL", &tables))
            .expect_err("broken table must fail when used");
        assert!(err.contains("broken_url"), "{err}");
        let _ = fs::remove_file(&csv);
    }

    #[test]
    fn alias_matching_is_whole_word_and_case_insensitive() {
        assert!(contains_word("select * from sales", "sales"));
        assert!(contains_word("select * from \"sales\" s", "sales"));
        assert!(contains_word("join sales\non", "sales"));
        assert!(!contains_word("select * from sales_2024", "sales"));
        assert!(!contains_word("select * from presales", "sales"));
        assert!(contains_word("from presales, sales", "sales"));
        let tables = vec![
            reg("Sales", "a.parquet", WorkspaceSourceKind::Parquet, None, None),
            reg("sales_2024", "b.parquet", WorkspaceSourceKind::Parquet, None, None),
        ];
        let picked: Vec<String> = tables_referenced_by("SELECT * FROM SALES", &tables).into_iter().map(|t| t.alias).collect();
        assert_eq!(picked, vec!["Sales"]);
        assert_eq!(tables_with_aliases(&tables, &["SALES_2024"]).len(), 1);
    }

    #[test]
    fn non_http_schemes_are_rejected_and_urls_redacted_in_logs() {
        use WorkspaceSourceKind::*;
        for p in ["s3://bucket/*.parquet", "gs://b/x.parquet", "hf://datasets/x/*.csv", "file:///C:/x.parquet"] {
            assert!(has_unsupported_scheme(p), "{p}");
            assert!(validate_workspace_source(p, true, Parquet, None).is_err(), "{p}");
            assert!(validate_workspace_source(p, false, Parquet, None).is_err(), "{p}");
        }
        assert!(!has_unsupported_scheme("https://h/x.parquet"));
        assert!(!has_unsupported_scheme("C:\\data\\x.parquet"));
        assert!(!has_unsupported_scheme("C:/data/*.csv"));
        assert_eq!(redact_for_log("https://h/x.parquet?sig=SECRET#f"), "https://h/x.parquet");
        assert_eq!(redact_for_log("C:\\a?b.parquet"), "C:\\a?b.parquet");
    }

    #[test]
    fn workbook_parser_handles_unescaped_gt_and_numeric_refs() {
        let xml = r#"<sheets><sheet name="a>b" sheetId="1"/><sheet name="Tom&#39;s &#x26; Co" sheetId="2"/><sheet name="lone & amp" sheetId="3"/></sheets>"#;
        assert_eq!(parse_workbook_sheet_names(xml), vec!["a>b", "Tom's & Co", "lone & amp"]);
    }

    #[test]
    fn source_sql_for_new_kinds() {
        use WorkspaceSourceKind::*;
        assert_eq!(
            workspace_source_sql(&reg("a", "C:\\d\\b.xlsx", Excel, Some("Q'1"), Some(false))),
            "read_xlsx('C:/d/b.xlsx', sheet => 'Q''1', header => false)"
        );
        assert_eq!(
            workspace_source_sql(&reg("a", "C:\\d\\b.xlsx", Excel, None, None)),
            "read_xlsx('C:/d/b.xlsx')"
        );
        assert_eq!(
            workspace_source_sql(&reg("a", "C:\\d\\app.db", Sqlite, Some("my table"), None)),
            "sqlite_scan('C:/d/app.db', 'my table')"
        );
        assert_eq!(workspace_source_sql(&reg("a", "C:\\d\\tbl", Delta, None, None)), "delta_scan('C:/d/tbl')");
        assert_eq!(
            workspace_source_sql(&reg("a", "https://h/x.parquet", Parquet, None, None)),
            "read_parquet('https://h/x.parquet')"
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let runtime_state = Arc::new(AppRuntimeState::new());

    tauri::Builder::default()
        .manage(Arc::clone(&runtime_state))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let state = app.state::<Arc<AppRuntimeState>>().inner().clone();
            spawn_memory_monitor(Arc::clone(&state));

            // Initialize log file path
            if let Ok(log_dir) = app.path().app_log_dir() {
                let _ = fs::create_dir_all(&log_dir);
                let log_path = log_dir.join("parq_bench.log");

                // Rotate if existing log exceeds 5 MB
                const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
                if let Ok(meta) = fs::metadata(&log_path) {
                    if meta.len() > MAX_LOG_BYTES {
                        let backup = log_dir.join("parq_bench.log.1");
                        let _ = fs::rename(&log_path, &backup);
                    }
                }

                if let Ok(mut guard) = state.log_file.lock() {
                    *guard = Some(log_path);
                }
            }
            // Parquet and JSON are statically linked via the `parquet` / `json`
            // crate features, so no runtime INSTALL/LOAD (and no network) is needed.
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
            peek_workspace_source,
            list_xlsx_sheets,
            list_sqlite_tables,
            list_extensions,
            install_extension,
            list_workspace_tables,
            rename_workspace_table,
            remove_workspace_table,
            run_workspace_query,
            describe_workspace_table,
            export_workspace_query,
            explain_workspace_query,
            summarize_workspace_table,
            diff_workspace_schema,
            cancel_workspace_query,
            workspace_query_progress,
            prepare_sql_completions,
            sync_completion_tables,
            sql_completions,
            sql_function_docs,
            list_saved_queries,
            save_query,
            delete_saved_query,
            get_log_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod editor_tests {
    use super::*;
    use std::sync::OnceLock;

    #[test]
    fn function_docs_group_overloads_with_types_and_descriptions() {
        let conn = Connection::open_in_memory().unwrap();
        let docs = load_function_docs(&conn).unwrap();
        assert!(docs.len() > 500, "expected hundreds of functions, got {}", docs.len());

        let find = |name: &str, kind: &str| docs.iter().find(|d| d.name == name && d.kind == kind)
            .unwrap_or_else(|| panic!("{name} ({kind}) missing"));
        let trunc = find("date_trunc", "scalar");
        assert!(trunc.description.as_deref().unwrap_or("").contains("Truncate"));
        assert!(trunc.signatures.len() >= 2, "date_trunc has several overloads");
        let first = &trunc.signatures[0];
        assert_eq!(first.params.len(), 2);
        assert_eq!(first.params[0].duckdb_type.as_deref(), Some("VARCHAR"));
        assert!(!trunc.examples.is_empty());

        let sum = find("sum", "aggregate");
        assert!(sum.signatures.iter().all(|s| s.returns.is_some()));

        // Table functions carry named parameters; pragmas are left out entirely.
        assert!(find("read_parquet", "table").signatures[0].params.iter().any(|p| p.name == "hive_partitioning"));
        assert!(docs.iter().all(|d| d.kind != "pragma"));

        // One entry per (name, kind), each signature listed once.
        let mut keys: Vec<(&str, &str)> = docs.iter().map(|d| (d.name.as_str(), d.kind.as_str())).collect();
        let total = keys.len();
        keys.sort();
        keys.dedup();
        assert_eq!(keys.len(), total);
        for d in &docs {
            for (i, sig) in d.signatures.iter().enumerate() {
                assert!(!d.signatures[..i].contains(sig), "{} repeats a signature", d.name);
            }
        }
    }

    #[test]
    fn function_docs_mark_variadic_functions() {
        let conn = Connection::open_in_memory().unwrap();
        let docs = load_function_docs(&conn).unwrap();
        let concat = docs.iter().find(|d| d.name == "concat" && d.kind == "scalar").expect("concat");
        assert!(concat.signatures.iter().any(|s| s.varargs.is_some()), "concat takes any number of arguments");
    }

    fn install_autocomplete() {
        static DONE: OnceLock<()> = OnceLock::new();
        DONE.get_or_init(|| {
            Connection::open_in_memory()
                .expect("open duckdb")
                .execute_batch("INSTALL autocomplete;")
                .expect("install autocomplete (needs internet on first run)");
        });
    }

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("parq_bench_{name}_{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn saved_queries_round_trip_newest_first() {
        let path = temp_dir("saved_round_trip").join("sub").join(SAVED_QUERIES_FILE);
        assert!(read_saved_queries(&path).unwrap().is_empty(), "missing file is an empty list");
        upsert_saved_query(&path, "  Revenue ", "SELECT 1", 100).unwrap();
        let list = upsert_saved_query(&path, "Counts", "SELECT 2", 200).unwrap();
        assert_eq!(list.iter().map(|q| q.name.as_str()).collect::<Vec<_>>(), ["Counts", "Revenue"]);
        assert_eq!(read_saved_queries(&path).unwrap(), list);
        assert!(!path.with_extension("json.tmp").exists(), "temporary file is renamed away");
    }

    #[test]
    fn saving_an_existing_name_replaces_it_ignoring_case() {
        let path = temp_dir("saved_replace").join(SAVED_QUERIES_FILE);
        upsert_saved_query(&path, "Revenue", "SELECT 1", 100).unwrap();
        upsert_saved_query(&path, "Other", "SELECT 9", 150).unwrap();
        let list = upsert_saved_query(&path, "revenue", "SELECT 2", 200).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0], SavedQuery { name: "revenue".into(), sql: "SELECT 2".into(), updated_at_ms: 200 });
    }

    #[test]
    fn deleting_removes_only_that_query() {
        let path = temp_dir("saved_delete").join(SAVED_QUERIES_FILE);
        upsert_saved_query(&path, "A", "SELECT 1", 1).unwrap();
        upsert_saved_query(&path, "B", "SELECT 2", 2).unwrap();
        let list = remove_saved_query(&path, "a").unwrap();
        assert_eq!(list.iter().map(|q| q.name.as_str()).collect::<Vec<_>>(), ["B"]);
        assert_eq!(remove_saved_query(&path, "missing").unwrap().len(), 1);
    }

    #[test]
    fn saved_query_names_are_required_and_bounded() {
        let path = temp_dir("saved_names").join(SAVED_QUERIES_FILE);
        assert!(upsert_saved_query(&path, "   ", "SELECT 1", 1).is_err());
        assert!(upsert_saved_query(&path, &"x".repeat(SAVED_QUERY_NAME_MAX + 1), "SELECT 1", 1).is_err());
        assert!(upsert_saved_query(&path, &"x".repeat(SAVED_QUERY_NAME_MAX), "SELECT 1", 1).is_ok());
    }

    #[test]
    fn a_damaged_saved_queries_file_is_an_error_and_never_overwritten() {
        let path = temp_dir("saved_damaged").join(SAVED_QUERIES_FILE);
        fs::write(&path, "{ not json").unwrap();
        assert!(read_saved_queries(&path).unwrap_err().contains("damaged"));
        assert!(upsert_saved_query(&path, "A", "SELECT 1", 1).is_err());
        assert!(remove_saved_query(&path, "A").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ not json");
    }

    #[test]
    fn a_saved_queries_file_from_a_newer_version_is_refused_not_rewritten() {
        let path = temp_dir("saved_newer").join(SAVED_QUERIES_FILE);
        let newer = r#"{"version": 2, "queries": [], "folders": ["kept"]}"#;
        fs::write(&path, newer).unwrap();
        assert!(read_saved_queries(&path).unwrap_err().contains("newer version"));
        assert!(upsert_saved_query(&path, "A", "SELECT 1", 1).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), newer);
    }

    /// Long enough to still be running when cancelled (~10^10 row pairs).
    const SLOW_SQL: &str = "SELECT sum(a.range * b.range) AS s FROM range(100000) a, range(100000) b";

    /// Runs `sql` the way `run_workspace_query` does, on its own thread.
    fn spawn_tracked_query(
        st: &Arc<AppRuntimeState>,
        id: &str,
        sql: &'static str,
    ) -> thread::JoinHandle<Result<WorkspaceQueryResponse, String>> {
        let st = st.clone();
        let id = id.to_string();
        thread::spawn(move || {
            let conn = open_configured_duckdb(&st)?;
            let guard = track_query(&st, Some(id), &conn)?;
            let outcome = run_statements(&st, &conn, &[], sql, &[], 10, &guard);
            guard.finish(outcome)
        })
    }

    fn wait_until_registered(st: &AppRuntimeState, id: &str) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !st.running_queries.lock().unwrap().contains_key(id) {
            assert!(Instant::now() < deadline, "query {id} never registered");
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn cancel_interrupts_a_running_query_and_clears_the_registry() {
        let st = Arc::new(AppRuntimeState::new());
        let handle = spawn_tracked_query(&st, "q-cancel", SLOW_SQL);
        wait_until_registered(&st, "q-cancel");
        thread::sleep(Duration::from_millis(300));
        let started = Instant::now();
        assert!(cancel_running_query(&st, "q-cancel").unwrap());
        let result = handle.join().unwrap();
        assert_eq!(result.unwrap_err(), QUERY_CANCELLED);
        assert!(started.elapsed() < Duration::from_secs(5), "cancel took {:?}", started.elapsed());
        assert!(st.running_queries.lock().unwrap().is_empty());
    }

    #[test]
    fn cancelling_an_unknown_query_reports_false() {
        let st = AppRuntimeState::new();
        assert!(!cancel_running_query(&st, "nope").unwrap());
    }

    #[test]
    fn finished_and_failed_queries_leave_the_registry() {
        let st = Arc::new(AppRuntimeState::new());
        let ok = spawn_tracked_query(&st, "q-ok", "SELECT 42 AS answer").join().unwrap().unwrap();
        assert_eq!(ok.rows, vec![vec![Some("42".to_string())]]);
        let err = spawn_tracked_query(&st, "q-err", "SELECT * FROM missing_table").join().unwrap();
        assert!(err.unwrap_err().contains("missing_table"));
        assert!(st.running_queries.lock().unwrap().is_empty());
    }

    #[test]
    fn progress_is_reported_while_a_scan_runs() {
        let st = Arc::new(AppRuntimeState::new());
        let handle = spawn_tracked_query(&st, "q-progress", SLOW_SQL);
        wait_until_registered(&st, "q-progress");
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut seen = None;
        while seen.is_none() && Instant::now() < deadline {
            seen = st
                .running_queries
                .lock()
                .unwrap()
                .get("q-progress")
                .and_then(|q| q.progress.query_progress().percentage());
            thread::sleep(Duration::from_millis(50));
        }
        cancel_running_query(&st, "q-progress").unwrap();
        let _ = handle.join();
        let pct = seen.expect("no progress estimate within 10 s");
        assert!((0.0..=100.0).contains(&pct), "progress {pct}");
    }

    #[test]
    fn setup_statements_run_first_on_the_same_connection() {
        let st = Arc::new(AppRuntimeState::new());
        let conn = open_configured_duckdb(&st).unwrap();
        let guard = track_query(&st, None, &conn).unwrap();
        let setup = vec![
            "CREATE TEMP TABLE t AS SELECT 1 AS x UNION ALL SELECT 2".to_string(),
            "INSERT INTO t VALUES (3)".to_string(),
        ];
        let result = run_statements(&st, &conn, &[], "SELECT sum(x) AS total FROM t", &setup, 10, &guard).unwrap();
        assert_eq!(result.rows, vec![vec![Some("6".to_string())]]);
        let failing = vec!["CREATE TABLE u AS SELECT * FROM nowhere".to_string()];
        let err = run_statements(&st, &conn, &[], "SELECT 1", &failing, 10, &guard).unwrap_err();
        assert!(err.starts_with("statement 1 of 2:"), "{err}");
    }

    #[test]
    fn trailing_line_comment_does_not_break_wrapped_queries() {
        let conn = Connection::open_in_memory().unwrap();
        let sql = "SELECT 7 AS n -- a note";
        let schema = query_schema(&conn, sql).expect("schema");
        let (rows, _) = query_rows_with_limit(&conn, sql, &schema, 5).expect("rows");
        assert_eq!(rows, vec![vec![Some("7".to_string())]]);
        let dir = temp_dir("comment_export");
        let out = dir.join("out.parquet").to_string_lossy().into_owned();
        export_workspace_query_to_file(&conn, sql, &out, "parquet", None, None).expect("export");
        assert!(Path::new(&out).exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn statement_splitter_respects_quotes_comments_and_dollar_strings() {
        assert_eq!(split_sql_statements("SELECT 1; SELECT 2;"), vec!["SELECT 1", "SELECT 2"]);
        assert_eq!(split_sql_statements("SELECT 'a;b', \"c;d\""), vec!["SELECT 'a;b', \"c;d\""]);
        assert_eq!(split_sql_statements("SELECT 'it''s; fine'"), vec!["SELECT 'it''s; fine'"]);
        assert_eq!(
            split_sql_statements("SELECT 1 -- no; split\n; SELECT 2"),
            vec!["SELECT 1 -- no; split", "SELECT 2"]
        );
        assert_eq!(split_sql_statements("SELECT /* a; b */ 1"), vec!["SELECT /* a; b */ 1"]);
        assert_eq!(split_sql_statements("SELECT $$a;b$$, $x$c;d$x$"), vec!["SELECT $$a;b$$, $x$c;d$x$"]);
        assert_eq!(split_sql_statements("SELECT $1; SELECT 2"), vec!["SELECT $1", "SELECT 2"]);
        assert_eq!(split_sql_statements("SELECT 1; -- trailing note"), vec!["SELECT 1"]);
        assert_eq!(split_sql_statements("  ;; -- only comments\n/* x */ "), Vec::<String>::new());
        assert_eq!(split_sql_statements("SELECT 'unterminated; text"), vec!["SELECT 'unterminated; text"]);
    }

    #[test]
    fn single_statement_normalization_is_quote_aware() {
        assert_eq!(normalize_single_sql_statement("SELECT 'a;b';").unwrap(), "SELECT 'a;b'");
        assert_eq!(normalize_single_sql_statement("SELECT 1; -- note").unwrap(), "SELECT 1");
        assert!(normalize_single_sql_statement("SELECT 1; SELECT 2").is_err());
        assert!(normalize_single_sql_statement("-- just a comment").is_err());
    }

    #[test]
    fn partial_export_cleanup_keeps_files_that_existed_before() {
        let dir = temp_dir("export_cleanup");
        let out = dir.join("result.parquet");
        let out_str = out.to_string_lossy().into_owned();
        // A file the user already had next to the export target must survive.
        let users_tmp = dir.join("tmp_result.parquet");
        fs::write(&users_tmp, "mine").unwrap();
        let before = existing_export_artifacts(&out_str);
        assert_eq!(before, vec![users_tmp.clone()]);
        fs::write(&out, "partial").unwrap();
        fs::write(format!("{out_str}.tmp"), "staging").unwrap();
        fs::write(dir.join("tmp_result.parquet.tmp"), "duckdb staging").unwrap();
        remove_partial_export(&out_str, &before);
        assert!(!out.exists());
        assert!(!Path::new(&format!("{out_str}.tmp")).exists());
        assert!(!dir.join("tmp_result.parquet.tmp").exists());
        assert!(users_tmp.exists(), "pre-existing file was deleted");
        // An output that existed before is left alone too.
        fs::write(&out, "old export").unwrap();
        remove_partial_export(&out_str, &existing_export_artifacts(&out_str));
        assert!(out.exists());
        let _ = fs::remove_dir_all(dir);
    }

    fn completion_tables() -> Vec<CompletionTable> {
        let col = |name: &str, ty: &str| CompletionColumn { name: name.into(), duckdb_type: ty.into() };
        vec![
            CompletionTable {
                alias: "orders".into(),
                columns: vec![col("o_orderkey", "BIGINT"), col("o_custkey", "BIGINT"), col("o_comment", "VARCHAR")],
            },
            CompletionTable {
                alias: "odd table".into(),
                columns: vec![col("my col", "STRUCT(a INTEGER, b VARCHAR)"), col("q\"uote", "INTEGER")],
            },
            CompletionTable {
                alias: "bad_types".into(),
                columns: vec![col("weird", "NOT_A_REAL_TYPE"), col("fine", "INTEGER")],
            },
            CompletionTable { alias: "empty".into(), columns: vec![] },
        ]
    }

    fn suggestions(conn: &Connection, text: &str) -> Vec<(String, String)> {
        sql_completions_for(conn, text, 200)
            .expect("completions")
            .into_iter()
            .map(|c| (c.text.trim_end().to_string(), c.kind))
            .collect()
    }

    #[test]
    fn completion_engine_suggests_tables_functions_columns_and_keywords() {
        install_autocomplete();
        let engine = build_completion_engine(completion_tables()).expect("engine");
        assert!(engine.ready, "autocomplete should load once installed");
        let conn = engine.conn.as_ref().unwrap();

        let from = suggestions(conn, "SELECT * FROM ord");
        assert!(from.contains(&("orders".into(), "table".into())), "{from:?}");

        let functions = suggestions(conn, "SELECT date_tr");
        assert!(functions.iter().any(|(t, k)| t == "date_trunc" && k == "scalar_function"), "{functions:?}");

        let columns = suggestions(conn, "SELECT * FROM orders WHERE o_c");
        assert!(columns.iter().any(|(t, k)| t == "o_custkey" && k == "column"), "{columns:?}");

        let keyword = suggestions(conn, "SELECT * FROM orders QUAL");
        assert!(keyword.iter().any(|(t, _)| t.eq_ignore_ascii_case("QUALIFY")), "{keyword:?}");

        // Mirror tables with odd names and nested types exist; bad types fall back to VARCHAR.
        let tables: Vec<String> = conn
            .prepare("SELECT table_name FROM duckdb_tables() ORDER BY 1")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(tables, vec!["bad_types", "odd table", "orders"]);
        let bad_type: String = conn
            .query_row(
                "SELECT data_type FROM duckdb_columns() WHERE table_name = 'bad_types' AND column_name = 'weird'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(bad_type, "VARCHAR");
    }

    #[test]
    fn completion_start_is_a_utf16_offset() {
        install_autocomplete();
        let engine = build_completion_engine(completion_tables()).expect("engine");
        let conn = engine.conn.as_ref().unwrap();
        // 'é' is 2 bytes in UTF-8 but 1 UTF-16 unit; the emoji is 4 bytes and 2 units.
        let text = "SELECT 'é\u{1F600}', date_tr";
        let expected = text.encode_utf16().count() - "date_tr".len();
        let got = sql_completions_for(conn, text, 50).unwrap();
        let date_trunc = got.iter().find(|c| c.text == "date_trunc").expect("date_trunc suggested");
        assert_eq!(date_trunc.start, expected);
    }

    #[test]
    fn utf16_offsets_convert_from_bytes() {
        assert_eq!(utf16_offset("abc", 2), 2);
        assert_eq!(utf16_offset("é1", 2), 1);
        assert_eq!(utf16_offset("\u{1F600}x", 4), 2);
        assert_eq!(utf16_offset("é", 1), 0, "inside a character rounds down");
        assert_eq!(utf16_offset("ab", 99), 2);
    }

    #[test]
    fn statements_with_leading_comments_still_return_rows() {
        assert!(is_select_like("-- first query\nSELECT 1"));
        assert!(is_select_like("/* header */ WITH x AS (SELECT 1) SELECT * FROM x"));
        assert!(!is_select_like("-- note\nCREATE TABLE t (x INT)"));
        assert_eq!(skip_leading_comments("  -- a\n /* b */ SELECT 1"), "SELECT 1");
        assert_eq!(split_sql_statements("SELECT 1; -- next\nSELECT 2"), vec!["SELECT 1", "SELECT 2"]);

        let st = Arc::new(AppRuntimeState::new());
        let conn = open_configured_duckdb(&st).unwrap();
        let guard = track_query(&st, None, &conn).unwrap();
        let result = run_statements(&st, &conn, &[], "-- title\nSELECT 5 AS five", &[], 10, &guard).unwrap();
        assert!(result.returns_rows);
        assert_eq!(result.rows, vec![vec![Some("5".to_string())]]);
        let ddl = run_statements(&st, &conn, &[], "CREATE TEMP TABLE z (x INT)", &[], 10, &guard).unwrap();
        assert!(!ddl.returns_rows);
    }

    #[test]
    fn a_cancel_that_arrives_before_the_query_registers_still_applies() {
        let st = Arc::new(AppRuntimeState::new());
        assert!(!cancel_running_query(&st, "early").unwrap(), "not running yet");
        let conn = open_configured_duckdb(&st).unwrap();
        let guard = track_query(&st, Some("early".into()), &conn).unwrap();
        // The setup statement must not run once the query is known to be cancelled.
        let setup = vec!["CREATE TEMP TABLE must_not_exist AS SELECT 1".to_string()];
        let outcome = run_statements(&st, &conn, &[], "SELECT 1", &setup, 10, &guard);
        assert_eq!(guard.finish(outcome).unwrap_err(), QUERY_CANCELLED);
        let exists: i64 = conn
            .query_row("SELECT count(*) FROM duckdb_tables() WHERE table_name = 'must_not_exist'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(exists, 0);
        assert!(st.cancelled_early.lock().unwrap().is_empty(), "early cancel consumed");
    }

    #[test]
    fn explain_and_stats_honour_an_early_cancel() {
        // Mirrors the commands: register, then the first step checks the flag.
        let st = Arc::new(AppRuntimeState::new());
        cancel_running_query(&st, "stats-early").unwrap();
        let conn = open_configured_duckdb(&st).unwrap();
        let guard = track_query(&st, Some("stats-early".into()), &conn).unwrap();
        assert_eq!(guard.check().unwrap_err(), QUERY_CANCELLED);
    }

    #[test]
    fn early_cancels_are_bounded() {
        let st = AppRuntimeState::new();
        for i in 0..(CANCELLED_EARLY_MAX + 10) {
            cancel_running_query(&st, &format!("gone-{i}")).unwrap();
        }
        assert_eq!(st.cancelled_early.lock().unwrap().len(), CANCELLED_EARLY_MAX);
    }

    #[test]
    fn completion_engine_starts_empty_and_not_ready() {
        let st = AppRuntimeState::new();
        let engine = st.completion.lock().unwrap();
        assert!(engine.conn.is_none());
        assert!(!engine.ready);
    }
}
