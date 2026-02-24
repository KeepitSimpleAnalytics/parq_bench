import React from "react";
import type { PreviewColumn } from "../types";
import { ROW_HEIGHT } from "../constants";

export interface VirtualScrollGridProps {
  schema: PreviewColumn[];
  loadedRows: Map<number, Array<string | null>>;
  visibleIndices: readonly number[];
  totalRows: number;
  scrollLeft: number;
  gridContentWidth: number;
  columnGridTemplate: string;
  onScroll: (scrollTop: number, scrollLeft: number) => void;
  onCopyColumn: (name: string) => void;
}

export const VirtualScrollGrid = React.memo(function VirtualScrollGrid({
  schema,
  loadedRows,
  visibleIndices,
  totalRows,
  scrollLeft,
  gridContentWidth,
  columnGridTemplate,
  onScroll,
  onCopyColumn,
}: VirtualScrollGridProps) {
  return (
    <>
      <div className="virtual-header-track">
        <div
          className="virtual-header-row"
          style={{
            gridTemplateColumns: columnGridTemplate,
            width: `${gridContentWidth}px`,
            transform: `translateX(-${scrollLeft}px)`,
          }}
        >
          {schema.map((col) => (
            <div key={col.name} className="virtual-cell virtual-cell-head col-copyable"
              title={`${col.duckdb_type} — click to copy`}
              onClick={() => onCopyColumn(col.name)}>
              {col.name}
            </div>
          ))}
        </div>
      </div>
      <div
        className="virtual-grid"
        onScroll={(event) => {
          onScroll(event.currentTarget.scrollTop, event.currentTarget.scrollLeft);
        }}
      >
        <div className="virtual-spacer" style={{ height: `${totalRows * ROW_HEIGHT}px`, width: `${gridContentWidth}px` }}>
          {visibleIndices.map((index) => {
            const row = loadedRows.get(index);
            return (
              <div
                key={`virtual-row-${index}`}
                className="virtual-row"
                style={{
                  top: `${index * ROW_HEIGHT}px`,
                  height: `${ROW_HEIGHT}px`,
                  width: `${gridContentWidth}px`,
                  gridTemplateColumns: columnGridTemplate,
                }}
              >
                {schema.map((col, colIndex) => (
                  <div key={`virtual-cell-${index}-${col.name}`} className="virtual-cell" title={row?.[colIndex] ?? "NULL"}>
                    {row ? (row[colIndex] ?? "NULL") : "..."}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
});
