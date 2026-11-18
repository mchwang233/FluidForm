import React, { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./icons";
import { Markdown as MarkdownView } from "./markdown";
import { when } from "./diagnosis";
import { ENGINEER_STATUS, type EngineerJob, type EngineerMessage } from "./engineer";
import { ENGINEER_WAITING, kindOf, useEngineerJobs } from "./lead-engineer";
import type { Capability } from "./capabilities";

/** The 平台 page's home: one conversation with the platform engineer, what waits for your nod
 * pinned above it, and beside it what the platform can do now and what changed lately. */

type RunRef = { id: string; plan: { summary: string; title?: string } };
type Skill = { name: string; description: string; tools: string[]; machine: boolean };

const DONE = new Set(["applied", "failed", "rejected", "cancelled"]);
// Pieces of work the conversation shows; older work is in 全部记录.
const SHOWN_JOBS = 8;
// Skills listed beside the conversation; the rest are named in one line.
const SHOWN_SKILLS = 6;
// A message longer than this shows its start, the rest folded.
const LONG_MESSAGE = 280;
const WORKING: Record<string, string> = {
  queued: "排队中…", planning: "正在写方案…", editing: "正在改代码…", validating: "正在运行测试和构建…", applying: "正在生效…",
};
const CHECKS: Record<string, string> = {
  "Python syntax": "语法检查", "Existing database compatibility": "旧数据兼容", "Backend tests": "后端测试",
  "Frontend tests": "前端测试", "Frontend build": "前端构建",
};

/** A job's name for the user: its plain headline, or for older jobs the first phrase of its title
 * (or of what was asked). */
export function headlineOf(job: Pick<EngineerJob, "headline" | "title" | "request">): string {
  if (job.headline) return job.headline;
  const text = (job.title || job.request || "").replace(/[*_`#>]+/g, "").replace(/^@平台工程师\s*/, "").trim();
  const head = (text.split(/[：:。，,；;\n]/)[0] || text).trim();
  return head.length > 16 ? `${head.slice(0, 15)}…` : head || "平台改动";
}

const verb = (job: EngineerJob) => job.kind === "component" ? "新增" : "修复";
const day = (iso: string) => new Date(iso).toLocaleDateString("zh-CN", { month: "long", day: "numeric" }).replace(/(\d+)/g, " $1 ").trim();
const short = (iso: string) => new Date(iso).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });

/** The first three points of a plan, without their labels: what it will do, in its own words. */
function planPoints(job: EngineerJob): string[] {
  if (job.plan_plain) return [job.plan_plain];
  return (job.plan ?? "").split("\n").map(line => line.replace(/^\s*[-*\d.]+\s*/, "").replace(/^(目标|改动|测试|风险)\s*[:：]\s*/, "").replace(/[*`]/g, "").trim())
    .filter(Boolean).slice(0, 3);
}

export function PlatformHome({ apiBase, runs, onOpenRun, onRecords, onCapabilities }: {
  apiBase: string; runs: RunRef[]; onOpenRun: (id: string) => void;
  onRecords: (jobId?: string) => void; onCapabilities: () => void;
}) {
  const { jobs, act, available } = useEngineerJobs(apiBase, null, "", true);
  const [capabilities, setCapabilities] = useState<Capability[]>([]), [skills, setSkills] = useState<Skill[]>([]);
  useEffect(() => {
    fetch(`${apiBase}/api/capabilities`).then(r => r.ok ? r.json() : []).then(list => Array.isArray(list) && setCapabilities(list)).catch(() => {});
    fetch(`${apiBase}/api/skills`).then(r => r.ok ? r.json() : []).then(list => Array.isArray(list) && setSkills(list)).catch(() => {});
  }, [apiBase]);
  const waiting = jobs.filter(job => ENGINEER_WAITING.has(job.status));
  const [target, setTarget] = useState<string | null>(null);
  const replyTo = waiting.find(job => job.id === target);
  const applied = jobs.filter(job => job.status === "applied").slice(0, 5);
  return <div className="platform-page">
    <section className="platform-main">
      <header className="platform-head">
        <h2>平台</h2>
        <p>跟平台工程师说要加什么能力、修什么问题。改动先在副本里做，测试通过、你点头才生效。</p>
      </header>
      {!available && <p className="error">平台工程师不可用：平台自修复没有启用，或这里没有可编辑的平台源码。</p>}
      {waiting.map(job => <Pending key={job.id} job={job} act={act} onRevise={() => setTarget(job.id)} />)}
      <Conversation jobs={jobs} runs={runs} onOpenRun={onOpenRun} onRecords={onRecords} />
      <PlatformComposer act={act} replyTo={replyTo} onDone={() => setTarget(null)} disabled={!available} />
    </section>
    <aside className="platform-side" aria-label="平台现在能做的">
      <h3>平台现在能做的</h3>
      <p className="platform-side-sub">能力 · 带代码，能直接用</p>
      <ul className="platform-abilities">
        {capabilities.map(item => <li key={item.id}>
          <button type="button" onClick={onCapabilities} title="管理能力">
            <span className="platform-ability-icon"><Icon name={item.kind === "automation" ? "activity" : "wrench"} size={15} /></span>
            <span className="platform-ability-text"><b>{item.name}</b><small>{item.summary}</small></span>
            <span className={`platform-ability-status ${item.status}`}>{item.status === "active" ? (item.kind === "automation" ? "待开启" : "可用") : item.status === "disabled" ? "已停用" : "检查未通过"}</span>
          </button>
        </li>)}
        {!capabilities.length && <li className="muted">还没有。任务做出可复用的代码后，你在结果页固化，它就带着说明书出现在这里。</li>}
      </ul>
      {!!capabilities.length && <button type="button" className="platform-link" onClick={onCapabilities}>管理能力 ›</button>}
      <p className="platform-side-sub">技能 · 只有用法说明</p>
      <ul className="platform-abilities">
        {skills.slice(0, SHOWN_SKILLS).map(item => <li key={`skill-${item.name}`}>
          <div>
            <span className="platform-ability-icon"><Icon name={"file" as IconName} size={15} /></span>
            <span className="platform-ability-text"><b>{item.name}</b><small title={item.description}>{item.description}</small></span>
            <span className="platform-ability-status active">会用</span>
          </div>
        </li>)}
        {skills.length > SHOWN_SKILLS && <li className="muted" title={skills.slice(SHOWN_SKILLS).map(item => item.name).join("、")}>还会 {skills.length - SHOWN_SKILLS} 项：{skills.slice(SHOWN_SKILLS).map(item => item.name).join("、")}</li>}
        {!skills.length && <li className="muted">还没有。</li>}
      </ul>
      <h3>最近改进</h3>
      <ul className="platform-changes">
        {applied.map(job => <li key={job.id}><button type="button" onClick={() => onRecords(job.id)}>
          <span className="platform-change-verb">{verb(job)}</span><span className="platform-change-name">{headlineOf(job)}</span><small>{short(job.finished_at ?? job.updated_at)}</small>
        </button></li>)}
        {!applied.length && <li className="muted">还没有。</li>}
      </ul>
      <button type="button" className="platform-link" onClick={() => onRecords()}>全部 {jobs.length} 条记录 ›</button>
    </aside>
  </div>;
}

/** What waits for the user's nod, pinned above the conversation, in plain words with its buttons. */
function Pending({ job, act, onRevise }: { job: EngineerJob; act: (path: string, body?: unknown) => Promise<string | null>; onRevise: () => void }) {
  const [busy, setBusy] = useState(""), [error, setError] = useState("");
  const base = `/api/engineer/jobs/${encodeURIComponent(job.id)}`;
  async function post(path: string, label: string, body?: unknown) {
    setBusy(label); setError("");
    setError(await act(path, body) ?? "");
    setBusy("");
  }
  const what = `${verb(job)}「${headlineOf(job)}」`;
  return <section className="platform-pending" aria-label={`等你点头：${what}`}>
    <p className="platform-pending-label">{job.status === "needs_input" ? "它在问你" : job.status === "ready" ? "改好了，等你确认生效" : "等你点头"}</p>
    <p className="platform-pending-title">{what}</p>
    {job.status === "plan_ready" && <ul>{planPoints(job).map((point, index) => <li key={index}>{point}</li>)}</ul>}
    {job.status === "ready" && <p className="platform-pending-text">{job.plain || `改动已通过检查${job.files?.length ? `，改了 ${job.files.length} 个文件` : ""}。应用后服务会重启一次。`}</p>}
    {job.status === "needs_input" && <p className="platform-pending-text">{job.question}</p>}
    {job.status === "plan_ready" && job.plan && <details className="platform-pending-more"><summary>完整方案</summary><MarkdownView text={job.plan} /></details>}
    <div className="platform-pending-actions">
      {job.status === "plan_ready" && <button type="button" className="primary" disabled={!!busy} onClick={() => post(`${base}/approve`, "approve")}>{busy === "approve" ? "提交中…" : "批准，开始做"}</button>}
      {job.status === "ready" && <button type="button" className="primary" disabled={!!busy} onClick={() => post(`${base}/approve`, "apply")}>{busy === "apply" ? "提交中…" : "应用这项改动"}</button>}
      {job.status === "needs_input" && (job.choices ?? []).map(choice => <button key={choice} type="button" className="ghost" disabled={!!busy}
        onClick={() => post(`${base}/reply`, "choice", { text: "", choice })}>{choice}</button>)}
      <button type="button" className="ghost" disabled={!!busy} onClick={onRevise}>{job.status === "needs_input" ? "回复" : "改一改"}</button>
      {job.status !== "needs_input" && <button type="button" className="platform-quiet" disabled={!!busy} onClick={() => post(`${base}/reject`, "reject")}>{job.status === "ready" ? "不要了" : "不做了"}</button>}
    </div>
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}

/** The conversation, one segment per piece of work, by the day it began: finished work folds to its
 * result line, work under way or waiting for you shows its own messages. */
function Conversation({ jobs, runs, onOpenRun, onRecords }: {
  jobs: EngineerJob[]; runs: RunRef[]; onOpenRun: (id: string) => void; onRecords: (jobId?: string) => void;
}) {
  const started = (job: EngineerJob) => job.messages?.[0]?.created_at ?? job.created_at;
  // Work with nothing said yet is only in the cards pinned above.
  const said = jobs.filter(job => job.messages?.length || DONE.has(job.status));
  const recent = [...said].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, SHOWN_JOBS)
    .sort((a, b) => started(a).localeCompare(started(b)));
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView?.({ block: "nearest" }); }, [recent.length]);
  const older = said.length - recent.length;
  let shownDay = "";
  return <div className="platform-thread" aria-label="和平台工程师的对话">
    {older > 0 && <button type="button" className="platform-older" onClick={() => onRecords()}>更早的 {older} 项在全部记录里 ›</button>}
    {!recent.length && <p className="platform-empty">还没有对话。在下面说要加什么能力、修什么问题。</p>}
    {recent.map(job => {
      const thisDay = day(started(job)), divider = thisDay !== shownDay;
      shownDay = thisDay;
      return <React.Fragment key={job.id}>
        {divider && <p className="platform-day">{thisDay}</p>}
        <Segment job={job} runs={runs} onOpenRun={onOpenRun} onRecords={onRecords} />
      </React.Fragment>;
    })}
    <div ref={end} />
  </div>;
}

/** One piece of work. Finished, it is one line that opens to its messages and details. */
function Segment({ job, runs, onOpenRun, onRecords }: {
  job: EngineerJob; runs: RunRef[]; onOpenRun: (id: string) => void; onRecords: (jobId?: string) => void;
}) {
  const messages = job.messages ?? [];
  const said = <>{messages.map((message, index) => <Message key={index} job={job} message={message} runs={runs} onOpenRun={onOpenRun} />)}</>;
  if (!DONE.has(job.status)) return <section className="platform-segment open" aria-label={headlineOf(job)}>
    {messages.filter(message => message.role !== "system").map((message, index) => <Message key={index} job={job} message={message} runs={runs} onOpenRun={onOpenRun} />)}
    {WORKING[job.status] && <p className="platform-working"><span className="dx-typing" aria-hidden="true"><i /><i /><i /></span>{headlineOf(job)} · {WORKING[job.status]}</p>}
  </section>;
  const status = ENGINEER_STATUS[job.status] ?? { label: job.status, tone: "muted" };
  const facts = [
    `${verb(job)}：${headlineOf(job)}`,
    ...(job.files?.length ? [`改了 ${job.files.length} 个文件`] : []),
    ...(job.status === "applied" && job.checks?.length ? ["测试全部通过"] : []),
  ];
  return <details className={`platform-segment platform-result ${job.status}`}>
    <summary><span className={`platform-result-status ${status.tone}`}>● {status.label}</span><span className="platform-result-facts">{facts.join(" · ")}</span>
      <small>{short(job.finished_at ?? job.updated_at)}</small><span className="platform-result-more" aria-hidden="true">›</span></summary>
    <div className="platform-result-body">
      {job.plain && <p className="platform-result-plain">{job.plain}</p>}
      <div className="platform-segment-said">{said}</div>
      <details className="platform-result-tech"><summary>技术细节</summary>
        {job.report && <MarkdownView text={job.report} />}
        {!!job.files?.length && <p className="platform-result-line">改动的文件：{job.files.map(file => <code key={file}>{file}</code>)}</p>}
        {!!job.checks?.length && <p className="platform-result-line">检查通过：{job.checks.map(check => CHECKS[check] ?? check).join("、")}</p>}
        {job.commit && <p className="platform-result-line">已提交到 git：<code>{job.commit.slice(0, 8)}</code>（没有推送）</p>}
        {job.error && <p className="error">{job.error}</p>}
      </details>
      <button type="button" className="link-button" onClick={() => onRecords(job.id)}>在全部记录里打开 ›</button>
    </div>
  </details>;
}

function Message({ job, message, runs, onOpenRun }: { job: EngineerJob; message: EngineerMessage; runs: RunRef[]; onOpenRun: (id: string) => void }) {
  if (message.role === "system") return <p className="platform-system">{message.text} · {when(message.created_at)}</p>;
  const text = message.text.replace(/^@平台工程师\s*/, "");
  if (message.role === "user") return <div className="platform-me"><Folded text={text} plain /><small>{when(message.created_at)}</small></div>;
  const lead = message.role === "lead";
  const run = job.run_id ? runs.find(item => item.id === job.run_id) : undefined;
  return <article className="platform-msg">
    <span className="platform-avatar" aria-hidden="true">{lead ? "负" : "工"}</span>
    <div>
      <p className="platform-meta"><b>{lead ? "负责人" : "平台工程师"}</b>
        {lead && run && <> · 来自任务 <button type="button" className="link-button" onClick={() => onOpenRun(run.id)}>「{run.plan.title || run.plan.summary.slice(0, 20)}」</button></>}
        {" · "}{when(message.created_at)}</p>
      <Folded text={text} />
    </div>
  </article>;
}

/** A long message shows its start; the rest opens in place. */
function Folded({ text, plain = false }: { text: string; plain?: boolean }) {
  const [open, setOpen] = useState(false);
  if (text.length <= LONG_MESSAGE || open) return <div className="platform-text">{plain ? <p>{text}</p> : <MarkdownView text={text} />}</div>;
  const start = text.replace(/[*_`#>|]+/g, "").replace(/\s+/g, " ").slice(0, LONG_MESSAGE);
  return <div className="platform-text"><p>{start}… <button type="button" className="link-button" onClick={() => setOpen(true)}>展开</button></p></div>;
}

/** The box at the foot: a new request, or a reply to what waits for the user. */
function PlatformComposer({ act, replyTo, onDone, disabled }: {
  act: (path: string, body?: unknown) => Promise<string | null>; replyTo?: EngineerJob; onDone: () => void; disabled: boolean;
}) {
  const [text, setText] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (replyTo) box.current?.focus(); }, [replyTo?.id]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const said = text.trim();
    if (!said || busy) return;
    setBusy(true); setError("");
    const problem = replyTo
      ? await act(`/api/engineer/jobs/${encodeURIComponent(replyTo.id)}/reply`, { text: said })
      : await act("/api/engineer/jobs", { request: said, kind: kindOf(said) });
    setBusy(false);
    if (problem) setError(problem); else { setText(""); onDone(); }
  }
  function keys(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
  }
  return <form className="platform-composer" onSubmit={submit} aria-label="给平台工程师留言">
    {replyTo && <p className="platform-reply-to">回复「{headlineOf(replyTo)}」<button type="button" className="link-button" onClick={onDone}>取消</button></p>}
    <div className="platform-input">
      <textarea ref={box} aria-label="给平台工程师的消息" rows={2} maxLength={20000} value={text} disabled={disabled || busy}
        onChange={event => setText(event.target.value)} onKeyDown={keys}
        placeholder={replyTo ? "写下要改的地方，或回答它的问题…" : "跟平台工程师说要加什么、修什么…"} />
      <button type="submit" className="primary send-button" disabled={disabled || busy || !text.trim()} title="Ctrl + Enter" aria-label="发送">
        {busy ? <span>发送中…</span> : <><Icon name="arrowUp" /><span className="sr-only">发送</span></>}</button>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
  </form>;
}
