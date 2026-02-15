# Parquet Test Fixtures

Generated fixture files used for compatibility, flattening, and performance regression checks.

## Files
- `flat_small.parquet`: flat baseline schema with common analytical types.
- `flat_wide.parquet`: wider column count for viewport/schema stress.
- `nested_struct.parquet`: nested struct + list columns for flattening behavior.
- `nested_collections.parquet`: map and list-of-struct style collection columns.
- `perf_medium.parquet`: larger synthetic dataset for acceptance/perf sweeps.

## Regenerate
From `app/src-tauri`:

```powershell
cargo run --bin generate_parquet_fixtures
```

To generate into a custom directory:

```powershell
cargo run --bin generate_parquet_fixtures -- "D:\path\to\fixtures"
```

## Compatibility Matrix
From `app/src-tauri`:

```powershell
cargo run --bin run_compat_matrix
```

Optional custom paths:

```powershell
cargo run --bin run_compat_matrix -- "E:\parq_bench\testdata\parquet" "E:\parq_bench\testdata\parquet\compat_matrix_report.json"
```
