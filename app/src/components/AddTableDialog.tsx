import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { SourcePeekResponse, WorkspaceSourceKind } from "../types";
import { PARQUET_EXTENSIONS, DELIMITED_EXTENSIONS, WORKSPACE_FOLDER_FILE_TYPES } from "../constants";
import {
  appendGlobPattern,
  describeDelimiter,
  detectSourceKind,
  friendlyError,
  isNumericDuckType,
  isValidAlias,
  suggestAlias,
} from "../utils";
import { Modal } from "./Modal";
import { Icon } from "./Icon";

type SourceMode = "file" | "folder";
type DelimiterChoice = "auto" | "," | "\t" | "|" | ";" | "custom";

const DELIMITER_OPTIONS: Array<{ value: Exclude<DelimiterChoice, "auto">; label: string }> = [
  { value: ",", label: "Comma ( , )" },
  { value: "\t", label: "Tab" },
  { value: "|", label: "Pipe ( | )" },
  { value: ";", label: "Semicolon ( ; )" },
  { value: "custom", label: "Other…" },
];

export interface AddTableDialogProps {
  open: boolean;
  onClose: () => void;
  existingAliases: string[];
  busy: boolean;
  onAdd: (alias: string, filePath: string, isGlob: boolean, sourceKind: WorkspaceSourceKind, delimiter?: string) => Promise<boolean>;
}

/** Replaces the trailing "*.ext" of a folder pattern (or appends one). */
function withFolderExt(path: string, ext: string): string {
  const trimmed = path.trim();
  if (!trimmed) return trimmed;
  const withoutPattern = trimmed.replace(/[/\\]?\*\.[A-Za-z0-9]+$/, "");
  return appendGlobPattern(withoutPattern, `*.${ext}`);
}

export function AddTableDialog({ open: isOpen, onClose, existingAliases, busy, onAdd }: AddTableDialogProps) {
  const [mode, setMode] = useState<SourceMode>("file");
  const [path, setPath] = useState("");
  const [folderExt, setFolderExt] = useState("parquet");
  const [delimiterChoice, setDelimiterChoice] = useState<DelimiterChoice>("auto");
  const [customDelimiter, setCustomDelimiter] = useState("");
  const [alias, setAlias] = useState("");
  const [aliasEdited, setAliasEdited] = useState(false);
  const [peek, setPeek] = useState<SourcePeekResponse | null>(null);
  const [peekError, setPeekError] = useState<string | null>(null);
  const [peekLoading, setPeekLoading] = useState(false);
  const peekSeq = useRef(0);

  // Reset the form each time the dialog opens.
  useEffect(() => {
    if (!isOpen) return;
    setMode("file");
    setPath("");
    setFolderExt("parquet");
    setDelimiterChoice("auto");
    setCustomDelimiter("");
    setAlias("");
    setAliasEdited(false);
    setPeek(null);
    setPeekError(null);
  }, [isOpen]);

  const trimmedPath = path.trim();
  const sourceKind = detectSourceKind(trimmedPath);
  const isGlob = mode === "folder";
  const delimiter =
    sourceKind !== "delimited" || delimiterChoice === "auto"
      ? undefined
      : delimiterChoice === "custom"
        ? customDelimiter || undefined
        : delimiterChoice;

  // Keep the alias in sync with the path until the user edits it.
  useEffect(() => {
    if (aliasEdited) return;
    setAlias(trimmedPath ? suggestAlias(trimmedPath, existingAliases) : "");
  }, [trimmedPath, aliasEdited, existingAliases]);

  // Peek at the source (debounced) whenever what would be mounted changes.
  useEffect(() => {
    if (!isOpen || !trimmedPath || (delimiterChoice === "custom" && !customDelimiter)) {
      peekSeq.current += 1; // invalidate any in-flight peek
      setPeek(null);
      setPeekError(null);
      setPeekLoading(false);
      return;
    }
    const seq = ++peekSeq.current;
    setPeekLoading(true);
    const timer = window.setTimeout(() => {
      invoke<SourcePeekResponse>("peek_workspace_source", {
        filePath: trimmedPath,
        isGlob,
        sourceKind,
        delimiter,
      })
        .then((result) => {
          if (seq !== peekSeq.current) return;
          setPeek(result);
          setPeekError(null);
        })
        .catch((err) => {
          if (seq !== peekSeq.current) return;
          setPeek(null);
          setPeekError(friendlyError(String(err)));
        })
        .finally(() => {
          if (seq === peekSeq.current) setPeekLoading(false);
        });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [isOpen, trimmedPath, isGlob, sourceKind, delimiter, delimiterChoice, customDelimiter]);

  async function browse() {
    if (mode === "folder") {
      const selected = await open({ title: "Select folder", directory: true, multiple: false });
      if (selected && !Array.isArray(selected)) setPath(appendGlobPattern(selected, `*.${folderExt}`));
      return;
    }
    const selected = await open({
      title: "Select file",
      multiple: false,
      filters: [
        { name: "Supported files", extensions: [...PARQUET_EXTENSIONS, ...DELIMITED_EXTENSIONS] },
        { name: "Parquet", extensions: PARQUET_EXTENSIONS },
        { name: "Delimited text", extensions: DELIMITED_EXTENSIONS },
      ],
    });
    if (selected && !Array.isArray(selected)) setPath(selected);
  }

  function switchMode(next: SourceMode) {
    if (next === mode) return;
    setMode(next);
    setPath("");
  }

  const aliasTrimmed = alias.trim();
  const aliasInvalid = aliasTrimmed.length > 0 && !isValidAlias(aliasTrimmed);
  const aliasReplaces = existingAliases.some((a) => a.toLowerCase() === aliasTrimmed.toLowerCase());
  const canAdd = !busy && !peekLoading && !peekError && peek !== null && aliasTrimmed.length > 0 && !aliasInvalid;

  async function submit() {
    if (!canAdd) return;
    const ok = await onAdd(aliasTrimmed, trimmedPath, isGlob, sourceKind, delimiter);
    if (ok) onClose();
  }

  const detectedDelimiter = peek?.detected_delimiter ?? null;
  const formatLine =
    peek === null
      ? null
      : peek.source_kind === "parquet"
        ? "Parquet"
        : detectedDelimiter
          ? `Delimited text · ${describeDelimiter(detectedDelimiter)} ( ${detectedDelimiter === "\t" ? "\\t" : detectedDelimiter} )`
          : "Delimited text";
  const detailParts: string[] = [];
  if (peek) {
    if (peek.has_header !== null) detailParts.push(peek.has_header ? "Header row found" : "No header row");
    if (peek.row_count !== null) detailParts.push(`${peek.row_count.toLocaleString()} rows`);
    detailParts.push(`${peek.schema.length} columns`);
  }

  return (
    <Modal
      open={isOpen}
      title="Add table"
      onClose={onClose}
      width={760}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!canAdd} onClick={() => void submit()}>
            {busy ? "Adding…" : "Add table"}
          </button>
        </>
      }
    >
      <div className="form-stack">
        <div role="group" aria-label="Source" className="segmented">
          <button type="button" aria-pressed={mode === "file"} className={mode === "file" ? "segmented-item is-active" : "segmented-item"} onClick={() => switchMode("file")}>
            Single file
          </button>
          <button type="button" aria-pressed={mode === "folder"} className={mode === "folder" ? "segmented-item is-active" : "segmented-item"} onClick={() => switchMode("folder")}>
            Folder of files
          </button>
        </div>

        <div className="field">
          <label htmlFor="add-path" className="field-label">{mode === "folder" ? "Folder" : "File"}</label>
          <div className="field-row">
            <input id="add-path" type="text" className="input input-mono grow" value={path}
              placeholder={mode === "folder" ? "C:\\data\\exports\\*.csv" : "C:\\data\\sales.parquet"}
              onChange={(e) => setPath(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
            <button type="button" className="btn btn-outline" onClick={() => void browse()}>Browse…</button>
          </div>
        </div>

        {mode === "folder" ? (
          <div className="field-row align-end">
            <div className="field">
              <label htmlFor="add-folder-ext" className="field-label">File type</label>
              <select id="add-folder-ext" className="input" value={folderExt}
                onChange={(e) => { const ext = e.currentTarget.value; setFolderExt(ext); setPath((p) => withFolderExt(p, ext)); }}>
                {WORKSPACE_FOLDER_FILE_TYPES.map((t) => <option key={t.ext} value={t.ext}>{t.label}</option>)}
              </select>
            </div>
            {peek?.matched_files != null ? (
              <span className="match-count"><Icon name="check" size={14} /> {peek.matched_files.toLocaleString()} {peek.matched_files === 1 ? "file matches" : "files match"}</span>
            ) : null}
          </div>
        ) : null}

        {trimmedPath ? (
          <div className="detect-box" aria-live="polite">
            <div className="detect-text">
              <span className="field-label">Detected format</span>
              {peekLoading ? <span className="muted">Reading file…</span> : null}
              {!peekLoading && formatLine ? <strong>{formatLine}</strong> : null}
              {!peekLoading && detailParts.length > 0 ? <span className="muted small">{detailParts.join(" · ")}</span> : null}
              {!peekLoading && peekError ? <span className="text-danger">{peekError}</span> : null}
            </div>
            {sourceKind === "delimited" ? (
              <div className="field">
                <label htmlFor="add-delim" className="field-label">Delimiter</label>
                <select id="add-delim" className="input" value={delimiterChoice}
                  onChange={(e) => setDelimiterChoice(e.currentTarget.value as DelimiterChoice)}>
                  <option value="auto">
                    Auto-detect{delimiterChoice === "auto" && detectedDelimiter ? ` (found ${describeDelimiter(detectedDelimiter)})` : ""}
                  </option>
                  {DELIMITER_OPTIONS.map((o) => <option key={o.label} value={o.value}>{o.label}</option>)}
                </select>
                {delimiterChoice === "custom" ? (
                  <input type="text" className="input input-mono" aria-label="Custom delimiter" maxLength={2} placeholder="e.g. ~ or \t"
                    value={customDelimiter} onChange={(e) => setCustomDelimiter(e.currentTarget.value)} />
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="add-alias" className="field-label">Table name</label>
          <input id="add-alias" type="text" className="input input-mono alias-input" value={alias}
            onChange={(e) => { setAlias(e.currentTarget.value); setAliasEdited(true); }} />
          {aliasInvalid ? (
            <span className="text-danger small">Use letters, numbers and underscores, starting with a letter or underscore.</span>
          ) : aliasReplaces ? (
            <span className="text-warning small">A table named {aliasTrimmed} already exists and will be replaced.</span>
          ) : aliasTrimmed ? (
            <span className="muted small">Filled in from the file name. Use it in SQL: SELECT * FROM {aliasTrimmed}</span>
          ) : null}
        </div>

        {peek && peek.rows.length > 0 ? (
          <div className="field">
            <span className="field-label">First {peek.rows.length} rows{isGlob ? " (across matching files)" : ""}</span>
            <div className="table-box">
              <table className="data-table compact">
                <thead>
                  <tr>{peek.schema.map((c) => (
                    <th key={c.name} scope="col" className={isNumericDuckType(c.duckdb_type) ? "num" : undefined}>
                      <span className="th-name">{c.name}</span><span className="th-type">{c.duckdb_type}</span>
                    </th>
                  ))}</tr>
                </thead>
                <tbody>
                  {peek.rows.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((v, ci) => (
                        <td key={ci} className={isNumericDuckType(peek.schema[ci]?.duckdb_type ?? "") ? "num" : undefined}>
                          {v === null ? <span className="null-cell">NULL</span> : v}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
