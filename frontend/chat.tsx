import React, { FormEvent, useEffect, useState } from "react";
import { Icon } from "./icons";
import { formatUsd } from "./mission-history";

/** A chat's page: its conversation (the lead panel in chat mode), and turning it into a task. */
export type PromoteOptions = { prompt: string; budget_usd: number; use_cli: boolean; allow_network: boolean };
type ChatRun = { id: string; prompt?: string; project_dir?: string | null; use_cli: boolean; actual_cost_usd: number; budget_usd: number;
  lead_messages?: { status: string }[]; plan: { summary: string } };

export function ChatDetail({ run, model, conversation, deleteButton, onPromote }: {
  run: ChatRun; model: string; conversation: React.ReactNode; deleteButton: React.ReactNode;
  onPromote: (options: PromoteOptions) => Promise<string | null>;
}) {
  const [promoting, setPromoting] = useState(false);
  useEffect(() => setPromoting(false), [run.id]);
  const answering = (run.lead_messages ?? []).some(item => item.status === "pending");
  return <section className="panel detail task-page chat-page" aria-label="对话">
    <div className="task-header">
      <div className="task-title">
        <p className="eyebrow task-meta"><span className="pill chat">对话</span>{model} · 已花 {formatUsd(run.actual_cost_usd)} / {formatUsd(run.budget_usd)}
          {run.project_dir && <span className="project-path" title={run.project_dir}> · <Icon name="folder" size={13} /> {run.project_dir}</span>}</p>
        <h3 title={run.plan.summary}>{run.plan.summary}</h3>
      </div>
      <div className="task-actions">
        <button type="button" className="primary" aria-expanded={promoting} disabled={answering} onClick={() => setPromoting(open => !open)}
          title={answering ? "等它回复完再转" : "按这段对话规划成任务，确认预算后执行"}><Icon name="list" />转成任务</button>
        {deleteButton}
      </div>
    </div>
    {promoting && <PromoteForm run={run} onCancel={() => setPromoting(false)} onPromote={onPromote} />}
    {conversation}
  </section>;
}

function PromoteForm({ run, onCancel, onPromote }: { run: ChatRun; onCancel: () => void; onPromote: (options: PromoteOptions) => Promise<string | null> }) {
  const [prompt, setPrompt] = useState(""), [budget, setBudget] = useState("2"), [cli, setCli] = useState(run.use_cli),
    [network, setNetwork] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const amount = Number(budget);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !(amount > 0)) return;
    setBusy(true); setError("");
    const problem = await onPromote({ prompt: prompt.trim(), budget_usd: amount, use_cli: cli, allow_network: network });
    setBusy(false);
    if (problem) setError(problem);
  }
  return <form className="change-panel promote-panel" onSubmit={submit} aria-label="转成任务">
    <div className="change-head"><b>转成任务</b><small>负责人会结合这段对话规划，你确认预算后才开始执行。对话记录保留。</small></div>
    <textarea value={prompt} onChange={event => setPrompt(event.target.value)} rows={3} maxLength={20000} aria-label="任务要完成的工作"
      placeholder={`要完成的工作。留空则按第一条消息：${(run.prompt ?? "").slice(0, 40)}`} />
    <div className="change-actions">
      <label className="budget-field">预算上限 <span>$</span><input type="number" min="0.01" step="any" inputMode="decimal" aria-label="任务的预算上限（美元）"
        value={budget} onChange={event => setBudget(event.target.value)} /></label>
      <label className="switch" title="关闭后只使用按量计费的 API 模型"><input type="checkbox" checked={cli} onChange={event => setCli(event.target.checked)} /><span />允许使用会员 CLI</label>
      <label className="switch" title="执行命令时可以访问互联网，本机上的服务仍然访问不到"><input type="checkbox" checked={network} onChange={event => setNetwork(event.target.checked)} /><span />允许联网</label>
      <span className="change-buttons">
        <button type="button" className="ghost" onClick={onCancel} disabled={busy}>取消</button>
        <button type="submit" className="primary" disabled={busy || !(amount > 0)}>{busy ? "正在生成计划…" : "生成执行计划"}</button>
      </span>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
  </form>;
}
