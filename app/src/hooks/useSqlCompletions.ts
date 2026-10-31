import { useEffect } from "react";
import type React from "react";
import type * as Monaco from "monaco-editor";
import type { PreviewColumn, WorkspaceQueryResponse, WorkspaceSchemaByAlias, WorkspaceTableInfo } from "../types";
import { sqlIdentifierInsertText } from "../utils";

/** Registers Monaco SQL completions for workspace tables, their columns and the last result's columns. */
export function useSqlCompletions(
  workspaceMonacoRef: React.RefObject<typeof Monaco | null>,
  workspaceEditorReady: boolean,
  workspaceTables: WorkspaceTableInfo[],
  workspaceTableSchemas: WorkspaceSchemaByAlias,
  workspaceQueryResult: WorkspaceQueryResponse | null,
) {
  useEffect(() => {
    const monaco = workspaceMonacoRef.current;
    if (!workspaceEditorReady || !monaco) {
      return;
    }

    const sqlKeywords = [
      "SELECT",
      "FROM",
      "WHERE",
      "JOIN",
      "LEFT JOIN",
      "RIGHT JOIN",
      "INNER JOIN",
      "GROUP BY",
      "ORDER BY",
      "LIMIT",
      "HAVING",
      "AS",
      "ON",
      "UNION ALL",
      "COUNT",
      "SUM",
      "AVG",
      "MIN",
      "MAX",
      "DISTINCT",
    ];
    const tableAliases = workspaceTables.map((table) => table.alias);
    const aliasSchemaMap = new Map<string, { alias: string; schema: PreviewColumn[] }>();
    const workspaceColumnMap = new Map<string, { aliases: Set<string>; types: Set<string> }>();
    const qualifiedColumns: Array<{ alias: string; column: PreviewColumn }> = [];
    Object.entries(workspaceTableSchemas).forEach(([alias, schema]) => {
      aliasSchemaMap.set(alias.toLowerCase(), { alias, schema });
      schema.forEach((column) => {
        qualifiedColumns.push({ alias, column });
        const existing = workspaceColumnMap.get(column.name) ?? {
          aliases: new Set<string>(),
          types: new Set<string>(),
        };
        existing.aliases.add(alias);
        existing.types.add(column.duckdb_type);
        workspaceColumnMap.set(column.name, existing);
      });
    });
    const queryColumns = (workspaceQueryResult?.schema ?? []).map((column) => column.name);

    const provider = monaco.languages.registerCompletionItemProvider("sql", {
      triggerCharacters: ["."],
      provideCompletionItems: (model, position) => {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        const linePrefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
        const aliasDotMatch = linePrefix.match(/([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z0-9_]*)$/);

        if (aliasDotMatch) {
          const aliasToken = aliasDotMatch[1];
          const partialColumn = aliasDotMatch[2] ?? "";
          const aliasEntry = aliasSchemaMap.get(aliasToken.toLowerCase());
          if (aliasEntry) {
            const columnRange = {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: position.column - partialColumn.length,
              endColumn: position.column,
            };
            return {
              suggestions: aliasEntry.schema.map((column) => ({
                label: column.name,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: sqlIdentifierInsertText(column.name),
                detail: `${aliasEntry.alias}.${column.name} (${column.duckdb_type})`,
                range: columnRange,
              })),
            };
          }
        }

        const keywordSuggestions = sqlKeywords.map((keyword) => ({
          label: keyword,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: keyword,
          range,
        }));
        const tableSuggestions = tableAliases.map((alias) => ({
          label: alias,
          kind: monaco.languages.CompletionItemKind.Class,
          insertText: alias,
          detail: "Workspace table alias",
          range,
        }));
        const workspaceColumnSuggestions = Array.from(workspaceColumnMap.entries()).map(
          ([columnName, info]) => ({
            label: columnName,
            kind: monaco.languages.CompletionItemKind.Field,
            insertText: sqlIdentifierInsertText(columnName),
            detail: `Workspace column (${Array.from(info.aliases).join(", ")})`,
            documentation: `Types: ${Array.from(info.types).join(" | ")}`,
            range,
          }),
        );
        const qualifiedColumnSuggestions = qualifiedColumns.map(({ alias, column }) => ({
          label: `${alias}.${column.name}`,
          kind: monaco.languages.CompletionItemKind.Field,
          insertText: `${sqlIdentifierInsertText(alias)}.${sqlIdentifierInsertText(column.name)}`,
          detail: `Qualified workspace column (${column.duckdb_type})`,
          range,
        }));
        const columnSuggestions = queryColumns.map((column) => ({
          label: column,
          kind: monaco.languages.CompletionItemKind.Field,
          insertText: sqlIdentifierInsertText(column),
          detail: "Column from last query result",
          range,
        }));

        return {
          suggestions: [
            ...keywordSuggestions,
            ...tableSuggestions,
            ...workspaceColumnSuggestions,
            ...qualifiedColumnSuggestions,
            ...columnSuggestions,
          ],
        };
      },
    });

    return () => {
      provider.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceEditorReady, workspaceQueryResult, workspaceTableSchemas, workspaceTables]);
}
