import React, { FormEvent, useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { CapabilityShelf } from "./capabilities";
import { PlatformHome, SkillsPage, headlineOf } from "./platform";
import { detailText } from "./mission-history";
import { MarkdownView } from "./markdown";
import { Composer, when, type Diagnosis } from "./diagnosis";

export type EngineerMessage = { role: "user" | "engineer" | "lead" | "system"; text: string; created_at: string };
export type EngineerJob = {
  id: string; kind: "repair" | "component"; origin: "user" | "lead" | "diagnosis" | "retrospective"; title: string; request: string;
  headline?: string; plan_plain?: string; plain?: string; thread_id?: string | null;
  status: string; plan?: string | null; report?: string | null; question?: string | null; choices?: string[];
  run_id?: string | null; node_id?: string | null; files?: string[]; checks?: string[]; diff?: string | null;
  commit?: string | null; model_id?: string | null; messages?: EngineerMessage[]; budget_usd: number; cost_usd: number;
  error?: string | null; created_at: string; updated_at: string; finished_at?: string | null;
};
export type EngineerOverview = { available: boolean; working_on?: string | null; pending?: string | null; jobs: EngineerJob[] };
type RunRef = { id: string; plan: { summary: string; title?: string } };

export const ENGINEER_STATUS: Record<string, { label: string; tone: string }> = {
  queued: { label: "排队中", tone: "busy" }, planning: { label: "写方案中", tone: "busy" },
  plan_ready: { label: "方案待批准", tone: "warn" }, editing: { label: "修改中", tone: "busy" },
  validating: { label: "检查中", tone: "busy" }, ready: { label: "改动待应用", tone: "warn" },
  needs_input: { label: "等你回复", tone: "warn" }, applying: { label: "生效中", tone: "busy" },
  applied: { label: "已生效", tone: "ok" }, failed: { label: "没有完成", tone: "bad" },
  rejected: { label: "已放弃", tone: "muted" }, cancelled: { label: "已取消", tone: "muted" },
};
const KIND = { repair: "修复", component: "组件" } as const;
const WAITING = new Set(["plan_ready", "ready", "needs_input"]);
const DONE = new Set(["applied", "failed", "rejected", "cancelled"]);
// The checks the engineer's changes pass, in the user's words.
const CHECKS: Record<string, string> = {
  "Python syntax": "语法检查", "Existing database compatibility": "旧数据兼容", "Backend tests": "后端测试",
  "Frontend tests": "前端测试", "Frontend build": "前端构建",
};
const ORIGIN = { user: "你提出", lead: "负责人请求", diagnosis: "任务诊断发起", retrospective: "任务复盘改进" } as const;
const SPEAKER: Record<string, string> = { user: "你", engineer: "平台工程师", lead: "负责人", system: "系统" };

/** A job's title as plain text: titles come from the first line of a request or report, which may be Markdown. */
function plainTitle(job: EngineerJob) {
  return (job.title || job.request.slice(0, 60) || "平台改动").replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
}

/** Jobs waiting for the user: a plan to approve, a change to apply, or a question. */
export function waitingJobs(jobs: EngineerJob[] = []) {
  return jobs.filter(job => job.status === "plan_ready" || job.status === "ready" || job.status === "needs_input").length;
}

type Act = (path: string, body?: unknown) => Promise<string | null>;

/** The platform engineer: ask it for a repair or a component, approve its plans and changes. */
export function EngineerPage({ apiBase, runs, focusId, onOpenRun }: {
  apiBase: string; runs: RunRef[]; focusId?: string | null; onOpenRun: (id: string) => void;
}) {
  const [data, setData] = useState<EngineerOverview | null>(null), [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(focusId ?? null);
  const revision = useRef(0);
  async function load() {
    const mine = revision.current;
    try {
      const response = await fetch(`${apiBase}/api/engineer`);
      if (!response.ok) throw new Error(`读取失败（${response.status}）`);
      const body = await response.json() as EngineerOverview;
      if (mine === revision.current) { setData(body); setError(""); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  }
  useEffect(() => { load(); const timer = setInterval(load, 2000); return () => clearInterval(timer); }, []);
  useEffect(() => { if (focusId) setSelectedId(focusId); }, [focusId]);
  const jobs = data?.jobs ?? [];
  const selected = jobs.find(job => job.id === selectedId) ?? jobs[0] ?? null;
  const act: Act = async (path, body) => {
    try {
      const response = await fetch(`${apiBase}/api/engineer/${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) return detailText(result.detail) || `操作失败（${response.status}）`;
      revision.current++;
      if (result?.id) {
        setData(current => current ? { ...current, jobs: current.jobs.some(job => job.id === result.id)
          ? current.jobs.map(job => job.id === result.id ? result : job) : [result, ...current.jobs] } : current);
        setSelectedId(result.id);
      }
      await load();
      return null;
    } catch (failure) { return failure instanceof Error ? failure.message : String(failure); }
  };
  const waiting = jobs.filter(job => WAITING.has(job.status));
  const active = jobs.filter(job => !DONE.has(job.status) && !WAITING.has(job.status));
  const applied = jobs.filter(job => job.status === "applied");
  const others = jobs.filter(job => DONE.has(job.status) && job.status !== "applied");
  // Opening the page shows what the platform can do; work that needs you or is under way shows the records.
  // The page opens on the conversation with the engineer (PlatformHome); all records and the
  // capabilities' management are a click away, and a job opened from a task shows its record.
  type View = "home" | "capabilities" | "skills" | "records";
  const [tab, setTab] = useState<View>(focusId ? "records" : "home");
  useEffect(() => { if (focusId) setTab("records"); }, [focusId]);
  const pick = (next: View) => setTab(next);
  const open = (id: string) => { setSelectedId(id); pick("records"); };
  const row = (job: EngineerJob) => <button type="button" key={job.id} aria-pressed={selected?.id === job.id} onClick={() => setSelectedId(job.id)}>
    <span className="engineer-list-title">{headlineOf(job)}</span>
    <span className="engineer-list-meta"><StatusChip status={job.status} /><span>{KIND[job.kind]} · {ORIGIN[job.origin]} · {when(job.created_at)}</span></span>
  </button>;
  if (tab === "home") return <PlatformHome apiBase={apiBase} runs={runs} onOpenRun={onOpenRun}
    onRecords={jobId => { if (jobId) setSelectedId(jobId); pick("records"); }} onCapabilities={() => pick("capabilities")} onSkills={() => pick("skills")} />;
  return <div className="engineer-page">
    <button type="button" className="platform-back" onClick={() => pick("home")}>← 平台</button>
    <header className="engineer-head"><h2>{tab === "records" ? "全部记录" : tab === "skills" ? "技能" : "能力"}</h2>
      {tab !== "records" && <p>{tab === "skills" ? "它知道怎么用的工具：每份是一本用法说明，步骤用到相应工具时会拿到。" : "任务做出来、你固化下来的代码和说明书，之后的任务会直接用。"}</p>}</header>
    {error && <p className="error" role="alert">{error}</p>}
    {tab === "skills" ? <SkillsPage apiBase={apiBase} /> : tab === "capabilities" ? <CapabilityShelf apiBase={apiBase} runs={runs} onOpenRun={onOpenRun} /> : <div className="engineer-layout">
      <nav className="engineer-list" aria-label="平台工程师的工作">
        {!jobs.length && <p className="empty">还没有记录。</p>}
        {!!(waiting.length + active.length) && <><h4>进行中</h4>{[...waiting, ...active].map(row)}</>}
        {!!applied.length && <><h4>已生效</h4>{applied.map(row)}</>}
        {!!others.length && <details className="engineer-others"><summary>未完成或放弃 · {others.length}</summary>{others.map(row)}</details>}
      </nav>
      {selected ? <JobDetail job={selected} working={data?.working_on === selected.id} runs={runs} act={act} onOpenRun={onOpenRun} />
        : <section className="engineer-job empty big">还没有记录。</section>}
    </div>}
  </div>;
}

function StatusChip({ status }: { status: string }) {
  const known = ENGINEER_STATUS[status] ?? { label: status, tone: "ok" };
  return <span className={`dx-chip ${known.tone}`}>{known.tone === "busy" && <i className="pulse" aria-hidden="true" />}{known.label}</span>;
}

function JobDetail({ job, working, runs, act, onOpenRun }: {
  job: EngineerJob; working: boolean; runs: RunRef[]; act: Act; onOpenRun: (id: string) => void;
}) {
  const [busy, setBusy] = useState(""), [error, setError] = useState("");
  const run = job.run_id ? runs.find(item => item.id === job.run_id) : undefined;
  async function post(action: string, label: string) {
    setBusy(label); setError("");
    const problem = await act(`jobs/${encodeURIComponent(job.id)}/${action}`);
    setBusy(""); if (problem) setError(problem);
  }
  const reply = (_id: string, body: { text: string; choice?: string }) => act(`jobs/${encodeURIComponent(job.id)}/reply`, body);
  const open = !["applied", "failed", "rejected", "cancelled", "applying"].includes(job.status);
  // The first message usually repeats the request shown above, and the engineer's last its report.
  const history = (job.messages ?? []).filter(message => ![job.request, job.report ?? ""].some(text => message.text.trim() === text.trim()));
  return <section className="engineer-job" aria-label="工作详情">
    <div className="engineer-job-head">
      <div className="engineer-job-title"><h3 title={plainTitle(job)}>{plainTitle(job)}</h3><StatusChip status={job.status} /></div>
      <p className="engineer-job-meta">{KIND[job.kind]} · {ORIGIN[job.origin]}{job.model_id ? ` · ${job.model_id}` : ""} · 花费 ${job.cost_usd.toFixed(4)}</p>
      {job.run_id && <p className="engineer-job-source"><span>来自任务</span>
        {run ? <button type="button" className="link" title={run.plan.summary} onClick={() => onOpenRun(job.run_id!)}>{run.plan.summary}</button> : <em>已删除（{job.run_id}）</em>}
        {job.origin === "lead" && <small>结束后结果会交回负责人，由它决定那一步怎么办。</small>}</p>}
    </div>
    <details className="engineer-request-text" open={!job.plan}><summary>需求</summary><div className="engineer-request-body"><MarkdownView text={job.request} /></div></details>
    {working && <p className="diagnosis-running"><span className="dx-typing" aria-hidden="true"><i /><i /><i /></span>
      {job.status === "planning" ? "平台工程师正在读代码、写方案…" : job.status === "validating" ? "正在独立运行测试和构建…" : "平台工程师正在修改源码副本…"}</p>}
    {job.plan && <div className="engineer-section"><h4>方案</h4><div className="dx-report"><MarkdownView text={job.plan} /></div></div>}
    {job.status === "plan_ready" && <div className="engineer-actions">
      <button type="button" className="primary" disabled={!!busy} onClick={() => post("approve", "approve")}>{busy === "approve" ? "提交中…" : "批准方案，开始实施"}</button>
      <button type="button" className="ghost" disabled={!!busy} onClick={() => post("reject", "reject")}>放弃</button>
    </div>}
    {job.report && <div className="engineer-section"><h4>{job.status === "applied" ? "结果" : "工程师的报告"}</h4><div className="dx-report"><MarkdownView text={job.report} /></div></div>}
    {!!job.files?.length && <div className="engineer-section"><h4>改动的文件</h4><ul className="engineer-files">{job.files.map(file => <li key={file}><code>{file}</code></li>)}</ul>
      {!!job.checks?.length && <p className="engineer-checks">检查通过：{job.checks.map(check => CHECKS[check] ?? check).join("、")}</p>}
      {job.diff && <details className="engineer-diff"><summary>查看改动内容</summary><pre>{job.diff}</pre></details>}</div>}
    {job.status === "ready" && <div className="engineer-actions">
      <button type="button" className="primary" disabled={!!busy} onClick={() => post("approve", "apply")}>{busy === "apply" ? "提交中…" : "应用这项改动"}</button>
      <button type="button" className="ghost" disabled={!!busy} onClick={() => post("reject", "reject")}>放弃</button>
      <small className="muted">应用时会等进行中的模型调用结束，再重启服务。</small>
    </div>}
    {job.commit && <p className="engineer-checks">已提交到 git：<code>{job.commit.slice(0, 8)}</code>（没有推送）</p>}
    {job.error && <p className="error">{job.error}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {!!history.length && <details className="engineer-section engineer-history-box" open={open}><summary>经过 · {history.length}</summary><ol className="engineer-history">
      {history.map((message, index) => <li key={index} className={`engineer-msg ${message.role}`}>
        <small>{SPEAKER[message.role] ?? message.role} · {when(message.created_at)}</small>
        <div>{message.role === "engineer" ? <MarkdownView text={message.text} /> : <p>{message.text}</p>}</div>
      </li>)}
    </ol></details>}
    {(job.status === "plan_ready" || job.status === "ready" || job.status === "needs_input") && <Composer
      item={{ id: job.id, trigger: "engineer", status: "done", created_at: job.created_at, question: job.question, choices: job.choices ?? [] } satisfies Diagnosis}
      waiting={job.status === "needs_input"} disabled={false} onReply={reply}
      sendLabel={job.status === "needs_input" ? "回复" : job.status === "plan_ready" ? "按这个意见改方案" : "按这个意见再改"}
      placeholder={job.status === "needs_input" ? "回答工程师的问题" : "写下要改的地方"} />}
    {open && job.status !== "plan_ready" && job.status !== "ready" && <div className="engineer-actions">
      <button type="button" className="ghost" disabled={!!busy} onClick={() => post("reject", "reject")}>{busy === "reject" ? "提交中…" : "放弃这项工作"}</button>
    </div>}
  </section>;
}
