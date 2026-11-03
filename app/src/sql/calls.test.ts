import { describe, expect, it } from "vitest";
import { callFrames, isCodeAt } from "./calls";

const names = (before: string) => callFrames(before).map((f) => [f.name, f.argIndex]);

describe("callFrames", () => {
  it("finds the call and argument under the cursor", () => {
    expect(names("SELECT date_trunc(")).toEqual([["date_trunc", 0]]);
    expect(names("SELECT date_trunc('day', ")).toEqual([["date_trunc", 1]]);
    expect(names("SELECT date_trunc('day', ts) + ")).toEqual([]);
  });

  it("lists nested calls innermost first", () => {
    expect(names("SELECT round(sum(amount), ")).toEqual([["round", 1]]);
    expect(names("SELECT round(sum(amount")).toEqual([["sum", 0], ["round", 0]]);
    expect(names("SELECT coalesce((a + b), ")).toEqual([["coalesce", 1]]);
    expect(names("SELECT coalesce((a + ")).toEqual([[null, 0], ["coalesce", 0]]);
  });

  it("ignores commas and parens inside strings, quoted names and comments", () => {
    expect(names("SELECT concat('a, (b', ")).toEqual([["concat", 1]]);
    expect(names('SELECT concat("x,y", ')).toEqual([["concat", 1]]);
    expect(names("SELECT concat(a, -- note, (\n b, ")).toEqual([["concat", 2]]);
    expect(names("SELECT concat(a, /* , ( */ b, ")).toEqual([["concat", 2]]);
    expect(names("SELECT concat($$a,(b$$, ")).toEqual([["concat", 1]]);
  });

  it("returns nothing while the cursor is inside a string or comment", () => {
    expect(callFrames("SELECT concat('a, ")).toEqual([]);
    expect(callFrames("SELECT concat(a -- note")).toEqual([]);
  });

  it("uses the last part of a qualified name and allows a space before the paren", () => {
    expect(names("SELECT main.abs (")).toEqual([["abs", 0]]);
  });
});

describe("isCodeAt", () => {
  const sql = "SELECT 'sum' AS s, sum(x) -- sum\nFROM t";
  it("is false inside strings and comments and true in code", () => {
    expect(isCodeAt(sql, sql.indexOf("sum") + 1)).toBe(false);
    expect(isCodeAt(sql, sql.indexOf("sum(") + 1)).toBe(true);
    expect(isCodeAt(sql, sql.indexOf("-- sum") + 4)).toBe(false);
    expect(isCodeAt(sql, sql.indexOf("FROM") + 1)).toBe(true);
  });
});
