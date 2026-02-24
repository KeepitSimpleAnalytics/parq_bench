import type {
  ThemeMode,
  ResolvedTheme,
  ActiveTab,
  QueryHistoryEntry,
  AppSettings,
  WorkspaceSourceKind,
} from "./types";
import {
  DEFAULT_SETTINGS,
  DELIMITED_EXTENSIONS,
  UI_THEME_STORAGE_KEY,
  UI_WORKSPACE_SLOW_MODE_STORAGE_KEY,
  UI_ACTIVE_TAB_STORAGE_KEY,
  UI_RECENT_FILES_STORAGE_KEY,
  UI_QUERY_HISTORY_STORAGE_KEY,
  UI_SETTINGS_STORAGE_KEY,
  RECENT_FILES_MAX,
  QUERY_HISTORY_MAX,
  PERSPECTIVE_RESTORE_TIMEOUT_DEFAULT_MS,
  PERSPECTIVE_RESTORE_TIMEOUT_CHART_MS,
} from "./constants";

export function detectSourceKind(filePath: string): WorkspaceSourceKind {
  const lower = filePath.toLowerCase().replace(/[/\\]+$/, "");
  if (lower.includes("*")) {
    for (const ext of DELIMITED_EXTENSIONS) {
      if (lower.endsWith(`*.${ext}`)) return "delimited";
    }
    return "parquet";
  }
  const dot = lower.lastIndexOf(".");
  if (dot !== -1) {
    const ext = lower.slice(dot + 1);
    if (DELIMITED_EXTENSIONS.includes(ext)) return "delimited";
  }
  return "parquet";
}

export function readActiveTab(): ActiveTab {
  if (typeof window === "undefined") {
    return "preview";
  }
  const value = window.localStorage.getItem(UI_ACTIVE_TAB_STORAGE_KEY);
  if (value === "preview" || value === "sql") {
    return value;
  }
  return "preview";
}

export function readThemeMode(): ThemeMode {
  if (typeof window === "undefined") {
    return "system";
  }
  const value = window.localStorage.getItem(UI_THEME_STORAGE_KEY);
  if (value === "light" || value === "dark" || value === "system") {
    return value;
  }
  return "system";
}

export function readWorkspaceSlowModeEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.localStorage.getItem(UI_WORKSPACE_SLOW_MODE_STORAGE_KEY) === "1";
}

export function readRecentFiles(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(UI_RECENT_FILES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x: unknown) => typeof x === "string").slice(0, RECENT_FILES_MAX) : [];
  } catch { return []; }
}

export function readQueryHistory(): QueryHistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(UI_QUERY_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, QUERY_HISTORY_MAX) : [];
  } catch { return []; }
}

export function readSettings(): AppSettings {
  if (typeof window === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(UI_SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return {
      sqlRowLimit: typeof parsed.sqlRowLimit === "number" ? parsed.sqlRowLimit : DEFAULT_SETTINGS.sqlRowLimit,
      perspectiveMaxRows: typeof parsed.perspectiveMaxRows === "number" ? parsed.perspectiveMaxRows : DEFAULT_SETTINGS.perspectiveMaxRows,
      editorFontSize: typeof parsed.editorFontSize === "number" ? parsed.editorFontSize : DEFAULT_SETTINGS.editorFontSize,
      expandMode: parsed.expandMode === "fullscreen" || parsed.expandMode === "resize" ? parsed.expandMode : DEFAULT_SETTINGS.expandMode,
      showPerspectiveConfigure: typeof parsed.showPerspectiveConfigure === "boolean" ? parsed.showPerspectiveConfigure : DEFAULT_SETTINGS.showPerspectiveConfigure,
      showVisualization: typeof parsed.showVisualization === "boolean" ? parsed.showVisualization : DEFAULT_SETTINGS.showVisualization,
    };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

export function resolveThemeMode(mode: ThemeMode): ResolvedTheme {
  if (mode === "light" || mode === "dark") {
    return mode;
  }
  if (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

export function formatWorkspaceDelimiter(value: string | null): string {
  if (value === null) {
    return "auto";
  }
  if (value === "\t") {
    return "\\t";
  }
  if (value === "\n") {
    return "\\n";
  }
  if (value === "\r") {
    return "\\r";
  }
  return value;
}

export function appendGlobPattern(folderPath: string, pattern: string): string {
  const trimmed = folderPath.trim();
  if (trimmed.length === 0) {
    return pattern;
  }
  if (trimmed.endsWith("\\") || trimmed.endsWith("/")) {
    return `${trimmed}${pattern}`;
  }
  const separator = trimmed.includes("\\") ? "\\" : "/";
  return `${trimmed}${separator}${pattern}`;
}

export function sqlIdentifierInsertText(identifier: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    return identifier;
  }
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

export function isNumericDuckType(duckType: string): boolean {
  const upper = duckType.toUpperCase();
  return (
    upper.includes("INT") ||
    upper.includes("DECIMAL") ||
    upper.includes("DOUBLE") ||
    upper.includes("FLOAT") ||
    upper.includes("REAL") ||
    upper.includes("HUGEINT")
  );
}

export function coerceWorkspaceCell(value: string | null, duckType: string): string | number | null {
  if (value === null) {
    return null;
  }
  if (isNumericDuckType(duckType)) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return value;
}

export function perspectiveRestoreTimeoutMs(restoreConfig: Record<string, unknown>): number {
  const plugin = String(restoreConfig.plugin ?? "");
  if (
    plugin === "Treemap" ||
    plugin === "Y Bar" ||
    plugin === "X Bar" ||
    plugin === "Y Line" ||
    plugin === "Line"
  ) {
    return PERSPECTIVE_RESTORE_TIMEOUT_CHART_MS;
  }
  return PERSPECTIVE_RESTORE_TIMEOUT_DEFAULT_MS;
}

export function escapeCsvCell(value: string): string {
  if (value.includes(",") || value.includes("\"") || value.includes("\n")) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return value;
}

export async function withTimeout<T>(label: string, promise: Promise<T>, ms = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function waitForNextPaint() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

export async function sleepMs(ms: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
