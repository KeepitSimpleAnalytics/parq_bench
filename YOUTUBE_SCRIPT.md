# Parq-Bench — YouTube Demo Script

**Video Title:** Parq-Bench: The Free Desktop Parquet Viewer You Didn't Know You Needed
**Target Length:** 8-12 minutes
**Tone:** Conversational, practical, developer-focused

---

## INTRO (0:00 - 0:45)

**[Screen: App splash / icon]**

> Have you ever needed to quickly peek inside a Parquet file — maybe check the schema, scan a few rows, or run a quick query — and realized you'd need to spin up a Jupyter notebook, write some pandas code, or fire up a full cloud tool just to look at your data?
>
> Parq-Bench is a free, open-source desktop app that lets you open, explore, and query Parquet files instantly. No cloud. No accounts. No telemetry. Everything runs locally on your machine, powered by DuckDB.
>
> In this video, I'll walk you through every feature — from opening your first file to running SQL queries across multiple tables, exporting results, and more. Let's jump in.

---

## SECTION 1: OPENING A FILE (0:45 - 2:00)

**[Screen: App opens — empty Preview tab visible]**

> When you first launch Parq-Bench, you land on the **Preview** tab. This is your quick-look viewer for individual Parquet files.
>
> There are three ways to open a file:

### Method 1: Open Button

> Click **Open Parquet** in the top-left, or use the shortcut **Ctrl+O**. Pick any `.parquet` file from your system.

**[Demo: Click Open Parquet, select a file]**

### Method 2: Drag and Drop

> Even easier — just drag a Parquet file from your file explorer and drop it right onto the app.

**[Demo: Drag file onto Preview pane]**

### Method 3: Recent Files

> After you've opened a few files, they show up in a **Recent Files** list right here on the home screen. Click any one to reopen it instantly. Up to 15 files are remembered across sessions.

**[Demo: Show recent files list, click one]**

---

## SECTION 2: EXPLORING DATA IN PREVIEW (2:00 - 3:30)

**[Screen: File loaded, metadata bar visible]**

> Once a file is loaded, you immediately see the metadata bar at the top: the file path, file size, total row count, and column count.
>
> Below that is the data table with **virtual scrolling**. This means even if your file has millions of rows, the app only loads what's on screen — 256 rows at a time. So it stays fast no matter the file size.

**[Demo: Scroll through data, show smooth performance]**

> Each column header shows the column name and its DuckDB type — like VARCHAR, INT32, TIMESTAMP, and so on.

### Copy Column Names

> Here's a handy feature: **click any column header** to copy that column name to your clipboard. Great for pasting into SQL queries.
>
> And if you need all of them, hit the **Copy All Columns** button to get a comma-separated list of every column name.

**[Demo: Click a header — show "Copied!" feedback. Click Copy All Columns.]**

### Interactive Perspective View

> Once the file loads, a **Switch to interactive view** button appears. This uses Perspective.js to give you a fully interactive data grid with sorting, filtering, pivoting, and even built-in charts — bar charts, line charts, treemaps, and more.

**[Demo: Click "Switch to interactive view", sort a column, maybe show a quick bar chart]**

> When you're done, hit **Close File** to free memory and go back to the home screen.

---

## SECTION 3: THE SQL WORKSPACE (3:30 - 6:30)

**[Screen: Click SQL tab or Ctrl+2]**

> Now let's look at the real power of Parq-Bench — the **SQL tab**. This is a full workspace where you can mount multiple Parquet files as tables and query them with standard SQL.

### Mounting Tables

> To add a table, give it an **alias** — that's the name you'll use in your SQL — then browse for the file and click **Mount**.

**[Demo: Type alias "orders", browse for orders.parquet, click Mount]**

> You can also **drag and drop** files here. The app auto-generates an alias from the filename.

**[Demo: Drag 2-3 files onto SQL pane, show pills appearing]**

> Each mounted table shows as a **pill** with action buttons. You can click the alias to **rename it inline**, or click the **X** to remove it.

### Schema Summary

> Below the tables, you'll see a **schema summary** — a compact view of each table's columns. Hover over any table to see the full column list with types.

**[Demo: Hover over a schema pill to show tooltip]**

### Column Search

> When you have multiple tables, a **Search columns** input appears. Type a column name — like "date" or "price" — and the schema pills instantly filter to show only tables that have a matching column. Matches are highlighted.

**[Demo: Type "price" into search, show filtering and highlighting]**

> This is pure client-side filtering — no queries needed. Press Escape or click the X to clear.

### Writing and Running SQL

> The SQL editor is powered by **Monaco** — the same editor engine behind VS Code. You get syntax highlighting, autocomplete for table names and column names, and a resizable editor pane.

**[Demo: Start typing a SELECT query, show autocomplete suggestions]**

> Hit **Ctrl+Enter** or click **Run SQL** to execute.

**[Demo: Run a query, show results table with row count and elapsed time]**

> Results show below with the row count, execution time, and column count. By default, results are limited to 200 rows — but you can change that in Settings.

### EXPLAIN ANALYZE

> Want to see how DuckDB plans to execute your query? Click **Explain** or press **Ctrl+Shift+Enter** to run **EXPLAIN ANALYZE**. This shows the full query execution plan — useful for optimizing complex queries.

**[Demo: Click Explain, show the collapsible plan output]**

### Query History

> Every query you run is saved to your **Query History** — up to 50 entries. Click the **History** button to see a dropdown with timestamps, row counts, and execution times. Click any entry to load it back into the editor.

**[Demo: Open history dropdown, click an older query, show it restored]**

### Column Statistics

> For a quick statistical summary of any table, click the **Stats** button on its pill. This runs DuckDB's `SUMMARIZE` command, showing min, max, null count, distinct count, and average for every column.

**[Demo: Click Stats on a table, show the collapsible stats panel]**

---

## SECTION 4: BULK TABLE OPERATIONS (6:30 - 7:15)

**[Screen: SQL tab with 3+ tables mounted]**

> When you're working with many tables, Parq-Bench gives you bulk operations to manage them.

### Clear All

> When you have two or more tables, a **Clear All** button appears. Click it, confirm, and all tables are removed at once.

**[Demo: Show Clear All button, click it, confirm dialog]**

### Multi-Select Mode

> Or if you only want to remove some tables, click the **Select** toggle. This puts you into multi-select mode — checkboxes appear on every table pill. Check the ones you want to remove, then click **Remove Selected**.

**[Demo: Toggle Select mode, check 2 tables, click Remove Selected]**

---

## SECTION 5: EXPORTING RESULTS (7:15 - 8:00)

**[Screen: SQL tab with query results visible]**

> After running a query, you can export the results in two formats:

### CSV Export

> Click **Export Query CSV** — or use the shortcut **Ctrl+Shift+E**. The exported CSV includes **metadata comment headers** at the top: the SQL query that generated the data, a timestamp, and which tables were involved.

**[Demo: Export CSV, open in text editor to show comment headers]**

### Parquet Export

> Click **Export Query Parquet** for a compact binary format. The Parquet file embeds the same metadata as **key-value metadata** inside the file itself — queryable by any tool that reads Parquet metadata.

**[Demo: Export Parquet, mention metadata]**

> Both exports show the file size and how long the export took.

---

## SECTION 6: SETTINGS & CUSTOMIZATION (8:00 - 8:45)

**[Screen: Open Settings with Ctrl+,]**

> Press **Ctrl+Comma** or click the **Settings** gear icon to open the Settings panel. Here you can configure:

> - **SQL Row Limit** — how many rows queries return. Default is 200, max is 100,000.
> - **Perspective Max Rows** — how many rows load into the interactive view. Higher values use more memory.
> - **Editor Font Size** — adjust the SQL editor text size. You can also use the **A-** and **A+** buttons in the editor toolbar.

**[Demo: Change row limit to 500, change font size]**

> All settings persist across sessions.

### Themes

> Use the **theme picker** in the top-right to switch between **System**, **Light**, and **Dark** modes. The dark theme is great for late-night data exploration.

**[Demo: Switch to dark mode, show the UI change]**

---

## SECTION 7: KEYBOARD SHORTCUTS (8:45 - 9:15)

**[Screen: Quick reference overlay or table graphic]**

> Here's a quick reference of all the keyboard shortcuts:

| Shortcut | Action |
|----------|--------|
| **Ctrl+1** | Switch to Preview tab |
| **Ctrl+2** | Switch to SQL tab |
| **Ctrl+O** | Open Parquet file |
| **Ctrl+Enter** | Run SQL query |
| **Ctrl+Shift+Enter** | Run EXPLAIN ANALYZE |
| **Ctrl+Shift+E** | Export query as CSV |
| **Ctrl+,** | Open Settings |
| **Escape** | Close modals or clear errors |

---

## SECTION 8: ADVANCED FEATURES (9:15 - 10:00)

### Glob Patterns

> In the SQL workspace, you can mount multiple files at once using **glob patterns**. Check the **Glob** checkbox, then enter a pattern like `logs/*.parquet`. DuckDB will treat all matching files as a single table.

**[Demo: Mount with glob pattern, run query against it]**

### Delimited File Support

> Toggle on **Slo-mo mode** to enable support for CSV, TSV, and other delimited files. It's called Slo-mo because these formats require full file parsing — slower than Parquet's columnar format — but it works great when you need it.

**[Demo: Enable Slo-mo, mount a CSV file, query it]**

### Memory Guard

> Parq-Bench monitors your system memory in real-time. If memory usage gets too high — above 85% — a **memory guard** activates, blocking new file opens and queries to prevent crashes. It automatically clears once memory drops back down.

---

## SECTION 9: WHAT'S UNDER THE HOOD (10:00 - 10:30)

> A few things worth knowing about how Parq-Bench works:

> - **DuckDB** handles all SQL execution locally — no server, no network calls.
> - **Apache Arrow IPC** is used for data transport. Small results are sent inline; large results stream over a localhost WebSocket for speed.
> - **Perspective.js** powers the interactive charting and pivoting.
> - **Tauri** wraps everything into a lightweight native desktop app — much smaller than Electron-based alternatives.

---

## OUTRO (10:30 - 11:00)

**[Screen: App overview / logo]**

> That's Parq-Bench — a fast, free, local-first Parquet viewer with a full SQL workspace. Whether you're a data engineer checking pipeline outputs, an analyst exploring datasets, or just someone who needs to peek inside a Parquet file without writing code — this tool has you covered.
>
> Parq-Bench is open source and available on GitHub. Link in the description.
>
> If you found this useful, leave a like and subscribe for more data tooling content. Thanks for watching!

---

## B-ROLL / VISUAL SUGGESTIONS

| Timestamp | Visual |
|-----------|--------|
| 0:00-0:10 | App icon animation / logo reveal |
| 0:10-0:45 | Split screen: frustration with notebooks vs. clean Parq-Bench UI |
| 2:00-2:30 | Close-up on metadata bar, highlight each metric |
| 3:30-4:00 | Side-by-side: drag files into workspace, pills appearing |
| 5:00-5:30 | Monaco autocomplete popup with table/column suggestions |
| 6:30-7:15 | Quick cuts showing bulk select checkbox animation |
| 8:00-8:45 | Settings modal with live preview of changes |
| 8:45-9:15 | Keyboard shortcut reference card (on-screen graphic) |
| 10:00-10:30 | Architecture diagram: Tauri + DuckDB + Arrow + Perspective |

---

## RECORDING TIPS

1. **Use a sample dataset** — TPC-H data or a public dataset with recognizable columns (dates, prices, names)
2. **Pre-mount 3-4 tables** for the SQL section so you don't wait during recording
3. **Dark mode** generally looks better on video — consider recording in dark theme
4. **Zoom the app to ~125%** for better readability on YouTube compression
5. **Pause 1-2 seconds** after each action so viewers can follow
6. **Show the keyboard shortcut** on screen (with a key overlay tool) when demonstrating hotkeys
