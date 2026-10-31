import type { ActiveTab, RuntimeHealth } from "../types";
import { APP_VERSION, PRODUCT_STAGE_LABEL, MEMORY_GUARD_RATIO } from "../constants";
import { formatBytes } from "../utils";
import { Icon } from "./Icon";

export function TopBar({
  activeTab,
  onTabChange,
  onOpenSettings,
  onOpenAbout,
}: {
  activeTab: ActiveTab;
  onTabChange: (tab: ActiveTab) => void;
  onOpenSettings: () => void;
  onOpenAbout: () => void;
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <Icon name="app" size={20} className="brand-icon" />
        Parq-Bench
      </div>
      <nav aria-label="Main" className="tab-switch">
        <button type="button" title="Preview (Ctrl+1)" aria-current={activeTab === "preview" ? "page" : undefined}
          className={activeTab === "preview" ? "tab-switch-item is-active" : "tab-switch-item"}
          onClick={() => onTabChange("preview")}>
          Preview
        </button>
        <button type="button" title="SQL (Ctrl+2)" aria-current={activeTab === "sql" ? "page" : undefined}
          className={activeTab === "sql" ? "tab-switch-item is-active" : "tab-switch-item"}
          onClick={() => onTabChange("sql")}>
          SQL
        </button>
      </nav>
      <div className="spacer" />
      <span className="badge">{PRODUCT_STAGE_LABEL} v{APP_VERSION}</span>
      <button type="button" className="icon-btn" aria-label="Settings" title="Settings (Ctrl+,)" onClick={onOpenSettings}>
        <Icon name="settings" size={18} />
      </button>
      <button type="button" className="icon-btn" aria-label="About" title="About" onClick={onOpenAbout}>
        <Icon name="info" size={18} />
      </button>
    </header>
  );
}

function memoryPercent(health: RuntimeHealth | null): number | null {
  if (!health || health.total_memory_bytes <= 0) return null;
  return Math.round(health.usage_ratio * 100);
}

export function MemoryGuardBanner({
  health,
  canCloseFile,
  onCloseFile,
}: {
  health: RuntimeHealth | null;
  canCloseFile: boolean;
  onCloseFile: () => void;
}) {
  if (!health?.memory_guard_tripped) return null;
  const pct = memoryPercent(health);
  const limit = Math.round(MEMORY_GUARD_RATIO * 100);
  return (
    <div role="alert" className="guard-banner">
      <Icon name="warning" size={18} className="guard-icon" />
      <span className="guard-text">
        <strong>Parq-Bench is using {pct ?? "?"}% of system memory.</strong>{" "}
        Opening files and running queries is paused until usage drops below {limit}%. Close the open file or
        remove workspace tables to free memory.
      </span>
      {canCloseFile ? (
        <button type="button" className="btn btn-sm btn-warning" onClick={onCloseFile}>Close file</button>
      ) : null}
    </div>
  );
}

export function StatusBar({
  health,
  duckdbVersion,
  right,
}: {
  health: RuntimeHealth | null;
  duckdbVersion: string | null;
  right?: React.ReactNode;
}) {
  const pct = memoryPercent(health);
  const tripped = health?.memory_guard_tripped ?? false;
  const warn = pct !== null && pct >= Math.round(MEMORY_GUARD_RATIO * 100) - 15;
  const dotClass = tripped ? "status-dot is-bad" : warn ? "status-dot is-warn" : "status-dot";
  return (
    <footer className="statusbar">
      <span className="status-item" title={health ? `App memory: ${formatBytes(health.process_rss_bytes)} of ${formatBytes(health.total_memory_bytes)} RAM` : undefined}>
        <span aria-hidden="true" className={dotClass} />
        {pct === null || !health ? "App memory —" : `App memory ${formatBytes(health.process_rss_bytes)} (${pct}% of RAM)${tripped ? " — paused" : ""}`}
      </span>
      {duckdbVersion ? <span className="status-item">DuckDB {duckdbVersion}</span> : null}
      <div className="spacer" />
      {right}
    </footer>
  );
}

export function InlineError({ message, onDismiss }: { message: string | null; onDismiss: () => void }) {
  if (!message) return null;
  return (
    <div role="alert" className="inline-error">
      <Icon name="alert" size={18} className="inline-error-icon" />
      <div className="inline-error-body">
        <strong>Something went wrong</strong>
        <span className="inline-error-message">{message}</span>
      </div>
      <button type="button" className="icon-btn icon-btn-ghost inline-error-close" aria-label="Dismiss error" onClick={onDismiss}>
        <Icon name="close" />
      </button>
    </div>
  );
}
