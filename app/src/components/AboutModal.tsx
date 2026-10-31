import React from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { APP_VERSION, PRODUCT_STAGE_LABEL } from "../constants";
import { Modal } from "./Modal";

async function safeOpenUrl(url: string) {
  try {
    await openUrl(url);
  } catch (err) {
    console.error("Failed to open URL:", url, err);
  }
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} className="link" onClick={(e) => { e.preventDefault(); void safeOpenUrl(href); }}>
      {children}
    </a>
  );
}

const SHORTCUTS: Array<[string, string]> = [
  ["Ctrl+O", "Open Parquet file"],
  ["Ctrl+1", "Preview tab"],
  ["Ctrl+2", "SQL tab"],
  ["Ctrl+Enter", "Run SQL query"],
  ["Ctrl+Shift+Enter", "Explain query plan"],
  ["Ctrl+Shift+E", "Export results as CSV"],
  ["Ctrl+,", "Settings"],
  ["Esc", "Close dialog / exit full window / dismiss error"],
];

export interface AboutModalProps {
  open: boolean;
  onClose: () => void;
  duckdbVersion: string | null;
}

export const AboutModal = React.memo(function AboutModal({ open, onClose, duckdbVersion }: AboutModalProps) {
  return (
    <Modal
      open={open}
      title="About Parq-Bench"
      onClose={onClose}
      width={560}
      footer={<button type="button" className="btn btn-primary" onClick={onClose}>Close</button>}
    >
      <span className="badge">{PRODUCT_STAGE_LABEL} v{APP_VERSION}</span>
      <p className="about-text">
        A desktop app for exploring and querying Parquet and delimited text files locally.
        No cloud, no accounts, no telemetry — all processing happens on your machine.
      </p>
      <p className="about-text muted">
        Built by <ExternalLink href="https://www.keepitsimpleanalytics.com/">KISA — Keep it Simple Analytics</ExternalLink>
      </p>

      <h3 className="section-label">Tech stack</h3>
      <dl className="kv-grid">
        <dt>Tauri</dt><dd>v2</dd>
        <dt>DuckDB</dt><dd>{duckdbVersion ?? "—"}</dd>
        <dt>React</dt><dd>19</dd>
        <dt>Perspective</dt><dd>Pivot and chart engine</dd>
        <dt>Monaco</dt><dd>SQL editor</dd>
      </dl>

      <h3 className="section-label">Keyboard shortcuts</h3>
      <dl className="kv-grid">
        {SHORTCUTS.map(([keys, action]) => (
          <React.Fragment key={keys}>
            <dt><kbd className="kbd">{keys}</kbd></dt><dd>{action}</dd>
          </React.Fragment>
        ))}
      </dl>

      <p className="about-text muted">
        Licensed under <ExternalLink href="https://github.com/KeepitSimpleAnalytics/parq_bench/blob/main/LICENSE">GPLv3</ExternalLink>.
        {" "}We believe great tools should be open and accessible to everyone.
      </p>
      <p className="about-text">
        <ExternalLink href="https://github.com/KeepitSimpleAnalytics/parq_bench">GitHub repository</ExternalLink>
        {" · "}
        <ExternalLink href="https://github.com/KeepitSimpleAnalytics/parq_bench/issues">Report an issue</ExternalLink>
      </p>
    </Modal>
  );
});
