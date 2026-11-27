import React, { useState } from "react";
import { detailText } from "./mission-history";

/** DELETE ``url``; null when done, else what went wrong in words. */
export async function deleteAt(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { method: "DELETE" });
    if (response.ok) return null;
    const body = await response.json().catch(() => ({}));
    return detailText(body.detail) || `删除失败（${response.status}）`;
  } catch (failure) {
    return failure instanceof Error ? failure.message : String(failure);
  }
}

/** A delete button that asks first: it says what goes and what stays (``note``), then deletes on a
 *  second click. ``onDelete`` returns what went wrong, or null. */
export function ConfirmDelete({ label = "删除", confirm = "确认删除", note, onDelete, disabled = false, className = "ghost" }: {
  label?: string; confirm?: string; note: string; onDelete: () => Promise<string | null>; disabled?: boolean; className?: string;
}) {
  const [asking, setAsking] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function go() {
    setBusy(true); setError("");
    const problem = await onDelete();
    setBusy(false);
    if (problem) setError(problem); else setAsking(false);
  }
  if (!asking) return <span className="confirm-delete"><button type="button" className={className} disabled={disabled} onClick={() => setAsking(true)}>{label}</button></span>;
  return <span className="confirm-delete asking" role="group" aria-label={label}>
    <span className="confirm-delete-note">{note}</span>
    <button type="button" className="danger" disabled={busy} onClick={() => void go()}>{busy ? "删除中…" : confirm}</button>
    <button type="button" className="ghost" disabled={busy} onClick={() => { setAsking(false); setError(""); }}>取消</button>
    {error && <span className="error" role="alert">{error}</span>}
  </span>;
}
