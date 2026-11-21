// The platform engineer: changes to Super Partner itself, as jobs (EngineerJob,
// docs/design/platform-engineer.md). The user asks for a repair or a component; a task's lead may ask
// for a component. A component is planned first and the user approves the plan; every change is made in
// an isolated copy and checked (platform-repair.ts), and applied by a restart (self-repair.ts), a
// component only once the user approves it. Repairs a task's diagnosis makes stay in that task
// (SelfRepair.fixPlatform) and are only recorded here.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import * as activity from "./activity.js";
import { BudgetExceeded, RequestBudget } from "./budget.js";
import { settings } from "./config.js";
import { interaction, OPTIONS_LINES, QUESTION_LINES } from "./diagnosis.js";
import { nowIso } from "./lax.js";
import { type Attachment, type Diagnosis, ENGINEER_DONE, ENGINEER_WAITING, type EngineerJob, EngineerJobSchema, EngineerMessageSchema, type ExecutionRun,
  type TaskNode } from "./models.js";
import { COMPONENT_GUIDES, RepairError, type RepairJob, REPAIR_GUIDES, repairGuide } from "./platform-repair.js";
import type { ProviderResult, SpendOk } from "./providers.js";
import { AsyncEvent, fixed, head, pyRegex, pyRound, splitlines, tail } from "./py.js";
import * as quality from "./quality.js";
import { engineers } from "./routing.js";
import { SelfRepair } from "./self-repair.js";
import { ENGINEER_CALLERS, engineerMessage } from "./supervisor.js";
import { currentTask, isCancelled, sleep, Task } from "./tasks.js";

// Models tried in turn when one fails (its usage ran out, say).
export const MAX_ENGINEERS = 3;
// What the user picks to let a job that spent its budget go on; it gets engineer_budget_usd more.
export const MORE_BUDGET = "追加预算，接着做";
export const STOP = "到此为止";
const STATUS = pyRegex(String.raw`^\s*STATUS:\s*(PLAN|FIXED|NEEDS_INPUT)\b`, "im");
// A job in one of these states has the engineer at work on it.
export const WORKING = new Set(["planning", "editing", "validating"]);
export const ROLE = "You are FluidForm's platform engineer: you change FluidForm itself (its backend, web "
  + "UI, tools, skills and model channels), never the user's projects. ";
type Json = Record<string, any>;
const message = (fields: Json) => EngineerMessageSchema.parse(fields);

/** A request the engineer cannot take now; the message is for the user. */
export class EngineerError extends Error {
  override name = "ValueError";
}

const stripChars = (text: string, chars: string) => {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text[start])) start += 1;
  while (end > start && chars.includes(text[end - 1])) end -= 1;
  return text.slice(start, end);
};

export function titleOf(request: string): string {
  const first = splitlines(request).find((item) => item.trim());
  const line = first === undefined ? "" : stripChars(first, " #-*");
  return head(line, 40) + ([...line].length > 40 ? "…" : "");
}

const PLAIN = pyRegex(String.raw`^\s*(HEADLINE|PLAIN)\s*[:：]\s*(.+?)\s*$`, "mg");
// A short name and a line or two for the user, before the engineer's own report.
export const plainRule = (what: string) => "Begin your reply with two lines for the user, in plain Chinese, without code, file names, line "
  + "numbers or test counts:\nHEADLINE: <what this is, at most 12 characters, such as 步骤结果误判 or 飞书发消息>\n"
  + `PLAIN: <${what}>\nThen write the rest as asked.\n`;

/** [headline, plain words, the rest] of an engineer's reply; "" for lines it did not write. */
export function plainLines(text: string | null | undefined): [string, string, string] {
  const found = new Map<string, string>();
  for (const match of (text || "").matchAll(PLAIN)) found.set(match[1].toUpperCase(), match[2].trim());
  const rest = (text || "").replace(PLAIN, "").trim();
  return [head(found.get("HEADLINE") ?? "", 24), head(found.get("PLAIN") ?? "", 300), rest];
}

// Characters of a conversation's earlier work a job continuing it is told.
export const MAX_THREAD_CONTEXT = 6000;

/** The conversation a job belongs to: its own record, else its task's, else itself (older jobs). */
export function threadOf(job: EngineerJob): string {
  return job.thread_id || (job.run_id ? `task:${job.run_id}` : job.id);
}

/** What was asked and came of it earlier in a conversation, oldest first, the latest kept. */
export function threadContext(jobs: EngineerJob[]): string {
  const lines = [...jobs].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0)).map((job) => {
    const outcome = job.plain || head(job.report || job.error || "", 600);
    return `- 需求：${head(job.request, 800)}\n  结果（${job.status}）：${outcome}`.trimEnd();
  });
  return tail(lines.join("\n"), MAX_THREAD_CONTEXT);
}

const conversation = (job: EngineerJob) => job.messages.slice(-20).map((item) => `${item.role}: ${head(item.text, 2000)}`).join("\n") || "(none)";

export function planPrompt(job: EngineerJob, guide: string): string {
  const asker = job.origin === "lead" ? "The lead of a running task asks for it" : "The user asks for it";
  return "[[super-partner:platform-engineer:plan]]\n" + ROLE
    + "The working directory is an isolated copy of FluidForm's source. Read it to plan the "
    + "change below; do not edit anything yet. Read docs/ARCHITECTURE.md first, then only the code "
    + `you need.\n${asker}:\n${job.request}\n\nConversation so far:\n${conversation(job)}\n`
    + (job.context ? `\nEarlier in this conversation, before this request:\n${job.context}\n` : "")
    + (job.plan ? `\nYour previous plan, which the user wants changed:\n${job.plan}\n` : "")
    + "\n" + plainRule("in two or three short sentences: what you will make or fix, how it will be used, roughly how big the change is")
    + "Write the plan in Chinese, short, for the user to approve:\n"
    + "- 目标: what will work afterwards.\n"
    + "- 改动: each file and what changes in it.\n"
    + "- 测试: the tests you will add and what they prove.\n"
    + "- 风险: what could break, and what is left out.\n"
    + "End with `STATUS: PLAN`. If a choice belongs to the user before you can plan, ask instead:\n"
    + 'QUESTION: <one question>\nOPTIONS: ["<option 1>", "<option 2>"]\nSTATUS: NEEDS_INPUT\n\n'
    + guide;
}

export function editPrompt(job: EngineerJob, guide: string, feedback = ""): string {
  const what = job.kind === "component" ? `Add this component as the approved plan says.\nRequest:\n${job.request}\n\nApproved plan:\n${job.plan}\n`
    : `Repair this defect in FluidForm:\n${job.request}\n`;
  const after = job.kind === "component" ? ", shows the user the change, and applies it once they approve" : ", and applies a passing change";
  return "[[super-partner:platform-engineer:edit]]\n" + ROLE
    + "The working directory is an isolated copy of FluidForm's source; make the change there "
    + "with your file tools. Preserve unrelated existing changes. Add tests that prove the change (for "
    + "a repair, a regression test that fails without it); never weaken or delete existing tests. Do "
    + "not touch task data, credentials, Git history, the live source, or running services. The "
    + `controller then runs the backend tests, frontend tests and build independently${after}.\n\n`
    + what + `\nConversation so far:\n${conversation(job)}\n`
    + (job.context ? `\nEarlier in this conversation, before this request:\n${job.context}\n` : "") + feedback
    + "\n" + plainRule("one or two sentences: what was wrong or wanted, and what works now")
    + "When done, report in Chinese (改了什么, 测试, 验证) and end with `STATUS: FIXED`. If a real "
    + "choice belongs to the user, ask with QUESTION, OPTIONS (a JSON array) and `STATUS: NEEDS_INPUT`.\n\n"
    + guide;
}

/** The engineer's report, its status (plan | fixed | needs_input), and a question with options. */
export function readReply(given: string | null | undefined): [string, string | null, string | null, string[]] {
  const text = given || "";
  const found = STATUS.exec(text);
  let body = found ? text.slice(0, found.index) : text;
  const [question, choices] = interaction(text);
  body = body.replace(OPTIONS_LINES, "").replace(QUESTION_LINES, "").trim();
  return [body, found ? found[1].toLowerCase() : null, question, choices];
}

/** Commit just ``files`` on the checkout's current branch, leaving anything else the user has staged
 *  alone; the new commit's id. */
export function commit(root: string, files: string[], text: string): string {
  const git = (...args: string[]) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 120_000 });
  if (git("rev-parse", "--is-inside-work-tree").status) throw new RepairError("源码目录不是 git 仓库。");
  for (const step of [["add", "-A", "--", ...files], ["commit", "-m", text, "--", ...files]]) {
    const result = git(...step);
    if (result.status) throw new RepairError(tail((result.stderr || result.stdout || "").trim(), 500) || "git 提交失败。");
  }
  return git("rev-parse", "HEAD").stdout.trim();
}

/** What tests replace: committing an applied change. */
export const deps = { commit: (root: string, files: string[], text: string) => commit(root, files, text) };

export type EngineerRequestOptions = { runId?: string | null; nodeId?: string | null; decisionId?: string | null; budgetUsd?: number | null;
  improvementId?: string | null; threadId?: string | null; attachments?: Attachment[] };

export abstract class Engineering extends SelfRepair {
  abstract syncImprovements(): void;

  // --- what the user and the API see ------------------------------------------------------------

  engineerAvailable(): boolean {
    return Boolean(this.platform.enabled && this.platform.root);
  }

  engineerOverview(limit = 30, runId: string | null = null): Json {
    let jobs = this.db.engineerJobs(runId ? 200 : limit);
    if (runId) jobs = jobs.filter((job) => job.run_id === runId);
    return { available: this.engineerAvailable(), working_on: this.engineerTask && !this.engineerTask.done ? this.engineerJobId : null,
      pending: this.platformPending ? this.platformPending.id : null, jobs,
      // Its repairs of this machine are kept in each task (Diagnosis): listed here too.
      environment: runId ? [] : this.environmentRepairs() };
  }

  /** The platform engineer's looks at tasks that did not change FluidForm's source (those are jobs):
   *  repairs of this machine and findings, newest first, from every task. */
  environmentRepairs(limit = 50): Json[] {
    const found: Json[] = [];
    for (const run of this.db.listRuns()) {
      const titles = new Map(run.plan.nodes.map((node) => [node.id, node.title]));
      for (const item of run.diagnoses) {
        if (!(item.trigger in ENGINEER_CALLERS) || item.status === "running" || item.scope === "super_partner") continue;
        found.push({ id: item.id, run_id: run.id, task: run.plan.title || head(run.plan.summary, 40), step: titles.get(item.node_id || "") ?? "",
          trigger: item.trigger, status: item.status, verdict: item.verdict, model_id: item.model_id, summary: head(item.report || item.error || "", 300),
          user_action: item.user_action, created_at: item.created_at });
      }
    }
    return found.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0)).slice(0, limit);
  }

  engineerSave(job: EngineerJob): void {
    job.updated_at = nowIso();
    this.db.saveEngineerJob(job);
  }

  engineerJob(jobId: string): EngineerJob {
    const job = this.db.getEngineerJob(jobId);
    if (!job) throw new EngineerError("找不到这项平台工程师工作。");
    return job;
  }

  /** A new job: a component is planned first, a repair is made at once. It waits its turn. With
   *  ``threadId`` it goes on with that conversation, told what came of it before. */
  engineerRequest(given: string, kind = "component", origin = "user", { runId = null, nodeId = null, decisionId = null, budgetUsd = null, improvementId = null,
    threadId = null, attachments = [] }: EngineerRequestOptions = {}): EngineerJob {
    if (!this.engineerAvailable()) throw new EngineerError("平台工程师不可用：平台自修复未启用，或当前安装没有可编辑的 FluidForm 源码。");
    const request = (given || "").trim();
    if (!request) throw new EngineerError("请写明要修复什么，或要添加什么组件。");
    if (kind !== "repair" && kind !== "component") throw new EngineerError("工作类型只能是修复或添加组件。");
    let context = "";
    let run = runId;
    if (threadId) {
      const earlier = this.db.engineerJobs(1000).filter((item) => threadOf(item) === threadId);
      if (!earlier.length && !threadId.startsWith("task:")) throw new EngineerError("这段对话不存在。");
      context = threadContext(earlier);
      if (threadId.startsWith("task:") && !run) run = threadId.slice(5);
    }
    const job = EngineerJobSchema.parse({ kind, origin, request, title: titleOf(request), thread_id: threadId, context, phase: kind === "component" ? "plan" : "edit",
      run_id: run, node_id: nodeId, decision_id: decisionId, improvement_id: improvementId, budget_usd: budgetUsd ?? settings.engineer_budget_usd, attachments,
      messages: [message({ role: origin === "lead" ? "lead" : "user", text: request, attachments })] });
    this.engineerSave(job);
    this.engineerKick();
    return job;
  }

  /** The user answers a question, or asks for a plan or a change to be redone differently. */
  engineerReply(jobId: string, text: string, choice: string | null = null, attachments: Attachment[] = []): EngineerJob {
    const job = this.engineerJob(jobId);
    let said = [choice, (text || "").trim()].filter(Boolean).join("\n") || (attachments.length ? "（见附件）" : "");
    if (!said) throw new EngineerError("请写下你的回复。");
    if (!ENGINEER_WAITING.has(job.status)) throw new EngineerError("平台工程师现在不在等你回复。");
    if (choice === MORE_BUDGET) {
      job.budget_usd = pyRound(Math.max(job.budget_usd, job.cost_usd) + settings.engineer_budget_usd, 6);
      said += `（预算追加到 $${fixed(job.budget_usd, 2)}）`;
    }
    job.messages.push(message({ role: "user", text: said, attachments }));
    const known = new Set(job.attachments.map((item) => item.id));
    job.attachments.push(...attachments.filter((item) => !known.has(item.id)));
    if (job.status === "plan_ready") job.phase = "plan";
    else if (job.status === "ready") job.phase = "edit";
    job.status = "queued";
    job.question = null;
    job.choices = [];
    this.engineerSave(job);
    this.engineerKick();
    return job;
  }

  /** Approve a plan (the change is then made) or a checked change (it is then applied). */
  engineerApprove(jobId: string): EngineerJob {
    const job = this.engineerJob(jobId);
    if (job.status === "plan_ready") {
      job.messages.push(message({ role: "system", text: "你批准了方案，开始实施。" }));
      job.status = "queued";
      job.phase = "edit";
      this.engineerSave(job);
      this.engineerKick();
      return job;
    }
    if (job.status === "ready") return this.engineerApply(job);
    throw new EngineerError("这项工作现在没有等你批准的方案或改动。");
  }

  /** The user gives the job up; work in progress stops. */
  async engineerReject(jobId: string): Promise<EngineerJob> {
    let job = this.engineerJob(jobId);
    if (ENGINEER_DONE.has(job.status) || job.status === "applying") throw new EngineerError("这项工作已经结束或正在生效，不能放弃。");
    if (this.engineerJobId === jobId && this.engineerTask && !this.engineerTask.done) {
      this.engineerTask.cancel();
      await this.engineerTask.settled();
      job = this.engineerJob(jobId);
    }
    job.messages.push(message({ role: "system", text: "你放弃了这项工作。" }));
    job.status = "rejected";
    this.engineerEnd(job);
    return job;
  }

  /** On API startup: work a restart cut off starts again. */
  restoreEngineer(): void {
    for (const job of this.db.engineerJobs(200)) {
      if (!(WORKING.has(job.status) || (job.status === "applying" && !this.platformPending))) continue;
      if (job.status === "applying") {
        // The restart applied it or not; the platform record says which.
        const record = this.platform.load(job.repair_id);
        if (record && ["activated", "failed", "rolled_back", "cancelled"].includes(record.status)) {
          this.engineerFinished(record);
          continue;
        }
      }
      const copy = job.repair_id ? this.platform.load(job.repair_id) : null;
      const kept = job.phase === "edit" && copy && !this.platform.stale(copy) && this.platform.edited(copy).length;
      job.messages.push(message({ role: "system", text: kept ? "服务重启打断了这项工作；已经改了的保留着，接着做。" : "服务重启打断了这项工作，重新开始。" }));
      job.status = "queued";
      if (job.phase === "edit" && job.kind === "component" && !job.plan) job.phase = "plan";
      this.engineerSave(job);
    }
    this.engineerKick();
  }

  // --- the work -------------------------------------------------------------------------------

  /** Start the next queued job if the engineer is free and no change is waiting to apply. */
  engineerKick(): void {
    if ((this.engineerTask && !this.engineerTask.done) || this.platformPending) return;
    const queued = this.db.engineerJobs(200).filter((job) => job.status === "queued").sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    if (!queued.length) return;
    this.engineerJobId = queued[0].id;
    this.engineerTask = new Task(() => this.engineerRun(queued[0].id));
  }

  private async engineerRun(jobId: string): Promise<void> {
    const job = this.engineerJob(jobId);
    let stopped = false;
    // What it does while it works, shown on its page; kept only meanwhile.
    this.engineerLogs.set(jobId, []);
    try {
      if (job.phase === "plan") await this.engineerPlan(job);
      else await this.engineerEdit(job);
    } catch (error) {
      if (isCancelled(error)) {
        stopped = true;
        throw error;
      }
      job.cost_usd = pyRound(job.cost_usd + (((error as Json)?.accounted_cost_usd as number) ?? 0), 6);
      if (error instanceof BudgetExceeded) {
        // Out of budget: ask whether to go on, where it stopped, instead of failing.
        job.status = "needs_input";
        job.choices = [MORE_BUDGET, STOP];
        job.question = `这项工作已经花了 $${fixed(job.cost_usd, 2)}，预算 $${fixed(job.budget_usd, 2)} 用完了。要追加 $${fixed(settings.engineer_budget_usd, 2)} 接着做吗？`;
        job.messages.push(message({ role: "engineer", text: job.question }));
        this.engineerSave(job);
      } else {
        job.status = "failed";
        job.error = head(String((error as Error)?.message ?? ""), 2000) || (error as Error)?.name || "Error";
        job.messages.push(message({ role: "system", text: `平台工程师没能完成：${head(job.error, 500)}` }));
        this.engineerEnd(job);
      }
    } finally {
      this.engineerLogs.delete(jobId);
      if (this.engineerTask === currentTask()) {
        this.engineerTask = null;
        this.engineerJobId = null;
      }
      if (!stopped) this.engineerKick();
    }
  }

  private async engineerPlan(job: EngineerJob): Promise<void> {
    job.status = "planning";
    this.engineerSave(job);
    const copy = await this.platform.prepare(job.run_id, null);
    let text: string;
    try {
      const source = join(copy.folder, "source");
      text = await this.engineerCall(job, planPrompt(job, repairGuide(source, COMPONENT_GUIDES)), source);
    } finally {
      rmSync(copy.folder, { recursive: true, force: true });
    }
    let [report, status, question, choices] = readReply(text);
    if (status === "needs_input" && question) {
      this.engineerAsk(job, report, question, choices);
      return;
    }
    // Every component change, a retrospective's too, waits for the user's approval of its plan and
    // again before it is applied.
    let headline: string;
    let plain: string;
    [headline, plain, report] = plainLines(report);
    job.headline = headline || job.headline;
    job.plan_plain = plain;
    job.plan = report;
    job.status = "plan_ready";
    job.messages.push(message({ role: "engineer", text: "方案写好了，请看过后批准，或回复要改的地方。" }));
    this.engineerSave(job);
  }

  /** One of the platform's own checks starting (``ok`` null) or ending, in the job's log. */
  private engineerCheckSeen(job: EngineerJob, title: string, ok: boolean | null): void {
    if (!this.engineerLogs.has(job.id)) this.engineerLogs.set(job.id, []);
    const entries = this.engineerLogs.get(job.id)!;
    const entry = { turn: 0, id: `check:${title}`, tool: "check", detail: title, ok, running: ok === null, status: ok === null ? "running" : ok ? "succeeded" : "failed" };
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index].id === entry.id && entries[index].running) {
        entries[index] = entry;
        return;
      }
    }
    entries.push(entry);
  }

  private engineerAsk(job: EngineerJob, report: string, question: string, choices: string[]): void {
    job.status = "needs_input";
    job.question = question;
    job.choices = choices;
    job.messages.push(message({ role: "engineer", text: [report, question].filter(Boolean).join("\n\n") }));
    this.engineerSave(job);
  }

  private async engineerEdit(job: EngineerJob): Promise<void> {
    job.status = "editing";
    this.engineerSave(job);
    let copy = this.platform.load(job.repair_id);
    const fresh = !copy || !["editing", "validating", "validated"].includes(copy.status) || this.platform.stale(copy);
    if (fresh) {
      // A first edit, or the live source has changed since: a fresh copy, so applying it cannot
      // overwrite what changed.
      copy = await this.platform.prepare(job.run_id, null);
      copy.engineer_job_id = job.id;
      this.platform.save(copy);
      job.repair_id = copy.id;
      this.engineerSave(job);
    }
    const source = join(copy!.folder, "source");
    const guide = repairGuide(source, job.kind === "component" ? COMPONENT_GUIDES : REPAIR_GUIDES);
    const done = fresh ? [] : this.platform.edited(copy!);
    // The same copy as before (a restart cut the work off, or the user asked for changes to it): it goes
    // on from what is there instead of starting over.
    let feedback = done.length ? `\nThe copy already has your earlier changes to: ${done.slice(0, 40).join(", ")}. Build on them: `
      + "check what is done and finish what the conversation asks for now; do not start over.\n" : "";
    let report = "";
    let checks: { name: string }[] = [];
    for (let attempt = 0; attempt < settings.platform_repair_attempts; attempt += 1) {
      const text = await this.engineerCall(job, editPrompt(job, guide, feedback), source);
      let status: string | null;
      let question: string | null;
      let choices: string[];
      [report, status, question, choices] = readReply(text);
      if (status === "needs_input" && question) {
        this.engineerAsk(job, report, question, choices);
        return;
      }
      job.status = "validating";
      this.engineerSave(job);
      try {
        checks = await this.platform.check(copy!, (title, ok) => this.engineerCheckSeen(job, title, ok));
        break;
      } catch (error) {
        if (!(error instanceof RepairError) || attempt + 1 === settings.platform_repair_attempts) throw error;
        feedback = `\nThe independent check failed. Fix it and recheck:\n${tail(error.message, 6000)}\n`;
        job.status = "editing";
        this.engineerSave(job);
      }
    }
    job.files = copy!.files;
    job.checks = checks.map((item) => item.name);
    let headline: string;
    let plain: string;
    [headline, plain, report] = plainLines(report);
    job.headline = headline || job.headline;
    job.plain = plain;
    job.diff = this.platform.diff(copy!);
    job.report = report;
    job.error = null;
    job.messages.push(message({ role: "engineer", text: plain || report || "改好了，检查全部通过。" }));
    if (job.kind === "component") {
      job.status = "ready";
      this.engineerSave(job);
      return;
    }
    // A repair applies on its own once checked, after any change already waiting to apply.
    while (this.platformPending) await sleep(1);
    this.engineerApply(job);
  }

  /** One piece of the engineer's work on the strongest model that can edit files (membership CLIs
   *  first), the next one when it fails; charged to the job's own budget. */
  private async engineerCall(job: EngineerJob, prompt: string, workspace: string): Promise<string> {
    const configured = this.providers.configuredModels ? this.providers.configuredModels(Object.keys(this.modelLookup)) : new Set<string>();
    const candidates = engineers(Object.values(this.modelLookup), configured).slice(0, MAX_ENGINEERS);
    if (!candidates.length) throw new RepairError("没有可用、并且能修改文件的模型来做这项工作。");
    let last: unknown = null;
    // A CLI's commands, file changes and messages as it prints them (activity.ts), an API model's tool
    // calls as it makes them: the same log its page shows.
    if (!this.engineerLogs.has(job.id)) this.engineerLogs.set(job.id, []);
    const entries = this.engineerLogs.get(job.id)!;
    for (const model of candidates) {
      job.model_id = model.id;
      this.engineerSave(job);
      try {
        const result = await activity.recording(entries, () => this.engineerCharged(job, model.id, (budget) => this.providers.complete(model.id, prompt, {
          workspace, spend_ok: budget, cli_timeout: settings.repair_call_minutes * 60, attachments: job.attachments, allow_api_fallback: false,
          act: model.channel !== "cli", repair: false, tool_log: entries, signal: currentTask()?.signal })));
        return result.text;
      } catch (error) {
        if (isCancelled(error) || error instanceof BudgetExceeded) throw error;
        last = error;
        job.messages.push(message({ role: "system", text: `${model.id} 没能完成，换下一个模型：${head(String((error as Error)?.message ?? error), 200)}` }));
        this.engineerSave(job);
      }
    }
    throw new RepairError(`所有可用模型都没能完成：${(last as Error)?.message ?? last}`);
  }

  private async engineerCharged(job: EngineerJob, modelId: string, call: (budget: SpendOk) => Promise<ProviderResult>) {
    // A job's budget is checked before each piece of its work, not only within an API model's turns: a
    // membership CLI's call is charged only once it ends.
    if (job.budget_usd - job.cost_usd <= 0) throw new BudgetExceeded(`已花 $${fixed(job.cost_usd, 2)}，预算 $${fixed(job.budget_usd, 2)} 用完了`);
    const charge = async (cost: number) => {
      if (cost) {
        job.cost_usd = pyRound(job.cost_usd + cost, 6);
        this.engineerSave(job);
      }
    };
    const budget = Object.assign(new RequestBudget({ models: this.modelLookup, remaining: () => job.budget_usd - job.cost_usd, reservations: new Map(), charge,
      changed: new AsyncEvent() }), { context: { run_id: job.run_id, purpose: "platform_engineer" } });
    try {
      const result = await call(budget as unknown as SpendOk);
      await charge(Math.max(0, this.actualCost(result, null, modelId) - budget.spent));
      return result;
    } catch (error) {
      const usage = (error as Json)?.usage;
      if (usage) await charge(Math.max(0, this.actualCost(usage, null, modelId) - budget.spent));
      throw error;
    } finally {
      budget.release();
    }
  }

  // --- applying, and what follows -------------------------------------------------------------

  /** Apply a checked change by a restart (SelfRepair.activatePlatform). */
  engineerApply(job: EngineerJob): EngineerJob {
    if (this.platformPending) throw new EngineerError("已有一项平台改动正在等待生效，请等它完成后再应用。");
    const copy = this.platform.load(job.repair_id);
    if (!copy || copy.status !== "validated") throw new EngineerError("这份改动还没有通过检查，不能应用。");
    if (this.platform.stale(copy)) {
      job.messages.push(message({ role: "system", text: "FluidForm 的源码在这期间有了更新，直接应用会覆盖它。平台工程师会在新的副本上按同样的要求重做，检查通过后"
        + (job.kind === "component" ? "再请你确认。" : "自动生效。") }));
      job.status = "queued";
      job.phase = "edit";
      this.engineerSave(job);
      this.engineerKick();
      return job;
    }
    Object.assign(copy, { report: job.report || "", model_id: job.model_id, engineer_job_id: job.id });
    job.status = "applying";
    job.messages.push(message({ role: "system", text: "开始生效：等进行中的模型调用结束后重启服务。" }));
    this.engineerSave(job);
    this.platform.schedule(copy);
    this.platformPending = copy;
    this.maintenanceTask = new Task(() => this.activatePlatform(copy));
    return job;
  }

  /** A platform change has been applied or not (SelfRepair.finishPlatform): update the job it belongs
   *  to, and commit an applied change. */
  engineerFinished(record: RepairJob): void {
    const job = this.db.getEngineerJob(record.engineer_job_id || "");
    if (!job || ENGINEER_DONE.has(job.status)) return;
    job.files = record.files?.length ? record.files : job.files;
    if (record.status === "activated") {
      job.status = "applied";
      let note = "已生效，服务健康检查通过。";
      if (settings.engineer_commit && job.files.length) {
        try {
          job.commit = deps.commit(record.root, job.files, `${job.title || "平台改动"}\n\nMade by FluidForm's platform engineer (job ${job.id}).`);
          note += `已提交到 git：${job.commit.slice(0, 8)}（没有推送）。`;
        } catch (error) {
          note += `没有提交到 git：${(error as Error)?.message ?? error}`;
        }
      }
      job.messages.push(message({ role: "system", text: note }));
    } else {
      job.status = "failed";
      job.error = record.error || "改动没有生效。";
      job.messages.push(message({ role: "system", text: `没有生效：${job.error}` }));
    }
    this.engineerEnd(job);
  }

  engineerEnd(job: EngineerJob): void {
    job.finished_at = nowIso();
    this.engineerSave(job);
    if (job.improvement_id) this.syncImprovements();
    if (job.kind === "component" && job.origin === "lead" && job.run_id && job.node_id) new Task(() => this.engineerToLead(job.id));
  }

  /** A component a task's lead asked for is done with (applied, failed or given up): the lead decides
   *  what happens to the step that waited for it. */
  private async engineerToLead(jobId: string): Promise<void> {
    const job = this.engineerJob(jobId);
    const run = await this.locked(job.run_id!, () => {
      const found = this.db.getRun(job.run_id!);
      if (!found || found.engineer_job_id !== job.id || found.status === "cancelled") return null;
      found.engineer_job_id = null;
      this.save(found);
      return found;
    });
    if (!run) return;
    const node = run.plan.nodes.find((item) => item.id === job.node_id);
    if (!node) return;
    const last = node.attempts.at(-1);
    const verdict = quality.verdict({ passed: false, reason: last?.reason || "步骤未完成" });
    let decision = null;
    const left = SelfRepair.decisionsLeft(run, node);
    if (this.canLead() && Math.min(...left) > 0) {
      const choices = this.choices(run, node);
      decision = await this.askForDecision(run.id, node.id, engineerMessage(run, node, job, choices, left), new Set(choices.map((item) => item.id)), null, false, "engineer_done");
    }
    if (decision === "budget") return;
    if (decision === null) {
      await this.locked(run.id, () => {
        const latest = this.db.getRun(run.id)!;
        latest.error = `平台工程师的工作已结束（${job.status}），负责人暂时无法决定下一步。看过后点“按此预算继续”。`;
        this.save(latest);
      });
      return;
    }
    await this.applyDecision(run.id, node.id, decision, verdict, last ? last.outcome : "error", "engineer_done");
    await this.continueAfterAnswer(run.id);
  }

  /** Bring the platform engineer into a task's conversation with the lead: a job tied to the task, which
   *  does not hold it. Returns the job, or null and why it could not be taken. */
  engineerJoin(runId: string, call: { kind?: string; request: string }, origin: string, nodeId: string | null = null, decisionId: string | null = null,
    attachments: Attachment[] = []): [EngineerJob | null, string] {
    let job: EngineerJob;
    try {
      job = this.engineerRequest(call.request, call.kind || "repair", origin, { runId, nodeId, decisionId, attachments });
    } catch (error) {
      if (error instanceof EngineerError) return [null, error.message];
      throw error;
    }
    this.emit(runId, "run.engineer_joined", { job_id: job.id, job_kind: job.kind, origin, title: job.title });
    return [job, ""];
  }

  /** The task's engineer jobs whose status changed since its lead last heard of them. */
  engineerNews(run: ExecutionRun): EngineerJob[] {
    return this.db.engineerJobs(200).filter((job) => job.run_id === run.id && run.engineer_seen[job.id] !== job.status);
  }

  /** The lead asks for a component (called holding the run's lock): the task waits for it. null if the
   *  engineer cannot take it. */
  engineerForLead(run: ExecutionRun, node: TaskNode, request: string, decisionId: string): EngineerJob | null {
    let job: EngineerJob;
    try {
      job = this.engineerRequest(request, "component", "lead", { runId: run.id, nodeId: node.id, decisionId });
    } catch (error) {
      if (error instanceof EngineerError) return null;
      throw error;
    }
    node.status = "pending";
    if (run.status === "running" || run.status === "queued") run.status = "paused";
    run.engineer_job_id = job.id;
    run.error = "负责人请平台工程师添加一个组件。请在负责人对话里看过平台工程师的方案后批准，组件生效后任务继续。";
    return job;
  }

  /** A task's platform repair (SelfRepair.fixPlatform), recorded as an engineer job. */
  recordPlatformRepair(run: ExecutionRun, diagnosis: Diagnosis, node: TaskNode | null, problem: string, copy: RepairJob): EngineerJob {
    const job = EngineerJobSchema.parse({ kind: "repair", origin: diagnosis.trigger === "lead_repair" ? "lead" : "diagnosis",
      request: problem || "任务的诊断发现 FluidForm 自身有缺陷。", status: "editing", phase: "edit", run_id: run.id, node_id: node ? node.id : null,
      decision_id: diagnosis.decision_id, diagnosis_id: diagnosis.id, repair_id: copy.id, budget_usd: 0 });
    job.title = titleOf(job.request);
    job.messages.push(message({ role: "system", text: "任务「" + head(run.prompt, 60) + "」的修复，花费记在该任务上。" }));
    this.engineerSave(job);
    copy.engineer_job_id = job.id;
    this.platform.save(copy);
    return job;
  }
}
