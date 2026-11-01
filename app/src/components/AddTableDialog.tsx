import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ExtensionStatus, RegisterTableRequest, SourcePeekResponse, SqliteObject, WorkspaceSourceKind } from "../types";
import {
  PARQUET_EXTENSIONS,
  DELIMITED_EXTENSIONS,
  EXCEL_EXTENSIONS,
  SQLITE_EXTENSIONS,
  WORKSPACE_EXTENSIONS,
  WORKSPACE_FOLDER_FILE_TYPES,
  DELTA_FOLDER_TYPE,
} from "../constants";
import {
  appendGlobPattern,
  describeDelimiter,
  detectSourceKind,
  extensionLabel,
  friendlyError,
  isNumericDuckType,
  isRemotePath,
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
  /** Pre-fills the path when the dialog opens (e.g. a dropped SQLite file that needs a table choice). */
  initialPath?: string;
  onAdd: (request: RegisterTableRequest) => Promise<boolean>;
}

/** Replaces the trailing "*.ext" of a folder pattern (or appends one). Delta tables take the bare folder. */
function withFolderExt(path: string, ext: string): string {
  const trimmed = path.trim();
  if (!trimmed) return trimmed;
  const withoutPattern = trimmed.replace(/[/\\]?\*\.[A-Za-z0-9]+$/, "");
  return ext === DELTA_FOLDER_TYPE ? withoutPattern : appendGlobPattern(withoutPattern, `*.${ext}`);
}

/** DuckDB extension a source needs (downloaded on first use), or null. */
function requiredExtension(kind: WorkspaceSourceKind, remote: boolean): string | null {
  if (kind === "excel") return "excel";
  if (kind === "sqlite") return "sqlite_scanner";
  if (kind === "delta") return "delta";
  return remote ? "httpfs" : null;
}

export function AddTableDialog({ open: isOpen, onClose, existingAliases, busy, initialPath, onAdd }: AddTableDialogProps) {
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
  // Excel sheets / SQLite tables of the chosen file.
  const [objects, setObjects] = useState<SqliteObject[] | null>(null);
  const [objectsError, setObjectsError] = useState<string | null>(null);
  const [objectName, setObjectName] = useState("");
  const [header, setHeader] = useState(true);
  const objectsSeq = useRef(0);
  const [extensions, setExtensions] = useState<ExtensionStatus[] | null>(null);

  // Reset the form each time the dialog opens.
  useEffect(() => {
    if (!isOpen) return;
    setMode("file");
    setPath(initialPath ?? "");
    setFolderExt("parquet");
    setDelimiterChoice("auto");
    setCustomDelimiter("");
    setAlias("");
    setAliasEdited(false);
    setPeek(null);
    setPeekError(null);
    setHeader(true);
    setExtensions(null);
  }, [isOpen, initialPath]);

  const trimmedPath = path.trim();
  const isDelta = mode === "folder" && folderExt === DELTA_FOLDER_TYPE;
  const isGlob = mode === "folder" && !isDelta;
  const remote = mode === "file" && isRemotePath(trimmedPath);
  const sourceKind: WorkspaceSourceKind = isDelta ? "delta" : detectSourceKind(trimmedPath);
  const needsObject = mode === "file" && !remote && (sourceKind === "excel" || sourceKind === "sqlite");
  const delimiter =
    sourceKind !== "delimited" || delimiterChoice === "auto"
      ? undefined
      : delimiterChoice === "custom"
        ? customDelimiter || undefined
        : delimiterChoice;
  const extensionName = requiredExtension(sourceKind, remote);

  // Keep the alias in sync with the path (and chosen SQLite table) until the user edits it.
  // Frozen while busy: registering refreshes existingAliases before the dialog closes,
  // which would otherwise flash a "name_2" suggestion.
  useEffect(() => {
    if (aliasEdited || busy) return;
    const base = sourceKind === "sqlite" && objectName ? `${objectName}.db` : trimmedPath;
    setAlias(trimmedPath ? suggestAlias(base, existingAliases) : "");
  }, [trimmedPath, aliasEdited, existingAliases, sourceKind, objectName, busy]);

  // Whether the needed extension is already downloaded (only checked when one is needed).
  useEffect(() => {
    if (!isOpen || !extensionName || extensions !== null) return;
    invoke<ExtensionStatus[]>("list_extensions").then(setExtensions).catch(() => setExtensions([]));
  }, [isOpen, extensionName, extensions]);
  const extensionMissing = extensionName !== null && extensions !== null
    && extensions.length > 0 && !extensions.find((e) => e.name === extensionName)?.installed;

  // List the sheets (Excel) or tables (SQLite) of the chosen file.
  useEffect(() => {
    const seq = ++objectsSeq.current;
    setObjects(null);
    setObjectsError(null);
    setObjectName("");
    if (!isOpen || !needsObject || !trimmedPath) return;
    const timer = window.setTimeout(() => {
      const request = sourceKind === "excel"
        ? invoke<string[]>("list_xlsx_sheets", { filePath: trimmedPath })
          .then((names) => names.map((name): SqliteObject => ({ name, kind: "table" })))
        : invoke<SqliteObject[]>("list_sqlite_tables", { filePath: trimmedPath });
      request
        .then((list) => {
          if (seq !== objectsSeq.current) return;
          if (list.length === 0) {
            setObjectsError(sourceKind === "excel" ? "This workbook has no sheets." : "This database has no tables or views.");
            return;
          }
          setObjects(list);
          setObjectName(list[0].name);
        })
        .catch((err) => {
          if (seq === objectsSeq.current) setObjectsError(friendlyError(String(err)));
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [isOpen, needsObject, trimmedPath, sourceKind]);

  // Peek at the source (debounced) whenever what would be mounted changes.
  useEffect(() => {
    const waitingForObject = needsObject && !objectName;
    if (!isOpen || !trimmedPath || waitingForObject || (delimiterChoice === "custom" && !customDelimiter)) {
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
        objectName: needsObject ? objectName : undefined,
        header: sourceKind === "excel" ? header : undefined,
      })
        .then((result) => {
          if (seq !== peekSeq.current) return;
          setPeek(result);
          setPeekError(null);
          // A first-use download may have just happened.
          if (extensionMissing) setExtensions(null);
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
    // extensionMissing is read only to refresh the notice; it must not re-trigger a peek.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, trimmedPath, isGlob, sourceKind, delimiter, delimiterChoice, customDelimiter, needsObject, objectName, header]);

  async function browse() {
    if (mode === "folder") {
      const selected = await open({ title: isDelta ? "Select Delta table folder" : "Select folder", directory: true, multiple: false });
      if (selected && !Array.isArray(selected)) setPath(isDelta ? selected : appendGlobPattern(selected, `*.${folderExt}`));
      return;
    }
    const selected = await open({
      title: "Select file",
      multiple: false,
      filters: [
        { name: "Supported files", extensions: WORKSPACE_EXTENSIONS },
        { name: "Parquet", extensions: PARQUET_EXTENSIONS },
        { name: "Delimited text", extensions: DELIMITED_EXTENSIONS },
        { name: "Excel", extensions: EXCEL_EXTENSIONS },
        { name: "SQLite", extensions: SQLITE_EXTENSIONS },
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
    const ok = await onAdd({
      alias: aliasTrimmed,
      filePath: trimmedPath,
      isGlob,
      sourceKind,
      delimiter,
      objectName: needsObject ? objectName : undefined,
      header: sourceKind === "excel" ? header : undefined,
    });
    if (ok) onClose();
  }

  const detectedDelimiter = peek?.detected_delimiter ?? null;
  const formatLine = (() => {
    if (peek === null) return null;
    const prefix = remote ? "From URL · " : "";
    switch (peek.source_kind) {
      case "parquet": return `${prefix}Parquet`;
      case "excel": return `Excel workbook · sheet ${objectName}`;
      case "sqlite": return `SQLite database · ${objects?.find((o) => o.name === objectName)?.kind ?? "table"} ${objectName}`;
      case "delta": return "Delta Lake table";
      default:
        return detectedDelimiter
          ? `${prefix}Delimited text · ${describeDelimiter(detectedDelimiter)} ( ${detectedDelimiter === "\t" ? "\\t" : detectedDelimiter} )`
          : `${prefix}Delimited text`;
    }
  })();
  const detailParts: string[] = [];
  if (peek) {
    if (peek.has_header !== null) detailParts.push(peek.has_header ? "Header row found" : "No header row");
    if (peek.row_count !== null) detailParts.push(`${peek.row_count.toLocaleString()} rows`);
    detailParts.push(`${peek.schema.length} columns`);
  }
  const sourceHint = remote
    ? "Read from the web each time a query runs, so it needs an internet connection."
    : sourceKind === "excel"
      ? "Excel stores numbers as decimals, so they arrive as DOUBLE. Cast in SQL if you need integers."
      : null;
  const pathLabel = mode === "file" ? "File or URL" : isDelta ? "Delta table folder" : "Folder";
  const pathPlaceholder = mode === "file"
    ? "C:\\data\\sales.parquet  or  https://…/sales.parquet"
    : isDelta ? "C:\\data\\events_delta" : "C:\\data\\exports\\*.csv";

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
          <label htmlFor="add-path" className="field-label">{pathLabel}</label>
          <div className="field-row">
            <input id="add-path" type="text" className="input input-mono grow" value={path}
              placeholder={pathPlaceholder}
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

        {needsObject && trimmedPath ? (
          <div className="field-row align-end">
            <div className="field grow">
              <label htmlFor="add-object" className="field-label">{sourceKind === "excel" ? "Sheet" : "Table"}</label>
              <select id="add-object" className="input" value={objectName} disabled={objects === null}
                onChange={(e) => setObjectName(e.currentTarget.value)}>
                {objects === null ? <option value="">{objectsError ? "—" : "Reading…"}</option> : null}
                {objects?.map((o) => (
                  <option key={`${o.kind}:${o.name}`} value={o.name}>{o.kind === "view" ? `${o.name} (view)` : o.name}</option>
                ))}
              </select>
            </div>
            {sourceKind === "excel" ? (
              <label className="checkbox-label">
                <input type="checkbox" className="checkbox" checked={header} onChange={(e) => setHeader(e.currentTarget.checked)} />
                First row is column names
              </label>
            ) : null}
          </div>
        ) : null}

        {trimmedPath ? (
          <div className="detect-box" aria-live="polite">
            <div className="detect-text">
              <span className="field-label">Detected format</span>
              {peekLoading ? (
                <span className="muted">
                  {extensionMissing ? `Downloading the ${extensionLabel(extensionName ?? "")} extension (first use only)…` : "Reading file…"}
                </span>
              ) : null}
              {!peekLoading && formatLine ? <strong>{formatLine}</strong> : null}
              {!peekLoading && detailParts.length > 0 ? <span className="muted small">{detailParts.join(" · ")}</span> : null}
              {!peekLoading && peekError ? <span className="text-danger">{peekError}</span> : null}
              {objectsError ? <span className="text-danger">{objectsError}</span> : null}
              {sourceHint ? <span className="muted small">{sourceHint}</span> : null}
              {!peekLoading && extensionMissing && !peek && !peekError && !objectsError ? (
                <span className="muted small">
                  Needs the {extensionLabel(extensionName ?? "")} extension, downloaded automatically on first use.
                </span>
              ) : null}
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
            <span className="muted small">Filled in from the {sourceKind === "sqlite" ? "table" : "file"} name. Use it in SQL: SELECT * FROM {aliasTrimmed}</span>
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
