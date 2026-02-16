# UI Config Plan (Docking + Named Layouts + Dark Mode)

## Status Snapshot (February 16, 2026)
- Docking, named layouts, and theme controls are implemented in the app.
- This document now tracks completion status vs. remaining UI hardening work.

## Scope
Implement a configurable UI with:
- Drag/drop docking
- Resizable split panes
- Saved named layouts
- Dark mode (`System`, `Light`, `Dark`)

## Decisions Confirmed
- Persistence: local-only
- Core panel closure: disallow closing core panels
- Theme behavior: follow system by default, allow user override
- Layout scope: global (not per-file/per-workspace)

## Architecture
- Docking engine: `flexlayout-react`
- Persistence: `localStorage` keys:
  - `parqbench.ui.layouts.v1`
  - `parqbench.ui.theme_mode`
  - `parqbench.ui.layout_edit_enabled`
  - `parqbench.ui.workspace_slow_mode_enabled`
- Theme: CSS tokens + `data-theme` on root + FlexLayout combined theme classes
- Panel registry: component factory keyed by panel id (`actions`, `preview`, `workspace`, `diagnostics`)

## Data Model
```ts
type ThemeMode = "system" | "light" | "dark";

type SavedLayout = {
  id: string;
  name: string;
  model: IJsonModel;
};

type StoredLayoutPrefs = {
  version: 1;
  active_layout_id: string;
  layouts: SavedLayout[];
};
```

Primary storage key: `parqbench.ui.layouts.v1`

## Phase Breakdown

### Phase 1: Panel Extraction (Foundation)
- [x] Extract current render into panel components/functions:
  - [x] Actions panel
  - [x] Preview panel
  - [x] Workspace panel
  - [x] Diagnostics panel
- [x] Keep all existing behavior unchanged.
- [x] Add panel registry abstraction for later docking factory.

### Phase 2: Docking Shell
- [x] Add `flexlayout-react` dependency.
- [x] Add default model with 4 panels:
  - [x] Actions (top)
  - [x] Preview (left)
  - [x] Workspace (right)
  - [x] Diagnostics (bottom)
- [x] Wire factory rendering from registry.
- [x] Enable drag/drop + split resize.
- [x] Mark core tabs non-closable:
  - [x] Actions
  - [x] Preview
  - [x] Workspace

### Phase 3: Named Layout Management
- [x] Add layout manager controls:
  - [x] Active layout select
  - [x] Save As
  - [x] Rename
  - [x] Duplicate
  - [x] Delete
  - [x] Reset to default
- [x] Persist model changes to active layout.
- [x] Persist prefs to `localStorage`.
- [x] Add migration guard/fallback for invalid prefs.

### Phase 4: Dark Mode
- [x] Add theme selector (`System`, `Light`, `Dark`).
- [x] Implement system-follow mode via `matchMedia`.
- [x] Add root token sets:
  - [x] `:root[data-theme="light"]`
  - [x] `:root[data-theme="dark"]`
- [x] Style FlexLayout host for light/dark theme classes.
- [x] Validate Monaco + Perspective readability in both themes.

### Phase 5: Hardening and Regression
- [x] Corrupt/invalid local prefs recovery path.
- [ ] Ensure Perspective lifecycle remains stable while moving panels across all custom layouts and long-running sessions.
- [ ] Regression checks:
  - [x] Open Parquet / virtual / perspective
  - [x] Workspace SQL / chart / exports
  - [x] Gate / Perf sweep
- [x] Build + release gate verification.

## Remaining Hardening Focus
- Complete extended drag/resize + Perspective lifecycle soak tests across `default`, `pq-view`, `pq-sql`, and `slo-mo`.
- Re-run perf sweeps after UI changes and keep regression thresholds green (`first viewport p95 <= 400ms`, `Perspective p95 <= 1000ms`, `failCount = 0`).
- Keep release gate clean after each UI hardening batch.

## Risks and Mitigations
- Risk: Single Perspective viewer/table lifecycle with dock moves.
  - Mitigation: Keep one authoritative viewer/table owner, guard table delete/load ordering.
- Risk: Corrupt layout JSON can brick UI.
  - Mitigation: schema/version checks + auto-reset to default layout.
- Risk: Dark mode contrast regressions in third-party surfaces.
  - Mitigation: explicit token overrides for Perspective and Monaco container surfaces.

## Acceptance Criteria
- Users can drag tabs between regions and resize splitters.
- Users can save and switch named layouts; last active layout restores on launch.
- Core panels cannot be closed.
- Theme follows OS in `System` mode; user override persists.
- Existing preview/workspace/gate/chart behavior remains functional.
