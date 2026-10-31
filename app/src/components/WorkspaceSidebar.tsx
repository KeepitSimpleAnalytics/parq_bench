import { useEffect, useRef, useState } from "react";
import type { WorkspaceTableInfo, WorkspaceSchemaByAlias } from "../types";
import { formatCompactCount, isValidAlias } from "../utils";
import { Icon } from "./Icon";

const COLUMNS_PREVIEW = 8;

export interface WorkspaceSidebarProps {
  tables: WorkspaceTableInfo[];
  schemas: WorkspaceSchemaByAlias;
  loading: boolean;
  onAddTable: () => void;
  onRemove: (alias: string) => void;
  onRename: (oldAlias: string, newAlias: string) => void;
  onClearAll: () => void;
  onRemoveSelected: (aliases: Set<string>) => void;
  onInsertSelect: (alias: string) => void;
  onShowStats: (alias: string) => void;
  /** Opens a single-file Parquet table in the Preview tab for full scrolling. */
  onPreview: (table: WorkspaceTableInfo) => void;
  onCompareSchemas: () => void;
  onError: (message: string) => void;
}

function kindLabel(table: WorkspaceTableInfo): string {
  const base = baseKindLabel(table);
  return table.is_remote ? `URL · ${base}` : base;
}

function baseKindLabel(table: WorkspaceTableInfo): string {
  if (table.source_kind === "parquet") return "PARQUET";
  if (table.source_kind === "excel") return "XLSX";
  if (table.source_kind === "sqlite") return "SQLITE";
  if (table.source_kind === "delta") return "DELTA";
  // URLs: ignore ?query and #fragment when reading the extension.
  const match = table.file_path.toLowerCase().replace(/[?#].*$/, "").match(/\.([a-z0-9]+)$/);
  const ext = match ? match[1].toUpperCase() : "TEXT";
  const delim = table.delimiter === "\t" ? "\\t" : table.delimiter;
  return delim && ext !== "CSV" && ext !== "TSV" ? `${ext} ${delim}` : ext;
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

export function WorkspaceSidebar({
  tables,
  schemas,
  loading,
  onAddTable,
  onRemove,
  onRename,
  onClearAll,
  onRemoveSelected,
  onInsertSelect,
  onShowStats,
  onPreview,
  onCompareSchemas,
  onError,
}: WorkspaceSidebarProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showAllColumns, setShowAllColumns] = useState<Set<string>>(new Set());
  const [searchInput, setSearchInput] = useState("");
  const [renaming, setRenaming] = useState<{ alias: string; value: string } | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const query = useDebounced(searchInput.trim().toLowerCase(), 150);
  // Rename commits exactly once, on blur; Enter blurs, Escape cancels then blurs.
  const renameCancelledRef = useRef(false);

  // Drop stale aliases from local UI state when tables change.
  useEffect(() => {
    const aliases = new Set(tables.map((t) => t.alias));
    const prune = (prev: Set<string>) => {
      const next = new Set([...prev].filter((a) => aliases.has(a)));
      return next.size === prev.size ? prev : next;
    };
    setExpanded(prune);
    setSelected(prune);
    setShowAllColumns(prune);
    if (tables.length < 2) setSelectMode(false);
  }, [tables]);

  function toggle(set: Set<string>, alias: string): Set<string> {
    const next = new Set(set);
    if (next.has(alias)) next.delete(alias); else next.add(alias);
    return next;
  }

  function commitRename() {
    if (!renaming) return;
    if (renameCancelledRef.current) {
      renameCancelledRef.current = false;
      setRenaming(null);
      return;
    }
    const value = renaming.value.trim();
    if (value && value !== renaming.alias) {
      if (!isValidAlias(value)) {
        onError("Table names use letters, numbers and underscores, starting with a letter or underscore.");
      } else {
        onRename(renaming.alias, value);
      }
    }
    setRenaming(null);
  }

  const visibleTables = tables.filter((table) => {
    if (!query) return true;
    return (schemas[table.alias] ?? []).some((c) => c.name.toLowerCase().includes(query)) || table.alias.toLowerCase().includes(query);
  });

  return (
    <aside className="sidebar" aria-label="Workspace tables">
      <div className="sidebar-head">
        <h2 className="section-label">Tables · {tables.length}</h2>
        <button type="button" className="btn btn-outline btn-sm" onClick={onAddTable} disabled={loading}>
          <Icon name="plus" size={14} /> Add table
        </button>
      </div>

      {tables.length > 0 ? (
        <div className="sidebar-search">
          <Icon name="search" size={14} className="muted" />
          <input type="text" aria-label="Search columns" placeholder="Search columns" value={searchInput}
            onChange={(e) => setSearchInput(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Escape" && searchInput) { e.stopPropagation(); setSearchInput(""); } }} />
          {searchInput ? (
            <button type="button" className="icon-btn icon-btn-ghost icon-btn-xs" aria-label="Clear search" onClick={() => setSearchInput("")}>
              <Icon name="close" size={12} />
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="sidebar-list">
        {tables.length === 0 ? (
          <div className="sidebar-empty">
            <p>No tables yet.</p>
            <p className="muted small">Add a Parquet, CSV/TSV/PSV/TXT, Excel or SQLite file, a Delta table or a web link — or drop files anywhere on this tab.</p>
          </div>
        ) : null}
        {query && visibleTables.length === 0 ? <p className="sidebar-empty muted small">No columns match “{searchInput.trim()}”.</p> : null}

        {visibleTables.map((table) => {
          const schema = schemas[table.alias] ?? [];
          const matching = query ? schema.filter((c) => c.name.toLowerCase().includes(query)) : schema;
          const isOpen = query ? matching.length > 0 : expanded.has(table.alias);
          const showAll = showAllColumns.has(table.alias) || Boolean(query);
          const shownColumns = showAll ? matching : matching.slice(0, COLUMNS_PREVIEW);
          const hiddenCount = matching.length - shownColumns.length;
          const isRenaming = renaming?.alias === table.alias;

          return (
            <div key={table.alias} className="tree-item">
              <div className="tree-row" title={table.object_name ? `${table.file_path} · ${table.source_kind === "excel" ? "sheet" : "table"} ${table.object_name}` : table.file_path}>
                {selectMode ? (
                  <input type="checkbox" className="checkbox" aria-label={`Select ${table.alias}`}
                    checked={selected.has(table.alias)} onChange={() => setSelected((s) => toggle(s, table.alias))} />
                ) : null}
                <button type="button" className="tree-toggle" aria-expanded={isOpen}
                  aria-label={`${isOpen ? "Hide" : "Show"} columns of ${table.alias}`}
                  onClick={() => setExpanded((s) => toggle(s, table.alias))}>
                  <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={14} />
                </button>
                {isRenaming ? (
                  <input type="text" className="input input-mono rename-input" aria-label={`New name for ${table.alias}`} autoFocus
                    value={renaming.value}
                    onChange={(e) => setRenaming({ alias: table.alias, value: e.currentTarget.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") { e.stopPropagation(); renameCancelledRef.current = true; e.currentTarget.blur(); }
                    }}
                    onBlur={commitRename} />
                ) : (
                  <span className="tree-alias">{table.alias}</span>
                )}
                <span className={table.source_kind === "parquet" ? "kind-badge" : "kind-badge is-text"}>{kindLabel(table)}</span>
                {table.is_glob ? <span className="kind-badge is-folder" title="Folder of files">folder</span> : null}
                <span className="tree-count" title={table.row_count !== null ? `${table.row_count.toLocaleString()} rows` : "Row count is only shown for Parquet files (other sources need a full scan)"}>
                  {table.row_count !== null ? formatCompactCount(table.row_count) : ""}
                </span>
              </div>

              {isOpen ? (
                <div className="tree-children">
                  {schema.length === 0 ? <span className="muted small">Schema unavailable</span> : null}
                  {query && query.length > 0 && matching.length > 0 ? (
                    <span className="muted small">{matching.length} of {schema.length} columns match</span>
                  ) : null}
                  {shownColumns.map((col) => (
                    <div key={col.name} className="tree-col">
                      <span className={query && col.name.toLowerCase().includes(query) ? "tree-col-name is-match" : "tree-col-name"}>{col.name}</span>
                      <span className="tree-col-type">{col.duckdb_type}</span>
                    </div>
                  ))}
                  {hiddenCount > 0 ? (
                    <button type="button" className="btn btn-link btn-xs" onClick={() => setShowAllColumns((s) => toggle(s, table.alias))}>
                      + {hiddenCount} more {hiddenCount === 1 ? "column" : "columns"}
                    </button>
                  ) : null}
                  {!query && showAllColumns.has(table.alias) && schema.length > COLUMNS_PREVIEW ? (
                    <button type="button" className="btn btn-link btn-xs" onClick={() => setShowAllColumns((s) => toggle(s, table.alias))}>
                      Show fewer
                    </button>
                  ) : null}
                  <div className="tree-actions">
                    {table.source_kind === "parquet" && !table.is_glob ? (
                      <button type="button" className="btn btn-xs" title="Scroll the whole file in the Preview tab"
                        onClick={() => onPreview(table)} disabled={loading}>
                        Preview
                      </button>
                    ) : null}
                    <button type="button" className="btn btn-xs" onClick={() => onShowStats(table.alias)} disabled={loading}>Stats</button>
                    <button type="button" className="btn btn-xs" onClick={() => { renameCancelledRef.current = false; setRenaming({ alias: table.alias, value: table.alias }); }} disabled={loading}>Rename</button>
                    <button type="button" className="btn btn-xs" onClick={() => onInsertSelect(table.alias)}>Insert SELECT</button>
                    <button type="button" className="btn btn-xs btn-danger-outline" onClick={() => onRemove(table.alias)} disabled={loading}>Remove</button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {tables.length > 0 ? (
        <div className="sidebar-foot">
          {selectMode ? (
            <>
              <button type="button" className="btn btn-sm btn-danger-outline grow" disabled={loading || selected.size === 0}
                onClick={() => { onRemoveSelected(selected); setSelected(new Set()); setSelectMode(false); }}>
                Remove selected ({selected.size})
              </button>
              <button type="button" className="btn btn-sm" onClick={() => { setSelectMode(false); setSelected(new Set()); }}>Cancel</button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn-sm grow" onClick={onCompareSchemas} disabled={loading || tables.length < 2}
                title={tables.length < 2 ? "Add at least two tables to compare" : undefined}>
                Compare schemas
              </button>
              {tables.length >= 2 ? (
                <button type="button" className="btn btn-sm" onClick={() => setSelectMode(true)} disabled={loading}>Select</button>
              ) : null}
              <button type="button" className="btn btn-sm" onClick={onClearAll} disabled={loading}>Clear all</button>
            </>
          )}
        </div>
      ) : null}
    </aside>
  );
}
