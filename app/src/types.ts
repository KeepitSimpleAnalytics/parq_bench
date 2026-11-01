import type * as Monaco from "monaco-editor";

export type SmokeRow = {
  id: number;
  label: string;
};

export type SmokeQueryResponse = {
  duckdb_version: string;
  rows: SmokeRow[];
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
  /** null for URLs (no local file to measure). */
  file_size_bytes: number | null;
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
  /** http(s):// source, read through the on-demand httpfs extension. */
  is_remote: boolean;
  source_kind: WorkspaceSourceKind;
  delimiter: string | null;
  /** Excel sheet or SQLite table/view name. */
  object_name: string | null;
  /** Excel only: first row holds column names. */
  header: boolean | null;
  /** null for folders, URLs and Delta tables. */
  file_size_bytes: number | null;
  /** From Parquet footer metadata; null for other sources. */
  row_count: number | null;
};

export type SourcePeekResponse = {
  source_kind: WorkspaceSourceKind;
  detected_delimiter: string | null;
  has_header: boolean | null;
  matched_files: number | null;
  row_count: number | null;
  schema: PreviewColumn[];
  rows: Array<Array<string | null>>;
};

export type WorkspaceSchemaByAlias = Record<string, PreviewColumn[]>;
export type WorkspaceSourceKind = "parquet" | "delimited" | "excel" | "sqlite" | "delta";

/** What the Add table dialog sends to register_workspace_table. */
export type RegisterTableRequest = {
  alias: string;
  filePath: string;
  isGlob: boolean;
  sourceKind: WorkspaceSourceKind;
  delimiter?: string;
  /** Excel sheet or SQLite table/view. */
  objectName?: string;
  /** Excel only. */
  header?: boolean;
};

export type SqliteObject = { name: string; kind: "table" | "view" };

export type ExtensionStatus = {
  name: string;
  installed: boolean;
  loaded: boolean;
  size_bytes: number | null;
};

export type ExportFormat = "csv" | "parquet" | "xlsx";

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
  format: ExportFormat;
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
export type ResultTab = "results" | "chart" | "plan";

export type RecentFile = {
  path: string;
  /** Size in bytes when last opened; null for entries saved by older versions. */
  sizeBytes: number | null;
  /** Epoch ms when last opened; null for entries saved by older versions. */
  openedAt: number | null;
};

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
  deepStats: boolean;
};

export type SummarizeRow = Record<string, string>;

export type WorkspaceEditorRef = Monaco.editor.IStandaloneCodeEditor | null;
export type WorkspaceMonacoRef = typeof Monaco | null;
