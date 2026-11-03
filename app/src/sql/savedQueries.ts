/**
 * Saved queries: named copies of the editor text, kept in a file in the app's data
 * folder by the backend. These helpers decide when replacing the editor text needs a
 * warning, and what saving under a name will do.
 */
import type { SavedQuery } from "../types";

export const SAVED_QUERY_NAME_MAX = 100;

/** The saved query with this name, ignoring case and surrounding spaces. */
export function findSavedQuery(saved: SavedQuery[], name: string | null): SavedQuery | null {
  if (name === null) return null;
  const key = name.trim().toLowerCase();
  return saved.find((q) => q.name.toLowerCase() === key) ?? null;
}

/** Why `name` can't be used, or null when it's fine. Mirrors the backend's check. */
export function savedQueryNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Give the query a name.";
  if ([...trimmed].length > SAVED_QUERY_NAME_MAX) return `Names can be at most ${SAVED_QUERY_NAME_MAX} characters.`;
  return null;
}

/**
 * What saving under `name` does: `new`, `update` (the query that's open in the
 * editor), or `replace` (a different saved query with that name, so ask first).
 */
export function saveOutcome(saved: SavedQuery[], name: string, openName: string | null): "new" | "update" | "replace" {
  const existing = findSavedQuery(saved, name);
  if (!existing) return "new";
  const open = findSavedQuery(saved, openName);
  return open && open.name === existing.name ? "update" : "replace";
}

/** Whether two editor texts are the same query (surrounding whitespace doesn't count). */
export function sameSql(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

/**
 * Whether the editor text would be lost by replacing it: false only when it's empty,
 * the starter query, or the same as a saved query. History doesn't count: it's capped
 * and can be cleared in one click.
 */
export function isUnsaved(text: string, saved: SavedQuery[], starter: string): boolean {
  if (text.trim() === "" || sameSql(text, starter)) return false;
  return !saved.some((q) => sameSql(q.sql, text));
}

/** Editor text and the open saved query, restored at startup. */
export interface EditorSession {
  sql: string;
  openName: string | null;
}

/** Parses the stored session; null if missing or not in the expected shape. */
export function parseEditorSession(raw: string | null): EditorSession | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null) return null;
    const { sql, openName } = value as Record<string, unknown>;
    if (typeof sql !== "string") return null;
    return { sql, openName: typeof openName === "string" ? openName : null };
  } catch {
    return null;
  }
}
