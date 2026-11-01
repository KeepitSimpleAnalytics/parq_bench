import { useEffect, useState } from "react";
import type { SavedQuery } from "../types";
import { Modal } from "./Modal";
import { findSavedQuery, saveOutcome, savedQueryNameProblem } from "../sql/savedQueries";

/** Asks for a name and saves the editor text under it. */
export function SaveQueryDialog({
  open,
  saved,
  openName,
  onClose,
  onSave,
}: {
  open: boolean;
  saved: SavedQuery[];
  /** The saved query open in the editor: the name is prefilled and saving updates it. */
  openName: string | null;
  onClose: () => void;
  /** Saves; rejects with a message to show in the dialog. */
  onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(openName ?? "");
    setBusy(false);
    setError(null);
  }, [open, openName]);

  const trimmed = name.trim();
  const problem = trimmed === "" ? null : savedQueryNameProblem(name);
  const outcome = saveOutcome(saved, name, openName);
  const existing = findSavedQuery(saved, name);
  const canSave = trimmed !== "" && problem === null && !busy;

  async function submit() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(trimmed);
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title="Save query" onClose={onClose} width={460}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!canSave} onClick={() => void submit()}>
            {busy ? "Saving…" : outcome === "replace" ? "Replace" : "Save"}
          </button>
        </>
      }>
      <form className="field" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label htmlFor="save-query-name" className="field-label">Name</label>
        <input id="save-query-name" type="text" className="input" value={name} autoComplete="off"
          placeholder="e.g. Monthly revenue" aria-describedby="save-query-hint save-query-error"
          aria-invalid={problem !== null || error !== null} onChange={(e) => setName(e.currentTarget.value)} />
        <span id="save-query-hint" aria-live="polite"
          className={problem ? "text-danger small" : outcome === "replace" ? "text-warning small" : "muted small"}>
          {problem
            ?? (outcome === "replace" && existing
              ? `A saved query named ${existing.name} already exists and will be replaced.`
              : outcome === "update" ? "Updates the saved query with the editor text." : "Saves the whole editor text.")}
        </span>
        {error ? <span id="save-query-error" className="text-danger small" role="alert">{error}</span> : null}
      </form>
    </Modal>
  );
}
