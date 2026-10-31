import type {
  ThemeMode,
  ResolvedTheme,
  ActiveTab,
  QueryHistoryEntry,
  AppSettings,
  WorkspaceSourceKind,
  RecentFile,
} from "./types";
import {
  DEFAULT_SETTINGS,
  DELIMITED_EXTENSIONS,
  UI_THEME_STORAGE_KEY,
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

/** Reads recent files; accepts the pre-0.6 format (plain path strings). */
export function readRecentFiles(): RecentFile[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(UI_RECENT_FILES_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const files: RecentFile[] = [];
    for (const item of parsed) {
      if (typeof item === "string") {
        files.push({ path: item, sizeBytes: null, openedAt: null });
      } else if (item && typeof item === "object" && typeof (item as RecentFile).path === "string") {
        const entry = item as RecentFile;
        files.push({
          path: entry.path,
          sizeBytes: typeof entry.sizeBytes === "number" ? entry.sizeBytes : null,
          openedAt: typeof entry.openedAt === "number" ? entry.openedAt : null,
        });
      }
    }
    return files.slice(0, RECENT_FILES_MAX);
  } catch { return []; }
}

export function fileNameFromPath(path: string): string {
  return path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? path;
}

/** 1536 -> "1.5 KB", 4478948229 -> "4.17 GB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** Compact row counts for tight spaces: 25 -> "25", 150000 -> "150K", 180000000 -> "180M". */
export function formatCompactCount(count: number): string {
  if (count < 1000) return String(count);
  const units: Array<[number, string]> = [[1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [size, suffix] of units) {
    if (count >= size) {
      const value = count / size;
      return `${value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "")}${suffix}`;
    }
  }
  return String(count);
}

/** 412 -> "412 ms", 17403 -> "17.4 s". */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}

export function formatRelativeTime(epochMs: number, now = Date.now()): string {
  const diffMin = Math.round((now - epochMs) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHours = Math.round(diffMin / 60);
  if (diffHours < 24) return `${diffHours} h ago`;
  const diffDays = Math.round(diffHours / 24);
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return new Date(epochMs).toLocaleDateString();
}

/** Builds a valid, unused table alias from a file path (e.g. "Sales 2024.csv" -> "sales_2024"). */
export function suggestAlias(filePath: string, taken: Iterable<string>): string {
  const takenLower = new Set(Array.from(taken, (a) => a.toLowerCase()));
  const base = fileNameFromPath(filePath).replace(/\*/g, "").replace(/\.[^.]+$/, "");
  let sanitized = base.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").toLowerCase();
  if (!sanitized) sanitized = "table";
  if (!/^[a-z_]/.test(sanitized)) sanitized = `_${sanitized}`;
  let alias = sanitized;
  let counter = 2;
  while (takenLower.has(alias)) {
    alias = `${sanitized}_${counter}`;
    counter += 1;
  }
  return alias;
}

export function isValidAlias(alias: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(alias);
}

/** Human label for a delimiter character. */
export function describeDelimiter(value: string | null): string {
  switch (value) {
    case null: return "auto-detected";
    case ",": return "comma";
    case "\t": return "tab";
    case "|": return "pipe";
    case ";": return "semicolon";
    default: return `"${value}"`;
  }
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
      deepStats: typeof parsed.deepStats === "boolean" ? parsed.deepStats : DEFAULT_SETTINGS.deepStats,
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

export function friendlyError(raw: string): string {
  let msg = raw;

  // Strip internal wrapper prefix
  msg = msg.replace(/^prepare workspace schema query:\s*/i, "");

  // Strip LINE N: ... ^ caret trace (internal SQL pointer noise)
  msg = msg.replace(/\s*LINE \d+:[\s\S]*\^$/, "").trim();

  // File not found
  if (/read file metadata:.*No such file/i.test(msg)) {
    return "File not found. Check that the path is correct.";
  }

  // Permission denied
  if (/read file metadata:.*Permission denied/i.test(msg)) {
    return "Permission denied. Check file permissions.";
  }

  // Lock poisoned
  if (/Workspace table lock poisoned/i.test(msg)) {
    return "Internal error \u2014 please restart Parq-Bench.";
  }

  // Strip Catalog Error prefix before checking table-not-found
  msg = msg.replace(/^Catalog Error:\s*/i, "");

  // Table not found
  const tableMatch = msg.match(/Table with name (\S+) does not exist/i);
  if (tableMatch) {
    const name = tableMatch[1];
    if (name === "my_table") {
      return "No tables mounted yet. Drop a file onto the SQL panel or use the Register Table form to get started.";
    }
    return `Table "${name}" not found. Check the alias name, or mount a file first.`;
  }

  // Parser / syntax error
  if (/^Parser Error:/i.test(msg)) {
    return `SQL syntax error: ${msg.replace(/^Parser Error:\s*/i, "")}`;
  }

  // Binder Error
  if (/^Binder Error:/i.test(msg)) {
    return `Query error: ${msg.replace(/^Binder Error:\s*/i, "")}`;
  }

  // Conversion / type mismatch
  if (/^Conversion Error:/i.test(msg) || /type mismatch/i.test(msg)) {
    return `Type error: ${msg.replace(/^Conversion Error:\s*/i, "")}`;
  }

  return msg;
}

export async function waitForNextPaint() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

export async function sleepMs(ms: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
