/**
 * Finds which tables a statement uses and the aliases it gives them, e.g.
 * `FROM orders o JOIN lineitem AS l` → { o: "orders", l: "lineitem" }.
 * DuckDB's autocomplete doesn't resolve aliases written in the query, so the
 * editor uses this for `alias.` completion and to rank the query's own columns.
 * It's a lightweight scanner, not a full SQL parser: subqueries, table functions
 * and CTE bodies are skipped rather than resolved.
 */

type Token =
  | { kind: "word"; value: string; quoted: boolean }
  | { kind: "punct"; value: string };

/** Words that end a FROM clause or can't be an alias. */
const RESERVED = new Set([
  "ANTI", "AS", "ASOF", "CROSS", "EXCEPT", "FETCH", "FROM", "FULL", "GROUP", "HAVING",
  "INNER", "INTERSECT", "JOIN", "LATERAL", "LEFT", "LIMIT", "NATURAL", "OFFSET", "ON",
  "ORDER", "OUTER", "PIVOT", "POSITIONAL", "QUALIFY", "RETURNING", "RIGHT", "SAMPLE",
  "SELECT", "SEMI", "SET", "TABLESAMPLE", "UNION", "UNPIVOT", "USING", "VALUES", "WHERE",
  "WINDOW", "WITH",
]);

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close === -1 ? sql.length : close + 2;
    } else if (c === "'") {
      // String literal: skipped, but kept as a placeholder so it can't be read as a name.
      i += 1;
      while (i < sql.length && !(sql[i] === "'" && sql[i + 1] !== "'")) i += sql[i] === "'" ? 2 : 1;
      i += 1;
      tokens.push({ kind: "punct", value: "'" });
    } else if (c === '"') {
      let value = "";
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          break;
        }
        value += sql[i];
        i += 1;
      }
      i += 1;
      tokens.push({ kind: "word", value, quoted: true });
    } else if (/[\p{L}_]/u.test(c)) {
      let j = i + 1;
      while (j < sql.length && /[\p{L}\p{N}_$]/u.test(sql[j])) j += 1;
      tokens.push({ kind: "word", value: sql.slice(i, j), quoted: false });
      i = j;
    } else {
      tokens.push({ kind: "punct", value: c });
      i += 1;
    }
  }
  return tokens;
}

function isKeyword(token: Token | undefined, ...words: string[]): boolean {
  return token?.kind === "word" && !token.quoted && words.includes(token.value.toUpperCase());
}

function isName(token: Token | undefined): token is { kind: "word"; value: string; quoted: boolean } {
  return token?.kind === "word" && (token.quoted || !RESERVED.has(token.value.toUpperCase()));
}

export interface TableReferences {
  /** Lower-cased alias → table name as written. A table without an alias maps to itself. */
  aliases: Map<string, string>;
  /** Table names used, in order of appearance, without duplicates. */
  tables: string[];
}

/** Index just past the parenthesised group that starts at `open`. */
function skipParens(tokens: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.kind === "punct" && t.value === "(") depth += 1;
    if (t.kind === "punct" && t.value === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return tokens.length;
}

export function findTableReferences(sql: string): TableReferences {
  const tokens = tokenize(sql);
  const aliases = new Map<string, string>();
  const tables: string[] = [];

  const addTable = (name: string, alias: string | null) => {
    if (!tables.some((t) => t.toLowerCase() === name.toLowerCase())) tables.push(name);
    aliases.set(name.toLowerCase(), name);
    if (alias) aliases.set(alias.toLowerCase(), name);
  };

  /** Reads one FROM item at `i`; returns the index after it. */
  const readFromItem = (start: number): number => {
    let i = start;
    let tableName: string | null = null;
    if (tokens[i]?.kind === "punct" && tokens[i].value === "(") {
      // Subquery or parenthesised join: not resolved, but its alias is skipped.
      i = skipParens(tokens, i);
    } else if (isName(tokens[i])) {
      // schema.table → keep the last part, which is what workspace tables are named.
      let name = (tokens[i] as { value: string }).value;
      i += 1;
      while (tokens[i]?.kind === "punct" && tokens[i].value === "." && isName(tokens[i + 1])) {
        name = (tokens[i + 1] as { value: string }).value;
        i += 2;
      }
      if (tokens[i]?.kind === "punct" && tokens[i].value === "(") {
        // Table function such as read_parquet(...): columns unknown.
        i = skipParens(tokens, i);
      } else {
        tableName = name;
      }
    } else {
      return i;
    }
    let alias: string | null = null;
    if (isKeyword(tokens[i], "AS") && isName(tokens[i + 1])) {
      alias = (tokens[i + 1] as { value: string }).value;
      i += 2;
    } else if (isName(tokens[i])) {
      alias = (tokens[i] as { value: string }).value;
      i += 1;
    }
    // Column alias list: t(a, b)
    if (alias && tokens[i]?.kind === "punct" && tokens[i].value === "(") i = skipParens(tokens, i);
    if (tableName) addTable(tableName, alias);
    return i;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    if (!isKeyword(tokens[i], "FROM", "JOIN")) continue;
    let j = readFromItem(i + 1);
    // Comma-separated FROM list: FROM a x, b y
    while (tokens[j]?.kind === "punct" && tokens[j].value === ",") j = readFromItem(j + 1);
    // Keep scanning from the next token rather than jumping past the FROM list, so
    // FROM/JOIN inside subqueries is still found. Re-reading a table is harmless.
  }
  return { aliases, tables };
}
