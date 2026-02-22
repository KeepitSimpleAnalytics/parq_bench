# Parq-Bench — Potential Enhancements

## Current State Summary

Parq-Bench is a Tauri v2 + React 19 + DuckDB 1.4.4 desktop app for exploring local Parquet and delimited data files. Core features include: virtual-scrolled preview, Perspective.js visualization, Monaco SQL editor with autocomplete, workspace table management (register/remove/rename/drag-drop), schema diff, query export, chart plugins, dark/light theme, and memory guard protection.

## Completed Enhancements

- **Keyboard Shortcuts (#8)** — DONE. Ctrl+Enter (run SQL), Ctrl+O (open file), Ctrl+1/2 (switch tabs), Ctrl+Shift+E (export CSV), Ctrl+Shift+Enter (explain analyze), Ctrl+, (settings), Escape (close modals/errors).
- **Drag-and-Drop** — DONE. Drop .parquet files on Preview tab to open; drop files on SQL tab to mount as workspace tables.
- **Alias Rename** — DONE. Click alias label on workspace table pill to rename inline.
- **Recent Files (#4)** — DONE. Last 15 opened files persisted to localStorage, shown in Preview placeholder.
- **Query History (#2)** — DONE. Last 50 queries persisted to localStorage with row count and timing. Click to restore into editor.
- **Settings Panel (#14)** — DONE. Configurable SQL row limit, Perspective max rows, editor font size. Persisted to localStorage.
- **EXPLAIN ANALYZE (#10)** — DONE. Explain button + Ctrl+Shift+Enter shortcut. Shows query execution plan in collapsible panel.
- **Column Statistics (#3)** — DONE. Stats button per workspace table pill runs DuckDB SUMMARIZE. Results displayed in collapsible table.
- **Export with Metadata (#11)** — DONE. CSV exports include comment headers (query, timestamp, tables). Parquet exports include KV_METADATA.
- **Copy Column Names (#6)** — DONE. Click any column header to copy its name. "Copy All Columns" button in both preview and workspace query results.
- **Bulk Table Operations (#13)** — DONE. "Clear All" button with confirmation, multi-select mode with checkboxes, "Remove Selected" for batch removal.
- **Search Across Tables (#15)** — DONE. Search input filters schema pills by column name (case-insensitive). Matching columns highlighted, count badge per pill.

---

## Tier 1 — High Impact, Moderate Effort

### 1. Workspace Persistence (Session Save/Restore) — PARTIAL

**Problem:** All mounted workspace tables, editor content, and query results are lost on app restart. Users must re-mount every file each session.

**Solution:** Serialize workspace state (mounted tables, SQL editor text, active tab, slo-mo toggle, chart config) to `localStorage` on change. Restore on app startup. Optionally support named workspace profiles saved to disk.

**Performance Impact:**
- **Startup time:** +5–15ms to read and parse localStorage JSON (negligible)
- **Runtime overhead:** +1–3ms per state change for serialization (debounced writes)
- **DuckDB re-registration:** +50–200ms per table on restore (sequential `register_workspace_table` calls). For 5 tables: ~250ms–1s total added to cold start
- **Memory:** No meaningful change — same tables would be mounted manually anyway
- **Net user time saved:** 30–120 seconds per session (eliminates manual re-mounting)

**Estimated effort:** 3–4 hours

---

### 1 — Partial Status

Active tab, theme, slo-mo toggle, and SQL editor content now persist across restarts via localStorage. Full workspace table re-registration on startup is not yet implemented — tables must be re-mounted manually.

---

### 2. Query History — DONE

**Problem:** No way to recall previous SQL queries. Users re-type or lose work when experimenting.

**Solution:** Maintain a ring buffer (last 50 queries) in React state, persisted to `localStorage`. Show as a dropdown or sidebar panel. Click to restore into editor.

**Performance Impact:**
- **Memory:** ~50KB for 50 queries (negligible)
- **localStorage writes:** +1–2ms per query execution (debounced)
- **Render cost:** Dropdown with 50 items: <1ms React reconciliation
- **No DuckDB impact** — purely frontend state
- **Net user time saved:** 10–30 seconds per repeated query

**Estimated effort:** 1–2 hours

---

### 3. Column Statistics Panel — DONE

**Problem:** Users have no visibility into data distribution (min, max, null count, distinct count, avg) without writing manual SQL. This makes charting decisions and data quality checks slow.

**Solution:** Add a "Quick Stats" button per workspace table that runs DuckDB's `SUMMARIZE` command. Display results in a compact table or tooltip. Cache results per alias until table is re-mounted.

**Performance Impact:**
- **DuckDB query cost:** `SUMMARIZE` scans the full table. For a 100MB Parquet file with 1M rows: ~200–800ms. For 1GB+: 2–5 seconds. Should run on `on_duckdb_thread()` to avoid blocking
- **Memory:** Result set is small (one row per column, ~10 fields each). ~5–50KB per table
- **Frontend render:** Trivial — small table of 5–30 rows
- **Risk:** On very large files (10GB+), `SUMMARIZE` could take 10–30 seconds and consume significant memory. Should respect memory guard and show progress indicator
- **Net user time saved:** 15–60 seconds per data exploration cycle (eliminates manual COUNT/MIN/MAX queries)

**Estimated effort:** 3–4 hours

---

### 4. Recent Files List — DONE

**Problem:** Every session starts from a blank slate. Users must navigate to the same directories repeatedly.

**Solution:** Track the last 10–20 opened file paths in `localStorage`. Display as a list in the Preview placeholder area and/or a dropdown near the Open button. Click to re-open.

**Performance Impact:**
- **localStorage:** +1–2ms read on startup, +1ms write per file open
- **File existence check:** Optional `fs.exists()` call per entry: ~1–5ms each, 10–100ms total for 20 entries. Can be done lazily or skipped (show path, handle error on open)
- **No DuckDB impact** until user clicks to open
- **Render cost:** List of 10–20 items: <1ms
- **Net user time saved:** 5–15 seconds per file open (eliminates directory navigation)

**Estimated effort:** 1–2 hours

---

## Tier 2 — Medium Impact, Low Effort

### 5. Jump to Row

**Problem:** Preview only supports scrolling. With millions of rows, reaching row 500,000 requires extensive scrolling.

**Solution:** Add a "Go to row" input field in the preview toolbar. On submit, set `scrollTop` to `targetRow * ROW_HEIGHT` and trigger page fetching for the target range.

**Performance Impact:**
- **Scroll update:** Instantaneous — single `setState` call (~1ms)
- **Page fetch:** Same as normal lazy-load: one `fetch_parquet_rows_transport` call per page. ~30–100ms per page depending on file size and column count
- **No additional memory** beyond normal page cache
- **Risk:** Jumping to a distant row may trigger 1–2 page fetches before content is visible. User sees "..." placeholders briefly (existing behavior)
- **Net user time saved:** 5–30 seconds when inspecting specific row ranges

**Estimated effort:** 30–60 minutes

---

### 6. Copy Column Names — DONE

**Problem:** No way to copy column names from preview schema for use in SQL queries. Users must retype them manually, error-prone for long or unusual names.

**Solution:** Add click-to-copy on individual column headers (copies single name). Add a "Copy all columns" button that copies a comma-separated list. Use `writeText` from `@tauri-apps/plugin-clipboard-manager`.

**Performance Impact:**
- **Clipboard write:** <1ms per operation
- **No DuckDB impact**
- **Render cost:** One additional click handler per column header — negligible
- **Net user time saved:** 5–15 seconds per query construction

**Estimated effort:** 30–60 minutes

---

### 7. SQL Templates / Snippets

**Problem:** Users write the same boilerplate SQL patterns repeatedly (COUNT, DISTINCT, GROUP BY, etc.).

**Solution:** Add a "Templates" dropdown near the SQL editor that inserts pre-built query patterns. Templates reference the first mounted workspace alias dynamically. Examples: `SELECT COUNT(*) FROM {alias}`, `SELECT *, COUNT(*) OVER() FROM {alias} LIMIT 100`, `SELECT col, COUNT(*) FROM {alias} GROUP BY col ORDER BY 2 DESC`.

**Performance Impact:**
- **No runtime cost** — purely UI string insertion
- **Monaco editor update:** <1ms per `setValue()` call
- **No DuckDB impact** until user runs the query
- **Net user time saved:** 5–10 seconds per template use

**Estimated effort:** 1–2 hours

---

### 8. Keyboard Shortcuts — DONE

**Problem:** No keyboard shortcuts exist. Power users must click buttons for every action.

**Solution:** Register global keyboard handlers: `Ctrl+Enter` (run SQL), `Ctrl+O` (open file), `Ctrl+1`/`Ctrl+2` (switch tabs), `Escape` (clear error/close modal). Use `useEffect` with `keydown` listener.

**Performance Impact:**
- **Event listener:** One global `keydown` handler — negligible overhead (~0.01ms per keypress)
- **No DuckDB impact** — shortcuts trigger existing functions
- **Memory:** ~1KB for handler closure
- **Net user time saved:** 1–3 seconds per action (compounds heavily for power users)

**Estimated effort:** 1–2 hours

---

## Tier 3 — Lower Priority, Varied Effort

### 9. JSON/JSONL File Support

**Problem:** DuckDB supports `read_json_auto()` natively but the app doesn't expose it. JSON/JSONL is common in log analysis and API data.

**Solution:** Add `"json"` and `"jsonl"` to workspace source kinds. Map `.json`/`.jsonl`/`.ndjson` extensions. Use `read_json_auto()` in `workspace_source_sql()`. Gate behind slo-mo toggle (like delimited files).

**Performance Impact:**
- **DuckDB JSON parsing:** Significantly slower than Parquet. 100MB JSON: 2–8 seconds vs. 200–500ms for equivalent Parquet. Memory usage 2–4x higher due to schema inference and string parsing
- **Schema inference:** `read_json_auto()` scans a sample of the file. First-time cost: 500ms–3s depending on file size and nesting depth
- **Memory pressure:** JSON files decompress into larger in-memory representations. A 100MB JSON file may consume 300–800MB of DuckDB memory. Memory guard becomes more important
- **Render cost:** Same as any other workspace table once loaded
- **Risk:** Deeply nested JSON produces very wide schemas after flattening. 50+ columns possible from a single file

**Estimated effort:** 2–3 hours

---

### 10. EXPLAIN ANALYZE View — DONE

**Problem:** Users have no visibility into why a query is slow. No query plan or execution statistics.

**Solution:** Add an "Explain" button next to "Run SQL" that prepends `EXPLAIN ANALYZE` to the query and displays the plan in a pre-formatted text block or collapsible panel.

**Performance Impact:**
- **DuckDB cost:** `EXPLAIN ANALYZE` runs the full query plus profiling overhead. Typically 10–30% slower than the query itself. For a 500ms query: ~550–650ms total
- **Result size:** Query plans are text, typically 1–10KB. No memory concern
- **Render cost:** Displaying preformatted text: <1ms
- **Risk:** For very long-running queries (10s+), the explain will also take 10s+. Should share the same loading/timeout UX as normal query execution

**Estimated effort:** 2–3 hours

---

### 11. Export with Metadata — DONE

**Problem:** Exported CSV/Parquet files contain no context about the source query, timestamp, or workspace configuration.

**Solution:** For CSV: prepend comment lines (`# Query: ...`, `# Exported: ...`, `# Tables: ...`) before the header row. For Parquet: write metadata key-value pairs into the Parquet file footer (DuckDB supports this via `KV_METADATA`).

**Performance Impact:**
- **CSV metadata:** +1–2ms for string concatenation. No measurable impact on file I/O
- **Parquet metadata:** DuckDB `KV_METADATA` option adds <1ms to export. File size increase: 100–500 bytes
- **No runtime overhead** outside of export operation
- **Risk:** Some CSV parsers may choke on comment lines. Should be opt-in or use a separate metadata sidecar

**Estimated effort:** 1–2 hours

---

### 12. Pre-registration Data Preview

**Problem:** Users mount CSV/delimited files without seeing contents first. Bad delimiter choice or wrong file wastes a registration cycle.

**Solution:** Add a "Preview" button in the workspace registration row that reads the first 5–10 rows of the file before committing. Display in a small inline table or tooltip.

**Performance Impact:**
- **DuckDB cost:** Reading 10 rows from a CSV: 10–50ms. From Parquet: 5–20ms. Minimal
- **Memory:** ~1–5KB for 10 rows. Temporary — discarded after preview closes
- **Additional IPC round-trip:** One `invoke` call: ~2–5ms overhead
- **Net user time saved:** 10–30 seconds when mounting unfamiliar files (avoids mount → inspect → remove → re-mount cycle)

**Estimated effort:** 2–3 hours

---

### 13. Bulk Table Operations — DONE

**Problem:** Removing or renaming multiple workspace tables requires clicking one at a time.

**Solution:** Add a "Clear All" button to remove all tables. Add multi-select mode (checkboxes on pills) with bulk remove. Bulk rename could use a prefix/suffix pattern.

**Detailed UX:**
- **Clear All:** A single "Clear All" button appears next to the "Tables:" label when 2+ tables are mounted. Clicking it calls `remove_workspace_table` for each alias sequentially, then refreshes. A confirmation dialog prevents accidental bulk deletion.
- **Multi-select mode:** A "Select" toggle button activates checkboxes on each table pill. When active, a "Remove Selected" button appears. Users check the tables they want to remove, then click "Remove Selected" to batch-remove them. The toggle deactivates after the operation completes.
- **Bulk rename prefix:** In multi-select mode, an optional "Rename prefix" input appears. Entering a prefix (e.g., `v2_`) and clicking "Apply Prefix" prepends the prefix to every selected table alias, calling `rename_workspace_table` for each.
- **Edge cases:** If a rename would cause a collision (two tables with the same resulting name), skip that rename and show an error for the specific alias. Partial failures don't roll back successful renames.

**Performance Impact:**
- **Batch remove:** One mutex lock + `Vec::retain()`: <1ms regardless of table count
- **Batch rename:** One mutex lock + N string assignments: <1ms
- **Frontend re-render:** Workspace table list with 10–20 pills: 1–3ms React reconciliation
- **`refreshWorkspaceTables` call:** One `list_workspace_tables` invoke + N `describe_workspace_table` calls. For 10 tables: ~100–500ms total

**Estimated effort:** 1–2 hours

---

### 14. Settings Panel — DONE

**Problem:** Default row limits, font sizes, memory thresholds, and editor preferences are hardcoded. Power users can't tune behavior.

**Solution:** Add a Settings modal with configurable values: default SQL row limit (currently 200), editor font size default, Perspective max rows (currently 5000), memory guard threshold (currently 85%), theme preference. Persist to `localStorage`.

**Performance Impact:**
- **No runtime overhead** beyond reading config values from state (already done for theme/slo-mo)
- **Perspective max rows tuning:** Increasing from 5000 to 20000 would increase Perspective load time by 2–4x and memory by 3–5x. Should include a warning
- **Memory guard threshold:** Lowering below 85% triggers guard earlier, reducing risk but blocking operations sooner. Raising above 85% increases crash risk
- **localStorage:** Same pattern as existing theme/slo-mo persistence: <1ms

**Estimated effort:** 2–3 hours

---

### 15. Search Across Tables — DONE

**Problem:** With many workspace tables mounted, users can't quickly find which table contains a specific column name.

**Solution:** Add a search input in the workspace panel that filters the schema summary pills by column name. Highlight matching columns across all tables.

**Detailed UX:**
- **Search input:** A text input labeled "Search columns" appears above the schema summary pills when 2+ tables are mounted. It is always visible (not hidden behind a toggle).
- **Live filtering:** As the user types, schema summary pills are filtered to show only tables that contain a column matching the search text (case-insensitive substring match). The matching column names within each pill are highlighted (bold or colored) while non-matching columns remain in their normal style.
- **Empty state:** If no columns match the search, show a "No matching columns found" message instead of the pills.
- **Clear behavior:** An "x" button inside the input clears the search and restores all pills. Pressing Escape while the input is focused also clears it.
- **Column count badge:** Each filtered pill shows `(N matching / M total)` to indicate how many columns matched out of the total.
- **No DuckDB interaction:** The filter operates entirely on the cached `workspaceTableSchemas` state object, so it's instantaneous.

**Performance Impact:**
- **Filter operation:** String matching across all column names. For 10 tables with 50 columns each (500 total): <1ms
- **Re-render:** Filtered pill list: 1–2ms React reconciliation
- **No DuckDB calls** — operates on cached `workspaceTableSchemas` state
- **Memory:** No additional memory

**Estimated effort:** 1 hour

---

## Performance Impact Summary

| Enhancement | DuckDB Cost | Memory Impact | Frontend Cost | User Time Saved |
|---|---|---|---|---|
| Workspace Persistence | +50–200ms/table on restore | None | +5–15ms startup | 30–120s/session |
| Query History | None | +50KB | +1–2ms/query | 10–30s/repeated query |
| Column Statistics | +200ms–5s per table | +5–50KB/table | Trivial | 15–60s/exploration |
| Recent Files | None | +1–2KB | +1–2ms startup | 5–15s/file open |
| Jump to Row | +30–100ms page fetch | None | +1ms | 5–30s/inspection |
| Copy Column Names | None | None | <1ms | 5–15s/query build |
| SQL Templates | None | None | <1ms | 5–10s/template |
| Keyboard Shortcuts | None | +1KB | ~0.01ms/keypress | 1–3s/action |
| JSON/JSONL Support | +2–8s for 100MB | 2–4x vs Parquet | Same as tables | Enables new workflows |
| EXPLAIN ANALYZE | +10–30% query time | +1–10KB | <1ms | Debug insight |
| Export with Metadata | <1ms | +100–500 bytes | None | Context preservation |
| Pre-registration Preview | +10–50ms | +1–5KB temp | 1–2ms | 10–30s/mount cycle |
| Bulk Table Operations | <1ms | None | 1–3ms | 5–15s/batch |
| Settings Panel | None | +1KB | <1ms | Enables tuning |
| Search Across Tables | None | None | <1ms | 5–10s/search |

---

## Recommended Implementation Order

1. **Recent Files** + **Query History** — Fastest wins, pure frontend, biggest daily friction reduction
2. **Workspace Persistence** — Transforms the app from "session tool" to "workspace tool"
3. **Keyboard Shortcuts** — Low effort, compounds for power users
4. **Column Statistics** — Unlocks smarter data exploration
5. **Copy Column Names** + **Jump to Row** — Small polish, removes papercuts
6. **SQL Templates** — Reduces boilerplate for new users
7. **JSON/JSONL Support** — Broadens file format coverage
8. **Settings Panel** — Enables power-user tuning
9. **Remaining items** — Based on user feedback and priorities

---

## Performance Tuning Opportunities

Identified via full codebase audit of `App.tsx` (~3000 lines), `App.css` (~880 lines), and `lib.rs` (~2400 lines).

### Tier 1 — High Impact

#### P1. DuckDB Connection Pooling

**Current:** Every Tauri command (`fetch_parquet_rows`, `run_workspace_query`, `summarize_workspace_table`, etc.) creates a brand-new `Connection::open_in_memory()` and re-sets pragmas (threads, memory limit). This happens on every page fetch during scroll, every query run, and every stats request.

**Fix:** Store a single DuckDB connection in `AppRuntimeState` behind a Mutex. Reuse across commands instead of recreating.

| Pros | Cons |
|------|------|
| Eliminates ~50-200ms overhead per operation | Persistent connection state (views, temp tables) requires careful cleanup |
| Biggest win for page fetches during virtual scroll | Mutex contention under concurrent calls |
| Reduces GC pressure from short-lived connections | Thread safety testing required |

**Impact:** Critical — every page fetch, query, and stats call currently pays connection setup cost.
**Effort:** ~2 hours

---

#### P2. Cache Schema Metadata

**Current:** `parquet_schema()` and `flattened_columns_for_source()` are called on every page fetch (256-row pages). A 100K-row file triggers 400+ schema introspection queries. Each runs `DESCRIBE` + recursive struct type parsing.

**Fix:** Cache schema and flattened column metadata after first `preview_parquet` call. Return schema with the preview response and reuse for all subsequent `fetch_parquet_rows` calls.

| Pros | Cons |
|------|------|
| Eliminates hundreds of redundant DESCRIBE queries per file view | Need to invalidate cache when a different file is opened |
| Massive speedup on large file scrolling | Small memory cost (~1-5KB per cached schema) |
| Reduces DuckDB CPU usage during scroll | |

**Impact:** Critical — schema introspection is the #1 cost during virtual scroll.
**Effort:** ~1 hour

---

#### P3. Extract Virtual Grid Component

**Current:** The entire `App` function (~3000 lines) is a single component with 70+ `useState` hooks. Changing any state (theme, settings, history, stats, search) triggers a full re-render, including the virtual scroll grid with all its row/cell elements.

**Fix:** Extract `<VirtualGrid>` as a separate `React.memo()` component. Pass only scroll position, loaded rows, and schema as props. Grid rendering is isolated from unrelated state changes.

| Pros | Cons |
|------|------|
| Grid rendering isolated from settings/history/stats/theme changes | Requires prop drilling or context for shared state |
| Smoother scrolling during background state updates | Moderate refactor effort (~200 lines to extract) |
| Better React reconciliation performance | |

**Impact:** High — prevents unrelated state changes from blocking scroll paint frames.
**Effort:** ~3-4 hours

---

#### P4. Parallelize Perspective WASM Loading

**Current:** Six sequential `await import()` calls for Perspective modules: core, viewer, server WASM, viewer WASM, datagrid plugin, d3fc plugin. Each waits for the previous to complete.

**Fix:** Use `Promise.all()` for independent imports. Core + viewer WASM can load in parallel; plugins can load in parallel with each other.

| Pros | Cons |
|------|------|
| Interactive view available ~1-2s faster | Error handling more complex with parallel promises |
| No behavior change — same modules loaded | Need to identify true sequential dependencies |
| Easy to implement (~30 min) | |

**Impact:** High — reduces Perspective load from ~3s to ~1.5s.
**Effort:** ~30 minutes

---

### Tier 2 — Medium Impact

#### P5. Memoize Monaco Completion Provider

**Current:** The completion provider is destroyed and rebuilt every time `workspaceTables`, `workspaceTableSchemas`, or `workspaceQueryResult` changes. Builds thousands of suggestion objects (SQL keywords + table aliases + all column names + qualified columns).

**Fix:** `useMemo` for suggestion arrays. Only rebuild the provider when the actual table list changes, not on every query result.

| Pros | Cons |
|------|------|
| Eliminates CPU spikes when adding tables or running queries | Slightly stale completions until memo invalidates |
| Reduces object allocation churn | |

**Impact:** Medium-High — noticeable lag with 5+ tables mounted.
**Effort:** ~1 hour

---

#### P6. Debounce Column Search

**Current:** Every keystroke in the "Search columns" input triggers a full filter of all tables and schemas, re-rendering the filtered pill list immediately.

**Fix:** Add 150ms debounce on `setColumnSearchQuery` so filtering runs after the user pauses typing.

| Pros | Cons |
|------|------|
| Smooth typing experience with 20+ tables | 150ms delay before filter results appear |
| Reduces render thrashing during fast typing | |

**Impact:** Medium — noticeable with many tables and hundreds of columns.
**Effort:** ~15 minutes

---

#### P7. Workspace Table Clone Reduction

**Current:** Every workspace command (`run_workspace_query`, `describe_workspace_table`, `export_workspace_query`, `explain_workspace_query`, `summarize_workspace_table`) clones the entire `Vec<WorkspaceTableRegistration>` via `lock.clone()`.

**Fix:** Use `Arc<Vec<...>>` so cloning is a cheap reference count increment instead of deep copy.

| Pros | Cons |
|------|------|
| Reduces allocation for workspaces with 50+ tables | Slightly more complex lock management |
| O(1) clone instead of O(n) | |

**Impact:** Medium — measurable overhead with many tables.
**Effort:** ~30 minutes

---

#### P8. Vite Code Splitting

**Current:** Entire app ships as a single 4.2MB JS bundle. Monaco (~2MB) and Perspective (~3MB WASM) load on startup regardless of which tab the user opens.

**Fix:** Add `manualChunks` in Vite config to split Monaco and Perspective into separate lazy-loaded chunks.

| Pros | Cons |
|------|------|
| Faster initial load — Preview tab doesn't need Monaco | Additional HTTP requests (minor for local app) |
| Browser can cache chunks independently | More complex build configuration |
| Reduces initial parse/compile time | |

**Impact:** Medium — affects cold start time.
**Effort:** ~30 minutes

---

#### P9. Memoize Inline Style Objects

**Current:** Style objects like `{ transform: \`translateY(${px}px)\` }` and `{ height: value }` are created as new JavaScript objects on every render. This breaks React's shallow comparison and causes unnecessary child re-renders.

**Fix:** Move computed styles to CSS classes with CSS custom properties, or wrap in `useMemo`.

| Pros | Cons |
|------|------|
| Fewer object allocations during scroll | More CSS classes to maintain |
| Better React reconciliation (stable object identity) | `useMemo` adds dependency tracking overhead |

**Impact:** Medium — accumulates during rapid scrolling.
**Effort:** ~1 hour

---

#### P10. Stabilize Global Keyboard Handler

**Current:** `handleGlobalKeyDown` depends on 6 state variables (`aboutOpen`, `settingsOpen`, `error`, `loading`, `explainLoading`, `activeTab`). Every time any of these changes, the event listener is removed and re-added.

**Fix:** Use refs for state values inside the handler with a stable `useCallback` (empty deps). The handler reads current values from refs instead of closures.

| Pros | Cons |
|------|------|
| Stops constant addEventListener/removeEventListener churn | Less "reactive" pattern; refs instead of closures |
| Stable handler reference across renders | |

**Impact:** Low-Medium — reduces event listener overhead during async operations.
**Effort:** ~30 minutes

---

### Tier 3 — Low Impact (Polish)

#### P11. Batch Perspective Stage Updates

**Current:** Each stage transition during Perspective loading (`core.init_server`, `viewer.ready`, `worker`, `table`, `load`, `restore`) calls `setPerspectiveStage()`, triggering a re-render each time (~6-8 renders).

**Fix:** Batch into a single state object updated once when loading completes, or use `React.startTransition()` for non-urgent updates.

| Pros | Cons |
|------|------|
| Fewer re-renders during Perspective init | Loses granular stage display (if used for debugging) |

**Impact:** Low. **Effort:** ~30 minutes

---

#### P12. Reduce Memory Monitor Polling Frequency

**Current:** Frontend polls `runtime_health` every 1.5s. Backend memory monitor thread checks `sysinfo` every 1s. Both run continuously even when the app is idle.

**Fix:** Increase idle polling to 5s. Switch to 1s only during active operations (file open, query run).

| Pros | Cons |
|------|------|
| ~1-2% CPU savings at idle | Slightly delayed memory guard reaction when idle |

**Impact:** Low. **Effort:** ~30 minutes

---

#### P13. React.lazy for Monaco Editor

**Current:** Monaco Editor bundle loads eagerly on app start, even if the user only uses the Preview tab.

**Fix:** `React.lazy(() => import('@monaco-editor/react'))` with `<Suspense>` fallback.

| Pros | Cons |
|------|------|
| Preview-only users see faster startup | Brief loading spinner when first switching to SQL tab |

**Impact:** Low. **Effort:** ~15 minutes

---

#### P14. Cache Escaped SQL Identifiers

**Current:** `escape_sql_ident()` and `escape_sql_string_literal()` are called in loops for the same identifiers on every command invocation.

**Fix:** Cache escaped identifiers in a local HashMap during command execution.

| Pros | Cons |
|------|------|
| Eliminates redundant string replace operations | Extra HashMap allocation; marginal gain |

**Impact:** Low. **Effort:** ~15 minutes

---

### Performance Tuning Priority

For maximum speed gain with minimum effort:

1. **P2 Cache Schema Metadata** — Eliminates hundreds of redundant SQL queries per file. ~1 hour.
2. **P1 DuckDB Connection Pooling** — Eliminates connection setup on every operation. ~2 hours.
3. **P4 Parallelize Perspective Loading** — Easy `Promise.all()` change. ~30 minutes.
4. **P3 Extract Virtual Grid** — Most effort but best long-term scroll performance. ~3-4 hours.

Items P1-P4 cover ~80% of potential performance gains.
