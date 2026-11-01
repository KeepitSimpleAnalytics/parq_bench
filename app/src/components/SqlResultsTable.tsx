import React from "react";
import type { WorkspaceQueryResponse } from "../types";
import { isNumericDuckType } from "../utils";

export interface SqlResultsTableProps {
  result: WorkspaceQueryResponse;
  onCopyColumn: (name: string) => void;
}

/** Query results: column types under names, numbers right-aligned, NULLs visually distinct. */
export const SqlResultsTable = React.memo(function SqlResultsTable({ result, onCopyColumn }: SqlResultsTableProps) {
  const numeric = result.schema.map((c) => isNumericDuckType(c.duckdb_type));
  return (
    <div className="results-scroll">
      <table className="data-table">
        <thead>
          <tr>
            {result.schema.map((col, i) => (
              <th key={`${col.name}-${i}`} scope="col" className={numeric[i] ? "num" : undefined}>
                <button type="button" className="th-button" title="Click to copy column name" onClick={() => onCopyColumn(col.name)}>
                  <span className="th-name">{col.name}</span>
                  <span className="th-type">{col.duckdb_type}</span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((value, colIndex) => (
                <td key={colIndex} className={numeric[colIndex] ? "num" : undefined}>
                  {value === null ? <span className="null-cell">NULL</span> : value}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});
