import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { loader, type OnMount } from "@monaco-editor/react";
import * as monacoEditor from "monaco-editor";
loader.config({ monaco: monacoEditor });
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { tableFromIPC } from "apache-arrow";
import type * as Monaco from "monaco-editor";
import "./App.css";

const PAGE_SIZE = 256;
const ROW_HEIGHT = 30;
const MIN_VIEWPORT_HEIGHT = 320;
const OVERSCAN = 8;
const COLUMN_WIDTH = 180;
const FIRST_VIEWPORT_TARGET_MS = 500;
const PERSPECTIVE_READY_TARGET_MS = 3000;
const ACCEPTANCE_GATE_TIMEOUT_MS = 15000;
const PERSPECTIVE_RESTORE_TIMEOUT_DEFAULT_MS = 8000;
const PERSPECTIVE_RESTORE_TIMEOUT_CHART_MS = 20000;

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

const DELIMITED_EXTENSIONS = ["csv", "tsv", "txt", "data"];

function detectSourceKind(filePath: string): WorkspaceSourceKind {
  const lower = filePath.toLowerCase().replace(/[/\\]+$/, "");
  // Glob patterns: only detect delimited for explicit extensions (*.csv, *.tsv, etc.)
  // *.* is ambiguous and defaults to parquet (safest — parquet ignores non-parquet silently)
  if (lower.includes("*")) {
    for (const ext of DELIMITED_EXTENSIONS) {
      if (lower.endsWith(`*.${ext}`)) return "delimited";
    }
    return "parquet";
  }
  // Single file: check extension
  const dot = lower.lastIndexOf(".");
  if (dot !== -1) {
    const ext = lower.slice(dot + 1);
    if (DELIMITED_EXTENSIONS.includes(ext)) return "delimited";
  }
  return "parquet";
}

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
type ActiveTab = "preview" | "sql";

const UI_THEME_STORAGE_KEY = "parqbench.ui.theme_mode";
const UI_WORKSPACE_SLOW_MODE_STORAGE_KEY = "parqbench.ui.workspace_slow_mode_enabled";
const UI_ACTIVE_TAB_STORAGE_KEY = "parqbench.ui.active_tab";
const UI_RECENT_FILES_STORAGE_KEY = "parqbench.ui.recent_files";
const UI_QUERY_HISTORY_STORAGE_KEY = "parqbench.ui.query_history";
const UI_SETTINGS_STORAGE_KEY = "parqbench.ui.settings";
const RECENT_FILES_MAX = 15;
const QUERY_HISTORY_MAX = 50;

type QueryHistoryEntry = {
  sql: string;
  timestamp: number;
  rowCount?: number;
  elapsedMs?: number;
};

type AppSettings = {
  sqlRowLimit: number;
  perspectiveMaxRows: number;
  editorFontSize: number;
  expandMode: "fullscreen" | "resize";
  showPerspectiveConfigure: boolean;
  showVisualization: boolean;
};

const DEFAULT_SETTINGS: AppSettings = {
  sqlRowLimit: 200,
  perspectiveMaxRows: 5000,
  editorFontSize: 13,
  expandMode: "fullscreen",
  showPerspectiveConfigure: true,
  showVisualization: true,
};

type SummarizeRow = Record<string, string>;
/**
 * Feature flags (compile-time, dead-code eliminated by Vite in production):
 *
 * INTERNAL_TOOLS_ENABLED — gates acceptance gate, perf sweeps, transport
 *   benchmarks, diagnostics panel, runtime metrics, and export buttons.
 *   Always on in dev. In production builds, set the env var
 *   VITE_PARQBENCH_INTERNAL_TOOLS=1 at build time to enable.
 *
 */
const INTERNAL_TOOLS_ENABLED =
  import.meta.env.DEV || import.meta.env.VITE_PARQBENCH_INTERNAL_TOOLS === "1";
const PRODUCT_STAGE_LABEL = "Beta";





function readActiveTab(): ActiveTab {
  if (typeof window === "undefined") {
    return "preview";
  }
  const value = window.localStorage.getItem(UI_ACTIVE_TAB_STORAGE_KEY);
  if (value === "preview" || value === "sql") {
    return value;
  }
  return "preview";
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

function readWorkspaceSlowModeEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.localStorage.getItem(UI_WORKSPACE_SLOW_MODE_STORAGE_KEY) === "1";
}

function readRecentFiles(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(UI_RECENT_FILES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x: unknown) => typeof x === "string").slice(0, RECENT_FILES_MAX) : [];
  } catch { return []; }
}

function readQueryHistory(): QueryHistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(UI_QUERY_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, QUERY_HISTORY_MAX) : [];
  } catch { return []; }
}

function readSettings(): AppSettings {
  if (typeof window === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(UI_SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return {
      sqlRowLimit: typeof parsed.sqlRowLimit === "number" ? parsed.sqlRowLimit : DEFAULT_SETTINGS.sqlRowLimit,
      perspectiveMaxRows: typeof parsed.perspectiveMaxRows === "number" ? parsed.perspectiveMaxRows : DEFAULT_SETTINGS.perspectiveMaxRows,
      editorFontSize: typeof parsed.editorFontSize === "number" ? parsed.editorFontSize : DEFAULT_SETTINGS.editorFontSize,
      expandMode: parsed.expandMode === "fullscreen" || parsed.expandMode === "resize" ? parsed.expandMode : DEFAULT_SETTINGS.expandMode,
      showPerspectiveConfigure: typeof parsed.showPerspectiveConfigure === "boolean" ? parsed.showPerspectiveConfigure : DEFAULT_SETTINGS.showPerspectiveConfigure,
      showVisualization: typeof parsed.showVisualization === "boolean" ? parsed.showVisualization : DEFAULT_SETTINGS.showVisualization,
    };
  } catch { return { ...DEFAULT_SETTINGS }; }
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
  const [activeTab, setActiveTab] = useState<ActiveTab>(() => readActiveTab());

  const [result, setResult] = useState<SmokeQueryResponse | null>(null);
  const [, setArrowRows] = useState<ArrowRow[]>([]);
  const [, setArrowBytes] = useState(0);
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
  const [, setLastExportPath] = useState<string | null>(null);
  const [workspaceTables, setWorkspaceTables] = useState<WorkspaceTableInfo[]>([]);
  const [workspaceTableSchemas, setWorkspaceTableSchemas] = useState<WorkspaceSchemaByAlias>({});
  const [workspaceAliasInput, setWorkspaceAliasInput] = useState("");
  const [workspacePathInput, setWorkspacePathInput] = useState("");
  const [workspaceIsGlob, setWorkspaceIsGlob] = useState(false);
  const [workspaceSlowModeEnabled, setWorkspaceSlowModeEnabled] = useState<boolean>(
    () => readWorkspaceSlowModeEnabled(),
  );
  const workspaceSourceKind = detectSourceKind(workspacePathInput);
  const [workspaceDelimiterInput, setWorkspaceDelimiterInput] = useState("");
  const [workspaceEditorReady, setWorkspaceEditorReady] = useState(false);
  const [workspaceSql, setWorkspaceSql] = useState(
    "SELECT * FROM my_table LIMIT 100",
  );
  const [editorHeight, setEditorHeight] = useState(180);
  const [settings, setSettings] = useState<AppSettings>(() => readSettings());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [editorFontSize, setEditorFontSize] = useState(() => settings.editorFontSize);
  const [workspaceQueryResult, setWorkspaceQueryResult] = useState<WorkspaceQueryResponse | null>(null);
  const [workspaceChartPlugin, setWorkspaceChartPlugin] = useState<WorkspaceChartPlugin>("Datagrid");
  const [workspaceChartX, setWorkspaceChartX] = useState("");
  const [workspaceChartY, setWorkspaceChartY] = useState("");
  const [workspaceChartAgg, setWorkspaceChartAgg] = useState("sum");
  const [workspaceDiffLeftAlias, setWorkspaceDiffLeftAlias] = useState("");
  const [workspaceDiffRightAlias, setWorkspaceDiffRightAlias] = useState("");
  const [workspaceSchemaDiff, setWorkspaceSchemaDiff] = useState<WorkspaceSchemaDiffResponse | null>(null);
  const [workspaceExport, setWorkspaceExport] = useState<WorkspaceExportResponse | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recentFiles, setRecentFiles] = useState<string[]>(() => readRecentFiles());
  const [queryHistory, setQueryHistory] = useState<QueryHistoryEntry[]>(() => readQueryHistory());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [explainPlan, setExplainPlan] = useState<string | null>(null);
  const [explainLoading, setExplainLoading] = useState(false);
  const [workspaceTableStats, setWorkspaceTableStats] = useState<Record<string, SummarizeRow[] | null>>({});
  const [statsLoading, setStatsLoading] = useState<string | null>(null);
  const [bulkSelectMode, setBulkSelectMode] = useState(false);
  const [bulkSelectedAliases, setBulkSelectedAliases] = useState<Set<string>>(new Set());
  const [columnSearchQuery, setColumnSearchQuery] = useState("");
  const [dragOverZone, setDragOverZone] = useState<"preview" | "sql" | null>(null);
  const [editingAlias, setEditingAlias] = useState<string | null>(null);
  const [editingAliasValue, setEditingAliasValue] = useState("");
  const [expandedPanel, setExpandedPanel] = useState<"preview-table" | "perspective" | "sql-results" | null>(null);
  const previewPaneRef = useRef<HTMLDivElement | null>(null);
  const sqlPaneRef = useRef<HTMLDivElement | null>(null);
  const perspectiveViewerRef = useRef<HTMLElement | null>(null);
  const perspectiveTableRef = useRef<{ delete?: () => Promise<void> | void } | null>(null);
  const memoryGuardRef = useRef(false);
  const openStartRef = useRef<number | null>(null);
  const perspectiveStatusRef = useRef<PerspectiveStatus>("idle");
  const perspectiveErrorRef = useRef<string | null>(null);
  const perspectiveReadyMsRef = useRef<number | null>(null);
  const perspectiveRuntimeInitRef = useRef<Promise<void> | null>(null);
  // Perspective module doesn't ship comprehensive TS types; typed as unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    const filters = workspaceIsGlob
      ? []
      : [
          { name: "Parquet", extensions: ["parquet"] },
          { name: "Delimited", extensions: ["csv", "tsv", "txt", "data"] },
        ];
    const selected = await open({
      title: workspaceIsGlob ? "Select Workspace Source Folder" : "Select Workspace Table Source",
      multiple: false,
      directory: workspaceIsGlob,
      filters: filters.length > 0 ? filters : undefined,
    });
    if (selected && !Array.isArray(selected)) {
      if (workspaceIsGlob) {
        // Default to *.parquet — user can change to *.csv etc. and detection auto-adjusts
        setWorkspacePathInput(appendGlobPattern(selected, "*.parquet"));
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

  async function copyToClipboard(text: string) {
    try {
      await writeText(text);
    } catch {
      // fallback to navigator API
      await navigator.clipboard.writeText(text);
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
      const sourceKind = detectSourceKind(workspacePathInput.trim());
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

  async function clearAllWorkspaceTables() {
    if (!window.confirm(`Remove all ${workspaceTables.length} workspace tables?`)) return;
    setLoading(true);
    setError(null);
    const errors: string[] = [];
    for (const table of workspaceTables) {
      try {
        await invoke("remove_workspace_table", { alias: table.alias });
      } catch (err) { errors.push(`${table.alias}: ${String(err)}`); }
    }
    setWorkspaceTableStats({});
    setBulkSelectMode(false);
    setBulkSelectedAliases(new Set());
    await refreshWorkspaceTables();
    if (errors.length > 0) setError(errors.join(" | "));
    setLoading(false);
  }

  async function removeSelectedWorkspaceTables() {
    if (bulkSelectedAliases.size === 0) return;
    setLoading(true);
    setError(null);
    const errors: string[] = [];
    for (const alias of bulkSelectedAliases) {
      try {
        await invoke("remove_workspace_table", { alias });
        setWorkspaceTableStats((prev) => { const n = { ...prev }; delete n[alias]; return n; });
      } catch (err) { errors.push(`${alias}: ${String(err)}`); }
    }
    setBulkSelectedAliases(new Set());
    setBulkSelectMode(false);
    await refreshWorkspaceTables();
    if (errors.length > 0) setError(errors.join(" | "));
    setLoading(false);
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
        queryText: sqlText,
        tableAliases: workspaceTables.map((t) => t.alias),
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
        rowLimit: settings.sqlRowLimit,
      });
      setWorkspaceQueryResult(result);
      setExplainPlan(null);
      setQueryHistory((prev) => {
        const entry: QueryHistoryEntry = {
          sql: result.sql,
          timestamp: Date.now(),
          rowCount: result.row_count,
          elapsedMs: result.elapsed_ms,
        };
        return [entry, ...prev.filter((h) => h.sql !== result.sql)].slice(0, QUERY_HISTORY_MAX);
      });
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

  async function runExplainAnalyze() {
    const sqlText = readWorkspaceSql();
    if (!sqlText.trim()) {
      setError("SQL query is required for EXPLAIN ANALYZE.");
      return;
    }
    setExplainLoading(true);
    setError(null);
    try {
      const result = await invoke<string>("explain_workspace_query", { sql: sqlText });
      setExplainPlan(result);
    } catch (err) {
      setError(String(err));
    } finally {
      setExplainLoading(false);
    }
  }

  async function loadTableStats(alias: string) {
    setStatsLoading(alias);
    setError(null);
    try {
      const result = await invoke<SummarizeRow[]>("summarize_workspace_table", { alias });
      setWorkspaceTableStats((prev) => ({ ...prev, [alias]: result }));
    } catch (err) {
      setError(String(err));
    } finally {
      setStatsLoading(null);
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
    const pasteFromClipboard = async () => {
      try {
        const text = await readText();
        if (text) {
          const selection = editor.getSelection();
          if (selection) {
            editor.executeEdits("paste", [{ range: selection, text }]);
          }
        }
      } catch (_) { /* clipboard unavailable */ }
    };
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV, pasteFromClipboard);
    editor.addAction({
      id: "tauri-paste",
      label: "Paste",
      contextMenuGroupId: "9_cutcopypaste",
      contextMenuOrder: 3,
      run: pasteFromClipboard,
    });
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
        // Stage 1: parallel import of all independent modules + WASM URLs
        const [perspective, perspectiveViewer, serverWasmMod, viewerWasmMod] = await withTimeout(
          "perspective parallel imports",
          Promise.all([
            import("@finos/perspective"),
            import("@finos/perspective-viewer"),
            import("@finos/perspective/dist/wasm/perspective-server.wasm?url"),
            import("@finos/perspective-viewer/dist/wasm/perspective-viewer.wasm?url"),
          ]),
        );
        // Stage 2: init server + init client in parallel (independent of each other)
        setStage("core.init");
        await withTimeout(
          "perspective init_server + init_client",
          Promise.all([
            Promise.resolve(perspective.init_server(fetch(serverWasmMod.default))),
            perspectiveViewer.init_client(fetch(viewerWasmMod.default)),
          ]),
        );
        // Stage 3: register plugins in parallel
        setStage("plugins.import");
        await withTimeout(
          "perspective plugins import",
          Promise.all([
            import("@finos/perspective-viewer-datagrid"),
            import("@finos/perspective-viewer-d3fc"),
          ]),
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
      // Perspective worker API is untyped; see https://perspective.finos.org/docs/js/
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    setRecentFiles((prev) => {
      const filtered = prev.filter((p) => p !== filePath);
      return [filePath, ...filtered].slice(0, RECENT_FILES_MAX);
    });
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
      benchmarks: [],
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
      perf_sweep: null,
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

  const totalRows = preview?.total_rows ?? 0;
  const canExportResults = true;
  const memoryGuardActive = runtimeHealth?.memory_guard_tripped ?? false;
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
      .slice(0, settings.perspectiveMaxRows);

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

  useEffect(() => {
    window.localStorage.setItem(UI_WORKSPACE_SLOW_MODE_STORAGE_KEY, workspaceSlowModeEnabled ? "1" : "0");
  }, [workspaceSlowModeEnabled]);

  useEffect(() => {
    if (!workspaceSlowModeEnabled) {
      setWorkspaceDelimiterInput("");
    }
  }, [workspaceSlowModeEnabled]);

  useEffect(() => {
    window.localStorage.setItem(UI_ACTIVE_TAB_STORAGE_KEY, activeTab);
  }, [activeTab]);

  useEffect(() => {
    window.localStorage.setItem(UI_RECENT_FILES_STORAGE_KEY, JSON.stringify(recentFiles));
  }, [recentFiles]);

  useEffect(() => {
    window.localStorage.setItem(UI_QUERY_HISTORY_STORAGE_KEY, JSON.stringify(queryHistory));
  }, [queryHistory]);

  useEffect(() => {
    window.localStorage.setItem(UI_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  // Hide/show Perspective's built-in configure (settings) button via shadow DOM style injection
  // Only runs after Perspective has fully loaded to avoid layout interference
  useEffect(() => {
    if (perspectiveStatus !== "ready") return;
    const viewer = perspectiveViewerRef.current;
    if (!viewer) return;
    const shadow = viewer.shadowRoot;
    if (!shadow) return;
    const styleId = "parqbench-hide-configure";
    let styleEl = shadow.getElementById(styleId) as HTMLStyleElement | null;
    if (!settings.showPerspectiveConfigure) {
      if (!styleEl) {
        styleEl = document.createElement("style");
        styleEl.id = styleId;
        styleEl.textContent = "#settings_button { display: none !important; }";
        shadow.appendChild(styleEl);
      }
    } else {
      if (styleEl) styleEl.remove();
    }
  }, [settings.showPerspectiveConfigure, perspectiveStatus]);

  useEffect(() => {
    let cancelled = false;
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (cancelled) return;
      const payload = event.payload;
      if (payload.type === "over") {
        const pos = payload.position;
        const previewRect = previewPaneRef.current?.getBoundingClientRect();
        const sqlRect = sqlPaneRef.current?.getBoundingClientRect();
        if (
          previewRect &&
          activeTab === "preview" &&
          pos.x >= previewRect.left &&
          pos.x <= previewRect.right &&
          pos.y >= previewRect.top &&
          pos.y <= previewRect.bottom
        ) {
          setDragOverZone("preview");
        } else if (
          sqlRect &&
          activeTab === "sql" &&
          pos.x >= sqlRect.left &&
          pos.x <= sqlRect.right &&
          pos.y >= sqlRect.top &&
          pos.y <= sqlRect.bottom
        ) {
          setDragOverZone("sql");
        } else {
          setDragOverZone(activeTab);
        }
      } else if (payload.type === "leave") {
        setDragOverZone(null);
      } else if (payload.type === "drop") {
        const zone = dragOverZone ?? activeTab;
        setDragOverZone(null);
        const paths = payload.paths;
        if (!paths || paths.length === 0) return;
        if (zone === "preview") {
          void handlePreviewDrop(paths);
        } else {
          void handleSqlDrop(paths);
        }
      }
    });

    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, dragOverZone]);

  async function handlePreviewDrop(paths: string[]) {
    const parquetPaths = paths.filter((p) => p.toLowerCase().endsWith(".parquet"));
    if (parquetPaths.length === 0) {
      setError("Only .parquet files can be opened in Preview.");
      return;
    }
    if (memoryGuardRef.current) {
      setError("Memory panic circuit is active. Cannot open file.");
      return;
    }
    if (loading) return;

    setLoading(true);
    setError(null);
    try {
      await loadPreviewFromPath(parquetPaths[0]);
      setActiveTab("preview");
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleSqlDrop(paths: string[]) {
    const supportedExts = [".parquet", ".csv", ".tsv", ".txt", ".data"];
    const validPaths = paths.filter((p) => {
      const lower = p.toLowerCase();
      return supportedExts.some((ext) => lower.endsWith(ext));
    });
    if (validPaths.length === 0) {
      setError("No supported files found. Supported: .parquet, .csv, .tsv, .txt, .data");
      return;
    }
    if (loading) return;

    setLoading(true);
    setError(null);
    try {
      const existingAliases = new Set(workspaceTables.map((t) => t.alias.toLowerCase()));
      const batchAliases = new Set<string>();
      let firstAlias: string | null = null;

      for (const filePath of validPaths) {
        const fileName = filePath.replace(/\\/g, "/").split("/").pop() ?? "table";
        const baseName = fileName.replace(/\.[^.]+$/, "");
        let sanitized = baseName
          .replace(/[^A-Za-z0-9_]/g, "_")
          .toLowerCase();
        if (!/^[a-z_]/.test(sanitized)) {
          sanitized = "_" + sanitized;
        }

        let alias = sanitized;
        let counter = 2;
        while (existingAliases.has(alias) || batchAliases.has(alias)) {
          alias = `${sanitized}_${counter}`;
          counter++;
        }
        batchAliases.add(alias);
        existingAliases.add(alias);
        if (!firstAlias) firstAlias = alias;

        const sourceKind = detectSourceKind(filePath);
        const delimiter = filePath.toLowerCase().endsWith(".tsv") ? "\t" : undefined;

        await invoke<WorkspaceTableInfo>("register_workspace_table", {
          alias,
          filePath,
          isGlob: false,
          sourceKind,
          delimiter,
        });
      }

      await refreshWorkspaceTables();
      if (firstAlias) {
        const currentSql = readWorkspaceSql();
        if (currentSql === "SELECT * FROM my_table LIMIT 100") {
          replaceWorkspaceSql(`SELECT * FROM ${firstAlias} LIMIT 100`);
        }
      }
      setActiveTab("sql");
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function renameWorkspaceTable(oldAlias: string, newAlias: string) {
    setLoading(true);
    setError(null);
    try {
      await invoke<WorkspaceTableInfo>("rename_workspace_table", { oldAlias, newAlias });
      await refreshWorkspaceTables();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  // Global keyboard shortcuts
  useEffect(() => {
    function handleGlobalKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      const target = e.target as HTMLElement | null;
      const tagName = target?.tagName ?? "";
      const isTextInput = tagName === "INPUT" || tagName === "TEXTAREA";

      // Escape — always allowed (only collapses in fullscreen mode)
      if (e.key === "Escape") {
        if (expandedPanel && settings.expandMode === "fullscreen") {
          e.preventDefault();
          setExpandedPanel(null);
        } else if (settingsOpen) {
          e.preventDefault();
          setSettingsOpen(false);
        } else if (aboutOpen) {
          e.preventDefault();
          setAboutOpen(false);
        } else if (historyOpen) {
          e.preventDefault();
          setHistoryOpen(false);
        } else if (error) {
          e.preventDefault();
          setError(null);
        }
        return;
      }

      // Skip modifier shortcuts when typing in text inputs (but not Monaco — Monaco handles its own keys)
      if (isTextInput) return;

      if (!mod) return;

      // Ctrl+1 → Preview tab
      if (e.key === "1") {
        e.preventDefault();
        setActiveTab("preview");
        return;
      }

      // Ctrl+2 → SQL tab
      if (e.key === "2") {
        e.preventDefault();
        setActiveTab("sql");
        return;
      }

      // Ctrl+O → Open Parquet (preview tab only)
      if (e.key === "o" || e.key === "O") {
        if (!loading && !memoryGuardRef.current) {
          e.preventDefault();
          void openParquetPreview();
        }
        return;
      }

      // Ctrl+Shift+Enter → Explain Analyze (SQL tab only) — must be before Ctrl+Enter
      if (e.key === "Enter" && e.shiftKey && activeTab === "sql") {
        if (!loading && !explainLoading) {
          e.preventDefault();
          void runExplainAnalyze();
        }
        return;
      }

      // Ctrl+Enter → Run SQL (SQL tab only)
      if (e.key === "Enter" && activeTab === "sql") {
        if (!loading) {
          e.preventDefault();
          void runWorkspaceQuery();
        }
        return;
      }

      // Ctrl+Shift+E → Export query as CSV (SQL tab only)
      if ((e.key === "e" || e.key === "E") && e.shiftKey && activeTab === "sql") {
        if (!loading) {
          e.preventDefault();
          void exportWorkspaceQuery("csv");
        }
        return;
      }

      // Ctrl+, → Settings
      if (e.key === ",") {
        e.preventDefault();
        setSettingsOpen((p) => !p);
        return;
      }
    }

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [aboutOpen, settingsOpen, error, loading, explainLoading, activeTab]);

  function resolvePerspectiveContext(preferred?: PerspectiveContext): PerspectiveContext | null {
    if (preferred === "preview" || preferred === "workspace") {
      return preferred;
    }
    return "preview";
  }

  const actionsPanel = (
    <section className="actions-toolbar">
      <div className="actions">
        {activeTab === "preview" ? (
          <button type="button" onClick={() => void openParquetPreview()} disabled={loading || memoryGuardActive}>
            Open Parquet<kbd className="shortcut-hint">Ctrl+O</kbd>
          </button>
        ) : null}
        {INTERNAL_TOOLS_ENABLED ? (
          <>
            <button type="button" onClick={() => void runAcceptanceGate()} disabled={loading || memoryGuardActive}>
              {loading ? "Running..." : "Run Acceptance Gate"}
            </button>
            <button type="button" onClick={() => void exportResults("json")} disabled={loading || !canExportResults}>
              Export JSON
            </button>
            <button type="button" onClick={() => void exportResults("csv")} disabled={loading || !canExportResults}>
              Export CSV
            </button>
          </>
        ) : null}
        {preview && activeTab === "preview" ? (
          <>
            {INTERNAL_TOOLS_ENABLED ? (
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
            <button type="button" onClick={() => {
              setPreview(null);
              setViewMode("virtual");
              setPerspectiveStatus("idle");
              setPerspectiveStage("idle");
              setPerspectiveError(null);
              setPerspectiveLoadedForFile(null);
              setFirstViewportMs(null);
              setPerspectiveReadyMs(null);
              setLoadedRows(new Map());
              setLoadedPages(new Set());
              setInFlightPages(new Set());
              setScrollTop(0);
              setScrollLeft(0);
              setAcceptanceGate(null);
            }}>
              Close File
            </button>
          </>
        ) : null}
        {INTERNAL_TOOLS_ENABLED && result ? <span>DuckDB {result.duckdb_version}</span> : null}
      </div>
      {error ? <p className="error">{error}</p> : null}
    </section>
  );

  const previewPanel = (
    <section className={expandedPanel === "preview-table" ? `preview-panel ${settings.expandMode === "resize" ? "resizable-panel" : "expanded-panel"}` : "preview-panel"}>
      {preview ? (
        <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <h3 style={{ margin: 0 }}>Parquet Preview</h3>
            {viewMode === "virtual" ? (
              <button type="button" className="expand-btn" title={expandedPanel === "preview-table" ? (settings.expandMode === "fullscreen" ? "Exit fullscreen (Esc)" : "Collapse") : "Expand table"}
                onClick={() => setExpandedPanel(expandedPanel === "preview-table" ? null : "preview-table")}>
                {expandedPanel === "preview-table" ? "\u2716" : (settings.expandMode === "resize" ? "\u2922" : "\u26F6")}
              </button>
            ) : null}
          </div>
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
            <button type="button" style={{ padding: "2px 7px", fontSize: "0.76rem" }}
              onClick={() => void copyToClipboard(preview.schema.map((c) => c.name).join(", "))}>
              Copy All Columns
            </button>
            {INTERNAL_TOOLS_ENABLED ? (
              <>
                <span>
                  <strong>Renderer:</strong> {viewMode}
                </span>
                <span>
                  <strong>Perspective:</strong> {perspectiveStatus}
                </span>
                <span>
                  <strong>Stage:</strong> {perspectiveStage}
                </span>
              </>
            ) : null}
          </p>
          {INTERNAL_TOOLS_ENABLED ? (
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
          ) : null}
          {perspectiveError ? <p className="error">Perspective error: {perspectiveError}</p> : null}

          {viewMode === "virtual" && !INTERNAL_TOOLS_ENABLED && perspectiveStatus === "ready" ? (
            <p className="row-cap-banner">
              Data visualization ready.{" "}
              <button type="button" className="row-cap-switch" onClick={() => setViewMode("perspective")}>
                Visualize Data
              </button>
              {totalRows > settings.perspectiveMaxRows ? (
                <span> (first {settings.perspectiveMaxRows.toLocaleString()} rows)</span>
              ) : null}
            </p>
          ) : null}
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
                    <div key={col.name} className="virtual-cell virtual-cell-head col-copyable"
                      title={`${col.duckdb_type} — click to copy`}
                      onClick={() => void copyToClipboard(col.name)}>
                      {col.name}
                    </div>
                  ))}
                </div>
              </div>
              <div
                className="virtual-grid"
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
          {viewMode === "perspective" && totalRows > settings.perspectiveMaxRows ? (
            <p className="row-cap-banner">
              Showing first {settings.perspectiveMaxRows.toLocaleString()} of{" "}
              {totalRows.toLocaleString()} rows.{" "}
              <button type="button" className="row-cap-switch" onClick={() => setViewMode("virtual")}>
                Switch to full-scroll view
              </button>
            </p>
          ) : null}
          {perspectiveContext === "preview" ? (
            <div
              className={`${viewMode === "perspective" ? "perspective-wrap" : "perspective-wrap hidden"}${expandedPanel === "perspective" ? (settings.expandMode === "resize" ? " resizable-panel" : " expanded-panel") : ""}`}
              style={expandedPanel === "perspective" ? undefined : { height: `${viewportHeight}px` }}
            >
              {viewMode === "perspective" ? (
                <button type="button" className="expand-btn perspective-expand-btn"
                  title={expandedPanel === "perspective" ? (settings.expandMode === "fullscreen" ? "Exit fullscreen (Esc)" : "Collapse") : "Expand chart"}
                  onClick={() => setExpandedPanel(expandedPanel === "perspective" ? null : "perspective")}>
                  {expandedPanel === "perspective" ? "\u2716" : (settings.expandMode === "resize" ? "\u2922" : "\u26F6")}
                </button>
              ) : null}
              <perspective-viewer ref={perspectiveViewerRef} className="perspective-viewer" />
            </div>
          ) : null}
        </>
      ) : (
        <div className="preview-placeholder">
          <h3>Parquet Preview</h3>
          <p className="phase">Open a parquet file to inspect rows and switch between virtual and perspective views.</p>
          {recentFiles.length > 0 ? (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <strong style={{ fontSize: "0.85rem" }}>Recent Files</strong>
                <button type="button" style={{ padding: "2px 6px", fontSize: "0.75rem" }}
                  onClick={() => setRecentFiles([])}>Clear</button>
              </div>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, fontSize: "0.84rem" }}>
                {recentFiles.map((filePath) => {
                  const fileName = filePath.split(/[/\\]/).pop() ?? filePath;
                  return (
                    <li key={filePath} style={{ marginBottom: 3 }}>
                      <button type="button"
                        style={{ border: "none", background: "none", color: "var(--accent)", padding: "2px 0", cursor: "pointer", textAlign: "left", fontWeight: 600, boxShadow: "none", fontSize: "0.84rem" }}
                        onClick={() => {
                          setLoading(true);
                          setError(null);
                          void loadPreviewFromPath(filePath).catch((err) => setError(String(err))).finally(() => setLoading(false));
                        }}
                        disabled={loading}
                      >
                        {fileName}
                      </button>
                      <span className="phase" style={{ marginLeft: 6 }} title={filePath}>{filePath}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
      )}
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
          Enable Slo-mo
        </label>
        {workspaceSlowModeEnabled ? <span className="metric-chip metric-bad">Slo-mo enabled</span> : null}
      </div>
      {workspaceSlowModeEnabled ? (
        <div className="workspace-slow-warning">
          Slo-mo enabled. You can process non-Parquet files, but at the expense of speed.
        </div>
      ) : null}
      {workspaceSourceKind === "delimited" ? (
        <div className="workspace-source-row">
          <span className="phase">Detected: delimited file</span>
          <label>
            Delimiter
            <input
              type="text"
              value={workspaceDelimiterInput}
              onChange={(event) => setWorkspaceDelimiterInput(event.currentTarget.value)}
              placeholder='Auto (.csv → ",", .tsv → "\t")'
            />
          </label>
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
          placeholder="file path or glob (e.g. *.parquet, *.csv)"
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
          Mount
        </button>
      </div>

      <div className="workspace-list">
        <strong>Tables:</strong>{" "}
        {workspaceTables.length >= 2 ? (
          <>
            <button type="button" style={{ padding: "2px 7px", fontSize: "0.75rem" }}
              onClick={() => void clearAllWorkspaceTables()} disabled={loading}>
              Clear All
            </button>
            <button type="button" style={{ padding: "2px 7px", fontSize: "0.75rem" }}
              onClick={() => { setBulkSelectMode((p) => !p); setBulkSelectedAliases(new Set()); }}>
              {bulkSelectMode ? "Cancel Select" : "Select"}
            </button>
            {bulkSelectMode && bulkSelectedAliases.size > 0 ? (
              <button type="button" style={{ padding: "2px 7px", fontSize: "0.75rem" }}
                onClick={() => void removeSelectedWorkspaceTables()} disabled={loading}>
                Remove Selected ({bulkSelectedAliases.size})
              </button>
            ) : null}
          </>
        ) : null}
        {workspaceTables.length === 0
          ? "none"
          : workspaceTables.map((table) => (
              <span key={`workspace-${table.alias}`} className="workspace-table-pill">
                {bulkSelectMode ? (
                  <input type="checkbox" className="bulk-checkbox"
                    checked={bulkSelectedAliases.has(table.alias)}
                    onChange={(e) => {
                      setBulkSelectedAliases((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(table.alias); else next.delete(table.alias);
                        return next;
                      });
                    }}
                  />
                ) : null}
                {editingAlias === table.alias ? (
                  <input
                    type="text"
                    className="workspace-alias-edit"
                    value={editingAliasValue}
                    autoFocus
                    onChange={(e) => setEditingAliasValue(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        const trimmed = editingAliasValue.trim();
                        if (trimmed && trimmed !== table.alias) {
                          void renameWorkspaceTable(table.alias, trimmed);
                        }
                        setEditingAlias(null);
                      } else if (e.key === "Escape") {
                        setEditingAlias(null);
                      }
                    }}
                    onBlur={() => {
                      const trimmed = editingAliasValue.trim();
                      if (trimmed && trimmed !== table.alias) {
                        void renameWorkspaceTable(table.alias, trimmed);
                      }
                      setEditingAlias(null);
                    }}
                  />
                ) : (
                  <span
                    className="workspace-alias-label"
                    title="Click to rename"
                    onClick={() => {
                      setEditingAlias(table.alias);
                      setEditingAliasValue(table.alias);
                    }}
                  >
                    {table.alias}
                  </span>
                )}
                <span className="workspace-table-source">
                  {table.source_kind === "delimited"
                    ? `delimited | ${formatWorkspaceDelimiter(table.delimiter)}`
                    : "parquet"}
                </span>
                <button
                  type="button"
                  style={{ border: "none", background: "none", color: "var(--accent)", padding: "0 2px", lineHeight: 1, boxShadow: "none", fontSize: "0.75rem", fontWeight: 600 }}
                  title="Column statistics"
                  onClick={() => {
                    if (workspaceTableStats[table.alias]) {
                      setWorkspaceTableStats((prev) => ({ ...prev, [table.alias]: null }));
                    } else {
                      void loadTableStats(table.alias);
                    }
                  }}
                  disabled={loading || statsLoading === table.alias}
                >
                  {statsLoading === table.alias ? "..." : "Stats"}
                </button>
                <button
                  type="button"
                  className="workspace-pill-remove"
                  onClick={() => {
                    void removeWorkspaceTable(table.alias);
                    setWorkspaceTableStats((prev) => { const n = { ...prev }; delete n[table.alias]; return n; });
                  }}
                  disabled={loading}
                >
                  x
                </button>
              </span>
            ))}
      </div>
      {workspaceTables.map((table) => {
        const stats = workspaceTableStats[table.alias];
        if (!stats) return null;
        return (
          <details key={`stats-${table.alias}`} open style={{ marginBottom: 8 }}>
            <summary style={{ cursor: "pointer", fontSize: "0.85rem", fontWeight: 600, marginBottom: 4 }}>
              Stats: {table.alias}
              <button type="button" style={{ marginLeft: 8, padding: "1px 6px", fontSize: "0.72rem" }}
                onClick={(e) => { e.stopPropagation(); setWorkspaceTableStats((prev) => ({ ...prev, [table.alias]: null })); }}>
                Hide
              </button>
            </summary>
            <div className="table-wrap" style={{ maxHeight: 240, overflowY: "auto" }}>
              {(() => {
                const STATS_COLS = ["column_name","column_type","min","max","approx_unique","avg","std","q25","q50","q75","count","null_percentage"];
                return (
                  <table>
                    <thead>
                      <tr>
                        {STATS_COLS.map((key) => (
                          <th key={`stats-th-${table.alias}-${key}`} style={{ fontSize: "0.78rem" }}>{key}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {stats.map((row, ri) => (
                        <tr key={`stats-row-${table.alias}-${ri}`}>
                          {STATS_COLS.map((key, ci) => (
                            <td key={`stats-cell-${table.alias}-${ri}-${ci}`} style={{ fontSize: "0.78rem" }}>{row[key] ?? ""}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                );
              })()}
            </div>
          </details>
        );
      })}
      {workspaceTables.length > 0 ? (
        <>
          {workspaceTables.length >= 2 ? (
            <div className="column-search-wrap">
              <input
                type="text"
                className="column-search-input"
                placeholder="Search columns..."
                value={columnSearchQuery}
                onChange={(e) => setColumnSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") { setColumnSearchQuery(""); e.currentTarget.blur(); } }}
              />
              {columnSearchQuery ? (
                <button type="button" className="column-search-clear" onClick={() => setColumnSearchQuery("")}>x</button>
              ) : null}
            </div>
          ) : null}
          <div className="workspace-schema-summary">
            {(() => {
              const query = columnSearchQuery.trim().toLowerCase();
              const filtered = workspaceTables.filter((table) => {
                if (!query) return true;
                const schema = workspaceTableSchemas[table.alias] ?? [];
                return schema.some((col) => col.name.toLowerCase().includes(query));
              });
              if (query && filtered.length === 0) {
                return <span className="phase">No matching columns found.</span>;
              }
              return filtered.map((table) => {
                const schema = workspaceTableSchemas[table.alias] ?? [];
                if (schema.length === 0) {
                  return (
                    <span key={`workspace-schema-${table.alias}`} className="workspace-schema-pill"
                      title={`${table.alias}: schema unavailable`}>
                      <strong>{table.alias}</strong>: schema unavailable
                    </span>
                  );
                }
                const matchingCols = query
                  ? schema.filter((col) => col.name.toLowerCase().includes(query))
                  : schema;
                const displayCols = query ? matchingCols : schema.slice(0, 6);
                const suffix = !query && schema.length > 6 ? ", ..." : "";
                const countLabel = query ? ` (${matchingCols.length}/${schema.length})` : "";
                return (
                  <span
                    key={`workspace-schema-${table.alias}`}
                    className="workspace-schema-pill"
                    title={`${table.alias}: ${schema.map((c) => `${c.name} (${c.duckdb_type})`).join(", ")}`}
                  >
                    <strong>{table.alias}</strong>{countLabel}:{" "}
                    {displayCols.map((col, i) => (
                      <span key={col.name}>
                        {i > 0 ? ", " : ""}
                        <span className={query && col.name.toLowerCase().includes(query) ? "col-match" : ""}>
                          {col.name}
                        </span>
                      </span>
                    ))}
                    {suffix}
                  </span>
                );
              });
            })()}
          </div>
        </>
      ) : null}

      {INTERNAL_TOOLS_ENABLED ? (
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
      ) : null}

      {INTERNAL_TOOLS_ENABLED && workspaceSchemaDiff ? (
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
        <div className="workspace-editor" style={{ height: editorHeight, resize: "vertical", overflow: "hidden" }}
          onMouseUp={(e) => {
            const h = (e.currentTarget as HTMLDivElement).offsetHeight;
            if (h !== editorHeight) setEditorHeight(h);
          }}
        >
          <Editor
            height="100%"
            defaultLanguage="sql"
            defaultValue={workspaceSql}
            theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
            onMount={onWorkspaceEditorMount}
            onChange={(value) => setWorkspaceSql(value ?? "")}
            options={{
              automaticLayout: true,
              minimap: { enabled: false },
              wordWrap: "on",
              fontSize: editorFontSize,
              scrollBeyondLastLine: false,
              lineNumbers: "on",
            }}
          />
        </div>
        <div className="workspace-editor-controls">
          <button type="button" onClick={() => void runWorkspaceQuery()} disabled={loading}>
            Run SQL<kbd className="shortcut-hint">Ctrl+Enter</kbd>
          </button>
          <button type="button" onClick={() => void runExplainAnalyze()} disabled={loading || explainLoading}>
            Explain<kbd className="shortcut-hint">Ctrl+Shift+Enter</kbd>
          </button>
          <button type="button" onClick={() => void exportWorkspaceQuery("csv")} disabled={loading}>
            Export CSV<kbd className="shortcut-hint">Ctrl+Shift+E</kbd>
          </button>
          <button type="button" onClick={() => void exportWorkspaceQuery("parquet")} disabled={loading}>
            Export Parquet
          </button>
          <div style={{ position: "relative", display: "inline-block" }}>
            <button type="button" onClick={() => setHistoryOpen((p) => !p)} disabled={queryHistory.length === 0}>
              History ({queryHistory.length})
            </button>
            {historyOpen ? (
              <div style={{ position: "absolute", top: "100%", left: 0, zIndex: 100, background: "var(--surface-strong)", border: "1px solid var(--border)", borderRadius: 8, padding: 6, maxHeight: 280, overflowY: "auto", minWidth: 340, boxShadow: "0 8px 24px rgba(0,0,0,0.15)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <strong style={{ fontSize: "0.82rem" }}>Query History</strong>
                  <button type="button" style={{ padding: "2px 6px", fontSize: "0.72rem" }} onClick={() => { setQueryHistory([]); setHistoryOpen(false); }}>Clear</button>
                </div>
                {queryHistory.map((entry, idx) => (
                  <div key={`qh-${idx}`}
                    style={{ padding: "4px 6px", borderBottom: "1px solid var(--border)", cursor: "pointer", fontSize: "0.8rem" }}
                    onClick={() => { replaceWorkspaceSql(entry.sql); setHistoryOpen(false); }}
                  >
                    <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 320, fontFamily: "monospace" }}>
                      {entry.sql}
                    </div>
                    <div style={{ fontSize: "0.72rem", color: "var(--text-soft)" }}>
                      {new Date(entry.timestamp).toLocaleString()}
                      {entry.rowCount != null ? ` | ${entry.rowCount} rows` : ""}
                      {entry.elapsedMs != null ? ` | ${entry.elapsedMs.toFixed(0)}ms` : ""}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          {settings.showVisualization ? (
            <button type="button" onClick={() => void visualizeWorkspaceChart()} disabled={loading || workspaceQueryResult === null}>
              Visualize Data
            </button>
          ) : null}
        </div>
        {explainLoading ? (
          <div className="meta-line"><span className="phase">Running EXPLAIN ANALYZE...</span></div>
        ) : null}
        {explainPlan ? (
          <details open style={{ marginBottom: 8 }}>
            <summary style={{ cursor: "pointer", fontSize: "0.85rem", fontWeight: 600, marginBottom: 4 }}>
              EXPLAIN ANALYZE
              <button type="button" style={{ marginLeft: 8, padding: "1px 6px", fontSize: "0.72rem" }}
                onClick={(e) => { e.stopPropagation(); setExplainPlan(null); }}>Dismiss</button>
            </summary>
            <pre style={{ background: "var(--surface-tint)", border: "1px solid var(--border)", borderRadius: 8, padding: 10, fontSize: "0.78rem", overflow: "auto", maxHeight: 300, whiteSpace: "pre-wrap", margin: 0 }}>
              {explainPlan}
            </pre>
          </details>
        ) : null}
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

      {viewMode === "perspective" && settings.showVisualization ? (
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
            Re-Visualize
          </button>
          {workspaceNumericColumns.length === 0 && workspaceQueryResult ? (
            <span className="phase">No numeric columns detected; use Datagrid.</span>
          ) : null}
        </div>
      ) : null}

      {perspectiveContext === "workspace" && settings.showVisualization ? (
        <div
          className={`${viewMode === "perspective" ? "perspective-wrap" : "perspective-wrap hidden"}${expandedPanel === "perspective" ? (settings.expandMode === "resize" ? " resizable-panel" : " expanded-panel") : ""}`}
          style={expandedPanel === "perspective" ? { marginBottom: "8px" } : { height: `${Math.max(360, Math.floor(viewportHeight * 0.8))}px`, marginBottom: "8px" }}
        >
          {viewMode === "perspective" ? (
            <button type="button" className="expand-btn perspective-expand-btn"
              title={expandedPanel === "perspective" ? (settings.expandMode === "fullscreen" ? "Exit fullscreen (Esc)" : "Collapse") : "Expand chart"}
              onClick={() => setExpandedPanel(expandedPanel === "perspective" ? null : "perspective")}>
              {expandedPanel === "perspective" ? "\u2716" : (settings.expandMode === "resize" ? "\u2922" : "\u26F6")}
            </button>
          ) : null}
          <perspective-viewer ref={perspectiveViewerRef} className="perspective-viewer" />
        </div>
      ) : null}

      {workspaceQueryResult ? (
        <div className={expandedPanel === "sql-results" ? `sql-results-section ${settings.expandMode === "resize" ? "resizable-panel" : "expanded-panel"}` : "sql-results-section"}>
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
            <button type="button" style={{ padding: "2px 7px", fontSize: "0.76rem" }}
              onClick={() => void copyToClipboard(workspaceQueryResult.schema.map((c) => c.name).join(", "))}>
              Copy All Columns
            </button>
            <button type="button" className="expand-btn" title={expandedPanel === "sql-results" ? (settings.expandMode === "fullscreen" ? "Exit fullscreen (Esc)" : "Collapse") : "Expand results"}
              onClick={() => setExpandedPanel(expandedPanel === "sql-results" ? null : "sql-results")}>
              {expandedPanel === "sql-results" ? "\u2716" : (settings.expandMode === "resize" ? "\u2922" : "\u26F6")}
            </button>
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {workspaceQueryResult.schema.map((col) => (
                    <th key={`workspace-col-${col.name}`} title={`${col.duckdb_type} — click to copy`}
                      className="col-copyable"
                      onClick={() => void copyToClipboard(col.name)}>
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
        </div>
      ) : null}
    </section>
  );

  return (
    <main className={expandedPanel && settings.expandMode === "fullscreen" ? "app-shell panel-maximized" : "app-shell"}>
      <header className="topbar">
        <h1>Parq-Bench — High-Performance Local Data Lake</h1>
        <div className="topbar-right">
          <label className="theme-picker">
            Theme
            <select value={themeMode} onChange={(event) => setThemeMode(event.currentTarget.value as ThemeMode)}>
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <button type="button" onClick={() => setSettingsOpen(true)}>
            Settings<kbd className="shortcut-hint">Ctrl+,</kbd>
          </button>
          <button type="button" onClick={() => setAboutOpen(true)}>
            About
          </button>
          <span className="beta-badge">{PRODUCT_STAGE_LABEL} v0.3.0</span>
        </div>
      </header>

      <nav className="tab-bar">
        <button
          type="button"
          className={activeTab === "preview" ? "tab-button tab-active" : "tab-button"}
          onClick={() => setActiveTab("preview")}
        >
          Preview<kbd className="shortcut-hint">Ctrl+1</kbd>
        </button>
        <button
          type="button"
          className={activeTab === "sql" ? "tab-button tab-active" : "tab-button"}
          onClick={() => setActiveTab("sql")}
        >
          SQL<kbd className="shortcut-hint">Ctrl+2</kbd>
        </button>
      </nav>

      {actionsPanel}

      <div className="tab-content">
        <div ref={previewPaneRef} className={activeTab === "preview" ? "tab-pane tab-pane-visible" : "tab-pane tab-pane-hidden"}>
          {previewPanel}
          {dragOverZone === "preview" ? (
            <div className="drop-overlay">
              <span>Drop .parquet file to preview</span>
            </div>
          ) : null}
        </div>
        <div ref={sqlPaneRef} className={activeTab === "sql" ? "tab-pane tab-pane-visible" : "tab-pane tab-pane-hidden"}>
          {workspacePanel}
          {dragOverZone === "sql" ? (
            <div className="drop-overlay">
              <span>Drop files to mount as workspace tables</span>
            </div>
          ) : null}
        </div>
      </div>

      {settingsOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setSettingsOpen(false)}>
          <section
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            onClick={(event) => event.stopPropagation()}
          >
            <h3>Settings</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, margin: "12px 0" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.85rem" }}>
                SQL Row Limit
                <input type="number" min={1} max={100000} value={settings.sqlRowLimit}
                  onChange={(e) => setSettings((s) => ({ ...s, sqlRowLimit: Math.max(1, parseInt(e.target.value) || 200) }))}
                  style={{ width: 120 }}
                />
                <span className="phase">Maximum rows returned by workspace queries (default: 200)</span>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.85rem" }}>
                Perspective Max Rows
                <input type="number" min={100} max={100000} value={settings.perspectiveMaxRows}
                  onChange={(e) => setSettings((s) => ({ ...s, perspectiveMaxRows: Math.max(100, parseInt(e.target.value) || 5000) }))}
                  style={{ width: 120 }}
                />
                <span className="phase">Maximum rows loaded into Perspective viewer (default: 5000). Higher values increase memory usage.</span>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.85rem" }}>
                Editor Font Size
                <input type="number" min={8} max={32} value={settings.editorFontSize}
                  onChange={(e) => {
                    const v = Math.min(32, Math.max(8, parseInt(e.target.value) || 13));
                    setSettings((s) => ({ ...s, editorFontSize: v }));
                    setEditorFontSize(v);
                    workspaceEditorRef.current?.updateOptions({ fontSize: v });
                  }}
                  style={{ width: 120 }}
                />
                <span className="phase">Monaco editor font size in pixels (default: 13)</span>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.85rem" }}>
                Expand Mode
                <select value={settings.expandMode}
                  onChange={(e) => setSettings((s) => ({ ...s, expandMode: e.target.value as "fullscreen" | "resize" }))}
                  style={{ width: 160 }}
                >
                  <option value="fullscreen">Fullscreen</option>
                  <option value="resize">Resize</option>
                </select>
                <span className="phase">Fullscreen: fixed overlay (default). Resize: drag-to-resize panels.</span>
              </label>
              <label style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 8, fontSize: "0.85rem", cursor: "pointer" }}>
                <input type="checkbox" checked={settings.showPerspectiveConfigure}
                  onChange={(e) => setSettings((s) => ({ ...s, showPerspectiveConfigure: e.target.checked }))}
                />
                Show Perspective Configure Button
                <span className="phase" style={{ marginLeft: "auto" }}>Toggle visibility of Perspective's built-in settings button</span>
              </label>
              <label style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 8, fontSize: "0.85rem", cursor: "pointer" }}>
                <input type="checkbox" checked={settings.showVisualization}
                  onChange={(e) => setSettings((s) => ({ ...s, showVisualization: e.target.checked }))}
                />
                Show Visualization
                <span className="phase" style={{ marginLeft: "auto" }}>Show Visualize Data button and chart controls in workspace</span>
              </label>
              <div style={{ fontSize: "0.84rem", color: "var(--text-soft)", padding: "6px 0", borderTop: "1px solid var(--border)" }}>
                Memory guard threshold: 85% (read-only, configured in backend)
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" onClick={() => {
                setSettings({ ...DEFAULT_SETTINGS });
                setEditorFontSize(DEFAULT_SETTINGS.editorFontSize);
                workspaceEditorRef.current?.updateOptions({ fontSize: DEFAULT_SETTINGS.editorFontSize });
              }}>
                Reset to Defaults
              </button>
              <button type="button" onClick={() => setSettingsOpen(false)}>
                Close
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {aboutOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setAboutOpen(false)}>
          <section
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-label="About Parq-Bench"
            onClick={(event) => event.stopPropagation()}
          >
            <h3>Parq-Bench</h3>
            <span className="beta-badge" style={{ marginBottom: 12, alignSelf: "flex-start" }}>{PRODUCT_STAGE_LABEL} v0.3.0</span>
            <p style={{ margin: "8px 0", lineHeight: 1.5 }}>
              A high-performance desktop application for exploring and querying Parquet and CSV files locally.
              No cloud, no accounts, no telemetry — all processing happens on your machine.
            </p>
            <p style={{ margin: "8px 0", lineHeight: 1.5, color: "var(--text-soft)" }}>
              Built by{" "}
              <a
                href="#"
                onClick={(e) => { e.preventDefault(); void openUrl("https://www.keepitsimpleanalytics.com/"); }}
                style={{ color: "var(--accent)" }}
              >
                KISA — Keep it Simple Analytics
              </a>
            </p>
            <div style={{ margin: "8px 0", fontSize: "0.82rem", color: "var(--text-soft)" }}>
              <strong style={{ fontSize: "0.84rem" }}>Tech Stack</strong>
              <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 12px", marginTop: 4 }}>
                <span>Tauri</span><span>v2</span>
                <span>DuckDB</span><span>{result?.duckdb_version ?? "—"}</span>
                <span>React</span><span>19</span>
                <span>Perspective</span><span>Streaming analytics</span>
                <span>Monaco</span><span>SQL editor</span>
              </div>
            </div>
            <div style={{ margin: "8px 0", fontSize: "0.82rem", color: "var(--text-soft)" }}>
              <strong style={{ fontSize: "0.84rem" }}>Keyboard Shortcuts</strong>
              <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 12px", marginTop: 4 }}>
                <kbd className="shortcut-hint" style={{ fontSize: "0.78rem" }}>Ctrl+O</kbd><span>Open Parquet file</span>
                <kbd className="shortcut-hint" style={{ fontSize: "0.78rem" }}>Ctrl+1</kbd><span>Preview tab</span>
                <kbd className="shortcut-hint" style={{ fontSize: "0.78rem" }}>Ctrl+2</kbd><span>SQL Workspace tab</span>
                <kbd className="shortcut-hint" style={{ fontSize: "0.78rem" }}>Ctrl+Enter</kbd><span>Run SQL query</span>
                <kbd className="shortcut-hint" style={{ fontSize: "0.78rem" }}>Ctrl+Shift+Enter</kbd><span>Explain Analyze</span>
                <kbd className="shortcut-hint" style={{ fontSize: "0.78rem" }}>Ctrl+Shift+E</kbd><span>Export query as CSV</span>
                <kbd className="shortcut-hint" style={{ fontSize: "0.78rem" }}>Ctrl+,</kbd><span>Settings</span>
                <kbd className="shortcut-hint" style={{ fontSize: "0.78rem" }}>Esc</kbd><span>Close modal / exit fullscreen</span>
              </div>
            </div>
            <p style={{ margin: "8px 0", fontSize: "0.84rem", color: "var(--text-soft)" }}>
              Licensed under{" "}
              <a href="#" onClick={(e) => { e.preventDefault(); void openUrl("https://github.com/KeepitSimpleAnalytics/parq_bench/blob/main/LICENSE"); }} style={{ color: "var(--accent)" }}>GPLv3</a>.
              {" "}We believe great tools should be open and accessible to everyone.
            </p>
            <p style={{ margin: "4px 0", fontSize: "0.82rem" }}>
              <a href="#" onClick={(e) => { e.preventDefault(); void openUrl("https://github.com/KeepitSimpleAnalytics/parq_bench"); }} style={{ color: "var(--accent)" }}>
                GitHub Repository
              </a>
              {" — "}
              <a href="#" onClick={(e) => { e.preventDefault(); void openUrl("https://github.com/KeepitSimpleAnalytics/parq_bench/issues"); }} style={{ color: "var(--accent)" }}>
                Report an Issue
              </a>
            </p>
            <div className="modal-actions">
              <button type="button" onClick={() => setAboutOpen(false)}>
                Close
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

export default App;
