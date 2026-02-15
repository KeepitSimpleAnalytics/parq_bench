# parq_bench

## Release Gate
From `app/`:

```powershell
npm run release:gate
```

This runs:
- frontend production build
- Rust `cargo check` + `cargo test`
- parquet fixture generation
- DuckDB compatibility matrix (`testdata/parquet/compat_matrix_report.json`)

## DuckDB Policy
- Upgrade policy: `docs/duckdb-upgrade-policy.md`
