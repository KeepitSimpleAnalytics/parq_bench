import { describe, expect, it } from "vitest";
import { displayWidth, failedStatementIndex, locateDuckDbError } from "./errorPosition";

/** The text a span covers, for readable assertions. */
function spanText(message: string, statement: string): string | null {
  const span = locateDuckDbError(message, statement);
  return span ? statement.slice(span.offset, span.offset + span.length) : null;
}

// Messages below are verbatim DuckDB 2.0 output, captured through the app's own
// query wrappers (query_schema / query_rows_with_limit / execute_batch).
describe("locateDuckDbError", () => {
  it("finds a parser error on an unwrapped statement", () => {
    const sql = "SELECT * FORM orders";
    const msg = 'Parser Error: syntax error at or near "orders"\n\nLINE 1: SELECT * FORM orders\n                      ^^^^^^';
    expect(locateDuckDbError(msg, sql)).toEqual({ offset: 14, length: 6 });
  });

  it("finds a binder error through the DESCRIBE wrapper on line 1", () => {
    const sql = "SELECT idd FROM orders";
    const msg = 'prepare workspace schema query: Binder Error: Referenced column "idd" not found in FROM clause!\nCandidate bindings: "id"\n\nLINE 1: DESCRIBE SELECT * FROM (SELECT idd FROM orders\n                                       ^^^';
    expect(spanText(msg, sql)).toBe("idd");
  });

  it("finds an error on a later line", () => {
    const sql = "SELECT *\nFROM orderz";
    const msg = 'prepare workspace schema query: Catalog Error: Table with name orderz does not exist!\nDid you mean "orders"?\n\nLINE 2: FROM orderz\n             ^^^^^^';
    expect(locateDuckDbError(msg, sql)).toEqual({ offset: 14, length: 6 });
  });

  it("handles CRLF line endings", () => {
    const sql = "SELECT id,\r\n  bogus\r\nFROM orders";
    const msg = 'prepare workspace schema query: Binder Error: Referenced column "bogus" not found in FROM clause!\nCandidate bindings: "amount", "customer"\n\nLINE 2:   bogus\n          ^^^^^';
    expect(spanText(msg, sql)).toBe("bogus");
  });

  it("treats tabs as zero-width, as DuckDB's caret does", () => {
    const sql = "SELECT\tid,\tbogus FROM orders";
    const msg = 'prepare workspace schema query: Binder Error: Referenced column "bogus" not found in FROM clause!\nCandidate bindings: "amount", "customer"\n\nLINE 1: DESCRIBE SELECT * FROM (SELECT\tid,\tbogus FROM orders\n                                         ^^^^^';
    expect(spanText(msg, sql)).toBe("bogus");
  });

  it("counts wide characters as two columns and combining marks as none", () => {
    const cjk = "SELECT 'é漢字', bogus FROM orders";
    const cjkMsg = 'Binder Error: Referenced column "bogus" not found in FROM clause!\nCandidate bindings: "amount", "customer"\n\nLINE 1: SELECT \'é漢字\', bogus FROM orders\n                        ^^^^^';
    expect(spanText(cjkMsg, cjk)).toBe("bogus");

    const emoji = "SELECT 'emoji 😀', bogus FROM orders";
    const emojiMsg = 'prepare workspace schema query: Binder Error: Referenced column "bogus" not found in FROM clause!\nCandidate bindings: "amount", "customer"\n\nLINE 1: DESCRIBE SELECT * FROM (SELECT \'emoji 😀\', bogus FROM orders\n                                                   ^^^^^';
    expect(spanText(emojiMsg, emoji)).toBe("bogus");

    const combining = "SELECT 'é', bogus FROM orders";
    const combiningMsg = 'prepare workspace schema query: Binder Error: Referenced column "bogus" not found in FROM clause!\nCandidate bindings: "amount", "customer"\n\nLINE 1: DESCRIBE SELECT * FROM (SELECT \'é\', bogus FROM orders\n                                            ^^^^^';
    expect(spanText(combiningMsg, combining)).toBe("bogus");
  });

  // Caret columns measured from DuckDB 2.0 for `SELECT '<s>', bogus FROM t`: each
  // grapheme is as wide as its first code point.
  it.each([
    ["rocket", "\u{1F680}", 2],
    ["lightning", "\u{26A1}", 2],
    ["check mark", "\u{2705}", 2],
    ["flag pair", "\u{1F1FA}\u{1F1F8}", 1],
    ["ZWJ family", "\u{1F468}‍\u{1F469}‍\u{1F467}", 2],
    ["skin tone", "\u{1F44D}\u{1F3FD}", 2],
    ["star", "\u{2B50}", 2],
    ["watch", "\u{231A}", 2],
    ["fullwidth A", "Ａ", 2],
    ["Cyrillic", "А", 1],
  ])("lines up the caret after a %s", (_label, text, width) => {
    const sql = `SELECT '${text}', bogus FROM t`;
    const msg = `Binder Error: Referenced column "bogus" not found in FROM clause!\n\nLINE 1: ${sql}\n${" ".repeat(8 + 11 + Number(width))}^^^^^`;
    expect(spanText(msg, sql)).toBe("bogus");
  });

  it("rejects a caret that lands inside a name (a width counted differently)", () => {
    const sql = "SELECT 'x', bogus FROM t";
    // One column too far: points at the "o" of bogus.
    const msg = `Binder Error: Referenced column "bogus" not found in FROM clause!\n\nLINE 1: ${sql}\n${" ".repeat(8 + 13)}^^^^^`;
    expect(locateDuckDbError(msg, sql)).toBeNull();
  });

  it("rejects a caret that doesn't start at the token the error names", () => {
    const sql = "SELECT 'x', bogus, other FROM t";
    // Lands on "other" (a token boundary) while the error is about "bogus".
    const msg = `Binder Error: Referenced column "bogus" not found in FROM clause!\n\nLINE 1: ${sql}\n${" ".repeat(8 + 19)}^^^^^`;
    expect(locateDuckDbError(msg, sql)).toBeNull();
  });

  it("lines up a long line cut short on both sides", () => {
    const cols = Array.from({ length: 30 }, (_, i) => `id AS c${i},`).join("");
    const more = Array.from({ length: 30 }, (_, i) => `id AS d${i}`).join(",");
    const sql = `SELECT ${cols} bogus_col, ${more} FROM orders`;
    const msg = 'prepare workspace schema query: Binder Error: Referenced column "bogus_col" not found in FROM clause!\nCandidate bindings: "amount"\n\nLINE 1: ...,id AS c24,id AS c25,id AS c26,id AS c27,id AS c28,id AS c29, bogus_col, id AS d0,id AS d1,id AS d2,id AS d3,id AS d4...\n                                                                         ^^^^^^^^^';
    expect(spanText(msg, sql)).toBe("bogus_col");
  });

  it("finds a runtime error raised inside the row-fetching wrapper", () => {
    const sql = "SELECT CAST(customer AS INT) FROM orders";
    const msg = 'run workspace query rows: Conversion Error: Could not convert string \'bob\' to INT32 when casting from source column customer\n\nLINE 1: ...)" AS VARCHAR) AS "CAST(customer AS INTEGER)" FROM (SELECT CAST(customer AS INT) FROM orders\n                                                                      ^^^^^^^^^^^^^^^^^^^^^';
    expect(spanText(msg, sql)).toBe("CAST(customer AS INT)");

    const multi = "SELECT id,\n  CAST('x' AS INT) AS bad\nFROM orders";
    const multiMsg = "run workspace query rows: Conversion Error: Could not convert string 'x' to INT32\n\nLINE 2:   CAST('x' AS INT) AS bad\n          ^^^^^^^^^^^^^^^^";
    expect(spanText(multiMsg, multi)).toBe("CAST('x' AS INT)");
  });

  it("finds a setup-statement error with the backend's statement prefix", () => {
    const sql = "CREATE TABLE t AS SELECT bogus FROM orders";
    const msg = 'statement 1 of 2: Binder Error: Referenced column "bogus" not found in FROM clause!\nCandidate bindings: "amount", "customer"\n\nLINE 1: CREATE TABLE t AS SELECT bogus FROM orders\n                                 ^^^^^';
    expect(spanText(msg, sql)).toBe("bogus");
  });

  it("offsets past leading whitespace the backend trims", () => {
    const sql = "\n  SELECT idd FROM orders";
    const msg = "Binder Error: x\n\nLINE 1: SELECT idd FROM orders\n               ^^^";
    expect(spanText(msg, sql)).toBe("idd");
  });

  it("returns null when there is no position", () => {
    expect(locateDuckDbError("Query cancelled.", "SELECT 1")).toBeNull();
    expect(locateDuckDbError("Conversion Error: Could not convert string 'x' to INT32", "SELECT 1")).toBeNull();
  });

  it("returns null when the caret points into a wrapper, not the user's text", () => {
    const sql = "SELECT 1";
    const msg = "Binder Error: x\n\nLINE 1: DESCRIBE SELECT * FROM (SELECT 1\n        ^^^^^^^^";
    expect(locateDuckDbError(msg, sql)).toBeNull();
  });

  it("returns null when the shown line doesn't match the statement", () => {
    const msg = "Binder Error: x\n\nLINE 1: SELECT idd FROM orders\n               ^^^";
    expect(locateDuckDbError(msg, "SELECT other FROM orders")).toBeNull();
    expect(locateDuckDbError("Binder Error: x\n\nLINE 3: idd\n        ^^^", "SELECT idd")).toBeNull();
  });

  it("ignores errors about registering workspace tables", () => {
    const msg = "register workspace table 'orders': Binder Error: x\n\nLINE 1: SELECT * FROM orders\n                     ^^^^^^";
    expect(locateDuckDbError(msg, "SELECT * FROM orders")).toBeNull();
  });
});

describe("displayWidth", () => {
  it("matches DuckDB's caret widths", () => {
    expect(displayWidth("a".codePointAt(0)!)).toBe(1);
    expect(displayWidth("\t".codePointAt(0)!)).toBe(0);
    expect(displayWidth(0x0301)).toBe(0);
    expect(displayWidth("漢".codePointAt(0)!)).toBe(2);
    expect(displayWidth("😀".codePointAt(0)!)).toBe(2);
  });
});

describe("failedStatementIndex", () => {
  it("reads the backend's statement prefix, else blames the last statement", () => {
    expect(failedStatementIndex("statement 2 of 3: Binder Error: x", 3)).toBe(1);
    expect(failedStatementIndex("Binder Error: x", 3)).toBe(2);
    expect(failedStatementIndex("statement 9 of 9: x", 3)).toBe(2);
  });
});
