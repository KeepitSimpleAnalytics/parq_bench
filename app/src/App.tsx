import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { loader, type OnMount } from "@monaco-editor/react";
import * as monacoEditor from "monaco-editor";
loader.config({ monaco: monacoEditor });
import { invoke } from "@tauri-apps/api/core";
// The dialog plugin replaces window.confirm with an async version (it returns a
// Promise, which is always truthy), so confirmations must await `confirm` instead.
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import type * as Monaco from "monaco-editor";
import "./App.css";

import type {
  SmokeQueryResponse,
  PreviewColumn,
  PreviewResponse,
  ViewMode,
  AcceptanceGateReport,
  WorkspaceTableInfo,
  WorkspaceSchemaByAlias,
  WorkspaceQueryResponse,
  RegisterTableRequest,
  ExportPayload,
  ActiveTab,
  ResultTab,
  QueryHistoryEntry,
  SavedQuery,
  AppSettings,
  RecentFile,
  PerspectiveContext,
  RunningOperation,
} from "./types";
import { planRun, splitSqlStatements, statementAtOffset, type RunPlan } from "./sql/statements";
import { findSavedQuery, isUnsaved, parseEditorSession, sameSql } from "./sql/savedQueries";
import {
  PAGE_SIZE,
  FIRST_VIEWPORT_TARGET_MS,
  PERSPECTIVE_READY_TARGET_MS,
  ACCEPTANCE_GATE_TIMEOUT_MS,
  UI_ACTIVE_TAB_STORAGE_KEY,
  UI_RECENT_FILES_STORAGE_KEY,
  UI_QUERY_HISTORY_STORAGE_KEY,
  UI_SETTINGS_STORAGE_KEY,
  UI_EDITOR_SESSION_STORAGE_KEY,
  RECENT_FILES_MAX,
  QUERY_HISTORY_MAX,
  INTERNAL_TOOLS_ENABLED,
  WORKSPACE_EXTENSIONS,
  PARQUET_EXTENSIONS,
  QUERY_CANCELLED,
} from "./constants";
import {
  detectSourceKind,
  isRemotePath,
  readActiveTab,
  readRecentFiles,
  readQueryHistory,
  readSettings,
  isNumericDuckType,
  waitForNextPaint,
  friendlyError,
  suggestAlias,
  fileNameFromPath,
  formatBytes,
} from "./utils";
import { buildExportCsv } from "./devReports";
import { useTheme } from "./hooks/useTheme";
import { useLocalStorageSync } from "./hooks/useLocalStorageSync";
import { useRuntimeHealth } from "./hooks/useRuntimeHealth";
import { useVirtualScroll } from "./hooks/useVirtualScroll";
import { usePerspective } from "./hooks/usePerspective";
import { useWorkspace } from "./hooks/useWorkspace";
import { useDragDrop } from "./hooks/useDragDrop";
import { useSqlCompletions } from "./hooks/useSqlCompletions";
import { useSqlErrorMarkers } from "./hooks/useSqlErrorMarkers";
import { useSqlReference } from "./hooks/useSqlReference";
import { SettingsModal } from "./components/SettingsModal";
import { AboutModal } from "./components/AboutModal";
import { VirtualScrollGrid } from "./components/VirtualScrollGrid";
import { TopBar, StatusBar, MemoryGuardBanner } from "./components/AppChrome";
import { PreviewPanel } from "./components/PreviewPanel";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { AddTableDialog } from "./components/AddTableDialog";
import { TableStatsDialog, SchemaDiffDialog } from "./components/TableDialogs";
import { ResultsPanel } from "./components/ResultsPanel";
import { ExportMenu, HistoryMenu, RunMenu, SavedMenu } from "./components/Menus";
import { SaveQueryDialog } from "./components/SaveQueryDialog";
import { Icon } from "./components/Icon";

const DEFAULT_SQL = "SELECT * FROM my_table LIMIT 100";

type ExpandedPanel = "preview" | "results" | null;

function App() {
  const { themeMode, resolvedTheme, setThemeMode } = useTheme();
  const { runtimeHealth, memoryGuardActive, memoryGuardRef, refreshRuntimeHealth } = useRuntimeHealth();

  const [activeTab, setActiveTab] = useState<ActiveTab>(() => readActiveTab());
  const [result, setResult] = useState<SmokeQueryResponse | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [sqlError, setSqlError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("virtual");
  const [firstViewportMs, setFirstViewportMs] = useState<number | null>(null);
  const [acceptanceGate, setAcceptanceGate] = useState<AcceptanceGateReport | null>(null);
  const [workspaceTables, setWorkspaceTables] = useState<WorkspaceTableInfo[]>([]);
  const [workspaceTableSchemas, setWorkspaceTableSchemas] = useState<WorkspaceSchemaByAlias>({});
  const [workspaceEditorReady, setWorkspaceEditorReady] = useState(false);
  // Editor text and open saved query from the last session (browser storage, like History).
  const [initialSession] = useState(() => {
    try {
      return parseEditorSession(window.localStorage.getItem(UI_EDITOR_SESSION_STORAGE_KEY));
    } catch {
      return null;
    }
  });
  const [workspaceSql, setWorkspaceSql] = useState(() => initialSession?.sql ?? DEFAULT_SQL);
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);
  /** Set when the saved-queries file couldn't be read; saving is then refused. */
  const [savedLoadError, setSavedLoadError] = useState<string | null>(null);
  /** Name of the saved query open in the editor (Ctrl+S updates it). */
  const [openSavedName, setOpenSavedName] = useState<string | null>(() => initialSession?.openName ?? null);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [editorHeight, setEditorHeight] = useState(180);
  const [settings, setSettings] = useState<AppSettings>(() => readSettings());
  const [editorFontSize, setEditorFontSize] = useState(() => settings.editorFontSize);
  const [workspaceQueryResult, setWorkspaceQueryResult] = useState<WorkspaceQueryResponse | null>(null);
  const [resultSeq, setResultSeq] = useState(0);
  const [queryStartedAt, setQueryStartedAt] = useState<number | null>(null);
  /** The query, export or explain the Cancel button can stop. */
  const [runningOp, setRunningOp] = useState<RunningOperation | null>(null);
  /** DuckDB's progress estimate (0–100) for `runningOp`, when it has one. */
  const [runningProgress, setRunningProgress] = useState<number | null>(null);
  /** Non-error status for the results panel, e.g. "Query cancelled after 4.2 s". */
  const [sqlNotice, setSqlNotice] = useState<string | null>(null);
  const [editorHasSelection, setEditorHasSelection] = useState(false);
  /** The statement(s) behind the current results, so Export writes exactly what was run. */
  const lastRunRef = useRef<{ sql: string; setup: string[] } | null>(null);
  /** Latest `runningOp`, for the editor's Esc handler (registered once at mount). */
  const runningOpRef = useRef<RunningOperation | null>(null);
  runningOpRef.current = runningOp;
  const [resultTab, setResultTab] = useState<ResultTab>("results");
  const [aboutOpen, setAboutOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addTableOpen, setAddTableOpen] = useState(false);
  /** Path pre-filled in the Add table dialog (a dropped SQLite file still needs a table choice). */
  const [addTableInitialPath, setAddTableInitialPath] = useState<string | undefined>(undefined);
  const [diffOpen, setDiffOpen] = useState(false);
  const [statsAlias, setStatsAlias] = useState<string | null>(null);
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>(() => readRecentFiles());
  const [queryHistory, setQueryHistory] = useState<QueryHistoryEntry[]>(() => readQueryHistory());
  const [explainPlan, setExplainPlan] = useState<string | null>(null);
  const [explainLoading, setExplainLoading] = useState(false);
  const [expandedPanel, setExpandedPanel] = useState<ExpandedPanel>(null);

  const {
    loadedRows, scrollLeft, setScrollTop, setScrollLeft,
    visibleIndices, totalRows, gridContentWidth,
    columnGridTemplate, resetScroll, setInitialPage, setInFlightPages,
  } = useVirtualScroll({ preview, memoryGuardRef, onError: setPreviewError });

  const previewPaneRef = useRef<HTMLDivElement | null>(null);
  const sqlPaneRef = useRef<HTMLDivElement | null>(null);
  const openStartRef = useRef<number | null>(null);
  const workspaceEditorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const workspaceMonacoRef = useRef<typeof Monaco | null>(null);

  const routeError = useCallback((message: string, context: PerspectiveContext) => {
    if (context === "workspace") setSqlError(message); else setPreviewError(message);
  }, []);

  const {
    perspectiveStatus, perspectiveStage, perspectiveError,
    perspectiveContext, perspectiveReadyMs,
    perspectiveViewerRef, loadPreviewIntoPerspective,
    loadPerspectiveDataset, waitForPerspectiveResult, resetPerspective,
  } = usePerspective({
    preview, loadedRows, firstViewportMs, openStartRef, settings,
    onError: routeError,
    onViewModeChange: setViewMode,
  });

  useLocalStorageSync(UI_ACTIVE_TAB_STORAGE_KEY, activeTab);
  useLocalStorageSync(UI_RECENT_FILES_STORAGE_KEY, JSON.stringify(recentFiles));
  useLocalStorageSync(UI_QUERY_HISTORY_STORAGE_KEY, JSON.stringify(queryHistory));
  useLocalStorageSync(UI_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  useLocalStorageSync(UI_EDITOR_SESSION_STORAGE_KEY, JSON.stringify({ sql: workspaceSql, openName: openSavedName }));

  // Saved queries live in a file in the app data folder: read at startup, and again
  // when the menu opens after a failed read (the file may have been locked or fixed).
  const loadSavedQueries = useCallback(() => {
    invoke<SavedQuery[]>("list_saved_queries")
      .then((list) => {
        setSavedQueries(list);
        setSavedLoadError(null);
        // The query open last session may have been deleted since.
        setOpenSavedName((name) => findSavedQuery(list, name)?.name ?? null);
      })
      .catch((err) => setSavedLoadError(friendlyError(String(err))));
  }, []);
  useEffect(loadSavedQueries, [loadSavedQueries]);

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
    workspaceTables, workspaceQueryResult,
    getLastRun: () => lastRunRef.current,
    operations: { start: startOperation, finish: finishOperation },
    loadPerspectiveDataset, setLoading, setError: setSqlError,
  });

  const smartCompletion = useSqlCompletions(
    workspaceMonacoRef, workspaceEditorRef, workspaceEditorReady,
    workspaceTables, workspaceTableSchemas, workspaceQueryResult,
  );
  useSqlReference(workspaceMonacoRef, workspaceEditorRef, workspaceEditorReady, workspaceTables, workspaceTableSchemas);
  const sqlErrorMarkers = useSqlErrorMarkers(workspaceMonacoRef, workspaceEditorRef, workspaceEditorReady);

  const { dragOverZone } = useDragDrop({
    activeTab, previewPaneRef, sqlPaneRef,
    onPreviewDrop: (paths) => void handlePreviewDrop(paths),
    onSqlDrop: (paths) => void handleSqlDrop(paths),
  });

  // ── Helpers ────────────────────────────────────────────────────────────

  async function copyToClipboard(text: string) {
    try {
      await writeText(text);
    } catch {
      await navigator.clipboard.writeText(text);
    }
  }

  function readWorkspaceSql(): string {
    const editor = workspaceEditorRef.current;
    if (editor) {
      const text = editor.getValue();
      if (text !== workspaceSql) setWorkspaceSql(text);
      return text;
    }
    return workspaceSql;
  }

  function replaceWorkspaceSql(nextSql: string): void {
    setWorkspaceSql(nextSql);
    workspaceEditorRef.current?.setValue(nextSql);
  }

  /** Replaces the whole editor content as one undoable edit (Ctrl+Z restores the previous SQL). */
  function replaceWorkspaceSqlUndoable(nextSql: string): void {
    const editor = workspaceEditorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) {
      replaceWorkspaceSql(nextSql);
      return;
    }
    editor.pushUndoStop();
    editor.executeEdits("replace-sql", [{ range: model.getFullModelRange(), text: nextSql, forceMoveMarkers: true }]);
    editor.pushUndoStop();
    setWorkspaceSql(nextSql);
  }

  // ── Saved queries ──────────────────────────────────────────────────────

  /** Saves the editor text under `name`; throws a readable message on failure. */
  async function saveQueryAs(name: string): Promise<void> {
    const sql = readWorkspaceSql();
    let list: SavedQuery[];
    try {
      list = await invoke<SavedQuery[]>("save_query", { name, sql });
    } catch (err) {
      throw friendlyError(String(err));
    }
    setSavedQueries(list);
    const savedName = findSavedQuery(list, name)?.name ?? name.trim();
    // Only mark it open if the editor still holds what was saved: if another query was
    // opened meanwhile, pointing Ctrl+S at this one would overwrite it with that text.
    if (readWorkspaceSql() === sql) setOpenSavedName(savedName);
    setSaveDialogOpen(false);
    setSqlNotice(`Saved “${savedName}”.`);
  }

  /** Ctrl+S: updates the open saved query, or asks for a name. */
  function saveCurrentQuery(): void {
    if (savedLoadError) {
      setSqlError(savedLoadError);
      return;
    }
    const open = findSavedQuery(savedQueries, openSavedName);
    if (open) {
      saveQueryAs(open.name).catch((message) => setSqlError(String(message)));
    } else {
      setSaveDialogOpen(true);
    }
  }

  /** Opens a saved query, asking first if the editor text isn't kept anywhere. */
  async function openSavedQuery(query: SavedQuery): Promise<void> {
    const current = readWorkspaceSql();
    if (!sameSql(current, query.sql) && isUnsaved(current, savedQueries, DEFAULT_SQL)) {
      const ok = await confirm(
        `The SQL in the editor isn't saved and will be replaced. Ctrl+Z brings it back.`,
        { title: `Open “${query.name}”?`, kind: "warning", okLabel: "Open", cancelLabel: "Cancel" },
      );
      // The editor may have changed while the question was open; never replace newer text.
      if (!ok || readWorkspaceSql() !== current) return;
    }
    replaceWorkspaceSqlUndoable(query.sql);
    setOpenSavedName(query.name);
  }

  async function deleteSavedQuery(query: SavedQuery): Promise<void> {
    const ok = await confirm(`Delete the saved query “${query.name}”?`,
      { title: "Delete saved query", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel" });
    if (!ok) return;
    try {
      const list = await invoke<SavedQuery[]>("delete_saved_query", { name: query.name });
      setSavedQueries(list);
      setOpenSavedName((name) => findSavedQuery(list, name)?.name ?? null);
    } catch (err) {
      setSqlError(friendlyError(String(err)));
    }
  }

  /** Inserts SQL at the cursor, or replaces the untouched starter query. */
  function insertWorkspaceSql(text: string): void {
    const editor = workspaceEditorRef.current;
    const current = readWorkspaceSql();
    if (!editor || current.trim() === "" || current === DEFAULT_SQL) {
      replaceWorkspaceSql(text);
      return;
    }
    const selection = editor.getSelection();
    if (selection) {
      editor.executeEdits("insert-sql", [{ range: selection, text, forceMoveMarkers: true }]);
    }
    editor.focus();
    setWorkspaceSql(editor.getValue());
  }

  // ── Workspace tables ───────────────────────────────────────────────────

  async function refreshWorkspaceTables() {
    const tables = await invoke<WorkspaceTableInfo[]>("list_workspace_tables");
    setWorkspaceTables(tables);
    if (tables.length === 0) {
      setWorkspaceTableSchemas({});
      return;
    }

    const schemaResults = await Promise.allSettled(
      tables.map(async (table) => {
        const schema = await invoke<PreviewColumn[]>("describe_workspace_table", { alias: table.alias });
        return { alias: table.alias, schema };
      }),
    );

    const nextSchemas: WorkspaceSchemaByAlias = {};
    const schemaErrors: string[] = [];
    schemaResults.forEach((r, index) => {
      if (r.status === "fulfilled") {
        nextSchemas[r.value.alias] = r.value.schema;
        return;
      }
      const alias = tables[index]?.alias ?? "unknown";
      const message = friendlyError(String(r.reason));
      // Messages for unreadable tables already name the table.
      schemaErrors.push(message.includes(`"${alias}"`) ? message : `Schema unavailable for ${alias}: ${message}`);
    });

    setWorkspaceTableSchemas(nextSchemas);
    if (schemaErrors.length > 0) {
      // Refreshes can repeat (e.g. at startup); don't stack the same message twice.
      setSqlError((previous) => {
        const parts = previous ? previous.split(" | ") : [];
        for (const e of schemaErrors) if (!parts.includes(e)) parts.push(e);
        return parts.join(" | ");
      });
    }
  }

  async function registerTable(request: RegisterTableRequest): Promise<boolean> {
    const { alias } = request;
    setLoading(true);
    setSqlError(null);
    try {
      await invoke("register_workspace_table", { ...request });
      await refreshWorkspaceTables();
      // Only replace the untouched starter query; never edit the user's SQL.
      const current = readWorkspaceSql();
      if (current.trim() === "" || current === DEFAULT_SQL) {
        replaceWorkspaceSql(`SELECT * FROM ${alias} LIMIT 100`);
      }
      return true;
    } catch (err) {
      setSqlError(friendlyError(String(err)));
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function removeTables(aliases: string[]) {
    setLoading(true);
    setSqlError(null);
    const errors: string[] = [];
    for (const alias of aliases) {
      try {
        await invoke("remove_workspace_table", { alias });
      } catch (err) {
        errors.push(`${alias}: ${friendlyError(String(err))}`);
      }
    }
    try {
      await refreshWorkspaceTables();
    } catch (err) {
      errors.push(friendlyError(String(err)));
    }
    if (errors.length > 0) setSqlError(errors.join(" | "));
    setLoading(false);
  }

  async function renameTable(oldAlias: string, newAlias: string) {
    setLoading(true);
    setSqlError(null);
    try {
      await invoke("rename_workspace_table", { oldAlias, newAlias });
      await refreshWorkspaceTables();
    } catch (err) {
      setSqlError(friendlyError(String(err)));
    } finally {
      setLoading(false);
    }
  }

  // ── Queries ────────────────────────────────────────────────────────────

  // ── Cancellable operations ─────────────────────────────────────────────

  function startOperation(kind: RunningOperation["kind"]): RunningOperation {
    const op: RunningOperation = { id: crypto.randomUUID(), kind, startedAt: Date.now() };
    setRunningOp(op);
    setRunningProgress(null);
    setSqlNotice(null);
    return op;
  }

  /** Ends `op`. Returns true when it failed because the user cancelled it (and says so). */
  function finishOperation(op: RunningOperation, err?: unknown): boolean {
    setRunningOp((current) => (current?.id === op.id ? null : current));
    setRunningProgress(null);
    if (err === undefined || String(err) !== QUERY_CANCELLED) return false;
    const what = op.kind === "export" ? "Export" : op.kind === "explain" ? "Explain" : "Query";
    const seconds = ((Date.now() - op.startedAt) / 1000).toFixed(1);
    setSqlNotice(`${what} cancelled after ${seconds} s.`);
    return true;
  }

  async function cancelRunningOperation() {
    const op = runningOp;
    if (!op) return;
    try {
      await invoke<boolean>("cancel_workspace_query", { queryId: op.id });
    } catch (err) {
      setSqlError(friendlyError(String(err)));
    }
  }

  // Poll DuckDB's progress estimate while something runs.
  useEffect(() => {
    if (!runningOp) return;
    const id = runningOp.id;
    let stopped = false;
    const timer = window.setInterval(() => {
      invoke<number | null>("workspace_query_progress", { queryId: id })
        .then((pct) => { if (!stopped) setRunningProgress(pct); })
        .catch(() => { /* the query just finished */ });
    }, 300);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [runningOp]);

  // ── Queries ────────────────────────────────────────────────────────────

  /**
   * What to run: "auto" = the selection if there is one, otherwise the statement
   * under the cursor; "all" = every statement in the editor. Earlier statements run
   * first as setup, so a script can create a temp table and then query it.
   */
  function planEditorRun(mode: "auto" | "all"): RunPlan | null {
    const full = readWorkspaceSql();
    const editor = workspaceEditorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || mode === "all") return planRun(splitSqlStatements(full));
    const selection = editor.getSelection();
    if (selection && !selection.isEmpty()) {
      const start = model.getOffsetAt(selection.getStartPosition());
      const end = model.getOffsetAt(selection.getEndPosition());
      return planRun(splitSqlStatements(full.slice(start, end)), start);
    }
    const position = editor.getPosition();
    const statements = splitSqlStatements(full);
    const current = position ? statementAtOffset(full, statements, model.getOffsetAt(position)) : statements[0] ?? null;
    return current ? planRun([current]) : null;
  }

  /** Briefly highlights the SQL that just started running. */
  function flashRange(start: number, end: number) {
    const editor = workspaceEditorRef.current;
    const model = editor?.getModel();
    const monaco = workspaceMonacoRef.current;
    if (!editor || !model || !monaco) return;
    const from = model.getPositionAt(start);
    const to = model.getPositionAt(end);
    const decorations = editor.createDecorationsCollection([{
      range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column),
      options: { className: "ran-sql-flash" },
    }]);
    window.setTimeout(() => decorations.clear(), 900);
  }

  async function runWorkspaceQuery(mode: "auto" | "all" = "auto") {
    // One cancellable operation at a time, so Cancel always stops the one that's running.
    if (loading || runningOp) return;
    const plan = planEditorRun(mode);
    // Read with the plan: the offsets in it are only valid for this version of the text.
    const editorVersion = sqlErrorMarkers.versionNow();
    if (!plan) {
      setSqlError("Write a SQL query first.");
      return;
    }

    await refreshRuntimeHealth();
    if (memoryGuardRef.current) {
      setSqlError("Memory guard is active — queries are paused until memory use drops.");
      return;
    }

    const op = startOperation("query");
    setLoading(true);
    setSqlError(null);
    sqlErrorMarkers.clearError();
    setQueryStartedAt(op.startedAt);
    if (resultTab === "plan") setResultTab("results");
    flashRange(plan.start, plan.end);
    try {
      const response = await invoke<WorkspaceQueryResponse>("run_workspace_query", {
        sql: plan.sql,
        setupSql: plan.setup,
        rowLimit: settings.sqlRowLimit,
        queryId: op.id,
      });
      finishOperation(op);
      lastRunRef.current = { sql: plan.sql, setup: plan.setup };
      setWorkspaceQueryResult(response);
      setResultSeq((n) => n + 1);
      setExplainPlan(null);
      const historySql = plan.setup.length > 0 ? `${[...plan.setup, plan.sql].join(";\n")};` : response.sql;
      setQueryHistory((prev) => {
        const entry: QueryHistoryEntry = {
          sql: historySql,
          timestamp: Date.now(),
          rowCount: response.row_count,
          elapsedMs: response.elapsed_ms,
        };
        return [entry, ...prev.filter((h) => h.sql !== historySql)].slice(0, QUERY_HISTORY_MAX);
      });
    } catch (err) {
      if (finishOperation(op, err)) return;
      const message = friendlyError(String(err));
      sqlErrorMarkers.markError(plan, String(err), message, editorVersion);
      if (message.includes("Referenced column")) {
        const availableColumns = Array.from(new Set(Object.values(workspaceTableSchemas).flat().map((c) => c.name)));
        const sample = availableColumns.slice(0, 18);
        const hint = sample.length === 0
          ? ""
          : ` Available columns: ${sample.join(", ")}${availableColumns.length > sample.length ? ", ..." : ""}`;
        setSqlError(`${message}${hint}`);
      } else {
        setSqlError(message);
      }
    } finally {
      setQueryStartedAt(null);
      setLoading(false);
    }
  }

  async function runExplainAnalyze() {
    if (loading || explainLoading || runningOp) return;
    const plan = planEditorRun("auto");
    if (!plan) {
      setSqlError("Write a SQL query first.");
      return;
    }
    if (plan.setup.length > 0) {
      setSqlError("Explain works on one statement. Select a single statement, or put the cursor in it.");
      return;
    }
    const op = startOperation("explain");
    setExplainLoading(true);
    setSqlError(null);
    sqlErrorMarkers.clearError();
    const editorVersion = sqlErrorMarkers.versionNow();
    setResultTab("plan");
    flashRange(plan.start, plan.end);
    try {
      setExplainPlan(await invoke<string>("explain_workspace_query", { sql: plan.sql, queryId: op.id }));
      finishOperation(op);
    } catch (err) {
      if (!finishOperation(op, err)) {
        const message = friendlyError(String(err));
        sqlErrorMarkers.markError(plan, String(err), message, editorVersion);
        setSqlError(message);
      }
    } finally {
      setExplainLoading(false);
    }
  }

  const onWorkspaceEditorMount: OnMount = (editor, monaco) => {
    workspaceEditorRef.current = editor;
    workspaceMonacoRef.current = monaco;
    const model = editor.getModel();
    if (model) monaco.editor.setModelLanguage(model, "sql");
    const pasteFromClipboard = async () => {
      try {
        const text = await readText();
        if (text) {
          const selection = editor.getSelection();
          if (selection) editor.executeEdits("paste", [{ range: selection, text }]);
        }
      } catch (_) { /* clipboard unavailable */ }
    };
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV, pasteFromClipboard);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => { void shortcutRef.current.runQuery("auto"); });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.Enter, () => { void shortcutRef.current.runQuery("all"); });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => { void shortcutRef.current.explain(); });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => shortcutRef.current.save());
    // Esc cancels a running query, unless it's closing a suggestion list or another editor widget.
    editor.onKeyDown((e) => {
      if (e.keyCode !== monaco.KeyCode.Escape || !runningOpRef.current) return;
      const node = editor.getDomNode();
      if (node?.querySelector(".suggest-widget.visible, .find-widget.visible, .parameter-hints-widget.visible")) return;
      e.preventDefault();
      e.stopPropagation();
      void shortcutRef.current.cancel();
    });
    editor.onDidChangeCursorSelection((e) => setEditorHasSelection(!e.selection.isEmpty()));
    editor.addAction({
      id: "tauri-paste",
      label: "Paste",
      contextMenuGroupId: "9_cutcopypaste",
      contextMenuOrder: 3,
      run: pasteFromClipboard,
    });
    setWorkspaceEditorReady(true);
  };

  // ── Preview ────────────────────────────────────────────────────────────

  async function pickParquetFile(): Promise<string | null> {
    const selected = await open({
      title: "Open Parquet File",
      multiple: false,
      filters: [{ name: "Parquet", extensions: PARQUET_EXTENSIONS }],
    });
    return !selected || Array.isArray(selected) ? null : selected;
  }

  async function loadPreviewFromPath(filePath: string): Promise<number> {
    openStartRef.current = performance.now();
    resetPerspective();
    setFirstViewportMs(null);

    const data = await invoke<PreviewResponse>("preview_parquet", { filePath, rowLimit: PAGE_SIZE });
    setPreview(data);
    setRecentFiles((prev) => [
      { path: filePath, sizeBytes: data.file_size_bytes, openedAt: Date.now() },
      ...prev.filter((f) => f.path !== filePath),
    ].slice(0, RECENT_FILES_MAX));
    setViewMode("virtual");
    setInitialPage(data);

    await waitForNextPaint();
    const elapsed = openStartRef.current === null ? 0 : performance.now() - openStartRef.current;
    setFirstViewportMs(elapsed);
    return elapsed;
  }

  async function openPreviewPath(filePath: string) {
    await refreshRuntimeHealth();
    if (memoryGuardRef.current) {
      setPreviewError("Memory guard is active — opening files is paused until memory use drops.");
      return;
    }
    setLoading(true);
    setPreviewError(null);
    try {
      await loadPreviewFromPath(filePath);
    } catch (err) {
      setPreviewError(friendlyError(String(err)));
    } finally {
      setLoading(false);
    }
  }

  async function openParquetPreview() {
    const selected = await pickParquetFile();
    if (!selected) return;
    setActiveTab("preview");
    await openPreviewPath(selected);
  }

  function closePreview() {
    setPreview(null);
    setViewMode("virtual");
    resetPerspective();
    setFirstViewportMs(null);
    resetScroll();
    setAcceptanceGate(null);
    setPreviewError(null);
    if (expandedPanel === "preview") setExpandedPanel(null);
  }

  /** Same file path regardless of slash direction or letter case (Windows paths). URLs compare exactly. */
  function samePath(a: string, b: string): boolean {
    if (isRemotePath(a) || isRemotePath(b)) return a.trim() === b.trim();
    const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
    return norm(a) === norm(b);
  }

  async function queryPreviewInSql() {
    if (!preview) return;
    const filePath = preview.file_path;
    const existing = workspaceTables.find((t) => !t.is_glob && samePath(t.file_path, filePath));
    let alias = existing?.alias ?? null;
    if (!alias) {
      alias = suggestAlias(filePath, workspaceTables.map((t) => t.alias));
      setLoading(true);
      setPreviewError(null);
      try {
        await invoke("register_workspace_table", { alias, filePath, isGlob: false, sourceKind: "parquet" });
        await refreshWorkspaceTables();
      } catch (err) {
        setPreviewError(friendlyError(String(err)));
        return;
      } finally {
        setLoading(false);
      }
    }
    setActiveTab("sql");
    replaceWorkspaceSqlUndoable(`SELECT * FROM ${alias} LIMIT 100`);
    workspaceEditorRef.current?.focus();
  }

  async function previewTable(table: WorkspaceTableInfo) {
    setActiveTab("preview");
    if (preview && samePath(preview.file_path, table.file_path)) return;
    await openPreviewPath(table.file_path);
  }

  function showPivot() {
    if (perspectiveContext === "preview" && perspectiveStatus === "ready") {
      setViewMode("perspective");
    } else {
      void loadPreviewIntoPerspective(true);
    }
  }

  // Leaving a tab exits any full-window panel so the top bar comes back.
  useEffect(() => { setExpandedPanel(null); }, [activeTab]);

  // The viewer element follows its context; if the SQL tab takes it, Preview falls back to rows.
  useEffect(() => {
    if (perspectiveContext !== "preview" && viewMode === "perspective") setViewMode("virtual");
  }, [perspectiveContext, viewMode]);

  // ── Drag and drop ──────────────────────────────────────────────────────

  async function handlePreviewDrop(paths: string[]) {
    const parquetPaths = paths.filter((p) => p.toLowerCase().endsWith(".parquet"));
    if (parquetPaths.length === 0) {
      setPreviewError("Only .parquet files can be opened in Preview. Drop text files on the SQL tab to add them as tables.");
      return;
    }
    if (loading) {
      setPreviewError("Still working on the previous action — drop the file again in a moment.");
      return;
    }
    await openPreviewPath(parquetPaths[0]);
    setActiveTab("preview");
  }

  async function handleSqlDrop(paths: string[]) {
    const validPaths = paths.filter((p) => {
      const lower = p.toLowerCase();
      return WORKSPACE_EXTENSIONS.some((ext) => lower.endsWith(`.${ext}`));
    });
    if (validPaths.length === 0) {
      setSqlError(`No supported files found. Supported: ${WORKSPACE_EXTENSIONS.map((e) => `.${e}`).join(", ")}`);
      return;
    }
    if (loading) {
      setSqlError("Still working on the previous action — drop the files again in a moment.");
      return;
    }

    // A SQLite database needs a table choice, so it opens the Add table dialog instead.
    const sqlitePaths = validPaths.filter((p) => detectSourceKind(p) === "sqlite");
    const sqlitePath = sqlitePaths[0];
    const directPaths = validPaths.filter((p) => detectSourceKind(p) !== "sqlite");
    const openSqliteDialog = () => {
      if (!sqlitePath) return;
      if (sqlitePaths.length > 1) {
        setSqlError(
          `SQLite databases are added one at a time. Choose a table from ${fileNameFromPath(sqlitePath)} now, then add `
          + `${sqlitePaths.slice(1).map(fileNameFromPath).join(", ")} with Add table.`,
        );
      }
      setActiveTab("sql");
      setAddTableInitialPath(sqlitePath);
      setAddTableOpen(true);
    };
    if (directPaths.length === 0) {
      openSqliteDialog();
      return;
    }

    setLoading(true);
    setSqlError(null);
    try {
      const taken = workspaceTables.map((t) => t.alias);
      let firstAlias: string | null = null;
      for (const filePath of directPaths) {
        const alias = suggestAlias(filePath, taken);
        taken.push(alias);
        if (!firstAlias) firstAlias = alias;
        // Delimiter is left to the backend: .tsv/.psv map to tab/pipe, others are sniffed.
        // Excel files mount their first sheet.
        await invoke<WorkspaceTableInfo>("register_workspace_table", {
          alias,
          filePath,
          isGlob: false,
          sourceKind: detectSourceKind(filePath),
        });
      }
      await refreshWorkspaceTables();
      if (firstAlias && readWorkspaceSql() === DEFAULT_SQL) {
        replaceWorkspaceSql(`SELECT * FROM ${firstAlias} LIMIT 100`);
      }
      setActiveTab("sql");
      openSqliteDialog();
    } catch (err) {
      setSqlError(friendlyError(String(err)));
      try { await refreshWorkspaceTables(); } catch { /* keep the original error visible */ }
    } finally {
      setLoading(false);
    }
  }

  // ── Internal tools (dev builds only) ───────────────────────────────────

  function buildExportPayload(exportedAt: string): ExportPayload {
    return {
      exported_at: exportedAt,
      targets: { first_viewport_ms: FIRST_VIEWPORT_TARGET_MS, perspective_ready_ms: PERSPECTIVE_READY_TARGET_MS },
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

  async function exportResults(format: "json" | "csv") {
    if (!preview) {
      setPreviewError("Open a file before exporting results.");
      return;
    }
    setLoading(true);
    setPreviewError(null);
    try {
      const exportedAt = new Date().toISOString();
      const payload = buildExportPayload(exportedAt);
      const selected = await save({
        title: `Export Results (${format.toUpperCase()})`,
        defaultPath: `parq_bench_results_${exportedAt.replace(/[:.]/g, "-")}.${format}`,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      if (!selected) return;
      const contents = format === "json" ? JSON.stringify(payload, null, 2) : buildExportCsv(payload);
      await invoke("write_text_report", { path: selected, contents });
    } catch (err) {
      setPreviewError(friendlyError(String(err)));
    } finally {
      setLoading(false);
    }
  }

  async function runAcceptanceGate() {
    await refreshRuntimeHealth();
    if (memoryGuardRef.current) {
      setPreviewError("Memory guard is active; acceptance gate is blocked.");
      return;
    }
    setLoading(true);
    setPreviewError(null);
    setAcceptanceGate(null);
    try {
      const targetFile = preview?.file_path ?? (await pickParquetFile());
      if (!targetFile) return;
      const firstMs = await loadPreviewFromPath(targetFile);
      // The pivot view auto-loads in the background once the first viewport paints.
      const perspectiveResult = await waitForPerspectiveResult(ACCEPTANCE_GATE_TIMEOUT_MS);
      const firstViewportPass = firstMs <= FIRST_VIEWPORT_TARGET_MS;
      const perspectivePass = perspectiveResult.status === "ready"
        && perspectiveResult.readyMs !== null
        && perspectiveResult.readyMs <= PERSPECTIVE_READY_TARGET_MS;
      setAcceptanceGate({
        filePath: targetFile,
        evaluatedAt: new Date().toISOString(),
        firstViewportMs: firstMs,
        perspectiveReadyMs: perspectiveResult.readyMs,
        firstViewportPass,
        perspectivePass,
        perspectiveStatus: perspectiveResult.status,
        passed: firstViewportPass && perspectivePass,
        details: perspectiveResult.error ?? "",
      });
    } catch (err) {
      const message = String(err);
      setPreviewError(friendlyError(message));
      setAcceptanceGate({
        filePath: preview?.file_path ?? "unknown",
        evaluatedAt: new Date().toISOString(),
        firstViewportMs,
        perspectiveReadyMs,
        firstViewportPass: firstViewportMs !== null && firstViewportMs <= FIRST_VIEWPORT_TARGET_MS,
        perspectivePass: false,
        perspectiveStatus: "error",
        passed: false,
        details: message,
      });
    } finally {
      setLoading(false);
    }
  }

  // ── Effects ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (runtimeHealth?.memory_guard_tripped) setInFlightPages(new Set());
  }, [runtimeHealth]);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        setResult(await invoke<SmokeQueryResponse>("duckdb_smoke_query"));
      } catch (err) {
        setPreviewError(`DuckDB failed to start: ${friendlyError(String(err))}`);
      }
      try {
        await refreshWorkspaceTables();
      } catch (err) {
        setSqlError(friendlyError(String(err)));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Keep the chart in sync with its options while the Chart tab is showing.
  const chartKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (perspectiveContext !== "workspace") chartKeyRef.current = null;
  }, [perspectiveContext]);
  useEffect(() => {
    if (activeTab !== "sql" || resultTab !== "chart" || !settings.showVisualization) return;
    if (!workspaceQueryResult || workspaceQueryResult.rows.length === 0) return;
    const key = `${resultSeq}|${workspaceChartPlugin}|${workspaceChartX}|${workspaceChartY}|${workspaceChartAgg}`;
    if (perspectiveContext === "workspace" && chartKeyRef.current === key) return;
    const timer = window.setTimeout(() => {
      chartKeyRef.current = key;
      void visualizeWorkspaceChart();
    }, 200);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, resultTab, settings.showVisualization, workspaceQueryResult, resultSeq,
    workspaceChartPlugin, workspaceChartX, workspaceChartY, workspaceChartAgg, perspectiveContext]);

  // Global keyboard shortcuts: one stable listener that reads the latest state through a ref.
  const shortcutRef = useRef({
    runQuery: runWorkspaceQuery,
    explain: runExplainAnalyze,
    cancel: cancelRunningOperation,
    save: saveCurrentQuery,
    onKeyDown: (_e: KeyboardEvent) => {},
  });
  shortcutRef.current.save = saveCurrentQuery;
  shortcutRef.current.runQuery = runWorkspaceQuery;
  shortcutRef.current.explain = runExplainAnalyze;
  shortcutRef.current.cancel = cancelRunningOperation;
  shortcutRef.current.onKeyDown = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    const target = e.target as HTMLElement | null;
    const tagName = target?.tagName ?? "";
    // Monaco's hidden textarea is not a plain text input: app shortcuts should work while editing SQL.
    const inMonaco = Boolean(target?.closest?.(".monaco-editor"));
    const isTextInput = !inMonaco && (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT");
    const dialogOpen = document.querySelector(".modal-card") !== null;

    if (e.key === "Escape") {
      // Dialogs and menus handle their own Escape in the capture phase.
      if (runningOp && activeTab === "sql" && !dialogOpen) {
        // Inside the editor, Monaco's own Esc binding cancels (and leaves Esc to an open suggestion list).
        if (!inMonaco) {
          e.preventDefault();
          void cancelRunningOperation();
        }
      } else if (expandedPanel && settings.expandMode === "fullscreen") {
        e.preventDefault();
        setExpandedPanel(null);
      } else if (activeTab === "sql" && sqlError) {
        e.preventDefault();
        setSqlError(null);
      } else if (activeTab === "preview" && previewError) {
        e.preventDefault();
        setPreviewError(null);
      }
      return;
    }
    if (isTextInput || !mod || dialogOpen) return;
    // Monaco runs Ctrl+Enter / Ctrl+Shift+Enter itself (editor commands); don't run them twice.
    if (inMonaco && e.key === "Enter") return;

    if (e.key === "1") { e.preventDefault(); setActiveTab("preview"); return; }
    if (e.key === "2") { e.preventDefault(); setActiveTab("sql"); return; }
    if (e.key === "o" || e.key === "O") {
      if (!loading && !memoryGuardRef.current) { e.preventDefault(); void openParquetPreview(); }
      return;
    }
    if ((e.key === "s" || e.key === "S") && !e.shiftKey && activeTab === "sql") {
      // Inside the editor Monaco's Ctrl+S command saves; don't save twice.
      e.preventDefault();
      if (!inMonaco) saveCurrentQuery();
      return;
    }
    if (e.key === "Enter" && e.shiftKey && activeTab === "sql") {
      if (!loading && !explainLoading) { e.preventDefault(); void runExplainAnalyze(); }
      return;
    }
    if (e.key === "Enter" && activeTab === "sql") {
      if (!loading) { e.preventDefault(); void runWorkspaceQuery(e.altKey ? "all" : "auto"); }
      return;
    }
    if ((e.key === "e" || e.key === "E") && e.shiftKey && activeTab === "sql") {
      if (!loading && !runningOp) { e.preventDefault(); void exportWorkspaceQuery("csv"); }
      return;
    }
    if (e.key === ",") { e.preventDefault(); setSettingsOpen((p) => !p); }
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => shortcutRef.current.onKeyDown(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const openSavedQueryEntry = findSavedQuery(savedQueries, openSavedName);
  const openSavedQueryInfo = openSavedQueryEntry
    ? { name: openSavedQueryEntry.name, edited: !sameSql(workspaceSql, openSavedQueryEntry.sql) }
    : null;

  // ── Render ─────────────────────────────────────────────────────────────

  const workspaceColumns = workspaceQueryResult?.schema ?? [];
  const workspaceNumericColumns = workspaceColumns.filter((c) => isNumericDuckType(c.duckdb_type));
  const pivotStatus = perspectiveContext === "preview" ? perspectiveStatus : "ready";
  const fullscreen = expandedPanel !== null && settings.expandMode === "fullscreen";

  const devTools = INTERNAL_TOOLS_ENABLED ? (
    <div className="dev-tools" aria-label="Internal tools">
      <span className="dev-label">Dev</span>
      <button type="button" className="btn btn-xs" onClick={() => void runAcceptanceGate()} disabled={loading || memoryGuardActive}>
        {loading ? "Running…" : "Run acceptance gate"}
      </button>
      <button type="button" className="btn btn-xs" onClick={() => void exportResults("json")} disabled={loading || !preview}>Export JSON</button>
      <button type="button" className="btn btn-xs" onClick={() => void exportResults("csv")} disabled={loading || !preview}>Export CSV</button>
      <span className={firstViewportMs === null ? "chip" : firstViewportMs <= FIRST_VIEWPORT_TARGET_MS ? "chip chip-add" : "chip chip-remove"}>
        First viewport: {firstViewportMs === null ? "pending" : `${firstViewportMs.toFixed(0)} / ${FIRST_VIEWPORT_TARGET_MS} ms`}
      </span>
      <span className={perspectiveReadyMs === null ? "chip" : perspectiveReadyMs <= PERSPECTIVE_READY_TARGET_MS ? "chip chip-add" : "chip chip-remove"}>
        Pivot ready: {perspectiveReadyMs === null ? "pending" : `${perspectiveReadyMs.toFixed(0)} / ${PERSPECTIVE_READY_TARGET_MS} ms`}
      </span>
      <span className="chip">Perspective: {perspectiveStatus} ({perspectiveStage}){perspectiveError ? ` — ${perspectiveError}` : ""}</span>
      {acceptanceGate ? (
        <span className={acceptanceGate.passed ? "chip chip-add" : "chip chip-remove"}>
          Gate {acceptanceGate.passed ? "PASS" : "FAIL"}{acceptanceGate.details ? ` — ${acceptanceGate.details}` : ""}
        </span>
      ) : null}
    </div>
  ) : null;

  const pivotHost = perspectiveContext === "preview"
    ? <perspective-viewer ref={perspectiveViewerRef} className="perspective-viewer" />
    : null;
  const chartHost = perspectiveContext === "workspace"
    ? <div className="chart-host"><perspective-viewer ref={perspectiveViewerRef} className="perspective-viewer" /></div>
    : <div className="chart-host" />;

  return (
    <main className={fullscreen ? "app-shell panel-maximized" : "app-shell"}>
      <TopBar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenAbout={() => setAboutOpen(true)}
      />
      <MemoryGuardBanner health={runtimeHealth} canCloseFile={preview !== null} onCloseFile={closePreview} />

      <div className="tab-content">
        <div ref={previewPaneRef} className={activeTab === "preview" ? "tab-pane" : "tab-pane tab-pane-hidden"}
          aria-hidden={activeTab !== "preview"}>
          <PreviewPanel
            preview={preview}
            recentFiles={recentFiles}
            loading={loading}
            blocked={memoryGuardActive}
            error={previewError}
            onDismissError={() => setPreviewError(null)}
            onOpen={() => void openParquetPreview()}
            onOpenRecent={(path) => void openPreviewPath(path)}
            onOpenUrl={(url) => void openPreviewPath(url)}
            onClearRecent={() => setRecentFiles([])}
            onCloseFile={closePreview}
            onCopyAllColumns={() => preview && void copyToClipboard(preview.schema.map((c) => c.name).join(", "))}
            onQueryWithSql={() => void queryPreviewInSql()}
            viewMode={viewMode}
            onShowRows={() => setViewMode("virtual")}
            onShowPivot={showPivot}
            pivotStatus={pivotStatus}
            pivotRowCap={settings.perspectiveMaxRows}
            expanded={expandedPanel === "preview"}
            expandMode={settings.expandMode}
            onToggleExpand={() => setExpandedPanel(expandedPanel === "preview" ? null : "preview")}
            devTools={devTools}
            pivotHost={pivotHost}
            grid={preview ? (
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
          />
          {dragOverZone === "preview" ? (
            <div className="drop-overlay"><span>Drop a .parquet file to preview it</span></div>
          ) : null}
        </div>

        <div ref={sqlPaneRef} className={activeTab === "sql" ? "tab-pane" : "tab-pane tab-pane-hidden"}
          aria-hidden={activeTab !== "sql"}>
          <div className="sql-layout">
            <WorkspaceSidebar
              tables={workspaceTables}
              schemas={workspaceTableSchemas}
              loading={loading}
              onAddTable={() => { setAddTableInitialPath(undefined); setAddTableOpen(true); }}
              onRemove={(alias) => void removeTables([alias])}
              onRename={(oldAlias, newAlias) => void renameTable(oldAlias, newAlias)}
              onClearAll={() => {
                const aliases = workspaceTables.map((t) => t.alias);
                void confirm(`Remove all ${aliases.length} tables from the workspace? Your files are not changed.`,
                  { title: "Remove all tables", kind: "warning", okLabel: "Remove", cancelLabel: "Cancel" })
                  .then((ok) => { if (ok) void removeTables(aliases); });
              }}
              onRemoveSelected={(aliases) => void removeTables([...aliases])}
              onInsertSelect={(alias) => insertWorkspaceSql(`SELECT * FROM ${alias} LIMIT 100`)}
              onShowStats={setStatsAlias}
              onPreview={(table) => void previewTable(table)}
              onCompareSchemas={() => setDiffOpen(true)}
              onError={setSqlError}
            />

            <div className="sql-main">
              <section className="card editor-card" aria-label="SQL editor">
                <div className="editor-toolbar">
                  {runningOp ? (
                    <button type="button" className="btn btn-danger-outline run-cancel" onClick={() => void cancelRunningOperation()}
                      title="Stop the running query (Esc)">
                      <Icon name="stop" size={12} /> Cancel
                      {runningProgress !== null ? <span className="run-progress">{Math.round(runningProgress)}%</span> : null}
                      <kbd className="kbd">Esc</kbd>
                    </button>
                  ) : (
                    <div className="split-btn">
                      <button type="button" className="btn btn-primary" onClick={() => void runWorkspaceQuery("auto")} disabled={loading}
                        title={editorHasSelection ? "Run the selected SQL" : "Run the statement under the cursor"}>
                        <Icon name="play" size={13} /> {editorHasSelection ? "Run selection" : "Run"}
                        <kbd className="kbd kbd-on-primary">Ctrl+Enter</kbd>
                      </button>
                      <RunMenu disabled={loading} onRunAll={() => void runWorkspaceQuery("all")} />
                    </div>
                  )}
                  <button type="button" className="btn" title="Explain query plan (Ctrl+Shift+Enter)"
                    onClick={() => void runExplainAnalyze()} disabled={loading || explainLoading || runningOp !== null}>
                    Explain
                  </button>
                  {smartCompletion.state === "downloading" ? (
                    <span className="muted small completion-status" role="status">
                      <Icon name="spinner" size={12} className="spin" /> Downloading SQL autocomplete (first use only)…
                    </span>
                  ) : smartCompletion.state === "unavailable" ? (
                    <span className="muted small completion-status" title={smartCompletion.reason}>
                      Basic suggestions only: SQL autocomplete couldn't load.
                    </span>
                  ) : null}
                  {openSavedQueryInfo ? (
                    <span className="open-query-name" role="status"
                      title={openSavedQueryInfo.edited ? "Edited since it was saved. Ctrl+S updates it." : "Saved query open in the editor"}>
                      <strong>{openSavedQueryInfo.name}</strong>{openSavedQueryInfo.edited ? " · edited" : ""}
                    </span>
                  ) : null}
                  <div className="spacer" />
                  <SavedMenu
                    saved={savedQueries}
                    openName={openSavedQueryInfo?.name ?? null}
                    loadError={savedLoadError}
                    onOpen={(query) => void openSavedQuery(query)}
                    onSaveAs={() => setSaveDialogOpen(true)}
                    onDelete={(query) => void deleteSavedQuery(query)}
                    onMenuOpen={() => { if (savedLoadError) loadSavedQueries(); }}
                  />
                  <HistoryMenu
                    history={queryHistory}
                    onSelect={(sql) => { replaceWorkspaceSqlUndoable(sql); setOpenSavedName(null); }}
                    onClear={() => setQueryHistory([])}
                  />
                  <ExportMenu
                    disabled={loading || runningOp !== null || !workspaceQueryResult?.returns_rows
                      || workspaceQueryResult.rows.length === 0 || !lastRunRef.current}
                    onExport={(format) => void exportWorkspaceQuery(format)}
                  />
                </div>
                <div className="workspace-editor" style={{ height: editorHeight }}
                  onMouseUp={(e) => {
                    const h = (e.currentTarget as HTMLDivElement).offsetHeight;
                    if (h !== editorHeight) setEditorHeight(h);
                  }}>
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
                      // Hover cards and parameter hints open above the line; let them extend
                      // past the editor's edges instead of being clipped near the top.
                      fixedOverflowWidgets: true,
                    }}
                  />
                </div>
              </section>

              <ResultsPanel
                tab={resultTab}
                onTabChange={setResultTab}
                showChartTab={settings.showVisualization}
                result={workspaceQueryResult}
                runningSince={queryStartedAt}
                runningProgress={runningOp?.kind === "query" ? runningProgress : null}
                notice={sqlNotice}
                onDismissNotice={() => setSqlNotice(null)}
                explainRunning={explainLoading}
                explainPlan={explainPlan}
                error={sqlError}
                onDismissError={() => setSqlError(null)}
                onCopyColumn={(name) => void copyToClipboard(name)}
                onCopyAllColumns={() => void copyToClipboard(workspaceColumns.map((c) => c.name).join(", "))}
                chart={{
                  plugin: workspaceChartPlugin, setPlugin: setWorkspaceChartPlugin,
                  x: workspaceChartX, setX: setWorkspaceChartX,
                  y: workspaceChartY, setY: setWorkspaceChartY,
                  agg: workspaceChartAgg, setAgg: setWorkspaceChartAgg,
                  columns: workspaceColumns,
                  numericColumns: workspaceNumericColumns,
                  status: perspectiveContext === "workspace" ? perspectiveStatus : "idle",
                }}
                chartHost={chartHost}
                expanded={expandedPanel === "results"}
                expandMode={settings.expandMode}
                onToggleExpand={() => setExpandedPanel(expandedPanel === "results" ? null : "results")}
              />
            </div>
          </div>
          {dragOverZone === "sql" ? (
            <div className="drop-overlay"><span>Drop files to add them as tables</span></div>
          ) : null}
        </div>
      </div>

      <StatusBar
        health={runtimeHealth}
        duckdbVersion={result?.duckdb_version ?? null}
        right={activeTab === "sql" && workspaceExport ? (
          <span className="status-item" title={workspaceExport.output_path}>
            Last export: {fileNameFromPath(workspaceExport.output_path)} · {formatBytes(workspaceExport.file_size_bytes)}
          </span>
        ) : null}
      />

      <AddTableDialog
        open={addTableOpen}
        onClose={() => setAddTableOpen(false)}
        existingAliases={workspaceTables.map((t) => t.alias)}
        busy={loading}
        initialPath={addTableInitialPath}
        onAdd={registerTable}
      />
      <TableStatsDialog alias={statsAlias} deep={settings.deepStats}
        parquet={workspaceTables.find((t) => t.alias === statsAlias)?.source_kind === "parquet"}
        onClose={() => setStatsAlias(null)} />
      <SchemaDiffDialog
        open={diffOpen}
        onClose={() => setDiffOpen(false)}
        tables={workspaceTables}
        leftAlias={workspaceDiffLeftAlias}
        rightAlias={workspaceDiffRightAlias}
        setLeftAlias={setWorkspaceDiffLeftAlias}
        setRightAlias={setWorkspaceDiffRightAlias}
        result={workspaceSchemaDiff}
        onRun={() => void runWorkspaceSchemaDiff()}
        busy={loading}
        error={sqlError}
        onDismissError={() => setSqlError(null)}
      />
      <SettingsModal
        open={settingsOpen}
        settings={settings}
        onSettingsChange={setSettings}
        onClose={() => setSettingsOpen(false)}
        onEditorFontSizeChange={setEditorFontSize}
        editorRef={workspaceEditorRef}
        themeMode={themeMode}
        onThemeModeChange={setThemeMode}
      />
      <SaveQueryDialog
        open={saveDialogOpen}
        saved={savedQueries}
        openName={openSavedQueryInfo?.name ?? null}
        onClose={() => setSaveDialogOpen(false)}
        onSave={saveQueryAs}
      />
      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} duckdbVersion={result?.duckdb_version ?? null} />
    </main>
  );
}

export default App;
