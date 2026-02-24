import React from "react";
import type { AppSettings } from "../types";
import { DEFAULT_SETTINGS } from "../constants";

export interface SettingsModalProps {
  open: boolean;
  settings: AppSettings;
  onSettingsChange: React.Dispatch<React.SetStateAction<AppSettings>>;
  onClose: () => void;
  onEditorFontSizeChange: (size: number) => void;
  editorRef: React.RefObject<{ updateOptions: (opts: { fontSize: number }) => void } | null>;
}

export const SettingsModal = React.memo(function SettingsModal({
  open,
  settings,
  onSettingsChange,
  onClose,
  onEditorFontSizeChange,
  editorRef,
}: SettingsModalProps) {
  if (!open) return null;

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(event) => event.stopPropagation()}
      >
        <h3>Settings</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, margin: "12px 0" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.85rem" }}>
            SQL Row Limit
            <input type="number" min={1} max={100000} value={settings.sqlRowLimit}
              onChange={(e) => onSettingsChange((s) => ({ ...s, sqlRowLimit: Math.max(1, parseInt(e.target.value) || 200) }))}
              style={{ width: 120 }}
            />
            <span className="phase">Maximum rows returned by workspace queries (default: 200)</span>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.85rem" }}>
            Perspective Max Rows
            <input type="number" min={100} max={100000} value={settings.perspectiveMaxRows}
              onChange={(e) => onSettingsChange((s) => ({ ...s, perspectiveMaxRows: Math.max(100, parseInt(e.target.value) || 5000) }))}
              style={{ width: 120 }}
            />
            <span className="phase">Maximum rows loaded into Perspective viewer (default: 5000). Higher values increase memory usage.</span>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.85rem" }}>
            Editor Font Size
            <input type="number" min={8} max={32} value={settings.editorFontSize}
              onChange={(e) => {
                const v = Math.min(32, Math.max(8, parseInt(e.target.value) || 13));
                onSettingsChange((s) => ({ ...s, editorFontSize: v }));
                onEditorFontSizeChange(v);
                editorRef.current?.updateOptions({ fontSize: v });
              }}
              style={{ width: 120 }}
            />
            <span className="phase">Monaco editor font size in pixels (default: 13)</span>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.85rem" }}>
            Expand Mode
            <select value={settings.expandMode}
              onChange={(e) => onSettingsChange((s) => ({ ...s, expandMode: e.target.value as "fullscreen" | "resize" }))}
              style={{ width: 160 }}
            >
              <option value="fullscreen">Fullscreen</option>
              <option value="resize">Resize</option>
            </select>
            <span className="phase">Fullscreen: fixed overlay (default). Resize: drag-to-resize panels.</span>
          </label>
          <label style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 8, fontSize: "0.85rem", cursor: "pointer" }}>
            <input type="checkbox" checked={settings.showPerspectiveConfigure}
              onChange={(e) => onSettingsChange((s) => ({ ...s, showPerspectiveConfigure: e.target.checked }))}
            />
            Show Perspective Configure Button
            <span className="phase" style={{ marginLeft: "auto" }}>Toggle visibility of Perspective's built-in settings button</span>
          </label>
          <label style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 8, fontSize: "0.85rem", cursor: "pointer" }}>
            <input type="checkbox" checked={settings.showVisualization}
              onChange={(e) => onSettingsChange((s) => ({ ...s, showVisualization: e.target.checked }))}
            />
            Show Visualization
            <span className="phase" style={{ marginLeft: "auto" }}>Show Visualize Data button and chart controls in workspace</span>
          </label>
          <div style={{ fontSize: "0.84rem", color: "var(--text-soft)", padding: "6px 0", borderTop: "1px solid var(--border)" }}>
            Memory guard threshold: 85% (read-only, configured in backend)
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={() => {
            onSettingsChange({ ...DEFAULT_SETTINGS });
            onEditorFontSizeChange(DEFAULT_SETTINGS.editorFontSize);
            editorRef.current?.updateOptions({ fontSize: DEFAULT_SETTINGS.editorFontSize });
          }}>
            Reset to Defaults
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </section>
    </div>
  );
});
