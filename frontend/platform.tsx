import React, { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./icons";
import { Markdown as MarkdownView } from "./markdown";
import { API_BASE, AttachmentTray, ClipButton, SentFiles, takesFiles, useAttachments } from "./attachments";
import { when } from "./diagnosis";
import { ENGINEER_STATUS, type EngineerJob, type EngineerMessage } from "./engineer";
import { ENGINEER_WAITING, kindOf, useEngineerJobs } from "./lead-engineer";
import { has, useProvided } from "./provided";
import type { Capability } from "./capabilities";

/** The 平台 page's home: one conversation with the platform engineer, what waits for your nod
 * pinned above it, and beside it what the platform can do now and what changed lately. */

type RunRef = { id: string; plan: { summary: string; title?: string } };
type Skill = { name: string; description: string; summary?: string; tools: string[]; machine: boolean };
/** A skill as the user reads it: its one line in their language, or the models' description. */
const skillLine = (item: Skill) => item.summary || item.description;

const DONE = new Set(["applied", "failed", "rejected", "cancelled"]);
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
type AbilityRuntime = { status?: string; text?: string; error?: string; secrets?: Record<string, boolean> };

/** How a capability is doing, as the side list says it: an automation by whether it runs (what its
 *  program says of itself, such as 已连接), not only by being switched on. */
export function abilityState(item: { status: string; kind: string }, runtime?: AbilityRuntime): { label: string; tone: string; title?: string } {
  if (item.status === "disabled") return { label: "已停用", tone: "muted" };
  if (item.status !== "active") return { label: "检查未通过", tone: "failed" };
  if (item.kind !== "automation") return { label: "可用", tone: "active" };
  if (runtime?.secrets && Object.values(runtime.secrets).some(given => !given)) return { label: "待配置", tone: "muted" };
  if (runtime?.status === "running") return { label: runtime.text || "运行中", tone: "active" };
  if (runtime?.status === "error") return { label: "出错", tone: "failed", title: runtime.error || runtime.text };
  if (runtime?.status === "starting" || runtime?.status === "restarting") return { label: "启动中", tone: "muted" };
  return { label: runtime ? "未运行" : "已启用", tone: "muted" };
}

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

/** The conversation a job belongs to: its own record, else its task's, else itself (engineer.thread_of). */
export function threadOf(job: Pick<EngineerJob, "thread_id" | "run_id" | "id">): string {
  return job.thread_id || (job.run_id ? `task:${job.run_id}` : job.id);
}

type Thread = { id: string; jobs: EngineerJob[]; run?: RunRef; started: string; updated: string };

function threads(jobs: EngineerJob[], runs: RunRef[]): Thread[] {
  const groups = new Map<string, EngineerJob[]>();
  for (const job of jobs) groups.set(threadOf(job), [...(groups.get(threadOf(job)) ?? []), job]);
  return [...groups.entries()].map(([id, items]) => {
    const sorted = [...items].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const runId = id.startsWith("task:") ? id.slice(5) : sorted[0].run_id;
    return { id, jobs: sorted, run: runs.find(run => run.id === runId), started: sorted[0].created_at,
      updated: sorted.map(job => job.updated_at).sort().at(-1)! };
  }).sort((a, b) => b.updated.localeCompare(a.updated));
}

function threadTitle(thread: Thread): string {
  // A task's conversation is named by its task; once the task is gone, by its first piece of work.
  if (thread.run) {
    const name = thread.run.plan.title || thread.run.plan.summary.split(/[，。；,.]/)[0];
    return name.length > 24 ? `${name.slice(0, 23)}…` : name;
  }
  return headlineOf(thread.jobs[0]);
}

/** Whether a conversation mentions ``needle``: its name, its work's names, what was asked and what came of it. */
function matches(thread: Thread, needle: string): boolean {
  const text = [threadTitle(thread), thread.run?.plan.summary, ...thread.jobs.flatMap(job => [headlineOf(job), job.title, job.request, job.plain, job.report])]
    .filter(Boolean).join("\n").toLowerCase();
  return text.includes(needle);
}

function threadSource(thread: Thread): string {
  return thread.id.startsWith("task:") ? (thread.run ? "来自任务" : "来自已删除的任务") : "你发起";
}

function threadState(thread: Thread): { label: string; tone: string } {
  if (thread.jobs.some(job => ENGINEER_WAITING.has(job.status))) return { label: "等你点头", tone: "warn" };
  if (thread.jobs.some(job => !DONE.has(job.status))) return { label: "进行中", tone: "busy" };
  return ENGINEER_STATUS[thread.jobs.at(-1)!.status] ?? { label: thread.jobs.at(-1)!.status, tone: "muted" };
}

// Conversations the 平台 page lists; older ones are in 全部记录.
const SHOWN_THREADS = 6;
// Capabilities and skills the side panel lists; 更多 shows them all.
const SIDE_ITEMS = 5;

export function PlatformHome({ apiBase, runs, onOpenRun, onRecords, onCapabilities, onSkills, openThread = null, visit = 0 }: {
  apiBase: string; runs: RunRef[]; onOpenRun: (id: string) => void;
  onRecords: (jobId?: string) => void; onCapabilities: () => void; onSkills: () => void; openThread?: string | null;
  // Changes when 平台 is picked again in the sidebar: back to the page itself, out of any conversation.
  visit?: number;
}) {
  const { jobs, act, available } = useEngineerJobs(apiBase, null, "", true);
  const engineerOn = has(useProvided(), "engineer");
  const [capabilities, setCapabilities] = useState<Capability[]>([]), [skills, setSkills] = useState<Skill[]>([]);
  const [running, setRunning] = useState<Record<string, AbilityRuntime>>({});
  useEffect(() => {
    fetch(`${apiBase}/api/capabilities`).then(r => r.ok ? r.json() : []).then(list => Array.isArray(list) && setCapabilities(list)).catch(() => {});
    fetch(`${apiBase}/api/capabilities/runtime`).then(r => r.ok ? r.json() : null).then(found => found?.capabilities && setRunning(found.capabilities)).catch(() => {});
    fetch(`${apiBase}/api/skills`).then(r => r.ok ? r.json() : []).then(list => Array.isArray(list) && setSkills(list)).catch(() => {});
  }, [apiBase]);
  const waiting = jobs.filter(job => ENGINEER_WAITING.has(job.status));
  const all = threads(jobs, runs);
  const [openId, setOpenId] = useState<string | null>(openThread), [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const found = needle ? all.filter(thread => matches(thread, needle)) : all.slice(0, SHOWN_THREADS);
  useEffect(() => { if (openThread) setOpenId(openThread); }, [openThread]);
  const seenVisit = useRef(visit);
  useEffect(() => { if (visit !== seenVisit.current) { seenVisit.current = visit; setOpenId(null); setQuery(""); } }, [visit]);
  const open = all.find(thread => thread.id === openId);
  return <div className="platform-page">
    <section className="platform-main">
      {open ? <>
        <button type="button" className="platform-back" onClick={() => setOpenId(null)}>← 平台</button>
        <ThreadView engineerOn={engineerOn} thread={open} title={threadTitle(open)} act={act} available={available} runs={runs} onOpenRun={onOpenRun} onRecords={onRecords} />
      </> : <div className="platform-home">
        <div className="platform-greeting"><span className="platform-greeting-mark" aria-hidden="true"><Icon name="wrench" size={26} /></span>
          <h2>{engineerOn ? "要平台加什么能力、修什么问题？" : "平台"}</h2></div>
        {!engineerOn ? <p className="chat-off" role="note">平台工程师能力已停用。在右侧「能力」里可以启用。</p> : <>
        {!available && <p className="error">平台工程师不可用：平台自修复没有启用，或这里没有可编辑的平台源码。</p>}
        <PlatformComposer act={act} disabled={!available} />
        <p className="platform-hint">平台工程师先在副本里改，测试通过、你点头才生效。</p>
        {waiting.map(job => <Pending key={job.id} job={job} act={act} onRevise={() => setOpenId(threadOf(job))} />)}
        </>}
      </div>}
    </section>
    <aside className="platform-side" aria-label="平台现在能做的">
      <div className="platform-side-head"><h3>能力 <small>{capabilities.length}</small></h3><button type="button" className="platform-link" onClick={onCapabilities}>更多 ›</button></div>
      <ul className="platform-abilities">
        {capabilities.slice(0, SIDE_ITEMS).map(item => <li key={item.id}>
          <button type="button" onClick={onCapabilities}>
            <span className="platform-ability-icon"><Icon name={item.kind === "automation" ? "activity" : "wrench"} size={15} /></span>
            <span className="platform-ability-text"><b>{item.name}</b><small>{item.summary}</small></span>
            {(state => <span className={`platform-ability-status ${state.tone}`} title={state.title}>{state.label}</span>)(abilityState(item, running[item.id]))}
          </button>
        </li>)}
        {!capabilities.length && <li className="muted">还没有。任务做出可复用的代码后，在结果页「固化」，它就带着说明书出现在这里。</li>}
      </ul>
      <div className="platform-side-head"><h3>技能 <small>{skills.length}</small></h3><button type="button" className="platform-link" onClick={onSkills}>更多 ›</button></div>
      <ul className="platform-abilities">
        {skills.slice(0, SIDE_ITEMS).map(item => <li key={item.name}>
          <button type="button" onClick={onSkills}>
            <span className="platform-ability-icon"><Icon name="file" size={15} /></span>
            <span className="platform-ability-text"><b>{item.name}</b><small title={item.description}>{skillLine(item)}</small></span>
          </button>
        </li>)}
        {!skills.length && <li className="muted">还没有。</li>}
      </ul>
      <div className="platform-side-head"><h3>最近的对话 <small>{all.length}</small></h3>
        {openId && <button type="button" className="platform-link" onClick={() => setOpenId(null)}>新对话</button>}</div>
      {all.length > 0 && <label className="platform-search"><Icon name="search" size={14} />
        <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索对话" aria-label="搜索对话" /></label>}
      <div className="platform-threads" aria-label="对话列表">
        {found.map(thread => {
          const state = threadState(thread);
          return <button type="button" key={thread.id} className="platform-thread-row" aria-pressed={thread.id === openId} onClick={() => setOpenId(thread.id)}>
            <span className="platform-thread-main"><b>{threadTitle(thread)}</b>
              <small>{threadSource(thread)} · {thread.jobs.length} 项 · {headlineOf(thread.jobs.at(-1)!)}</small></span>
            <span className="platform-thread-side"><span className={`platform-thread-state ${state.tone}`}>{state.label}</span>
              <small className="platform-thread-date">{short(thread.updated)}</small></span>
          </button>;
        })}
        {!all.length && <p className="muted">还没有。</p>}
        {!!all.length && needle && !found.length && <p className="muted">没有匹配的对话。</p>}
      </div>
      <button type="button" className="platform-link" onClick={() => onRecords()}>全部 {jobs.length} 条记录 ›</button>
    </aside>
  </div>;
}

/** 技能: every skill the steps know, as cards (平台 → 技能 → 更多). */
export function SkillsPage({ apiBase }: { apiBase: string }) {
  const [skills, setSkills] = useState<Skill[] | null>(null);
  useEffect(() => { fetch(`${apiBase}/api/skills`).then(r => r.ok ? r.json() : []).then(list => setSkills(Array.isArray(list) ? list : [])).catch(() => setSkills([])); }, [apiBase]);
  return <div className="platform-cards" aria-label="技能">
    {(skills ?? []).map(item => <div key={item.name} className="platform-card">
      <span className="platform-card-head"><span className="platform-ability-icon"><Icon name="file" size={15} /></span>
        <b>{item.name}</b><span className="platform-ability-status muted">{item.machine ? "本机" : "平台自带"}</span></span>
      <span className="platform-card-text full" title={item.summary ? item.description : undefined}>{skillLine(item)}</span>
      {!!item.tools.length && <small>涉及：{item.tools.join("、")}</small>}
    </div>)}
    {skills && !skills.length && <div className="platform-card empty"><span className="platform-card-text">还没有技能。</span></div>}
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

/** One conversation: everything said in it, each piece of work followed by what came of it, and
 * the box to go on — a reply to what waits for you, or new work in this conversation. */
function ThreadView({ engineerOn, thread, title, act, available, runs, onOpenRun, onRecords }: {
  engineerOn: boolean; thread: Thread; title: string; act: (path: string, body?: unknown) => Promise<string | null>; available: boolean;
  runs: RunRef[]; onOpenRun: (id: string) => void; onRecords: (jobId?: string) => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  const said = thread.jobs.reduce((count, job) => count + (job.messages?.length ?? 0), 0);
  useEffect(() => { end.current?.scrollIntoView?.({ block: "end" }); }, [said, thread.id]);
  const waiting = thread.jobs.find(job => ENGINEER_WAITING.has(job.status));
  let shownDay = "";
  return <>
    <header className="platform-head">
      <h2>{title}</h2>
      <p>{thread.run ? <>来自任务 <button type="button" className="link-button" onClick={() => onOpenRun(thread.run!.id)}>「{thread.run.plan.title || thread.run.plan.summary.slice(0, 30)}」</button> · </> : `${threadSource(thread) === "你发起" ? "你发起的对话" : "来自已删除的任务"} · `}{thread.jobs.length} 项工作</p>
    </header>
    <div className="platform-thread" aria-label="对话内容">
      {thread.jobs.map(job => <React.Fragment key={job.id}>
        {(job.messages ?? []).map((message, index) => {
          const thisDay = day(message.created_at), divider = thisDay !== shownDay;
          shownDay = thisDay;
          return <React.Fragment key={index}>{divider && <p className="platform-day">{thisDay}</p>}
            <Message job={job} message={message} runs={runs} onOpenRun={onOpenRun} /></React.Fragment>;
        })}
        {DONE.has(job.status) && <Result job={job} onRecords={onRecords} />}
        {WORKING[job.status] && <p className="platform-working"><span className="dx-typing" aria-hidden="true"><i /><i /><i /></span>{headlineOf(job)} · {WORKING[job.status]}</p>}
        {engineerOn && ENGINEER_WAITING.has(job.status) && <Pending job={job} act={act} onRevise={() => document.querySelector<HTMLTextAreaElement>(".platform-composer textarea")?.focus()} />}
      </React.Fragment>)}
      <div ref={end} />
    </div>
    {engineerOn ? <PlatformComposer act={act} disabled={!available} replyTo={waiting} threadId={thread.id} />
      : <p className="chat-off" role="note">平台工程师能力已停用，这段对话只能查看。</p>}
  </>;
}

/** What came of a piece of work, in one line; the engineer's technical report folded inside. */
function Result({ job, onRecords }: { job: EngineerJob; onRecords: (jobId?: string) => void }) {
  const status = ENGINEER_STATUS[job.status] ?? { label: job.status, tone: "muted" };
  const facts = [
    `${verb(job)}：${headlineOf(job)}`,
    ...(job.files?.length ? [`改了 ${job.files.length} 个文件`] : []),
    ...(job.status === "applied" && job.checks?.length ? ["测试全部通过"] : []),
  ];
  return <details className={`platform-result ${job.status}`}>
    <summary><span className={`platform-result-status ${status.tone}`}>● {status.label}</span><span className="platform-result-facts">{facts.join(" · ")}</span>
      <span className="platform-result-more" aria-hidden="true">›</span></summary>
    <div className="platform-result-body">
      {job.report && <MarkdownView text={job.report} />}
      {!!job.files?.length && <p className="platform-result-line">改动的文件：{job.files.map(file => <code key={file}>{file}</code>)}</p>}
      {!!job.checks?.length && <p className="platform-result-line">检查通过：{job.checks.map(check => CHECKS[check] ?? check).join("、")}</p>}
      {job.commit && <p className="platform-result-line">已提交到 git：<code>{job.commit.slice(0, 8)}</code>（没有推送）</p>}
      {job.error && <p className="error">{job.error}</p>}
      <button type="button" className="link-button" onClick={() => onRecords(job.id)}>在全部记录里打开 ›</button>
    </div>
  </details>;
}

function Message({ job, message, runs, onOpenRun }: { job: EngineerJob; message: EngineerMessage; runs: RunRef[]; onOpenRun: (id: string) => void }) {
  if (message.role === "system") return <p className="platform-system">{message.text} · {when(message.created_at)}</p>;
  const text = message.text.replace(/^@平台工程师\s*/, "");
  if (message.role === "user") return <div className="platform-me">{!(text === "（见附件）" && message.attachments?.length) && <Folded text={text} plain />}<SentFiles attachments={message.attachments} /><small>{when(message.created_at)}</small></div>;
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
  const body = plain ? <p>{text}</p> : <MarkdownView text={text} />;
  if (text.length <= LONG_MESSAGE || open) return <div className="platform-text">{body}</div>;
  // Folded, it is the same message cut to its first lines, formatting and all.
  return <div className="platform-text folded"><div className="platform-text-clip">{body}</div>
    <button type="button" className="link-button" onClick={() => setOpen(true)}>展开</button></div>;
}

/** The box at the foot: a new request, or a reply to what waits for the user. */
function PlatformComposer({ act, replyTo, threadId, disabled }: {
  act: (path: string, body?: unknown) => Promise<string | null>; replyTo?: EngineerJob; threadId?: string; disabled: boolean;
}) {
  const [text, setText] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const box = useRef<HTMLTextAreaElement>(null), files = useAttachments(API_BASE);
  // A reply may be files alone; a new request says what it is for.
  const ready = (!!text.trim() || (!!replyTo && files.ids.length > 0)) && !files.uploading;
  async function submit(event: FormEvent) {
    event.preventDefault();
    const said = text.trim(), attached = files.ids.length ? { attachments: files.ids } : {};
    if (!ready || busy) return;
    setBusy(true); setError("");
    const problem = replyTo
      ? await act(`/api/engineer/jobs/${encodeURIComponent(replyTo.id)}/reply`, { text: said, ...attached })
      : await act("/api/engineer/jobs", { request: said, kind: kindOf(said), ...(threadId ? { thread_id: threadId } : {}), ...attached });
    setBusy(false);
    if (problem) setError(problem); else { setText(""); files.clear(); }
  }
  function keys(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
  }
  return <form className="platform-composer" onSubmit={submit} aria-label="给平台工程师留言">
    {replyTo && <p className="platform-reply-to">回复「{headlineOf(replyTo)}」</p>}
    <div className="platform-input" {...takesFiles(files)}>
      <AttachmentTray attachments={files} />
      <textarea ref={box} aria-label="给平台工程师的消息" rows={2} maxLength={20000} value={text} disabled={disabled || busy}
        onChange={event => setText(event.target.value)} onKeyDown={keys}
        placeholder={replyTo ? "写下要改的地方，或回答它的问题…" : threadId ? "接着说…" : "跟平台工程师说要加什么、修什么…（开始一段新对话）"} />
      <div className="platform-input-bar">
        <ClipButton onFiles={files.add} />
        <button type="submit" className="primary send-button" disabled={disabled || busy || !ready} title="Ctrl + Enter" aria-label="发送">
          {busy || files.uploading ? <span>{files.uploading ? "上传中…" : "发送中…"}</span> : <><Icon name="arrowUp" /><span className="sr-only">发送</span></>}</button>
      </div>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
  </form>;
}
