# Parq-Bench

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

A high-performance desktop application for exploring large Parquet files locally. Built with Tauri, React, and DuckDB. No cloud, no accounts, no telemetry — all processing happens on your machine.

<!-- TODO: Add screenshot or demo GIF here -->
<!-- ![Parq-Bench screenshot](docs/screenshot.png) -->

## Installation

Download the latest installer for your platform from the [Releases](https://github.com/KeepitSimpleAnalytics/parq_bench/releases) page.

## Features

### Preview Tab

Open any Parquet file and see data instantly. Parq-Bench uses virtual scrolling to handle files with millions of rows — only the visible rows are rendered, so scrolling stays smooth regardless of file size.

- **Open a file** — Click **Open Parquet** or press `Ctrl+O` to pick a `.parquet` file. You can also drag and drop a file onto the preview pane.
- **File metadata** — Path, size, row count, and column count are shown at the top.
- **Schema at a glance** — Column names and DuckDB types appear in the header row.
- **Interactive pivot view** — Once Perspective.js finishes loading in the background, click **Switch to interactive view** to pivot, sort, filter, and chart the first 5,000 rows.
- **Close file** — Click **Close File** to clear the preview and free memory.

### SQL Tab

Register one or more files as named tables, then write SQL to query across them.

- **Mount a table** — Enter an alias (e.g. `sales`), browse for a file, and click **Mount**. The table is immediately queryable. You can also drag and drop files onto the SQL pane to auto-register them.
- **Glob patterns** — Check the **Glob** box to mount an entire folder of Parquet files as a single table (e.g. `logs/*.parquet`).
- **CSV / TSV support** — Enable **Slo-mo** mode to register delimited text files (CSV, TSV, TXT) with optional custom delimiter.
- **Rename or remove tables** — Click an alias to rename it in-place. Click **x** to remove.
- **Schema summary** — Column names and types for each mounted table are shown as compact pills below the table list.
- **SQL editor** — A Monaco-powered editor with SQL syntax highlighting, word wrap, and line numbers. Resize it vertically by adjusting the font size with the **A-** / **A+** buttons.
- **Autocomplete** — Type `.` after a table alias to get column suggestions. SQL keywords, table names, and column names from all mounted tables are offered as completions.
- **Run a query** — Click **Run SQL** or press `Ctrl+Enter`. Results appear in a scrollable table below the editor with row count, execution time, and column types.
- **Export results** — Click **Export Query CSV** or **Export Query Parquet** to save query output to a file. Press `Ctrl+Shift+E` to export as CSV directly.
- **Charting** — After running a query, pick a chart plugin (Y Bar, X Bar, Y Line, Treemap), select X/Y columns and an aggregation (sum, avg, count, min, max), then click **Chart in Perspective** to visualize results interactively.

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+O` | Open Parquet file |
| `Ctrl+1` | Switch to Preview tab |
| `Ctrl+2` | Switch to SQL tab |
| `Ctrl+Enter` | Run SQL query |
| `Ctrl+Shift+E` | Export query as CSV |
| `Escape` | Close About dialog or clear error |

### Theme

Choose **System**, **Light**, or **Dark** from the dropdown in the header. The choice persists across sessions.

### Memory Guard

Parq-Bench monitors system memory. If usage gets too high, the memory guard trips and blocks file opens and queries until pressure drops. A banner explains what happened and how to recover.

## Building from Source

### Prerequisites

- [Node.js 20+](https://nodejs.org/)
- [Rust (stable)](https://rustup.rs/)
- Platform build tools for [Tauri v2](https://v2.tauri.app/start/prerequisites/)

### Development

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

## Release Gate

Validates the full pipeline before a release:

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

## Contributing

Bug reports and feature requests are welcome — please [open an issue](https://github.com/KeepitSimpleAnalytics/parq_bench/issues).

## License

[Apache License 2.0](LICENSE) — KISA-Keep it Simple Analytics LLC
