import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { WorkspaceTableInfo, WorkspaceSchemaByAlias, SummarizeRow } from "../types";
import { INTERNAL_TOOLS_ENABLED } from "../constants";
import { detectSourceKind, formatWorkspaceDelimiter, appendGlobPattern } from "../utils";

export interface WorkspaceTableRegistryProps {
  tables: WorkspaceTableInfo[];
  schemas: WorkspaceSchemaByAlias;
  loading: boolean;
  deepStats: boolean;
  workspaceSlowModeEnabled: boolean;
  onSlowModeChange: (enabled: boolean) => void;
  onRegister: (alias: string, filePath: string, isGlob: boolean, sourceKind: "parquet" | "delimited", delimiter?: string) => Promise<void>;
  onRemove: (alias: string) => Promise<void>;
  onRename: (oldAlias: string, newAlias: string) => Promise<void>;
  onClearAll: () => Promise<void>;
  onRemoveSelected: (aliases: Set<string>) => Promise<void>;
  onError: (msg: string) => void;
  schemaDiff: {
    leftAlias: string;
    rightAlias: string;
    result: import("../types").WorkspaceSchemaDiffResponse | null;
    setLeftAlias: (v: string) => void;
    setRightAlias: (v: string) => void;
    run: () => void;
  };
}

export function WorkspaceTableRegistry({
  tables,
  schemas,
  loading,
  deepStats,
  workspaceSlowModeEnabled,
  onSlowModeChange,
  onRegister,
  onRemove,
  onRename,
  onClearAll,
  onRemoveSelected,
  onError,
  schemaDiff,
}: WorkspaceTableRegistryProps) {
  // Internal states (previously in App)
  const [aliasInput, setAliasInput] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [isGlob, setIsGlob] = useState(false);
  const [delimiterInput, setDelimiterInput] = useState("");
  const [bulkSelectMode, setBulkSelectMode] = useState(false);
  const [bulkSelectedAliases, setBulkSelectedAliases] = useState<Set<string>>(new Set());
  const [columnSearchQuery, setColumnSearchQuery] = useState("");
  const [editingAlias, setEditingAlias] = useState<string | null>(null);
  const [editingAliasValue, setEditingAliasValue] = useState("");
  const [tableStats, setTableStats] = useState<Record<string, { rows: SummarizeRow[]; deep: boolean } | null>>({});
  const [statsLoading, setStatsLoading] = useState<string | null>(null);

  const sourceKind = detectSourceKind(pathInput);

  async function pickPath() {
    const filters = isGlob
      ? []
      : [
          { name: "Parquet", extensions: ["parquet"] },
          { name: "Delimited", extensions: ["csv", "tsv", "txt", "data"] },
        ];
    const selected = await open({
      title: isGlob ? "Select Workspace Source Folder" : "Select Workspace Table Source",
      multiple: false,
      directory: isGlob,
      filters: filters.length > 0 ? filters : undefined,
    });
    if (selected && !Array.isArray(selected)) {
      if (isGlob) {
        setPathInput(appendGlobPattern(selected, "*.parquet"));
      } else {
        setPathInput(selected);
      }
    }
  }

  async function handleRegister() {
    if (!aliasInput.trim() || !pathInput.trim()) {
      onError("Workspace alias and file path are required.");
      return;
    }
    const sk = detectSourceKind(pathInput.trim());
    const delimiter = sk === "delimited" ? delimiterInput.trim() || undefined : undefined;
    await onRegister(aliasInput.trim(), pathInput.trim(), isGlob, sk, delimiter);
    setAliasInput("");
    setPathInput("");
    setIsGlob(false);
    setDelimiterInput("");
  }

  async function handleRemoveSelected() {
    if (bulkSelectedAliases.size === 0) return;
    await onRemoveSelected(bulkSelectedAliases);
    setBulkSelectedAliases(new Set());
    setBulkSelectMode(false);
  }

  async function handleClearAll() {
    await onClearAll();
    setTableStats({});
    setBulkSelectMode(false);
    setBulkSelectedAliases(new Set());
  }

  async function loadStats(alias: string) {
    setStatsLoading(alias);
    try {
      const result = await invoke<SummarizeRow[]>("summarize_workspace_table", { alias, deep: deepStats });
      setTableStats((prev) => ({ ...prev, [alias]: { rows: result, deep: deepStats } }));
    } catch (err) {
      onError(String(err));
    } finally {
      setStatsLoading(null);
    }
  }

  return (
    <>
      <h3>Workspace Explorer</h3>
      <div className="workspace-mode-row">
        <label className="workspace-slow-toggle">
          <input
            type="checkbox"
            checked={workspaceSlowModeEnabled}
            onChange={(event) => onSlowModeChange(event.currentTarget.checked)}
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
      {sourceKind === "delimited" ? (
        <div className="workspace-source-row">
          <span className="phase">Detected: delimited file</span>
          <label>
            Delimiter
            <input
              type="text"
              value={delimiterInput}
              onChange={(event) => setDelimiterInput(event.currentTarget.value)}
              placeholder='Auto (.csv → ",", .tsv → "\t")'
            />
          </label>
        </div>
      ) : null}
      <div className="workspace-register-row">
        <input
          type="text"
          placeholder="alias (e.g. my_table)"
          value={aliasInput}
          onChange={(event) => setAliasInput(event.currentTarget.value)}
        />
        <input
          type="text"
          className="workspace-path-input"
          placeholder="file path or glob (e.g. *.parquet, *.csv)"
          value={pathInput}
          onChange={(event) => setPathInput(event.currentTarget.value)}
        />
        <label className="workspace-checkbox">
          <input
            type="checkbox"
            checked={isGlob}
            onChange={(event) => setIsGlob(event.currentTarget.checked)}
          />
          glob
        </label>
        <button type="button" onClick={() => void pickPath()} disabled={loading}>
          Browse
        </button>
        <button type="button" onClick={() => void handleRegister()} disabled={loading}>
          Mount
        </button>
      </div>

      <div className="workspace-list">
        <strong>Tables:</strong>{" "}
        {tables.length >= 2 ? (
          <>
            <button type="button" style={{ padding: "2px 7px", fontSize: "0.75rem" }}
              onClick={() => void handleClearAll()} disabled={loading}>
              Clear All
            </button>
            <button type="button" style={{ padding: "2px 7px", fontSize: "0.75rem" }}
              onClick={() => { setBulkSelectMode((p) => !p); setBulkSelectedAliases(new Set()); }}>
              {bulkSelectMode ? "Cancel Select" : "Select"}
            </button>
            {bulkSelectMode && bulkSelectedAliases.size > 0 ? (
              <button type="button" style={{ padding: "2px 7px", fontSize: "0.75rem" }}
                onClick={() => void handleRemoveSelected()} disabled={loading}>
                Remove Selected ({bulkSelectedAliases.size})
              </button>
            ) : null}
          </>
        ) : null}
        {tables.length === 0
          ? "none"
          : tables.map((table) => (
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
                          void onRename(table.alias, trimmed);
                        }
                        setEditingAlias(null);
                      } else if (e.key === "Escape") {
                        setEditingAlias(null);
                      }
                    }}
                    onBlur={() => {
                      const trimmed = editingAliasValue.trim();
                      if (trimmed && trimmed !== table.alias) {
                        void onRename(table.alias, trimmed);
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
                    if (tableStats[table.alias]) {
                      setTableStats((prev) => ({ ...prev, [table.alias]: null }));
                    } else {
                      void loadStats(table.alias);
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
                    void onRemove(table.alias);
                    setTableStats((prev) => { const n = { ...prev }; delete n[table.alias]; return n; });
                  }}
                  disabled={loading}
                >
                  x
                </button>
              </span>
            ))}
      </div>
      {tables.map((table) => {
        const stats = tableStats[table.alias];
        if (!stats) return null;
        return (
          <details key={`stats-${table.alias}`} open style={{ marginBottom: 8 }}>
            <summary style={{ cursor: "pointer", fontSize: "0.85rem", fontWeight: 600, marginBottom: 4 }}>
              Stats: {table.alias} <span style={{ fontWeight: 400, fontSize: "0.78rem", color: "var(--text-soft)" }}>({stats.deep ? "deep scan" : "metadata"})</span>
              <button type="button" style={{ marginLeft: 8, padding: "1px 6px", fontSize: "0.72rem" }}
                onClick={(e) => { e.stopPropagation(); setTableStats((prev) => ({ ...prev, [table.alias]: null })); }}>
                Hide
              </button>
            </summary>
            <div className="table-wrap" style={{ maxHeight: 240, overflowY: "auto" }}>
              {(() => {
                const ALL_STATS_COLS = ["column_name","column_type","min","max","approx_unique","avg","std","q25","q50","q75","count","null_percentage"];
                const STATS_COLS = stats.rows.length > 0 ? ALL_STATS_COLS.filter((c) => c in stats.rows[0]) : [];
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
                      {stats.rows.map((row, ri) => (
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
      {tables.length > 0 ? (
        <>
          {tables.length >= 2 ? (
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
              const filtered = tables.filter((table) => {
                if (!query) return true;
                const schema = schemas[table.alias] ?? [];
                return schema.some((col) => col.name.toLowerCase().includes(query));
              });
              if (query && filtered.length === 0) {
                return <span className="phase">No matching columns found.</span>;
              }
              return filtered.map((table) => {
                const schema = schemas[table.alias] ?? [];
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
            <select value={schemaDiff.leftAlias} onChange={(event) => schemaDiff.setLeftAlias(event.currentTarget.value)}>
              <option value="">Select table</option>
              {tables.map((table) => (
                <option key={`diff-left-${table.alias}`} value={table.alias}>
                  {table.alias}
                </option>
              ))}
            </select>
          </label>
          <label>
            Diff Right
            <select value={schemaDiff.rightAlias} onChange={(event) => schemaDiff.setRightAlias(event.currentTarget.value)}>
              <option value="">Select table</option>
              {tables.map((table) => (
                <option key={`diff-right-${table.alias}`} value={table.alias}>
                  {table.alias}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={schemaDiff.run} disabled={loading || tables.length < 2}>
            Run Schema Diff
          </button>
        </div>
      ) : null}

      {INTERNAL_TOOLS_ENABLED && schemaDiff.result ? (
        <>
          <p className="meta-line">
            <span>
              <strong>Added:</strong> {schemaDiff.result.added_count}
            </span>
            <span>
              <strong>Removed:</strong> {schemaDiff.result.removed_count}
            </span>
            <span>
              <strong>Type Changed:</strong> {schemaDiff.result.type_changed_count}
            </span>
            <span>
              <strong>Unchanged:</strong> {schemaDiff.result.unchanged_count}
            </span>
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Column</th>
                  <th>{schemaDiff.result.left_alias}</th>
                  <th>{schemaDiff.result.right_alias}</th>
                  <th>Change</th>
                </tr>
              </thead>
              <tbody>
                {schemaDiff.result.columns.map((column) => (
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
    </>
  );
}
