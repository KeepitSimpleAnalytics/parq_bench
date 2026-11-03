import { describe, expect, it } from "vitest";
import { planRun, skipLeadingComments, splitSqlStatements, statementAtOffset, writesOutsideApp } from "./statements";

const texts = (sql: string) => splitSqlStatements(sql).map((s) => s.text);

describe("splitSqlStatements", () => {
  it("splits on semicolons", () => {
    expect(texts("SELECT 1; SELECT 2;")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("ignores semicolons in strings and quoted identifiers", () => {
    expect(texts(`SELECT 'a;b', "c;d"`)).toEqual([`SELECT 'a;b', "c;d"`]);
    expect(texts("SELECT 'it''s; fine'")).toEqual(["SELECT 'it''s; fine'"]);
  });

  it("ignores semicolons in comments", () => {
    expect(texts("SELECT 1 -- no; split\n; SELECT 2")).toEqual(["SELECT 1 -- no; split", "SELECT 2"]);
    expect(texts("SELECT /* a; b */ 1")).toEqual(["SELECT /* a; b */ 1"]);
  });

  it("ignores semicolons in dollar-quoted strings but not after $1 parameters", () => {
    expect(texts("SELECT $$a;b$$, $x$c;d$x$")).toEqual(["SELECT $$a;b$$, $x$c;d$x$"]);
    expect(texts("SELECT $1; SELECT 2")).toEqual(["SELECT $1", "SELECT 2"]);
  });

  it("drops chunks that are only whitespace or comments", () => {
    expect(texts("SELECT 1; -- trailing note")).toEqual(["SELECT 1"]);
    expect(texts("  ;; -- only comments\n/* x */ ")).toEqual([]);
  });

  it("keeps an unterminated string as one statement", () => {
    expect(texts("SELECT 'unterminated; text")).toEqual(["SELECT 'unterminated; text"]);
  });

  it("reports positions of the trimmed text", () => {
    const sql = "  SELECT 1 ;\n\nSELECT 2";
    const [a, b] = splitSqlStatements(sql);
    expect(sql.slice(a.start, a.end)).toBe("SELECT 1");
    expect(a.terminatorEnd).toBe(sql.indexOf(";") + 1);
    expect(sql.slice(b.start, b.end)).toBe("SELECT 2");
    expect(b.terminatorEnd).toBe(sql.length);
  });
});

describe("leading comments", () => {
  it("are not part of the statement that follows them", () => {
    const sql = "SELECT 1; -- first query\nSELECT 2";
    const [a, b] = splitSqlStatements(sql);
    expect(a.text).toBe("SELECT 1");
    expect(b.text).toBe("SELECT 2");
    expect(b.start).toBe(sql.indexOf("SELECT 2"));
    expect(texts("/* header */\n-- title\nSELECT 3")).toEqual(["SELECT 3"]);
  });

  it("leave a cursor at the end of a trailing comment on the statement before", () => {
    const sql = "SELECT 1; -- first query\nSELECT 2";
    const statements = splitSqlStatements(sql);
    expect(statementAtOffset(sql, statements, sql.indexOf("\n"))?.text).toBe("SELECT 1");
  });

  it("skipLeadingComments finds the first code", () => {
    expect(skipLeadingComments("  -- a\n /* b */ SELECT 1")).toBe("  -- a\n /* b */ ".length);
    expect(skipLeadingComments("-- only")).toBe("-- only".length);
  });
});

describe("writesOutsideApp", () => {
  it("flags statements whose effects outlive the app's in-memory database", () => {
    expect(writesOutsideApp("COPY t TO 'out.csv'")).toBe(true);
    expect(writesOutsideApp("-- save\nEXPORT DATABASE 'dir'")).toBe(true);
    expect(writesOutsideApp("ATTACH 'crm.db' AS crm")).toBe(true);
    expect(writesOutsideApp("ATTACH 'read_only.db' AS x")).toBe(true);
  });

  it("allows statements that only touch the throwaway database", () => {
    expect(writesOutsideApp("ATTACH 'crm.db' AS crm (READ_ONLY)")).toBe(false);
    expect(writesOutsideApp("CREATE TEMP TABLE t AS SELECT 1")).toBe(false);
    expect(writesOutsideApp("SET threads = 4")).toBe(false);
    expect(writesOutsideApp("SELECT 'COPY' AS word")).toBe(false);
  });
});

describe("statementAtOffset", () => {
  const sql = "SELECT 1;\n\nSELECT 2;\nSELECT 3";
  const statements = splitSqlStatements(sql);
  const at = (offset: number) => statementAtOffset(sql, statements, offset)?.text;

  it("finds the statement containing the cursor", () => {
    expect(at(0)).toBe("SELECT 1");
    expect(at(sql.indexOf("2"))).toBe("SELECT 2");
    expect(at(sql.length)).toBe("SELECT 3");
  });

  it("treats a cursor right after a semicolon or on a blank line as the statement before", () => {
    expect(at(sql.indexOf(";") + 1)).toBe("SELECT 1");
    expect(at(sql.indexOf("\n\n") + 1)).toBe("SELECT 1");
  });

  it("returns null for an empty editor", () => {
    expect(statementAtOffset("  -- nothing\n", splitSqlStatements("  -- nothing\n"), 3)).toBeNull();
  });

  it("gives a heading comment on its own line to the statement below it", () => {
    const sql = "SELECT 1;\n\n-- Top customers\nSELECT 2";
    const statements = splitSqlStatements(sql);
    const at = (offset: number) => statementAtOffset(sql, statements, offset)?.text;
    expect(at(sql.indexOf("Top"))).toBe("SELECT 2");
    expect(at(sql.indexOf("\n\n") + 1)).toBe("SELECT 1"); // blank line before the heading
  });
});

describe("planRun", () => {
  it("runs the last statement after the others as setup", () => {
    const sql = "CREATE TEMP TABLE t AS SELECT 1 x; SELECT * FROM t";
    const plan = planRun(splitSqlStatements(sql));
    expect(plan).toEqual({
      sql: "SELECT * FROM t",
      setup: ["CREATE TEMP TABLE t AS SELECT 1 x"],
      start: 0,
      end: sql.length,
      starts: [0, sql.indexOf("SELECT * FROM t")],
    });
  });

  it("offsets positions for a selection", () => {
    const plan = planRun(splitSqlStatements(" SELECT 1"), 10);
    expect(plan?.start).toBe(11);
    expect(plan?.end).toBe(19);
    expect(plan?.starts).toEqual([11]);
  });

  it("returns null when there is nothing to run", () => {
    expect(planRun([])).toBeNull();
  });
});
