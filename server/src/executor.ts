// Runs a task's steps: scheduling, attempts, retries and step outcomes. The parts it is
// made of are the classes it extends (executor-base.ts says how).
import { uses } from "./features.js";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import * as activity from "./activity.js";
import * as briefing from "./briefing.js";
import { BudgetExceeded, StepLimitExceeded } from "./budget.js";
import { settings } from "./config.js";
import * as contracts from "./contracts.js";
import * as memory from "./conversation.js";
import { Conversation } from "./conversation.js";
import type { Database } from "./db.js";
import { stepKey } from "./review.js";
import { tracePath, TURN_LIMIT_HINT, type Providers } from "./executor-base.js";
import { nowIso } from "./lax.js";
import * as learning from "./learning.js";
import { type ExecutionRun, type ModelProfile, NodeAttemptSchema, scoreFor, type TaskNode } from "./models.js";
import { Preflighting } from "./preflighting.js";
import { gitSnapshot } from "./projects.js";
import { TOOL_LIMIT_REQUIREMENTS, type ProviderResult } from "./providers.js";
import { formatG, fixed, head, pyDumps, pyIsoformat, pyRound } from "./py.js";
import * as quality from "./quality.js";
import { ModelUnavailable } from "./quota.js";
import { turnsFor } from "./recovery.js";
import { canAct, eligibleForNode, NoEligibleModelError, nodeCost, routeNode, spreadTo, costsFor, vendor } from "./routing.js";
import * as pricing from "./pricing.js";
import { collect } from "./routing-feedback.js";
import * as scopes from "./scopes.js";
import { currentTask, first, isCancelled, Task } from "./tasks.js";
import * as team from "./team.js";
import { delegate } from "./planning.js";

// What a step started early (headStart) is called among the tasks at work.
export const HEAD = "head:";
// A membership CLI cannot count its tool calls, so a contract step it runs is bounded by time instead:
// this many minutes per declared tool call, checked with its progress checks.
export const CLI_MINUTES_PER_TOOL_CALL = 1.5;
type Json = Record<string, any>;
type Verdict = quality.Verdict;
const accounted = (error: unknown) => ((error as Json)?.accounted_cost_usd as number) ?? 0;

/** A head start found its folder in use, so it does not wait for it (Executor.headStart). */
class FolderBusy extends Error {
  override name = "FolderBusy";
}

export class Executor extends Preflighting {
  constructor(db: Database, providers: Providers, modelLookup: Record<string, ModelProfile>) {
    super(db, providers, modelLookup);
  }

  // --- learning (Python's Learning mixin, learning.ts) ------------------------------------------
  finishLearning(runId: string): void {
    learning.finishLearning(this, runId);
  }

  skipCancelledLearning(runId: string): void {
    learning.skipCancelledLearning(this, runId);
  }

  startLearning(runId: string, manual = false) {
    return learning.startLearning(this, runId, { manual });
  }

  restoreLearning(): void {
    learning.restoreLearning(this);
  }

  syncImprovements(): void {
    learning.syncImprovements(this.db);
  }

  // --- running tasks ----------------------------------------------------------------------------

  start(runId: string): void {
    if (this.platformPending) {
      const run = this.db.getRun(runId);
      if (run) this.holdForPlatform(run);
      return;
    }
    const task = this.tasks.get(runId);
    if (!task || task.done) this.tasks.set(runId, new Task(() => this.execute(runId)));
  }

  cancel(runId: string): void {
    this.skipCancelledLearning(runId);
    for (const task of new Set([this.tasks.get(runId), this.diagnosing.get(runId)])) if (task && !task.done) task.cancel();
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    const all = new Set<Task<unknown>>([...this.tasks.values(), ...this.diagnosing.values(), ...this.learningTasks.values(), ...this.namingTasks.values()]);
    for (const task of [this.maintenanceTask, this.engineerTask]) if (task) all.add(task);
    for (const task of all) if (!task.done) task.cancel();
    await Promise.all([...all].map((task) => task.settled()));
  }

  async execute(runId: string): Promise<void> {
    let run = this.db.getRun(runId);
    if (!run || run.status !== "queued") return;
    run.status = "running";
    // Steps left running by an interrupted process never finished; run them again.
    for (const node of run.plan.nodes) {
      if (node.status === "running") node.status = "pending";
      node.preparing = false;
    }
    this.save(run);
    this.emit(run.id, "run.started");
    if (run.project_dir) this.emit(run.id, "workspace.snapshot", { project_dir: run.project_dir, ...gitSnapshot(run.project_dir) });
    if (!(await this.preflight(runId))) return; // paused: something the task needs is missing (preflight.ts)
    run = this.db.getRun(runId);
    if (run?.plan.employees.length) {
      team.refreshSkills(run.plan);
      this.save(run);
    }
    const running = new Map<Task<void>, string>();
    const signal = currentTask()?.signal;
    // Stopped with the task: the wait for its steps ends at once (the steps are then cancelled).
    const cancelled = new Promise<never>((_, fail) => {
      if (signal?.aborted) fail(signal.reason);
      signal?.addEventListener("abort", () => fail(signal.reason), { once: true });
    });
    cancelled.catch(() => undefined);
    try {
      for (;;) {
        for (;;) {
          run = this.db.getRun(runId);
          if (!run) return;
          if (run.status === "cancelled" || run.status === "paused") {
            // Let steps in flight finish so their results and costs are recorded.
            if (!running.size) return;
          } else {
            let heldBack = false;
            if (this.platformPending) {
              this.holdForPlatform(run);
              if (!running.size) return;
            } else heldBack = await this.dispatch(run, running);
            if (!running.size) {
              if (heldBack) {
                this.pauseForBudget(run);
                return;
              }
              break;
            }
          }
          await Promise.race([first(running.keys()), cancelled]);
          for (const [task] of [...running]) {
            if (!task.done) continue;
            running.delete(task);
            if (task.error !== undefined && !isCancelled(task.error)) throw task.error;
          }
        }
        run = this.db.getRun(runId);
        if (!run) return;
        const failed = run.plan.nodes.filter((node) => node.status === "failed");
        if (failed.length) {
          throw new Error(`${failed.length} 个步骤失败：` + failed.map((node) =>
            `${node.title}（${head(node.review || node.attempts.at(-1)?.reason || "" || "未知原因", 160) || "未知原因"}）`).join("；"));
        }
        const unable = run.plan.nodes.filter((node) => node.status === "unable" || node.status === "blocked");
        if (unable.length) {
          this.endIncomplete(run, unable);
          return;
        }
        if (run.plan.nodes.some((node) => node.status !== "succeeded")) throw new Error("Task graph is blocked by failed or cyclic dependencies");
        // The lead checks the whole result first; steps it reworks or adds run before the end.
        if (await this.finalReview(runId)) continue;
        run = this.db.getRun(runId)!;
        run.status = "succeeded";
        run.final_result = Executor.finalResult(run);
        this.save(run);
        this.emit(run.id, "run.succeeded", { actual_cost_usd: run.actual_cost_usd });
        this.forget(runId);
        this.startCapabilityProposals(runId);
        return;
      }
    } catch (error) {
      await Executor.stopNodes(running);
      const latest = this.db.getRun(runId);
      if (isCancelled(error)) {
        // Only a user cancel marks steps cancelled; on shutdown they stay running to resume.
        if (latest && latest.status === "cancelled") {
          for (const node of latest.plan.nodes) if (node.status === "running") node.status = "cancelled";
          this.save(latest);
        }
        throw error;
      }
      if (latest) {
        latest.status = "failed";
        latest.error = (error as Error)?.message ?? String(error);
        this.save(latest);
        this.emit(latest.id, "run.failed", { error: latest.error });
      }
    }
  }

  /** Everything possible is done; say plainly what is not and why, instead of success. */
  endIncomplete(run: ExecutionRun, unable: TaskNode[]): void {
    const skipped = quality.descendants(run, new Set(unable.map((node) => node.id)));
    for (const node of run.plan.nodes) {
      if (skipped.has(node.id) && node.status === "pending") {
        node.status = "blocked";
        node.review = "依赖的步骤无法完成，这一步没有执行。";
      }
    }
    const reasons = unable.map((node) => `${node.title}（${head((node.unable_reason || "").split(/\r\n|\n|\r/)[0] ?? "", 160)}）`).join("；");
    const done = Executor.finalResult(run, true);
    const sections = [`## 未能完成\n\n${unable.length} 个步骤在当前环境中无法完成，任务没有全部做完：`,
      ...unable.map((node) => `### ${node.title}\n\n${node.unable_reason || "未说明原因。"}`)];
    const blocked = run.plan.nodes.filter((node) => node.status === "blocked").map((node) => node.title);
    if (blocked.length) sections.push("因此没有执行：" + blocked.map((title) => `「${title}」`).join("、"));
    if (done) sections.push(`## 已完成的部分\n\n${done}`);
    run.status = "incomplete";
    run.final_result = sections.join("\n\n");
    run.error = `${unable.length} 个步骤无法完成：${reasons}`;
    this.save(run);
    this.emit(run.id, "run.incomplete", { actual_cost_usd: run.actual_cost_usd, unable: unable.map((node) => node.id), blocked });
  }

  /** Start ready steps up to the parallel limit; true if the budget held any back. */
  async dispatch(run: ExecutionRun, running: Map<Task<void>, string>): Promise<boolean> {
    const inFlight = new Set(running.values());
    // Steps at work, including those started early (headStart).
    const started = new Set([...inFlight].map((item) => (item.startsWith(HEAD) ? item.slice(HEAD.length) : item)));
    const completed = new Set(run.plan.nodes.filter((node) => node.status === "succeeded").map((node) => node.id));
    const ready = run.plan.nodes.filter((node) => node.status === "pending" && !started.has(node.id) && node.dependencies.every((dep) => completed.has(dep)));
    let reserved = run.actual_cost_usd + run.plan.nodes.filter((node) => inFlight.has(node.id)).reduce((sum, node) => sum + node.estimated_cost_usd, 0);
    let heldBack = false;
    const load = new Map<string, number>();
    for (const node of run.plan.nodes) {
      const model = node.model_id ? this.modelLookup[node.model_id] : undefined;
      if (started.has(node.id) && model) load.set(model.provider, (load.get(model.provider) ?? 0) + 1);
    }
    const atCapacity = (model: ModelProfile | undefined) => {
      if (run.plan.employees.length && model) {
        // An employee is a role, not a worker: its independent tasks run at the same time, each in a
        // session of its own; only a provider's capacity holds them back.
        const cap = ((settings.provider_limits[model.provider] ?? {}) as Json).concurrency ?? 0;
        if (cap && (load.get(model.provider) ?? 0) >= cap) return true;
      }
      const limit = settings.max_parallel_nodes;
      return Boolean(limit) && running.size >= limit;
    };
    for (const node of ready) {
      if (node.status !== "pending") continue;
      if (!(await this.admitToolChannel(run, node, reserved))) {
        // Handed to its lead at its limit: counted as at work, so the task waits for the decision.
        if (handedToLead(node)) {
          running.set(new Task(() => this.leadAtLimit(run.id, node.id)), node.id);
          started.add(node.id);
        }
        continue;
      }
      const model = node.model_id ? this.modelLookup[node.model_id] : undefined;
      if (atCapacity(model)) continue;
      if (node.estimated_cost_usd && reserved + node.estimated_cost_usd > run.budget_usd) {
        heldBack = true;
        continue;
      }
      reserved += node.estimated_cost_usd;
      if (model) load.set(model.provider, (load.get(model.provider) ?? 0) + 1);
      running.set(new Task(() => this.executeNode(run.id, node.id)), node.id);
      started.add(node.id);
    }
    // With room left, steps still waiting for their inputs start on what does not need them.
    for (const node of run.plan.nodes) {
      if (!this.canHeadStart(run, node, started)) continue;
      const model = this.modelLookup[node.model_id!];
      if (atCapacity(model) || reserved + node.estimated_cost_usd > run.budget_usd) continue;
      load.set(model.provider, (load.get(model.provider) ?? 0) + 1);
      started.add(node.id);
      running.set(new Task(() => this.headStart(run.id, node.id)), HEAD + node.id);
    }
    return heldBack;
  }

  /** Whether ``node`` may start early: on, its first time in this generation, waiting only for steps
   *  still to do or at work, on a model that edits files, with files or folders of its own (an unscoped
   *  step would hold the whole folder and stop the steps it waits for). */
  canHeadStart(run: ExecutionRun, node: TaskNode, started: Set<string>): boolean {
    if (!settings.head_start || node.status !== "pending" || started.has(node.id) || node.attempts.length || node.head_start_generation === node.generation) return false;
    const byId = new Map(run.plan.nodes.map((item) => [item.id, item]));
    const waiting = node.dependencies.map((dep) => byId.get(dep)).filter((dep): dep is TaskNode => Boolean(dep) && dep!.status !== "succeeded");
    if (!waiting.length || waiting.some((dep) => dep.status !== "pending" && dep.status !== "running")) return false;
    const model = this.modelLookup[node.model_id || ""];
    if (!model || this.outOfQuota(node.model_id) || !(node.model_id!.startsWith("cli:") || canAct(model))) return false;
    const scope = scopes.of(node);
    if (scope.everything || !scope.writes.size) return false;
    // Waiting for the folder would hold a place and start only once its inputs are ready.
    const folder = this.folderLocks.get(Executor.folder(run, node));
    return !(folder && folder.busy(scope));
  }

  /** Start a step early, while steps it depends on are at work, on what does not need their results. Not
   *  reviewed and not an attempt; its report goes into the step's first attempt. */
  async headStart(runId: string, nodeId: string): Promise<void> {
    const begun = await this.locked(runId, () => {
      const run = this.db.getRun(runId);
      const node = run?.plan.nodes.find((item) => item.id === nodeId);
      if (!run || !node || run.status !== "running" || this.platformPending || !this.canHeadStart(run, node, new Set())) return null;
      node.preparing = true;
      node.head_start_generation = node.generation;
      this.save(run);
      return [run, node] as const;
    });
    if (!begun) return;
    const [run, node] = begun;
    this.emit(runId, "node.head_start", { node_id: nodeId, model_id: node.model_id });
    let report = "";
    let error: string | null = null;
    let skipped = false;
    const stop = new AbortController();
    const outer = currentTask()?.signal;
    const signal = outer ? AbortSignal.any([outer, stop.signal]) : stop.signal;
    let timer: NodeJS.Timeout | undefined;
    try {
      const prompt = quality.headStartPrompt(node, run, settings.handoff_max_chars);
      const [result] = await Promise.race([this.work(run, node, node.model_id!, prompt, false, null, true, signal), new Promise<never>((_, fail) => {
        timer = setTimeout(() => {
          stop.abort(new Error("head start limit"));
          fail(Object.assign(new Error("head start limit"), { name: "TimeoutError" }));
        }, settings.head_start_minutes * 60_000);
      })]);
      report = (result.text || "").trim();
    } catch (problem) {
      if ((problem as Error)?.name === "TimeoutError") {
        error = `准备到了 ${formatG(settings.head_start_minutes)} 分钟的时限，已停下，可能有没做完的文件。`;
        report = `(Stopped at the ${formatG(settings.head_start_minutes)}-minute limit; some files may be unfinished.)`;
      } else if (problem instanceof FolderBusy) skipped = true;
      else if (isCancelled(problem) && outer?.aborted) throw problem;
      else error = head(String((problem as Error)?.message ?? problem), 500); // the step itself still runs once its inputs are ready
    } finally {
      clearTimeout(timer);
      await this.locked(runId, () => {
        const latest = this.db.getRun(runId);
        const current = latest?.plan.nodes.find((item) => item.id === nodeId);
        if (latest && current) {
          current.preparing = false;
          if (skipped && current.head_start_generation === node.generation) current.head_start_generation = null; // may start early once the folder is free
          if (report && current.generation === node.generation) current.head_start = report;
          this.save(latest);
        }
      });
      this.releaseLog(runId, nodeId);
    }
    this.emit(runId, "node.head_started", { node_id: nodeId, error, skipped });
  }

  /** Fail closed before starting work; replacements use ordinary routing and permissions. */
  async admitToolChannel(run: ExecutionRun, node: TaskNode, given: number | null = null, previousModelId: string | null = null): Promise<boolean> {
    const limits = team.governors(run.plan, node);
    try {
      for (const upstream of run.plan.nodes) if (node.dependencies.includes(upstream.id)) contracts.accepted(run, upstream);
    } catch (error) {
      if (!(error instanceof contracts.ArtifactBlocked)) throw error;
      this.stopContract(run, node, error.message, "blocked", { started: false, code: "upstream_not_accepted",
        affected_dependencies: [...quality.descendants(run, new Set([node.id]))].sort() });
      this.save(run);
      return false;
    }
    if (!limits.length) return true;
    const configured = this.configured(run);
    const allowed = eligibleForNode(node, Object.values(this.modelLookup), configured, this.needsVision(run));
    const eligible = new Set(allowed.filter((model) => scoreFor(model.scores!, node.capability) >= node.quality_threshold).map((model) => model.id));
    // The model the task's lead switched this step to keeps it below the quality threshold: the lead
    // judged it fit (often because the stronger one keeps failing), and moving it back would undo that.
    const decision = run.decisions.filter((item) => item.node_id === node.id).at(-1);
    if (decision?.action === "switch_model" && decision.model_id === node.model_id && allowed.some((model) => model.id === node.model_id)) {
      eligible.add(node.model_id!);
    }
    if (run.plan.employees.length) {
      const employee = team.member(run.plan, node.employee_id);
      if (!employee || !employee.capabilities.includes(node.capability)) eligible.clear();
    }
    const reserved = given ?? run.actual_cost_usd + run.plan.nodes.filter((item) => item.status === "running" && item.id !== node.id).reduce((sum, item) => sum + item.estimated_cost_usd, 0);
    const stepLeft = Math.min(...limits.map((n) => n.artifact_contract!.max_cost_usd - n.contract_cost_usd));
    const channels: Json[] = [];
    const candidates: ModelProfile[] = [];
    const costs = await costsFor(node, Object.values(this.modelLookup).filter((model) => eligible.has(model.id)));
    for (const model of Object.values(this.modelLookup)) {
      const declared = this.providers.toolLimitCapabilities ? this.providers.toolLimitCapabilities(model.id) : {};
      // Membership CLIs cannot count tool calls; they are bounded by time instead (timedWatch).
      const compatible = canAct(model) && (model.id.startsWith("cli:") || Object.entries(TOOL_LIMIT_REQUIREMENTS).every(([k, v]) => declared[k] === v));
      const cost = eligible.has(model.id) ? costs[model.id] ?? 0 : null;
      const affordable = cost !== null && reserved + cost <= run.budget_usd && cost <= stepLeft;
      channels.push({ model_id: model.id, declared_capabilities: declared, authorized: configured.has(model.id), eligible: eligible.has(model.id), compatible, affordable });
      const retained = model.id === node.model_id && (previousModelId === null || previousModelId === model.id);
      if (compatible && eligible.has(model.id) && (retained || affordable)) candidates.push(model);
    }
    const reason = limits.map((n) => this.contractLimitReason(n)).find(Boolean) ?? null;
    // At its own declared limit before it starts (an early start used the calls, say): its lead decides,
    // as for a limit reached while working (finish): more calls, a split, a repair or giving up. The
    // caller hands it over (leadAtLimit); only without a lead does it stop as declared.
    const own = this.contractLimitReason(node);
    if (own && this.canLead()) {
      node.status = "running";
      // Recorded as an attempt that stopped before doing anything: the lead reads the last attempt, and
      // the step's history shows why its calls are used up.
      node.attempts.push(NodeAttemptSchema.parse({ model_id: node.model_id, outcome: "stopped", reason: `开始前已用完：${own}` }));
      this.save(run);
      this.emit(run.id, "node.limit_reached", { node_id: node.id, reason: own, started: false });
      return false;
    }
    if (candidates.length && !reason) {
      if (!candidates.some((model) => model.id === node.model_id)) {
        const previous = node.model_id;
        await routeNode(node, candidates, configured, this.needsVision(run));
        this.save(run);
        this.emit(run.id, "node.model_switched", { node_id: node.id, model_id: previous, next_model_id: node.model_id, reason: "tool_limit_compatibility" });
      }
      return true;
    }
    this.stopContract(run, node, reason || "没有已授权且满足能力、预算及工具调用硬上限要求的执行通道。", reason ? "stopped" : "blocked", {
      started: false, code: reason ? "contract_limit_exhausted" : "tool_limit_incompatible", required_capabilities: { ...TOOL_LIMIT_REQUIREMENTS }, channels,
      actual_counts: Object.fromEntries(limits.map((n) => [n.id, { requests: n.contract_turns, tool_calls: n.contract_tool_calls, cost_usd: n.contract_cost_usd,
        limit: n.artifact_contract!.max_turns }])),
      affected_dependencies: [...quality.descendants(run, new Set([node.id]))].sort() });
    this.save(run);
    return false;
  }

  static async stopNodes(running: Map<Task<void>, string>): Promise<void> {
    for (const task of running.keys()) task.cancel();
    await Promise.all([...running.keys()].map((task) => task.settled()));
  }

  /** A step at its declared limit before it started (admitToolChannel), for its lead to decide. */
  async leadAtLimit(runId: string, nodeId: string): Promise<void> {
    const node = this.db.getRun(runId)?.plan.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    const reason = this.contractLimitReason(node) ?? "达到声明上限，停止工作包。";
    await this.decide(runId, nodeId, quality.verdict({ passed: false, reason }), "stopped");
  }

  async executeNode(runId: string, nodeId: string): Promise<void> {
    const begun = await this.locked(runId, async () => {
      const run = this.db.getRun(runId);
      if (!run) return null;
      const node = run.plan.nodes.find((item) => item.id === nodeId)!;
      if (node.status !== "pending" || run.status !== "running") return null;
      if (run.plan.nodes.some((n) => node.dependencies.includes(n.id) && n.status !== "succeeded")) return null;
      if (this.platformPending) {
        this.holdForPlatform(run);
        return null;
      }
      const admitted = node.model_id;
      if (!this.outOfQuota(node.model_id)) {
        try {
          await this.refreshModel(run, node);
        } catch (error) {
          if (!(error instanceof NoEligibleModelError)) throw error;
          if (team.governors(run.plan, node).length) {
            if (!(await this.admitToolChannel(run, node))) return handedToLead(node) ? "lead" : null;
          } else {
            run.status = "paused";
            run.error = error.message;
            this.save(run);
            this.emit(runId, "approval.required", { reason: "model_unavailable", node_id: node.id });
            return null;
          }
        }
        await this.spread(run, node);
      }
      // Refreshing, spreading and concurrent work may have changed the final channel or limits.
      if (!(await this.admitToolChannel(run, node, null, admitted))) return handedToLead(node) ? "lead" : null;
      if (!this.outOfQuota(node.model_id) && node.estimated_cost_usd && run.actual_cost_usd + node.estimated_cost_usd > run.budget_usd) {
        this.pauseForBudget(run);
        return null;
      }
      node.status = "running";
      node.started_at = nowIso();
      node.waiting_for_folder = false;
      this.save(run);
      return [run, node] as const;
    });
    if (!begun) return;
    if (begun === "lead") return this.leadAtLimit(runId, nodeId);
    const [run, node] = begun;
    this.emit(runId, "node.started", { node_id: node.id, model_id: node.model_id, attempt: node.attempts.length + 1 });
    const generation = node.generation;
    const key = stepKey(runId, nodeId);
    const self = currentTask() as Task<void> | null;
    if (self) this.nodeTasks.set(key, self);
    let inputs: Json[] = [];
    let workAccounted = 0;
    try {
      let prompt: string;
      [prompt, inputs] = quality.nodePrompt(node, run, settings.handoff_max_chars) as [string, Json[]];
      // Routed before its model ran out (at planning, or before a pause).
      if (this.outOfQuota(node.model_id)) throw this.providers.quota!.error(node.model_id!);
      const [result, changed, cost, workspace] = await this.work(run, node, node.model_id || "mock:local", prompt, await this.fallbackAllowed(run, node),
        this.conversation(run, node), false, self?.signal);
      workAccounted = result.accounted_cost_usd;
      const intruded = this.intrusions.get(key);
      this.intrusions.delete(key);
      const latest = this.db.getRun(runId);
      const stale = latest !== null && latest.plan.nodes.find((n) => n.id === nodeId)!.generation !== generation;
      let verdict: Verdict;
      if (run.plan.employees.length && uses.delegation() && result.text.trimStart().startsWith(team.DELEGATE)) {
        try {
          const payload = team.parseDelegation(result.text)!;
          await this.delegateResult(runId, nodeId, payload, result, inputs, changed, cost, generation);
          return;
        } catch (error) {
          if (!(error instanceof TypeError || (error as Error)?.name === "ValueError" || error instanceof SyntaxError)) throw error;
          verdict = quality.verdict({ passed: false, reason: `委派请求未通过校验：${(error as Error).message}`, fix: (error as Error).message });
        }
      } else verdict = stale ? quality.verdict({ passed: false, reason: "上游已返工，本次结果失效。" }) : await this.checkResult(run, node, result.text, changed, workspace);
      if (intruded?.length && !stale) {
        const paths = intruded.slice(0, 5).map(([path]) => path).join("、");
        verdict = quality.verdict({ passed: false, reason: `改了自己范围外的文件 ${paths}，而同时在跑的「${intruded[0][1]}」正把它们当输入使用。`,
          fix: "Change only the files in your own scope. If these files must change, say so in your report instead, so the lead can give the change to the right step: "
            + intruded.map(([path]) => path).join(", ") });
      }
      // Nobody checked it, and a summary made at the turn limit says the work is unfinished.
      if (result.turn_limit && verdict.passed && !verdict.reviewer_model_id) {
        verdict = quality.verdict({ passed: false, reason: `用完了工具调用轮次，${TURN_LIMIT_HINT}：只交了进度总结。` });
      }
      await this.finish(runId, nodeId, result, verdict, inputs, changed, cost, null, { generation });
    } catch (error) {
      if (isCancelled(error)) {
        const spent = accounted(error) + workAccounted;
        const latest = this.db.getRun(runId);
        if (latest) {
          const current = latest.plan.nodes.find((n) => n.id === nodeId)!;
          if (current.attempts.length === node.attempts.length) {
            current.attempts.push(NodeAttemptSchema.parse({ model_id: node.model_id, outcome: current.generation !== generation ? "superseded" : "cancelled",
              interrupted: latest.status !== "cancelled", reason: "上游返工或任务取消，调用已停止。", cost_usd: spent,
              ...this.takeLog(runId, nodeId, (error as Json)?.usage ?? null) }));
          }
          this.save(latest);
          this.releaseLog(runId, nodeId);
          if (current.generation !== generation) return;
        }
        throw error;
      }
      if (error instanceof ModelUnavailable) {
        await this.switchModel(runId, nodeId, error);
        return;
      }
      const spent = accounted(error) + workAccounted;
      const usage = (error as Json)?.usage ?? null;
      const outcome = error instanceof BudgetExceeded ? "budget" : error instanceof StepLimitExceeded ? "stopped" : error instanceof contracts.ArtifactBlocked ? "blocked" : "error";
      await this.finish(runId, nodeId, null, quality.verdict({ passed: false, reason: (error as Error)?.message ?? String(error) }), inputs, [], spent, outcome,
        { generation, accounted: spent, usage });
    } finally {
      this.nodeTasks.delete(key);
    }
  }

  /** Commit the child graph and the parent's yielded attempt in one saved run. */
  async delegateResult(runId: string, nodeId: string, payload: Json, result: ProviderResult, inputs: Json[], changed: string[], cost: number, generation: number): Promise<void> {
    const emitted = await this.locked(runId, async () => {
      const run = this.db.getRun(runId);
      if (!run) return null;
      let node = run.plan.nodes.find((n) => n.id === nodeId)!;
      const stale = node.generation !== generation;
      const stopped = ["cancelled", "succeeded", "failed", "incomplete"].includes(run.status) || node.status !== "running";
      const outcome = stale ? "superseded" : stopped ? "cancelled" : "delegated";
      let children: TaskNode[] = [];
      if (!stale && !stopped) {
        for (const governor of team.governors(run.plan, node)) {
          const reason = this.contractLimitReason(governor);
          if (reason) throw new StepLimitExceeded(reason);
        }
        const existing = run.plan.nodes.filter((n) => n.delegation_parent_id === node.id && n.delegation_request_id === payload.request_id);
        if (existing.length && existing.every((n) => n.status === "succeeded")) {
          throw Object.assign(new Error("该委派已完成，请使用已有子任务结果继续原任务，不要再次委派。"), { name: "ValueError" });
        }
        children = await delegate(run, node, payload, Object.values(this.modelLookup), this.configured(run), this.needsVision(run));
        node = run.plan.nodes.find((n) => n.id === nodeId)!;
        node.status = "pending";
        node.review_passed = null;
        node.feedback = null;
        node.review = "等待委派任务验收：" + children.map((n) => n.title).join("、");
        node.result = result.text;
        node.inputs = inputs as TaskNode["inputs"];
        node.changed_files = [...new Set([...node.changed_files, ...changed])];
      }
      node.attempts.push(NodeAttemptSchema.parse({ model_id: result.used_model_id || node.model_id, outcome,
        reason: children.length ? node.review : "任务已停止或上游变化，未发布子任务。", cost_usd: cost, ...this.takeLog(runId, nodeId, result as unknown as Json) }));
      run.actual_cost_usd = pyRound(run.actual_cost_usd + Math.max(0, cost - result.accounted_cost_usd), 6);
      await pricing.reestimate(run);
      this.save(run);
      this.releaseLog(runId, nodeId);
      return children.length ? { node, children } : null;
    });
    if (emitted) {
      this.emit(runId, "node.delegated", { node_id: nodeId, employee_id: emitted.node.employee_id,
        children: emitted.children.map((n) => ({ id: n.id, employee_id: n.employee_id, title: n.title })), reason: head(String(payload.reason || ""), 2000) });
    }
  }

  /** Restore within the same task generation and dependency revision; model switches receive an archived
   *  handoff. Long contexts are compressed by the provider, never discarded. */
  conversation(run: ExecutionRun, node: TaskNode): Conversation {
    const key = stepKey(run.id, node.id);
    let held = this.conversations.get(key) ?? null;
    const last = node.attempts.at(-1) ?? null;
    if (held === null) {
      const saved = this.db.conversation(run.id, node.id);
      if (saved) held = new Conversation({ modelId: (saved.model_id as string) ?? null, state: (saved.state as Json) ?? null, fence: (saved.fence as Json) ?? null });
    }
    const dependencies = Object.fromEntries(run.plan.nodes.filter((item) => node.dependencies.includes(item.id))
      .map((item) => [item.id, [item.generation, item.attempts.length ? pyIsoformat(item.attempts.at(-1)!.finished_at) : null]]));
    const fence = { generation: node.generation, project: run.project_dir, request: createHash("sha256").update(pyDumps([run.prompt, node.instructions,
      node.acceptance_criteria, node.files, node.reads, node.check], false)).digest("hex"), dependencies };
    const checkpoint = (body: Json) => {
      const latest = this.db.getRun(run.id);
      const current = latest?.plan.nodes.find((item) => item.id === node.id);
      if (current && current.generation === node.generation) this.db.saveConversation(run.id, node.id, body);
    };
    const bind = (conversation: Conversation) => {
      conversation.fence = fence;
      conversation.checkpoint = checkpoint;
      conversation.archive = (body) => this.db.archiveConversation(run.id, node.id, body);
      conversation.recall = (archiveId) => this.db.conversationArchive(run.id, node.id, archiveId);
      return conversation;
    };
    const upstream = run.plan.nodes.filter((item) => node.dependencies.includes(item.id) && item.attempts.length).map((item) => item.attempts.at(-1)!.finished_at);
    let delegatedResume = false;
    const same = (a: unknown, b: unknown) => pyDumps(a, false, true) === pyDumps(b, false, true);
    if (held?.fence && last && last.outcome === "delegated") {
      const previous = held.fence as Json;
      const childIds = new Set(run.plan.nodes.filter((n) => n.delegation_parent_id === node.id).map((n) => n.id));
      delegatedResume = (["generation", "project", "request"] as const).every((k) => same(previous[k], fence[k]))
        && Object.entries(previous.dependencies ?? {}).every(([k, v]) => same(dependencies[k], v))
        && Object.keys(dependencies).filter((k) => !(k in (previous.dependencies ?? {}))).every((k) => childIds.has(k));
    }
    const valid = held !== null && (held.fence === null || same(held.fence, fence) || delegatedResume);
    if (valid && held!.modelId === node.model_id && (last === null || (last.outcome !== "superseded" && (last.outcome !== "cancelled" || last.interrupted)
      && !(last.reason || "").includes("进度检查判断这次尝试卡住，已停止：") && (delegatedResume || !upstream.some((finished) => timeOf(finished) > timeOf(last.finished_at)))))) {
      bind(held!);
      held!.followup = last ? quality.continuePrompt(node, run) : "The service restarted during this step. Continue from its saved state. "
        + "For any interrupted tool, inspect actual effects before repeating it.\n" + node.instructions;
      this.conversations.set(key, held!);
      return held!;
    }
    const fresh = bind(new Conversation());
    if (valid && held!.state) {
      bind(held!);
      fresh.handoff = memory.handoff(held!);
    }
    this.conversations.set(key, fresh);
    return fresh;
  }

  /** ``prompt`` with the full text of the files the step needs. A work package the planner scoped gets
   *  its own files and nothing else; any other step gets the list of the project's files and the files it
   *  most likely needs (briefing.ts). */
  static withFiles(run: ExecutionRun, node: TaskNode, workspace: string, prompt: string): string {
    if (node.files.length || node.reads.length) {
      const attached = briefing.attachedFiles(workspace, [...node.files, ...node.reads], briefing.SCOPED_ATTACH_CHARS, briefing.SCOPED_ATTACH_CHARS);
      return [prompt, attached].filter(Boolean).join("\n\n");
    }
    const files = briefing.render(workspace, null);
    const attached = briefing.attachedFiles(workspace, briefing.likelyFiles(workspace, node, run));
    return [prompt, files, attached].filter(Boolean).join("\n\n");
  }

  forget(runId: string): void {
    for (const key of [...this.conversations.keys()]) if (key.startsWith(`${runId}\0`)) this.conversations.delete(key);
  }

  /** Revalidate a stored selection immediately before confirming or executing it. */
  async refreshModel(run: ExecutionRun, node: TaskNode): Promise<void> {
    const models = Object.values(this.modelLookup);
    if (run.plan.employees.length) {
      await team.route(node, run.plan, models, this.configured(run), this.needsVision(run));
      return;
    }
    const model = this.modelLookup[node.model_id || ""];
    const configured = this.configured(run);
    const available = eligibleForNode(node, models, configured, this.needsVision(run));
    // Lightweight provider doubles without configuration still obey explicit switches.
    const valid = model && model.enabled && (this.providers.configuredModels ? available.some((item) => item.id === node.model_id) : true);
    if (!valid) {
      const previous = node.model_id;
      await routeNode(node, models, configured, this.needsVision(run));
      this.emit(run.id, "node.model_switched", { node_id: node.id, model_id: previous, next_model_id: node.model_id, reason: "model_configuration_changed" });
    } else if (!node.attempts.length && node.routing_note && this.providers.configuredModels) {
      const previous = node.model_id;
      await routeNode(node, models, configured, this.needsVision(run), { feedback: collect(this.db) });
      if (node.model_id !== previous) this.emit(run.id, "node.model_switched", { node_id: node.id, model_id: previous, next_model_id: node.model_id, reason: "observed_delivery_cost" });
    }
  }

  /** Keep one provider (an API provider, or one membership CLI) from carrying all of the task's running
   *  steps, so that its outage or quota does not stop them all: past ``max_steps_per_provider`` the step
   *  goes to another provider's model when one fits (routing.spreadTo). */
  async spread(run: ExecutionRun, node: TaskNode): Promise<void> {
    if (run.plan.employees.length) return; // the lead owns employee model assignments
    const cap = settings.max_steps_per_provider;
    const of = (id: string | null) => {
      const model = id ? this.modelLookup[id] : undefined;
      return model ? vendor(model) : (id || "").split(":", 1)[0];
    };
    const provider = of(node.model_id);
    if (!cap || !node.model_id || provider === "mock") return;
    const running = new Map<string, number>();
    for (const item of run.plan.nodes) {
      if (item.status === "running" && item.id !== node.id) {
        const name = of(item.model_id);
        running.set(name, (running.get(name) ?? 0) + 1);
      }
    }
    if ((running.get(provider) ?? 0) < cap) return;
    const busy = new Set([...running].filter(([, count]) => count >= cap).map(([name]) => name));
    const other = await spreadTo(node, Object.values(this.modelLookup), this.configured(run), busy, this.needsVision(run));
    if (other === null) return;
    const previous = node.model_id;
    node.model_id = other.id;
    node.estimated_cost_usd = pyRound(await nodeCost(node, other), 6);
    this.emit(run.id, "node.model_switched", { node_id: node.id, model_id: previous, next_model_id: other.id, reason: "spread_across_providers" });
  }

  /** The step's model is unavailable: hand the step to a backup without counting a failed attempt, or
   *  pause the task when no other model can take it. */
  async switchModel(runId: string, nodeId: string, error: ModelUnavailable): Promise<void> {
    await this.locked(runId, async () => {
      const run = this.db.getRun(runId);
      if (!run) return;
      const node = run.plan.nodes.find((item) => item.id === nodeId)!;
      node.attempts.push(NodeAttemptSchema.parse({ model_id: error.modelId, outcome: error.kind, reason: error.message, cost_usd: accounted(error),
        ...this.takeLog(runId, nodeId, (error as unknown as Json).usage ?? null) }));
      if (node.artifact_contract) {
        node.contract_turns = Math.max(node.contract_turns, node.attempts.reduce((sum, a) => sum + a.turns, 0));
        node.contract_cost_usd = Math.max(node.contract_cost_usd, node.attempts.reduce((sum, a) => sum + a.cost_usd, 0));
      }
      const reason = this.contractLimitReason(node);
      if (reason) {
        const last = node.attempts.at(-1)!;
        last.outcome = "stopped";
        last.reason = reason + "\n" + error.message;
        this.stopContract(run, node, last.reason, "stopped");
      } else await this.routeAfterUnavailable(run, node, error);
      this.save(run);
      this.releaseLog(runId, nodeId);
    });
  }

  /** Have ``modelId`` do ``node`` in its working folder: the user's project or the task's scratch folder.
   *  Returns [result, changed files, cost, working folder]. ``conversation`` continues the step's last
   *  attempt when it holds a followup. A ``headStart`` records no contract baseline and has no progress
   *  watch. */
  async work(run: ExecutionRun, node: TaskNode, modelId: string, given: string, fallback: boolean, conversation: Conversation | null = null, headStart = false,
    signal?: AbortSignal): Promise<[ProviderResult, string[], number, string]> {
    let prompt = given;
    await this.locked(run.id, () => {
      const latest = this.db.getRun(run.id)!;
      learning.attach(this.db, latest);
      for (const item of latest.improvement_uses as Json[]) {
        if (learning.matches(item, learning.nodeText(node), node.capability) && !item.node_ids.includes(node.id)) item.node_ids.push(node.id);
      }
      run.improvement_uses = latest.improvement_uses;
      this.save(latest);
    });
    const lessons = learning.instruction(run.improvement_uses as Json[], node);
    if (lessons) prompt += "\n\n" + lessons;
    const inProject = Boolean(run.project_dir && node.needs_workspace);
    if (inProject) prompt = `You are working in the user's existing project at ${run.project_dir}. Edit files in place, keep changes focused on the task, and do not commit.\n\n` + prompt;
    const workspace = this.ensureFolder(Executor.folder(run, node));
    const model = this.modelLookup[modelId];
    // API models act on the workspace through tools; CLIs do so on their own.
    const act = Boolean(model && model.channel !== "cli" && canAct(model));
    const usesFiles = modelId.startsWith("cli:") || act;
    const scope = scopes.of(node);
    const key = stepKey(run.id, node.id);
    const inFolder = async (): Promise<[ProviderResult, string[]]> => {
      const before = usesFiles ? quality.files.state(workspace) : new Map<string, string>();
      // A continued conversation has its files already.
      if (usesFiles && before.size && !conversation?.followup) prompt = Executor.withFiles(run, node, workspace, prompt);
      this.workResults.delete(key);
      const entries: Json[] = [];
      this.toolLogs.set(key, entries);
      const trace = tracePath(run.id, node.id, headStart ? 0 : node.attempts.length + 1);
      this.toolTraces.set(key, trace);
      for (const governor of team.governors(run.plan, node)) {
        const reason = this.contractLimitReason(governor);
        if (reason) throw new StepLimitExceeded(reason);
      }
      if (node.artifact_contract && !headStart) {
        contracts.prepare(run, node);
        await this.locked(run.id, () => {
          const latest = this.db.getRun(run.id)!;
          const current = latest.plan.nodes.find((item) => item.id === node.id)!;
          for (const field of ["contract_generation", "artifact_inputs", "artifact_baseline", "artifact_evidence"] as const) (current as Json)[field] = (node as Json)[field];
          this.save(latest);
        });
      }
      const overrun = headStart ? null : this.overrunCheck(run, node, modelId);
      const result = await activity.recording(entries, () => this.complete(run, node, modelId, prompt, workspace, { allow_api_fallback: fallback && !inProject,
        attachments: run.attachments, act, max_turns: turnsFor(node), tool_log: entries, tool_trace: trace, watch: headStart ? null : this.timedWatch(run, node, modelId),
        effort: settings.reasoning_by_difficulty[node.difficulty] ?? null, ...(conversation ? { conversation } : {}), ...(overrun ? { overrun } : {}), signal }));
      this.workResults.set(key, result);
      let after: Map<string, string>;
      try {
        after = usesFiles ? quality.files.state(workspace) : new Map();
      } catch (error) {
        if (error && typeof error === "object") (error as Json).accounted_cost_usd = result.accounted_cost_usd;
        throw error;
      }
      const everything = quality.changedFiles(before, after);
      // Told to those still in the folder before it leaves (FolderLock.hold); it is credited only with its own.
      scope.changed = scope.own(everything);
      const changed = scope.mine(everything);
      const intruded = scope.intrusions(everything);
      if (intruded.length) this.intrusions.set(key, intruded);
      return [result, changed];
    };
    let result: ProviderResult;
    let changed: string[];
    if (usesFiles) {
      // Steps editing the same folder at once would clobber each other, unless the files they change do
      // not overlap (scopes.ts).
      let folder = this.folderLocks.get(workspace);
      if (!folder) this.folderLocks.set(workspace, (folder = new scopes.FolderLock()));
      const queued = folder.busy(scope);
      if (queued && headStart) throw new FolderBusy();
      if (queued) await this.noteQueued(run.id, node.id, true);
      [result, changed] = await folder.hold(scope, async () => {
        if (queued) await this.noteQueued(run.id, node.id, false);
        return inFolder();
      }, signal);
    } else [result, changed] = await inFolder();
    // The step's own model falls back to its routed estimate; a takeover has none.
    const cost = await this.actualCost(result, node, modelId === node.model_id ? null : modelId);
    return [result, changed, cost, workspace];
  }

  /** Show a running step as queued while it waits for the folder; when it gets in, its time starts then
   *  (started_at), not when it began waiting. */
  async noteQueued(runId: string, nodeId: string, waiting: boolean): Promise<void> {
    const changed = await this.locked(runId, () => {
      const run = this.db.getRun(runId);
      const node = run?.plan.nodes.find((item) => item.id === nodeId);
      if (!run || !node || node.status !== "running") return false;
      node.waiting_for_folder = waiting;
      if (!waiting) node.started_at = nowIso();
      this.save(run);
      return true;
    });
    if (changed) this.emit(runId, waiting ? "node.queued" : "node.dequeued", { node_id: nodeId });
  }

  /** The progress watch of an attempt; for a contract step on a membership CLI, which cannot count its
   *  tool calls, it also stops the attempt past the time its declared calls allow. */
  timedWatch(run: ExecutionRun, node: TaskNode, modelId: string) {
    const watch = this.progressWatch(run, node, modelId);
    const limits = team.governors(run.plan, node);
    const minutes = modelId.startsWith("cli:") && limits.length ? Math.min(...limits.map((n) => n.artifact_contract!.max_turns)) * CLI_MINUTES_PER_TOOL_CALL : null;
    const started = performance.now();
    return async (evidence: string): Promise<string | null> => {
      if (minutes !== null && (performance.now() - started) / 60_000 >= minutes) return `达到用时上限 ${fixed(minutes, 0)} 分钟（会员 CLI 无法统计工具调用次数，按用时约束）。`;
      // The checker's and the lead's calls are not the step's work.
      return activity.paused(() => watch(evidence));
    };
  }

  /** Record an attempt, then accept the step, retry it, or send verified work back. */
  async finish(runId: string, nodeId: string, result: ProviderResult | null, verdict: Verdict, inputs: Json[], changed: string[], cost: number, given: string | null,
    { generation = null, accounted: already = 0, usage = null }: { generation?: number | null; accounted?: number; usage?: Json | null } = {}): Promise<void> {
    const [next, outcome] = await this.locked(runId, async (): Promise<["lead" | "diagnose" | null, string]> => {
      const run = this.db.getRun(runId);
      if (!run) return [null, ""];
      const node = run.plan.nodes.find((item) => item.id === nodeId)!;
      const stale = generation !== null && node.generation !== generation;
      const returned = result ?? this.workResults.get(stepKey(runId, nodeId)) ?? null;
      const logged = this.takeLog(runId, nodeId, (result as unknown as Json) ?? usage);
      let outcome = given;
      if (node.artifact_contract && !stale) {
        node.contract_turns = Math.max(node.contract_turns, node.attempts.reduce((sum, a) => sum + a.turns, 0) + logged.turns);
        node.contract_cost_usd = Math.max(node.contract_cost_usd, node.attempts.reduce((sum, a) => sum + a.cost_usd, 0) + cost + verdict.cost_usd);
        node.artifact_evidence = verdict.artifact_evidence;
        if (verdict.passed) {
          try {
            contracts.accepted(run, node);
          } catch (error) {
            if (!(error instanceof contracts.ArtifactBlocked)) throw error;
            verdict.passed = false;
            verdict.reason = error.message;
          }
        }
        const reason = verdict.passed ? null : this.contractLimitReason(node);
        if (reason) {
          outcome = "stopped";
          verdict.reason = reason + "\n" + verdict.reason;
        }
      }
      // A verification that ran out of turns has not finished, which says nothing against the work it
      // verifies: it is retried itself rather than sending that work back.
      const unfinished = Boolean(result?.turn_limit) && (verdict.reason || "").includes(TURN_LIMIT_HINT);
      outcome = outcome || (verdict.blocked ? "blocked" : verdict.unable ? "unable" : !verdict.verified ? "unverified" : verdict.passed ? "passed"
        : node.verifies.length && !unfinished ? "verify_failed" : "rejected");
      if (stale) outcome = "superseded";
      const spent = pyRound(cost + verdict.cost_usd, 6);
      node.attempts.push(NodeAttemptSchema.parse({ model_id: returned?.used_model_id || node.model_id, outcome, reason: verdict.reason,
        reviewer_model_id: verdict.reviewer_model_id, cost_usd: spent, turn_limit: Boolean(returned?.turn_limit) || (verdict.reason || "").includes(TURN_LIMIT_HINT), ...logged }));
      const counted = already + (result?.accounted_cost_usd ?? 0) + verdict.accounted_cost_usd;
      run.actual_cost_usd = pyRound(run.actual_cost_usd + Math.max(0, spent - counted), 6);
      if (stale) {
        this.save(run);
        this.releaseLog(runId, nodeId);
        this.emit(runId, "node.superseded", { node_id: node.id });
        return [null, outcome];
      }
      const checked = verdict.verified && uses.review() && (settings.review_nodes || node.verifies.length > 0);
      node.inputs = inputs as TaskNode["inputs"];
      node.review_passed = checked ? verdict.passed : null;
      node.review = verdict.reason;
      if (logged.result !== null) {
        node.result = logged.result;
        node.summary = verdict.summary;
        node.changed_files = [...new Set([...node.changed_files, ...changed])];
      }
      // At a declared limit, or blocked (missing evidence, a target not reached, a platform rule), the lead
      // decides: more calls, rework upstream, a repair, ask the user, or give up (leading.ts). Without a
      // lead it stops as declared.
      const limited = this.canLead() && (outcome === "blocked" || (outcome === "stopped" && Boolean(this.contractLimitReason(node))));
      if (limited) node.status = "running";
      else if (outcome === "blocked" || outcome === "stopped") this.stopContract(run, node, verdict.reason, outcome);
      else if (outcome === "budget") {
        node.status = "pending";
        this.pauseForBudget(run);
      } else if (outcome === "passed") {
        node.status = "succeeded";
        node.feedback = null;
        node.failed_attempts = 0;
        node.accepted_by_lead = false;
        this.emit(runId, "node.succeeded", { node_id: node.id, cost_usd: spent, selected_model_id: node.model_id, used_model_id: result ? result.used_model_id : null });
      } else if (outcome === "verify_failed") {
        // The lead judges the findings before any work is sent back (leading.ts).
        if (this.canLead()) node.status = "running";
        else this.sendBack(run, node, verdict);
      } else if (uses.diagnosis() || (this.canLead() && uses.decisions())) {
        // Every failed attempt goes to the lead or is diagnosed first; repairDone then retries or pauses.
        node.status = "running";
      } else await this.recover(run, node, verdict, outcome);
      if (run.actual_cost_usd > run.budget_usd && run.status === "running") {
        run.status = "paused";
        this.emit(runId, "approval.required", { reason: "budget_exceeded", actual_cost_usd: run.actual_cost_usd });
      }
      // A verification out of rework rounds is a failure too.
      const diagnose = uses.diagnosis() && !limited && (node.status === "running" || (outcome === "verify_failed" && node.status === "failed"));
      // A failed attempt held for recovery goes to the task's lead (leading.ts).
      const lead = node.status === "running" && this.canLead() && (uses.decisions() || limited || outcome === "verify_failed");
      this.save(run);
      this.releaseLog(runId, nodeId);
      return [lead ? "lead" : diagnose ? "diagnose" : null, outcome];
    });
    if (next === "lead") await this.decide(runId, nodeId, verdict, outcome);
    else if (next === "diagnose") await this.repair(runId, nodeId, verdict, outcome);
  }
}

/** admitToolChannel gave the step to its lead (its limit reached before it started), rather than refusing it. */
function handedToLead(node: TaskNode): boolean {
  return node.status === "running";
}

/** A stored time's instant, for ordering times written in different forms. */
function timeOf(text: string): number {
  return Date.parse(text);
}
