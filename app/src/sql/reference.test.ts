import { describe, expect, it } from "vitest";
import type { FunctionDoc, FunctionSignature, WorkspaceTableInfo } from "../types";
import {
  activeParam, buildFunctionIndex, columnHoverMarkdown, formatSignature, functionHoverMarkdown,
  pickSignature, tableHoverMarkdown,
} from "./reference";

const sig = (params: [string, string | null][], returns: string | null, varargs: string | null = null): FunctionSignature => ({
  params: params.map(([name, duckdb_type]) => ({ name, duckdb_type })),
  returns,
  varargs,
});

const dateTrunc: FunctionDoc = {
  name: "date_trunc",
  kind: "scalar",
  description: "Truncate to specified precision",
  examples: ["date_trunc('hour', TIMESTAMPTZ '1992-09-20 20:38:40')"],
  signatures: [sig([["part", "VARCHAR"], ["timestamp", "TIMESTAMP"]], "TIMESTAMP")],
};

describe("formatSignature", () => {
  it("labels parameters with their types and marks each one's range", () => {
    const f = formatSignature("date_trunc", dateTrunc.signatures[0]);
    expect(f.label).toBe("date_trunc(part VARCHAR, timestamp TIMESTAMP) → TIMESTAMP");
    expect(f.params.map(([a, b]) => f.label.slice(a, b))).toEqual(["part VARCHAR", "timestamp TIMESTAMP"]);
  });

  it("shows a variadic tail and untyped macro parameters", () => {
    const concat = formatSignature("concat", sig([["value", "ANY"]], "VARCHAR", "ANY"));
    expect(concat.label).toBe("concat(value ANY, ANY, ...) → VARCHAR");
    expect(concat.params).toHaveLength(2);
    expect(formatSignature("m", sig([["a", null]], null)).label).toBe("m(a)");
  });
});

describe("pickSignature / activeParam", () => {
  const overloads = [sig([["x", "INTEGER"]], "INTEGER"), sig([["x", "DOUBLE"], ["digits", "INTEGER"]], "DOUBLE")];
  it("picks the first overload with enough parameters", () => {
    expect(pickSignature(overloads, 0)).toBe(0);
    expect(pickSignature(overloads, 1)).toBe(1);
    expect(pickSignature(overloads, 5)).toBe(0);
  });
  it("highlights the variadic tail past the fixed parameters", () => {
    const concat = sig([["value", "ANY"]], "VARCHAR", "ANY");
    expect(activeParam(concat, 0)).toBe(0);
    expect(activeParam(concat, 3)).toBe(1);
    // Too many arguments for a fixed-arity overload: out of range, nothing highlighted.
    expect(activeParam(overloads[0], 3)).toBe(1);
  });
});

describe("hover markdown", () => {
  it("shows signatures, description and an example for a function", () => {
    const md = functionHoverMarkdown([dateTrunc]);
    expect(md).toContain("**date_trunc** · function");
    expect(md).toContain("date_trunc(part VARCHAR, timestamp TIMESTAMP) → TIMESTAMP");
    expect(md).toContain("Truncate to specified precision");
    expect(md).toContain("Example:");
  });

  it("caps the overloads shown", () => {
    const many: FunctionDoc = { ...dateTrunc, name: "abs", signatures: ["TINYINT", "SMALLINT", "INTEGER", "BIGINT", "FLOAT", "DOUBLE"].map((t) => sig([["x", t]], t)) };
    const md = functionHoverMarkdown([many]);
    expect(md).toContain("+2 more overloads");
    expect(md).not.toContain("abs(x DOUBLE)");
  });

  it("keeps backticks in examples inside the code block", () => {
    const md = functionHoverMarkdown([{ ...dateTrunc, examples: ["SELECT ```x```"] }]);
    expect(md).toContain("````sql\nSELECT ```x```\n````");
  });

  it("describes tables, aliases and columns", () => {
    const table: WorkspaceTableInfo = {
      alias: "orders", file_path: "C:/data/orders.parquet", is_glob: false, is_remote: false,
      source_kind: "parquet", delimiter: null, object_name: null, header: null,
      file_size_bytes: 1000, row_count: 12345,
    };
    const cols = [{ name: "id", duckdb_type: "BIGINT" }, { name: "amount", duckdb_type: "DOUBLE" }];
    const md = tableHoverMarkdown(table, cols);
    expect(md).toContain("**orders** · workspace table");
    expect(md).toContain("2 columns · 12,345 rows");
    expect(md).toContain("`C:/data/orders.parquet`");
    expect(tableHoverMarkdown(table, cols, "o")).toContain("**o** → table **orders**");

    expect(columnHoverMarkdown("id", [{ table: "orders", column: cols[0] }])).toContain("orders.id BIGINT");
  });
});

describe("buildFunctionIndex", () => {
  it("keys by lower-case name and keeps every kind", () => {
    const index = buildFunctionIndex([dateTrunc, { ...dateTrunc, name: "Date_Trunc", kind: "macro" }]);
    expect(index.get("date_trunc")?.map((d) => d.kind)).toEqual(["scalar", "macro"]);
  });
});
