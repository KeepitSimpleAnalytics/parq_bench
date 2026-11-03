import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type {
  WorkspaceChartPlugin,
  WorkspaceSchemaDiffResponse,
  WorkspaceExportResponse,
  ExportFormat,
  WorkspaceQueryResponse,
  WorkspaceTableInfo,
  PerspectiveContext,
  RunningOperation,
} from "../types";
import { isNumericDuckType, coerceWorkspaceCell, friendlyError } from "../utils";
import { writesOutsideApp } from "../sql/statements";

interface UseWorkspaceParams {
  workspaceTables: WorkspaceTableInfo[];
  workspaceQueryResult: WorkspaceQueryResponse | null;
  /** The statement (and setup statements) that produced the current results. */
  getLastRun: () => { sql: string; setup: string[] } | null;
  /** Registers a cancellable operation; `finish` returns true if it was cancelled. */
  operations: {
    start: (kind: RunningOperation["kind"]) => RunningOperation;
    finish: (op: RunningOperation, err?: unknown) => boolean;
  };
  loadPerspectiveDataset: (
    dataset: Array<Record<string, unknown>>,
    restoreConfig: Record<string, unknown>,
    options?: { context?: PerspectiveContext },
  ) => Promise<void>;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export function useWorkspace({
  workspaceTables,
  workspaceQueryResult,
  getLastRun,
  operations,
  loadPerspectiveDataset,
  setLoading,
  setError,
}: UseWorkspaceParams) {
  const [workspaceChartPlugin, setWorkspaceChartPlugin] = useState<WorkspaceChartPlugin>("X Bar");
  const [workspaceChartX, setWorkspaceChartX] = useState("");
  const [workspaceChartY, setWorkspaceChartY] = useState("");
  const [workspaceChartAgg, setWorkspaceChartAgg] = useState("sum");
  const [workspaceDiffLeftAlias, setWorkspaceDiffLeftAlias] = useState("");
  const [workspaceDiffRightAlias, setWorkspaceDiffRightAlias] = useState("");
  const [workspaceSchemaDiff, setWorkspaceSchemaDiff] = useState<WorkspaceSchemaDiffResponse | null>(null);
  const [workspaceExport, setWorkspaceExport] = useState<WorkspaceExportResponse | null>(null);

  // Auto-select chart X/Y columns when query result changes
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

  // Auto-select diff aliases when workspace tables change
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
      setError(friendlyError(String(err)));
    } finally {
      setLoading(false);
    }
  }

  async function exportWorkspaceQuery(format: ExportFormat) {
    if (!workspaceQueryResult || !workspaceQueryResult.returns_rows || workspaceQueryResult.rows.length === 0) {
      setError("Run a query with results before exporting.");
      return;
    }
    // Export re-runs exactly what produced the results, not whatever the editor holds now.
    const lastRun = getLastRun();
    if (!lastRun) {
      setError("Run a query with results before exporting.");
      return;
    }
    // Exporting a "Run all" result runs its setup statements again; never repeat ones
    // that write files or could change an attached database.
    if (lastRun.setup.some(writesOutsideApp)) {
      setError(
        "Export would run this script's COPY, EXPORT or ATTACH statements again. "
        + "Run the final query on its own (select it and press Ctrl+Enter), then export.",
      );
      return;
    }

    const nowIso = new Date().toISOString().replace(/[:.]/g, "-");
    const selected = await save({
      title: `Export Workspace Query (${format.toUpperCase()})`,
      defaultPath: `workspace_query_${nowIso}.${format}`,
      filters: [
        {
          name: format === "xlsx" ? "Excel" : format.toUpperCase(),
          extensions: [format],
        },
      ],
    });
    if (!selected) {
      return;
    }

    const op = operations.start("export");
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<WorkspaceExportResponse>("export_workspace_query", {
        sql: lastRun.sql,
        setupSql: lastRun.setup,
        outputPath: selected,
        format,
        queryText: lastRun.sql,
        tableAliases: workspaceTables.map((t) => t.alias),
        queryId: op.id,
      });
      operations.finish(op);
      setWorkspaceExport(result);
    } catch (err) {
      if (!operations.finish(op, err)) setError(friendlyError(String(err)));
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

  return {
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
  };
}
