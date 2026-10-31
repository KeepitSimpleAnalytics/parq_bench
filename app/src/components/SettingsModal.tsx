import React from "react";
import type { AppSettings, ThemeMode } from "../types";
import { DEFAULT_SETTINGS } from "../constants";
import { Modal } from "./Modal";

export interface SettingsModalProps {
  open: boolean;
  settings: AppSettings;
  onSettingsChange: React.Dispatch<React.SetStateAction<AppSettings>>;
  onClose: () => void;
  onEditorFontSizeChange: (size: number) => void;
  editorRef: React.RefObject<{ updateOptions: (opts: { fontSize: number }) => void } | null>;
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
}

const THEMES: Array<{ value: ThemeMode; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function SettingRow({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        {htmlFor ? <label htmlFor={htmlFor} className="setting-label">{label}</label> : <span className="setting-label">{label}</span>}
        {hint ? <span className="setting-hint">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

export const SettingsModal = React.memo(function SettingsModal({
  open,
  settings,
  onSettingsChange,
  onClose,
  onEditorFontSizeChange,
  editorRef,
  themeMode,
  onThemeModeChange,
}: SettingsModalProps) {
  function applyFontSize(size: number) {
    onSettingsChange((s) => ({ ...s, editorFontSize: size }));
    onEditorFontSizeChange(size);
    editorRef.current?.updateOptions({ fontSize: size });
  }

  return (
    <Modal
      open={open}
      title="Settings"
      onClose={onClose}
      width={600}
      footer={
        <>
          <button type="button" className="btn btn-link" onClick={() => {
            onSettingsChange({ ...DEFAULT_SETTINGS });
            applyFontSize(DEFAULT_SETTINGS.editorFontSize);
            onThemeModeChange("system");
          }}>
            Reset to defaults
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
        </>
      }
    >
      <h3 className="section-label">Appearance</h3>
      <SettingRow label="Theme">
        <div role="group" aria-label="Theme" className="segmented">
          {THEMES.map((t) => (
            <button key={t.value} type="button" aria-pressed={themeMode === t.value}
              className={themeMode === t.value ? "segmented-item is-active" : "segmented-item"}
              onClick={() => onThemeModeChange(t.value)}>
              {t.label}
            </button>
          ))}
        </div>
      </SettingRow>
      <SettingRow label="Editor font size" htmlFor="set-font">
        <input id="set-font" type="number" min={8} max={32} className="input input-num" value={settings.editorFontSize}
          onChange={(e) => applyFontSize(Math.min(32, Math.max(8, parseInt(e.target.value) || DEFAULT_SETTINGS.editorFontSize)))} />
      </SettingRow>
      <SettingRow label="Expand panels" hint="How the expand button enlarges a table or chart" htmlFor="set-expand">
        <select id="set-expand" className="input" value={settings.expandMode}
          onChange={(e) => onSettingsChange((s) => ({ ...s, expandMode: e.target.value as AppSettings["expandMode"] }))}>
          <option value="fullscreen">Full window</option>
          <option value="resize">Drag to resize</option>
        </select>
      </SettingRow>

      <h3 className="section-label">Queries</h3>
      <SettingRow label="Result row limit" hint="Rows shown per SQL query. Exports always include every row." htmlFor="set-rows">
        <input id="set-rows" type="number" min={1} max={100000} className="input input-num" value={settings.sqlRowLimit}
          onChange={(e) => onSettingsChange((s) => ({ ...s, sqlRowLimit: Math.max(1, parseInt(e.target.value) || DEFAULT_SETTINGS.sqlRowLimit) }))} />
      </SettingRow>
      <SettingRow label="Chart row limit" hint="Rows loaded into pivot and chart views. Higher values use more memory." htmlFor="set-chart-rows">
        <input id="set-chart-rows" type="number" min={100} max={100000} className="input input-num" value={settings.perspectiveMaxRows}
          onChange={(e) => onSettingsChange((s) => ({ ...s, perspectiveMaxRows: Math.max(100, parseInt(e.target.value) || DEFAULT_SETTINGS.perspectiveMaxRows) }))} />
      </SettingRow>
      <SettingRow label="Exact table stats" hint="Scans the whole table. Off: instant stats from Parquet metadata." htmlFor="set-deep">
        <input id="set-deep" type="checkbox" className="checkbox" checked={settings.deepStats}
          onChange={(e) => onSettingsChange((s) => ({ ...s, deepStats: e.target.checked }))} />
      </SettingRow>

      <details className="settings-advanced">
        <summary className="section-label">Advanced</summary>
        <SettingRow label="Show charting" hint="The Chart tab in SQL results" htmlFor="set-viz">
          <input id="set-viz" type="checkbox" className="checkbox" checked={settings.showVisualization}
            onChange={(e) => onSettingsChange((s) => ({ ...s, showVisualization: e.target.checked }))} />
        </SettingRow>
        <SettingRow label="Show chart configure panel" hint="The pivot/chart engine's own settings button" htmlFor="set-configure">
          <input id="set-configure" type="checkbox" className="checkbox" checked={settings.showPerspectiveConfigure}
            onChange={(e) => onSettingsChange((s) => ({ ...s, showPerspectiveConfigure: e.target.checked }))} />
        </SettingRow>
      </details>
    </Modal>
  );
});
