import React, { useMemo } from "react";
import type { PreviewColumn } from "../types";
import { ROW_HEIGHT } from "../constants";
import { isNumericDuckType } from "../utils";

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
  const numeric = useMemo(() => schema.map((c) => isNumericDuckType(c.duckdb_type)), [schema]);
  return (
    <div className="virtual-wrap">
      <div className="virtual-header-track">
        <div
          className="virtual-header-row"
          style={{
            gridTemplateColumns: columnGridTemplate,
            width: `${gridContentWidth}px`,
            transform: `translateX(-${scrollLeft}px)`,
          }}
        >
          {schema.map((col, i) => (
            <button key={col.name} type="button"
              className={numeric[i] ? "virtual-cell virtual-cell-head num" : "virtual-cell virtual-cell-head"}
              title="Click to copy column name"
              onClick={() => onCopyColumn(col.name)}>
              <span className="th-name">{col.name}</span>
              <span className="th-type">{col.duckdb_type}</span>
            </button>
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
                {schema.map((col, colIndex) => {
                  const value = row ? row[colIndex] ?? null : undefined;
                  const cls = numeric[colIndex] ? "virtual-cell num" : "virtual-cell";
                  if (value === undefined) {
                    return <div key={col.name} className={`${cls} loading-cell`}>…</div>;
                  }
                  if (value === null) {
                    return <div key={col.name} className={cls}><span className="null-cell">NULL</span></div>;
                  }
                  return <div key={col.name} className={cls} title={value}>{value}</div>;
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});
