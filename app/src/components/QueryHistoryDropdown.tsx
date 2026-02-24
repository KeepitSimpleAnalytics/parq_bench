import React from "react";
import type { QueryHistoryEntry } from "../types";

export interface QueryHistoryDropdownProps {
  history: QueryHistoryEntry[];
  open: boolean;
  onToggle: () => void;
  onSelect: (sql: string) => void;
  onClear: () => void;
}

export const QueryHistoryDropdown = React.memo(function QueryHistoryDropdown({
  history,
  open,
  onToggle,
  onSelect,
  onClear,
}: QueryHistoryDropdownProps) {
  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button type="button" onClick={onToggle} disabled={history.length === 0}>
        History ({history.length})
      </button>
      {open ? (
        <div style={{ position: "absolute", top: "100%", left: 0, zIndex: 100, background: "var(--surface-strong)", border: "1px solid var(--border)", borderRadius: 8, padding: 6, maxHeight: 280, overflowY: "auto", minWidth: 340, boxShadow: "0 8px 24px rgba(0,0,0,0.15)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <strong style={{ fontSize: "0.82rem" }}>Query History</strong>
            <button type="button" style={{ padding: "2px 6px", fontSize: "0.72rem" }} onClick={onClear}>Clear</button>
          </div>
          {history.map((entry, idx) => (
            <div key={`qh-${idx}`}
              style={{ padding: "4px 6px", borderBottom: "1px solid var(--border)", cursor: "pointer", fontSize: "0.8rem" }}
              onClick={() => onSelect(entry.sql)}
            >
              <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 320, fontFamily: "monospace" }}>
                {entry.sql}
              </div>
              <div style={{ fontSize: "0.72rem", color: "var(--text-soft)" }}>
                {new Date(entry.timestamp).toLocaleString()}
                {entry.rowCount != null ? ` | ${entry.rowCount} rows` : ""}
                {entry.elapsedMs != null ? ` | ${entry.elapsedMs.toFixed(0)}ms` : ""}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
});
