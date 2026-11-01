import { useEffect, useRef, useState } from "react";
import type { ExportFormat, QueryHistoryEntry, SavedQuery } from "../types";
import { Icon } from "./Icon";

/** Closes a popover on outside click or Escape. */
function useDismiss(open: boolean, setOpen: (v: boolean) => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.stopPropagation(); setOpen(false); }
    }
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, setOpen]);
  return ref;
}

/** The caret beside Run: runs every statement in the editor. */
export function RunMenu({ disabled, onRunAll }: { disabled: boolean; onRunAll: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, setOpen);
  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className="btn btn-primary split-btn-caret" aria-haspopup="menu" aria-expanded={open}
        aria-label="More run options" title="More run options" disabled={disabled} onClick={() => setOpen((o) => !o)}>
        <Icon name="chevronDown" size={12} />
      </button>
      {open ? (
        <div role="menu" className="menu">
          <button type="button" role="menuitem" className="menu-item menu-item-nowrap" onClick={() => { setOpen(false); onRunAll(); }}>
            Run all statements <kbd className="kbd">Ctrl+Alt+Enter</kbd>
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function ExportMenu({ disabled, onExport }: { disabled: boolean; onExport: (format: ExportFormat) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, setOpen);
  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className="btn" aria-haspopup="menu" aria-expanded={open} disabled={disabled}
        title="Export all result rows" onClick={() => setOpen((o) => !o)}>
        <Icon name="download" size={15} /> Export <Icon name="chevronDown" size={12} />
      </button>
      {open ? (
        <div role="menu" className="menu menu-right">
          <button type="button" role="menuitem" className="menu-item" onClick={() => { setOpen(false); onExport("csv"); }}>
            CSV <kbd className="kbd">Ctrl+Shift+E</kbd>
          </button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => { setOpen(false); onExport("parquet"); }}>
            Parquet
          </button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => { setOpen(false); onExport("xlsx"); }}>
            Excel (.xlsx)
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function HistoryMenu({
  history,
  onSelect,
  onClear,
}: {
  history: QueryHistoryEntry[];
  onSelect: (sql: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, setOpen);
  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className="btn" aria-haspopup="menu" aria-expanded={open} disabled={history.length === 0}
        title="Query history" onClick={() => setOpen((o) => !o)}>
        <Icon name="history" size={15} /> History
      </button>
      {open ? (
        <div role="menu" className="menu menu-right menu-wide">
          <div className="menu-head">
            <strong>Recent queries</strong>
            <button type="button" className="btn btn-link btn-xs" onClick={() => { onClear(); setOpen(false); }}>Clear</button>
          </div>
          {history.map((entry) => (
            <button key={entry.timestamp} type="button" role="menuitem" className="menu-item history-item"
              onClick={() => { onSelect(entry.sql); setOpen(false); }}>
              <span className="history-sql">{entry.sql}</span>
              <span className="history-meta">
                {new Date(entry.timestamp).toLocaleString()}
                {entry.rowCount != null ? ` · ${entry.rowCount.toLocaleString()} rows` : ""}
                {entry.elapsedMs != null ? ` · ${entry.elapsedMs.toFixed(0)} ms` : ""}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Named queries kept in the app data folder: save the editor text, open or delete one. */
export function SavedMenu({
  saved,
  openName,
  loadError,
  onOpen,
  onSaveAs,
  onDelete,
  onMenuOpen,
}: {
  saved: SavedQuery[];
  /** The saved query currently open in the editor, if any. */
  openName: string | null;
  /** Set when the saved-queries file couldn't be read. */
  loadError: string | null;
  onOpen: (query: SavedQuery) => void;
  onSaveAs: () => void;
  onDelete: (query: SavedQuery) => void;
  onMenuOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, setOpen);
  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className="btn" aria-haspopup="dialog" aria-expanded={open}
        title="Saved queries (Ctrl+S saves the editor text)"
        onClick={() => setOpen((o) => { if (!o) onMenuOpen(); return !o; })}>
        <Icon name="bookmark" size={15} /> Saved
      </button>
      {open ? (
        // A panel of rows with two actions each (open, delete), so not role="menu".
        <div role="dialog" aria-label="Saved queries" className="menu menu-right menu-wide">
          <div className="menu-head">
            <strong>Saved queries</strong>
            <button type="button" className="btn btn-link btn-xs" disabled={loadError !== null}
              onClick={() => { setOpen(false); onSaveAs(); }}>
              Save current as…
            </button>
          </div>
          {loadError ? (
            <p className="menu-note menu-note-error" role="alert">{loadError}</p>
          ) : saved.length === 0 ? (
            <p className="menu-note">No saved queries yet. Press <kbd className="kbd">Ctrl+S</kbd> to save the editor text.</p>
          ) : saved.map((query) => (
            <div key={query.name} className={`saved-row${query.name === openName ? " saved-row-open" : ""}`}>
              <button type="button" className="menu-item history-item saved-open"
                onClick={() => { setOpen(false); onOpen(query); }}>
                <span className="saved-name">{query.name}</span>
                <span className="history-sql">{query.sql}</span>
                <span className="history-meta">{new Date(query.updated_at_ms).toLocaleString()}</span>
              </button>
              <button type="button" className="icon-btn icon-btn-ghost saved-delete" aria-label={`Delete ${query.name}`}
                title="Delete" onClick={() => onDelete(query)}>
                <Icon name="close" size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
