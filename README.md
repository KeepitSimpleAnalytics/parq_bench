# Parq-Bench

[![License](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

A high-performance desktop application for exploring large Parquet and delimited text files locally, plus Excel, SQLite and Delta Lake tables. Built with Tauri, React, and DuckDB. No cloud, no accounts, no telemetry — all processing happens on your machine. The only network use is a one-time download of an optional DuckDB extension when you first use a feature that needs it (see [Extensions](#extensions)), and reading files you open from a URL.

## Installation

Download the latest installer for your platform from the [Releases](https://github.com/KeepitSimpleAnalytics/parq_bench/releases) page.

## Features

### Preview Tab

Open any Parquet file and see data instantly. Parq-Bench uses virtual scrolling to handle files with millions of rows — only the visible rows are rendered, so scrolling stays smooth regardless of file size.

- **Open a file** — Click **Open file…** or press `Ctrl+O` to pick a `.parquet` file, drop a file onto the Preview tab, or pick one from **Recent**. To open a Parquet file from the web, paste an `https://` link and click **Open URL**.
- **File header** — File name, row count, column count and size, with the full path underneath. **Copy column names**, **Open…** and **Close** (×) sit next to it.
- **Column types** — Each column header shows its DuckDB type. Numbers are right-aligned; `NULL` values are shown in grey italics.
- **Query with SQL** — Adds the open file as a table (or reuses it if it is already added), switches to the SQL tab and starts a `SELECT` for it. Ctrl+Z in the editor brings back what you had.
- **Pivot & chart** — Switch from **Rows** to **Pivot & chart** to pivot, sort, filter and chart the first 5,000 rows (configurable) with Perspective.js. It loads in the background, so the switch is instant.

### SQL Tab

Add files as named tables in the sidebar, then write SQL to query across them.

- **Add a table** — Click **Add table**, choose **Single file** or **Folder of files**, and browse. The table name is filled in from the file name, the format and delimiter are detected, and the first 5 rows are shown before you add it. You can also drop files onto the SQL tab to add them directly.
- **Supported files** — Parquet (`.parquet`) and delimited text (`.csv`, `.tsv`, `.psv`, `.txt`, `.data`). `.tsv` uses tabs and `.psv` uses pipes; other text files have their delimiter auto-detected. You can override it with comma, tab, pipe, semicolon or any single character.
- **Excel** (`.xlsx`) — Pick a sheet and whether the first row holds column names. Excel stores numbers as decimals, so numeric columns arrive as `DOUBLE`. Dropped `.xlsx` files add their first sheet.
- **SQLite** (`.db`, `.sqlite`, `.sqlite3`) — Pick a table or view from the database. Dropping a SQLite file opens **Add table** so you can choose one.
- **Web URLs** — Type an `https://` link to a Parquet or CSV file in the path field. It is read from the web each time a query runs.
- **Folders** — **Folder of files** mounts every file of one type in a folder as a single table (e.g. `exports\*.csv`) and shows how many files match. Choose **Delta Lake table (folder)** to add a Delta table folder.
- **Tables sidebar** — Expand a table to see its columns and types. Each table has **Stats**, **Rename**, **Insert SELECT** and **Remove**; single-file Parquet tables also have **Preview**, which opens them in the Preview tab for full scrolling. Parquet tables show their row count. **Search columns** filters tables by column name.
- **Compare schemas** — Compare two tables to see columns only in one side or with a changed type.
- **SQL editor** — Monaco-powered editor with SQL highlighting. Drag the bottom edge to resize it.
- **Autocomplete** — Suggestions fit where you are typing: tables after `FROM`, the query's own columns in the `SELECT` list and `WHERE`, DuckDB's functions (`date_trunc`, `regexp_extract`, …) and keywords such as `QUALIFY`. Aliases you write work too: after `FROM orders o`, typing `o.` lists the orders columns. This uses DuckDB's autocomplete extension, downloaded the first time you click into the editor; until then, or if it can't be downloaded, you get a basic list of keywords, tables and columns.
- **Run a query** — Click **Run** or press `Ctrl+Enter` to run the statement under the cursor, or the selected text if you have selected some (the button then reads **Run selection**). To run every statement in the editor, use **▾ → Run all statements** or `Ctrl+Alt+Enter`; the earlier statements run first, so a script can create a temporary table and then query it, and you see the last statement's result. The statement that runs is briefly highlighted.
- **Cancel** — While a query, an export, Explain or an exact Stats scan runs, **Run** turns into **Cancel**, with DuckDB's progress estimate when it has one. Press **Cancel** or `Esc` to stop it. A cancelled export removes the partly written file.
- **Results / Chart / Plan** — Results show row count, time and column types. **Chart** draws a Bar, Column, Line, Treemap or Table chart and updates as you change the group-by column, value and summary. **Plan** shows `EXPLAIN ANALYZE` output for the statement under the cursor (**Explain** or `Ctrl+Shift+Enter`).
- **Export** — **Export ▾** saves all result rows of the query that produced them (not just the displayed ones) as CSV, Parquet or Excel (`.xlsx`, up to 1,048,576 rows). `Ctrl+Shift+E` exports CSV directly.
- **Table statistics** — **Stats** reads column statistics from Parquet metadata (instant). Turn on **Exact table stats** in Settings for a full scan.
- **History** — The last 50 queries, with row counts and timings.

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+O` | Open Parquet file |
| `Ctrl+1` | Switch to Preview tab |
| `Ctrl+2` | Switch to SQL tab |
| `Ctrl+Enter` | Run the statement under the cursor (or the selection) |
| `Ctrl+Alt+Enter` | Run all statements |
| `Esc` | Cancel the running query |
| `Ctrl+Shift+Enter` | Explain query plan |
| `Ctrl+Shift+E` | Export results as CSV |
| `Ctrl+,` | Open Settings |
| `Escape` | Close dialog, exit full window, or dismiss error |

### Settings

Press `Ctrl+,` or click the gear icon. Configurable options:

| Setting | Default | Description |
|---------|---------|-------------|
| Theme | System | System, Light or Dark |
| Editor font size | 13 px | Monaco editor font size |
| Expand panels | Full window | Full window overlay or drag-to-resize panels |
| Result row limit | 200 | Rows shown per SQL query (exports include every row) |
| Chart row limit | 5,000 | Rows loaded into pivot and chart views |
| Exact table stats | Off | Full table scan for exact stats (may be slow on large files) |
| Show charting *(Advanced)* | On | The Chart tab in SQL results |
| Show chart configure panel *(Advanced)* | On | Perspective's built-in settings button |

### Extensions

Parquet and JSON support is built in. Excel, SQLite, web URLs, Delta Lake, time zones (`AT TIME ZONE`) and SQL autocomplete use DuckDB extensions that are **downloaded automatically the first time you use them** (about 45–80 MB each) and cached in `~/.duckdb/extensions`, after which they work offline. Nothing is downloaded or loaded at startup, and none of them ship with the installer.

**Settings → Extensions** shows which are downloaded and lets you download them ahead of time, for example before working offline. Other official DuckDB extensions also download automatically when a query uses one of their functions.

### Memory Guard

Parq-Bench monitors its own memory use, shown in the status bar. If it passes 85% of system RAM, a banner explains that opening files and running queries is paused until usage drops, and offers to close the open file.

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
| Editor | Monaco Editor | SQL workspace; DuckDB's autocomplete extension for suggestions |
| Visualization | Perspective.js (FINOS) | Interactive grid, charts, pivoting |
| Backend | Rust, Tauri 2 | File I/O, DuckDB queries, Arrow IPC transport |
| Query Engine | DuckDB 2.0.0 (bundled, Parquet + JSON built in) | Parquet reading, SQL execution, exports |
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
- Frontend unit tests (`npm test`, Vitest: SQL statement splitting and alias detection)
- `cargo test` (58 tests; it compiles the app and both helper binaries too, so there is no separate `cargo check`; the extension tests download the Excel, SQLite, Delta and autocomplete extensions on their first run, so the first gate run needs internet)
- Parquet fixture regeneration (5 synthetic files)
- DuckDB compatibility matrix (5/5 must pass)

### DuckDB Version Policy

DuckDB is pinned to `2.0.0` (crate `duckdb = "=1.20000.1"`) for reproducibility. See [docs/duckdb-upgrade-policy.md](docs/duckdb-upgrade-policy.md) for the upgrade process.

## Contributing

Bug reports and feature requests are welcome — please [open an issue](https://github.com/KeepitSimpleAnalytics/parq_bench/issues).

## License

[GNU General Public License v3.0](LICENSE) — KISA-Keep it Simple Analytics LLC
