// Carrying out the task lead's decisions after a failed attempt, and handing the user's answers to its
// questions back to it (supervisor.ts words the questions and reads the answers).
import * as taskFiles from "./task-files.js";
import { join } from "node:path";
import * as streaming from "./streaming.js";
import { log } from "./log.js";
import * as chat from "./chat.js";
import { attach, safeName } from "./attachments.js";
import * as capabilities from "./capabilities.js";
import { settings } from "./config.js";
import * as contracts from "./contracts.js";
import { type Attachment, DecisionSchema, type ExecutionRun, folderId, LeadMessageSchema, type TaskNode } from "./models.js";
import { head } from "./py.js";
import * as quality from "./quality.js";
import { type PlanChanges, planning } from "./ports/planning.js";
import { Reviewing } from "./reviewing.js";
import * as supervisor from "./supervisor.js";
import { currentTask, isCancelled, Task } from "./tasks.js";
import * as lead from "./lead.js";
import { available } from "./provided.js";

type Json = Record<string, any>;
type Choice = supervisor.Decision | "budget" | null;

export abstract class Leading extends Reviewing {
  /** Decisions the lead may still make for ``node`` and for the task before it pauses. */
  static decisionsLeft(run: ExecutionRun, node: TaskNode): [number, number] {
    const counted = run.decisions.filter((item) => item.action !== "fallback" && (run.decisions_since === null || item.created_at >= run.decisions_since));
    return [settings.max_node_decisions - counted.filter((item) => item.node_id === node.id).length, settings.max_run_decisions - counted.length];
  }

  /** An attempt of the step failed: the lead decides what to do, and it is done. Without a lead able
   *  to decide, the usual diagnosis takes over. */
  async decide(runId: string, nodeId: string, verdict: quality.Verdict, outcome: string): Promise<void> {
    // Switched off since the attempt failed: as without a lead.
    if (!available("lead")) return this.repair(runId, nodeId, verdict, outcome);
    return lead.decide.call(this, runId, nodeId, verdict, outcome);
  }

  /** The finished steps ``node`` builds on, which the lead may send back. */
  static upstream(run: ExecutionRun, node: TaskNode): Set<string> {
    return new Set(contracts.ancestors(node, run.plan.nodes).filter((item) => item.status === "succeeded").map((item) => item.id));
  }

  /** The steps a verification may send back: those it checks. */
  static targets(run: ExecutionRun, node: TaskNode): Set<string> {
    return new Set(node.verifies.filter((item) => run.plan.nodes.some((other) => other.id === item)));
  }

  /** The lead's decision; null when no lead can give a valid one, or "budget" when the task has run out
   *  of budget for asking (it is then paused). ``targets``: the steps rework may send back; ``final``:
   *  every step has finished; ``event``: what it decides on. */
  askForDecision(runId: string, nodeId: string | null, prompt: string, modelIds: Set<string>, targets: Set<string> | null = null, final = false,
    event = "attempt_failed"): Promise<Choice> {
    return this.thinking(runId, event, nodeId, () => this.decision(runId, nodeId, prompt, modelIds, targets, final));
  }

  private async decision(runId: string, nodeId: string | null, prompt: string, modelIds: Set<string>, targets: Set<string> | null, final: boolean): Promise<Choice> {
    return available("lead") ? lead.decision.call(this, runId, nodeId, prompt, modelIds, targets, final) : null;
  }

  async changePlan(run: ExecutionRun, change: Json, deciding: string | null): Promise<PlanChanges> {
    return (await planning()).changePlan(run, change, Object.values(this.modelLookup), this.configured(run), this.needsVision(run), deciding);
  }

  /** Why a plan change cannot be made, tried on a copy of the task; null if it can. */
  async planProblem(runId: string, change: Json, deciding: string | null): Promise<string | null> {
    try {
      await this.changePlan(structuredClone(this.db.getRun(runId)!), change, deciding);
    } catch (error) {
      // A malformed change (not the shape asked for) is as unusable as an impossible one.
      return (error as Error)?.message || (error as Error)?.name || "Error";
    }
    return null;
  }

  /** Send finished steps back to be redone with ``note``, and everything built on them. */
  reopen(run: ExecutionRun, targets: Set<string>, note: string): string[] {
    const reopened = new Set([...targets, ...quality.descendants(run, targets)]);
    for (const node of run.plan.nodes) {
      if (!reopened.has(node.id)) continue;
      node.generation += 1;
      node.status = "pending";
      node.failed_attempts = 0;
      node.feedback = targets.has(node.id) ? `负责人检查整体结果后要求返工：${note}` : null;
    }
    return [...reopened].sort();
  }

  /** Every step has finished: the lead checks the whole result against the request. True if it sent
   *  work back or changed the plan, so the task goes on; false to finish it. It is the one acceptance
   *  kept when steps are not accepted one by one (settings.acceptance). */
  async finalReview(runId: string): Promise<boolean> {
    const run = this.db.getRun(runId)!;
    for (const node of run.plan.nodes) {
      try {
        contracts.accepted(run, node);
      } catch (error) {
        if (!(error instanceof contracts.ArtifactBlocked)) throw error;
        this.stopContract(run, node, error.message);
        this.save(run);
        return true;
      }
    }
    if (!this.canLead() || !run.supervisor?.model_id) return false;
    return lead.finalDecision.call(this, runId);
  }

  async recordFallback(runId: string, nodeId: string): Promise<void> {
    const reason = "负责人暂时无法决策，改由平台工程师处理这次失败。";
    await this.locked(runId, () => {
      const run = this.db.getRun(runId)!;
      run.decisions.push(DecisionSchema.parse({ node_id: nodeId, event: "attempt_failed", action: "fallback", reason }));
      this.save(run);
    });
    this.emit(runId, "run.decision", { node_id: nodeId, action: "fallback", reason });
  }

  abstract engineerForLead(run: ExecutionRun, node: TaskNode, request: string, decisionId: string): { id: string } | null;

  /** Do what the lead decided for the step, and record it with its reason. */
  applyDecision(runId: string, nodeId: string, decision: supervisor.Decision, verdict: quality.Verdict, outcome: string, event: string): Promise<void> {
    return lead.applyDecision.call(this, runId, nodeId, decision, verdict, outcome, event);
  }

  /** A repair the lead asked for has ended: the lead sees how, and decides what happens to the step, so
   *  a repair that did not work does not send the step back into the same wall. False when no lead could
   *  decide; the usual handling of a repair then applies. */
  async afterRepair(runId: string, nodeId: string, diagnosisId: string, verdict: quality.Verdict, outcome: string): Promise<boolean> {
    return available("lead") ? lead.afterRepair.call(this, runId, nodeId, diagnosisId, verdict, outcome) : false;
  }

  /** When a task succeeds, ask its lead in the background what it built that is reusable; never holds up
   *  the task's end (docs/design/capabilities.md). */
  startCapabilityProposals(runId: string): void {
    if (settings.capability_proposals) this.capabilityTasks.set(runId, new Task(() => this.proposeCapabilities(runId)));
  }

  private async proposeCapabilities(runId: string): Promise<void> {
    if (available("lead")) await lead.proposeCapabilities.call(this, runId);
  }

  /** The user writes to the lead: the message and a pending reply are saved at once, and the lead answers
   *  in the background. False if it is still answering an earlier message. ``shown``: what the
   *  conversation keeps of the message, when the model is told more. */
  startLeadChat(runId: string, text: string, attachments: Attachment[] = [], shown: string | null = null): boolean {
    const task = this.leadTasks.get(runId);
    if (task && !task.done) return false;
    const run = this.db.getRun(runId)!;
    for (const message of run.lead_messages) {
      if (message.status === "pending") {
        // Its answer was lost (a restart while the lead was answering, say).
        message.status = "failed";
        message.text = "这条回复被中断了，请重新提问。";
      }
    }
    attach(run, attachments);
    run.lead_messages.push(LeadMessageSchema.parse({ role: "user", text: shown || text, attachments }), LeadMessageSchema.parse({ role: "lead", status: "pending" }));
    const replyId = run.lead_messages.at(-1)!.id;
    this.save(run);
    this.emit(runId, "run.lead_message", { role: "user", text: shown || text });
    this.leadTasks.set(runId, new Task(() => this.leadChat(runId, text, replyId)));
    return true;
  }

  private async leadChat(runId: string, text: string, replyId: string): Promise<void> {
    let job: { id: string; title: string } | null = null;
    let answer: string;
    let status: string;
    try {
      const run = this.db.getRun(runId)!;
      // A chat is only a conversation; a task's lead answers as the lead who follows it.
      const prompt = run.kind === "chat" ? text : supervisor.chatMessage(text);
      if (run.kind === "chat") this.bringTaskFiles(run);
      // The files sent with this message (and a chat's first ones) are among the task's attachments the
      // lead has not seen yet; askLead gives them to it.
      answer = await this.askLead(runId, prompt);
      status = "done";
      // What the owner's chat keeps about them (an automation's chat is remembered by the API).
      if (run.kind === "chat" && !(run.origin || {}).capability) [answer] = await chat.remember(chat.WEB, answer);
      // The lead may bring the platform engineer in at once; a chat's ENGINEER line is read by the chat package.
      const [shown, call] = run.kind === "chat" ? await chatEngineer(answer) : supervisor.splitEngineer(answer);
      answer = shown;
      if (call) {
        const [joined, problem] = this.engineerJoin(runId, call, "lead");
        job = joined;
        answer += joined ? `\n\n（已请平台工程师加入：${joined.title}）` : `\n\n（没能请平台工程师加入：${problem}）`;
      }
    } catch (error) {
      if (isCancelled(error)) {
        answer = "这条回复被中断了，请重新提问。";
        status = "failed";
        await this.saveReply(runId, replyId, answer, status, null);
        throw error;
      }
      const latest = this.db.getRun(runId);
      const chat = latest !== null && latest.kind === "chat";
      answer = `${chat ? "模型" : "负责人"}暂时无法回答：${head(String((error as Error)?.message ?? error), 300)}`;
      status = "failed";
    }
    await this.saveReply(runId, replyId, answer, status, job);
    if (status === "done") this.startChatSummary(runId);
    this.emit(runId, "run.lead_message", { role: "lead", status });
  }

  /** What the tasks a chat asked for made, in its folder (tasks/<task>/), for it to send again when asked:
   *  a task's own folder is not the chat's to reach. */
  private bringTaskFiles(chatRun: ExecutionRun): void {
    if (!settings.chat_tools || chatRun.project_dir) return;
    const folder = join(settings.workspace_root, folderId(chatRun), taskFiles.IN_CHAT);
    for (const task of this.db.listRuns()) {
      if (task.kind === "chat" || task.origin?.chat_run !== chatRun.id || !["succeeded", "incomplete"].includes(task.status)) continue;
      const made = taskFiles.named(task);
      if (made.length) taskFiles.copyInto(join(folder, safeName(task.plan.title || task.plan.summary || task.id).slice(0, 60)), made);
    }
  }

  /** A chat grown long has its older turns summarised, after the answer so that nobody waits for it.
   *  A summary that cannot be made leaves the chat to its latest turns. */
  private startChatSummary(runId: string): void {
    const run = this.db.getRun(runId);
    const model = this.modelLookup[run?.supervisor?.model_id ?? ""];
    const busy = this.chatSummaries.get(runId);
    if (run?.kind !== "chat" || !model || model.channel === "cli" || (busy && !busy.done)) return;
    // Nobody hears it being written: it is not the answer.
    this.chatSummaries.set(runId, streaming.listener.run(null, () => new Task(() => this.summariseChat(runId, model.id))));
  }

  private async summariseChat(runId: string, modelId: string): Promise<void> {
    try {
      const run = this.db.getRun(runId);
      if (!run) return;
      const ctx = chat.context(run, null, null);
      ctx.chat.history = chat.history(run);
      const { prompt, until } = await chat.ask("chat.compaction", { ctx });
      if (!prompt) return;
      const result = await this.complete(run, null, modelId, prompt, null, { effort: "low", allow_api_fallback: false });
      const text = await chat.text("chat.summary", { text: result.text });
      if (!text) return;
      await this.locked(runId, () => {
        const latest = this.db.getRun(runId);
        if (!latest) return;
        latest.chat_summary = { text, until };
        this.save(latest);
      });
    } catch (error) {
      if (isCancelled(error)) throw error;
      log.warning(`summarising chat ${runId} failed: ${(error as Error)?.message ?? error}`);
    }
  }

  private saveReply(runId: string, replyId: string, answer: string, status: string, job: { id: string } | null): Promise<void> {
    return this.locked(runId, () => {
      const run = this.db.getRun(runId);
      const reply = run?.lead_messages.find((item) => item.id === replyId);
      if (run && reply) {
        reply.text = answer;
        reply.status = status as typeof reply.status;
        reply.engineer_job_id = job ? job.id : null;
        this.save(run);
      }
    });
  }

  /** The user answered the lead's question: it decides what to do with the step. */
  startLeadAnswer(runId: string, questionId: string): void {
    this.diagnosing.set(runId, new Task(() => this.leadAnswer(runId, questionId)));
  }

  private async leadAnswer(runId: string, questionId: string): Promise<void> {
    if (available("lead")) return lead.leadAnswer.call(this, runId, questionId);
    try {
      await this.locked(runId, () => {
        const latest = this.db.getRun(runId)!;
        latest.error = "没有启用负责人能力：在 平台 → 能力 里启用后，点“按此预算继续”。";
        this.save(latest);
      });
    } finally {
      if (this.diagnosing.get(runId) === currentTask()) this.diagnosing.delete(runId);
    }
  }

  /** A task paused for the lead's question goes on once nothing else holds it. */
  async continueAfterAnswer(runId: string): Promise<void> {
    const go = await this.locked(runId, () => {
      const run = this.db.getRun(runId)!;
      if (run.status !== "paused" || run.waiting_diagnosis_id || run.maintenance_id || run.engineer_job_id) return false;
      const required = run.actual_cost_usd + run.plan.nodes.filter((node) => node.status !== "succeeded").reduce((sum, node) => sum + node.estimated_cost_usd, 0);
      if (required > run.budget_usd) {
        this.pauseForBudget(run);
        this.save(run);
        return false;
      }
      const active = this.tasks.get(runId);
      run.status = active && !active.done ? "running" : "queued";
      run.error = null;
      this.save(run);
      return true;
    });
    if (!go) return;
    this.emit(runId, "run.recovered", { reason: "lead" });
    this.start(runId);
  }
}

/** A chat's answer without its ENGINEER line, and the call it makes (the chat package reads it). */
async function chatEngineer(answer: string): Promise<[string, supervisor.EngineerCall | null]> {
  const found = await chat.ask("chat.split", { text: answer });
  return [String(found.text ?? ""), found.engineer ?? null];
}
