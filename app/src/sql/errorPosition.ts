/**
 * Finds where in the user's SQL a DuckDB error points.
 *
 * DuckDB ends many errors with the offending source line and a caret run under the
 * bad token:
 *
 *     LINE 2:   bogus
 *               ^^^^^
 *
 * The line it shows is from the SQL DuckDB actually ran, which may be the user's
 * statement wrapped by the backend (`DESCRIBE SELECT * FROM (<sql>\n) AS _q`, ...).
 * Wrappers only ever add text before the statement on its first line and after it on
 * a new line, so line N of the statement is line N of what ran, with only line 1
 * possibly carrying a prefix. The caret is located by matching the shown text from
 * the caret onward against the user's own line; when that doesn't match (the caret
 * points into a wrapper, or the line can't be lined up) there is no position, never
 * a wrong one.
 */

/** A span within one statement's text, in UTF-16 code units (JavaScript string offsets). */
export interface ErrorSpan {
  offset: number;
  length: number;
}

const LINE_RE = /\nLINE (\d+): ([^\n]*)\n( *)(\^+)[ \t]*$/;
const ELLIPSIS = "...";

/** East Asian Wide / Fullwidth and emoji-presentation ranges (Unicode 15), as [first, last]. */
const WIDE_RANGES: [number, number][] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0],
  [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f],
  [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5],
  [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728],
  [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x18cff], [0x1b000, 0x1b2ff], [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f2ff], [0x1f300, 0x1f320],
  [0x1f32d, 0x1f335], [0x1f337, 0x1f37c], [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca], [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0], [0x1f3f4, 0x1f3f4], [0x1f3f8, 0x1f43e], [0x1f440, 0x1f440], [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d], [0x1f54b, 0x1f54e], [0x1f550, 0x1f567], [0x1f57a, 0x1f57a], [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4], [0x1f5fb, 0x1f64f], [0x1f680, 0x1f6c5], [0x1f6cc, 0x1f6cc], [0x1f6d0, 0x1f6d2],
  [0x1f6d5, 0x1f6d7], [0x1f6dc, 0x1f6df], [0x1f6eb, 0x1f6ec], [0x1f6f4, 0x1f6fc], [0x1f7e0, 0x1f7eb],
  [0x1f7f0, 0x1f7f0], [0x1f90c, 0x1f93a], [0x1f93c, 0x1f945], [0x1f947, 0x1f9ff], [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
];

/** Display columns of one code point: 0 for control characters and combining marks, 2 for wide ones. */
export function displayWidth(codePoint: number): number {
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (
    (codePoint >= 0x200b && codePoint <= 0x200f) || // zero-width space/joiners, marks
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || // variation selectors
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef) ||
    /\p{Mn}|\p{Me}/u.test(String.fromCodePoint(codePoint))
  ) {
    return 0;
  }
  for (const [first, last] of WIDE_RANGES) {
    if (codePoint < first) break;
    if (codePoint <= last) return 2;
  }
  return 1;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The text as DuckDB lays out its caret line: one cell group per grapheme, as wide
 * as the grapheme's first code point (so a ZWJ emoji family is 2, a flag pair 1).
 */
function graphemes(text: string): { index: number; length: number; width: number }[] {
  return [...segmenter.segment(text)].map((g) => ({
    index: g.index,
    length: g.segment.length,
    width: displayWidth(g.segment.codePointAt(0)!),
  }));
}

/**
 * UTF-16 index in `text` of the first visible grapheme that starts at display
 * column `column`, or null when none starts exactly there.
 */
function indexAtColumn(text: string, column: number): number | null {
  let width = 0;
  for (const g of graphemes(text)) {
    if (width === column && g.width > 0) return g.index;
    if (width > column) return null;
    width += g.width;
  }
  return null;
}

/** UTF-16 length of the start of `text` that covers `columns` display columns. */
function lengthForColumns(text: string, columns: number): number {
  let width = 0;
  let end = 0;
  for (const g of graphemes(text)) {
    if (width >= columns) break;
    width += g.width;
    end = g.index + g.length;
  }
  return end;
}

const IDENT_CHAR_RE = /[\p{L}\p{N}_$]/u;

/** The name an error is about, when it quotes one: `column "x"`, `at or near "x"`, `Table with name x`. */
function namedToken(message: string): string | null {
  const m = message.match(/(?:column|at or near|function|Table with name|Catalog \w+ with name)\s+"((?:[^"]|"")+)"/i)
    ?? message.match(/Table with name ([^\s"]+) does not exist/i);
  return m ? m[1].replace(/""/g, '"') : null;
}

function allIndexesOf(haystack: string, needle: string): number[] {
  const found: number[] = [];
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    found.push(at);
    at = haystack.indexOf(needle, at + 1);
  }
  return found;
}

/**
 * Where `message` (a DuckDB error, possibly with our own "prepare …:" prefixes) points
 * in `statement`, the exact text that was sent for that statement. Null when the
 * error carries no position or it can't be matched to the statement.
 */
export function locateDuckDbError(message: string, statement: string): ErrorSpan | null {
  // Errors about registering a workspace table point into SQL the app generated.
  if (/^register workspace table /i.test(message.trimStart())) return null;
  const match = message.replace(/\r\n?$/, "").match(LINE_RE);
  if (!match) return null;
  const lineNumber = Number(match[1]);
  let snippet = match[2];
  let caretColumn = match[3].length - `LINE ${match[1]}: `.length;
  const caretWidth = match[4].length;
  if (caretColumn < 0) return null;

  const cutBefore = snippet.startsWith(ELLIPSIS);
  if (cutBefore) {
    snippet = snippet.slice(ELLIPSIS.length);
    caretColumn -= ELLIPSIS.length;
  }
  const cutAfter = snippet.endsWith(ELLIPSIS);
  if (cutAfter) snippet = snippet.slice(0, -ELLIPSIS.length);

  const caretIndex = indexAtColumn(snippet, caretColumn);
  if (caretIndex === null) return null;
  const tail = snippet.slice(caretIndex);
  if (tail.length === 0) return null;

  // The backend trims the statement before running it, so lines count from its first code.
  const lead = statement.length - statement.trimStart().length;
  const lines = statement.slice(lead).split("\n");
  if (lines[lineNumber - 1] === undefined) return null;
  // DuckDB doesn't show a CRLF line's trailing \r.
  const line = lines[lineNumber - 1].replace(/\r$/, "");

  let column: number | null = null;
  if (!cutAfter) {
    // The shown text runs to the end of the line, so the caret is that far from its end.
    if (line.endsWith(tail)) column = line.length - tail.length;
  } else {
    const hits = allIndexesOf(line, tail);
    if (hits.length === 1) {
      column = hits[0];
    } else if (hits.length > 1 && !cutBefore && lineNumber > 1 && line.startsWith(snippet)) {
      // Lines after the first are shown as-is, so the snippet starts where the line does.
      column = caretIndex;
    }
  }
  if (column === null) return null;

  let lineStart = lead;
  for (let i = 0; i < lineNumber - 1; i += 1) lineStart += lines[i].length + 1;
  // DuckDB's caret marks the start of a token, never the middle of a name.
  if (column > 0 && IDENT_CHAR_RE.test(line[column - 1]) && IDENT_CHAR_RE.test(line[column])) return null;
  const length = Math.max(1, Math.min(lengthForColumns(tail, caretWidth), line.length - column));
  // When the error names the token, the underline must start with it (catches a caret
  // lined up with the wrong characters, e.g. from a width DuckDB counts differently).
  const named = namedToken(message);
  if (named) {
    const at = line.slice(column).toLowerCase();
    const lower = named.toLowerCase();
    const quoted = `"${named.replace(/"/g, '""')}"`.toLowerCase();
    if (line.toLowerCase().includes(lower) && !at.startsWith(lower) && !at.startsWith(quoted)) return null;
  }
  return { offset: lineStart + column, length };
}

/**
 * Which of the statements sent in one run failed: the backend prefixes errors from the
 * setup statements with "statement i of n:"; anything else came from the last one.
 */
export function failedStatementIndex(message: string, statementCount: number): number {
  const match = message.trimStart().match(/^statement (\d+) of (\d+):/);
  if (match) {
    const index = Number(match[1]) - 1;
    if (index >= 0 && index < statementCount) return index;
  }
  return statementCount - 1;
}
