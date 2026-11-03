import type * as Monaco from "monaco-editor";
import { splitSqlStatements } from "./statements";

export interface EditorContext {
  /** Offset where the statement under the cursor starts (or the cursor, for a new one). */
  statementStart: number;
  /** The whole statement under the cursor, including text after the cursor. */
  statement: string;
  /** The statement's text up to the cursor. */
  before: string;
}

/** The statement under the cursor and the part of it before the cursor. */
export function editorContext(model: Monaco.editor.ITextModel, position: Monaco.Position): EditorContext {
  const full = model.getValue();
  const offset = model.getOffsetAt(position);
  const current = splitSqlStatements(full).find((s) =>
    offset >= s.start &&
    (offset < s.terminatorEnd || (offset === s.terminatorEnd && full[s.terminatorEnd - 1] !== ";")),
  );
  if (!current) return { statementStart: offset, statement: "", before: "" };
  const statementEnd = full[current.terminatorEnd - 1] === ";" ? current.terminatorEnd - 1 : current.terminatorEnd;
  return {
    statementStart: current.start,
    statement: full.slice(current.start, statementEnd),
    before: full.slice(current.start, offset),
  };
}
