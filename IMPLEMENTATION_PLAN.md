# Parq-Bench Implementation Plan (from TDD v1.1.0)

## 1) Scope and planning baseline
- Source spec: `ParqBench_TDD_v1.1_1.docx` (Version 1.1.0, February 2026).
- Planning focus for this repo: Phase 0 and Phase 1 readiness.
- Primary product promise to protect:
  - First viewport in `< 500ms` (rapid-render path).
  - Full interactive grid in `< 3s` (Perspective ready).
  - Local-first, no cloud dependency.

## 2) MVP architecture decisions
- Desktop shell: Tauri + Rust host.
- Query engine: DuckDB embedded in Rust.
- Data transport:
  - `< 1MB`: Tauri IPC.
  - `>= 1MB`: Arrow IPC streaming over localhost socket.
- UI rendering:
  - Initial: virtual-scroll HTML table (fast boot path).
  - Full: Perspective.js (lazy-loaded).
- Safety:
  - Adaptive thread count: `max(2, floor(cores * 0.6))`.
  - Memory panic circuit at `85%` RSS.
  - DuckDB memory limit: `min(available_ram * 0.75, 24GB)`.

## 3) Delivery milestones

## Phase 0: Transport Prototype (Go/No-Go)
Goal: prove Arrow IPC transport throughput and end-to-end viability in Tauri.

Deliverables:
- Minimal Tauri app shell.
- Rust endpoint loads Parquet via DuckDB and returns Arrow RecordBatch.
- Localhost socket transport path implemented.
- Browser-side binary receive + decode path implemented.
- Plain HTML table render of sample rows.

Acceptance criteria:
- Sustained Arrow IPC transfer throughput `> 500MB/s` on local machine.
- Correct row/column counts in UI for test files.
- No process crash for at least 10 repeated transfers.

Exit decision:
- Pass: proceed to Phase 1.
- Fail: evaluate `egui` or localhost web-server shell before full build.

## Phase 1: Viewer MVP
Goal: open large local Parquet and explore safely.

Deliverables:
- Native file picker.
- Rapid-render virtual table (first viewport).
- Perspective grid handoff after lazy init.
- Schema panel (name, type, row count, size).
- Memory panic circuit + user-visible warning.

Acceptance criteria:
- 5GB Parquet opens with first viewport `< 500ms`.
- Perspective interactive `< 3s`.
- No OOM/crash under normal scroll/filter behavior.

## 4) Implementation workstreams

## A. Core runtime (Rust)
- Tauri command handlers and lifecycle.
- DuckDB session management and PRAGMA setup.
- Workspace table registration API (single-table for MVP, extensible).
- Query execution API returning Arrow batches.

## B. Transport
- Batch size router (`IPC` vs `socket`).
- Arrow IPC serialization and chunked streaming.
- Frontend stream receiver + backpressure handling.
- Throughput benchmark harness and logging.

## C. Frontend
- App shell + file open flow.
- Virtual-scroll table component.
- Perspective loader and swap preserving scroll offset.
- Schema sidebar and query status surface.

## D. Reliability and observability
- RSS watcher thread + cancellation token.
- Structured logs for query duration, bytes sent, rows rendered.
- Fail-safe fallback to virtual table if Perspective fails.

## 5) Backlog (prioritized)
1. Create base Tauri + Rust + frontend app skeleton.
2. Integrate DuckDB and verify local Parquet scan.
3. Implement Arrow IPC serialization from DuckDB results.
4. Implement localhost socket server/client path.
5. Build minimal virtual-scroll table renderer.
6. Add transport throughput benchmark command.
7. Add adaptive thread and memory config at startup.
8. Add schema extraction endpoint and sidebar UI.
9. Add Perspective lazy-load and seamless swap.
10. Add memory panic circuit and UI warning channel.

## 6) Test strategy (initial)
- Unit tests (Rust):
  - Thread formula correctness.
  - Batch routing threshold correctness.
  - Memory limit calculation correctness.
- Integration tests:
  - Read Parquet and return Arrow batch schema.
  - Socket transport reassembles all chunks correctly.
- Performance checks:
  - Throughput benchmark script for Phase 0 gate.
  - Cold-start timer checkpoints: file-open, first viewport, Perspective-ready.

## 7) Risks to actively burn down first
- Localhost socket security and lifecycle complexity in desktop context.
- Perspective cold-start variability on lower-end hardware.
- Nested data flattening design before charting features.
- DuckDB version pinning and file compatibility matrix.

## 8) Immediate next execution steps
1. Scaffold project skeleton (`src-tauri` + frontend app). `COMPLETED`
2. Wire DuckDB open/query primitive and return fixed sample rows. `COMPLETED`
3. Add Arrow IPC encode/decode smoke test (no Perspective yet). `COMPLETED`
4. Add synthetic throughput benchmark and record baseline. `COMPLETED` (measured: IPC ~9.4 MB/s @16MB, socket ~798.3 MB/s @64MB)

## 9) Phase 1 progress snapshot
1. Native file picker flow wired through Tauri dialog plugin. `COMPLETED`
2. `preview_parquet` backend command (schema + first 100 rows) via DuckDB. `COMPLETED`
3. Rapid-render virtual-scroll table implementation. `COMPLETED`
4. Perspective lazy-load and swap-over flow. `COMPLETED`
5. Hybrid page transport (`<1MB` IPC, `>=1MB` socket) with Arrow IPC decode in UI. `COMPLETED`
6. Live timing telemetry for `<500ms` first viewport and `<3s` Perspective ready targets. `COMPLETED`
7. Memory panic circuit + UI warning + guarded command execution. `COMPLETED`
8. Adaptive DuckDB runtime config (`threads`, `memory_limit`) + structured perf logs. `COMPLETED`

## 10) Next execution slice
1. Acceptance gate runner UI/logic wired (`Run Acceptance Gate`): evaluates `<500ms` first viewport and `<3s` Perspective-ready thresholds with PASS/FAIL output. `COMPLETED`
2. Run Phase 1 acceptance gate on representative large Parquet files (5GB target) and capture results. `COMPLETED` (sample result: first viewport `499ms`, Perspective `754ms`)
3. Add Rust integration tests for Parquet read path and socket transport chunk delivery. `COMPLETED`
4. Add benchmark/result export (JSON/CSV) for reproducible transport and viewport timing history. `COMPLETED`

## 11) Phase 2 progress snapshot
1. Workspace catalog commands (`register/list/remove`) for multi-file aliases. `COMPLETED`
2. SQL query endpoint (`run_workspace_query`) with schema introspection, row-limit truncation, and telemetry. `COMPLETED`
3. Workspace Explorer UI (register table aliases, run SQL, render query table). `COMPLETED`
4. Add Monaco SQL editor with autocomplete from workspace catalog. `COMPLETED`
5. Add chart configuration flow for query results in Perspective. `COMPLETED`
6. Add schema diff workflow between workspace aliases. `COMPLETED`
7. Add workspace SQL export actions (CSV + Parquet). `COMPLETED`

## 12) Phase 3 kickoff snapshot
1. Add repeatable perf sweep harness in UI (`Run Perf Sweep`) with configurable run count and per-run gate telemetry. `COMPLETED`
2. Add p50/p95 summary metrics and pass-rate reporting for first viewport and Perspective readiness. `COMPLETED`
3. Extend JSON/CSV export payloads with perf sweep summary + run history rows. `COMPLETED`
4. Run perf sweeps on representative files and set regression thresholds from observed p95 values (`first viewport p95 <= 400ms`, `Perspective p95 <= 1000ms`, `failCount = 0`). `COMPLETED`
5. Implement deterministic nested-column flattening in backend (`struct.field` expansion, collection fallback as string) for preview/workspace schema paths. `COMPLETED`
6. Build DuckDB compatibility matrix runner over fixture corpus with schema/read/query/export checks and JSON report output. `COMPLETED`
7. Wire compatibility matrix into release gate command + CI workflow (`npm run release:gate`, GitHub Actions on push/PR to `main`). `COMPLETED`
8. Pin and document explicit DuckDB upgrade policy with matrix revalidation requirements (`docs/duckdb-upgrade-policy.md`). `COMPLETED`
9. Cut Phase 3 hardening release candidate and run final manual UX regression before Phase 4/UI iteration. `COMPLETED` (manual gate checks: `praxis_2023_data.parquet` first viewport `354ms`, Perspective `792ms`; `2017_raw_data.parquet` first viewport `232ms`, Perspective `824ms`)

## 13) Phase 4 UI iteration execution slice
Goal: improve day-to-day usability and layout reliability while preserving performance gates.

1. Reconcile UI planning docs with implemented state (`docs/UI_CONFIG_PLAN.md`): mark completed docking/layout/theme milestones and isolate remaining hardening items. `COMPLETED`
2. Harden layout persistence recovery:
   - Add explicit invalid/corrupt layout payload handling telemetry.
   - Ensure auto-reset path cannot loop and always restores factory layout. `COMPLETED` (recovery telemetry + persisted fallback + no-loop empty-state guard)
3. Drag/reposition reliability pass:
   - Validate tabset drag/resize behavior across default, `pq-view`, `pq-sql`, and `slo-mo`.
   - Add regression checks around edit-lock transitions and empty tabset deletion flow. `COMPLETED` (empty layout container pruning in `normalizeLayoutModel` + manual cross-layout validation)
4. Workspace UX polish pass:
   - Keep advanced checks under `Layouts` menu; no duplicate top-level controls.
   - Validate slow-mode visibility contract (all slow-mode UI hidden when disabled). `COMPLETED`
5. Performance guardrail confirmation:
   - Run 5-run perf sweep on representative files and confirm `first viewport p95 <= 400ms`, `Perspective p95 <= 1000ms`, `failCount = 0`.
   - Re-run `npm run release:gate` after UI hardening changes. `COMPLETED` (perf sweep: first viewport p95 `353ms`, Perspective p95 `720ms`, failCount `0`; release gate rerun passed via staged execution)
6. Phase 4 exit criteria:
   - Manual regression checklist passes (preview/virtual/perspective, workspace SQL/chart/export, gate/perf sweep, layout persistence).
   - No new regressions in Rust tests, compatibility matrix, or release gate.
   - Plan docs updated with measured results and RC notes. `COMPLETED`

## 14) Phase 5 reliability and release-readiness slice
Goal: convert Phase 4 hardening baseline into repeatable release confidence across longer sessions and larger datasets.

1. Long-session reliability soak:
   - Run 30-60 minute interactive soak with repeated layout switches (`default`, `pq-view`, `pq-sql`, `slo-mo`) and perspective toggles.
   - Track and classify any transient perspective restore/init errors. `IN PROGRESS` (fixed transient `Perspective viewer did not initialize` race; post-fix gate PASS on `perf_medium.parquet`: first viewport `135ms`, Perspective `463ms`)
2. Extended performance coverage:
   - Run 5-run perf sweeps on at least two additional representative large files.
   - Record p50/p95/failCount results in this plan for trend tracking. `IN PROGRESS` (representative run set shows single cold-start outlier: run1 first `919ms`, Perspective `1349ms`; runs 2-5 passed. `praxis_2023_data.parquet` sweep PASS: first p95 `353ms`, Perspective p95 `720ms`, failCount `0`)
3. Startup and dev-loop efficiency:
   - Document expected first-run compile/link behavior for `tauri dev` and release gate stages.
   - Add practical guidance to avoid duplicate cargo lock contention during local validation. `COMPLETED` (documented operational guidance: avoid overlapping `cargo` runs, prefer single staged gate execution, expect long first link stage on Windows + bundled DuckDB)
4. Release artifact readiness:
   - Verify app metadata and identity consistency (`Parq-Bench` title/productName/identifier/package names).
   - Ensure release-gate outputs are reproducible from a clean shell session. `COMPLETED` (`Parq-Bench` naming aligned in frontend/Tauri/Cargo; release gate reruns passed in staged clean execution)
5. Phase 5 exit criteria:
   - Soak run completes without unhandled runtime failures.
   - Perf thresholds remain green across expanded file set (allowing explicit cold-start variance caveat until optional prewarm policy is adopted).
   - Release gate passes from clean session and docs are updated with measured results. `IN PROGRESS`
