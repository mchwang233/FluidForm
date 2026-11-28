// Diagnosing failed or stuck steps and acting on the diagnosis (recovery.afterDiagnosis
// decides what it means).
import { uses } from "./features.js";
import { settings } from "./config.js";
import { interaction, parse as parseDiagnosis, userAction } from "./diagnosis.js";
import * as environment from "./environment.js";
import { nowIso } from "./lax.js";
import { Leading } from "./leading.js";
import { type Diagnosis, DiagnosisSchema, type ExecutionRun, NodeAttemptSchema, type TaskNode } from "./models.js";
import type { ProviderResult } from "./providers.js";
import { pyRound } from "./py.js";
import * as quality from "./quality.js";
import { failureKind } from "./quota.js";
import { afterDiagnosis } from "./recovery.js";
import { diagnosers, pickDiagnoser } from "./routing.js";
import { currentTask, isCancelled, Task } from "./tasks.js";
import * as engineer from "./engineering.js";

type Json = Record<string, any>;
const shortId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 8);
const accounted = (error: unknown) => ((error as Json)?.accounted_cost_usd as number) ?? 0;

export abstract class Diagnosing extends Leading {
  abstract fixPlatform(run: ExecutionRun, diagnosis: Diagnosis, node: TaskNode | null, problem: string): Promise<[string, number]>;
  abstract refreshModel(run: ExecutionRun, node: TaskNode): Promise<void>;

  /** After a failed attempt, a strong model (a membership CLI when possible) looks for what blocks the
   *  step outside the task (missing software, sandbox or machine limits, configuration) and repairs it.
   *  Its status decides the rest (repairDone). Runs inside the step's task, so the run waits for it. */
  async repair(runId: string, nodeId: string, verdict: quality.Verdict, outcome: string,
    { diagnosisId = null, brief = "", decisionId = null }: { diagnosisId?: string | null; brief?: string; decisionId?: string | null } = {}): Promise<void> {
    if (uses.stuckWaits()) {
      await this.locked(runId, async () => {
        const found = this.db.getRun(runId);
        const step = found?.plan.nodes.find((item) => item.id === nodeId);
        if (!found || !step || found.status === "cancelled" || step.status !== "running") return;
        await this.recover(found, step, verdict, outcome);
        this.save(found);
      });
      return;
    }
    return engineer.repair.call(this, runId, nodeId, verdict, outcome, { diagnosisId, brief, decisionId });
  }

  /** Run a diagnosis on its model, or, if that fails (a CLI at its usage limit, say), on the next
   *  diagnosers in turn. Returns the result and the model that gave it; switches are recorded as events,
   *  and the last failure is thrown. */
  async diagnoseWith(given: ExecutionRun, diagnosis: Diagnosis, node: TaskNode | null, prompt: string, workspace: string, repair: boolean,
    edit = false): Promise<[ProviderResult, string, number]> {
    return engineer.diagnoseWith.call(this, given, diagnosis, node, prompt, workspace, repair, edit);
  }

  /** Act on the diagnosis of a failed attempt: a repair the lead asked for goes back to the lead
   *  (``consult``); otherwise recovery.afterDiagnosis decides what to do. */
  async repairDone(runId: string, nodeId: string, diagnosisId: string, text: string | null, error: string | null, cost: number, verdict: quality.Verdict,
    outcome: string, sharedFiles: string[] | null = null, consult = true): Promise<void> {
    const handover = await this.locked(runId, async () => {
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
        await this.routeAfterUnavailable(run, node, unavailable, diagnosis.id);
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
        await this.retryOrFail(run, node, verdict, outcome);
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
    return engineer.runDiagnosis.call(this, runId, diagnosisId);
  }
}
