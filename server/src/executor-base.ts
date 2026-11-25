// What every part of the executor shares (executor.ts's Executor, without its mixins): the state of
// the tasks at work, one lock per task, saving and events, charging model calls to a task's budget,
// asking the task's lead, and the step outcomes the lead, the diagnosis and the scheduler all use.
//
// Python mixes Reviewing, Leading, Diagnosing, SelfRepair, Engineering, Preflighting and Learning into
// one class. Here they are one line of classes, each in its own file and each extending the one
// before: ExecutorBase -> Reviewing -> Leading -> Diagnosing -> SelfRepair -> Engineering ->
// Preflighting -> Executor. What a part calls of a later one is declared here, abstract.
import { uses } from "./features.js";
import { chosenFor } from "./model-choice.js";
import { mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { RequestBudget, StepLimitExceeded } from "./budget.js";
import * as pricing from "./pricing.js";
import { CLI_SPECS } from "./cli-channels.js";
import { settings } from "./config.js";
import * as contracts from "./contracts.js";
import type { Conversation } from "./conversation.js";
import type { Database } from "./db.js";
import { nowIso } from "./lax.js";
import { log } from "./log.js";
import { type Attachment, type Diagnosis, DiagnosisSchema, type EngineerJob, EventSchema, type ExecutionRun, folderId, LeadThinkingSchema, type ModelProfile,
  routingReady, type TaskNode } from "./models.js";
import { type PlatformRepairs, type RepairJob, SourceRepairs } from "./platform-repair.js";
import * as progress from "./progress.js";
import type { CompleteOptions, ProviderResult, SpendOk } from "./providers.js";
import { AsyncEvent, fixed, head, pyRound, pyStr } from "./py.js";
import * as quality from "./quality.js";
import { type ModelUnavailable, failureKind, type QuotaTracker } from "./quota.js";
import { retryModel } from "./recovery.js";
import * as retrospect from "./retrospect.js";
import * as experience from "./experience.js";
import { NoEligibleModelError, eligibleForNode, nodeCost, routeNode } from "./routing.js";
import { stepKey } from "./review.js";
import type * as scopes from "./scopes.js";
import { currentTask, Mutex, Task } from "./tasks.js";
import * as team from "./team.js";
import * as supervisor from "./supervisor.js";

type Json = Record<string, any>;

// How a model call that ran out of turns reads in an attempt's reason (providers.turnLimitMark).
export const TURN_LIMIT_HINT = "轮工具调用后仍未完成";
// Diagnosis report kept with a step that cannot be done.
export const MAX_UNABLE_REPORT = 1500;

/** What the executor needs of the model calls (ProviderRegistry, or a test's double). */
export type Providers = {
  complete(modelId: string, prompt: string, options?: CompleteOptions): Promise<ProviderResult>;
  converse?: supervisor.Conversing["converse"];
  configuredModels?(modelIds: Iterable<string>): Set<string>;
  toolLimitCapabilities?(modelId: string): Record<string, unknown>;
  quota?: QuotaTracker;
  cli?: unknown;
};

/** Where an attempt's full tool trace goes: under the data folder, which steps cannot read. */
export function tracePath(runId: string, nodeId: string, attempt: number): string {
  return join(resolve(settings.data_dir), "traces", runId, `${nodeId}-${attempt}.jsonl`);
}

const shortId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 8);
export const newDiagnosisId = shortId;

export abstract class ExecutorBase {
  readonly tasks = new Map<string, Task<void>>();
  readonly learningTasks = new Map<string, Task<void>>();
  // Naming a finished task's problems (retrospect.nameProblems), one call each.
  readonly namingTasks = new Map<string, Task<unknown>>();
  closing = false;
  readonly diagnosing = new Map<string, Task<unknown>>();
  readonly locks = new Map<string, Mutex>();
  // One message at a time in each task's conversation with its lead.
  readonly leadLocks = new Map<string, Mutex>();
  // The user's messages to each task's lead, answered in the background.
  readonly leadTasks = new Map<string, Task<void>>();
  /** A long chat's older turns being summarised, by chat. */
  readonly chatSummaries = new Map<string, Task<void>>();
  // A succeeded task's lead, asked what it built that is reusable (capabilities.ts).
  readonly capabilityTasks = new Map<string, Task<void>>();
  // Called with (run id, end event) whenever a task ends (emit).
  readonly endListeners: ((runId: string, kind: string) => void)[] = [];
  // Called with (run id, the event's data) whenever a task asks the user something (run.diagnosis_question).
  readonly questionListeners: ((runId: string, data: Json) => void)[] = [];
  // Steps working in one folder at once (scopes.ts).
  readonly folderLocks = new Map<string, scopes.FolderLock>();
  // Files a step changed outside its own that a step alongside it reads (Scope.intrusions).
  readonly intrusions = new Map<string, [string, string][]>();
  readonly nodeTasks = new Map<string, Task<void>>();
  // Tool calls of each step's attempt in progress, written onto the attempt when it ends.
  readonly toolLogs = new Map<string, Json[]>();
  // Where each running attempt writes its full tool trace (NodeAttempt.trace).
  readonly toolTraces = new Map<string, string>();
  readonly workResults = new Map<string, ProviderResult>();
  // Each step's conversation with its API model, continued by its next attempt.
  readonly conversations = new Map<string, Conversation>();
  readonly reservations = new Map<string, Map<unknown, number>>();
  readonly budgetEvents = new Map<string, AsyncEvent>();
  // Shared environment repairs must not overwrite one another across projects.
  readonly repairLock = new Mutex();
  platform: PlatformRepairs;
  platformPending: RepairJob | null = null;
  maintenanceTask: Task<void> | null = null;
  // The platform engineer's job at work, if any (engineer.ts).
  engineerTask: Task<void> | null = null;
  // What the platform engineer's running job is doing, by job id.
  readonly engineerLogs = new Map<string, Json[]>();
  engineerJobId: string | null = null;
  activeRequests = 0;

  constructor(readonly db: Database, readonly providers: Providers, readonly modelLookup: Record<string, ModelProfile>) {
    this.platform = new SourceRepairs(settings.platform_root, settings.data_dir, settings.api_base_url, settings.platform_self_repair, db.path);
  }

  // --- what later parts give ----------------------------------------------------------------------
  abstract start(runId: string): void;
  abstract repair(runId: string, nodeId: string, verdict: quality.Verdict, outcome: string, options?: { diagnosisId?: string | null;
    brief?: string; decisionId?: string | null }): Promise<void>;
  abstract afterRepair(runId: string, nodeId: string, diagnosisId: string, verdict: quality.Verdict, outcome: string): Promise<boolean>;
  abstract continueAfterAnswer(runId: string): Promise<void>;
  abstract holdForPlatform(run: ExecutionRun, force?: boolean): void;
  abstract engineerJoin(runId: string, call: { kind?: string; request: string }, origin: string, nodeId?: string | null, decisionId?: string | null,
    attachments?: Attachment[]): [EngineerJob | null, string];
  abstract engineerNews(run: ExecutionRun): EngineerJob[];
  abstract finishLearning(runId: string): void;
  abstract skipCancelledLearning(runId: string): void;

  // --- locks, saving, events ----------------------------------------------------------------------

  /** ``work`` holding ``runId``'s lock (Python's ``async with self.locks.setdefault(...)``). */
  locked<T>(runId: string, work: () => T | Promise<T>): Promise<T> {
    let lock = this.locks.get(runId);
    if (!lock) this.locks.set(runId, (lock = new Mutex()));
    return lock.run(work);
  }

  save(run: ExecutionRun): void {
    run.updated_at = nowIso();
    this.db.saveRun(run);
  }

  emit(runId: string, kind: string, data: Json = {}): void {
    this.db.addEvent(EventSchema.parse({ run_id: runId, kind, data }));
    if (kind === "run.diagnosis_question") {
      // A chat app it was asked for in hears the question, to answer it there.
      for (const listener of this.questionListeners) {
        try {
          listener(runId, data);
        } catch (error) {
          log.error(`a question listener failed for ${runId}: ${(error as Error).stack ?? error}`);
        }
      }
    }
    if (retrospect.END_EVENTS.has(kind)) {
      // Told whenever a task ends (the Feishu bot sends its result back where it was asked).
      for (const listener of this.endListeners) {
        try {
          listener(runId, kind);
        } catch (error) {
          log.error(`an end listener failed for ${runId}: ${(error as Error).stack ?? error}`);
        }
      }
      // The task has ended: look back on it while its records are fresh.
      if (uses.learning()) retrospect.record(this.db, runId);
      this.nameProblems(runId);
      this.finishLearning(runId);
    }
  }

  /** Name the problems of a task that has just ended by what they are about, in the background. */
  nameProblems(runId: string): void {
    if (!settings.problem_naming || !uses.learning() || this.closing) return;
    const run = this.db.getRun(runId);
    const current = this.namingTasks.get(runId);
    if (!run || (current && !current.done)) return;
    const complete = async (modelId: string, prompt: string) => this.providers.complete(modelId, prompt, { allow_api_fallback: false, effort: "low" });
    this.namingTasks.set(runId, new Task(() => experience.nameProblems(this.db, complete, Object.values(this.modelLookup), this.configured(run), runId)));
  }

  // --- models, budget and model calls -------------------------------------------------------------

  configured(run: ExecutionRun): Set<string> {
    if (!this.providers?.configuredModels) return new Set();
    let found = this.providers.configuredModels(Object.keys(this.modelLookup));
    if (run.plan.nodes.some((node) => node.model_id && !node.model_id.startsWith("mock:"))) found = new Set([...found].filter((id) => !id.startsWith("mock:")));
    return chosenFor(found, run);
  }

  needsVision(run: ExecutionRun): boolean {
    return run.attachments.some((item) => item.kind === "image");
  }

  outOfQuota(modelId: string | null | undefined): boolean {
    return Boolean(this.providers.quota && modelId && this.providers.quota.exhausted(modelId));
  }

  /** Charge by token usage; if the model or its price has since left the catalog, the work is still
   *  done, so charge the routed estimate rather than failing the step. */
  actualCost(result: Pick<ProviderResult, "input_tokens" | "output_tokens" | "cached_input_tokens"> & { used_model_id?: string | null },
    node: TaskNode | null, modelId: string | null = null): Promise<number> {
    const model = this.modelLookup[result.used_model_id || modelId || node?.model_id || ""];
    if (!pricing.enabled()) return Promise.resolve(0);
    if (!pricing.priced(model)) return Promise.resolve(modelId || node === null ? 0 : node.estimated_cost_usd);
    return pricing.charge(model, result.input_tokens, result.output_tokens, result.cached_input_tokens ?? 0);
  }

  static contractLimitReason(node: TaskNode): string | null {
    let reason = progress.limitReason(node);
    if (!reason && node.artifact_contract && node.contract_tool_calls >= node.artifact_contract.max_turns) {
      reason = `达到声明工具调用上限 ${node.artifact_contract.max_turns}，停止工作包；保留产物与日志供诊断。`;
    }
    return reason;
  }

  contractLimitReason(node: TaskNode): string | null {
    return ExecutorBase.contractLimitReason(node);
  }

  /** Run ``call(budget)``, a model call, against the task's budget. Persist each received usage report,
   *  even if a later round fails or is cancelled. */
  async charged(run: ExecutionRun, node: TaskNode | null, modelId: string, call: (budget: SpendOk) => Promise<ProviderResult>,
    { work = false }: { work?: boolean } = {}): Promise<ProviderResult> {
    const charge = async (cost: number) => {
      if (!cost) return;
      await this.locked(run.id, () => {
        const latest = this.db.getRun(run.id);
        if (!latest) return;
        latest.actual_cost_usd = pyRound(latest.actual_cost_usd + cost, 6);
        const current = node ? latest.plan.nodes.find((item) => item.id === node.id) : undefined;
        if (current) for (const governor of team.governors(latest.plan, current)) governor.contract_cost_usd += cost;
        this.save(latest);
      });
    };
    const remaining = () => {
      const latest = this.db.getRun(run.id);
      return latest ? latest.budget_usd - latest.actual_cost_usd : -Infinity;
    };
    const currentLimits = () => {
      const latest = this.db.getRun(run.id)!;
      return team.governors(latest.plan, latest.plan.nodes.find((item) => item.id === node!.id)!);
    };
    const useTurn = () => this.locked(run.id, () => {
      const latest = this.db.getRun(run.id)!;
      const governors = team.governors(latest.plan, latest.plan.nodes.find((item) => item.id === node!.id)!);
      for (const governor of governors) {
        const reason = this.contractLimitReason(governor);
        if (reason) throw new StepLimitExceeded(reason);
      }
      for (const governor of governors) governor.contract_turns += 1;
      this.save(latest);
    });
    // The check and debit share the run lock, including delegated siblings. Never refund an
    // interrupted or failed invocation: its side effects may already exist.
    const beginTool = () => this.locked(run.id, () => {
      const latest = this.db.getRun(run.id)!;
      const governors = team.governors(latest.plan, latest.plan.nodes.find((item) => item.id === node!.id)!);
      for (const governor of governors) {
        if (governor.contract_tool_calls >= governor.artifact_contract!.max_turns) throw new StepLimitExceeded("达到声明工具调用上限，额外调用未执行。");
      }
      for (const governor of governors) governor.contract_tool_calls += 1;
      this.save(latest);
    });
    const limits = node ? team.governors(run.plan, node) : [];
    // Turns and tool calls are counted for API models only; a membership CLI cannot report them, and
    // is bounded by time instead (timedWatch). Cost limits apply to both.
    const counted = limits.length > 0 && work && !modelId.startsWith("cli:");
    if (!this.reservations.has(run.id)) this.reservations.set(run.id, new Map());
    if (!this.budgetEvents.has(run.id)) this.budgetEvents.set(run.id, new AsyncEvent());
    // An automation's chat (the Feishu bot's) is counted, never held back by what it costs.
    const countOnly = !node && run.kind === "chat" && Boolean(run.origin?.capability);
    const cost = (work: () => Promise<number>) => (countOnly ? pricing.countOnly(work, 0) : work());
    const budget = Object.assign(new RequestBudget({ countOnly, models: this.modelLookup, remaining, reservations: this.reservations.get(run.id)!, charge,
      changed: this.budgetEvents.get(run.id)!,
      stepRemaining: limits.length ? () => Math.min(...currentLimits().map((n) => n.artifact_contract!.max_cost_usd - n.contract_cost_usd)) : null,
      turnRemaining: counted ? () => Math.min(...currentLimits().map((n) => n.artifact_contract!.max_turns - n.contract_turns)) : null,
      useTurn: counted ? useTurn : null, scope: limits.length ? `${run.id}\0${limits.at(-1)!.id}` : null, waitForStep: work }), {
      beginTool: counted ? beginTool : null,
      toolRemaining: counted ? () => Math.min(...currentLimits().map((n) => n.artifact_contract!.max_turns - n.contract_tool_calls)) : null,
      context: { run_id: run.id, node_id: node ? node.id : null, count_only: countOnly, purpose: work ? "work" : "review_or_control" },
    });
    let result: ProviderResult | null = null;
    try {
      result = await call(budget as unknown as SpendOk);
      // CLI calls and provider adapters without streaming usage are accounted here.
      const extra = Math.max(0, (await cost(() => this.actualCost(result!, node, node && modelId === node.model_id ? null : modelId))) - budget.spent);
      await charge(extra);
      result.accounted_cost_usd = budget.spent + extra;
      return result;
    } catch (error) {
      const usage = (error as Json)?.usage || result;
      const extra = usage ? Math.max(0, (await cost(() => this.actualCost(usage, node, modelId))) - budget.spent) : 0;
      await charge(extra);
      if (error && typeof error === "object") (error as Json).accounted_cost_usd = budget.spent + extra;
      throw error;
    } finally {
      budget.release();
    }
  }

  /** A model call for ``run`` (and ``node``), charged to its budget; in the calling task's signal. */
  async complete(run: ExecutionRun, node: TaskNode | null, modelId: string, prompt: string, workspace: string | null,
    options: CompleteOptions = {}): Promise<ProviderResult> {
    // Read fresh, so allowing the network takes effect from the task's next model call.
    const latest = this.db.getRun(run.id);
    const given: CompleteOptions = { ...options, workspace, signal: options.signal ?? currentTask()?.signal };
    if (latest?.allow_network && !options.repair) given.network = true;
    return this.charged(run, node, modelId, (budget) => this.providers.complete(modelId, prompt, { ...given, spend_ok: budget }),
      { work: Boolean(options.tool_trace) });
  }

  /** Ask the task's lead (supervisor.ts); its conversation is saved with the task. One message at a time
   *  per task, so the conversation stays in order. */
  askLead(runId: string, given: string, attachments: Attachment[] = []): Promise<string> {
    let lock = this.leadLocks.get(runId);
    if (!lock) this.leadLocks.set(runId, (lock = new Mutex()));
    return lock.run(async () => {
      const run = this.db.getRun(runId)!;
      const previous = run.supervisor?.model_id ?? null;
      let prompt = given;
      // What the platform engineer did for this task since the lead last heard.
      const news = this.engineerNews(run);
      if (news.length) prompt = supervisor.engineerUpdates(news) + prompt;
      const charged: supervisor.Charged = (modelId, call) => this.charged(run, null, modelId, call);
      // Files the lead has not been given yet go with this message: the user may send some while the
      // task runs (a message, a reply to its question).
      const seen = run.lead_seen_attachments ?? (run.supervisor?.calls ? run.attachments.map((item) => item.id) : []);
      const given2 = new Map([...attachments, ...run.attachments.filter((item) => !seen.includes(item.id))].map((item) => [item.id, item]));
      let sent = [...given2.values()];
      const lead = this.modelLookup[previous ?? ""];
      if (lead && lead.channel !== "cli" && lead.supports_vision === false) {
        // An API lead that cannot see images is told of them, not sent them.
        const blind = sent.filter((item) => item.kind === "image");
        sent = sent.filter((item) => item.kind !== "image");
        if (blind.length) prompt += "\n\n(The user also sent images you cannot see: " + blind.map((item) => item.name).join(", ") + ".)";
      }
      if (!this.providers.converse) throw new TypeError("these providers keep no conversations");
      const [text, session] = await supervisor.ask(this.providers as supervisor.Conversing, Object.values(this.modelLookup), this.configured(run), run,
        prompt, charged, sent);
      await this.locked(runId, () => {
        const latest = this.db.getRun(runId)!;
        latest.supervisor = session;
        latest.lead_seen_attachments = [...new Set([...seen, ...given2.keys()])];
        for (const job of news) latest.engineer_seen[job.id] = job.status;
        this.save(latest);
      });
      if (session.model_id !== previous) this.emit(runId, "run.lead_changed", { model_id: session.model_id, previous_model_id: previous });
      return text;
    });
  }

  canLead(): boolean {
    return uses.lead() && typeof this.providers.converse === "function";
  }

  /** Shows that the lead is deciding ``event`` (the panel and the timeline) until ``work`` is done. */
  async thinking<T>(runId: string, event: string, nodeId: string | null, work: () => Promise<T>): Promise<T> {
    const show = (thinking: Json | null) => this.locked(runId, () => {
      const run = this.db.getRun(runId);
      if (run) {
        run.lead_thinking = thinking as ExecutionRun["lead_thinking"];
        this.save(run);
      }
    });
    await show(LeadThinkingSchema.parse({ event, node_id: nodeId }));
    this.emit(runId, "run.lead_thinking", { event, node_id: nodeId });
    try {
      return await work();
    } finally {
      await show(null);
    }
  }

  // --- the step's evidence ------------------------------------------------------------------------

  /** What an attempt did, for its NodeAttempt, however it ended (finished, cancelled, its model
   *  unavailable): its tool calls, its turns (from the model's usage, else the calls), and its full trace
   *  if one was written. */
  takeLog(runId: string, nodeId: string, result: Json | null = null): Json {
    // Snapshot only. A failed validation or database write must leave the evidence available.
    const key = stepKey(runId, nodeId);
    const calls = (this.toolLogs.get(key) ?? []).map((call) => ({ ...call }));
    const trace = this.toolTraces.get(key);
    const answer: Json | undefined = result && "text" in result ? result : this.workResults.get(key);
    const turns = result?.turns || answer?.turns || Math.max(0, ...calls.map((call) => call.turn ?? 0));
    const latest = this.db.getRun(runId);
    const node = latest?.plan.nodes.find((item) => item.id === nodeId);
    const elapsed = node?.started_at ? Math.max(0, (Date.now() - Date.parse(node.started_at)) / 1000) : null;
    let traced: string | null = null;
    if (trace) {
      try {
        traced = statSync(trace).isFile() ? trace : null;
      } catch {
        traced = null;
      }
    }
    return { tool_calls: calls, turns, trace: traced, duration_seconds: elapsed, result: answer?.text ?? null,
      result_source: answer !== undefined ? "provider" : null };
  }

  /** Release an attempt's evidence only after its record was saved. */
  releaseLog(runId: string, nodeId: string): void {
    const key = stepKey(runId, nodeId);
    this.toolLogs.delete(key);
    this.toolTraces.delete(key);
    this.workResults.delete(key);
  }

  // --- step outcomes ------------------------------------------------------------------------------

  pauseForBudget(run: ExecutionRun): void {
    run.status = "paused";
    this.save(run);
    this.emit(run.id, "approval.required", { reason: "budget_insufficient", actual_cost_usd: run.actual_cost_usd, budget_usd: run.budget_usd });
  }

  /** Record a deterministic diagnosis, without another model call or automatic recovery. */
  stopContract(run: ExecutionRun, node: TaskNode, reason: string, outcome = "blocked", details: Json = {}): void {
    node.status = "blocked";
    node.review_passed = false;
    node.review = node.unable_reason = reason;
    if (node.artifact_evidence) node.artifact_evidence.accepted = false;
    if (!node.result) node.result = `BLOCKED: ${reason}`;
    let report = `${reason}\n累计请求轮次：${node.contract_turns}；工具调用：${node.contract_tool_calls}；累计费用：$${fixed(node.contract_cost_usd, 6)}。\n` + contracts.prompt(node);
    const last = node.attempts.at(-1);
    if (last?.trace) report += `\n日志：${last.trace}`;
    run.diagnoses.push(DiagnosisSchema.parse({ id: shortId(), trigger: "artifact_contract", node_id: node.id, status: "done", scope: "task", verdict: "blocked",
      report, finished_at: nowIso() }));
    const below = quality.descendants(run, new Set([node.id]));
    for (const downstream of run.plan.nodes) {
      if (below.has(downstream.id) && downstream.status === "pending") {
        downstream.status = "blocked";
        downstream.review = downstream.unable_reason = `上游「${node.title}」没有已验收的交付：${reason}`;
      }
    }
    this.emit(run.id, "node.blocked", { node_id: node.id, reason, outcome, ...details });
  }

  /** The fallback without a lead's decision: count the failure, then retry or fail. */
  async retryOrFail(run: ExecutionRun, node: TaskNode, verdict: quality.Verdict, outcome: string): Promise<void> {
    node.failed_attempts += 1;
    const problem = verdict.reason + (verdict.fix ? `\n应修改：${verdict.fix}` : "");
    if (node.failed_attempts >= settings.max_node_attempts) {
      if (outcome === "unable") {
        this.markUnable(run, node, verdict.unable || verdict.reason);
        return;
      }
      node.status = "failed";
      const last = node.attempts.at(-1);
      if (outcome === "error" && !(last && last.result !== null)) node.result = verdict.reason;
      this.emit(run.id, "node.failed", { node_id: node.id, error: verdict.reason, attempts: node.attempts.length });
      return;
    }
    // Retry with the problems spelled out, on the strongest model that can take the step; one that
    // failed it twice in a row makes way for another, a CLI included.
    node.feedback = quality.retryFeedback(node.feedback, problem);
    // Without a lead (fixed rules) the same model has one more try before a stronger one takes over.
    if (uses.fixedRetries() && node.failed_attempts === 1 && node.model_id && this.configured(run).has(node.model_id)) {
      node.status = "pending";
      this.emit(run.id, "node.retry", { node_id: node.id, reason: verdict.reason, model_id: node.model_id, attempt: node.failed_attempts + 1 });
      return;
    }
    const stronger = await retryModel(node, Object.values(this.modelLookup), this.configured(run), this.needsVision(run));
    if (stronger && stronger.id !== node.model_id) {
      node.model_id = stronger.id;
      node.estimated_cost_usd = pyRound(await nodeCost(node, stronger), 6);
    }
    node.status = "pending";
    this.emit(run.id, "node.retry", { node_id: node.id, reason: verdict.reason, model_id: node.model_id, attempt: node.failed_attempts + 1 });
  }

  /** End a step that cannot be done in this environment, saying why and what the user could do; steps
   *  that need its result are skipped when the task ends. */
  markUnable(run: ExecutionRun, node: TaskNode, reason: string | null, diagnosis: Diagnosis | null = null, userAction: string | null = null): void {
    const action = userAction || diagnosis?.user_action || null;
    const report = diagnosis && diagnosis.status === "done" ? head(diagnosis.report || "", MAX_UNABLE_REPORT) : "";
    node.status = "unable";
    node.unable_reason = [(reason || "这一步在当前环境中无法完成。").trim(), action ? `需要你处理：${action}` : "", report ? `诊断结论：\n${report}` : ""]
      .filter(Boolean).join("\n\n");
    node.review = head(`无法完成：${(reason || "").trim()}`, 500);
    this.emit(run.id, "node.unable", { node_id: node.id, reason, user_action: action });
  }

  /** A failed verification reopens the verified steps (or the ``targets`` among them) with its findings
   *  and ``note``, and everything that already used their results, including the verifier itself.
   *  Without the lead deciding (``limited``), max_rework_rounds caps it. */
  /** A failed attempt nobody diagnoses: retried, or, when it cannot be done here, the step says so
   *  and, without a platform engineer, the task waits for the user. */
  async recover(run: ExecutionRun, node: TaskNode, verdict: quality.Verdict, outcome: string): Promise<void> {
    // Without a diagnosis to change the environment, another attempt meets the same limit.
    if (outcome === "unable") this.markUnable(run, node, verdict.unable);
    else await this.retryOrFail(run, node, verdict, outcome);
    if (node.status !== "unable" || !uses.stuckWaits() || run.status !== "running") return;
    run.status = "paused";
    run.error = `步骤「${node.title}」卡住了，没有启用平台工程师，等你处理：${node.unable_reason}`;
    this.emit(run.id, "approval.required", { reason: "unable", node_id: node.id });
  }

  sendBack(run: ExecutionRun, verifier: TaskNode, verdict: quality.Verdict, targets: Set<string> | null = null, note: string | null = null, limited = true): void {
    if (limited && run.rework_rounds >= settings.max_rework_rounds) {
      verifier.status = "failed";
      verifier.review = `返工 ${run.rework_rounds} 轮后验证仍未通过：${verdict.fix || verdict.reason}`;
      this.emit(run.id, "node.failed", { node_id: verifier.id, error: verifier.review });
      return;
    }
    run.rework_rounds += 1;
    const chosen = new Set([...(targets ?? verifier.verifies)].filter((item) => verifier.verifies.includes(item) && run.plan.nodes.some((node) => node.id === item)));
    const reopened = new Set([...chosen, ...quality.descendants(run, chosen), verifier.id]);
    const asked = note ? `\n负责人要求：${note}` : "";
    for (const node of run.plan.nodes) {
      if (!reopened.has(node.id)) continue;
      node.generation += 1;
      const task = this.nodeTasks.get(stepKey(run.id, node.id));
      if (task && task !== currentTask() && !task.done) task.cancel();
      node.status = "pending";
      node.failed_attempts = 0;
      node.feedback = chosen.has(node.id) ? `${quality.REWORK_PREFIX}${verifier.title}）发现问题：${verdict.fix || verdict.reason}${asked}` : null;
    }
    this.emit(run.id, "run.rework", { round: run.rework_rounds, verifier: verifier.id, reopened: [...reopened].sort(), problems: verdict.fix || verdict.reason });
  }

  /** Select a replacement under the run lock, for a provider error or a diagnosis. */
  async routeAfterUnavailable(run: ExecutionRun, node: TaskNode, error: ModelUnavailable, diagnosisId: string | null = null): Promise<void> {
    // Older diagnoses may have told the step to wait for its old provider. That advice must not block
    // the replacement; keep the original verification or work feedback.
    if (node.feedback) {
      for (const diagnosis of run.diagnoses) {
        if (diagnosis.node_id === node.id && diagnosis.advice && (["quota_exhausted", "model_unavailable"].includes(diagnosis.verdict ?? "")
          || failureKind(diagnosis.report || ""))) node.feedback = node.feedback.replace(`\n诊断建议：${diagnosis.advice}`, "");
      }
      node.feedback = node.feedback.trim() || null;
    }
    node.status = "pending";
    const models = Object.values(this.modelLookup);
    const context: Json = diagnosisId ? { diagnosis_id: diagnosisId } : {};
    context.reason = error.kind === "quota" ? "quota_exhausted" : "model_unavailable";
    try {
      if (node.failed_attempts) {
        // Already retrying, so on the strongest model that has not failed it; keep it that way.
        const backup = await retryModel(node, models, this.configured(run), this.needsVision(run));
        if (backup === null) throw new NoEligibleModelError("no backup");
        node.model_id = backup.id;
        node.estimated_cost_usd = pyRound(await nodeCost(node, backup), 6);
      } else await routeNode(node, models, this.configured(run), this.needsVision(run));
    } catch (problem) {
      if (!(problem instanceof NoEligibleModelError)) throw problem;
      run.error = `步骤「${node.title}」：${error.message}，目前没有其它可用模型能接替。任务已暂停，模型恢复或启用其它模型后点“按此预算继续”。`;
      if (run.status === "running") run.status = "paused";
      this.emit(run.id, "approval.required", { node_id: node.id, model_id: error.modelId, until: error.until.toISOString().replace("Z", "+00:00"), ...context });
      return;
    }
    this.emit(run.id, "node.model_switched", { node_id: node.id, model_id: error.modelId, next_model_id: node.model_id,
      until: error.until.toISOString().replace("Z", "+00:00"), ...context });
  }

  /** The lead's summary when it ended the task with one; else the results of the graph's end steps,
   *  which nothing else depends on, in plan order; ``completedOnly`` takes the furthest completed steps. */
  static finalResult(run: ExecutionRun, completedOnly = false): string | null {
    const last = run.decisions.at(-1);
    if (!completedOnly && last && last.event === "all_done" && last.summary) return last.summary;
    const nodes = completedOnly ? run.plan.nodes.filter((node) => node.status === "succeeded") : run.plan.nodes;
    const required = new Set(nodes.flatMap((node) => node.dependencies));
    const sinks = nodes.filter((node) => !required.has(node.id));
    if (completedOnly && !sinks.length) return null;
    if (sinks.length === 1) return sinks[0].result;
    return sinks.filter((node) => node.result).map((node) => `${node.title}:\n${node.result}`).join("\n\n") || null;
  }

  /** A CLI step may fall back to its metered API only if enabled and within budget. */
  async fallbackAllowed(run: ExecutionRun, node: TaskNode): Promise<boolean> {
    const spec = CLI_SPECS[node.model_id || ""];
    if (!spec) return true;
    const model = this.modelLookup[spec.fallback_model_id];
    if (!model || !model.enabled || !routingReady(model)) return false;
    // CLI steps reserve nothing, so the fallback's cost must fit what other steps leave.
    const reserved = run.actual_cost_usd + run.plan.nodes.filter((item) => item.status === "running" && item.id !== node.id)
      .reduce((sum, item) => sum + item.estimated_cost_usd, 0);
    return reserved + (await nodeCost(node, model)) <= run.budget_usd;
  }

  /** The working folder of ``node``: the user's project, or the task's scratch folder. */
  static folder(run: ExecutionRun, node: TaskNode | null): string {
    return run.project_dir && (node === null || node.needs_workspace) ? run.project_dir : join(settings.workspace_root, folderId(run));
  }

  ensureFolder(path: string): string {
    mkdirSync(path, { recursive: true });
    return path;
  }

  /** The steps a model can take now, for the lead's choice. */
  choices(run: ExecutionRun, node: TaskNode): ModelProfile[] {
    return eligibleForNode(node, Object.values(this.modelLookup), this.configured(run), this.needsVision(run));
  }

  /** Events as a diagnosis reads them: "HH:MM:SS kind data". */
  eventLines(runId: string): string[] {
    return this.db.events(runId).map((event) => `${event.created_at.slice(11, 19)} ${event.kind} ${pyStr(event.data)}`);
  }
}
