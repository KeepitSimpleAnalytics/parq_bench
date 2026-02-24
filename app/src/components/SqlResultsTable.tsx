import React from "react";
import type { WorkspaceQueryResponse } from "../types";

export interface SqlResultsTableProps {
  result: WorkspaceQueryResponse;
  expandedPanel: "preview-table" | "perspective" | "sql-results" | null;
  expandMode: "fullscreen" | "resize";
  onToggleExpand: () => void;
  onCopyColumns: (text: string) => void;
}

export const SqlResultsTable = React.memo(function SqlResultsTable({
  result,
  expandedPanel,
  expandMode,
  onToggleExpand,
  onCopyColumns,
}: SqlResultsTableProps) {
  return (
    <div className={expandedPanel === "sql-results" ? `sql-results-section ${expandMode === "resize" ? "resizable-panel" : "expanded-panel"}` : "sql-results-section"}>
      <p className="meta-line">
        <span>
          <strong>Rows:</strong> {result.row_count}
          {result.truncated ? ` (truncated to ${result.row_limit})` : ""}
        </span>
        <span>
          <strong>Elapsed:</strong> {result.elapsed_ms.toFixed(0)}ms
        </span>
        <span>
          <strong>Columns:</strong> {result.schema.length}
        </span>
        <button type="button" style={{ padding: "2px 7px", fontSize: "0.76rem" }}
          onClick={() => onCopyColumns(result.schema.map((c) => c.name).join(", "))}>
          Copy All Columns
        </button>
        <button type="button" className="expand-btn" title={expandedPanel === "sql-results" ? (expandMode === "fullscreen" ? "Exit fullscreen (Esc)" : "Collapse") : "Expand results"}
          onClick={onToggleExpand}>
          {expandedPanel === "sql-results" ? "\u2716" : (expandMode === "resize" ? "\u2922" : "\u26F6")}
        </button>
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {result.schema.map((col) => (
                <th key={`workspace-col-${col.name}`} title={`${col.duckdb_type} — click to copy`}
                  className="col-copyable"
                  onClick={() => onCopyColumns(col.name)}>
                  {col.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, rowIndex) => (
              <tr key={`workspace-row-${rowIndex}`}>
                {row.map((value, colIndex) => (
                  <td key={`workspace-cell-${rowIndex}-${colIndex}`}>{value ?? "NULL"}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
});
