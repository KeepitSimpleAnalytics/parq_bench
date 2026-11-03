import { describe, expect, it } from "vitest";
import { findTableReferences } from "./aliases";

const aliasesOf = (sql: string) => Object.fromEntries(findTableReferences(sql).aliases);

describe("findTableReferences", () => {
  it("reads aliases with and without AS", () => {
    const refs = findTableReferences("SELECT * FROM orders o JOIN lineitem AS l ON o.k = l.k");
    expect(refs.tables).toEqual(["orders", "lineitem"]);
    expect(aliasesOf("SELECT * FROM orders o JOIN lineitem AS l ON o.k = l.k")).toEqual({
      orders: "orders",
      o: "orders",
      lineitem: "lineitem",
      l: "lineitem",
    });
  });

  it("handles comma-separated FROM lists and every JOIN flavour", () => {
    const sql = "SELECT * FROM a x, b y LEFT OUTER JOIN c z USING (k) CROSS JOIN d";
    expect(findTableReferences(sql).tables).toEqual(["a", "b", "c", "d"]);
    expect(aliasesOf(sql)).toMatchObject({ x: "a", y: "b", z: "c" });
  });

  it("does not mistake clause keywords for aliases", () => {
    expect(aliasesOf("SELECT * FROM orders WHERE x = 1")).toEqual({ orders: "orders" });
    expect(aliasesOf("SELECT * FROM orders GROUP BY 1")).toEqual({ orders: "orders" });
    expect(aliasesOf("SELECT * FROM orders o QUALIFY true")).toEqual({ orders: "orders", o: "orders" });
  });

  it("works when FROM comes after the cursor's position in the text", () => {
    // The editor passes the whole statement, so a FROM after the SELECT list still counts.
    expect(aliasesOf("SELECT o. FROM orders o")).toMatchObject({ o: "orders" });
  });

  it("supports quoted names and schema-qualified tables", () => {
    expect(aliasesOf('SELECT * FROM "my table" AS "t 1"')).toEqual({ "my table": "my table", "t 1": "my table" });
    expect(aliasesOf("SELECT * FROM main.orders o")).toEqual({ orders: "orders", o: "orders" });
  });

  it("skips subqueries and table functions but keeps the tables inside", () => {
    const sql = "SELECT * FROM (SELECT * FROM orders o) sub JOIN read_parquet('x.parquet') rp ON true";
    const refs = findTableReferences(sql);
    expect(refs.tables).toEqual(["orders"]);
    expect(refs.aliases.has("sub")).toBe(false);
    expect(refs.aliases.has("rp")).toBe(false);
    expect(refs.aliases.get("o")).toBe("orders");
  });

  it("ignores names inside strings and comments", () => {
    expect(findTableReferences("SELECT 'FROM fake f' -- FROM other\nFROM real r").tables).toEqual(["real"]);
  });

  it("is case-insensitive for aliases but keeps the table's spelling", () => {
    expect(findTableReferences("select * from Orders O").aliases.get("o")).toBe("Orders");
  });
});
