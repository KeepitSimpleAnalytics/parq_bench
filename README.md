# Parq-Bench

A high-performance desktop application for exploring large Parquet files locally. Built with Tauri, React, and DuckDB.

## Features

- **Fast preview** — Opens 5 GB+ Parquet files with first-viewport rendering in under 500 ms
- **Interactive grid** — Seamless swap to [Perspective.js](https://perspective.finos.org/) for pivoting, filtering, and charting
- **SQL workspace** — Register multiple Parquet/CSV files and query across them with a Monaco-powered SQL editor with autocomplete
- **Schema inspection** — View column names, types, and nested struct expansion at a glance
- **Export** — Save query results as CSV or Parquet
- **Dark mode** — System-aware theme with manual override
- **Local-first** — No cloud, no accounts, no telemetry. All processing happens on your machine

## Quick Start

### Prerequisites

- [Node.js 20+](https://nodejs.org/)
- [Rust (stable)](https://rustup.rs/)
- Platform build tools for [Tauri v2](https://v2.tauri.app/start/prerequisites/)

### Install and Run

```bash
cd app
npm install
npm run tauri dev
```

### Production Build

```bash
cd app
npm run tauri build
```

Installers are output to `app/src-tauri/target/release/bundle/`.

## Architecture

| Layer | Technology | Role |
|-------|-----------|------|
| Frontend | React 19, TypeScript, Vite | UI, virtual-scroll table, Perspective viewer |
| Editor | Monaco Editor | SQL workspace with autocomplete |
| Visualization | Perspective.js (FINOS) | Interactive grid, charts, pivoting |
| Backend | Rust, Tauri 2 | File I/O, DuckDB queries, Arrow IPC transport |
| Query Engine | DuckDB 1.4.4 (bundled) | Parquet reading, SQL execution, exports |
| Transport | Arrow IPC / WebSocket | < 1 MB via Tauri IPC, >= 1 MB via localhost socket |

## Project Structure

```
parq_bench/
  app/
    src/            # React frontend (TypeScript)
    src-tauri/
      src/
        lib.rs      # Tauri commands, DuckDB integration, transport
        main.rs     # App entry point
        bin/        # CLI tools (fixture generator, compat matrix)
  docs/             # Architecture docs, upgrade policies
  testdata/         # Synthetic Parquet test fixtures
```

## Development

### Release Gate

Validates the full pipeline (build, tests, fixtures, compatibility):

```bash
cd app
npm run release:gate
```

This runs:
- TypeScript + Vite production build
- `cargo check` and `cargo test` (13 integration tests)
- Parquet fixture regeneration (5 synthetic files)
- DuckDB compatibility matrix (5/5 must pass)

### DuckDB Version Policy

DuckDB is pinned to `1.4.4` for reproducibility. See [docs/duckdb-upgrade-policy.md](docs/duckdb-upgrade-policy.md) for the upgrade process.

### Feature Flags

Internal development tools are gated behind build-time environment variables:

| Variable | Effect |
|----------|--------|
| `VITE_PARQBENCH_INTERNAL_TOOLS=1` | Enables acceptance gate, perf sweeps, diagnostics, transport benchmarks |
| `VITE_PARQBENCH_LAYOUTS_ENABLED=1` | Enables docking layout save/switch/rename (requires internal tools) |

Both are always enabled in `npm run tauri dev`. In production builds, they default to off.

## License

[Apache License 2.0](LICENSE) — KISA-Keep it Simple Analytics LLC
