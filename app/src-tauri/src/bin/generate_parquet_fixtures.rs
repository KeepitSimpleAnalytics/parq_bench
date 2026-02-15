use duckdb::Connection;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[cfg(target_os = "windows")]
#[link(name = "rstrtmgr")]
unsafe extern "system" {}

struct FixtureSpec {
    file_name: &'static str,
    description: &'static str,
    select_sql: &'static str,
}

fn sql_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .replace('\'', "''")
}

fn write_fixture(conn: &Connection, output_dir: &Path, spec: &FixtureSpec) -> Result<u64, String> {
    let output_path = output_dir.join(spec.file_name);
    let output_sql_path = sql_path(&output_path);
    let copy_sql = format!(
        "COPY ({}) TO '{}' (FORMAT PARQUET, COMPRESSION ZSTD);",
        spec.select_sql, output_sql_path
    );
    conn.execute_batch(&copy_sql)
        .map_err(|e| format!("write {}: {e}", spec.file_name))?;
    let size = fs::metadata(&output_path)
        .map_err(|e| format!("metadata {}: {e}", spec.file_name))?
        .len();
    Ok(size)
}

fn default_output_dir() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .join("..")
        .join("..")
        .join("testdata")
        .join("parquet")
}

fn fixture_specs() -> Vec<FixtureSpec> {
    vec![
        FixtureSpec {
            file_name: "flat_small.parquet",
            description: "Flat schema baseline with common analytical types",
            select_sql: "
                SELECT
                    i::BIGINT AS row_id,
                    format('flow-%06d', i) AS flow_id,
                    (i % 65535)::INTEGER AS destination_port,
                    ((i * 37) % 900000)::BIGINT AS flow_duration,
                    ((i % 1000) / 10.0)::DOUBLE AS score,
                    (i % 2 = 0) AS is_attack,
                    TIMESTAMP '2023-01-01 00:00:00' + (i * INTERVAL 1 SECOND) AS event_ts
                FROM range(0, 50000) AS t(i)
            ",
        },
        FixtureSpec {
            file_name: "flat_wide.parquet",
            description: "Wide table for viewport stress and schema handling",
            select_sql: "
                SELECT
                    i::BIGINT AS row_id,
                    (i % 10)::INTEGER AS c01,
                    (i % 20)::INTEGER AS c02,
                    (i % 30)::INTEGER AS c03,
                    (i % 40)::INTEGER AS c04,
                    (i % 50)::INTEGER AS c05,
                    (i % 60)::INTEGER AS c06,
                    (i % 70)::INTEGER AS c07,
                    (i % 80)::INTEGER AS c08,
                    (i % 90)::INTEGER AS c09,
                    (i % 100)::INTEGER AS c10,
                    (i % 110)::INTEGER AS c11,
                    (i % 120)::INTEGER AS c12,
                    (i % 130)::INTEGER AS c13,
                    (i % 140)::INTEGER AS c14,
                    (i % 150)::INTEGER AS c15,
                    (i % 160)::INTEGER AS c16,
                    (i % 170)::INTEGER AS c17,
                    (i % 180)::INTEGER AS c18,
                    (i % 190)::INTEGER AS c19,
                    (i % 200)::INTEGER AS c20,
                    repeat('x', (i % 25) + 1) AS payload
                FROM range(0, 30000) AS t(i)
            ",
        },
        FixtureSpec {
            file_name: "nested_struct.parquet",
            description: "Nested STRUCT/LIST dataset for flattening behavior",
            select_sql: "
                SELECT
                    i::BIGINT AS row_id,
                    {
                        'src_ip': format('10.0.%d.%d', (i / 256) % 256, i % 256),
                        'src_port': (1000 + (i % 50000))::BIGINT,
                        'metrics': {
                            'flow_duration': (i * 5)::BIGINT,
                            'packet_count': (i % 400)::INTEGER,
                            'score': ((i % 100) / 100.0)::DOUBLE
                        }
                    } AS flow,
                    [i::INTEGER, (i + 1)::INTEGER, (i + 2)::INTEGER]::INTEGER[] AS hops
                FROM range(0, 40000) AS t(i)
            ",
        },
        FixtureSpec {
            file_name: "nested_collections.parquet",
            description: "MAP and LIST<STRUCT> style shapes for stringify fallback",
            select_sql: "
                SELECT
                    i::BIGINT AS row_id,
                    map(
                        ['k1', 'k2', 'k3'],
                        [i::BIGINT, (i * 2)::BIGINT, (i * 3)::BIGINT]
                    ) AS tag_map,
                    [
                        {'code': 'A', 'value': i::BIGINT},
                        {'code': 'B', 'value': (i + 1)::BIGINT}
                    ] AS events
                FROM range(0, 15000) AS t(i)
            ",
        },
        FixtureSpec {
            file_name: "perf_medium.parquet",
            description: "Larger synthetic dataset for perf sweeps and gate checks",
            select_sql: "
                SELECT
                    i::BIGINT AS row_id,
                    format('user-%07d', i % 1000000) AS user_id,
                    (i % 65535)::INTEGER AS destination_port,
                    ((i * 13) % 1000000)::BIGINT AS flow_duration,
                    ((i % 1000) / 1000.0)::DOUBLE AS anomaly_score,
                    [i % 5, (i + 1) % 5, (i + 2) % 5]::INTEGER[] AS bins,
                    TIMESTAMP '2024-01-01 00:00:00' + (i * INTERVAL 1 SECOND) AS event_ts
                FROM range(0, 500000) AS t(i)
            ",
        },
    ]
}

fn main() -> Result<(), String> {
    let output_dir = env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(default_output_dir);
    fs::create_dir_all(&output_dir)
        .map_err(|e| format!("create output directory '{}': {e}", output_dir.display()))?;

    let conn = Connection::open_in_memory().map_err(|e| format!("open DuckDB: {e}"))?;
    conn.execute_batch("PRAGMA threads=4;")
        .map_err(|e| format!("configure DuckDB: {e}"))?;

    println!("Generating parquet fixtures in {}", output_dir.display());
    for spec in fixture_specs() {
        let size = write_fixture(&conn, &output_dir, &spec)?;
        println!(
            "  - {} ({:.2} MB): {}",
            spec.file_name,
            (size as f64) / (1024.0 * 1024.0),
            spec.description
        );
    }
    println!("Done.");
    Ok(())
}
