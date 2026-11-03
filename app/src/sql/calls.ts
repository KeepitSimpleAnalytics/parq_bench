/**
 * Lightweight SQL scanning for signature help and hover: which function call the
 * cursor is inside, and whether a position is in code (not a string or comment).
 * Uses the same quoting rules as `splitSqlStatements`.
 */

/** An open parenthesis around the cursor, innermost first in `callFrames`' result. */
export interface CallFrame {
  /** The identifier right before `(` (last part of `schema.name`), or null for a grouping paren. */
  name: string | null;
  /** Offset of `name` in the text (or of the paren when there is no name). */
  nameStart: number;
  /** Zero-based argument the cursor is in: commas seen at this paren's level. */
  argIndex: number;
}

const IDENT_TAIL_RE = /([\p{L}_][\p{L}\p{N}_$]*)\s*$/u;

interface ScanHandlers {
  /** Called for each character of code (outside strings and comments). */
  code(index: number, ch: string): void;
}

/** Walks `sql`, calling back for code characters only. Returns false if it ends inside a string or comment. */
function scan(sql: string, handlers: ScanHandlers): boolean {
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "'" || c === '"') {
      let closed = false;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            i += 2;
            continue;
          }
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) return false;
      i += 1;
    } else if (c === "-" && next === "-") {
      const newline = sql.indexOf("\n", i);
      if (newline === -1) return false;
      i = newline + 1;
    } else if (c === "/" && next === "*") {
      const close = sql.indexOf("*/", i + 2);
      if (close === -1) return false;
      i = close + 2;
    } else if (c === "$" && !/[0-9]/.test(next ?? "")) {
      let j = i + 1;
      while (j < sql.length && /[\p{L}\p{N}_]/u.test(sql[j])) j += 1;
      if (j < sql.length && sql[j] === "$") {
        const tag = sql.slice(i, j + 1);
        const close = sql.indexOf(tag, j + 1);
        if (close === -1) return false;
        i = close + tag.length;
      } else {
        handlers.code(i, c);
        i += 1;
      }
    } else {
      handlers.code(i, c);
      i += 1;
    }
  }
  return true;
}

/**
 * Open parentheses enclosing the end of `before` (the text up to the cursor),
 * innermost first. Empty when the cursor is in a string or comment.
 */
export function callFrames(before: string): CallFrame[] {
  const stack: CallFrame[] = [];
  const inCode = scan(before, {
    code(index, ch) {
      if (ch === "(") {
        // For `schema.fn(` this is the last part, which is what the reference is keyed by.
        const ident = before.slice(0, index).match(IDENT_TAIL_RE);
        stack.push({
          name: ident ? ident[1] : null,
          nameStart: ident ? ident.index! : index,
          argIndex: 0,
        });
      } else if (ch === ")") {
        stack.pop();
      } else if (ch === "," && stack.length > 0) {
        stack[stack.length - 1].argIndex += 1;
      }
    },
  });
  return inCode ? stack.reverse() : [];
}

/** Whether `offset` in `sql` is in code, not inside a string, quoted identifier or comment. */
export function isCodeAt(sql: string, offset: number): boolean {
  return scan(sql.slice(0, offset), { code() {} });
}
