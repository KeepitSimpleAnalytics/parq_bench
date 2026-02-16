import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { Actions, Layout, Model, type Action, type IJsonModel, type TabNode } from "flexlayout-react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { tableFromIPC } from "apache-arrow";
import type * as Monaco from "monaco-editor";
import "flexlayout-react/style/combined.css";
import "./App.css";

const PAGE_SIZE = 256;
const ROW_HEIGHT = 30;
const MIN_VIEWPORT_HEIGHT = 320;
const OVERSCAN = 8;
const PERSPECTIVE_MAX_ROWS = 5000;
const COLUMN_WIDTH = 180;
const FIRST_VIEWPORT_TARGET_MS = 500;
const PERSPECTIVE_READY_TARGET_MS = 3000;
const ACCEPTANCE_GATE_TIMEOUT_MS = 15000;
const PERSPECTIVE_RESTORE_TIMEOUT_DEFAULT_MS = 8000;
const PERSPECTIVE_RESTORE_TIMEOUT_CHART_MS = 20000;
const PERF_SWEEP_MIN_RUNS = 2;
const PERF_SWEEP_MAX_RUNS = 25;
const PERF_SWEEP_DEFAULT_RUNS = 5;

type SmokeRow = {
  id: number;
  label: string;
};

type SmokeQueryResponse = {
  duckdb_version: string;
  rows: SmokeRow[];
};

type ArrowRow = {
  id: number;
  label: string;
};

type SocketServerInfo = {
  url: string;
  payload_bytes: number;
};

type BenchmarkResult = {
  mode: "ipc" | "socket";
  sizeMb: number;
  bytes: number;
  elapsedMs: number;
  throughputMbps: number;
};

type RuntimeHealth = {
  memory_guard_tripped: boolean;
  process_rss_bytes: number;
  total_memory_bytes: number;
  usage_ratio: number;
  message: string | null;
};

type PreviewColumn = {
  name: string;
  duckdb_type: string;
};

type PreviewResponse = {
  file_path: string;
  file_size_bytes: number;
  total_rows: number;
  row_offset: number;
  row_limit: number;
  schema: PreviewColumn[];
  rows: Array<Array<string | null>>;
};

type ParquetRowsTransport = {
  mode: "ipc" | "socket";
  payload_bytes: number;
  ipc_payload: number[] | null;
  socket_url: string | null;
  row_offset: number;
  row_limit: number;
  row_count: number;
};

type ViewMode = "virtual" | "perspective";
type PerspectiveStatus = "idle" | "loading" | "ready" | "error";
type PerspectiveContext = "preview" | "workspace";
type GatePerspectiveStatus = "ready" | "error" | "timeout";

type AcceptanceGateReport = {
  filePath: string;
  evaluatedAt: string;
  firstViewportMs: number | null;
  perspectiveReadyMs: number | null;
  firstViewportPass: boolean;
  perspectivePass: boolean;
  perspectiveStatus: GatePerspectiveStatus;
  passed: boolean;
  details: string;
};

type PerfSweepSummary = {
  filePath: string;
  evaluatedAt: string;
  runCount: number;
  completedRuns: number;
  passCount: number;
  failCount: number;
  firstViewportP50: number | null;
  firstViewportP95: number | null;
  perspectiveReadyP50: number | null;
  perspectiveReadyP95: number | null;
  perspectiveReadySamples: number;
  runs: AcceptanceGateReport[];
};

type WorkspaceTableInfo = {
  alias: string;
  file_path: string;
  is_glob: boolean;
  source_kind: "parquet" | "delimited";
  delimiter: string | null;
  file_size_bytes: number | null;
};

type WorkspaceSchemaByAlias = Record<string, PreviewColumn[]>;
type WorkspaceSourceKind = "parquet" | "delimited";

type WorkspaceQueryResponse = {
  sql: string;
  row_limit: number;
  row_count: number;
  truncated: boolean;
  elapsed_ms: number;
  schema: PreviewColumn[];
  rows: Array<Array<string | null>>;
};

type WorkspaceChartPlugin = "Datagrid" | "Y Bar" | "X Bar" | "Y Line" | "Treemap";

type WorkspaceSchemaDiffColumn = {
  name: string;
  left_type: string | null;
  right_type: string | null;
  change: "added" | "removed" | "type_changed" | "unchanged";
};

type WorkspaceSchemaDiffResponse = {
  left_alias: string;
  right_alias: string;
  added_count: number;
  removed_count: number;
  type_changed_count: number;
  unchanged_count: number;
  columns: WorkspaceSchemaDiffColumn[];
};

type WorkspaceExportResponse = {
  sql: string;
  format: "csv" | "parquet";
  output_path: string;
  file_size_bytes: number;
  elapsed_ms: number;
};

type ExportPayload = {
  exported_at: string;
  targets: {
    first_viewport_ms: number;
    perspective_ready_ms: number;
  };
  acceptance_gate: AcceptanceGateReport | null;
  benchmarks: BenchmarkResult[];
  latest_view: {
    file_path: string | null;
    first_viewport_ms: number | null;
    perspective_ready_ms: number | null;
    perspective_status: PerspectiveStatus;
    perspective_stage: string;
  };
  workspace: {
    table_count: number;
    tables: WorkspaceTableInfo[];
    last_query: WorkspaceQueryResponse | null;
    last_schema_diff: WorkspaceSchemaDiffResponse | null;
  };
  perf_sweep: PerfSweepSummary | null;
};

type ThemeMode = "system" | "light" | "dark";
type ResolvedTheme = "light" | "dark";
type DockPanelComponent = "actions" | "preview" | "workspace" | "diagnostics";
type ImportedLayoutPreview = {
  sourceFile: string;
  name: string;
  model: IJsonModel;
  tabCount: number;
  panelCounts: Array<{ component: string; count: number }>;
  unknownPanels: string[];
};
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

const UI_THEME_STORAGE_KEY = "parqbench.ui.theme_mode";
const UI_LAYOUT_STORAGE_KEY = "parqbench.ui.layouts.v1";
const UI_LAYOUT_RECOVERY_STORAGE_KEY = "parqbench.ui.layouts.recovery.v1";
const UI_LAYOUT_EDIT_STORAGE_KEY = "parqbench.ui.layout_edit_enabled";
const UI_WORKSPACE_SLOW_MODE_STORAGE_KEY = "parqbench.ui.workspace_slow_mode_enabled";
const DEFAULT_LAYOUT_ID = "default";
const PQ_VIEW_LAYOUT_ID = "pq_view";
const PQ_SQL_LAYOUT_ID = "pq_sql";
const SLO_MO_LAYOUT_ID = "slo_mo";

const DEFAULT_LAYOUT_MODEL: IJsonModel = {
  global: {
    rootOrientationVertical: true,
    tabSetEnableClose: false,
    tabSetEnableDeleteWhenEmpty: true,
    tabSetEnableDrag: true,
    tabSetEnableDrop: true,
    tabSetEnableDivide: true,
    tabSetEnableSingleTabStretch: false,
    tabSetEnableTabStrip: true,
    tabEnableClose: false,
    tabEnableDrag: true,
    tabEnablePopout: false,
    tabEnableRenderOnDemand: false,
  },
  borders: [],
  layout: {
    type: "row",
    children: [
      {
        type: "tabset",
        weight: 16,
        enableClose: false,
        enableDeleteWhenEmpty: true,
        enableMaximize: false,
        children: [{ type: "tab", component: "actions", name: "Actions", enableClose: false, enableDrag: true }],
      },
      {
        type: "tabset",
        weight: 40,
        enableClose: false,
        enableDeleteWhenEmpty: true,
        children: [{ type: "tab", component: "preview", name: "Preview", enableClose: false }],
      },
      {
        type: "tabset",
        weight: 30,
        enableClose: false,
        enableDeleteWhenEmpty: true,
        children: [{ type: "tab", component: "workspace", name: "Workspace", enableClose: false }],
      },
      {
        type: "tabset",
        weight: 14,
        enableDeleteWhenEmpty: true,
        children: [{ type: "tab", component: "diagnostics", name: "Diagnostics", enableClose: true }],
      },
    ],
  },
};

const PQ_VIEW_LAYOUT_MODEL: IJsonModel = {
  global: {
    rootOrientationVertical: true,
    tabSetEnableClose: false,
    tabSetEnableDeleteWhenEmpty: true,
    tabSetEnableDrag: true,
    tabSetEnableDrop: true,
    tabSetEnableDivide: true,
    tabSetEnableSingleTabStretch: false,
    tabSetEnableTabStrip: true,
    tabEnableClose: false,
    tabEnableDrag: true,
    tabEnablePopout: false,
    tabEnableRenderOnDemand: false,
  },
  borders: [],
  layout: {
    type: "row",
    children: [
      {
        type: "tabset",
        weight: 18,
        enableClose: false,
        enableDeleteWhenEmpty: true,
        enableMaximize: false,
        children: [{ type: "tab", component: "actions", name: "Actions", enableClose: false, enableDrag: true }],
      },
      {
        type: "tabset",
        weight: 68,
        enableClose: false,
        enableDeleteWhenEmpty: true,
        children: [{ type: "tab", component: "preview", name: "Preview", enableClose: false }],
      },
      {
        type: "tabset",
        weight: 14,
        enableDeleteWhenEmpty: true,
        children: [{ type: "tab", component: "diagnostics", name: "Diagnostics", enableClose: true }],
      },
    ],
  },
};

const PQ_SQL_LAYOUT_MODEL: IJsonModel = {
  global: {
    rootOrientationVertical: true,
    tabSetEnableClose: false,
    tabSetEnableDeleteWhenEmpty: true,
    tabSetEnableDrag: true,
    tabSetEnableDrop: true,
    tabSetEnableDivide: true,
    tabSetEnableSingleTabStretch: false,
    tabSetEnableTabStrip: true,
    tabEnableClose: false,
    tabEnableDrag: true,
    tabEnablePopout: false,
    tabEnableRenderOnDemand: false,
  },
  borders: [],
  layout: {
    type: "row",
    children: [
      {
        type: "tabset",
        weight: 16,
        enableClose: false,
        enableDeleteWhenEmpty: true,
        enableMaximize: false,
        children: [{ type: "tab", component: "actions", name: "Actions", enableClose: false, enableDrag: true }],
      },
      {
        type: "tabset",
        weight: 68,
        enableClose: false,
        enableDeleteWhenEmpty: true,
        children: [{ type: "tab", component: "workspace", name: "Workspace", enableClose: false }],
      },
      {
        type: "tabset",
        weight: 16,
        enableDeleteWhenEmpty: true,
        children: [{ type: "tab", component: "diagnostics", name: "Diagnostics", enableClose: true }],
      },
    ],
  },
};

const SLO_MO_LAYOUT_MODEL: IJsonModel = {
  global: {
    rootOrientationVertical: true,
    tabSetEnableClose: false,
    tabSetEnableDeleteWhenEmpty: true,
    tabSetEnableDrag: true,
    tabSetEnableDrop: true,
    tabSetEnableDivide: true,
    tabSetEnableSingleTabStretch: false,
    tabSetEnableTabStrip: true,
    tabEnableClose: false,
    tabEnableDrag: true,
    tabEnablePopout: false,
    tabEnableRenderOnDemand: false,
  },
  borders: [],
  layout: {
    type: "row",
    children: [
      {
        type: "tabset",
        weight: 100,
        enableClose: false,
        enableDeleteWhenEmpty: true,
        children: [{ type: "tab", component: "workspace", name: "Workspace", enableClose: false }],
      },
    ],
  },
};

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function pruneEmptyLayoutNode(node: unknown): Record<string, unknown> | null {
  if (!isRecord(node)) {
    return null;
  }

  if (Array.isArray(node.children)) {
    const children = node.children
      .map((child) => pruneEmptyLayoutNode(child))
      .filter((child): child is Record<string, unknown> => child !== null);
    node.children = children;
  }

  if (node.type === "tabset") {
    return Array.isArray(node.children) && node.children.length > 0 ? node : null;
  }

  if (node.type === "row" || node.type === "column") {
    return Array.isArray(node.children) && node.children.length > 0 ? node : null;
  }

  return node;
}

function normalizeLayoutModel(model: IJsonModel): IJsonModel {
  const normalized = cloneJson(model);
  const globalAttrs = (isRecord(normalized.global) ? normalized.global : {}) as Record<string, unknown>;
  globalAttrs.tabSetEnableDeleteWhenEmpty = true;
  globalAttrs.tabSetEnableDrag = true;
  globalAttrs.tabSetEnableDrop = true;
  globalAttrs.tabSetEnableDivide = true;
  globalAttrs.tabSetEnableSingleTabStretch = false;
  globalAttrs.tabSetEnableTabStrip = true;
  globalAttrs.tabEnableDrag = true;
  normalized.global = globalAttrs;

  const walk = (node: unknown) => {
    if (!isRecord(node)) {
      return;
    }
    if (node.type === "tabset") {
      node.enableDeleteWhenEmpty = true;
      node.enableDrag = true;
      node.enableDrop = true;
      node.enableDivide = true;
      node.enableTabStrip = true;
    } else if (node.type === "tab" && typeof node.component === "string") {
      node.enableDrag = true;
    }
    if (Array.isArray(node.children)) {
      node.children.forEach(walk);
    }
  };

  const normalizedLayout = pruneEmptyLayoutNode(normalized.layout);
  normalized.layout = (normalizedLayout ?? cloneJson(DEFAULT_LAYOUT_MODEL.layout)) as IJsonModel["layout"];
  walk(normalized.layout);
  if (Array.isArray(normalized.borders)) {
    const nextBorders = normalized.borders
      .map((border) => pruneEmptyLayoutNode(border))
      .filter((border): border is Record<string, unknown> => border !== null);
    (normalized as unknown as { borders: unknown[] }).borders = nextBorders;
    nextBorders.forEach(walk);
  }

  return normalized;
}

function buildFactoryLayouts(): SavedLayout[] {
  return [
    {
      id: DEFAULT_LAYOUT_ID,
      name: "Default",
      model: normalizeLayoutModel(DEFAULT_LAYOUT_MODEL),
    },
    {
      id: PQ_VIEW_LAYOUT_ID,
      name: "pq-view",
      model: normalizeLayoutModel(PQ_VIEW_LAYOUT_MODEL),
    },
    {
      id: PQ_SQL_LAYOUT_ID,
      name: "pq-sql",
      model: normalizeLayoutModel(PQ_SQL_LAYOUT_MODEL),
    },
    {
      id: SLO_MO_LAYOUT_ID,
      name: "slo-mo",
      model: normalizeLayoutModel(SLO_MO_LAYOUT_MODEL),
    },
  ];
}

function mergeFactoryLayouts(layouts: SavedLayout[]): SavedLayout[] {
  const factory = buildFactoryLayouts();
  const factoryIds = new Set(factory.map((layout) => layout.id));
  const byId = new Map(layouts.map((layout) => [layout.id, layout]));
  const mergedFactory = factory.map((layout) => byId.get(layout.id) ?? layout);
  const custom = layouts.filter((layout) => !factoryIds.has(layout.id));
  return [...mergedFactory, ...custom];
}

function defaultLayoutPrefs(): StoredLayoutPrefs {
  return {
    version: 1,
    active_layout_id: DEFAULT_LAYOUT_ID,
    layouts: buildFactoryLayouts(),
  };
}

function recordLayoutRecovery(reason: string, detail: string) {
  if (typeof window === "undefined") {
    return;
  }
  const event = {
    at: new Date().toISOString(),
    reason,
    detail,
  };
  try {
    window.localStorage.setItem(UI_LAYOUT_RECOVERY_STORAGE_KEY, JSON.stringify(event));
  } catch {
    // Ignore storage write failures and keep runtime functional.
  }
  console.warn(`[Parq-Bench][layout-recovery] ${reason}: ${detail}`);
}

function persistLayoutPrefs(prefs: StoredLayoutPrefs) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(UI_LAYOUT_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage write failures and keep runtime functional.
  }
}

function canHydrateLayoutModel(model: IJsonModel): boolean {
  try {
    Model.fromJson(cloneJson(model));
    return true;
  } catch {
    return false;
  }
}

function recoverDefaultLayoutPrefs(reason: string, detail: string): StoredLayoutPrefs {
  const fallback = defaultLayoutPrefs();
  recordLayoutRecovery(reason, detail);
  persistLayoutPrefs(fallback);
  return fallback;
}

function readLayoutPrefs(): StoredLayoutPrefs {
  if (typeof window === "undefined") {
    return defaultLayoutPrefs();
  }
  const raw = window.localStorage.getItem(UI_LAYOUT_STORAGE_KEY);
  if (!raw) {
    return defaultLayoutPrefs();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredLayoutPrefs>;
    if (parsed.version !== 1 || !Array.isArray(parsed.layouts) || parsed.layouts.length === 0) {
      return recoverDefaultLayoutPrefs(
        "invalid_layout_prefs_shape",
        "Stored layout payload failed version/layout list validation.",
      );
    }
    const normalizedLayouts = parsed.layouts
      .filter(
        (layout): layout is SavedLayout =>
          typeof layout.id === "string" &&
          layout.id.trim().length > 0 &&
          typeof layout.name === "string" &&
          layout.name.trim().length > 0 &&
          typeof layout.model === "object" &&
          layout.model !== null,
      )
      .map((layout) => ({
        ...layout,
        model: normalizeLayoutModel(layout.model),
      }));
    const layouts = normalizedLayouts.filter((layout) => canHydrateLayoutModel(layout.model));
    if (layouts.length !== normalizedLayouts.length) {
      recordLayoutRecovery(
        "dropped_invalid_layout_models",
        `Dropped ${normalizedLayouts.length - layouts.length} saved layout(s) due to invalid model JSON.`,
      );
    }
    if (layouts.length === 0) {
      return recoverDefaultLayoutPrefs(
        "no_valid_layout_models",
        "No persisted layouts could be hydrated into runtime layout models.",
      );
    }
    const mergedLayouts = mergeFactoryLayouts(layouts);
    const active = mergedLayouts.some((layout) => layout.id === parsed.active_layout_id)
      ? (parsed.active_layout_id as string)
      : DEFAULT_LAYOUT_ID;
    if (active !== parsed.active_layout_id) {
      recordLayoutRecovery(
        "invalid_active_layout_id",
        "Active layout id missing; reset active layout to default.",
      );
    }
    return {
      version: 1,
      active_layout_id: active,
      layouts: mergedLayouts,
    };
  } catch (err) {
    return recoverDefaultLayoutPrefs(
      "layout_prefs_parse_error",
      `Failed to parse persisted layout payload: ${String(err)}`,
    );
  }
}

function nextLayoutId(): string {
  return `layout_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isJsonModel(value: unknown): value is IJsonModel {
  return isRecord(value) && isRecord(value.layout);
}

function sanitizeFileName(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9_-]+/g, "_");
  return normalized.length > 0 ? normalized : "layout";
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read layout file."));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsText(file);
  });
}

function parseImportedLayoutPayload(parsed: unknown, fallbackName: string): { name: string; model: IJsonModel } {
  if (!isRecord(parsed)) {
    throw new Error("Unsupported layout file format.");
  }

  const parsedLayout = parsed.layout;
  if (isRecord(parsedLayout) && isJsonModel(parsedLayout.model)) {
    const layout = parsed.layout as Record<string, unknown>;
    const layoutModel = parsedLayout.model;
    return {
      name: typeof layout.name === "string" && layout.name.trim().length > 0 ? layout.name.trim() : fallbackName,
      model: normalizeLayoutModel(layoutModel),
    };
  }

  const parsedModel = parsed.model;
  if (isJsonModel(parsedModel)) {
    return {
      name: typeof parsed.name === "string" && parsed.name.trim().length > 0 ? parsed.name.trim() : fallbackName,
      model: normalizeLayoutModel(parsedModel),
    };
  }

  if (Array.isArray(parsed.layouts)) {
    const list = parsed.layouts.filter(isRecord);
    const chosen =
      list.find((item) => typeof item.id === "string" && item.id === parsed.active_layout_id) ?? list[0];
    const chosenModel = chosen?.model;
    if (!chosen || !isJsonModel(chosenModel)) {
      throw new Error("No valid layout model found.");
    }
    return {
      name: typeof chosen.name === "string" && chosen.name.trim().length > 0 ? chosen.name.trim() : fallbackName,
      model: normalizeLayoutModel(chosenModel),
    };
  }

  if (isJsonModel(parsed)) {
    return {
      name: typeof parsed.name === "string" && parsed.name.trim().length > 0 ? parsed.name.trim() : fallbackName,
      model: normalizeLayoutModel(parsed),
    };
  }

  throw new Error("Unsupported layout file format.");
}

function collectLayoutTabComponents(model: IJsonModel): string[] {
  const components: string[] = [];
  const walk = (node: unknown) => {
    if (!isRecord(node)) {
      return;
    }
    if (node.type === "tab" && typeof node.component === "string") {
      components.push(node.component);
    }
    if (Array.isArray(node.children)) {
      node.children.forEach(walk);
    }
  };
  walk(model.layout);
  if (Array.isArray(model.borders)) {
    model.borders.forEach(walk);
  }
  return components;
}

function readThemeMode(): ThemeMode {
  if (typeof window === "undefined") {
    return "system";
  }
  const value = window.localStorage.getItem(UI_THEME_STORAGE_KEY);
  if (value === "light" || value === "dark" || value === "system") {
    return value;
  }
  return "system";
}

function readLayoutEditEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.localStorage.getItem(UI_LAYOUT_EDIT_STORAGE_KEY) === "1";
}

function readWorkspaceSlowModeEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.localStorage.getItem(UI_WORKSPACE_SLOW_MODE_STORAGE_KEY) === "1";
}

function resolveThemeMode(mode: ThemeMode): ResolvedTheme {
  if (mode === "light" || mode === "dark") {
    return mode;
  }
  if (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

function formatWorkspaceDelimiter(value: string | null): string {
  if (value === null) {
    return "auto";
  }
  if (value === "\t") {
    return "\\t";
  }
  if (value === "\n") {
    return "\\n";
  }
  if (value === "\r") {
    return "\\r";
  }
  return value;
}

function appendGlobPattern(folderPath: string, pattern: string): string {
  const trimmed = folderPath.trim();
  if (trimmed.length === 0) {
    return pattern;
  }
  if (trimmed.endsWith("\\") || trimmed.endsWith("/")) {
    return `${trimmed}${pattern}`;
  }
  const separator = trimmed.includes("\\") ? "\\" : "/";
  return `${trimmed}${separator}${pattern}`;
}

function App() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readThemeMode());
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveThemeMode(readThemeMode()));
  const initialLayoutPrefsRef = useRef<StoredLayoutPrefs | null>(null);
  if (initialLayoutPrefsRef.current === null) {
    initialLayoutPrefsRef.current = readLayoutPrefs();
  }
  const initialLayoutPrefs = initialLayoutPrefsRef.current;
  const initialActiveLayout =
    initialLayoutPrefs.layouts.find((layout) => layout.id === initialLayoutPrefs.active_layout_id) ??
    initialLayoutPrefs.layouts[0];
  const [savedLayouts, setSavedLayouts] = useState<SavedLayout[]>(initialLayoutPrefs.layouts);
  const [activeLayoutId, setActiveLayoutId] = useState<string>(initialActiveLayout.id);
  const [layoutModel, setLayoutModel] = useState<Model>(() => Model.fromJson(cloneJson(initialActiveLayout.model)));
  const [layoutEditEnabled, setLayoutEditEnabled] = useState<boolean>(() => readLayoutEditEnabled());
  const [pendingImportedLayout, setPendingImportedLayout] = useState<ImportedLayoutPreview | null>(null);
  const [pendingImportedName, setPendingImportedName] = useState("");

  const [result, setResult] = useState<SmokeQueryResponse | null>(null);
  const [arrowRows, setArrowRows] = useState<ArrowRow[]>([]);
  const [arrowBytes, setArrowBytes] = useState(0);
  const [benchmarks, setBenchmarks] = useState<BenchmarkResult[]>([]);
  const [runtimeHealth, setRuntimeHealth] = useState<RuntimeHealth | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [loadedRows, setLoadedRows] = useState<Map<number, Array<string | null>>>(new Map());
  const [loadedPages, setLoadedPages] = useState<Set<number>>(new Set());
  const [inFlightPages, setInFlightPages] = useState<Set<number>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(520);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("virtual");
  const [perspectiveStatus, setPerspectiveStatus] = useState<PerspectiveStatus>("idle");
  const [perspectiveStage, setPerspectiveStage] = useState("idle");
  const [perspectiveError, setPerspectiveError] = useState<string | null>(null);
  const [perspectiveContext, setPerspectiveContext] = useState<PerspectiveContext>("preview");
  const [perspectiveLoadedForFile, setPerspectiveLoadedForFile] = useState<string | null>(null);
  const [firstViewportMs, setFirstViewportMs] = useState<number | null>(null);
  const [perspectiveReadyMs, setPerspectiveReadyMs] = useState<number | null>(null);
  const [acceptanceGate, setAcceptanceGate] = useState<AcceptanceGateReport | null>(null);
  const [perfSweepReport, setPerfSweepReport] = useState<PerfSweepSummary | null>(null);
  const [perfSweepRunsInput, setPerfSweepRunsInput] = useState(String(PERF_SWEEP_DEFAULT_RUNS));
  const [lastExportPath, setLastExportPath] = useState<string | null>(null);
  const [workspaceTables, setWorkspaceTables] = useState<WorkspaceTableInfo[]>([]);
  const [workspaceTableSchemas, setWorkspaceTableSchemas] = useState<WorkspaceSchemaByAlias>({});
  const [workspaceAliasInput, setWorkspaceAliasInput] = useState("");
  const [workspacePathInput, setWorkspacePathInput] = useState("");
  const [workspaceIsGlob, setWorkspaceIsGlob] = useState(false);
  const [workspaceSlowModeEnabled, setWorkspaceSlowModeEnabled] = useState<boolean>(
    () => readWorkspaceSlowModeEnabled(),
  );
  const [workspaceSourceKind, setWorkspaceSourceKind] = useState<WorkspaceSourceKind>("parquet");
  const [workspaceDelimiterInput, setWorkspaceDelimiterInput] = useState("");
  const [workspaceEditorReady, setWorkspaceEditorReady] = useState(false);
  const [workspaceSql, setWorkspaceSql] = useState(
    "SELECT * FROM my_table LIMIT 100",
  );
  const [workspaceQueryResult, setWorkspaceQueryResult] = useState<WorkspaceQueryResponse | null>(null);
  const [workspaceChartPlugin, setWorkspaceChartPlugin] = useState<WorkspaceChartPlugin>("Datagrid");
  const [workspaceChartX, setWorkspaceChartX] = useState("");
  const [workspaceChartY, setWorkspaceChartY] = useState("");
  const [workspaceChartAgg, setWorkspaceChartAgg] = useState("sum");
  const [workspaceDiffLeftAlias, setWorkspaceDiffLeftAlias] = useState("");
  const [workspaceDiffRightAlias, setWorkspaceDiffRightAlias] = useState("");
  const [workspaceSchemaDiff, setWorkspaceSchemaDiff] = useState<WorkspaceSchemaDiffResponse | null>(null);
  const [workspaceExport, setWorkspaceExport] = useState<WorkspaceExportResponse | null>(null);
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const perspectiveViewerRef = useRef<HTMLElement | null>(null);
  const perspectiveTableRef = useRef<{ delete?: () => Promise<void> | void } | null>(null);
  const memoryGuardRef = useRef(false);
  const openStartRef = useRef<number | null>(null);
  const perspectiveStatusRef = useRef<PerspectiveStatus>("idle");
  const perspectiveErrorRef = useRef<string | null>(null);
  const perspectiveReadyMsRef = useRef<number | null>(null);
  const previousLayoutIdRef = useRef<string | null>(null);
  const slowModeAutoEnabledByLayoutRef = useRef(false);
  const layoutRecoveryInProgressRef = useRef(false);
  const perspectiveRuntimeInitRef = useRef<Promise<void> | null>(null);
  const perspectiveCoreRef = useRef<any>(null);
  const workspaceEditorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const workspaceMonacoRef = useRef<typeof Monaco | null>(null);
  const workspaceCompletionRef = useRef<Monaco.IDisposable | null>(null);

  async function withTimeout<T>(label: string, promise: Promise<T>, ms = 8000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  async function waitForNextPaint() {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }

  async function sleepMs(ms: number) {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  function clampPerfSweepRuns(input: string): number {
    const parsed = Number.parseInt(input.trim(), 10);
    if (!Number.isFinite(parsed)) {
      return PERF_SWEEP_DEFAULT_RUNS;
    }
    return Math.min(PERF_SWEEP_MAX_RUNS, Math.max(PERF_SWEEP_MIN_RUNS, parsed));
  }

  function percentile(values: number[], fraction: number): number | null {
    if (values.length === 0) {
      return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const clamped = Math.max(0, Math.min(1, fraction));
    const index = (sorted.length - 1) * clamped;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) {
      return sorted[lower];
    }
    const weight = index - lower;
    return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
  }

  function buildFailedGateReport(
    filePath: string,
    message: string,
    fallback?: { firstViewportMs?: number | null; perspectiveReadyMs?: number | null },
  ): AcceptanceGateReport {
    const firstMs = fallback?.firstViewportMs ?? firstViewportMs;
    const perspectiveMs = fallback?.perspectiveReadyMs ?? perspectiveReadyMs;
    return {
      filePath,
      evaluatedAt: new Date().toISOString(),
      firstViewportMs: firstMs ?? null,
      perspectiveReadyMs: perspectiveMs ?? null,
      firstViewportPass: firstMs !== null && firstMs !== undefined && firstMs <= FIRST_VIEWPORT_TARGET_MS,
      perspectivePass: false,
      perspectiveStatus: "error",
      passed: false,
      details: message,
    };
  }

  async function pickParquetFile(): Promise<string | null> {
    const selected = await open({
      title: "Open Parquet File",
      multiple: false,
      filters: [{ name: "Parquet", extensions: ["parquet"] }],
    });

    if (!selected || Array.isArray(selected)) {
      return null;
    }
    return selected;
  }

  async function pickWorkspaceTablePath(): Promise<void> {
    const registrationSourceKind: WorkspaceSourceKind = workspaceSlowModeEnabled ? workspaceSourceKind : "parquet";
    const filters = workspaceSlowModeEnabled
      ? [
          { name: "Parquet", extensions: ["parquet"] },
          { name: "Delimited", extensions: ["csv", "tsv", "txt", "data"] },
        ]
      : [{ name: "Parquet", extensions: ["parquet"] }];
    const selected = await open({
      title: workspaceIsGlob ? "Select Workspace Source Folder" : "Select Workspace Table Source",
      multiple: false,
      directory: workspaceIsGlob,
      filters,
    });
    if (selected && !Array.isArray(selected)) {
      if (workspaceIsGlob) {
        const pattern = registrationSourceKind === "delimited" ? "*.*" : "*.parquet";
        setWorkspacePathInput(appendGlobPattern(selected, pattern));
      } else {
        setWorkspacePathInput(selected);
      }
    }
  }

  async function refreshWorkspaceTables() {
    const tables = await invoke<WorkspaceTableInfo[]>("list_workspace_tables");
    setWorkspaceTables(tables);
    if (tables.length === 0) {
      setWorkspaceTableSchemas({});
      return;
    }

    const schemaResults = await Promise.allSettled(
      tables.map(async (table) => {
        const schema = await invoke<PreviewColumn[]>("describe_workspace_table", {
          alias: table.alias,
        });
        return { alias: table.alias, schema };
      }),
    );

    const nextSchemas: WorkspaceSchemaByAlias = {};
    const schemaErrors: string[] = [];
    schemaResults.forEach((result, index) => {
      if (result.status === "fulfilled") {
        nextSchemas[result.value.alias] = result.value.schema;
        return;
      }
      schemaErrors.push(`Schema unavailable for ${tables[index]?.alias ?? "unknown"}: ${String(result.reason)}`);
    });

    setWorkspaceTableSchemas(nextSchemas);
    if (schemaErrors.length > 0) {
      setError((previous) => previous ?? schemaErrors.join(" | "));
    }
  }

  function readWorkspaceSql(): string {
    const editor = workspaceEditorRef.current;
    if (editor) {
      const text = editor.getValue();
      if (text !== workspaceSql) {
        setWorkspaceSql(text);
      }
      return text;
    }
    return workspaceSql;
  }

  function replaceWorkspaceSql(nextSql: string): void {
    setWorkspaceSql(nextSql);
    const editor = workspaceEditorRef.current;
    if (editor) {
      editor.setValue(nextSql);
    }
  }

  async function registerWorkspaceTable() {
    if (!workspaceAliasInput.trim() || !workspacePathInput.trim()) {
      setError("Workspace alias and file path are required.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const sourceKind: WorkspaceSourceKind = workspaceSlowModeEnabled ? workspaceSourceKind : "parquet";
      const delimiter = sourceKind === "delimited" ? workspaceDelimiterInput.trim() || undefined : undefined;
      await invoke<WorkspaceTableInfo>("register_workspace_table", {
        alias: workspaceAliasInput.trim(),
        filePath: workspacePathInput.trim(),
        isGlob: workspaceIsGlob,
        sourceKind,
        delimiter,
      });
      await refreshWorkspaceTables();
      const alias = workspaceAliasInput.trim();
      if (!readWorkspaceSql().includes(alias)) {
        replaceWorkspaceSql(`SELECT * FROM ${alias} LIMIT 100`);
      }
      setWorkspaceAliasInput("");
      setWorkspacePathInput("");
      setWorkspaceIsGlob(false);
      setWorkspaceSourceKind("parquet");
      setWorkspaceDelimiterInput("");
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function removeWorkspaceTable(alias: string) {
    setLoading(true);
    setError(null);
    try {
      await invoke("remove_workspace_table", { alias });
      await refreshWorkspaceTables();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function runWorkspaceSchemaDiff() {
    if (!workspaceDiffLeftAlias || !workspaceDiffRightAlias) {
      setError("Select two workspace aliases before running schema diff.");
      return;
    }
    if (workspaceDiffLeftAlias === workspaceDiffRightAlias) {
      setError("Select two different workspace aliases for schema diff.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await invoke<WorkspaceSchemaDiffResponse>("diff_workspace_schema", {
        leftAlias: workspaceDiffLeftAlias,
        rightAlias: workspaceDiffRightAlias,
      });
      setWorkspaceSchemaDiff(result);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function exportWorkspaceQuery(format: "csv" | "parquet") {
    const sqlText = readWorkspaceSql();
    if (!sqlText.trim()) {
      setError("Workspace SQL query is required before export.");
      return;
    }

    const nowIso = new Date().toISOString().replace(/[:.]/g, "-");
    const selected = await save({
      title: `Export Workspace Query (${format.toUpperCase()})`,
      defaultPath: `workspace_query_${nowIso}.${format}`,
      filters: [
        {
          name: format.toUpperCase(),
          extensions: [format],
        },
      ],
    });
    if (!selected) {
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await invoke<WorkspaceExportResponse>("export_workspace_query", {
        sql: sqlText,
        outputPath: selected,
        format,
      });
      setWorkspaceExport(result);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function runWorkspaceQuery() {
    const sqlText = readWorkspaceSql();
    if (!sqlText.trim()) {
      setError("Workspace SQL query is required.");
      return;
    }

    await refreshRuntimeHealth();
    if (memoryGuardRef.current) {
      setError("Memory panic circuit is active; workspace query is blocked.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await invoke<WorkspaceQueryResponse>("run_workspace_query", {
        sql: sqlText,
        rowLimit: 200,
      });
      setWorkspaceQueryResult(result);
    } catch (err) {
      const message = String(err);
      if (message.includes("Referenced column")) {
        const availableColumns = Array.from(
          new Set(
            Object.values(workspaceTableSchemas)
              .flat()
              .map((column) => column.name),
          ),
        );
        const sample = availableColumns.slice(0, 18);
        const hint =
          sample.length === 0
            ? ""
            : ` Available columns: ${sample.join(", ")}${availableColumns.length > sample.length ? ", ..." : ""}`;
        setError(`${message}${hint}`);
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  }

  async function visualizeWorkspaceChart() {
    if (!workspaceQueryResult || workspaceQueryResult.rows.length === 0) {
      setError("Run a workspace query with rows before charting.");
      return;
    }

    const dataset = workspaceQueryResult.rows.map((row) => {
      const item: Record<string, string | number | null> = {};
      workspaceQueryResult.schema.forEach((column, index) => {
        item[column.name] = coerceWorkspaceCell(row[index] ?? null, column.duckdb_type);
      });
      return item;
    });

    let restoreConfig: Record<string, unknown> = { plugin: workspaceChartPlugin };
    if (workspaceChartPlugin !== "Datagrid") {
      if (!workspaceChartX || !workspaceChartY) {
        setError("Select X and Y columns for chart visualization.");
        return;
      }
      restoreConfig = {
        plugin: workspaceChartPlugin,
        group_by: [workspaceChartX],
        columns: [workspaceChartY],
        aggregates: {
          [workspaceChartY]: workspaceChartAgg,
        },
      };
    }

    await loadPerspectiveDataset(dataset, restoreConfig, { context: "workspace" });
  }

  const onWorkspaceEditorMount: OnMount = (editor, monaco) => {
    workspaceEditorRef.current = editor;
    workspaceMonacoRef.current = monaco;
    const model = editor.getModel();
    if (model) {
      monaco.editor.setModelLanguage(model, "sql");
    }
    setWorkspaceEditorReady(true);
  };

  function sqlIdentifierInsertText(identifier: string): string {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
      return identifier;
    }
    return `"${identifier.replace(/"/g, "\"\"")}"`;
  }

  function isNumericDuckType(duckType: string): boolean {
    const upper = duckType.toUpperCase();
    return (
      upper.includes("INT") ||
      upper.includes("DECIMAL") ||
      upper.includes("DOUBLE") ||
      upper.includes("FLOAT") ||
      upper.includes("REAL") ||
      upper.includes("HUGEINT")
    );
  }

  function coerceWorkspaceCell(value: string | null, duckType: string): string | number | null {
    if (value === null) {
      return null;
    }
    if (isNumericDuckType(duckType)) {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : null;
    }
    return value;
  }

  function perspectiveRestoreTimeoutMs(restoreConfig: Record<string, unknown>): number {
    const plugin = String(restoreConfig.plugin ?? "");
    if (
      plugin === "Treemap" ||
      plugin === "Y Bar" ||
      plugin === "X Bar" ||
      plugin === "Y Line" ||
      plugin === "Line"
    ) {
      return PERSPECTIVE_RESTORE_TIMEOUT_CHART_MS;
    }
    return PERSPECTIVE_RESTORE_TIMEOUT_DEFAULT_MS;
  }

  async function waitForPerspectiveViewerReady(timeoutMs = 3000): Promise<
    HTMLElement & {
      load: (table: unknown) => Promise<void>;
      restore: (config: unknown) => Promise<void>;
    }
  > {
    const started = performance.now();
    while (performance.now() - started < timeoutMs) {
      const viewer = perspectiveViewerRef.current as
        | (HTMLElement & {
            load?: (table: unknown) => Promise<void>;
            restore?: (config: unknown) => Promise<void>;
          })
        | null;
      if (viewer && typeof viewer.load === "function" && typeof viewer.restore === "function") {
        return viewer as HTMLElement & {
          load: (table: unknown) => Promise<void>;
          restore: (config: unknown) => Promise<void>;
        };
      }
      await waitForNextPaint();
    }
    throw new Error("Perspective viewer did not initialize.");
  }

  async function ensurePerspectiveRuntime(setStage: (stage: string) => void) {
    if (!perspectiveRuntimeInitRef.current) {
      perspectiveRuntimeInitRef.current = (async () => {
        const perspective = await withTimeout("perspective core import", import("@finos/perspective"));
        const perspectiveViewer = await withTimeout(
          "perspective-viewer import",
          import("@finos/perspective-viewer"),
        );
        const perspectiveServerWasmUrl = (
          await withTimeout(
            "perspective-server wasm url",
            import("@finos/perspective/dist/wasm/perspective-server.wasm?url"),
          )
        ).default;
        setStage("core.init_server");
        await withTimeout(
          "perspective init_server()",
          Promise.resolve(perspective.init_server(fetch(perspectiveServerWasmUrl))),
        );
        const viewerWasmUrl = (
          await withTimeout(
            "perspective-viewer wasm url",
            import("@finos/perspective-viewer/dist/wasm/perspective-viewer.wasm?url"),
          )
        ).default;
        setStage("viewer.init_client");
        await withTimeout(
          "perspective-viewer init_client()",
          perspectiveViewer.init_client(fetch(viewerWasmUrl)),
        );
        setStage("datagrid.import");
        await withTimeout(
          "perspective-viewer-datagrid import",
          import("@finos/perspective-viewer-datagrid"),
        );
        setStage("d3fc.import");
        await withTimeout(
          "perspective-viewer-d3fc import",
          import("@finos/perspective-viewer-d3fc"),
        );
        setStage("custom-element");
        await withTimeout(
          "perspective-viewer define",
          customElements.whenDefined("perspective-viewer"),
        );
        perspectiveCoreRef.current = perspective;
      })().catch((err) => {
        perspectiveRuntimeInitRef.current = null;
        throw err;
      });
    }
    await withTimeout("perspective runtime init", perspectiveRuntimeInitRef.current);
  }

  async function loadPerspectiveDataset(
    dataset: Array<Record<string, unknown>>,
    restoreConfig: Record<string, unknown>,
    options?: { loadedForFile?: string; trackOpenTiming?: boolean; context?: PerspectiveContext },
  ) {
    let stage = "runtime";
    setPerspectiveStatus("loading");
    setPerspectiveStage(stage);
    setPerspectiveError(null);

    try {
      if (dataset.length === 0) {
        throw new Error("No rows available to visualize.");
      }
      const targetContext = resolvePerspectiveContext(options?.context);
      if (!targetContext) {
        throw new Error("Perspective viewer unavailable in current layout. Add Preview or Workspace tab.");
      }
      if (perspectiveContext !== targetContext) {
        setPerspectiveContext(targetContext);
        await waitForNextPaint();
      }

      await ensurePerspectiveRuntime((next) => {
        stage = next;
        setPerspectiveStage(next);
      });

      const perspective = perspectiveCoreRef.current;
      if (!perspective) {
        throw new Error("Perspective runtime is unavailable after initialization.");
      }

      stage = "viewer.ready";
      setPerspectiveStage(stage);
      const viewer = await withTimeout("viewer.ready()", waitForPerspectiveViewerReady(), 5000);

      const previousTable = perspectiveTableRef.current;

      stage = "worker";
      setPerspectiveStage(stage);
      const worker: any = await withTimeout("perspective worker()", perspective.worker());
      stage = "table";
      setPerspectiveStage(stage);
      const table = await withTimeout("worker.table()", worker.table(dataset));
      perspectiveTableRef.current = table as { delete?: () => Promise<void> | void };
      stage = "viewer.load";
      setPerspectiveStage(stage);
      await withTimeout("viewer.load()", viewer.load(table));
      stage = "viewer.restore";
      setPerspectiveStage(stage);
      const restoreTimeoutMs = perspectiveRestoreTimeoutMs(restoreConfig);
      try {
        await withTimeout("viewer.restore()", viewer.restore(restoreConfig), restoreTimeoutMs);
      } catch (restoreErr) {
        const restoreMessage = String(restoreErr);
        if (!restoreMessage.includes("View not found")) {
          throw restoreErr;
        }
        stage = "viewer.restore.retry";
        setPerspectiveStage(stage);
        await waitForNextPaint();
        await withTimeout("viewer.restore(retry)", viewer.restore(restoreConfig), restoreTimeoutMs);
      }
      if (previousTable?.delete) {
        try {
          await previousTable.delete();
        } catch (cleanupErr) {
          const message = String(cleanupErr);
          if (!message.includes("Cannot delete table with views")) {
            throw cleanupErr;
          }
        }
      }

      setPerspectiveStatus("ready");
      setPerspectiveStage("ready");
      if (options?.loadedForFile) {
        setPerspectiveLoadedForFile(options.loadedForFile);
      }
      if (options?.trackOpenTiming && openStartRef.current !== null) {
        setPerspectiveReadyMs(performance.now() - openStartRef.current);
      }
      setViewMode("perspective");
    } catch (err) {
      const plugin = String(restoreConfig.plugin ?? "");
      const timeoutHint =
        stage === "viewer.restore" && String(err).includes("timed out")
          ? ` Try a lower-cardinality X column or reduce row count before using ${plugin}.`
          : "";
      setPerspectiveStatus("error");
      setPerspectiveStage("error");
      setPerspectiveError(`stage=${stage} ${String(err)}${timeoutHint}`);
      setError(`Perspective error: stage=${stage} ${String(err)}${timeoutHint}`);
      setViewMode("virtual");
    }
  }

  async function loadPreviewFromPath(filePath: string): Promise<number> {
    openStartRef.current = performance.now();
    perspectiveStatusRef.current = "idle";
    perspectiveReadyMsRef.current = null;
    perspectiveErrorRef.current = null;
    setFirstViewportMs(null);
    setPerspectiveReadyMs(null);

    const data = await invoke<PreviewResponse>("preview_parquet", {
      filePath,
      rowLimit: PAGE_SIZE,
    });
    setPreview(data);
    setPerspectiveContext("preview");
    setViewMode("virtual");
    setPerspectiveStatus("idle");
    setPerspectiveStage("idle");
    setPerspectiveError(null);
    setPerspectiveLoadedForFile(null);
    setScrollTop(0);
    setScrollLeft(0);
    setLoadedPages(new Set([0]));
    setInFlightPages(new Set());
    setLoadedRows(() => {
      const next = new Map<number, Array<string | null>>();
      data.rows.forEach((row, idx) => next.set(data.row_offset + idx, row));
      return next;
    });

    await waitForNextPaint();
    const elapsed = openStartRef.current === null ? 0 : performance.now() - openStartRef.current;
    setFirstViewportMs(elapsed);
    return elapsed;
  }

  async function waitForPerspectiveResult(timeoutMs: number): Promise<{
    status: GatePerspectiveStatus;
    readyMs: number | null;
    error: string | null;
  }> {
    const started = performance.now();
    while (performance.now() - started < timeoutMs) {
      const status = perspectiveStatusRef.current;
      if (status === "ready") {
        const readyMs = perspectiveReadyMsRef.current;
        if (readyMs !== null) {
          return { status: "ready", readyMs, error: null };
        }
      }
      if (status === "error") {
        return {
          status: "error",
          readyMs: perspectiveReadyMsRef.current,
          error: perspectiveErrorRef.current,
        };
      }
      await sleepMs(100);
    }
    return { status: "timeout", readyMs: perspectiveReadyMsRef.current, error: "Perspective timeout" };
  }

  async function refreshRuntimeHealth() {
    const health = await invoke<RuntimeHealth>("runtime_health");
    setRuntimeHealth(health);
    memoryGuardRef.current = health.memory_guard_tripped;
  }

  function buildExportPayload(exportedAt: string): ExportPayload {
    return {
      exported_at: exportedAt,
      targets: {
        first_viewport_ms: FIRST_VIEWPORT_TARGET_MS,
        perspective_ready_ms: PERSPECTIVE_READY_TARGET_MS,
      },
      acceptance_gate: acceptanceGate,
      benchmarks,
      latest_view: {
        file_path: preview?.file_path ?? null,
        first_viewport_ms: firstViewportMs,
        perspective_ready_ms: perspectiveReadyMs,
        perspective_status: perspectiveStatus,
        perspective_stage: perspectiveStage,
      },
      workspace: {
        table_count: workspaceTables.length,
        tables: workspaceTables,
        last_query: workspaceQueryResult,
        last_schema_diff: workspaceSchemaDiff,
      },
      perf_sweep: perfSweepReport,
    };
  }

  function escapeCsvCell(value: string): string {
    if (value.includes(",") || value.includes("\"") || value.includes("\n")) {
      return `"${value.replace(/"/g, "\"\"")}"`;
    }
    return value;
  }

  function buildExportCsv(payload: ExportPayload): string {
    const rows: string[] = [];
    rows.push(
      [
        "category",
        "timestamp",
        "file_path",
        "mode",
        "size_mb",
        "bytes",
        "elapsed_ms",
        "throughput_mb_s",
        "first_viewport_ms",
        "first_viewport_target_ms",
        "first_viewport_pass",
        "perspective_ready_ms",
        "perspective_target_ms",
        "perspective_status",
        "perspective_pass",
        "gate_pass",
        "details",
      ].join(","),
    );

    if (payload.acceptance_gate) {
      rows.push(
        [
          "gate",
          payload.acceptance_gate.evaluatedAt,
          payload.acceptance_gate.filePath,
          "",
          "",
          "",
          "",
          "",
          payload.acceptance_gate.firstViewportMs === null
            ? ""
            : payload.acceptance_gate.firstViewportMs.toFixed(3),
          String(FIRST_VIEWPORT_TARGET_MS),
          String(payload.acceptance_gate.firstViewportPass),
          payload.acceptance_gate.perspectiveReadyMs === null
            ? ""
            : payload.acceptance_gate.perspectiveReadyMs.toFixed(3),
          String(PERSPECTIVE_READY_TARGET_MS),
          payload.acceptance_gate.perspectiveStatus,
          String(payload.acceptance_gate.perspectivePass),
          String(payload.acceptance_gate.passed),
          payload.acceptance_gate.details,
        ]
          .map((cell) => escapeCsvCell(String(cell)))
          .join(","),
      );
    }

    if (payload.perf_sweep) {
      rows.push(
        [
          "perf_sweep_summary",
          payload.perf_sweep.evaluatedAt,
          payload.perf_sweep.filePath,
          "",
          "",
          "",
          "",
          "",
          payload.perf_sweep.firstViewportP95 === null
            ? ""
            : payload.perf_sweep.firstViewportP95.toFixed(3),
          String(FIRST_VIEWPORT_TARGET_MS),
          String(payload.perf_sweep.passCount === payload.perf_sweep.completedRuns),
          payload.perf_sweep.perspectiveReadyP95 === null
            ? ""
            : payload.perf_sweep.perspectiveReadyP95.toFixed(3),
          String(PERSPECTIVE_READY_TARGET_MS),
          payload.perf_sweep.failCount === 0 ? "ready" : "error",
          String(payload.perf_sweep.failCount === 0),
          String(payload.perf_sweep.failCount === 0),
          `runs=${payload.perf_sweep.completedRuns}/${payload.perf_sweep.runCount}; pass=${payload.perf_sweep.passCount}; fail=${payload.perf_sweep.failCount}; first_p50=${payload.perf_sweep.firstViewportP50?.toFixed(1) ?? "n/a"}; perspective_p50=${payload.perf_sweep.perspectiveReadyP50?.toFixed(1) ?? "n/a"}`,
        ]
          .map((cell) => escapeCsvCell(String(cell)))
          .join(","),
      );

      payload.perf_sweep.runs.forEach((run) => {
        rows.push(
          [
            "perf_sweep_run",
            run.evaluatedAt,
            run.filePath,
            "",
            "",
            "",
            "",
            "",
            run.firstViewportMs === null ? "" : run.firstViewportMs.toFixed(3),
            String(FIRST_VIEWPORT_TARGET_MS),
            String(run.firstViewportPass),
            run.perspectiveReadyMs === null ? "" : run.perspectiveReadyMs.toFixed(3),
            String(PERSPECTIVE_READY_TARGET_MS),
            run.perspectiveStatus,
            String(run.perspectivePass),
            String(run.passed),
            run.details,
          ]
            .map((cell) => escapeCsvCell(String(cell)))
            .join(","),
        );
      });
    }

    for (const entry of payload.benchmarks) {
      rows.push(
        [
          "benchmark",
          payload.exported_at,
          payload.latest_view.file_path ?? "",
          entry.mode,
          String(entry.sizeMb),
          String(entry.bytes),
          entry.elapsedMs.toFixed(3),
          entry.throughputMbps.toFixed(3),
          payload.latest_view.first_viewport_ms === null
            ? ""
            : payload.latest_view.first_viewport_ms.toFixed(3),
          String(FIRST_VIEWPORT_TARGET_MS),
          "",
          payload.latest_view.perspective_ready_ms === null
            ? ""
            : payload.latest_view.perspective_ready_ms.toFixed(3),
          String(PERSPECTIVE_READY_TARGET_MS),
          payload.latest_view.perspective_status,
          "",
          "",
          "",
        ]
          .map((cell) => escapeCsvCell(String(cell)))
          .join(","),
      );
    }

    return rows.join("\n");
  }

  async function exportResults(format: "json" | "csv") {
    setLoading(true);
    setError(null);

    try {
      const exportedAt = new Date().toISOString();
      const payload = buildExportPayload(exportedAt);
      const stamp = exportedAt.replace(/[:.]/g, "-");
      const selected = await save({
        title: `Export Results (${format.toUpperCase()})`,
        defaultPath: `parq_bench_results_${stamp}.${format}`,
        filters: [
          {
            name: format.toUpperCase(),
            extensions: [format],
          },
        ],
      });

      if (!selected) {
        return;
      }

      const contents = format === "json" ? JSON.stringify(payload, null, 2) : buildExportCsv(payload);
      await invoke("write_text_report", { path: selected, contents });
      setLastExportPath(selected);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const updateViewportHeight = () => {
      setViewportHeight(Math.max(MIN_VIEWPORT_HEIGHT, Math.floor(window.innerHeight * 0.62)));
    };

    updateViewportHeight();
    window.addEventListener("resize", updateViewportHeight);
    return () => window.removeEventListener("resize", updateViewportHeight);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const health = await invoke<RuntimeHealth>("runtime_health");
        if (!cancelled) {
          setRuntimeHealth(health);
          memoryGuardRef.current = health.memory_guard_tripped;
        }
      } catch {
        // runtime health polling is best-effort
      }
    };

    void poll();
    const id = window.setInterval(() => {
      void poll();
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    perspectiveStatusRef.current = perspectiveStatus;
  }, [perspectiveStatus]);

  useEffect(() => {
    perspectiveErrorRef.current = perspectiveError;
  }, [perspectiveError]);

  useEffect(() => {
    perspectiveReadyMsRef.current = perspectiveReadyMs;
  }, [perspectiveReadyMs]);

  useEffect(() => {
    const monaco = workspaceMonacoRef.current;
    if (!workspaceEditorReady || !monaco) {
      return;
    }

    const sqlKeywords = [
      "SELECT",
      "FROM",
      "WHERE",
      "JOIN",
      "LEFT JOIN",
      "RIGHT JOIN",
      "INNER JOIN",
      "GROUP BY",
      "ORDER BY",
      "LIMIT",
      "HAVING",
      "AS",
      "ON",
      "UNION ALL",
      "COUNT",
      "SUM",
      "AVG",
      "MIN",
      "MAX",
      "DISTINCT",
    ];
    const tableAliases = workspaceTables.map((table) => table.alias);
    const aliasSchemaMap = new Map<string, { alias: string; schema: PreviewColumn[] }>();
    const workspaceColumnMap = new Map<string, { aliases: Set<string>; types: Set<string> }>();
    const qualifiedColumns: Array<{ alias: string; column: PreviewColumn }> = [];
    Object.entries(workspaceTableSchemas).forEach(([alias, schema]) => {
      aliasSchemaMap.set(alias.toLowerCase(), { alias, schema });
      schema.forEach((column) => {
        qualifiedColumns.push({ alias, column });
        const existing = workspaceColumnMap.get(column.name) ?? {
          aliases: new Set<string>(),
          types: new Set<string>(),
        };
        existing.aliases.add(alias);
        existing.types.add(column.duckdb_type);
        workspaceColumnMap.set(column.name, existing);
      });
    });
    const queryColumns = (workspaceQueryResult?.schema ?? []).map((column) => column.name);

    const provider = monaco.languages.registerCompletionItemProvider("sql", {
      triggerCharacters: ["."],
      provideCompletionItems: (model, position) => {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        const linePrefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
        const aliasDotMatch = linePrefix.match(/([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z0-9_]*)$/);

        if (aliasDotMatch) {
          const aliasToken = aliasDotMatch[1];
          const partialColumn = aliasDotMatch[2] ?? "";
          const aliasEntry = aliasSchemaMap.get(aliasToken.toLowerCase());
          if (aliasEntry) {
            const columnRange = {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: position.column - partialColumn.length,
              endColumn: position.column,
            };
            return {
              suggestions: aliasEntry.schema.map((column) => ({
                label: column.name,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: sqlIdentifierInsertText(column.name),
                detail: `${aliasEntry.alias}.${column.name} (${column.duckdb_type})`,
                range: columnRange,
              })),
            };
          }
        }

        const keywordSuggestions = sqlKeywords.map((keyword) => ({
          label: keyword,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: keyword,
          range,
        }));
        const tableSuggestions = tableAliases.map((alias) => ({
          label: alias,
          kind: monaco.languages.CompletionItemKind.Class,
          insertText: alias,
          detail: "Workspace table alias",
          range,
        }));
        const workspaceColumnSuggestions = Array.from(workspaceColumnMap.entries()).map(
          ([columnName, info]) => ({
            label: columnName,
            kind: monaco.languages.CompletionItemKind.Field,
            insertText: sqlIdentifierInsertText(columnName),
            detail: `Workspace column (${Array.from(info.aliases).join(", ")})`,
            documentation: `Types: ${Array.from(info.types).join(" | ")}`,
            range,
          }),
        );
        const qualifiedColumnSuggestions = qualifiedColumns.map(({ alias, column }) => ({
          label: `${alias}.${column.name}`,
          kind: monaco.languages.CompletionItemKind.Field,
          insertText: `${sqlIdentifierInsertText(alias)}.${sqlIdentifierInsertText(column.name)}`,
          detail: `Qualified workspace column (${column.duckdb_type})`,
          range,
        }));
        const columnSuggestions = queryColumns.map((column) => ({
          label: column,
          kind: monaco.languages.CompletionItemKind.Field,
          insertText: sqlIdentifierInsertText(column),
          detail: "Column from last query result",
          range,
        }));

        return {
          suggestions: [
            ...keywordSuggestions,
            ...tableSuggestions,
            ...workspaceColumnSuggestions,
            ...qualifiedColumnSuggestions,
            ...columnSuggestions,
          ],
        };
      },
    });

    workspaceCompletionRef.current = provider;
    return () => {
      provider.dispose();
      if (workspaceCompletionRef.current === provider) {
        workspaceCompletionRef.current = null;
      }
    };
  }, [workspaceEditorReady, workspaceQueryResult, workspaceTableSchemas, workspaceTables]);

  useEffect(() => {
    const columns = workspaceQueryResult?.schema ?? [];
    const numericColumns = columns.filter((column) => isNumericDuckType(column.duckdb_type));

    if (columns.length === 0) {
      setWorkspaceChartX("");
      setWorkspaceChartY("");
      return;
    }

    const firstColumn = columns[0]?.name ?? "";
    const firstNumeric = numericColumns[0]?.name ?? firstColumn;

    setWorkspaceChartX((prev) =>
      prev && columns.some((column) => column.name === prev) ? prev : firstColumn,
    );
    setWorkspaceChartY((prev) =>
      prev && columns.some((column) => column.name === prev) ? prev : firstNumeric,
    );
  }, [workspaceQueryResult]);

  useEffect(() => {
    if (workspaceTables.length < 2) {
      setWorkspaceDiffLeftAlias(workspaceTables[0]?.alias ?? "");
      setWorkspaceDiffRightAlias("");
      setWorkspaceSchemaDiff(null);
      return;
    }

    const aliases = workspaceTables.map((table) => table.alias);
    const defaultLeft = aliases[0] ?? "";
    const defaultRight = aliases[1] ?? aliases[0] ?? "";

    setWorkspaceDiffLeftAlias((prev) => (aliases.includes(prev) ? prev : defaultLeft));
    setWorkspaceDiffRightAlias((prev) =>
      aliases.includes(prev) && prev !== (workspaceDiffLeftAlias || defaultLeft) ? prev : defaultRight,
    );
  }, [workspaceTables, workspaceDiffLeftAlias]);

  async function runSmokeQuery() {
    const response = await invoke<SmokeQueryResponse>("duckdb_smoke_query");
    setResult(response);
  }

  async function runArrowIpcSmoke() {
    const payload = await invoke<number[]>("arrow_ipc_smoke_batch");
    const bytes = Uint8Array.from(payload);
    const table = tableFromIPC(bytes);
    const rows = Array.from(table).map((row) => ({
      id: Number(row.id),
      label: String(row.label),
    }));

    setArrowBytes(bytes.byteLength);
    setArrowRows(rows);
  }

  async function runIpcBenchmark(sizeMb: number): Promise<BenchmarkResult> {
    const start = performance.now();
    const payload = await invoke<number[]>("arrow_ipc_payload", { sizeMb });
    const elapsedMs = performance.now() - start;
    const bytes = payload.length;
    const throughputMbps = bytes / (1024 * 1024) / (elapsedMs / 1000);

    return { mode: "ipc", sizeMb, bytes, elapsedMs, throughputMbps };
  }

  async function runSocketBenchmark(sizeMb: number): Promise<BenchmarkResult> {
    const server = await invoke<SocketServerInfo>("start_arrow_socket_server", {
      sizeMb,
    });

    const start = performance.now();
    const bytes = await new Promise<number>((resolve, reject) => {
      let received = 0;
      const ws = new WebSocket(server.url);
      ws.binaryType = "arraybuffer";

      ws.onmessage = (event) => {
        if (typeof event.data === "string") {
          return;
        }

        if (event.data instanceof ArrayBuffer) {
          received += event.data.byteLength;
        }
      };

      ws.onerror = () => reject(new Error("Socket benchmark connection failed"));
      ws.onclose = () => resolve(received);
    });

    const elapsedMs = performance.now() - start;
    const throughputMbps = bytes / (1024 * 1024) / (elapsedMs / 1000);

    return { mode: "socket", sizeMb, bytes, elapsedMs, throughputMbps };
  }

  async function readSocketPayload(url: string): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";

      ws.onmessage = (event) => {
        if (typeof event.data === "string") {
          return;
        }

        if (event.data instanceof ArrayBuffer) {
          const chunk = new Uint8Array(event.data);
          chunks.push(chunk);
          totalBytes += chunk.byteLength;
        }
      };

      ws.onerror = () => reject(new Error("Socket page stream failed"));
      ws.onclose = () => {
        const merged = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.byteLength;
        }
        resolve(merged);
      };
    });
  }

  async function runTransportBenchmarks() {
    await refreshRuntimeHealth();
    if (memoryGuardRef.current) {
      setError("Memory panic circuit is active; transport benchmark is blocked.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const ipc = await runIpcBenchmark(16);
      const socket = await runSocketBenchmark(64);
      setBenchmarks([ipc, socket]);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  const setRowsAtOffset = useCallback((rowOffset: number, rows: Array<Array<string | null>>) => {
    setLoadedRows((prev) => {
      const next = new Map(prev);
      rows.forEach((row, idx) => next.set(rowOffset + idx, row));
      return next;
    });
  }, []);

  const fetchPage = useCallback(
    async (pageIndex: number) => {
      if (memoryGuardRef.current) {
        return;
      }
      if (!preview || loadedPages.has(pageIndex) || inFlightPages.has(pageIndex)) {
        return;
      }

      setInFlightPages((prev) => new Set(prev).add(pageIndex));
      try {
        const rowOffset = pageIndex * PAGE_SIZE;
        const page = await invoke<ParquetRowsTransport>("fetch_parquet_rows_transport", {
          filePath: preview.file_path,
          rowOffset,
          rowLimit: PAGE_SIZE,
        });

        let payloadBytes: Uint8Array;
        if (page.mode === "ipc") {
          if (!page.ipc_payload) {
            throw new Error("Missing IPC payload for parquet page transport.");
          }
          payloadBytes = Uint8Array.from(page.ipc_payload);
        } else {
          if (!page.socket_url) {
            throw new Error("Missing socket URL for parquet page transport.");
          }
          payloadBytes = await readSocketPayload(page.socket_url);
        }

        const table = tableFromIPC(payloadBytes);
        const rows = Array.from(table).map((record) =>
          preview.schema.map((col) => {
            const value = (record as Record<string, unknown>)[col.name];
            return value === null || value === undefined ? null : String(value);
          }),
        );

        if (memoryGuardRef.current) {
          return;
        }
        setRowsAtOffset(page.row_offset, rows);
        setLoadedPages((prev) => new Set(prev).add(pageIndex));
      } catch (err) {
        setError(String(err));
      } finally {
        setInFlightPages((prev) => {
          const next = new Set(prev);
          next.delete(pageIndex);
          return next;
        });
      }
    },
    [inFlightPages, loadedPages, preview, setRowsAtOffset],
  );

  async function openParquetPreview() {
    await refreshRuntimeHealth();
    if (memoryGuardRef.current) {
      setError(
        "Memory panic circuit is active. Close other memory-heavy apps or reduce workload before opening more data.",
      );
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const selected = await pickParquetFile();
      if (!selected) {
        return;
      }
      await loadPreviewFromPath(selected);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function evaluateAcceptanceGateForFile(targetFile: string): Promise<AcceptanceGateReport> {
    const firstMs = await loadPreviewFromPath(targetFile);
    const perspectiveResult = await waitForPerspectiveResult(ACCEPTANCE_GATE_TIMEOUT_MS);
    const firstViewportPass = firstMs <= FIRST_VIEWPORT_TARGET_MS;
    const perspectivePass =
      perspectiveResult.status === "ready" &&
      perspectiveResult.readyMs !== null &&
      perspectiveResult.readyMs <= PERSPECTIVE_READY_TARGET_MS;
    return {
      filePath: targetFile,
      evaluatedAt: new Date().toISOString(),
      firstViewportMs: firstMs,
      perspectiveReadyMs: perspectiveResult.readyMs,
      firstViewportPass,
      perspectivePass,
      perspectiveStatus: perspectiveResult.status,
      passed: firstViewportPass && perspectivePass,
      details: perspectiveResult.error ?? "",
    };
  }

  async function runAcceptanceGate() {
    await refreshRuntimeHealth();
    if (memoryGuardRef.current) {
      setError("Memory panic circuit is active; acceptance gate is blocked.");
      return;
    }

    setLoading(true);
    setError(null);
    setAcceptanceGate(null);

    try {
      let targetFile = preview?.file_path ?? null;
      if (!targetFile) {
        targetFile = await pickParquetFile();
      }
      if (!targetFile) {
        return;
      }

      const report = await evaluateAcceptanceGateForFile(targetFile);
      setAcceptanceGate(report);
    } catch (err) {
      const message = String(err);
      setError(message);
      setAcceptanceGate(buildFailedGateReport(preview?.file_path ?? "unknown", message));
    } finally {
      setLoading(false);
    }
  }

  async function runPerfSweep() {
    await refreshRuntimeHealth();
    if (memoryGuardRef.current) {
      setError("Memory panic circuit is active; perf sweep is blocked.");
      return;
    }

    const runCount = clampPerfSweepRuns(perfSweepRunsInput);
    setPerfSweepRunsInput(String(runCount));
    setLoading(true);
    setError(null);
    setPerfSweepReport(null);

    try {
      let targetFile = preview?.file_path ?? null;
      if (!targetFile) {
        targetFile = await pickParquetFile();
      }
      if (!targetFile) {
        return;
      }

      const runs: AcceptanceGateReport[] = [];
      for (let index = 0; index < runCount; index += 1) {
        try {
          const report = await evaluateAcceptanceGateForFile(targetFile);
          runs.push(report);
          setAcceptanceGate(report);
        } catch (err) {
          const failed = buildFailedGateReport(targetFile, String(err));
          runs.push(failed);
          setAcceptanceGate(failed);
        }

        await refreshRuntimeHealth();
        if (memoryGuardRef.current) {
          setError("Memory panic circuit tripped during perf sweep. Sweep stopped early.");
          break;
        }
      }

      const firstViewportSamples = runs
        .map((run) => run.firstViewportMs)
        .filter((value): value is number => value !== null);
      const perspectiveSamples = runs
        .map((run) => run.perspectiveReadyMs)
        .filter((value): value is number => value !== null);
      const passCount = runs.filter((run) => run.passed).length;
      const failCount = runs.length - passCount;
      const summary: PerfSweepSummary = {
        filePath: targetFile,
        evaluatedAt: new Date().toISOString(),
        runCount,
        completedRuns: runs.length,
        passCount,
        failCount,
        firstViewportP50: percentile(firstViewportSamples, 0.5),
        firstViewportP95: percentile(firstViewportSamples, 0.95),
        perspectiveReadyP50: percentile(perspectiveSamples, 0.5),
        perspectiveReadyP95: percentile(perspectiveSamples, 0.95),
        perspectiveReadySamples: perspectiveSamples.length,
        runs,
      };
      setPerfSweepReport(summary);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  const totalRows = preview?.total_rows ?? 0;
  const canExportResults = true;
  const memoryGuardActive = runtimeHealth?.memory_guard_tripped ?? false;
  const memoryUsagePct = runtimeHealth ? runtimeHealth.usage_ratio * 100 : null;
  const memoryRssMb = runtimeHealth ? runtimeHealth.process_rss_bytes / (1024 * 1024) : null;
  const previewRowCount = preview?.total_rows ?? null;
  const previewColumnCount = preview?.schema.length ?? null;
  const workspaceRowCount = workspaceQueryResult?.row_count ?? null;
  const workspaceColumnCount = workspaceQueryResult?.schema.length ?? null;
  const workspaceQueryElapsedMs = workspaceQueryResult?.elapsed_ms ?? null;
  const workspaceColumns = workspaceQueryResult?.schema ?? [];
  const workspaceNumericColumns = workspaceColumns.filter((column) =>
    isNumericDuckType(column.duckdb_type),
  );
  const gridContentWidth = preview ? preview.schema.length * COLUMN_WIDTH : 0;
  const columnGridTemplate = preview ? `repeat(${preview.schema.length}, ${COLUMN_WIDTH}px)` : "";
  const visibleStart = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const visibleEnd = Math.max(
    visibleStart,
    Math.min(totalRows - 1, visibleStart + visibleCount - 1),
  );

  const visibleIndices = useMemo(() => {
    const rows: number[] = [];
    for (let idx = visibleStart; idx <= visibleEnd; idx += 1) {
      rows.push(idx);
    }
    return rows;
  }, [visibleEnd, visibleStart]);

  useEffect(() => {
    if (!preview || totalRows === 0) {
      return;
    }

    const firstPage = Math.floor(visibleStart / PAGE_SIZE);
    const lastPage = Math.floor(visibleEnd / PAGE_SIZE);

    for (let page = firstPage; page <= lastPage; page += 1) {
      if (!loadedPages.has(page) && !inFlightPages.has(page)) {
        void fetchPage(page);
      }
    }
  }, [fetchPage, inFlightPages, loadedPages, preview, totalRows, visibleEnd, visibleStart]);

  useEffect(() => {
    if (runtimeHealth?.memory_guard_tripped) {
      setInFlightPages(new Set());
      if (runtimeHealth.message) {
        setError(runtimeHealth.message);
      }
    }
  }, [runtimeHealth]);

  useEffect(() => {
    if (
      !preview ||
      firstViewportMs === null ||
      perspectiveLoadedForFile === preview.file_path ||
      perspectiveStatus !== "idle"
    ) {
      return;
    }

    const rowIndexes = Array.from(loadedRows.keys())
      .sort((a, b) => a - b)
      .slice(0, PERSPECTIVE_MAX_ROWS);

    if (rowIndexes.length === 0) {
      return;
    }

    const dataset = rowIndexes.map((rowIndex) => {
      const row = loadedRows.get(rowIndex) ?? [];
      const item: Record<string, string | null> = {};
      preview.schema.forEach((col, colIndex) => {
        item[col.name] = row[colIndex] ?? null;
      });
      return item;
    });

    void loadPerspectiveDataset(dataset, { plugin: "Datagrid" }, {
      loadedForFile: preview.file_path,
      trackOpenTiming: true,
      context: "preview",
    });
  }, [firstViewportMs, loadedRows, perspectiveLoadedForFile, perspectiveStatus, preview]);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        await runSmokeQuery();
        await runArrowIpcSmoke();
        await refreshWorkspaceTables();
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    window.localStorage.setItem(UI_THEME_STORAGE_KEY, themeMode);
    if (themeMode === "light" || themeMode === "dark") {
      setResolvedTheme(themeMode);
      return;
    }
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const applySystemTheme = () => setResolvedTheme(mediaQuery.matches ? "dark" : "light");
    applySystemTheme();
    mediaQuery.addEventListener("change", applySystemTheme);
    return () => mediaQuery.removeEventListener("change", applySystemTheme);
  }, [themeMode]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolvedTheme);
  }, [resolvedTheme]);

  const activeLayout = useMemo(
    () => savedLayouts.find((layout) => layout.id === activeLayoutId) ?? savedLayouts[0] ?? null,
    [activeLayoutId, savedLayouts],
  );

  useEffect(() => {
    if (!activeLayout) {
      return;
    }
    const payload: StoredLayoutPrefs = {
      version: 1,
      active_layout_id: activeLayoutId,
      layouts: savedLayouts,
    };
    window.localStorage.setItem(UI_LAYOUT_STORAGE_KEY, JSON.stringify(payload));
  }, [activeLayout, activeLayoutId, savedLayouts]);

  useEffect(() => {
    window.localStorage.setItem(UI_LAYOUT_EDIT_STORAGE_KEY, layoutEditEnabled ? "1" : "0");
  }, [layoutEditEnabled]);

  useEffect(() => {
    window.localStorage.setItem(UI_WORKSPACE_SLOW_MODE_STORAGE_KEY, workspaceSlowModeEnabled ? "1" : "0");
  }, [workspaceSlowModeEnabled]);

  useEffect(() => {
    const previous = previousLayoutIdRef.current;

    if (activeLayoutId === SLO_MO_LAYOUT_ID && previous !== SLO_MO_LAYOUT_ID) {
      if (!workspaceSlowModeEnabled) {
        slowModeAutoEnabledByLayoutRef.current = true;
        setWorkspaceSlowModeEnabled(true);
      } else {
        slowModeAutoEnabledByLayoutRef.current = false;
      }
    } else if (previous === SLO_MO_LAYOUT_ID && activeLayoutId !== SLO_MO_LAYOUT_ID) {
      if (slowModeAutoEnabledByLayoutRef.current) {
        setWorkspaceSlowModeEnabled(false);
      }
      slowModeAutoEnabledByLayoutRef.current = false;
    }

    previousLayoutIdRef.current = activeLayoutId;
  }, [activeLayoutId, workspaceSlowModeEnabled]);

  useEffect(() => {
    if (!workspaceSlowModeEnabled) {
      setWorkspaceSourceKind("parquet");
      setWorkspaceDelimiterInput("");
    }
  }, [workspaceSlowModeEnabled]);

  useEffect(() => {
    if (!layoutEditEnabled) {
      return;
    }
    const normalized = normalizeLayoutModel(layoutModel.toJson());
    setLayoutModel(Model.fromJson(cloneJson(normalized)));
    setSavedLayouts((prev) =>
      prev.map((layout) =>
        layout.id === activeLayoutId
          ? {
              ...layout,
              model: cloneJson(normalized),
            }
          : layout,
      ),
    );
  }, [activeLayoutId, layoutEditEnabled]);

  useEffect(() => {
    if (savedLayouts.length === 0) {
      if (layoutRecoveryInProgressRef.current) {
        return;
      }
      layoutRecoveryInProgressRef.current = true;
      const fallback = recoverDefaultLayoutPrefs(
        "empty_layout_state",
        "Runtime layout state became empty; restored factory defaults.",
      );
      setSavedLayouts(fallback.layouts);
      setActiveLayoutId(fallback.active_layout_id);
      setLayoutModel(Model.fromJson(cloneJson(fallback.layouts[0].model)));
      return;
    }
    layoutRecoveryInProgressRef.current = false;
    if (!savedLayouts.some((layout) => layout.id === activeLayoutId)) {
      const next = savedLayouts[0];
      setActiveLayoutId(next.id);
      setLayoutModel(Model.fromJson(cloneJson(next.model)));
    }
  }, [activeLayoutId, savedLayouts]);

  function switchLayout(layoutId: string) {
    const next = savedLayouts.find((layout) => layout.id === layoutId);
    if (!next) {
      return;
    }
    setActiveLayoutId(next.id);
    setLayoutModel(Model.fromJson(cloneJson(next.model)));
  }

  function saveLayoutSnapshot() {
    const name = window.prompt("Save layout as", `${activeLayout?.name ?? "Layout"} Copy`)?.trim();
    if (!name) {
      return;
    }
    const snapshotModel = normalizeLayoutModel(layoutModel.toJson());
    const snapshot: SavedLayout = {
      id: nextLayoutId(),
      name,
      model: cloneJson(snapshotModel),
    };
    setSavedLayouts((prev) => [...prev, snapshot]);
    setActiveLayoutId(snapshot.id);
    setLayoutModel(Model.fromJson(cloneJson(snapshot.model)));
  }

  function renameLayout() {
    if (!activeLayout) {
      return;
    }
    const name = window.prompt("Rename layout", activeLayout.name)?.trim();
    if (!name) {
      return;
    }
    setSavedLayouts((prev) =>
      prev.map((layout) => (layout.id === activeLayout.id ? { ...layout, name } : layout)),
    );
  }

  function duplicateLayout() {
    if (!activeLayout) {
      return;
    }
    const snapshotModel = normalizeLayoutModel(layoutModel.toJson());
    const snapshot: SavedLayout = {
      id: nextLayoutId(),
      name: `${activeLayout.name} Copy`,
      model: cloneJson(snapshotModel),
    };
    setSavedLayouts((prev) => [...prev, snapshot]);
    setActiveLayoutId(snapshot.id);
    setLayoutModel(Model.fromJson(cloneJson(snapshot.model)));
  }

  function deleteLayout() {
    if (!activeLayout || savedLayouts.length <= 1) {
      return;
    }
    if (!window.confirm(`Delete layout "${activeLayout.name}"?`)) {
      return;
    }
    const remaining = savedLayouts.filter((layout) => layout.id !== activeLayout.id);
    const next = remaining[0];
    setSavedLayouts(remaining);
    setActiveLayoutId(next.id);
    setLayoutModel(Model.fromJson(cloneJson(next.model)));
  }

  function resetToDefaultLayout() {
    const nextModel = normalizeLayoutModel(DEFAULT_LAYOUT_MODEL);
    setLayoutModel(Model.fromJson(nextModel));
    setSavedLayouts((prev) =>
      prev.map((layout) =>
        layout.id === activeLayoutId
          ? {
              ...layout,
              model: nextModel,
            }
          : layout,
      ),
    );
  }

  function restoreFactoryLayouts() {
    if (!window.confirm("Restore factory layouts? This will remove all saved custom layouts.")) {
      return;
    }
    const defaults = defaultLayoutPrefs();
    setSavedLayouts(defaults.layouts);
    setActiveLayoutId(defaults.active_layout_id);
    setLayoutModel(Model.fromJson(cloneJson(defaults.layouts[0].model)));
    setLayoutEditEnabled(false);
  }

  function exportLayoutJson() {
    if (!activeLayout) {
      setError("No active layout to export.");
      return;
    }
    try {
      const payload = {
        version: 1,
        exported_at: new Date().toISOString(),
        layout: {
          name: activeLayout.name,
          model: cloneJson(layoutModel.toJson()),
        },
      };
      const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${sanitizeFileName(activeLayout.name)}.layout.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setError(null);
    } catch (err) {
      setError(`Export layout failed: ${String(err)}`);
    }
  }

  async function importLayoutJson() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.multiple = false;

    const filePromise = new Promise<File | null>((resolve) => {
      input.onchange = () => {
        resolve(input.files?.[0] ?? null);
      };
    });

    input.click();
    const selected = await filePromise;
    if (!selected) {
      return;
    }

    try {
      const raw = await readFileAsText(selected);
      const parsed = JSON.parse(raw) as unknown;
      const fallbackName = selected.name.replace(/\.json$/i, "") || "Imported";
      const imported = parseImportedLayoutPayload(parsed, fallbackName);
      Model.fromJson(cloneJson(imported.model));

      const components = collectLayoutTabComponents(imported.model);
      const panelCountsMap = new Map<string, number>();
      components.forEach((component) => {
        panelCountsMap.set(component, (panelCountsMap.get(component) ?? 0) + 1);
      });
      const panelCounts = Array.from(panelCountsMap.entries())
        .map(([component, count]) => ({ component, count }))
        .sort((a, b) => a.component.localeCompare(b.component));
      const knownPanels = new Set<DockPanelComponent>(["actions", "preview", "workspace", "diagnostics"]);
      const unknownPanels = panelCounts
        .map((item) => item.component)
        .filter((component) => !knownPanels.has(component as DockPanelComponent));

      setPendingImportedLayout({
        sourceFile: selected.name,
        name: imported.name,
        model: cloneJson(imported.model),
        tabCount: components.length,
        panelCounts,
        unknownPanels,
      });
      setPendingImportedName(imported.name);
      setError(null);
    } catch (err) {
      setError(`Import layout failed: ${String(err)}`);
    }
  }

  function applyImportedLayout() {
    if (!pendingImportedLayout) {
      return;
    }
    const layoutName = pendingImportedName.trim() || pendingImportedLayout.name;
    const normalizedModel = normalizeLayoutModel(pendingImportedLayout.model);
    const snapshot: SavedLayout = {
      id: nextLayoutId(),
      name: layoutName,
      model: cloneJson(normalizedModel),
    };
    setSavedLayouts((prev) => [...prev, snapshot]);
    setActiveLayoutId(snapshot.id);
    setLayoutModel(Model.fromJson(cloneJson(snapshot.model)));
    setPendingImportedLayout(null);
    setPendingImportedName("");
    setError(null);
  }

  function cancelImportedLayout() {
    setPendingImportedLayout(null);
    setPendingImportedName("");
  }

  function onLayoutModelChange(model: Model) {
    const snapshot = normalizeLayoutModel(model.toJson());
    setSavedLayouts((prev) =>
      prev.map((layout) =>
        layout.id === activeLayoutId
          ? {
              ...layout,
              model: snapshot,
            }
          : layout,
      ),
    );
  }

  function onLayoutAction(action: Action): Action | undefined {
    if (layoutEditEnabled) {
      return action;
    }
    const blocked = new Set<string>([
      Actions.MOVE_NODE,
      Actions.ADD_NODE,
      Actions.DELETE_TAB,
      Actions.DELETE_TABSET,
      Actions.RENAME_TAB,
      Actions.ADJUST_WEIGHTS,
      Actions.ADJUST_BORDER_SPLIT,
      Actions.MAXIMIZE_TOGGLE,
      Actions.CREATE_WINDOW,
      Actions.CLOSE_WINDOW,
      Actions.POPOUT_TAB,
      Actions.POPOUT_TABSET,
      Actions.UPDATE_MODEL_ATTRIBUTES,
      Actions.UPDATE_NODE_ATTRIBUTES,
    ]);
    if (blocked.has(action.type)) {
      return undefined;
    }
    return action;
  }

  function resolvePerspectiveContext(preferred?: PerspectiveContext): PerspectiveContext | null {
    const components = new Set(collectLayoutTabComponents(layoutModel.toJson()));
    const hasPreview = components.has("preview");
    const hasWorkspace = components.has("workspace");

    if (preferred === "preview" && hasPreview) {
      return "preview";
    }
    if (preferred === "workspace" && hasWorkspace) {
      return "workspace";
    }
    if (hasPreview) {
      return "preview";
    }
    if (hasWorkspace) {
      return "workspace";
    }
    return null;
  }

  const actionsPanel = (
    <section className="dock-panel">
      <div className="actions">
        <button type="button" onClick={() => void openParquetPreview()} disabled={loading || memoryGuardActive}>
          Open Parquet
        </button>
        <button type="button" onClick={() => void runAcceptanceGate()} disabled={loading || memoryGuardActive}>
          {loading ? "Running..." : "Run Acceptance Gate"}
        </button>
        <button type="button" onClick={() => setLayoutMenuOpen((prev) => !prev)}>
          {layoutMenuOpen ? "Hide Layouts" : "Layouts"}
        </button>
        <button type="button" onClick={() => void exportResults("json")} disabled={loading || !canExportResults}>
          Export JSON
        </button>
        <button type="button" onClick={() => void exportResults("csv")} disabled={loading || !canExportResults}>
          Export CSV
        </button>
        {preview ? (
          <>
            <button type="button" onClick={() => setViewMode("virtual")} disabled={viewMode === "virtual"}>
              Virtual View
            </button>
            <button
              type="button"
              onClick={() => setViewMode("perspective")}
              disabled={perspectiveStatus !== "ready" || viewMode === "perspective"}
            >
              Perspective View
            </button>
          </>
        ) : null}
        {result ? <span>DuckDB {result.duckdb_version}</span> : null}
        {arrowBytes > 0 ? <span>Arrow IPC {arrowBytes} bytes</span> : null}
        {lastExportPath ? (
          <span className="path-text" title={lastExportPath}>
            Exported: {lastExportPath}
          </span>
        ) : null}
      </div>
      {layoutMenuOpen ? (
        <div className="actions-layout-menu">
          <button type="button" onClick={saveLayoutSnapshot}>
            Save As
          </button>
          <button type="button" onClick={renameLayout} disabled={!activeLayout}>
            Rename
          </button>
          <button type="button" onClick={duplicateLayout} disabled={!activeLayout}>
            Duplicate
          </button>
          <button type="button" onClick={deleteLayout} disabled={savedLayouts.length <= 1}>
            Delete
          </button>
          <button type="button" onClick={resetToDefaultLayout}>
            Reset
          </button>
          <button type="button" onClick={restoreFactoryLayouts}>
            Restore Factory
          </button>
          <button type="button" onClick={exportLayoutJson} disabled={!activeLayout}>
            Export Layout JSON
          </button>
          <button
            type="button"
            onClick={() => {
              void importLayoutJson();
            }}
          >
            Import Layout JSON
          </button>
          <button type="button" onClick={() => setLayoutEditEnabled((prev) => !prev)}>
            {layoutEditEnabled ? "Lock Layout" : "Edit Layout"}
          </button>
          <button type="button" onClick={() => void runTransportBenchmarks()} disabled={loading}>
            Run Transport Bench
          </button>
          <button type="button" onClick={() => void runPerfSweep()} disabled={loading}>
            Run Perf Sweep
          </button>
          <button
            type="button"
            onClick={() => {
              void (async () => {
                await runSmokeQuery();
                await runArrowIpcSmoke();
              })();
            }}
            disabled={loading}
          >
            Run Smoke Checks
          </button>
          <span className={layoutEditEnabled ? "metric-chip metric-good" : "metric-chip"}>
            {layoutEditEnabled ? "Layout editing enabled" : "Layout editing locked"}
          </span>
          <span className="phase">Advanced checks are intentionally tucked under Layouts.</span>
        </div>
      ) : null}

      {runtimeHealth || preview || workspaceQueryResult ? (
        <div className="runtime-metrics">
          {runtimeHealth ? (
            <span className={memoryGuardActive ? "metric-chip metric-bad" : "metric-chip"}>
              Memory: {memoryUsagePct?.toFixed(1) ?? "n/a"}%
            </span>
          ) : null}
          {runtimeHealth ? <span className="metric-chip">RSS: {memoryRssMb?.toFixed(1) ?? "n/a"} MB</span> : null}
          {previewRowCount !== null ? <span className="metric-chip">Preview rows: {previewRowCount.toLocaleString()}</span> : null}
          {previewColumnCount !== null ? <span className="metric-chip">Preview cols: {previewColumnCount}</span> : null}
          {firstViewportMs !== null ? <span className="metric-chip">Preview load: {firstViewportMs.toFixed(0)}ms</span> : null}
          {workspaceRowCount !== null ? <span className="metric-chip">SQL rows: {workspaceRowCount.toLocaleString()}</span> : null}
          {workspaceColumnCount !== null ? <span className="metric-chip">SQL cols: {workspaceColumnCount}</span> : null}
          {workspaceQueryElapsedMs !== null ? (
            <span className="metric-chip">SQL response: {workspaceQueryElapsedMs.toFixed(0)}ms</span>
          ) : null}
          {runtimeHealth?.message ? (
            <span className={memoryGuardActive ? "metric-chip metric-bad" : "metric-chip"} title={runtimeHealth.message}>
              {runtimeHealth.message}
            </span>
          ) : null}
        </div>
      ) : null}

      {acceptanceGate ? (
        <div className={acceptanceGate.passed ? "gate-report gate-pass" : "gate-report gate-fail"}>
          Gate {acceptanceGate.passed ? "PASS" : "FAIL"} | First viewport:{" "}
          {acceptanceGate.firstViewportMs === null ? "n/a" : `${acceptanceGate.firstViewportMs.toFixed(0)}ms`} |{" "}
          Perspective:{" "}
          {acceptanceGate.perspectiveReadyMs === null
            ? acceptanceGate.perspectiveStatus
            : `${acceptanceGate.perspectiveReadyMs.toFixed(0)}ms (${acceptanceGate.perspectiveStatus})`}{" "}
          | File: {acceptanceGate.filePath}
          {acceptanceGate.details ? ` | Detail: ${acceptanceGate.details}` : ""}
        </div>
      ) : null}
      {perfSweepReport ? (
        <div className={perfSweepReport.failCount === 0 ? "gate-report gate-pass" : "gate-report gate-fail"}>
          Perf Sweep {perfSweepReport.failCount === 0 ? "PASS" : "FAIL"} | Runs: {perfSweepReport.completedRuns}/
          {perfSweepReport.runCount} | Pass: {perfSweepReport.passCount} | First p50/p95:{" "}
          {perfSweepReport.firstViewportP50 === null
            ? "n/a"
            : `${perfSweepReport.firstViewportP50.toFixed(0)}ms / ${perfSweepReport.firstViewportP95?.toFixed(0) ?? "n/a"}ms`}{" "}
          | Perspective p50/p95:{" "}
          {perfSweepReport.perspectiveReadyP50 === null
            ? "n/a"
            : `${perfSweepReport.perspectiveReadyP50.toFixed(0)}ms / ${perfSweepReport.perspectiveReadyP95?.toFixed(0) ?? "n/a"}ms`}{" "}
          | File: {perfSweepReport.filePath}
        </div>
      ) : null}
      {perfSweepReport ? (
        <details className="sweep-runs">
          <summary>Perf Sweep Runs</summary>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>First viewport (ms)</th>
                  <th>Perspective (ms)</th>
                  <th>Status</th>
                  <th>Gate</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {perfSweepReport.runs.map((run, index) => (
                  <tr key={`perf-run-${run.evaluatedAt}-${index}`}>
                    <td>{index + 1}</td>
                    <td>{run.firstViewportMs === null ? "n/a" : run.firstViewportMs.toFixed(1)}</td>
                    <td>{run.perspectiveReadyMs === null ? "n/a" : run.perspectiveReadyMs.toFixed(1)}</td>
                    <td>{run.perspectiveStatus}</td>
                    <td>{run.passed ? "PASS" : "FAIL"}</td>
                    <td>{run.details || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}

      {error ? <p className="error">{error}</p> : null}
    </section>
  );

  const previewPanel = (
    <section className="preview-panel">
      {preview ? (
        <>
          <h3>Parquet Preview</h3>
          <p className="meta-line">
            <span className="path-text" title={preview.file_path}>
              <strong>Path:</strong> {preview.file_path}
            </span>
            <span>
              <strong>Size:</strong> {(preview.file_size_bytes / (1024 * 1024)).toFixed(2)} MB
            </span>
            <span>
              <strong>Rows:</strong> {preview.total_rows.toLocaleString()}
            </span>
            <span>
              <strong>Columns:</strong> {preview.schema.length}
            </span>
            <span>
              <strong>Renderer:</strong> {viewMode}
            </span>
            <span>
              <strong>Perspective:</strong> {perspectiveStatus}
            </span>
            <span>
              <strong>Stage:</strong> {perspectiveStage}
            </span>
          </p>
          <div className="metrics-line">
            <span
              className={
                firstViewportMs === null
                  ? "metric-chip"
                  : firstViewportMs <= FIRST_VIEWPORT_TARGET_MS
                    ? "metric-chip metric-good"
                    : "metric-chip metric-bad"
              }
            >
              First viewport:{" "}
              {firstViewportMs === null ? "pending" : `${firstViewportMs.toFixed(0)}ms / target ${FIRST_VIEWPORT_TARGET_MS}ms`}
            </span>
            <span
              className={
                perspectiveReadyMs === null
                  ? "metric-chip"
                  : perspectiveReadyMs <= PERSPECTIVE_READY_TARGET_MS
                    ? "metric-chip metric-good"
                    : "metric-chip metric-bad"
              }
            >
              Perspective ready:{" "}
              {perspectiveReadyMs === null
                ? "pending"
                : `${perspectiveReadyMs.toFixed(0)}ms / target ${PERSPECTIVE_READY_TARGET_MS}ms`}
            </span>
          </div>
          {perspectiveError ? <p className="error">Perspective error: {perspectiveError}</p> : null}

          {viewMode === "virtual" ? (
            <>
              <div className="virtual-header-track">
                <div
                  className="virtual-header-row"
                  style={{
                    gridTemplateColumns: columnGridTemplate,
                    width: `${gridContentWidth}px`,
                    transform: `translateX(-${scrollLeft}px)`,
                  }}
                >
                  {preview.schema.map((col) => (
                    <div key={col.name} className="virtual-cell virtual-cell-head" title={col.duckdb_type}>
                      {col.name}
                    </div>
                  ))}
                </div>
              </div>
              <div
                className="virtual-grid"
                style={{ height: `${viewportHeight}px` }}
                onScroll={(event) => {
                  setScrollTop(event.currentTarget.scrollTop);
                  setScrollLeft(event.currentTarget.scrollLeft);
                }}
              >
                <div className="virtual-spacer" style={{ height: `${totalRows * ROW_HEIGHT}px`, width: `${gridContentWidth}px` }}>
                  {visibleIndices.map((index) => {
                    const row = loadedRows.get(index);
                    return (
                      <div
                        key={`virtual-row-${index}`}
                        className="virtual-row"
                        style={{
                          top: `${index * ROW_HEIGHT}px`,
                          height: `${ROW_HEIGHT}px`,
                          width: `${gridContentWidth}px`,
                          gridTemplateColumns: columnGridTemplate,
                        }}
                      >
                        {preview.schema.map((col, colIndex) => (
                          <div key={`virtual-cell-${index}-${col.name}`} className="virtual-cell" title={row?.[colIndex] ?? "NULL"}>
                            {row ? (row[colIndex] ?? "NULL") : "..."}
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          ) : null}
          {perspectiveContext === "preview" ? (
            <div
              className={viewMode === "perspective" ? "perspective-wrap" : "perspective-wrap hidden"}
              style={{ height: `${viewportHeight}px` }}
            >
              <perspective-viewer ref={perspectiveViewerRef} className="perspective-viewer" />
            </div>
          ) : null}
        </>
      ) : (
        <div className="preview-placeholder">
          <h3>Parquet Preview</h3>
          <p className="phase">Open a parquet file to inspect rows and switch between virtual and perspective views.</p>
        </div>
      )}
    </section>
  );

  const diagnosticsPanel = (
    <section className="dock-panel">
      <h3>Arrow IPC Decode</h3>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Label</th>
          </tr>
        </thead>
        <tbody>
          {arrowRows.map((row) => (
            <tr key={`arrow-${row.id}`}>
              <td>{row.id}</td>
              <td>{row.label}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Transport Benchmarks</h3>
      <table>
        <thead>
          <tr>
            <th>Mode</th>
            <th>Payload</th>
            <th>Bytes</th>
            <th>Time (ms)</th>
            <th>Throughput (MB/s)</th>
          </tr>
        </thead>
        <tbody>
          {benchmarks.map((entry) => (
            <tr key={entry.mode}>
              <td>{entry.mode}</td>
              <td>{entry.sizeMb} MB</td>
              <td>{entry.bytes.toLocaleString()}</td>
              <td>{entry.elapsedMs.toFixed(1)}</td>
              <td>{entry.throughputMbps.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );

  const workspacePanel = (
    <section className="workspace-panel">
      <h3>Workspace Explorer</h3>
      <div className="workspace-mode-row">
        <label className="workspace-slow-toggle">
          <input
            type="checkbox"
            checked={workspaceSlowModeEnabled}
            onChange={(event) => setWorkspaceSlowModeEnabled(event.currentTarget.checked)}
          />
          Enable slow mode for non-Parquet workspace sources
        </label>
        {workspaceSlowModeEnabled ? <span className="metric-chip metric-bad">Slow mode enabled</span> : null}
      </div>
      {workspaceSlowModeEnabled ? (
        <div className="workspace-slow-warning">
          Slow mode is active. Non-Parquet file parsing is outside the fast path and may have higher latency and memory
          pressure than standard Parquet workflows.
        </div>
      ) : null}
      {workspaceSlowModeEnabled ? (
        <div className="workspace-source-row">
          <label>
            Source type
            <select
              value={workspaceSourceKind}
              onChange={(event) => {
                const next = event.currentTarget.value as WorkspaceSourceKind;
                setWorkspaceSourceKind(next);
                if (next === "parquet") {
                  setWorkspaceDelimiterInput("");
                }
              }}
            >
              <option value="parquet">Parquet (fast path)</option>
              <option value="delimited">Delimited (csv/txt/data/tsv)</option>
            </select>
          </label>
          {workspaceSourceKind === "delimited" ? (
            <label>
              Delimiter
              <input
                type="text"
                value={workspaceDelimiterInput}
                onChange={(event) => setWorkspaceDelimiterInput(event.currentTarget.value)}
                placeholder='Auto by extension (.csv ",", .tsv "\\t", .txt/.data ",")'
              />
            </label>
          ) : null}
        </div>
      ) : null}
      <div className="workspace-register-row">
        <input
          type="text"
          placeholder="alias (e.g. my_table)"
          value={workspaceAliasInput}
          onChange={(event) => setWorkspaceAliasInput(event.currentTarget.value)}
        />
        <input
          type="text"
          className="workspace-path-input"
          placeholder={
            workspaceSlowModeEnabled && workspaceSourceKind === "delimited"
              ? "csv/txt/data file path or glob"
              : "parquet file path or glob"
          }
          value={workspacePathInput}
          onChange={(event) => setWorkspacePathInput(event.currentTarget.value)}
        />
        <label className="workspace-checkbox">
          <input
            type="checkbox"
            checked={workspaceIsGlob}
            onChange={(event) => setWorkspaceIsGlob(event.currentTarget.checked)}
          />
          glob
        </label>
        <button type="button" onClick={() => void pickWorkspaceTablePath()} disabled={loading}>
          Browse
        </button>
        <button type="button" onClick={() => void registerWorkspaceTable()} disabled={loading}>
          Register
        </button>
      </div>

      <div className="workspace-list">
        <strong>Tables:</strong>{" "}
        {workspaceTables.length === 0
          ? "none"
          : workspaceTables.map((table) => (
              <span key={`workspace-${table.alias}`} className="workspace-table-pill">
                {table.alias}
                <span className="workspace-table-source">
                  {table.source_kind === "delimited"
                    ? `delimited | ${formatWorkspaceDelimiter(table.delimiter)}`
                    : "parquet"}
                </span>
                <button
                  type="button"
                  className="workspace-pill-remove"
                  onClick={() => void removeWorkspaceTable(table.alias)}
                  disabled={loading}
                >
                  x
                </button>
              </span>
            ))}
      </div>
      {workspaceTables.length > 0 ? (
        <div className="workspace-schema-summary">
          {workspaceTables.map((table) => {
            const schema = workspaceTableSchemas[table.alias] ?? [];
            const columnsPreview = schema
              .slice(0, 6)
              .map((column) => column.name)
              .join(", ");
            const suffix = schema.length > 6 ? ", ..." : "";
            return (
              <span
                key={`workspace-schema-${table.alias}`}
                className="workspace-schema-pill"
                title={
                  schema.length === 0
                    ? `${table.alias}: schema unavailable`
                    : `${table.alias}: ${schema.map((column) => `${column.name} (${column.duckdb_type})`).join(", ")}`
                }
              >
                <strong>{table.alias}</strong>: {schema.length === 0 ? "schema unavailable" : `${columnsPreview}${suffix}`}
              </span>
            );
          })}
        </div>
      ) : null}

      <div className="workspace-diff-row">
        <label>
          Diff Left
          <select value={workspaceDiffLeftAlias} onChange={(event) => setWorkspaceDiffLeftAlias(event.currentTarget.value)}>
            <option value="">Select table</option>
            {workspaceTables.map((table) => (
              <option key={`diff-left-${table.alias}`} value={table.alias}>
                {table.alias}
              </option>
            ))}
          </select>
        </label>
        <label>
          Diff Right
          <select value={workspaceDiffRightAlias} onChange={(event) => setWorkspaceDiffRightAlias(event.currentTarget.value)}>
            <option value="">Select table</option>
            {workspaceTables.map((table) => (
              <option key={`diff-right-${table.alias}`} value={table.alias}>
                {table.alias}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => void runWorkspaceSchemaDiff()} disabled={loading || workspaceTables.length < 2}>
          Run Schema Diff
        </button>
      </div>

      {workspaceSchemaDiff ? (
        <>
          <p className="meta-line">
            <span>
              <strong>Added:</strong> {workspaceSchemaDiff.added_count}
            </span>
            <span>
              <strong>Removed:</strong> {workspaceSchemaDiff.removed_count}
            </span>
            <span>
              <strong>Type Changed:</strong> {workspaceSchemaDiff.type_changed_count}
            </span>
            <span>
              <strong>Unchanged:</strong> {workspaceSchemaDiff.unchanged_count}
            </span>
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Column</th>
                  <th>{workspaceSchemaDiff.left_alias}</th>
                  <th>{workspaceSchemaDiff.right_alias}</th>
                  <th>Change</th>
                </tr>
              </thead>
              <tbody>
                {workspaceSchemaDiff.columns.map((column) => (
                  <tr key={`schema-diff-${column.name}`}>
                    <td>{column.name}</td>
                    <td>{column.left_type ?? "-"}</td>
                    <td>{column.right_type ?? "-"}</td>
                    <td>{column.change}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <div className="workspace-sql-row">
        <div className="workspace-editor">
          <Editor
            height="180px"
            defaultLanguage="sql"
            defaultValue={workspaceSql}
            theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
            onMount={onWorkspaceEditorMount}
            onChange={(value) => setWorkspaceSql(value ?? "")}
            options={{
              automaticLayout: true,
              minimap: { enabled: false },
              wordWrap: "on",
              fontSize: 13,
              scrollBeyondLastLine: false,
              lineNumbers: "on",
            }}
          />
        </div>
        <button type="button" onClick={() => void runWorkspaceQuery()} disabled={loading}>
          Run SQL
        </button>
        <div className="workspace-export-row">
          <button type="button" onClick={() => void exportWorkspaceQuery("csv")} disabled={loading}>
            Export Query CSV
          </button>
          <button type="button" onClick={() => void exportWorkspaceQuery("parquet")} disabled={loading}>
            Export Query Parquet
          </button>
        </div>
      </div>

      {workspaceExport ? (
        <p className="meta-line">
          <span>
            <strong>Last Export:</strong> {workspaceExport.format.toUpperCase()}
          </span>
          <span className="path-text" title={workspaceExport.output_path}>
            <strong>Path:</strong> {workspaceExport.output_path}
          </span>
          <span>
            <strong>Size:</strong> {(workspaceExport.file_size_bytes / 1024).toFixed(1)} KB
          </span>
          <span>
            <strong>Elapsed:</strong> {workspaceExport.elapsed_ms.toFixed(0)}ms
          </span>
        </p>
      ) : null}

      <div className="workspace-chart-row">
        <label>
          Plugin
          <select value={workspaceChartPlugin} onChange={(event) => setWorkspaceChartPlugin(event.currentTarget.value as WorkspaceChartPlugin)}>
            <option value="Datagrid">Datagrid</option>
            <option value="Y Bar">Y Bar</option>
            <option value="X Bar">X Bar</option>
            <option value="Y Line">Y Line</option>
            <option value="Treemap">Treemap</option>
          </select>
        </label>
        <label>
          X
          <select value={workspaceChartX} onChange={(event) => setWorkspaceChartX(event.currentTarget.value)}>
            {workspaceColumns.map((column) => (
              <option key={`chart-x-${column.name}`} value={column.name}>
                {column.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Y
          <select value={workspaceChartY} onChange={(event) => setWorkspaceChartY(event.currentTarget.value)}>
            {workspaceColumns.map((column) => (
              <option key={`chart-y-${column.name}`} value={column.name}>
                {column.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Agg
          <select value={workspaceChartAgg} onChange={(event) => setWorkspaceChartAgg(event.currentTarget.value)}>
            <option value="sum">sum</option>
            <option value="avg">avg</option>
            <option value="count">count</option>
            <option value="min">min</option>
            <option value="max">max</option>
          </select>
        </label>
        <button type="button" onClick={() => void visualizeWorkspaceChart()} disabled={loading || workspaceQueryResult === null}>
          Chart In Perspective
        </button>
        {workspaceNumericColumns.length === 0 && workspaceQueryResult ? (
          <span className="phase">No numeric columns detected; use Datagrid.</span>
        ) : null}
      </div>

      {perspectiveContext === "workspace" ? (
        <div
          className={viewMode === "perspective" ? "perspective-wrap" : "perspective-wrap hidden"}
          style={{ height: `${Math.max(360, Math.floor(viewportHeight * 0.8))}px`, marginBottom: "8px" }}
        >
          <perspective-viewer ref={perspectiveViewerRef} className="perspective-viewer" />
        </div>
      ) : null}

      {workspaceQueryResult ? (
        <>
          <p className="meta-line">
            <span>
              <strong>Rows:</strong> {workspaceQueryResult.row_count}
              {workspaceQueryResult.truncated ? ` (truncated to ${workspaceQueryResult.row_limit})` : ""}
            </span>
            <span>
              <strong>Elapsed:</strong> {workspaceQueryResult.elapsed_ms.toFixed(0)}ms
            </span>
            <span>
              <strong>Columns:</strong> {workspaceQueryResult.schema.length}
            </span>
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {workspaceQueryResult.schema.map((col) => (
                    <th key={`workspace-col-${col.name}`} title={col.duckdb_type}>
                      {col.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {workspaceQueryResult.rows.map((row, rowIndex) => (
                  <tr key={`workspace-row-${rowIndex}`}>
                    {row.map((value, colIndex) => (
                      <td key={`workspace-cell-${rowIndex}-${colIndex}`}>{value ?? "NULL"}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );

  const dockThemeClass = resolvedTheme === "dark" ? "flexlayout__theme_dark" : "flexlayout__theme_light";

  function dockFactory(node: TabNode) {
    const component = node.getComponent() as DockPanelComponent;
    switch (component) {
      case "actions":
        return actionsPanel;
      case "preview":
        return previewPanel;
      case "workspace":
        return workspacePanel;
      case "diagnostics":
        return diagnosticsPanel;
      default:
        return <div className="phase">Unknown panel</div>;
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <h1>Parq-Bench — High-Performance Local Data Lake</h1>
        <div className="topbar-right">
          <label className="theme-picker">
            Layout
            <select value={activeLayout?.id ?? ""} onChange={(event) => switchLayout(event.currentTarget.value)}>
              {savedLayouts.map((layout) => (
                <option key={`layout-top-${layout.id}`} value={layout.id}>
                  {layout.name}
                </option>
              ))}
            </select>
          </label>
          <label className="theme-picker">
            Theme
            <select value={themeMode} onChange={(event) => setThemeMode(event.currentTarget.value as ThemeMode)}>
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <button type="button" onClick={() => setAboutOpen(true)} disabled={pendingImportedLayout !== null}>
            About
          </button>
          <span className="phase">Phase 3 Hardening</span>
        </div>
      </header>

      <section className="card">
        <div className={`dock-host ${dockThemeClass}`}>
          <Layout
            model={layoutModel}
            factory={dockFactory}
            onAction={onLayoutAction}
            onModelChange={(model) => onLayoutModelChange(model)}
          />
        </div>
      </section>

      {aboutOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setAboutOpen(false)}>
          <section
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-label="About Parq-Bench"
            onClick={(event) => event.stopPropagation()}
          >
            <h3>About Parq-Bench</h3>
            <p className="phase">Parq-Bench — High-Performance Local Data Lake.</p>
            <div className="modal-actions">
              <button type="button" onClick={() => setAboutOpen(false)}>
                Close
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {pendingImportedLayout ? (
        <div className="modal-backdrop" role="presentation" onClick={cancelImportedLayout}>
          <section
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-label="Import layout preview"
            onClick={(event) => event.stopPropagation()}
          >
            <h3>Import Layout Preview</h3>
            <p className="phase">
              File: <strong>{pendingImportedLayout.sourceFile}</strong>
            </p>
            <p className="phase">
              Tabs: <strong>{pendingImportedLayout.tabCount}</strong>
            </p>
            <div className="meta-line">
              {pendingImportedLayout.panelCounts.map((item) => (
                <span key={`import-panel-${item.component}`} className="metric-chip">
                  {item.component}: {item.count}
                </span>
              ))}
            </div>
            {pendingImportedLayout.unknownPanels.length > 0 ? (
              <p className="error">
                Unknown panel components: {pendingImportedLayout.unknownPanels.join(", ")}. They may render as
                placeholders.
              </p>
            ) : null}
            <label className="theme-picker">
              Imported layout name
              <input
                type="text"
                value={pendingImportedName}
                onChange={(event) => setPendingImportedName(event.currentTarget.value)}
              />
            </label>
            <div className="modal-actions">
              <button type="button" onClick={applyImportedLayout}>
                Import
              </button>
              <button type="button" onClick={cancelImportedLayout}>
                Cancel
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

export default App;
