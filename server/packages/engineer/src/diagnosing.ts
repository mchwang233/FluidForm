// How the platform engineer looks into a stuck step and repairs it. Each runs with the executor as
// ``this`` (server/src/diagnosing.ts), which acts on what it finds.
import {
  agent as agentTools, BudgetExceeded, canAct, currentTask, diagnosers, Diagnosing, type Diagnosis, engineers, environment,
  type ExecutionRun, head, interaction, isCancelled, NoEligibleModelError, nowIso, parse as parseDiagnosis, type ProviderResult, pyRound,
  quality, RepairError, retrospect, settings, Task, type TaskNode, uses
} from "../../../src/extension-api.js";
import { repairPrompt, prompt as diagnosisPrompt } from "./prompts.js";

type Json = Record<string, any>;
const accounted = (error: unknown) => ((error as Json)?.accounted_cost_usd as number) ?? 0;
const withCost = (error: unknown, cost: number) => {
  if (error && typeof error === "object") (error as Json).accounted_cost_usd = cost;
};
const MAX_DIAGNOSERS = 3;

export async function repair(this: Diagnosing, runId: string, nodeId: string, verdict: quality.Verdict, outcome: string,
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

export async function diagnoseWith(this: Diagnosing, given: ExecutionRun, diagnosis: Diagnosis, node: TaskNode | null, prompt: string, workspace: string, repair: boolean,
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

export async function runDiagnosis(this: Diagnosing, runId: string, diagnosisId: string): Promise<void> {
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
    const go = await this.locked(runId, async () => {
      const latest = this.db.getRun(runId);
      const current = latest?.plan.nodes.find((item) => item.id === node.id);
      if (!latest || !current || latest.status === "cancelled" || current.status !== "pending") return false;
      // A failed or budget-blocked diagnosis does not authorize another blind attempt.
      const record = latest.diagnoses.find((d) => d.id === diagnosisId)!;
      if (record.status !== "done" || ["needs_input", "platform_pending"].includes(record.verdict ?? "")) return false;
      try {
        await this.refreshModel(latest, current);
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
