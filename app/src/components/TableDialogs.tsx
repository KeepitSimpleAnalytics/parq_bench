import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SummarizeRow, WorkspaceSchemaDiffResponse, WorkspaceTableInfo } from "../types";
import { friendlyError } from "../utils";
import { Modal } from "./Modal";
import { Icon } from "./Icon";
import { InlineError } from "./AppChrome";

const STATS_COLUMNS: Array<[string, string]> = [
  ["column_name", "Column"],
  ["column_type", "Type"],
  ["min", "Min"],
  ["max", "Max"],
  ["approx_unique", "Distinct (approx.)"],
  ["avg", "Avg"],
  ["std", "Std dev"],
  ["q25", "Q25"],
  ["q50", "Median"],
  ["q75", "Q75"],
  ["count", "Count"],
  ["null_percentage", "Null %"],
];
const LEFT_ALIGNED = new Set(["column_name", "column_type", "min", "max"]);

export function TableStatsDialog({ alias, deep, onClose }: { alias: string | null; deep: boolean; onClose: () => void }) {
  const [rows, setRows] = useState<SummarizeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!alias) return;
    let cancelled = false;
    setRows(null);
    setError(null);
    setLoading(true);
    invoke<SummarizeRow[]>("summarize_workspace_table", { alias, deep })
      .then((result) => { if (!cancelled) setRows(result); })
      .catch((err) => { if (!cancelled) setError(friendlyError(String(err))); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [alias, deep]);

  const columns = rows && rows.length > 0 ? STATS_COLUMNS.filter(([key]) => key in rows[0]) : [];

  return (
    <Modal open={alias !== null} title={`Stats: ${alias ?? ""}`} onClose={onClose} width={1100}
      footer={<button type="button" className="btn btn-primary" onClick={onClose}>Close</button>}>
      <p className="muted small">
        {deep ? "Exact values from a full table scan." : "Instant values from Parquet metadata. Turn on Exact table stats in Settings for a full scan."}
      </p>
      {loading ? (
        <div className="loading-state"><Icon name="spinner" size={22} className="spin" /> {deep ? "Scanning table…" : "Reading metadata…"}</div>
      ) : null}
      {error ? <p className="text-danger">{error}</p> : null}
      {rows && rows.length > 0 ? (
        <div className="table-box tall">
          <table className="data-table compact">
            <thead>
              <tr>{columns.map(([key, label]) => <th key={key} scope="col" className={LEFT_ALIGNED.has(key) ? undefined : "num"}>{label}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri}>
                  {columns.map(([key]) => {
                    const value = row[key];
                    const empty = value === undefined || value === null || value === "";
                    return (
                      <td key={key} className={LEFT_ALIGNED.has(key) ? (key === "column_name" ? "strong" : undefined) : "num"}>
                        {empty ? <span className="null-cell">—</span> : value}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {rows && rows.length === 0 ? <p className="muted">No statistics returned.</p> : null}
    </Modal>
  );
}

const CHANGE_LABEL: Record<WorkspaceSchemaDiffResponse["columns"][number]["change"], string> = {
  added: "Only in right",
  removed: "Only in left",
  type_changed: "Type changed",
  unchanged: "Same",
};

export function SchemaDiffDialog({
  open,
  onClose,
  tables,
  leftAlias,
  rightAlias,
  setLeftAlias,
  setRightAlias,
  result,
  onRun,
  busy,
  error,
  onDismissError,
}: {
  open: boolean;
  onClose: () => void;
  tables: WorkspaceTableInfo[];
  leftAlias: string;
  rightAlias: string;
  setLeftAlias: (v: string) => void;
  setRightAlias: (v: string) => void;
  result: WorkspaceSchemaDiffResponse | null;
  onRun: () => void;
  busy: boolean;
  error: string | null;
  onDismissError: () => void;
}) {
  const [hideSame, setHideSame] = useState(false);
  const shown = result ? result.columns.filter((c) => !hideSame || c.change !== "unchanged") : [];
  return (
    <Modal open={open} title="Compare schemas" onClose={onClose} width={760}
      footer={<button type="button" className="btn btn-primary" onClick={onClose}>Close</button>}>
      <div className="field-row align-end">
        <div className="field">
          <label htmlFor="diff-left" className="field-label">Left table</label>
          <select id="diff-left" className="input" value={leftAlias} onChange={(e) => setLeftAlias(e.currentTarget.value)}>
            {tables.map((t) => <option key={t.alias} value={t.alias}>{t.alias}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="diff-right" className="field-label">Right table</label>
          <select id="diff-right" className="input" value={rightAlias} onChange={(e) => setRightAlias(e.currentTarget.value)}>
            {tables.map((t) => <option key={t.alias} value={t.alias}>{t.alias}</option>)}
          </select>
        </div>
        <button type="button" className="btn btn-primary" onClick={onRun} disabled={busy || !leftAlias || !rightAlias || leftAlias === rightAlias}>
          Compare
        </button>
      </div>
      <InlineError message={error} onDismiss={onDismissError} />
      {leftAlias && leftAlias === rightAlias ? <p className="text-warning small">Pick two different tables.</p> : null}

      {result ? (
        <>
          <div className="diff-summary">
            <span className="chip chip-add">{result.added_count} only in {result.right_alias}</span>
            <span className="chip chip-remove">{result.removed_count} only in {result.left_alias}</span>
            <span className="chip chip-change">{result.type_changed_count} type changed</span>
            <span className="chip">{result.unchanged_count} same</span>
            <label className="inline-check">
              <input type="checkbox" className="checkbox" checked={hideSame} onChange={(e) => setHideSame(e.currentTarget.checked)} />
              Hide unchanged
            </label>
          </div>
          <div className="table-box tall">
            <table className="data-table compact">
              <thead>
                <tr>
                  <th scope="col">Column</th>
                  <th scope="col">{result.left_alias}</th>
                  <th scope="col">{result.right_alias}</th>
                  <th scope="col">Change</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.name} className={`diff-${c.change}`}>
                    <td className="strong mono">{c.name}</td>
                    <td className="mono">{c.left_type ?? <span className="null-cell">—</span>}</td>
                    <td className="mono">{c.right_type ?? <span className="null-cell">—</span>}</td>
                    <td>{CHANGE_LABEL[c.change]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
