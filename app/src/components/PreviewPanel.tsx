import type { ReactNode } from "react";
import type { PreviewResponse, RecentFile, ViewMode } from "../types";
import { fileNameFromPath, formatBytes, formatRelativeTime } from "../utils";
import { Icon } from "./Icon";
import { InlineError } from "./AppChrome";

export interface PreviewPanelProps {
  preview: PreviewResponse | null;
  recentFiles: RecentFile[];
  loading: boolean;
  blocked: boolean;
  error: string | null;
  onDismissError: () => void;
  onOpen: () => void;
  onOpenRecent: (path: string) => void;
  onClearRecent: () => void;
  onCloseFile: () => void;
  onCopyAllColumns: () => void;
  /** Adds the open file as a workspace table and switches to the SQL tab. */
  onQueryWithSql: () => void;
  viewMode: ViewMode;
  onShowRows: () => void;
  onShowPivot: () => void;
  pivotStatus: "idle" | "loading" | "ready" | "error";
  pivotRowCap: number;
  expanded: boolean;
  expandMode: "fullscreen" | "resize";
  onToggleExpand: () => void;
  grid: ReactNode;
  pivotHost: ReactNode;
  devTools?: ReactNode;
}

export function PreviewPanel(p: PreviewPanelProps) {
  const { preview } = p;

  if (!preview) {
    return (
      <div className="preview-empty">
        <div className="preview-empty-inner">
          {p.error ? <InlineError message={p.error} onDismiss={p.onDismissError} /> : null}
          <div className="drop-card">
            <Icon name="upload" size={32} className="accent" />
            <h1 className="drop-title">Open a Parquet file</h1>
            <p className="muted">Drop a .parquet file here, or browse for one. Nothing leaves your machine.</p>
            <button type="button" className="btn btn-primary" onClick={p.onOpen} disabled={p.loading || p.blocked}>
              {p.loading ? "Opening…" : "Open file…"} <kbd className="kbd kbd-on-primary">Ctrl+O</kbd>
            </button>
          </div>
          {p.devTools}
          {p.recentFiles.length > 0 ? (
            <section aria-label="Recent files" className="recent">
              <div className="recent-head">
                <h2 className="section-label">Recent</h2>
                <button type="button" className="btn btn-link btn-xs" onClick={p.onClearRecent}>Clear</button>
              </div>
              {p.recentFiles.map((f) => {
                const meta = [
                  f.sizeBytes !== null ? formatBytes(f.sizeBytes) : null,
                  f.openedAt !== null ? formatRelativeTime(f.openedAt) : null,
                ].filter(Boolean).join(" · ");
                return (
                  <button key={f.path} type="button" className="recent-item" title={f.path}
                    disabled={p.loading || p.blocked} onClick={() => p.onOpenRecent(f.path)}>
                    <span className="recent-name">{fileNameFromPath(f.path)}</span>
                    <span className="muted small">{meta}</span>
                  </button>
                );
              })}
            </section>
          ) : null}
        </div>
      </div>
    );
  }

  const pivotActive = p.viewMode === "perspective";
  const capped = preview.total_rows > p.pivotRowCap;
  const expandClass = p.expanded ? (p.expandMode === "resize" ? " resizable-panel" : " expanded-panel") : "";

  return (
    <div className="preview-layout">
      <section aria-label="Open file" className="card file-header">
        <div className="file-info">
          <div className="file-title-row">
            <h1 className="file-title">{fileNameFromPath(preview.file_path)}</h1>
            <span className="muted small">
              {preview.total_rows.toLocaleString()} rows · {preview.schema.length} columns · {formatBytes(preview.file_size_bytes)}
            </span>
          </div>
          <span className="file-path" title={preview.file_path}>{preview.file_path}</span>
        </div>
        <div className="file-actions">
          <div role="group" aria-label="View" className="segmented">
            <button type="button" aria-pressed={!pivotActive} className={!pivotActive ? "segmented-item is-active" : "segmented-item"} onClick={p.onShowRows}>
              Rows
            </button>
            <button type="button" aria-pressed={pivotActive}
              className={pivotActive ? "segmented-item is-active" : "segmented-item"}
              disabled={p.pivotStatus === "loading" || p.pivotStatus === "idle"}
              title={p.pivotStatus === "loading" || p.pivotStatus === "idle" ? "Preparing pivot view…" : `Pivot and chart the first ${p.pivotRowCap.toLocaleString()} rows`}
              onClick={p.onShowPivot}>
              {p.pivotStatus === "loading" || p.pivotStatus === "idle" ? "Pivot & chart…" : "Pivot & chart"}
            </button>
          </div>
          <button type="button" className="btn btn-outline" onClick={p.onQueryWithSql} disabled={p.loading || p.blocked}
            title="Add this file as a table and open it in the SQL tab">
            Query with SQL
          </button>
          <button type="button" className="btn" onClick={p.onCopyAllColumns}>Copy column names</button>
          <button type="button" className="btn" title="Open another file (Ctrl+O)" onClick={p.onOpen} disabled={p.loading || p.blocked}>Open…</button>
          <button type="button" className="icon-btn" aria-label="Close file" title="Close file" onClick={p.onCloseFile}>
            <Icon name="close" size={15} />
          </button>
        </div>
        {p.devTools}
      </section>

      {p.error ? <InlineError message={p.error} onDismiss={p.onDismissError} /> : null}

      {pivotActive && capped ? (
        <p className="notice">
          Pivot &amp; chart shows the first {p.pivotRowCap.toLocaleString()} of {preview.total_rows.toLocaleString()} rows.{" "}
          <button type="button" className="btn btn-link btn-xs" onClick={p.onShowRows}>Back to all rows</button>
        </p>
      ) : null}

      <section aria-label={pivotActive ? "Pivot and chart" : "Rows"} className={`card grid-card${expandClass}`}>
        <button type="button" className="icon-btn icon-btn-ghost grid-expand" onClick={p.onToggleExpand}
          aria-label={p.expanded ? "Collapse" : "Expand"}
          title={p.expanded ? (p.expandMode === "fullscreen" ? "Exit full window (Esc)" : "Collapse") : "Expand"}>
          <Icon name={p.expanded ? "collapse" : "expand"} size={15} />
        </button>
        {!pivotActive ? p.grid : null}
        <div className={pivotActive ? "pivot-host" : "pivot-host hidden"}>{p.pivotHost}</div>
      </section>
    </div>
  );
}
