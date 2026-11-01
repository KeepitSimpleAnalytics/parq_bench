import { useEffect, useRef } from "react";
import type React from "react";
import type * as Monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import type { FunctionDoc, WorkspaceSchemaByAlias, WorkspaceTableInfo } from "../types";
import { findTableReferences } from "../sql/aliases";
import { callFrames, isCodeAt } from "../sql/calls";
import { editorContext } from "../sql/editorContext";
import {
  activeParam, buildFunctionIndex, columnHoverMarkdown, findSchema, formatSignature,
  functionHoverMarkdown, functionSummary, pickSignature, tableHoverMarkdown,
  type ColumnMatch, type FunctionIndex,
} from "../sql/reference";

/** `alias.` (or `"quoted alias".`) right before a word. */
const QUALIFIER_BEFORE_RE = /([\p{L}_][\p{L}\p{N}_$]*|"(?:[^"]|"")+")\s*\.\s*$/u;

function unquote(name: string): string {
  return name.startsWith('"') ? name.slice(1, -1).replace(/""/g, '"') : name;
}

/**
 * Hover cards (functions, workspace tables, aliases, columns) and signature help
 * (parameters of the function call around the cursor) for the workspace editor.
 * DuckDB's function reference loads on first focus of the editor, never at startup.
 */
export function useSqlReference(
  workspaceMonacoRef: React.RefObject<typeof Monaco | null>,
  workspaceEditorRef: React.RefObject<Monaco.editor.IStandaloneCodeEditor | null>,
  workspaceEditorReady: boolean,
  workspaceTables: WorkspaceTableInfo[],
  workspaceTableSchemas: WorkspaceSchemaByAlias,
): void {
  const functionsRef = useRef<FunctionIndex>(new Map());
  const dataRef = useRef({ workspaceTables, workspaceTableSchemas });
  dataRef.current = { workspaceTables, workspaceTableSchemas };

  // Load the function reference the first time the editor gets focus. On failure,
  // hover still covers tables and columns and the next focus tries again.
  useEffect(() => {
    const editor = workspaceEditorRef.current;
    if (!workspaceEditorReady || !editor) return;
    let loading = false;
    let loaded = false;
    const load = () => {
      if (loading || loaded) return;
      loading = true;
      invoke<FunctionDoc[]>("sql_function_docs")
        .then((docs) => {
          functionsRef.current = buildFunctionIndex(docs);
          loaded = true;
          subscription.dispose();
        })
        .catch((err) => console.warn("SQL function reference unavailable:", err))
        .finally(() => { loading = false; });
    };
    const subscription = editor.onDidFocusEditorText(load);
    if (editor.hasTextFocus()) load();
    return () => subscription.dispose();
  }, [workspaceEditorReady, workspaceEditorRef]);

  useEffect(() => {
    const monaco = workspaceMonacoRef.current;
    if (!workspaceEditorReady || !monaco) return;

    const hover = monaco.languages.registerHoverProvider("sql", {
      provideHover: (model, position) => {
        const word = model.getWordAtPosition(position);
        if (!word) return null;
        const { statementStart, statement } = editorContext(model, position);
        const wordStart = model.getOffsetAt({ lineNumber: position.lineNumber, column: word.startColumn }) - statementStart;
        if (statement.length === 0 || wordStart < 0 || !isCodeAt(statement, wordStart)) return null;
        const wordEnd = wordStart + word.word.length;
        const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
        const card = (value: string): Monaco.languages.Hover => ({ range, contents: [{ value }] });

        const name = word.word;
        const lower = name.toLowerCase();
        const { workspaceTables: tables, workspaceTableSchemas: schemas } = dataRef.current;
        const functions = functionsRef.current.get(lower);
        const calledAsFunction = /^\s*\(/.test(statement.slice(wordEnd));
        if (calledAsFunction) return functions ? card(functionHoverMarkdown(functions)) : null;

        const refs = findTableReferences(statement);

        // alias.column / table.column
        const qualifier = statement.slice(0, wordStart).match(QUALIFIER_BEFORE_RE);
        if (qualifier) {
          const q = unquote(qualifier[1]);
          const found = findSchema(schemas, refs.aliases.get(q.toLowerCase()) ?? q);
          const column = found?.schema.find((c) => c.name.toLowerCase() === lower);
          return found && column ? card(columnHoverMarkdown(column.name, [{ table: found.alias, column }])) : null;
        }

        // A table name, or an alias this statement gives one.
        const tableName = tables.some((t) => t.alias.toLowerCase() === lower) ? name : refs.aliases.get(lower);
        const table = tableName ? tables.find((t) => t.alias.toLowerCase() === tableName.toLowerCase()) : undefined;
        if (table) return card(tableHoverMarkdown(table, findSchema(schemas, table.alias)?.schema, name));

        // A column: from the tables this statement uses, else from any workspace table.
        const columnsIn = (tableNames: string[]): ColumnMatch[] => tableNames.flatMap((t) => {
          const found = findSchema(schemas, t);
          const column = found?.schema.find((c) => c.name.toLowerCase() === lower);
          return found && column ? [{ table: found.alias, column }] : [];
        });
        let matches = columnsIn(refs.tables);
        if (matches.length === 0) matches = columnsIn(Object.keys(schemas));
        if (matches.length > 0) return card(columnHoverMarkdown(matches[0].column.name, matches));

        // Functions that can be written without parentheses, e.g. current_date.
        return functions ? card(functionHoverMarkdown(functions)) : null;
      },
    });

    const signatureHelp = monaco.languages.registerSignatureHelpProvider("sql", {
      signatureHelpTriggerCharacters: ["(", ","],
      signatureHelpRetriggerCharacters: [","],
      provideSignatureHelp: (model, position) => {
        const { before } = editorContext(model, position);
        // Innermost named call; grouping parens like `((a + b)` sit inside it.
        // A paren after a keyword (`IN (`, `OVER (`) isn't a call, so it ends the search.
        const frame = callFrames(before).find((f) => f.name !== null);
        const docs = frame?.name ? functionsRef.current.get(frame.name.toLowerCase()) : undefined;
        if (!frame || !docs) return null;
        const argIndex = frame.argIndex;
        const all = docs.flatMap((doc) => doc.signatures.map((sig) => ({ doc, sig })));
        const signatures: Monaco.languages.SignatureInformation[] = all.map(({ doc, sig }) => {
          const formatted = formatSignature(doc.name, sig);
          return {
            label: formatted.label,
            documentation: functionSummary(doc),
            parameters: formatted.params.map((p) => ({ label: p })),
          };
        });
        const active = pickSignature(all.map((a) => a.sig), argIndex);
        return {
          value: {
            signatures,
            activeSignature: active,
            activeParameter: activeParam(all[active].sig, argIndex),
          },
          dispose: () => {},
        };
      },
    });

    return () => {
      hover.dispose();
      signatureHelp.dispose();
    };
  }, [workspaceEditorReady, workspaceMonacoRef]);
}
