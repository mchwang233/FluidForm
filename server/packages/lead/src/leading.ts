// What the lead does: after a failed attempt, at the end, and with the user's answers. Each runs with
// the executor as ``this`` (server/src/leading.ts), which does what changes the task.
import { BudgetExceeded } from "../../../src/budget.js";
import * as capabilities from "../../../src/capabilities.js";
import { settings } from "../../../src/config.js";
import * as contracts from "../../../src/contracts.js";
import { ENGINEER_CALLED } from "../../../src/diagnosis.js";
import { nowIso } from "../../../src/lax.js";
import { log } from "../../../src/log.js";
import { DecisionSchema, DiagnosisSchema } from "../../../src/models.js";
import { pyRound } from "../../../src/py.js";
import * as quality from "../../../src/quality.js";
import { nodeCost } from "../../../src/routing.js";
import * as supervisor from "../../../src/supervisor.js";
import * as prompts from "./prompts.js";
import { currentTask, isCancelled } from "../../../src/tasks.js";
import { Leading } from "../../../src/leading.js";

type Json = Record<string, any>;
type Choice = supervisor.Decision | "budget" | null;
const shortId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 8);

export async function decide(this: Leading, runId: string, nodeId: string, verdict: quality.Verdict, outcome: string): Promise<void> {
  const run = this.db.getRun(runId);
  const node = run?.plan.nodes.find((item) => item.id === nodeId);
  if (!run || !node || run.status === "cancelled") return;
  const left = Leading.decisionsLeft(run, node);
  if (Math.min(...left) <= 0) {
    await this.locked(runId, () => {
      const latest = this.db.getRun(runId)!;
      const step = latest.plan.nodes.find((item) => item.id === nodeId)!;
      step.status = "pending";
      const which = left[0] <= 0 ? `步骤「${step.title}」已决策 ${settings.max_node_decisions} 次` : `整个任务已决策 ${settings.max_run_decisions} 次`;
      latest.error = `${which}仍未解决，任务已暂停。看过情况后点“按此预算继续”，负责人会接着处理。`;
      if (latest.status === "running" || latest.status === "queued") latest.status = "paused";
      this.save(latest);
    });
    this.emit(runId, "approval.required", { reason: "decision_limit", node_id: nodeId });
    return;
  }
  const choices = this.choices(run, node);
  const verifying = outcome === "verify_failed";
  const blocked = outcome === "blocked";
  // A blocked step may need work it builds on redone (a coverage gap, a missing output).
  const targets = verifying ? Leading.targets(run, node) : blocked ? Leading.upstream(run, node) : null;
  let prompt = verifying ? prompts.verificationMessage(run, node, verdict, choices, left)
    : prompts.failureMessage(run, node, node.attempts.at(-1)!, verdict, choices, left, targets);
  let limited = outcome === "stopped" && node.artifact_contract !== null;
  if (limited) prompt += "\n" + prompts.limitNote(node, contracts.extension(node));
  if (blocked) prompt += "\n" + prompts.blockedNote();
  limited = limited || blocked;
  const event = verifying ? "verify_failed" : "attempt_failed";
  const decision = await this.askForDecision(runId, nodeId, prompt, new Set(choices.map((item) => item.id)), targets, false, event);
  if (decision === null && limited) {
    // Nobody decided to give it more: it stops at its limit as declared.
    await this.locked(runId, () => {
      const latest = this.db.getRun(runId)!;
      this.stopContract(latest, latest.plan.nodes.find((item) => item.id === nodeId)!, verdict.reason, "stopped");
      this.save(latest);
    });
  } else if (decision === null) {
    await this.recordFallback(runId, nodeId);
    if (verifying) {
      // As before the lead: the findings send the verified work back, within the usual rounds.
      await this.locked(runId, () => {
        const latest = this.db.getRun(runId)!;
        this.sendBack(latest, latest.plan.nodes.find((item) => item.id === nodeId)!, verdict);
        this.save(latest);
      });
    } else await this.repair(runId, nodeId, verdict, outcome);
  } else if (decision !== "budget") await this.applyDecision(runId, nodeId, decision, verdict, outcome, event);
}

export async function decision(this: Leading, runId: string, nodeId: string | null, prompt: string, modelIds: Set<string>, targets: Set<string> | null, final: boolean): Promise<Choice> {
  const read = async (reply: string): Promise<[supervisor.Decision | null, string]> => {
    const found = prompts.parseDecision(reply, modelIds, targets, final);
    if (found && found.action === "replan") {
      const problem = await this.planProblem(runId, found.plan!, nodeId);
      if (problem) return [null, `That plan change cannot be made: ${problem}`];
    }
    return [found, "That was not a valid decision."];
  };
  try {
    let [found, problem] = await read(await this.askLead(runId, prompt));
    if (found === null) {
      // Same conversation: it only has to say what it decided in the asked form.
      [found] = await read(await this.askLead(runId, `${problem}\n` + prompts.decisionFormat(Boolean(targets?.size), final)));
    }
    return found;
  } catch (error) {
    if (isCancelled(error)) throw error;
    if (error instanceof BudgetExceeded) {
      await this.locked(runId, () => {
        const run = this.db.getRun(runId)!;
        for (const item of run.plan.nodes) if (item.id === nodeId) item.status = "pending";
        this.pauseForBudget(run);
        this.save(run);
      });
      return "budget";
    }
    return null;
  }
}

export async function finalDecision(this: Leading, runId: string): Promise<boolean> {
  let run = this.db.getRun(runId)!;
  const counted = run.decisions.filter((item) => item.action !== "fallback" && (run.decisions_since === null || item.created_at >= run.decisions_since));
  const left = settings.max_run_decisions - counted.length;
  if (left <= 0) return false;
  const targets = new Set(run.plan.nodes.map((node) => node.id));
  const decision = await this.askForDecision(runId, null, prompts.finalMessage(run, left), new Set(), targets, true, "all_done");
  if (decision === "budget") return true;
  if (decision === null) return false;
  const { action } = decision;
  const reason = decision.reason ?? "";
  let changes: Awaited<ReturnType<Leading["changePlan"]>> | null = null;
  await this.locked(runId, async () => {
    run = this.db.getRun(runId)!;
    run.decisions.push(DecisionSchema.parse({ event: "all_done", action, reason, instructions: decision.instructions ?? null, targets: decision.targets ?? [],
      summary: decision.summary ?? null, lead_model_id: run.supervisor!.model_id }));
    if (action === "rework") this.reopen(run, new Set(decision.targets), decision.instructions || reason);
    else if (action === "replan") changes = await this.changePlan(run, decision.plan!, null);
    this.save(run);
  });
  this.emit(runId, "run.decision", { action, reason, targets: decision.targets ?? null, event: "all_done" });
  if (changes) this.emit(runId, "run.plan_changed", changes);
  return action !== "done";
}

export async function applyDecision(this: Leading, runId: string, nodeId: string, decision: supervisor.Decision, verdict: quality.Verdict, outcome: string, event: string): Promise<void> {
  const { action } = decision;
  const reason = decision.reason ?? "";
  const instructions = decision.instructions ?? null;
  let repairWith: [quality.Verdict, string] | null = null;
  let changes: Awaited<ReturnType<Leading["changePlan"]>> | null = null;
  // call_engineer: a component is asked for as before; a repair goes to the engineer's repair session,
  // which finds whether the machine or FluidForm is at fault (one-engineer.md).
  const does = action === "call_engineer" ? (decision.kind === "component" ? "request_component" : "call_engineer") : action;
  let madeId = "";
  const stopped = await this.locked(runId, async () => {
    const run = this.db.getRun(runId)!;
    const node = run.plan.nodes.find((item) => item.id === nodeId)!;
    if (run.status === "cancelled" || !["running", "pending"].includes(node.status)) return true;
    if (node.artifact_contract && ["accept", "retry", "switch_model", "replan"].includes(action)) {
      try {
        if (action === "accept") contracts.accepted(run, node);
        else if (this.contractLimitReason(node)) {
          // Running it again is the lead granting it more calls (prompts.limitNote).
          const granted = contracts.extend(node);
          this.emit(runId, "node.limit_extended", { node_id: nodeId, ...granted });
        }
      } catch (error) {
        if (!(error instanceof contracts.ArtifactBlocked)) throw error;
        this.stopContract(run, node, error.message);
        this.save(run);
        return true;
      }
    }
    const made = DecisionSchema.parse({ node_id: nodeId, event, action, reason, instructions, model_id: decision.model_id ?? null, targets: decision.targets ?? [],
      lead_model_id: run.supervisor ? run.supervisor.model_id : null });
    madeId = made.id;
    run.decisions.push(made);
    const asked = instructions ? `负责人要求：${instructions}` : "";
    const feedback = (current: string | null) => quality.retryFeedback(current, [verdict.reason, asked].filter(Boolean).join("\n"));
    if (action === "retry" || action === "switch_model") {
      if (action === "switch_model") {
        const model = this.modelLookup[decision.model_id!];
        node.model_id = model.id;
        node.estimated_cost_usd = pyRound(await nodeCost(node, model), 6);
      }
      node.feedback = feedback(node.feedback);
      node.status = "pending";
      this.emit(runId, "node.retry", { node_id: nodeId, reason: "lead", model_id: node.model_id, attempt: node.attempts.length + 1 });
    } else if (action === "rework" && !node.verifies.length) {
      // A blocked step: what it builds on is redone, then it and everything after it.
      run.rework_rounds += 1;
      const reopened = this.reopen(run, new Set(decision.targets), instructions || reason);
      this.emit(runId, "run.rework", { verifier: nodeId, round: run.rework_rounds, reopened, problems: instructions || reason });
    } else if (action === "rework") {
      this.sendBack(run, node, verdict, new Set(decision.targets), instructions, false);
    } else if (action === "replan") {
      changes = await this.changePlan(run, decision.plan!, nodeId);
      const current = run.plan.nodes.find((item) => item.id === nodeId);
      if (current) {
        // The step stays in the plan: it runs again, after any steps added before it.
        current.status = "pending";
        current.feedback = feedback(current.feedback);
      }
    } else if (action === "accept") {
      node.status = "succeeded";
      node.feedback = null;
      node.review = `负责人接受：${reason}`;
      this.emit(runId, "node.succeeded", { node_id: nodeId, accepted_by_lead: true, reason });
    } else if (action === "unable") {
      this.markUnable(run, node, reason || verdict.unable || verdict.reason, null, decision.user_action ?? null);
    } else if (does === "request_component") {
      const job = this.engineerForLead(run, node, instructions || reason, made.id);
      if (job) {
        made.engineer_job_id = job.id;
        this.emit(runId, "run.engineer_requested", { node_id: nodeId, job_id: job.id });
      } else {
        this.markUnable(run, node, `这一步需要 FluidForm 新增能力，但平台工程师当前不可用：${instructions || reason}`, null,
          "启用平台自修复后，可以在负责人对话里点“拉平台工程师进来”提出这个需求。");
      }
    } else if (action === "ask_user") {
      const question = DiagnosisSchema.parse({ id: shortId(), trigger: "lead", node_id: nodeId, model_id: run.supervisor ? run.supervisor.model_id : null,
        status: "done", verdict: "needs_input", report: reason, question: decision.question, choices: decision.options ?? [], finished_at: nowIso() });
      run.diagnoses.push(question);
      node.status = "pending";
      if (run.status === "running" || run.status === "queued") run.status = "paused";
      run.error = question.question;
      run.waiting_diagnosis_id = question.id;
      this.emit(runId, "run.diagnosis_question", { diagnosis_id: question.id, question: question.question, choices: question.choices });
    }
    const call = decision.engineer;
    if (call && !["request_component", "repair_platform", "call_engineer"].includes(does)) {
      // Something in FluidForm itself the lead found on the way: the engineer takes it in the
      // background, whatever this decision does with the step.
      const [job] = this.engineerJoin(runId, call, "lead", nodeId, made.id);
      made.engineer_job_id = job ? job.id : null;
    }
    if (["repair_environment", "repair_platform", "call_engineer"].includes(does)) {
      // A repair session with access to this machine (or a platform source repair) does the work;
      // its outcome comes back to the lead (afterRepair) before the step runs.
      node.status = "running";
      const what = ({ repair_platform: "FluidForm itself is at fault; make a platform repair (STATUS: PLATFORM_REPAIR)",
        repair_environment: "the environment needs a repair", call_engineer: ENGINEER_CALLED } as Json)[does];
      repairWith = [verdict, `${what}: ${instructions || reason}`];
    }
    this.save(run);
    return false;
  });
  if (stopped) return;
  this.emit(runId, "run.decision", { node_id: nodeId, action, reason, model_id: decision.model_id ?? null, targets: decision.targets ?? null, event });
  if (changes) this.emit(runId, "run.plan_changed", changes);
  if (repairWith) {
    const [given, brief] = repairWith as [quality.Verdict, string];
    await this.repair(runId, nodeId, given, outcome, { brief, decisionId: madeId });
  }
}

export async function afterRepair(this: Leading, runId: string, nodeId: string, diagnosisId: string, verdict: quality.Verdict, outcome: string): Promise<boolean> {
  const run = this.db.getRun(runId)!;
  const node = run.plan.nodes.find((item) => item.id === nodeId)!;
  const diagnosis = run.diagnoses.find((item) => item.id === diagnosisId)!;
  const left = Leading.decisionsLeft(run, node);
  if (Math.min(...left) <= 0) return false;
  const choices = this.choices(run, node);
  const decision = await this.askForDecision(runId, nodeId, prompts.repairMessage(run, node, diagnosis, choices, left), new Set(choices.map((item) => item.id)),
    null, false, "repair_done");
  if (decision === null) return false;
  if (decision !== "budget") await this.applyDecision(runId, nodeId, decision, verdict, outcome, "repair_done");
  return true;
}

export async function proposeCapabilities(this: Leading, runId: string): Promise<void> {
  let cards;
  try {
    const run = this.db.getRun(runId);
    if (!run?.supervisor?.model_id) return;
    cards = capabilities.readCards(await this.askLead(runId, capabilities.PROMPT));
  } catch (error) {
    if (isCancelled(error)) throw error;
    // proposing is a courtesy: a lead that cannot answer leaves none
    log.warning(`capability proposals for ${runId} failed: ${(error as Error)?.message ?? error}`);
    return;
  }
  if (!cards.length) return;
  const saved = await this.locked(runId, () => {
    const run = this.db.getRun(runId);
    if (!run) return false;
    run.capability_proposals = cards;
    this.save(run);
    return true;
  });
  if (saved) this.emit(runId, "run.capabilities_proposed", { names: cards.map((card) => card.name) });
}

export async function leadAnswer(this: Leading, runId: string, questionId: string): Promise<void> {
  try {
    const run = this.db.getRun(runId)!;
    const question = run.diagnoses.find((item) => item.id === questionId)!;
    const node = run.plan.nodes.find((item) => item.id === question.node_id)!;
    const reply = question.messages.at(-1)!;
    const answer = [reply.choice, reply.text].filter(Boolean).join("\n");
    const choices = this.choices(run, node);
    const targets = Leading.targets(run, node);
    const decision = await this.askForDecision(runId, node.id, prompts.answerMessage(node, question.question ?? "", answer, targets.size > 0),
      new Set(choices.map((m) => m.id)), targets.size ? targets : null, false, "user_answer");
    if (decision === "budget") return;
    if (decision === null) {
      await this.locked(runId, () => {
        const latest = this.db.getRun(runId)!;
        latest.error = "负责人暂时无法处理你的回答，请稍后点“按此预算继续”。";
        this.save(latest);
      });
      return;
    }
    const last = node.attempts.at(-1);
    const verdict = quality.verdict({ passed: false, reason: last?.reason || "步骤未完成" });
    await this.applyDecision(runId, node.id, decision, verdict, last ? last.outcome : "error", "user_answer");
    await this.continueAfterAnswer(runId);
  } finally {
    if (this.diagnosing.get(runId) === currentTask()) this.diagnosing.delete(runId);
  }
}
