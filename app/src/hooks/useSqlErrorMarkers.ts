import { useCallback, useEffect, useRef } from "react";
import type React from "react";
import type * as Monaco from "monaco-editor";
import type { RunPlan } from "../sql/statements";
import { failedStatementIndex, locateDuckDbError } from "../sql/errorPosition";

const MARKER_OWNER = "duckdb";

export interface SqlErrorMarkers {
  /** The editor's version now; pass it back to `markError` so stale positions are skipped. */
  versionNow(): number | null;
  /**
   * Underlines where DuckDB's error `raw` points, in the statement of `plan` that failed,
   * with `message` on hover. Does nothing if the error has no position or the editor
   * changed since `version`.
   */
  markError(plan: RunPlan, raw: string, message: string, version: number | null): void;
  clearError(): void;
}

/** Red squiggles under the SQL a query error points at, cleared on the next run or an edit there. */
export function useSqlErrorMarkers(
  workspaceMonacoRef: React.RefObject<typeof Monaco | null>,
  workspaceEditorRef: React.RefObject<Monaco.editor.IStandaloneCodeEditor | null>,
  workspaceEditorReady: boolean,
): SqlErrorMarkers {
  /** Tracks the marked range as the text around it is edited. */
  const trackedRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  /** The text that was underlined. */
  const markedTextRef = useRef("");

  const clearError = useCallback(() => {
    const model = workspaceEditorRef.current?.getModel();
    const monaco = workspaceMonacoRef.current;
    if (model && monaco) monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
    trackedRef.current?.clear();
    trackedRef.current = null;
  }, [workspaceEditorRef, workspaceMonacoRef]);

  const versionNow = useCallback(
    () => workspaceEditorRef.current?.getModel()?.getVersionId() ?? null,
    [workspaceEditorRef],
  );

  const markError = useCallback((plan: RunPlan, raw: string, message: string, version: number | null) => {
    clearError();
    const editor = workspaceEditorRef.current;
    const model = editor?.getModel();
    const monaco = workspaceMonacoRef.current;
    if (!editor || !model || !monaco || version === null || model.getVersionId() !== version) return;
    const texts = [...plan.setup, plan.sql];
    const index = failedStatementIndex(raw, texts.length);
    const span = locateDuckDbError(raw, texts[index]);
    const statementStart = plan.starts[index];
    if (!span || statementStart === undefined) return;
    const from = model.getPositionAt(statementStart + span.offset);
    const to = model.getPositionAt(statementStart + span.offset + span.length);
    const range = new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column);
    monaco.editor.setModelMarkers(model, MARKER_OWNER, [{
      severity: monaco.MarkerSeverity.Error,
      message,
      source: "DuckDB",
      ...range,
    }]);
    markedTextRef.current = model.getValueInRange(range);
    trackedRef.current = editor.createDecorationsCollection([{
      range,
      options: { stickiness: monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges },
    }]);
  }, [clearError, workspaceEditorRef, workspaceMonacoRef]);

  // Changing the underlined text (typing in it or at its edges) clears the underline;
  // edits elsewhere keep it, and it moves with the text around it.
  useEffect(() => {
    const editor = workspaceEditorRef.current;
    if (!workspaceEditorReady || !editor) return;
    const subscription = editor.onDidChangeModelContent(() => {
      const tracked = trackedRef.current;
      if (!tracked) return;
      const range = tracked.getRange(0);
      const model = editor.getModel();
      if (!range || !model || model.getValueInRange(range) !== markedTextRef.current) clearError();
    });
    return () => subscription.dispose();
  }, [workspaceEditorReady, workspaceEditorRef, clearError]);

  return { versionNow, markError, clearError };
}
