use duckdb::Connection;
use serde::Serialize;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
#[link(name = "rstrtmgr")]
unsafe extern "system" {}

#[derive(Serialize)]
struct FileSchemaColumn {
    name: String,
    duckdb_type: String,
}

#[derive(Serialize)]
struct FileCompatResult {
    file_name: String,
    file_path: String,
    file_size_bytes: u64,
    row_count: Option<u64>,
    column_count: usize,
    nested_column_count: usize,
    schema_check_pass: bool,
    read_count_pass: bool,
    sample_query_pass: bool,
    export_csv_pass: bool,
    export_parquet_pass: bool,
    passed: bool,
    error: Option<String>,
    schema: Vec<FileSchemaColumn>,
}

#[derive(Serialize)]
struct CompatMatrixReport {
    generated_at: String,
    duckdb_version: String,
    fixtures_dir: String,
    total_files: usize,
    pass_count: usize,
    fail_count: usize,
    results: Vec<FileCompatResult>,
}

fn sql_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .replace('\'', "''")
}

fn is_nested_type(duckdb_type: &str) -> bool {
    let upper = duckdb_type.trim().to_ascii_uppercase();
    upper.starts_with("STRUCT(")
        || upper.starts_with("LIST(")
        || upper.starts_with("MAP(")
        || upper.starts_with("ARRAY(")
        || upper.starts_with("UNION(")
        || upper.contains("[]")
}

fn default_fixtures_dir() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .join("..")
        .join("..")
        .join("testdata")
        .join("parquet")
}

fn default_report_path(fixtures_dir: &Path) -> PathBuf {
    fixtures_dir.join("compat_matrix_report.json")
}

fn utc_now_rfc3339() -> String {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => format!("unix:{}s", duration.as_secs()),
        Err(_) => "unix:0s".to_string(),
    }
}

fn load_schema(conn: &Connection, source: &str) -> Result<Vec<FileSchemaColumn>, String> {
    let describe_sql = format!("DESCRIBE SELECT * FROM {source}");
    let mut stmt = conn
        .prepare(&describe_sql)
        .map_err(|e| format!("prepare schema query: {e}"))?;
    let iter = stmt
        .query_map([], |row| {
            Ok(FileSchemaColumn {
                name: row.get(0)?,
                duckdb_type: row.get(1)?,
            })
        })
        .map_err(|e| format!("run schema query: {e}"))?;
    iter.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect schema query rows: {e}"))
}

fn run_sample_query(conn: &Connection, source: &str, schema: &[FileSchemaColumn]) -> Result<(), String> {
    if schema.is_empty() {
        return Err("no columns returned by schema query".to_string());
    }
    let projection = schema
        .iter()
        .map(|column| {
            let escaped_name = column.name.replace('"', "\"\"");
            format!("CAST(\"{escaped_name}\" AS VARCHAR) AS \"{escaped_name}\"")
        })
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("SELECT {projection} FROM {source} LIMIT 25");
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare sample query: {e}"))?;
    let col_count = schema.len();
    let rows = stmt
        .query_map([], |row| {
            let mut output = Vec::<Option<String>>::with_capacity(col_count);
            for idx in 0..col_count {
                output.push(row.get(idx)?);
            }
            Ok(output)
        })
        .map_err(|e| format!("run sample query: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect sample query rows: {e}"))?;
    if rows.is_empty() {
        return Err("sample query returned zero rows".to_string());
    }
    Ok(())
}

fn run_export_check(conn: &Connection, source: &str, file_stem: &str) -> Result<(bool, bool), String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let mut temp_dir = env::temp_dir();
    temp_dir.push("parq_bench_matrix");
    fs::create_dir_all(&temp_dir).map_err(|e| format!("create temp export dir: {e}"))?;

    let csv_path = temp_dir.join(format!("{file_stem}_{now}.csv"));
    let pq_path = temp_dir.join(format!("{file_stem}_{now}.parquet"));
    let csv_sql_path = sql_path(&csv_path);
    let pq_sql_path = sql_path(&pq_path);

    let csv_sql = format!("COPY (SELECT * FROM {source} LIMIT 250) TO '{csv_sql_path}' (FORMAT CSV, HEADER TRUE);");
    let pq_sql = format!("COPY (SELECT * FROM {source} LIMIT 250) TO '{pq_sql_path}' (FORMAT PARQUET);");

    let csv_ok = conn.execute_batch(&csv_sql).is_ok()
        && fs::metadata(&csv_path).map(|meta| meta.len() > 0).unwrap_or(false);
    let pq_ok = conn.execute_batch(&pq_sql).is_ok()
        && fs::metadata(&pq_path).map(|meta| meta.len() > 0).unwrap_or(false);

    let _ = fs::remove_file(csv_path);
    let _ = fs::remove_file(pq_path);
    Ok((csv_ok, pq_ok))
}

fn evaluate_file(conn: &Connection, file_path: &Path) -> FileCompatResult {
    let file_name = file_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown.parquet".to_string());
    let file_size_bytes = fs::metadata(file_path).map(|meta| meta.len()).unwrap_or(0);
    let sql_file_path = sql_path(file_path);
    let source = format!("read_parquet('{sql_file_path}')");

    let mut row_count = None;
    let mut column_count = 0_usize;
    let mut nested_column_count = 0_usize;
    let mut schema_check_pass = false;
    let mut read_count_pass = false;
    let mut sample_query_pass = false;
    let mut export_csv_pass = false;
    let mut export_parquet_pass = false;
    let mut schema = Vec::<FileSchemaColumn>::new();

    let outcome = (|| -> Result<(), String> {
        schema = load_schema(conn, &source)?;
        column_count = schema.len();
        nested_column_count = schema
            .iter()
            .filter(|column| is_nested_type(&column.duckdb_type))
            .count();
        schema_check_pass = !schema.is_empty();

        let count_sql = format!("SELECT COUNT(*)::UBIGINT FROM {source}");
        let rows = conn
            .query_row(&count_sql, [], |row| row.get::<_, u64>(0))
            .map_err(|e| format!("row count query failed: {e}"))?;
        row_count = Some(rows);
        read_count_pass = true;

        run_sample_query(conn, &source, &schema)?;
        sample_query_pass = true;

        let stem = file_name.trim_end_matches(".parquet");
        let (csv_ok, pq_ok) = run_export_check(conn, &source, stem)?;
        export_csv_pass = csv_ok;
        export_parquet_pass = pq_ok;
        if !csv_ok {
            return Err("csv export check failed".to_string());
        }
        if !pq_ok {
            return Err("parquet export check failed".to_string());
        }
        Ok(())
    })();

    let passed = outcome.is_ok()
        && schema_check_pass
        && read_count_pass
        && sample_query_pass
        && export_csv_pass
        && export_parquet_pass;

    FileCompatResult {
        file_name,
        file_path: file_path.to_string_lossy().to_string(),
        file_size_bytes,
        row_count,
        column_count,
        nested_column_count,
        schema_check_pass,
        read_count_pass,
        sample_query_pass,
        export_csv_pass,
        export_parquet_pass,
        passed,
        error: outcome.err(),
        schema,
    }
}

fn main() -> Result<(), String> {
    let fixtures_dir = env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(default_fixtures_dir);
    if !fixtures_dir.exists() {
        return Err(format!(
            "fixtures directory does not exist: {}",
            fixtures_dir.display()
        ));
    }

    let report_path = env::args()
        .nth(2)
        .map(PathBuf::from)
        .unwrap_or_else(|| default_report_path(&fixtures_dir));

    let conn = Connection::open_in_memory().map_err(|e| format!("open DuckDB: {e}"))?;
    conn.execute_batch("PRAGMA threads=4;")
        .map_err(|e| format!("configure DuckDB: {e}"))?;
    let duckdb_version: String = conn
        .query_row("SELECT version()", [], |row| row.get(0))
        .map_err(|e| format!("query DuckDB version: {e}"))?;

    let mut files = fs::read_dir(&fixtures_dir)
        .map_err(|e| format!("read fixtures directory: {e}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .map(|ext| ext.to_string_lossy().eq_ignore_ascii_case("parquet"))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    files.sort();
    if files.is_empty() {
        return Err(format!(
            "no .parquet files found in fixtures directory: {}",
            fixtures_dir.display()
        ));
    }

    let mut results = Vec::<FileCompatResult>::new();
    for file in &files {
        let result = evaluate_file(&conn, file);
        println!(
            "[{}] {} | rows={} cols={} nested={} err={}",
            if result.passed { "PASS" } else { "FAIL" },
            result.file_name,
            result.row_count
                .map(|value| value.to_string())
                .unwrap_or_else(|| "n/a".to_string()),
            result.column_count,
            result.nested_column_count,
            result.error.clone().unwrap_or_else(|| "-".to_string())
        );
        results.push(result);
    }

    let pass_count = results.iter().filter(|result| result.passed).count();
    let fail_count = results.len() - pass_count;
    let report = CompatMatrixReport {
        generated_at: utc_now_rfc3339(),
        duckdb_version,
        fixtures_dir: fixtures_dir.to_string_lossy().to_string(),
        total_files: results.len(),
        pass_count,
        fail_count,
        results,
    };

    if let Some(parent) = report_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create report output directory: {e}"))?;
    }
    let json = serde_json::to_string_pretty(&report)
        .map_err(|e| format!("serialize report json: {e}"))?;
    fs::write(&report_path, json).map_err(|e| format!("write report: {e}"))?;

    println!(
        "Compatibility matrix complete: {}/{} passed. Report: {}",
        report.pass_count,
        report.total_files,
        report_path.display()
    );
    if report.fail_count > 0 {
        return Err(format!("compatibility matrix failed: {} files failed", report.fail_count));
    }
    Ok(())
}
