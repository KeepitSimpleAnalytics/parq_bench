/**
 * Formatting for the editor's hover cards and signature help: DuckDB functions
 * (from `duckdb_functions()`), workspace tables and their columns.
 */
import type { FunctionDoc, FunctionSignature, PreviewColumn, WorkspaceSchemaByAlias, WorkspaceTableInfo } from "../types";

/** A workspace table's columns by name, ignoring case; `alias` is the name as registered. */
export function findSchema(schemas: WorkspaceSchemaByAlias, table: string): { alias: string; schema: PreviewColumn[] } | null {
  const lower = table.toLowerCase();
  for (const [alias, schema] of Object.entries(schemas)) {
    if (alias.toLowerCase() === lower) return { alias, schema };
  }
  return null;
}

/** Overloads shown in a hover card before "+N more". */
export const HOVER_SIGNATURE_LIMIT = 4;

export type FunctionIndex = Map<string, FunctionDoc[]>;

/** Function docs keyed by lower-case name (a name can be both, e.g., a scalar and an aggregate). */
export function buildFunctionIndex(docs: FunctionDoc[]): FunctionIndex {
  const index: FunctionIndex = new Map();
  for (const doc of docs) {
    const key = doc.name.toLowerCase();
    const list = index.get(key);
    if (list) list.push(doc);
    else index.set(key, [doc]);
  }
  return index;
}

export interface FormattedSignature {
  label: string;
  /** [start, end) of each parameter in `label`; a variadic tail is the last one. */
  params: [number, number][];
}

export function formatSignature(name: string, sig: FunctionSignature): FormattedSignature {
  let label = `${name}(`;
  const params: [number, number][] = [];
  const parts = sig.params.map((p) => (p.duckdb_type ? `${p.name} ${p.duckdb_type}` : p.name));
  if (sig.varargs) parts.push(`${sig.varargs}, ...`);
  parts.forEach((part, i) => {
    if (i > 0) label += ", ";
    params.push([label.length, label.length + part.length]);
    label += part;
  });
  label += ")";
  if (sig.returns) label += ` → ${sig.returns}`;
  return { label, params };
}

/**
 * The overload to highlight for the argument the cursor is in: the first that has
 * that many parameters (or takes any number), else the first one.
 */
export function pickSignature(signatures: FunctionSignature[], argIndex: number): number {
  const found = signatures.findIndex((s) => s.varargs !== null || s.params.length > argIndex);
  return found === -1 ? 0 : found;
}

/**
 * Index into `formatSignature(...).params` for the argument the cursor is in. Past the
 * last parameter of a fixed-arity function it's out of range, so nothing is highlighted.
 */
export function activeParam(sig: FunctionSignature, argIndex: number): number {
  if (argIndex < sig.params.length) return argIndex;
  return sig.params.length;
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "scalar": return "function";
    case "aggregate": return "aggregate function";
    case "window": return "window function";
    case "table": return "table function";
    case "macro": return "macro";
    case "table_macro": return "table macro";
    default: return kind.replace(/_/g, " ");
  }
}

function codeBlock(lines: string[]): string {
  // Fence longer than any backtick run inside, so the block can't be closed early.
  const longest = Math.max(2, ...lines.map((l) => Math.max(0, ...(l.match(/`+/g) ?? []).map((m) => m.length))));
  const fence = "`".repeat(longest + 1);
  return `${fence}sql\n${lines.join("\n")}\n${fence}`;
}

/** Markdown for hovering a function name: signatures, description, an example. */
export function functionHoverMarkdown(docs: FunctionDoc[]): string {
  const sections = docs.map((doc) => {
    const shown = doc.signatures.slice(0, HOVER_SIGNATURE_LIMIT).map((s) => formatSignature(doc.name, s).label);
    const extra = doc.signatures.length - shown.length;
    const parts = [`**${doc.name}** · ${kindLabel(doc.kind)}`, codeBlock(shown)];
    if (extra > 0) parts.push(`+${extra} more overload${extra === 1 ? "" : "s"}`);
    if (doc.description) parts.push(doc.description);
    if (doc.examples.length > 0) parts.push(`Example:\n${codeBlock([doc.examples[0]])}`);
    return parts.join("\n\n");
  });
  return sections.join("\n\n---\n\n");
}

/** Signature-help documentation: the description only (the label already shows types). */
export function functionSummary(doc: FunctionDoc): string {
  return doc.description ?? kindLabel(doc.kind);
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** Markdown for hovering a workspace table name, or an alias that stands for one. */
export function tableHoverMarkdown(
  table: WorkspaceTableInfo,
  columns: PreviewColumn[] | undefined,
  aliasUsed?: string,
): string {
  const heading = aliasUsed && aliasUsed.toLowerCase() !== table.alias.toLowerCase()
    ? `**${aliasUsed}** → table **${table.alias}**`
    : `**${table.alias}** · workspace table`;
  const facts: string[] = [];
  if (columns) facts.push(`${formatCount(columns.length)} column${columns.length === 1 ? "" : "s"}`);
  if (table.row_count !== null) facts.push(`${formatCount(table.row_count)} rows`);
  const source = table.object_name ? `${table.file_path} › ${table.object_name}` : table.file_path;
  const parts = [heading];
  if (facts.length > 0) parts.push(facts.join(" · "));
  parts.push(`\`${source.replace(/`/g, "'")}\``);
  return parts.join("\n\n");
}

export interface ColumnMatch {
  table: string;
  column: PreviewColumn;
}

/** Markdown for hovering a column name: its type in each table that has it. */
export function columnHoverMarkdown(name: string, matches: ColumnMatch[]): string {
  const lines = matches.map((m) => `${m.table}.${m.column.name} ${m.column.duckdb_type}`);
  return [`**${name}** · column`, codeBlock(lines)].join("\n\n");
}
