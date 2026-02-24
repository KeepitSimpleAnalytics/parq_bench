import type * as Monaco from "monaco-editor";

export type SmokeRow = {
  id: number;
  label: string;
};

export type SmokeQueryResponse = {
  duckdb_version: string;
  rows: SmokeRow[];
};

export type ArrowRow = {
  id: number;
  label: string;
};

export type BenchmarkResult = {
  mode: "ipc" | "socket";
  sizeMb: number;
  bytes: number;
  elapsedMs: number;
  throughputMbps: number;
};

export type RuntimeHealth = {
  memory_guard_tripped: boolean;
  process_rss_bytes: number;
  total_memory_bytes: number;
  usage_ratio: number;
  message: string | null;
};

export type PreviewColumn = {
  name: string;
  duckdb_type: string;
};

export type PreviewResponse = {
  file_path: string;
  file_size_bytes: number;
  total_rows: number;
  row_offset: number;
  row_limit: number;
  schema: PreviewColumn[];
  rows: Array<Array<string | null>>;
};

export type ParquetRowsTransport = {
  mode: "ipc" | "socket";
  payload_bytes: number;
  ipc_payload: number[] | null;
  socket_url: string | null;
  row_offset: number;
  row_limit: number;
  row_count: number;
};

export type ViewMode = "virtual" | "perspective";
export type PerspectiveStatus = "idle" | "loading" | "ready" | "error";
export type PerspectiveContext = "preview" | "workspace";
export type GatePerspectiveStatus = "ready" | "error" | "timeout";

export type AcceptanceGateReport = {
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

export type PerfSweepSummary = {
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

export type WorkspaceTableInfo = {
  alias: string;
  file_path: string;
  is_glob: boolean;
  source_kind: "parquet" | "delimited";
  delimiter: string | null;
  file_size_bytes: number | null;
};

export type WorkspaceSchemaByAlias = Record<string, PreviewColumn[]>;
export type WorkspaceSourceKind = "parquet" | "delimited";

export type WorkspaceQueryResponse = {
  sql: string;
  row_limit: number;
  row_count: number;
  truncated: boolean;
  elapsed_ms: number;
  schema: PreviewColumn[];
  rows: Array<Array<string | null>>;
};

export type WorkspaceChartPlugin = "Datagrid" | "Y Bar" | "X Bar" | "Y Line" | "Treemap";

export type WorkspaceSchemaDiffColumn = {
  name: string;
  left_type: string | null;
  right_type: string | null;
  change: "added" | "removed" | "type_changed" | "unchanged";
};

export type WorkspaceSchemaDiffResponse = {
  left_alias: string;
  right_alias: string;
  added_count: number;
  removed_count: number;
  type_changed_count: number;
  unchanged_count: number;
  columns: WorkspaceSchemaDiffColumn[];
};

export type WorkspaceExportResponse = {
  sql: string;
  format: "csv" | "parquet";
  output_path: string;
  file_size_bytes: number;
  elapsed_ms: number;
};

export type ExportPayload = {
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

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export type ActiveTab = "preview" | "sql";

export type QueryHistoryEntry = {
  sql: string;
  timestamp: number;
  rowCount?: number;
  elapsedMs?: number;
};

export type AppSettings = {
  sqlRowLimit: number;
  perspectiveMaxRows: number;
  editorFontSize: number;
  expandMode: "fullscreen" | "resize";
  showPerspectiveConfigure: boolean;
  showVisualization: boolean;
};

export type SummarizeRow = Record<string, string>;

export type WorkspaceEditorRef = Monaco.editor.IStandaloneCodeEditor | null;
export type WorkspaceMonacoRef = typeof Monaco | null;
