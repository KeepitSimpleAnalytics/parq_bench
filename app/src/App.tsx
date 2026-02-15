import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { tableFromIPC } from "apache-arrow";
import type * as Monaco from "monaco-editor";
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
  file_size_bytes: number | null;
};

type WorkspaceSchemaByAlias = Record<string, PreviewColumn[]>;

type WorkspaceQueryResponse = {
  sql: string;
  row_limit: number;
  row_count: number;
  truncated: boolean;
  elapsed_ms: number;
  schema: PreviewColumn[];
  rows: Array<Array<string | null>>;
};

type WorkspaceChartPlugin = "Datagrid" | "Y Bar" | "X Bar" | "Line" | "Treemap";

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

function App() {
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
  const perspectiveViewerRef = useRef<HTMLElement | null>(null);
  const perspectiveTableRef = useRef<{ delete?: () => Promise<void> | void } | null>(null);
  const memoryGuardRef = useRef(false);
  const openStartRef = useRef<number | null>(null);
  const perspectiveStatusRef = useRef<PerspectiveStatus>("idle");
  const perspectiveErrorRef = useRef<string | null>(null);
  const perspectiveReadyMsRef = useRef<number | null>(null);
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
    const selected = await open({
      title: "Select Workspace Table Source",
      multiple: false,
      filters: [{ name: "Parquet", extensions: ["parquet"] }],
    });
    if (selected && !Array.isArray(selected)) {
      setWorkspacePathInput(selected);
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
      await invoke<WorkspaceTableInfo>("register_workspace_table", {
        alias: workspaceAliasInput.trim(),
        filePath: workspacePathInput.trim(),
        isGlob: workspaceIsGlob,
      });
      await refreshWorkspaceTables();
      const alias = workspaceAliasInput.trim();
      if (!readWorkspaceSql().includes(alias)) {
        replaceWorkspaceSql(`SELECT * FROM ${alias} LIMIT 100`);
      }
      setWorkspaceAliasInput("");
      setWorkspacePathInput("");
      setWorkspaceIsGlob(false);
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
      if (options?.context) {
        setPerspectiveContext(options.context);
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

      const viewer = perspectiveViewerRef.current as
        | (HTMLElement & {
            load?: (table: unknown) => Promise<void>;
            restore?: (config: unknown) => Promise<void>;
          })
        | null;

      if (!viewer || !viewer.load || !viewer.restore) {
        throw new Error("Perspective viewer did not initialize.");
      }

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
      await withTimeout("viewer.restore()", viewer.restore(restoreConfig));
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
      setPerspectiveStatus("error");
      setPerspectiveStage("error");
      setPerspectiveError(`stage=${stage} ${String(err)}`);
      setError(`Perspective error: stage=${stage} ${String(err)}`);
      setViewMode("virtual");
    }
  }

  async function loadPreviewFromPath(filePath: string): Promise<number> {
    openStartRef.current = performance.now();
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
        return { status: "ready", readyMs: perspectiveReadyMsRef.current, error: null };
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
    if (!preview || perspectiveLoadedForFile === preview.file_path || perspectiveStatus !== "idle") {
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
  }, [loadedRows, perspectiveLoadedForFile, perspectiveStatus, preview]);

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

  return (
    <main className="app-shell">
      <header className="topbar">
        <h1>Parq-Bench</h1>
        <span className="phase">Phase 3 Hardening</span>
      </header>

      <section className="card">
        <div className="actions">
          <button type="button" onClick={() => void openParquetPreview()} disabled={loading || memoryGuardActive}>
            Open Parquet
          </button>
          <button type="button" onClick={() => void runAcceptanceGate()} disabled={loading || memoryGuardActive}>
            {loading ? "Running..." : "Run Acceptance Gate"}
          </button>
          <div className="perf-sweep-controls">
            <label htmlFor="perf-sweep-runs">Runs</label>
            <input
              id="perf-sweep-runs"
              type="number"
              className="perf-sweep-input"
              min={PERF_SWEEP_MIN_RUNS}
              max={PERF_SWEEP_MAX_RUNS}
              value={perfSweepRunsInput}
              onChange={(event) => setPerfSweepRunsInput(event.currentTarget.value)}
              disabled={loading || memoryGuardActive}
            />
            <button type="button" onClick={() => void runPerfSweep()} disabled={loading || memoryGuardActive}>
              {loading ? "Running..." : "Run Perf Sweep"}
            </button>
          </div>
          <button
            type="button"
            onClick={() =>
              void (async () => {
                setLoading(true);
                setError(null);
                try {
                  await runSmokeQuery();
                  await runArrowIpcSmoke();
                  await runTransportBenchmarks();
                } catch (err) {
                  setError(String(err));
                } finally {
                  setLoading(false);
                }
              })()
            }
            disabled={loading || memoryGuardActive}
          >
            {loading ? "Running..." : "Run Smoke Checks"}
          </button>
          <button type="button" onClick={() => void exportResults("json")} disabled={loading || !canExportResults}>
            Export JSON
          </button>
          <button type="button" onClick={() => void exportResults("csv")} disabled={loading || !canExportResults}>
            Export CSV
          </button>
          {preview ? (
            <>
              <button
                type="button"
                onClick={() => setViewMode("virtual")}
                disabled={viewMode === "virtual"}
              >
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

        {runtimeHealth ? (
          <div className={memoryGuardActive ? "health-banner health-bad" : "health-banner"}>
            Memory usage: {memoryUsagePct?.toFixed(1)}%
            {runtimeHealth.message ? ` | ${runtimeHealth.message}` : ""}
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
            Perf Sweep {perfSweepReport.failCount === 0 ? "PASS" : "FAIL"} | Runs:{" "}
            {perfSweepReport.completedRuns}/{perfSweepReport.runCount} | Pass: {perfSweepReport.passCount} | First
            p50/p95:{" "}
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
                {firstViewportMs === null
                  ? "pending"
                  : `${firstViewportMs.toFixed(0)}ms / target ${FIRST_VIEWPORT_TARGET_MS}ms`}
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
                      <div
                        key={col.name}
                        className="virtual-cell virtual-cell-head"
                        title={col.duckdb_type}
                      >
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
                  <div
                    className="virtual-spacer"
                    style={{ height: `${totalRows * ROW_HEIGHT}px`, width: `${gridContentWidth}px` }}
                  >
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
                            <div
                              key={`virtual-cell-${index}-${col.name}`}
                              className="virtual-cell"
                              title={row?.[colIndex] ?? "NULL"}
                            >
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
        ) : null}

        <section className="workspace-panel">
          <h3>Workspace Explorer</h3>
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
              placeholder="parquet file path or glob"
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
                    <strong>{table.alias}</strong>:{" "}
                    {schema.length === 0 ? "schema unavailable" : `${columnsPreview}${suffix}`}
                  </span>
                );
              })}
            </div>
          ) : null}

          <div className="workspace-diff-row">
            <label>
              Diff Left
              <select
                value={workspaceDiffLeftAlias}
                onChange={(event) => setWorkspaceDiffLeftAlias(event.currentTarget.value)}
              >
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
              <select
                value={workspaceDiffRightAlias}
                onChange={(event) => setWorkspaceDiffRightAlias(event.currentTarget.value)}
              >
                <option value="">Select table</option>
                {workspaceTables.map((table) => (
                  <option key={`diff-right-${table.alias}`} value={table.alias}>
                    {table.alias}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => void runWorkspaceSchemaDiff()}
              disabled={loading || workspaceTables.length < 2}
            >
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
              <select
                value={workspaceChartPlugin}
                onChange={(event) => setWorkspaceChartPlugin(event.currentTarget.value as WorkspaceChartPlugin)}
              >
                <option value="Datagrid">Datagrid</option>
                <option value="Y Bar">Y Bar</option>
                <option value="X Bar">X Bar</option>
                <option value="Line">Line</option>
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
            <button
              type="button"
              onClick={() => void visualizeWorkspaceChart()}
              disabled={loading || workspaceQueryResult === null}
            >
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

        <details className="diagnostics">
          <summary>Diagnostics</summary>
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
        </details>
      </section>
    </main>
  );
}

export default App;
