import React, { useEffect, useState } from "react";
import { Icon } from "./icons";

/** Capabilities: what finished tasks left the platform able to do (docs/design/capabilities.md).
 * The shelf on the platform engineer page lists them; a task's result page offers its lead's
 * proposals to solidify. */
export type CapabilityCard = {
  name: string; kind: string; summary: string; usage: string; files: string[]; check: string;
  secrets: string[]; domains: string[];
};
export type Capability = CapabilityCard & {
  id: string; status: "active" | "disabled" | "failed"; source_run_id?: string | null;
  check_ok?: boolean | null; check_output: string; created_at: string;
};
export type CapabilityProposal = CapabilityCard & { status: "proposed" | "solidified" | "dismissed"; capability_id?: string | null };

const KIND: Record<string, string> = { tool: "工具", automation: "自动化" };
const STATUS: Record<Capability["status"], string> = { active: "可用", disabled: "已停用", failed: "检查未通过" };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.detail === "string" ? body.detail : `请求失败（${response.status}）`);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

/** 平台工程师 → 能力: every capability on this machine. */
export function CapabilityShelf({ apiBase, runs, onOpenRun }: {
  apiBase: string; runs: { id: string; plan: { summary: string; title?: string } }[]; onOpenRun: (id: string) => void;
}) {
  const [items, setItems] = useState<Capability[] | null>(null), [error, setError] = useState(""), [removing, setRemoving] = useState<string | null>(null);
  const load = () => call<Capability[]>(`${apiBase}/api/capabilities`).then(setItems).catch(failure => setError(failure.message));
  useEffect(() => { void load(); }, [apiBase]);
  async function act(promise: Promise<unknown>) {
    setError("");
    try { await promise; await load(); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  }
  const source = (id?: string | null) => runs.find(run => run.id === id);
  return <section className="panel capability-shelf" aria-label="能力">
    <h3>能力{!!items?.length && <small>{items.length}</small>}</h3>
    <p className="muted">任务做出来、你固化下来的工具和自动化。可用的工具会告诉之后的每个任务，让它们直接用。</p>
    {error && <p className="error" role="alert">{error}</p>}
    {items && !items.length && <p className="empty">还没有能力。任务完成后，负责人会提议它做出的可复用工具，你在结果页一键固化。</p>}
    <ul className="capability-list">{(items ?? []).map(item => <li key={item.id} className={`capability ${item.status}`}>
      <div className="capability-head">
        <Icon name={item.kind === "automation" ? "activity" : "wrench"} size={15} />
        <b>{item.name}</b>
        <span className="capability-kind">{KIND[item.kind] ?? item.kind}</span>
        <span className={`capability-status ${item.status}`}>{STATUS[item.status]}</span>
        <span className="capability-actions">
          {item.status !== "failed" && <button type="button" className="ghost" onClick={() => act(call(`${apiBase}/api/capabilities/${encodeURIComponent(item.id)}`,
            { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: item.status !== "active" }) }))}>
            {item.status === "active" ? "停用" : "启用"}</button>}
          {removing === item.id
            ? <button type="button" className="danger" onClick={() => { setRemoving(null); void act(call(`${apiBase}/api/capabilities/${encodeURIComponent(item.id)}`, { method: "DELETE" })); }}>确认删除</button>
            : <button type="button" className="ghost" onClick={() => setRemoving(item.id)}>删除</button>}
        </span>
      </div>
      {item.summary && <p>{item.summary}</p>}
      <dl>
        {item.usage && <><dt>用法</dt><dd><code>{item.usage}</code></dd></>}
        {!!item.secrets.length && <><dt>需要</dt><dd>{item.secrets.join("、")}</dd></>}
        {!!item.domains.length && <><dt>访问</dt><dd>{item.domains.join("、")}</dd></>}
        {item.source_run_id && <><dt>来自</dt><dd>{source(item.source_run_id)
          ? <button type="button" className="link-button" onClick={() => onOpenRun(item.source_run_id!)}>「{source(item.source_run_id)!.plan.title || source(item.source_run_id)!.plan.summary}」</button>
          : "已删除的任务"}</dd></>}
      </dl>
      {item.kind === "automation" && <p className="capability-note">自动化需要后台运行器才能一直运行，下一步提供；现在先登记在这里。</p>}
      {item.status === "failed" && <details className="capability-check"><summary>检查输出</summary><pre>{item.check_output}</pre></details>}
    </li>)}</ul>
  </section>;
}

/** On a finished task's result page: what its lead found reusable, to solidify or dismiss. */
export function CapabilityProposals<T>({ apiBase, runId, proposals, onUpdated }: {
  apiBase: string; runId: string; proposals: CapabilityProposal[]; onUpdated: (run: T) => void;
}) {
  const [busy, setBusy] = useState<number | null>(null), [error, setError] = useState("");
  const shown = proposals.map((item, index) => ({ item, index })).filter(({ item }) => item.status !== "dismissed");
  if (!shown.length) return null;
  async function act(index: number, action: "solidify" | "dismiss") {
    setBusy(index); setError("");
    try { onUpdated(await call<T>(`${apiBase}/api/tasks/${encodeURIComponent(runId)}/capabilities/${index}/${action}`, { method: "POST" })); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(null); }
  }
  return <section className="capability-proposals" aria-label="可复用的能力">
    <p className="capability-proposals-head"><Icon name="plus" size={14} />这个任务做出了可以复用的能力</p>
    {shown.map(({ item, index }) => <div key={index} className="capability-proposal">
      <div><b>{item.name}</b><span className="capability-kind">{KIND[item.kind] ?? item.kind}</span><p>{item.summary}</p></div>
      {item.status === "solidified"
        ? <span className="capability-status active">已固化，在平台工程师 → 能力里</span>
        : <span className="capability-actions">
          <button type="button" className="ghost" disabled={busy !== null} onClick={() => act(index, "dismiss")}>忽略</button>
          <button type="button" className="primary" disabled={busy !== null} onClick={() => act(index, "solidify")}>{busy === index ? "正在固化…" : "固化"}</button>
        </span>}
    </div>)}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
