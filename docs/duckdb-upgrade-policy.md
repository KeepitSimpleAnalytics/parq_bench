# DuckDB Upgrade Policy

This project currently pins DuckDB via `app/src-tauri/Cargo.toml`:
- `duckdb = { version = "=1.20000.1", features = ["bundled", "parquet", "json"] }` (DuckDB 2.0.0; from 1.5 onward the crate version encodes the DuckDB version as `1.Mmmpp.x` (e.g. 2.0.0 → `1.20000.x`, 1.5.6 → `1.10506.x`); `cargo update` will not cross these on its own)

## Why pinning is required
- Workspace SQL, nested-column flattening, and export behavior can change across DuckDB versions.
- We use a hard release gate and compatibility corpus; upgrades must prove parity before merge.

## Required upgrade process
1. Update pinned crate version in `app/src-tauri/Cargo.toml`.
2. Refresh lockfile:
   - `cd app/src-tauri`
   - `cargo update -p duckdb`
3. Run release gate from `app/`:
   - `npm run release:gate`
4. Verify compatibility report:
   - `testdata/parquet/compat_matrix_report.json`
   - Required: `fail_count = 0`
5. Run perf sweeps on representative datasets (minimum 3 files):
   - Required budgets:
   - first viewport p95 `<= 400ms`
   - Perspective ready p95 `<= 1000ms`
   - sweep failures `= 0`
6. If all checks pass:
   - commit with explicit DuckDB version bump note
   - include compatibility/perf results summary in PR description

## Rollback rule
- If any gate fails, revert to prior pinned DuckDB version and re-run `npm run release:gate` before proceeding.
