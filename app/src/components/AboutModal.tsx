import React from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { PRODUCT_STAGE_LABEL } from "../constants";

export interface AboutModalProps {
  open: boolean;
  onClose: () => void;
  duckdbVersion: string | null;
}

export const AboutModal = React.memo(function AboutModal({
  open,
  onClose,
  duckdbVersion,
}: AboutModalProps) {
  if (!open) return null;

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label="About Parq-Bench"
        onClick={(event) => event.stopPropagation()}
      >
        <h3>Parq-Bench</h3>
        <span className="beta-badge" style={{ marginBottom: 12, alignSelf: "flex-start" }}>{PRODUCT_STAGE_LABEL} v0.3.0</span>
        <p style={{ margin: "8px 0", lineHeight: 1.5 }}>
          A high-performance desktop application for exploring and querying Parquet and CSV files locally.
          No cloud, no accounts, no telemetry — all processing happens on your machine.
        </p>
        <p style={{ margin: "8px 0", lineHeight: 1.5, color: "var(--text-soft)" }}>
          Built by{" "}
          <a
            href="#"
            onClick={(e) => { e.preventDefault(); void openUrl("https://www.keepitsimpleanalytics.com/"); }}
            style={{ color: "var(--accent)" }}
          >
            KISA — Keep it Simple Analytics
          </a>
        </p>
        <div style={{ margin: "8px 0", fontSize: "0.82rem", color: "var(--text-soft)" }}>
          <strong style={{ fontSize: "0.84rem" }}>Tech Stack</strong>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 12px", marginTop: 4 }}>
            <span>Tauri</span><span>v2</span>
            <span>DuckDB</span><span>{duckdbVersion ?? "—"}</span>
            <span>React</span><span>19</span>
            <span>Perspective</span><span>Streaming analytics</span>
            <span>Monaco</span><span>SQL editor</span>
          </div>
        </div>
        <div style={{ margin: "8px 0", fontSize: "0.82rem", color: "var(--text-soft)" }}>
          <strong style={{ fontSize: "0.84rem" }}>Keyboard Shortcuts</strong>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 12px", marginTop: 4 }}>
            <kbd className="shortcut-hint" style={{ fontSize: "0.78rem" }}>Ctrl+O</kbd><span>Open Parquet file</span>
            <kbd className="shortcut-hint" style={{ fontSize: "0.78rem" }}>Ctrl+1</kbd><span>Preview tab</span>
            <kbd className="shortcut-hint" style={{ fontSize: "0.78rem" }}>Ctrl+2</kbd><span>SQL Workspace tab</span>
            <kbd className="shortcut-hint" style={{ fontSize: "0.78rem" }}>Ctrl+Enter</kbd><span>Run SQL query</span>
            <kbd className="shortcut-hint" style={{ fontSize: "0.78rem" }}>Ctrl+Shift+Enter</kbd><span>Explain Analyze</span>
            <kbd className="shortcut-hint" style={{ fontSize: "0.78rem" }}>Ctrl+Shift+E</kbd><span>Export query as CSV</span>
            <kbd className="shortcut-hint" style={{ fontSize: "0.78rem" }}>Ctrl+,</kbd><span>Settings</span>
            <kbd className="shortcut-hint" style={{ fontSize: "0.78rem" }}>Esc</kbd><span>Close modal / exit fullscreen</span>
          </div>
        </div>
        <p style={{ margin: "8px 0", fontSize: "0.84rem", color: "var(--text-soft)" }}>
          Licensed under{" "}
          <a href="#" onClick={(e) => { e.preventDefault(); void openUrl("https://github.com/KeepitSimpleAnalytics/parq_bench/blob/main/LICENSE"); }} style={{ color: "var(--accent)" }}>GPLv3</a>.
          {" "}We believe great tools should be open and accessible to everyone.
        </p>
        <p style={{ margin: "4px 0", fontSize: "0.82rem" }}>
          <a href="#" onClick={(e) => { e.preventDefault(); void openUrl("https://github.com/KeepitSimpleAnalytics/parq_bench"); }} style={{ color: "var(--accent)" }}>
            GitHub Repository
          </a>
          {" — "}
          <a href="#" onClick={(e) => { e.preventDefault(); void openUrl("https://github.com/KeepitSimpleAnalytics/parq_bench/issues"); }} style={{ color: "var(--accent)" }}>
            Report an Issue
          </a>
        </p>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </section>
    </div>
  );
});
