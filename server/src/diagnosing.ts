// Diagnosing failed or stuck steps and acting on the diagnosis (recovery.afterDiagnosis
// decides what it means).
import * as agentTools from "./agent.js";
import { BudgetExceeded } from "./budget.js";
import { settings } from "./config.js";
import { interaction, parse as parseDiagnosis, prompt as diagnosisPrompt, repairPrompt, userAction } from "./diagnosis.js";
import * as environment from "./environment.js";
import { nowIso } from "./lax.js";
import { Leading } from "./leading.js";
import { type Diagnosis, DiagnosisSchema, type ExecutionRun, NodeAttemptSchema, type TaskNode } from "./models.js";
import { RepairError } from "./platform-repair.js";
import type { ProviderResult } from "./providers.js";
import { head, pyRound } from "./py.js";
import * as quality from "./quality.js";
import { failureKind } from "./quota.js";
import { afterDiagnosis } from "./recovery.js";
import * as retrospect from "./retrospect.js";
import { canAct, diagnosers, engineers, NoEligibleModelError, pickDiagnoser } from "./routing.js";
import { currentTask, isCancelled, Task } from "./tasks.js";

// Models tried in turn for one repair when the previous one fails.
export const MAX_DIAGNOSERS = 3;
type Json = Record<string, any>;
const shortId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 8);
const accounted = (error: unknown) => ((error as Json)?.accounted_cost_usd as number) ?? 0;
const withCost = (error: unknown, cost: number) => {
  if (error && typeof error === "object") (error as Json).accounted_cost_usd = cost;
};

export abstract class Diagnosing extends Leading {
  abstract fixPlatform(run: ExecutionRun, diagnosis: Diagnosis, node: TaskNode | null, problem: string): Promise<[string, number]>;
  abstract refreshModel(run: ExecutionRun, node: TaskNode): void;

  /** After a failed attempt, a strong model (a membership CLI when possible) looks for what blocks the
   *  step outside the task (missing software, sandbox or machine limits, configuration) and repairs it.
   *  Its status decides the rest (repairDone). Runs inside the step's task, so the run waits for it. */
  async repair(runId: string, nodeId: string, verdict: quality.Verdict, outcome: string,
    { diagnosisId = null, brief = "", decisionId = null }: { diagnosisId?: string | null; brief?: string; decisionId?: string | null } = {}): Promise<void> {
    let run!: ExecutionRun;
    let node!: TaskNode;
    let diagnosis!: Diagnosis;
    let started: string | null = diagnosisId;
    for (;;) {
      const outcome2 = await this.locked(runId, (): "stop" | "go" | Task<unknown> => {
        const found = this.db.getRun(runId);
        if (!found || found.status === "cancelled") return "stop";
        run = found;
        if (started) {
          node = run.plan.nodes.find((item) => item.id === nodeId)!;
          diagnosis = run.diagnoses.find((item) => item.id === started)!;
          return "go";
        }
        const busy = this.diagnosing.get(runId);
        // The slot may be this very task: the lead's answer to the user, which led here.
        if (!busy || busy.done || busy === currentTask()) {
          node = run.plan.nodes.find((item) => item.id === nodeId)!;
          started = this.beginDiagnosis(run, decisionId ? "lead_repair" : "auto", nodeId);
          diagnosis = run.diagnoses.at(-1)!;
          diagnosis.decision_id = decisionId;
          if (started) {
            const self = currentTask();
            if (self) this.diagnosing.set(runId, self);
          }
          this.save(run);
          return "go";
        }
        return busy;
      });
      if (outcome2 === "stop") return;
      if (outcome2 === "go") break;
      // Another diagnosis (manual, or another step's repair) is running; this one follows it.
      await outcome2.settled();
    }
    if (!started) return this.repairDone(runId, nodeId, diagnosis.id, null, null, 0, verdict, outcome);
    const workspace = this.ensureFolder(Diagnosing.folder(run, node));
    const events = this.eventLines(runId);
    let cost = 0;
    let text: string;
    let sharedFiles: string[];
    const releaseSlot = () => {
      if (diagnosis.trigger !== "manual") this.diagnosing.delete(runId);
    };
    try {
      [text, sharedFiles] = await this.repairLock.run(async () => {
        const shared = environment.prepare();
        const before = quality.files.state(shared);
        const prompt = repairPrompt(run, node, workspace, shared, await agentTools.deps.sandboxPorts(), events, this.db.sharedRepairs(5) as never,
          this.platform.context(), brief, retrospect.similar(this.db, run, node));
        let found: string;
        if (this.platformPending) {
          [found] = await this.fixPlatform(run, diagnosis, node, "");
        } else {
          let result: ProviderResult;
          [result, , cost] = await this.diagnoseWith(run, diagnosis, node, prompt, workspace, true);
          found = result.text;
          if (parseDiagnosis(found)[2] === "platform_repair") {
            let extra: number;
            try {
              [found, extra] = await this.fixPlatform(run, diagnosis, node, found);
            } catch (error) {
              withCost(error, accounted(error) + cost);
              throw error;
            }
            cost += extra;
          }
        }
        return [found, quality.changedFiles(before, quality.files.state(shared))] as [string, string[]];
      });
    } catch (error) {
      if (isCancelled(error)) {
        releaseSlot();
        // Stopped by a cancel or shutdown; the record must not stay "running".
        const stopped = this.db.getRun(runId);
        for (const item of stopped?.diagnoses ?? []) {
          if (item.id === diagnosis.id && item.status === "running") {
            item.status = "failed";
            item.error = "修复被中断（任务取消或服务重启）。";
            item.cost_usd = pyRound(Math.max(cost, accounted(error)), 6);
            item.finished_at = nowIso();
            this.save(stopped!);
          }
        }
        throw error;
      }
      cost = Math.max(cost, accounted(error));
      releaseSlot();
      if (error instanceof BudgetExceeded) {
        await this.locked(runId, () => {
          const current = this.db.getRun(runId)!;
          current.plan.nodes.find((n) => n.id === nodeId)!.status = "pending";
          const record = current.diagnoses.find((d) => d.id === diagnosis.id)!;
          if (record.reply_to && current.waiting_diagnosis_id === record.reply_to) current.waiting_diagnosis_id = null;
          record.status = "failed";
          record.error = error.message;
          record.cost_usd = pyRound(cost, 6);
          record.finished_at = nowIso();
          this.pauseForBudget(current);
          this.emit(runId, "run.diagnosed", { diagnosis_id: record.id, status: record.status });
        });
        return;
      }
      return this.repairDone(runId, nodeId, diagnosis.id, null, head(String((error as Error)?.message ?? error), 500), cost, verdict, outcome);
    }
    releaseSlot();
    await this.repairDone(runId, nodeId, diagnosis.id, text, null, cost, verdict, outcome, sharedFiles);
  }

  /** Run a diagnosis on its model, or, if that fails (a CLI at its usage limit, say), on the next
   *  diagnosers in turn. Returns the result and the model that gave it; switches are recorded as events,
   *  and the last failure is thrown. */
  async diagnoseWith(given: ExecutionRun, diagnosis: Diagnosis, node: TaskNode | null, prompt: string, workspace: string, repair: boolean,
    edit = false): Promise<[ProviderResult, string, number]> {
    const runId = given.id;
    const diagnosisId = diagnosis.id;
    let available;
    if (edit) {
      // Changing FluidForm's source: only strong models. Membership CLIs too when they cost nothing,
      // whatever the task allows its own steps (it is not the task's work).
      const configured = this.configured(given);
      if (settings.cli_free && this.providers.configuredModels) {
        for (const id of this.providers.configuredModels(Object.keys(this.modelLookup))) if (id.startsWith("cli:")) configured.add(id);
      }
      available = engineers(Object.values(this.modelLookup), configured);
    } else available = diagnosers(Object.values(this.modelLookup), this.configured(given));
    const allowed = new Set(available.map((model) => model.id));
    const candidates = [...(diagnosis.model_id && allowed.has(diagnosis.model_id) ? [diagnosis.model_id] : []),
      ...available.map((model) => model.id).filter((id) => id !== diagnosis.model_id)].slice(0, MAX_DIAGNOSERS);
    if (!candidates.length) throw new RepairError("没有当前可用、能做这次修复的模型。");
    if (candidates[0] !== diagnosis.model_id) {
      const latest = this.db.getRun(runId)!;
      latest.diagnoses.find((d) => d.id === diagnosisId)!.model_id = candidates[0];
      this.save(latest);
      this.emit(runId, "run.diagnosis_fallback", { diagnosis_id: diagnosisId, model_id: diagnosis.model_id, next_model_id: candidates[0],
        error: "原来用的模型已不可用，或做不了这次修复需要的事。" });
    }
    let cost = 0;
    for (const [index, modelId] of candidates.entries()) {
      const model = this.modelLookup[modelId];
      // Repairs act on the machine; an analysis only reads, which CLIs do on their own.
      const act = Boolean((repair || edit) && model && model.channel !== "cli" && canAct(model));
      const run = this.db.getRun(runId)!;
      try {
        const result = await this.complete(run, node, modelId, prompt, workspace, { cli_timeout: repair || edit ? settings.repair_call_minutes * 60 : 600,
          allow_api_fallback: false, act, repair, effort: settings.diagnosis_reasoning_effort });
        return [result, modelId, cost + result.accounted_cost_usd];
      } catch (error) {
        if (isCancelled(error)) {
          withCost(error, accounted(error) + cost);
          throw error;
        }
        cost += accounted(error);
        if (error instanceof BudgetExceeded || index === candidates.length - 1) {
          withCost(error, cost);
          throw error;
        }
        const following = candidates[index + 1];
        await this.locked(runId, () => {
          const latest = this.db.getRun(runId)!;
          for (const item of latest.diagnoses) if (item.id === diagnosisId) item.model_id = following;
          this.save(latest);
        });
        this.emit(runId, "run.diagnosis_fallback", { diagnosis_id: diagnosisId, model_id: modelId, next_model_id: following,
          error: head(String((error as Error)?.message ?? error), 300) });
      }
    }
    throw new RepairError("unreachable");
  }

  /** Act on the diagnosis of a failed attempt: a repair the lead asked for goes back to the lead
   *  (``consult``); otherwise recovery.afterDiagnosis decides what to do. */
  async repairDone(runId: string, nodeId: string, diagnosisId: string, text: string | null, error: string | null, cost: number, verdict: quality.Verdict,
    outcome: string, sharedFiles: string[] | null = null, consult = true): Promise<void> {
    const handover = await this.locked(runId, () => {
      const run = this.db.getRun(runId);
      if (!run) return false;
      const node = run.plan.nodes.find((item) => item.id === nodeId)!;
      const diagnosis = run.diagnoses.find((item) => item.id === diagnosisId)!;
      if (error && diagnosis.reply_to && run.waiting_diagnosis_id === diagnosis.reply_to) run.waiting_diagnosis_id = null;
      if (diagnosis.status === "running") {
        diagnosis.status = error ? "failed" : "done";
        diagnosis.error = error || null;
        diagnosis.cost_usd = pyRound(cost, 6);
        diagnosis.finished_at = nowIso();
      }
      if (text !== null) {
        [diagnosis.report, diagnosis.advice, diagnosis.verdict] = parseDiagnosis(text) as [string, string | null, Diagnosis["verdict"]];
        diagnosis.user_action = userAction(text);
        [diagnosis.question, diagnosis.choices] = interaction(text);
        // An answer without a status line still had its say; retrying is the safe reading.
        diagnosis.verdict = diagnosis.verdict || "retry";
        if (diagnosis.verdict !== "needs_input") run.waiting_diagnosis_id = null;
      }
      // A known provider limit must not become a user-blocking environment problem, even if a
      // diagnosis used the older BLOCKED response format.
      const known = outcome === "error" ? failureKind(verdict.reason) : null;
      if (diagnosis.status === "done" && known && !["platform_pending", "needs_input"].includes(diagnosis.verdict ?? "")) {
        diagnosis.verdict = known === "quota" ? "quota_exhausted" : "model_unavailable";
      }
      if (diagnosis.verdict === "blocked" && !diagnosis.user_action) {
        diagnosis.verdict = "retry";
        diagnosis.advice = (diagnosis.advice || "") + "\n诊断未指出必须由用户提供的权限、凭据、预算或决定；请执行可用的修复并验证结果，公共环境问题修复到共享工具目录。";
      }
      this.emit(runId, "run.diagnosed", { diagnosis_id: diagnosisId, status: diagnosis.status, model_id: diagnosis.model_id, verdict: diagnosis.verdict });
      if (run.status === "cancelled" || !["running", "failed"].includes(node.status)) {
        this.save(run);
        return false;
      }
      const status = diagnosis.status === "done" ? diagnosis.verdict : null;
      // A repair the lead asked for goes back to it, unless it needs the user or a platform repair.
      const lead = consult && Boolean(diagnosis.decision_id) && this.canLead() && !["platform_pending", "needs_input"].includes(status ?? "");
      const action = lead ? "lead" : afterDiagnosis(outcome, status, { hasModel: Boolean(node.model_id), environmentFixes: node.environment_fixes });
      if (action === "hold_for_platform") {
        node.status = "pending";
        node.environment_fixes += 1;
        this.holdForPlatform(run, diagnosis.trigger === "manual");
      } else if (action === "ask_user") {
        node.status = "pending";
        run.status = "paused";
        diagnosis.question = diagnosis.question || "请补充你希望采用的方案或约束。";
        run.error = diagnosis.question;
        run.waiting_diagnosis_id = diagnosis.id;
        run.maintenance_id = null;
        this.emit(runId, "run.diagnosis_question", { diagnosis_id: diagnosis.id, question: diagnosis.question, choices: diagnosis.choices });
      } else if (action === "switch_model") {
        if (!node.attempts.length) node.attempts.push(NodeAttemptSchema.parse({ model_id: node.model_id, outcome: "error", reason: verdict.reason }));
        const failedModel = node.attempts.at(-1)!.model_id || node.model_id!;
        const kind = status === "quota_exhausted" ? "quota" : "unavailable";
        this.providers.quota!.learn(failedModel, verdict.reason, kind, run.id, diagnosis.id);
        const unavailable = this.providers.quota!.mark(failedModel, `${verdict.reason}\n${diagnosis.report || ""}`, kind);
        // finish already recorded this attempt. Reclassify it without duplicating its cost or history
        // or using up a quality retry.
        node.attempts.at(-1)!.outcome = kind;
        node.review = unavailable.message;
        node.review_passed = null;
        this.routeAfterUnavailable(run, node, unavailable, diagnosis.id);
      } else if (action === "retry_fixed") {
        if (sharedFiles?.length) {
          this.db.saveSharedRepair({ id: diagnosis.id, run_id: run.id, model_id: diagnosis.model_id, files: sharedFiles, report: diagnosis.report || "",
            created_at: nowIso().replace(/Z$/, "+00:00") });
          this.emit(run.id, "run.repair_shared", { diagnosis_id: diagnosis.id, files: sharedFiles });
        }
        node.environment_fixes += 1;
        node.feedback = quality.retryFeedback(node.feedback, `${verdict.reason}\n环境已修复，请重新执行这一步：\n${diagnosis.report || ""}`.trim());
        node.status = "pending";
        // The verification had used up its rework rounds; it gets one more.
        if (outcome === "verify_failed") run.rework_rounds = Math.max(0, settings.max_rework_rounds - 1);
        this.emit(runId, "node.retry", { node_id: node.id, reason: "environment_fixed", model_id: node.model_id, attempt: node.attempts.length + 1 });
      } else if (action === "unable") {
        // The diagnosis could not lift the limit (or needs the user to): the step ends as one that cannot
        // be done here, with why, and the rest of the task goes on.
        this.markUnable(run, node, verdict.unable || (outcome === "unable" ? verdict.reason : "平台工程师判断：这一步在当前环境中无法完成。"), diagnosis);
      } else if (action === "pause") {
        node.status = "failed";
        this.pauseForDiagnosis(run, node, diagnosis, "遇到需要你处理的问题");
      } else if (action === "pause_rework") {
        this.pauseForDiagnosis(run, node, diagnosis, `返工 ${run.rework_rounds} 轮后验证仍未通过`);
      } else if (action !== "lead") {
        this.retryOrFail(run, node, verdict, outcome);
        if (node.status === "pending" && diagnosis.advice) node.feedback = `${node.feedback}${quality.ADVICE_NOTE}${diagnosis.advice}`;
        else if (node.status === "failed") {
          const why = `重试 ${node.failed_attempts} 次仍未通过` + (diagnosis.status !== "done" ? `（平台工程师没有查完：${diagnosis.error || "没有可用的模型"}）` : "");
          this.pauseForDiagnosis(run, node, diagnosis, why);
        }
      }
      this.save(run);
      return lead;
    });
    if (handover && !(await this.afterRepair(runId, nodeId, diagnosisId, verdict, outcome))) {
      await this.repairDone(runId, nodeId, diagnosisId, null, null, 0, verdict, outcome, sharedFiles, false);
    }
  }

  pauseForDiagnosis(run: ExecutionRun, node: TaskNode, diagnosis: Diagnosis, why: string): void {
    run.error = `步骤「${node.title}」${why}，任务已暂停。请看平台工程师的报告，处理后点“按此预算继续”。`;
    if (run.status === "running") run.status = "paused";
    this.emit(run.id, "approval.required", { reason: "diagnosis_unresolved", node_id: node.id, diagnosis_id: diagnosis.id });
  }

  /** Record a new diagnosis on ``run`` (the caller saves it); null if one is running. */
  beginDiagnosis(run: ExecutionRun, trigger: string, nodeId: string | null = null): string | null {
    const task = this.diagnosing.get(run.id);
    if (task && !task.done && task !== currentTask()) return null;
    const model = pickDiagnoser(Object.values(this.modelLookup), this.configured(run));
    const diagnosis = DiagnosisSchema.parse({ id: shortId(), trigger, node_id: nodeId, model_id: model ? model.id : null });
    if (!model) {
      diagnosis.status = "failed";
      diagnosis.error = "平台工程师没有可用的模型：请启用一个会员 CLI 或 API 模型。";
      diagnosis.finished_at = nowIso();
    }
    run.diagnoses.push(diagnosis);
    this.emit(run.id, "run.diagnosis_started", { diagnosis_id: diagnosis.id, trigger, node_id: nodeId, model_id: diagnosis.model_id });
    return model ? diagnosis.id : null;
  }

  startDiagnosis(runId: string, diagnosisId: string): void {
    this.diagnosing.set(runId, new Task(() => this.diagnose(runId, diagnosisId)));
  }

  private async diagnose(runId: string, diagnosisId: string): Promise<void> {
    try {
      await this.runDiagnosis(runId, diagnosisId);
    } catch (error) {
      await this.locked(runId, () => {
        const latest = this.db.getRun(runId);
        const record = latest?.diagnoses.find((d) => d.id === diagnosisId) ?? null;
        if (record && record.status === "running") {
          record.status = "failed";
          record.error = (error as Error)?.message || "平台工程师的排查被中断。";
          record.cost_usd = pyRound(accounted(error), 6);
          record.finished_at = nowIso();
        }
        if (latest) {
          if (record?.reply_to && latest.waiting_diagnosis_id === record.reply_to) latest.waiting_diagnosis_id = null;
          for (const node of latest.plan.nodes) {
            if (record && node.id === record.node_id && node.status === "running" && latest.status !== "running") {
              node.status = latest.status === "cancelled" ? "cancelled" : "pending";
            }
          }
          this.save(latest);
        }
      });
      if (isCancelled(error)) throw error;
    } finally {
      if (this.diagnosing.get(runId) === currentTask()) this.diagnosing.delete(runId);
    }
  }

  private async runDiagnosis(runId: string, diagnosisId: string): Promise<void> {
    const run = this.db.getRun(runId);
    const diagnosis = run?.diagnoses.find((item) => item.id === diagnosisId);
    if (!run || !diagnosis || !diagnosis.model_id) return;
    const node = run.plan.nodes.find((item) => item.id === diagnosis.node_id) ?? null;
    if (node && ["paused", "failed", "incomplete"].includes(run.status) && ["failed", "pending", "unable"].includes(node.status)) {
      // A requested diagnosis of a stopped step uses the same repair and switching as automatic
      // recovery, then goes on within the budget approved before.
      const last = node.attempts.at(-1);
      const verdict = quality.verdict({ passed: false, reason: last?.reason || node.review || run.error || "步骤未完成" });
      const outcome = !last || ["error", "quota", "unavailable"].includes(last.outcome) ? "error" : last.outcome;
      node.status = "running";
      node.failed_attempts = 0;
      node.environment_fixes = 0;
      this.save(run);
      await this.repair(runId, node.id, verdict, outcome, { diagnosisId });
      const go = await this.locked(runId, () => {
        const latest = this.db.getRun(runId);
        const current = latest?.plan.nodes.find((item) => item.id === node.id);
        if (!latest || !current || latest.status === "cancelled" || current.status !== "pending") return false;
        // A failed or budget-blocked diagnosis does not authorize another blind attempt.
        const record = latest.diagnoses.find((d) => d.id === diagnosisId)!;
        if (record.status !== "done" || ["needs_input", "platform_pending"].includes(record.verdict ?? "")) return false;
        try {
          this.refreshModel(latest, current);
        } catch (error) {
          if (error instanceof NoEligibleModelError) return false;
          throw error;
        }
        const required = latest.actual_cost_usd + latest.plan.nodes.filter((n) => n.status !== "succeeded").reduce((sum, n) => sum + n.estimated_cost_usd, 0);
        if (required > latest.budget_usd) {
          this.pauseForBudget(latest);
          return false;
        }
        const active = this.tasks.get(runId);
        latest.status = active && !active.done ? "running" : "queued";
        latest.error = null;
        this.save(latest);
        this.emit(runId, "run.recovered", { diagnosis_id: diagnosisId });
        return true;
      });
      if (go) this.start(runId);
      return;
    }
    const workspace = this.ensureFolder(Diagnosing.folder(run, null));
    const events = this.eventLines(runId);
    let report: string | null = null;
    let advice: string | null = null;
    let status: string | null = null;
    let error: string | null = null;
    let cost = 0;
    let text = "";
    try {
      let result: ProviderResult;
      [result, , cost] = await this.diagnoseWith(run, diagnosis, null, diagnosisPrompt(run, diagnosis.node_id, workspace, events, this.platform.context()), workspace, false);
      text = result.text;
      if (parseDiagnosis(text)[2] === "platform_repair") {
        await this.repairLock.run(async () => {
          let extra: number;
          try {
            [text, extra] = await this.fixPlatform(run, diagnosis, node, text);
          } catch (problem) {
            withCost(problem, accounted(problem) + cost);
            throw problem;
          }
          cost += extra;
        });
      }
      [report, advice, status] = parseDiagnosis(text);
    } catch (problem) {
      if (isCancelled(problem)) {
        await this.locked(runId, () => {
          const latest = this.db.getRun(runId);
          const target = latest?.diagnoses.find((d) => d.id === diagnosisId);
          if (latest && target) {
            target.status = "failed";
            target.error = "平台工程师的排查被中断（任务取消或服务重启）。";
            target.cost_usd = pyRound(accounted(problem), 6);
            target.finished_at = nowIso();
            this.save(latest);
          }
        });
        this.diagnosing.delete(runId);
        throw problem;
      }
      error = head(String((problem as Error)?.message ?? problem), 500);
      cost = accounted(problem);
    }
    this.diagnosing.delete(runId);
    let latestStatus: string | null = null;
    const done = await this.locked(runId, () => {
      const latest = this.db.getRun(runId);
      const target = latest?.diagnoses.find((item) => item.id === diagnosisId);
      if (!latest || !target) return null;
      target.status = error ? "failed" : "done";
      target.report = report;
      target.advice = advice;
      target.error = error;
      target.cost_usd = pyRound(cost, 6);
      target.verdict = error ? null : (status as Diagnosis["verdict"]);
      const answeredWaiting = Boolean(target.reply_to && latest.waiting_diagnosis_id === target.reply_to);
      if (answeredWaiting) latest.waiting_diagnosis_id = null;
      if (!error) {
        [target.question, target.choices] = interaction(text);
        if (status === "needs_input") {
          target.question = target.question || "请补充你希望采用的方案或约束。";
          latest.waiting_diagnosis_id = target.id;
          if (["queued", "running", "paused"].includes(latest.status)) {
            latest.status = "paused";
            latest.error = target.question;
            latest.maintenance_id = null;
          }
          this.emit(runId, "run.diagnosis_question", { diagnosis_id: target.id, question: target.question, choices: target.choices });
        } else if (status === "platform_pending") {
          latest.waiting_diagnosis_id = null;
          this.holdForPlatform(latest, answeredWaiting);
        } else if (answeredWaiting && (status === "retry" || status === "fixed") && latest.status === "paused") {
          const required = latest.actual_cost_usd + latest.plan.nodes.filter((n) => n.status !== "succeeded").reduce((sum, n) => sum + n.estimated_cost_usd, 0);
          if (required <= latest.budget_usd) {
            const active = this.tasks.get(runId);
            latest.status = active && !active.done ? "running" : "queued";
            latest.error = null;
          } else this.pauseForBudget(latest);
        }
      }
      target.finished_at = nowIso();
      this.save(latest);
      latestStatus = latest.status;
      return target;
    });
    if (!done) return;
    this.emit(runId, "run.diagnosed", { diagnosis_id: diagnosisId, status: done.status, model_id: done.model_id });
    if (latestStatus === "queued" || latestStatus === "running") this.start(runId);
  }
}
