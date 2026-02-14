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
