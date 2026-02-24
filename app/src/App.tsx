import { useEffect, useRef, useState } from "react";
import Editor, { loader, type OnMount } from "@monaco-editor/react";
import * as monacoEditor from "monaco-editor";
loader.config({ monaco: monacoEditor });
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { tableFromIPC } from "apache-arrow";
import type * as Monaco from "monaco-editor";
import "./App.css";

import type {
  SmokeQueryResponse,
  ArrowRow,
  PreviewColumn,
  PreviewResponse,
  ViewMode,
  AcceptanceGateReport,
  WorkspaceTableInfo,
  WorkspaceSchemaByAlias,
  WorkspaceQueryResponse,
  WorkspaceChartPlugin,
  ExportPayload,
  ThemeMode,
  ActiveTab,
  QueryHistoryEntry,
  AppSettings,
} from "./types";
import {
  PAGE_SIZE,
  FIRST_VIEWPORT_TARGET_MS,
  PERSPECTIVE_READY_TARGET_MS,
  ACCEPTANCE_GATE_TIMEOUT_MS,
  UI_ACTIVE_TAB_STORAGE_KEY,
  UI_RECENT_FILES_STORAGE_KEY,
  UI_QUERY_HISTORY_STORAGE_KEY,
  UI_SETTINGS_STORAGE_KEY,
  UI_WORKSPACE_SLOW_MODE_STORAGE_KEY,
  RECENT_FILES_MAX,
  QUERY_HISTORY_MAX,
  INTERNAL_TOOLS_ENABLED,
  PRODUCT_STAGE_LABEL,
} from "./constants";
import {
  detectSourceKind,
  readActiveTab,
  readWorkspaceSlowModeEnabled,
  readRecentFiles,
  readQueryHistory,
  readSettings,
  sqlIdentifierInsertText,
  isNumericDuckType,
  escapeCsvCell,
  waitForNextPaint,
} from "./utils";
import { useTheme } from "./hooks/useTheme";
import { useLocalStorageSync } from "./hooks/useLocalStorageSync";
import { useRuntimeHealth } from "./hooks/useRuntimeHealth";
import { useVirtualScroll } from "./hooks/useVirtualScroll";
import { SettingsModal } from "./components/SettingsModal";
import { AboutModal } from "./components/AboutModal";
import { QueryHistoryDropdown } from "./components/QueryHistoryDropdown";
import { VirtualScrollGrid } from "./components/VirtualScrollGrid";
import { SqlResultsTable } from "./components/SqlResultsTable";
import { usePerspective } from "./hooks/usePerspective";
import { useWorkspace } from "./hooks/useWorkspace";
import { useDragDrop } from "./hooks/useDragDrop";
import { WorkspaceTableRegistry } from "./components/WorkspaceTableRegistry";



function App() {
  // Extracted hooks
  const { themeMode, resolvedTheme, setThemeMode } = useTheme();
  const { runtimeHealth, memoryGuardActive, memoryGuardRef, refreshRuntimeHealth } = useRuntimeHealth();

  const [activeTab, setActiveTab] = useState<ActiveTab>(() => readActiveTab());
  const [result, setResult] = useState<SmokeQueryResponse | null>(null);
  const [, setArrowRows] = useState<ArrowRow[]>([]);
  const [, setArrowBytes] = useState(0);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("virtual");
  const [firstViewportMs, setFirstViewportMs] = useState<number | null>(null);
  const [acceptanceGate, setAcceptanceGate] = useState<AcceptanceGateReport | null>(null);
  const [, setLastExportPath] = useState<string | null>(null);
  const [workspaceTables, setWorkspaceTables] = useState<WorkspaceTableInfo[]>([]);
  const [workspaceTableSchemas, setWorkspaceTableSchemas] = useState<WorkspaceSchemaByAlias>({});
  const [workspaceSlowModeEnabled, setWorkspaceSlowModeEnabled] = useState<boolean>(
    () => readWorkspaceSlowModeEnabled(),
  );
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
  const [aboutOpen, setAboutOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recentFiles, setRecentFiles] = useState<string[]>(() => readRecentFiles());
  const [queryHistory, setQueryHistory] = useState<QueryHistoryEntry[]>(() => readQueryHistory());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [explainPlan, setExplainPlan] = useState<string | null>(null);
  const [explainLoading, setExplainLoading] = useState(false);
  const [expandedPanel, setExpandedPanel] = useState<"preview-table" | "perspective" | "sql-results" | null>(null);

  // Virtual scroll hook
  const {
    loadedRows, scrollLeft, setScrollTop, setScrollLeft,
    viewportHeight, visibleIndices, totalRows, gridContentWidth,
    columnGridTemplate, resetScroll, setInitialPage, setInFlightPages,
  } = useVirtualScroll({ preview, memoryGuardRef, onError: setError });

  const previewPaneRef = useRef<HTMLDivElement | null>(null);
  const sqlPaneRef = useRef<HTMLDivElement | null>(null);
  const openStartRef = useRef<number | null>(null);
  const workspaceEditorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const workspaceMonacoRef = useRef<typeof Monaco | null>(null);
  const workspaceCompletionRef = useRef<Monaco.IDisposable | null>(null);

  // Perspective lifecycle hook
  const {
    perspectiveStatus, perspectiveStage, perspectiveError,
    perspectiveContext, perspectiveReadyMs,
    perspectiveViewerRef, loadPerspectiveDataset,
    waitForPerspectiveResult, resetPerspective,
  } = usePerspective({
    preview, loadedRows, firstViewportMs, openStartRef, settings,
    onError: setError,
    onViewModeChange: setViewMode,
  });

  // localStorage sync for simple values
  useLocalStorageSync(UI_ACTIVE_TAB_STORAGE_KEY, activeTab);
  useLocalStorageSync(UI_RECENT_FILES_STORAGE_KEY, JSON.stringify(recentFiles));
  useLocalStorageSync(UI_QUERY_HISTORY_STORAGE_KEY, JSON.stringify(queryHistory));
  useLocalStorageSync(UI_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  useLocalStorageSync(UI_WORKSPACE_SLOW_MODE_STORAGE_KEY, workspaceSlowModeEnabled ? "1" : "0");

  // Workspace chart/diff/export hook
  const {
    workspaceChartPlugin, setWorkspaceChartPlugin,
    workspaceChartX, setWorkspaceChartX,
    workspaceChartY, setWorkspaceChartY,
    workspaceChartAgg, setWorkspaceChartAgg,
    workspaceDiffLeftAlias, setWorkspaceDiffLeftAlias,
    workspaceDiffRightAlias, setWorkspaceDiffRightAlias,
    workspaceSchemaDiff,
    workspaceExport,
    runWorkspaceSchemaDiff,
    exportWorkspaceQuery,
    visualizeWorkspaceChart,
  } = useWorkspace({
    workspaceTables, workspaceQueryResult, readWorkspaceSql,
    loadPerspectiveDataset, setLoading, setError,
  });

  // Drag-and-drop hook
  const { dragOverZone } = useDragDrop({
    activeTab, previewPaneRef, sqlPaneRef,
    onPreviewDrop: (paths) => void handlePreviewDrop(paths),
    onSqlDrop: (paths) => void handleSqlDrop(paths),
  });

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


  async function loadPreviewFromPath(filePath: string): Promise<number> {
    openStartRef.current = performance.now();
    resetPerspective();
    setFirstViewportMs(null);

    const data = await invoke<PreviewResponse>("preview_parquet", {
      filePath,
      rowLimit: PAGE_SIZE,
    });
    setPreview(data);
    setRecentFiles((prev) => {
      const filtered = prev.filter((p) => p !== filePath);
      return [filePath, ...filtered].slice(0, RECENT_FILES_MAX);
    });
    setViewMode("virtual");
    setInitialPage(data);

    await waitForNextPaint();
    const elapsed = openStartRef.current === null ? 0 : performance.now() - openStartRef.current;
    setFirstViewportMs(elapsed);
    return elapsed;
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

  const canExportResults = true;
  const workspaceColumns = workspaceQueryResult?.schema ?? [];
  const workspaceNumericColumns = workspaceColumns.filter((column) =>
    isNumericDuckType(column.duckdb_type),
  );

  useEffect(() => {
    if (runtimeHealth?.memory_guard_tripped) {
      setInFlightPages(new Set());
      if (runtimeHealth.message) {
        setError(runtimeHealth.message);
      }
    }
  }, [runtimeHealth]);

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
              resetPerspective();
              setFirstViewportMs(null);
              resetScroll();
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
            <VirtualScrollGrid
              schema={preview.schema}
              loadedRows={loadedRows}
              visibleIndices={visibleIndices}
              totalRows={totalRows}
              scrollLeft={scrollLeft}
              gridContentWidth={gridContentWidth}
              columnGridTemplate={columnGridTemplate}
              onScroll={(st, sl) => { setScrollTop(st); setScrollLeft(sl); }}
              onCopyColumn={(name) => void copyToClipboard(name)}
            />
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
      <WorkspaceTableRegistry
        tables={workspaceTables}
        schemas={workspaceTableSchemas}
        loading={loading}
        workspaceSlowModeEnabled={workspaceSlowModeEnabled}
        onSlowModeChange={setWorkspaceSlowModeEnabled}
        onRegister={async (alias, filePath, isGlob, sourceKind, delimiter) => {
          setLoading(true);
          setError(null);
          try {
            await invoke("register_workspace_table", { alias, filePath, isGlob, sourceKind, delimiter });
            await refreshWorkspaceTables();
            if (!readWorkspaceSql().includes(alias)) {
              replaceWorkspaceSql(`SELECT * FROM ${alias} LIMIT 100`);
            }
          } catch (err) { setError(String(err)); }
          finally { setLoading(false); }
        }}
        onRemove={async (alias) => {
          setLoading(true); setError(null);
          try { await invoke("remove_workspace_table", { alias }); await refreshWorkspaceTables(); }
          catch (err) { setError(String(err)); }
          finally { setLoading(false); }
        }}
        onRename={async (oldAlias, newAlias) => {
          setLoading(true); setError(null);
          try { await invoke("rename_workspace_table", { oldAlias, newAlias }); await refreshWorkspaceTables(); }
          catch (err) { setError(String(err)); }
          finally { setLoading(false); }
        }}
        onClearAll={async () => {
          if (!window.confirm(`Remove all ${workspaceTables.length} workspace tables?`)) return;
          setLoading(true); setError(null);
          const errors: string[] = [];
          for (const table of workspaceTables) {
            try { await invoke("remove_workspace_table", { alias: table.alias }); }
            catch (err) { errors.push(`${table.alias}: ${String(err)}`); }
          }
          await refreshWorkspaceTables();
          if (errors.length > 0) setError(errors.join(" | "));
          setLoading(false);
        }}
        onRemoveSelected={async (aliases) => {
          setLoading(true); setError(null);
          const errors: string[] = [];
          for (const alias of aliases) {
            try { await invoke("remove_workspace_table", { alias }); }
            catch (err) { errors.push(`${alias}: ${String(err)}`); }
          }
          await refreshWorkspaceTables();
          if (errors.length > 0) setError(errors.join(" | "));
          setLoading(false);
        }}
        onError={setError}
        schemaDiff={{
          leftAlias: workspaceDiffLeftAlias,
          rightAlias: workspaceDiffRightAlias,
          result: workspaceSchemaDiff,
          setLeftAlias: setWorkspaceDiffLeftAlias,
          setRightAlias: setWorkspaceDiffRightAlias,
          run: () => void runWorkspaceSchemaDiff(),
        }}
      />

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
          <QueryHistoryDropdown
            history={queryHistory}
            open={historyOpen}
            onToggle={() => setHistoryOpen((p) => !p)}
            onSelect={(sql) => { replaceWorkspaceSql(sql); setHistoryOpen(false); }}
            onClear={() => { setQueryHistory([]); setHistoryOpen(false); }}
          />
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
        <SqlResultsTable
          result={workspaceQueryResult}
          expandedPanel={expandedPanel}
          expandMode={settings.expandMode}
          onToggleExpand={() => setExpandedPanel(expandedPanel === "sql-results" ? null : "sql-results")}
          onCopyColumns={(text) => void copyToClipboard(text)}
        />
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

      <SettingsModal
        open={settingsOpen}
        settings={settings}
        onSettingsChange={setSettings}
        onClose={() => setSettingsOpen(false)}
        onEditorFontSizeChange={setEditorFontSize}
        editorRef={workspaceEditorRef}
      />

      <AboutModal
        open={aboutOpen}
        onClose={() => setAboutOpen(false)}
        duckdbVersion={result?.duckdb_version ?? null}
      />
    </main>
  );
}

export default App;
