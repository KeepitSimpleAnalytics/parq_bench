import { useEffect, useRef, useState } from "react";
import type { QueryHistoryEntry } from "../types";
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

export function ExportMenu({ disabled, onExport }: { disabled: boolean; onExport: (format: "csv" | "parquet") => void }) {
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
