import React, { useEffect, useState } from "react";

// What chats remember about the people they talk with (remembering.py), by where it was said, and
// how FluidForm works (config.PROFILES), picked in the 设置 menu.

type Place = { key: string; label: string; facts: string[] };
type Memory = { enabled: boolean; places: Place[] };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.detail === "string" ? body.detail : `请求失败（${response.status}）`);
  return body as T;
}

export function MemoryPage({ apiBase }: { apiBase: string }) {
  const [memory, setMemory] = useState<Memory | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { call<Memory>(`${apiBase}/api/memory`).then(setMemory).catch(err => setError(err.message)); }, [apiBase]);
  async function forget(key: string, fact: string) {
    setBusy(`${key}\n${fact}`); setError("");
    try {
      setMemory(await call<Memory>(`${apiBase}/api/memory/forget`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, fact }) }));
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  }
  return <section className="problems-page" aria-label="记住的事">
    <h2>记住的事</h2>
    <p className="muted">对话里有人说过的长期偏好和情况。新开的对话会先知道这些；记错了就删掉，或在对话里说"忘掉……"。</p>
    {memory && !memory.enabled && <p className="memory-off">记忆没有打开：对话不会再记新的事，下面的也不会告诉它们。</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {memory === null && !error && <p className="muted">加载中…</p>}
    {memory?.places.length === 0 && <p className="empty">还没有记住什么。</p>}
    {memory && memory.places.length > 0 && <ol className="problem-topics">{memory.places.map(place => <li key={place.key} className="problem-topic">
      <div className="problem-head"><b>{place.label}</b><span className="problem-count">{place.facts.length} 条</span></div>
      <ul className="memory-facts">{place.facts.map(fact => <li key={fact}>
        <span>{fact}</span>
        <button type="button" className="link-button" disabled={busy === `${place.key}\n${fact}`}
          aria-label={`删除：${fact}`} onClick={() => void forget(place.key, fact)}>{busy === `${place.key}\n${fact}` ? "删除中…" : "删除"}</button>
      </li>)}</ul>
    </li>)}</ol>}
  </section>;
}

type Profile = "" | "careful";
const PROFILES: { id: Profile; label: string; hint: string }[] = [
  { id: "", label: "默认", hint: "小事直接做，大事排计划" },
  { id: "careful", label: "稳妥", hint: "每件都排计划、每步都验收" },
];

/** In the 设置 menu: how FluidForm works, saved as it is picked. */
export function ProfilePicker({ apiBase }: { apiBase: string }) {
  const [profile, setProfile] = useState<Profile | null>(null), [alone, setAlone] = useState<Record<string, string[]>>({});
  const [state, setState] = useState<"" | "saving" | "saved">(""), [error, setError] = useState("");
  const show = (view: { profile: Profile; given_alone: Record<string, string[]> }) => { setProfile(view.profile); setAlone(view.given_alone); };
  useEffect(() => { call<{ profile: Profile; given_alone: Record<string, string[]> }>(`${apiBase}/api/settings/profile`).then(show).catch(err => setError(err.message)); }, [apiBase]);
  async function pick(next: Profile) {
    if (next === profile) return;
    setState("saving"); setError("");
    try {
      show(await call(`${apiBase}/api/settings/profile`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile: next }) }));
      setState("saved");
    } catch (err) { setState(""); setError(err instanceof Error ? err.message : String(err)); }
  }
  const current = PROFILES.find(item => item.id === profile);
  const kept = profile ? (alone[profile] ?? []).length : 0;
  return <>
    <p>工作方式{state === "saving" ? <span className="settings-state">保存中…</span> : state === "saved" ? <span className="settings-state">已保存</span> : null}</p>
    <div className="settings-themes settings-profiles" role="group" aria-label="工作方式">{PROFILES.map(item =>
      <button key={item.id || "none"} type="button" aria-pressed={profile === item.id} disabled={profile === null || state === "saving"}
        title={item.hint} onClick={() => void pick(item.id)}>{item.label}</button>)}</div>
    {current && <small className="settings-hint">{current.hint}{kept ? `；${kept} 项单独设过，不跟着变` : ""}</small>}
    {error && <p className="error" role="alert">{error}</p>}
  </>;
}
