import { describe, expect, it } from "vitest";
import type { SavedQuery } from "../types";
import {
  SAVED_QUERY_NAME_MAX, findSavedQuery, isUnsaved, parseEditorSession, sameSql, saveOutcome, savedQueryNameProblem,
} from "./savedQueries";

const q = (name: string, sql: string, updated_at_ms = 1): SavedQuery => ({ name, sql, updated_at_ms });
const saved = [q("Monthly revenue", "SELECT sum(x) FROM t"), q("Counts", "SELECT count(*) FROM t")];

describe("findSavedQuery", () => {
  it("matches ignoring case and spaces", () => {
    expect(findSavedQuery(saved, "  monthly REVENUE ")?.name).toBe("Monthly revenue");
    expect(findSavedQuery(saved, "nope")).toBeNull();
    expect(findSavedQuery(saved, null)).toBeNull();
  });
});

describe("savedQueryNameProblem", () => {
  it("requires a name within the length limit", () => {
    expect(savedQueryNameProblem("   ")).toMatch(/name/);
    expect(savedQueryNameProblem("x".repeat(SAVED_QUERY_NAME_MAX + 1))).toMatch(/at most/);
    expect(savedQueryNameProblem("x".repeat(SAVED_QUERY_NAME_MAX))).toBeNull();
    expect(savedQueryNameProblem("Revenue")).toBeNull();
  });
});

describe("saveOutcome", () => {
  it("tells new, update of the open query, and replace of another apart", () => {
    expect(saveOutcome(saved, "Brand new", null)).toBe("new");
    expect(saveOutcome(saved, "monthly revenue", "Monthly revenue")).toBe("update");
    expect(saveOutcome(saved, "Counts", "Monthly revenue")).toBe("replace");
    expect(saveOutcome(saved, "Counts", null)).toBe("replace");
    // The open query was deleted meanwhile: an existing name is still a replace.
    expect(saveOutcome(saved, "Counts", "Gone")).toBe("replace");
  });
});

describe("isUnsaved", () => {
  const starter = "SELECT * FROM my_table LIMIT 100";
  it("is false for empty text, the starter query and saved queries", () => {
    expect(isUnsaved("", saved, starter)).toBe(false);
    expect(isUnsaved("  \n", saved, starter)).toBe(false);
    expect(isUnsaved(starter, saved, starter)).toBe(false);
    expect(isUnsaved("SELECT count(*) FROM t\n", saved, starter)).toBe(false);
  });
  it("is true for edited or new text, even if it ran (History doesn't count)", () => {
    expect(isUnsaved("SELECT count(*) FROM t WHERE x > 1", saved, starter)).toBe(true);
    expect(isUnsaved("SELECT 42", saved, starter)).toBe(true);
  });
});

describe("sameSql", () => {
  it("ignores only surrounding whitespace", () => {
    expect(sameSql("SELECT 1\n", "  SELECT 1")).toBe(true);
    expect(sameSql("SELECT 1", "SELECT  1")).toBe(false);
  });
});

describe("parseEditorSession", () => {
  it("reads a stored session and rejects anything else", () => {
    expect(parseEditorSession(JSON.stringify({ sql: "SELECT 1", openName: "A" }))).toEqual({ sql: "SELECT 1", openName: "A" });
    expect(parseEditorSession(JSON.stringify({ sql: "SELECT 1" }))).toEqual({ sql: "SELECT 1", openName: null });
    expect(parseEditorSession(null)).toBeNull();
    expect(parseEditorSession("{bad")).toBeNull();
    expect(parseEditorSession(JSON.stringify({ sql: 5 }))).toBeNull();
    expect(parseEditorSession("null")).toBeNull();
  });
});
