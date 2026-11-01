/**
 * SQL statement splitting for the editor. Mirrors `split_sql_statements` in the
 * Rust backend: `;` only separates statements outside 'strings', "identifiers",
 * $$dollar$$ strings, -- line comments and block comments.
 */

export interface SqlStatement {
  /** Statement text, trimmed. Never empty and never only comments. */
  text: string;
  /** Offset of the first character of `text` in the source. */
  start: number;
  /** Offset just past the last character of `text`. */
  end: number;
  /** Offset just past this statement's terminating `;`, or the source length. */
  terminatorEnd: number;
}

function isIdentChar(ch: string): boolean {
  return /[\p{L}\p{N}_]/u.test(ch);
}

/** Index of the first character in sql[from, to) that isn't whitespace or part of a comment. */
export function skipLeadingComments(sql: string, from = 0, to = sql.length): number {
  let i = from;
  while (i < to) {
    if (/\s/.test(sql[i])) {
      i += 1;
    } else if (sql[i] === "-" && sql[i + 1] === "-") {
      const newline = sql.indexOf("\n", i);
      i = newline === -1 || newline >= to ? to : newline + 1;
    } else if (sql[i] === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close === -1 || close + 2 > to ? to : close + 2;
    } else {
      break;
    }
  }
  return i;
}

/**
 * Whether re-running `statement` could change something outside the app's throwaway
 * in-memory database: writing files (COPY, EXPORT) or attaching a database that
 * could then be modified. Export re-runs a script's setup statements, so it refuses
 * those rather than repeat their effects.
 */
export function writesOutsideApp(statement: string): boolean {
  const code = statement.slice(skipLeadingComments(statement)).toUpperCase();
  if (/^(COPY|EXPORT)\b/.test(code)) return true;
  // Read-only only when READ_ONLY is in the trailing option list, not e.g. a file name.
  return /^ATTACH\b/.test(code) && !/\(\s*[^)]*\bREAD_ONLY\b[^)]*\)\s*$/.test(code);
}

/** Splits `sql` into statements, keeping their positions in the source. */
export function splitSqlStatements(sql: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let chunkStart = 0;
  let hasCode = false;
  let i = 0;

  const pushChunk = (chunkEnd: number, terminatorEnd: number) => {
    if (hasCode) {
      // A statement starts at its first code: comments before it (e.g. a note after the
      // previous statement's `;`) don't belong to it.
      const start = skipLeadingComments(sql, chunkStart, chunkEnd);
      const text = sql.slice(start, chunkEnd).trimEnd();
      statements.push({ text, start, end: start + text.length, terminatorEnd });
    }
    hasCode = false;
    chunkStart = terminatorEnd;
  };

  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "'" || c === '"') {
      // Quoted text; a doubled quote is an escaped quote.
      hasCode = true;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            i += 2;
            continue;
          }
          break;
        }
        i += 1;
      }
      i += 1;
    } else if (c === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
    } else if (c === "/" && next === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close === -1 ? sql.length : close + 2;
    } else if (c === "$") {
      // $tag$ ... $tag$ (tag may be empty). A `$` followed by a digit (`$1`) is a parameter.
      hasCode = true;
      let j = i + 1;
      while (j < sql.length && isIdentChar(sql[j])) j += 1;
      const tagIsValid = j < sql.length && sql[j] === "$" && !/[0-9]/.test(sql[i + 1] ?? "");
      if (tagIsValid) {
        const tag = sql.slice(i, j + 1);
        const close = sql.indexOf(tag, j + 1);
        i = close === -1 ? sql.length : close + tag.length;
      } else {
        i += 1;
      }
    } else if (c === ";") {
      pushChunk(i, i + 1);
      i += 1;
    } else {
      if (!/\s/.test(c)) hasCode = true;
      i += 1;
    }
  }
  pushChunk(sql.length, sql.length);
  return statements;
}

/**
 * The statement the cursor belongs to: the one whose span (up to and including its
 * `;`) contains `offset`. Between two statements:
 * - the rest of the `;` line (e.g. a trailing `-- note`) and blank lines after it
 *   belong to the statement before, which is what "run what I just typed" expects;
 * - a comment on its own line, and anything after it, is a heading for the
 *   statement below, so it belongs to that one.
 */
export function statementAtOffset(sql: string, statements: SqlStatement[], offset: number): SqlStatement | null {
  if (statements.length === 0) return null;
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    const following = statements[index + 1];
    if (offset <= statement.terminatorEnd) return statement;
    if (!following || offset < following.start) {
      if (!following) return statement;
      const lineEnd = sql.indexOf("\n", statement.terminatorEnd);
      if (lineEnd === -1 || offset <= lineEnd) return statement;
      const headingStart = lineEnd + 1 + (sql.slice(lineEnd + 1, following.start).search(/\S/));
      const hasHeading = headingStart > lineEnd && headingStart < following.start;
      return hasHeading && offset >= headingStart ? following : statement;
    }
  }
  return statements[statements.length - 1];
}

/** Statements to send to the backend: everything before the last runs first as setup. */
export interface RunPlan {
  sql: string;
  setup: string[];
  /** Source range that will run, for highlighting. */
  start: number;
  end: number;
  /** Source offset of each statement's text: the setup statements in order, then `sql`. */
  starts: number[];
}

export function planRun(statements: SqlStatement[], offsetBase = 0): RunPlan | null {
  if (statements.length === 0) return null;
  const last = statements[statements.length - 1];
  return {
    sql: last.text,
    setup: statements.slice(0, -1).map((s) => s.text),
    start: offsetBase + statements[0].start,
    end: offsetBase + last.end,
    starts: statements.map((s) => offsetBase + s.start),
  };
}
