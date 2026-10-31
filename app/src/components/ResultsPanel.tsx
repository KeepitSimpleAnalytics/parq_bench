import { useEffect, useState } from "react";
import type { PreviewColumn, ResultTab, WorkspaceChartPlugin, WorkspaceQueryResponse } from "../types";
import { CHART_AGGREGATES, CHART_TYPES } from "../constants";
import { formatDuration } from "../utils";
import { Icon } from "./Icon";
import { InlineError } from "./AppChrome";
import { SqlResultsTable } from "./SqlResultsTable";

export interface ChartControls {
  plugin: WorkspaceChartPlugin;
  setPlugin: (p: WorkspaceChartPlugin) => void;
  x: string;
  setX: (v: string) => void;
  y: string;
  setY: (v: string) => void;
  agg: string;
  setAgg: (v: string) => void;
  columns: PreviewColumn[];
  numericColumns: PreviewColumn[];
  status: "idle" | "loading" | "ready" | "error";
}

export interface ResultsPanelProps {
  tab: ResultTab;
  onTabChange: (tab: ResultTab) => void;
  showChartTab: boolean;
  result: WorkspaceQueryResponse | null;
  runningSince: number | null;
  explainRunning: boolean;
  explainPlan: string | null;
  error: string | null;
  onDismissError: () => void;
  onCopyColumn: (name: string) => void;
  onCopyAllColumns: () => void;
  chart: ChartControls;
  /** The Perspective host; stays mounted so the viewer survives tab switches. */
  chartHost: React.ReactNode;
  expanded: boolean;
  expandMode: "fullscreen" | "resize";
  onToggleExpand: () => void;
}

function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [since]);
  return since === null ? 0 : Math.max(0, now - since);
}

export function ResultsPanel(props: ResultsPanelProps) {
  const { tab, onTabChange, showChartTab, result, runningSince, explainRunning, explainPlan, error, chart } = props;
  const elapsed = useElapsed(runningSince);
  const tabs: Array<{ id: ResultTab; label: string }> = [
    { id: "results", label: "Results" },
    ...(showChartTab ? [{ id: "chart" as const, label: "Chart" }] : []),
    { id: "plan", label: "Plan" },
  ];
  const activeTab = !showChartTab && tab === "chart" ? "results" : tab;
  const running = runningSince !== null;
  const expandClass = props.expanded ? (props.expandMode === "resize" ? " resizable-panel" : " expanded-panel") : "";

  return (
    <section className={`card results-card${expandClass}`} aria-label="Query results">
      <div className="results-head">
        <div role="tablist" aria-label="Result views" className="result-tabs">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={activeTab === t.id}
              className={activeTab === t.id ? "result-tab is-active" : "result-tab"}
              onClick={() => onTabChange(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="spacer" />
        {result && !running ? (
          <>
            <span className="muted small">
              {result.row_count.toLocaleString()} rows{result.truncated ? ` (first ${result.row_limit.toLocaleString()} — limit in Settings)` : ""}
              {" · "}{formatDuration(result.elapsed_ms)} · {result.schema.length} columns
            </span>
            <button type="button" className="btn btn-link btn-xs" onClick={props.onCopyAllColumns}>Copy column names</button>
          </>
        ) : null}
        <button type="button" className="icon-btn icon-btn-ghost" onClick={props.onToggleExpand}
          aria-label={props.expanded ? "Collapse results" : "Expand results"}
          title={props.expanded ? (props.expandMode === "fullscreen" ? "Exit full window (Esc)" : "Collapse") : "Expand results"}>
          <Icon name={props.expanded ? "collapse" : "expand"} size={15} />
        </button>
      </div>

      {error ? <div className="results-error"><InlineError message={error} onDismiss={props.onDismissError} /></div> : null}

      {running ? (
        <div className="loading-state" role="status">
          <Icon name="spinner" size={28} className="spin accent" />
          <span className="loading-title">Running query…</span>
          <span className="muted small">{(elapsed / 1000).toFixed(1)} s elapsed</span>
        </div>
      ) : null}

      {!running && activeTab === "results" ? (
        result ? (
          <SqlResultsTable result={result} onCopyColumn={props.onCopyColumn} />
        ) : error ? null : (
          <div className="empty-state">
            <p>Run a query to see results here.</p>
            <p className="muted small">Press <kbd className="kbd">Ctrl+Enter</kbd> in the editor.</p>
          </div>
        )
      ) : null}

      {showChartTab ? (
        <div className={!running && activeTab === "chart" ? "chart-pane" : "chart-pane hidden"}>
          {result ? (
            <div className="chart-controls">
              <div className="field">
                <label htmlFor="chart-type" className="field-label">Chart</label>
                <select id="chart-type" className="input" value={chart.plugin} onChange={(e) => chart.setPlugin(e.currentTarget.value as WorkspaceChartPlugin)}>
                  {CHART_TYPES.map((c) => <option key={c.plugin} value={c.plugin}>{c.label}</option>)}
                </select>
              </div>
              {chart.plugin !== "Datagrid" ? (
                <>
                  <div className="field">
                    <label htmlFor="chart-x" className="field-label">Group by</label>
                    <select id="chart-x" className="input" value={chart.x} onChange={(e) => chart.setX(e.currentTarget.value)}>
                      {chart.columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="chart-y" className="field-label">Value</label>
                    <select id="chart-y" className="input" value={chart.y} onChange={(e) => chart.setY(e.currentTarget.value)}>
                      {chart.columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="chart-agg" className="field-label">Summarize</label>
                    <select id="chart-agg" className="input" value={chart.agg} onChange={(e) => chart.setAgg(e.currentTarget.value)}>
                      {CHART_AGGREGATES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                    </select>
                  </div>
                </>
              ) : null}
              <span className="muted small chart-hint">
                {chart.status === "loading"
                  ? "Drawing chart…"
                  : chart.numericColumns.length === 0 && chart.plugin !== "Datagrid"
                    ? "No numeric columns — try Count, or the Table chart."
                    : "Updates as you change options"}
              </span>
            </div>
          ) : (
            <div className="empty-state"><p>Run a query, then chart its results here.</p></div>
          )}
          {props.chartHost}
        </div>
      ) : null}

      {!running && activeTab === "plan" ? (
        explainRunning ? (
          <div className="loading-state" role="status">
            <Icon name="spinner" size={28} className="spin accent" />
            <span className="loading-title">Running EXPLAIN ANALYZE…</span>
          </div>
        ) : explainPlan ? (
          <pre className="plan-text">{explainPlan}</pre>
        ) : (
          <div className="empty-state">
            <p>See how DuckDB runs your query.</p>
            <p className="muted small">Click <strong>Explain</strong> or press <kbd className="kbd">Ctrl+Shift+Enter</kbd>.</p>
          </div>
        )
      ) : null}
    </section>
  );
}
