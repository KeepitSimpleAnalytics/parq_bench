import { useEffect, useRef, useState } from "react";
import type React from "react";
import type * as Monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import type {
  ExtensionStatus,
  PreviewColumn,
  SmartCompletionStatus,
  SqlCompletion,
  WorkspaceQueryResponse,
  WorkspaceSchemaByAlias,
  WorkspaceTableInfo,
} from "../types";
import { friendlyError, sqlIdentifierInsertText } from "../utils";
import { editorContext } from "../sql/editorContext";
import { findTableReferences } from "../sql/aliases";
import { findSchema } from "../sql/reference";

/** Keywords offered by the basic list (used until DuckDB's autocomplete is ready). */
const BASIC_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "GROUP BY",
  "ORDER BY", "LIMIT", "HAVING", "AS", "ON", "UNION ALL", "COUNT", "SUM", "AVG", "MIN", "MAX",
  "DISTINCT", "CASE", "WHEN", "THEN", "ELSE", "END", "WITH", "QUALIFY", "EXCLUDE", "PIVOT",
];

/** `alias.` or `alias.par` at the end of the text before the cursor. */
const QUALIFIER_RE = /([\p{L}_][\p{L}\p{N}_$]*|"(?:[^"]|"")+")\.([\p{L}\p{N}_$]*)$/u;
/** The cursor is in a SELECT list: SELECT appears with no FROM after it yet. */
const IN_SELECT_LIST_RE = /\bSELECT\b(?:(?!\bFROM\b)[\s\S])*$/i;

function unquoteIdentifier(name: string): string {
  return name.startsWith('"') ? name.slice(1, -1).replace(/""/g, '"') : name;
}

function completionKind(monaco: typeof Monaco, kind: string): Monaco.languages.CompletionItemKind {
  const k = monaco.languages.CompletionItemKind;
  switch (kind) {
    case "keyword": return k.Keyword;
    case "table": return k.Class;
    case "column": return k.Field;
    case "scalar_function":
    case "aggregate_function": return k.Function;
    case "table_function": return k.Method;
    case "type": return k.TypeParameter;
    case "schema":
    case "catalog": return k.Module;
    case "file":
    case "directory": return k.File;
    default: return k.Text;
  }
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "scalar_function": return "function";
    case "aggregate_function": return "aggregate";
    case "table_function": return "table function";
    default: return kind.replace(/_/g, " ");
  }
}

/**
 * SQL completion for the workspace editor. Uses DuckDB's autocomplete extension
 * (downloaded on first focus of the editor, then cached) for context-aware keywords,
 * tables, functions and columns, plus our own resolver for aliases written in the
 * query (`FROM orders o` → `o.`). Until the extension is ready, or if it can't be
 * downloaded, the basic list of keywords, tables and columns is used instead.
 */
export function useSqlCompletions(
  workspaceMonacoRef: React.RefObject<typeof Monaco | null>,
  workspaceEditorRef: React.RefObject<Monaco.editor.IStandaloneCodeEditor | null>,
  workspaceEditorReady: boolean,
  workspaceTables: WorkspaceTableInfo[],
  workspaceTableSchemas: WorkspaceSchemaByAlias,
  workspaceQueryResult: WorkspaceQueryResponse | null,
): SmartCompletionStatus {
  const [status, setStatus] = useState<SmartCompletionStatus>({ state: "idle" });
  const statusRef = useRef(status);
  statusRef.current = status;
  /** The autocomplete extension downloaded and loaded (prepare succeeded). */
  const preparedRef = useRef(false);
  const dataRef = useRef({ workspaceTables, workspaceTableSchemas, workspaceQueryResult });
  dataRef.current = { workspaceTables, workspaceTableSchemas, workspaceQueryResult };

  // Keep the completion engine's mirror tables in step with the workspace.
  useEffect(() => {
    const tables = Object.entries(workspaceTableSchemas).map(([alias, columns]) => ({
      alias,
      columns: columns.map((c) => ({ name: c.name, duckdb_type: c.duckdb_type })),
    }));
    // A failed sync only matters once smart completion is in use; the next
    // successful sync (any table change) brings it back.
    invoke("sync_completion_tables", { tables })
      .then(() => { if (preparedRef.current) setStatus({ state: "ready" }); })
      .catch((err) => {
        if (preparedRef.current) setStatus({ state: "unavailable", reason: friendlyError(String(err)) });
      });
  }, [workspaceTableSchemas]);

  // Download/load DuckDB's autocomplete the first time the editor gets focus, never at startup.
  useEffect(() => {
    const editor = workspaceEditorRef.current;
    if (!workspaceEditorReady || !editor) return;
    let started = false;
    const prepare = () => {
      if (started) return;
      started = true;
      subscription.dispose();
      void (async () => {
        try {
          const statuses = await invoke<ExtensionStatus[]>("list_extensions");
          const installed = statuses.find((s) => s.name === "autocomplete")?.installed ?? false;
          if (!installed) setStatus({ state: "downloading" });
          await invoke("prepare_sql_completions");
          preparedRef.current = true;
          setStatus({ state: "ready" });
        } catch (err) {
          setStatus({ state: "unavailable", reason: friendlyError(String(err)) });
        }
      })();
    };
    const subscription = editor.onDidFocusEditorText(prepare);
    // Focus can already be in the editor when this runs (no focus event would follow).
    if (editor.hasTextFocus()) prepare();
    return () => subscription.dispose();
  }, [workspaceEditorReady, workspaceEditorRef]);

  useEffect(() => {
    const monaco = workspaceMonacoRef.current;
    if (!workspaceEditorReady || !monaco) return;

    const columnItem = (
      alias: string,
      column: PreviewColumn,
      range: Monaco.IRange,
      sortText: string,
    ): Monaco.languages.CompletionItem => ({
      label: column.name,
      kind: monaco.languages.CompletionItemKind.Field,
      insertText: sqlIdentifierInsertText(column.name),
      detail: `${alias}.${column.name} (${column.duckdb_type})`,
      sortText,
      range,
    });

    /** Today's list: keywords, tables, all columns, columns of the last result. */
    const basicSuggestions = (range: Monaco.IRange): Monaco.languages.CompletionItem[] => {
      const { workspaceTables: tables, workspaceTableSchemas: schemas, workspaceQueryResult: result } = dataRef.current;
      const items: Monaco.languages.CompletionItem[] = [];
      for (const keyword of BASIC_KEYWORDS) {
        items.push({ label: keyword, kind: monaco.languages.CompletionItemKind.Keyword, insertText: keyword, range });
      }
      for (const table of tables) {
        items.push({
          label: table.alias,
          kind: monaco.languages.CompletionItemKind.Class,
          insertText: sqlIdentifierInsertText(table.alias),
          detail: "Workspace table",
          range,
        });
      }
      const seen = new Set<string>();
      for (const [alias, schema] of Object.entries(schemas)) {
        for (const column of schema) {
          if (seen.has(column.name)) continue;
          seen.add(column.name);
          items.push({ ...columnItem(alias, column, range, column.name), detail: `Column (${column.duckdb_type})` });
        }
      }
      for (const column of result?.schema ?? []) {
        if (seen.has(column.name)) continue;
        seen.add(column.name);
        items.push({ ...columnItem("result", column, range, column.name), detail: "Column from last query result" });
      }
      return items;
    };

    const provider = monaco.languages.registerCompletionItemProvider("sql", {
      triggerCharacters: ["."],
      provideCompletionItems: async (model, position, _context, token) => {
        const word = model.getWordUntilPosition(position);
        const wordRange: Monaco.IRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        const { statementStart, statement, before } = editorContext(model, position);
        const refs = findTableReferences(statement);
        const schemas = dataRef.current.workspaceTableSchemas;

        // alias.column — resolved from this statement's FROM/JOIN, or a table name used directly.
        const qualified = before.match(QUALIFIER_RE);
        if (qualified) {
          const qualifier = unquoteIdentifier(qualified[1]);
          const table = refs.aliases.get(qualifier.toLowerCase()) ?? qualifier;
          const found = findSchema(schemas, table);
          if (found) {
            const partial = qualified[2] ?? "";
            const range: Monaco.IRange = {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: position.column - partial.length,
              endColumn: position.column,
            };
            return { suggestions: found.schema.map((c, i) => columnItem(found.alias, c, range, `0${String(i).padStart(5, "0")}`)) };
          }
        }

        if (statusRef.current.state !== "ready") {
          return { suggestions: basicSuggestions(wordRange) };
        }

        let completions: SqlCompletion[];
        try {
          completions = await invoke<SqlCompletion[]>("sql_completions", { text: before });
        } catch {
          // The engine can be mid-rebuild (tables just changed); the basic list covers this keystroke.
          return { suggestions: basicSuggestions(wordRange) };
        }
        if (token.isCancellationRequested) return { suggestions: [] };

        const items: Monaco.languages.CompletionItem[] = [];
        const labels = new Set<string>();

        // Columns of the tables this statement uses come first in a SELECT list and
        // wherever DuckDB suggests columns (it lists every table's columns otherwise).
        const offersColumns = completions.some((c) => c.kind === "column") || IN_SELECT_LIST_RE.test(before);
        if (offersColumns) {
          let rank = 0;
          for (const table of refs.tables) {
            const found = findSchema(schemas, table);
            if (!found) continue;
            for (const column of found.schema) {
              if (labels.has(column.name)) continue;
              labels.add(column.name);
              items.push(columnItem(found.alias, column, wordRange, `0${String(rank++).padStart(5, "0")}`));
            }
          }
        }

        completions.forEach((c, index) => {
          const label = c.text.trimEnd();
          if (labels.has(label)) return;
          labels.add(label);
          const startPos = model.getPositionAt(statementStart + c.start);
          const range: Monaco.IRange = startPos.lineNumber === position.lineNumber && startPos.column <= position.column
            ? { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: startPos.column, endColumn: position.column }
            : wordRange;
          items.push({
            label,
            kind: completionKind(monaco, c.kind),
            insertText: c.text,
            detail: kindLabel(c.kind),
            filterText: label,
            sortText: `1${String(index).padStart(5, "0")}`,
            range,
          });
        });
        return { suggestions: items };
      },
    });

    return () => provider.dispose();
  }, [workspaceEditorReady, workspaceMonacoRef]);

  return status;
}
