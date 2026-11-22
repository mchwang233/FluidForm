// What the lead is asked about an attempt that runs far past its expected time.
import * as activity from "../../../src/activity.js";
import { BudgetExceeded, StepLimitExceeded } from "../../../src/budget.js";
import { settings } from "../../../src/config.js";
import type { ExecutionRun, TaskNode } from "../../../src/models.js";
import * as progress from "../../../src/progress.js";
import { pyRound } from "../../../src/py.js";
import * as quality from "../../../src/quality.js";
import type { ReviewHost } from "../../../src/review.js";
import { loopTurns } from "../../../src/routing.js";
import * as supervisor from "../../../src/supervisor.js";
import { isCancelled } from "../../../src/tasks.js";

/** A step others wait for that runs far past its expected time is not stuck, but holds the whole task:
 *  the lead says whether it goes on or stops for a faster model. Asked again after each further stretch
 *  of that length. */
export async function criticalCheck(host: ReviewHost, runId: string, node: TaskNode, modelId: string, minutes: number, evidence: string,
  asked: number[]): Promise<string | null> {
  const expected = loopTurns(node) * settings.minutes_per_turn;
  const due = expected * settings.critical_overrun_factor * (asked[0] + 1);
  const run = host.db.getRun(runId);
  if (!run || minutes < due || !run.supervisor?.model_id || !host.canLead()) return null;
  const below = quality.descendants(run, new Set([node.id]));
  const waiting = run.plan.nodes.filter((item) => below.has(item.id) && item.status === "pending").map((item) => item.title);
  if (!waiting.length) return null;
  asked[0] += 1;
  let reason: string | null;
  try {
    const reply = await host.thinking(runId, "critical_overrun", node.id, () => host.askLead(runId,
      supervisor.criticalOverrunMessage(node, modelId, minutes, expected, waiting, evidence)));
    reason = progress.parse(reply);
  } catch (error) {
    if (isCancelled(error) || error instanceof BudgetExceeded || error instanceof StepLimitExceeded) throw error;
    reason = null; // without an answer the attempt goes on
  }
  host.emit(runId, "node.critical_overrun_check", { node_id: node.id, model_id: modelId, minutes: pyRound(minutes), expected_minutes: pyRound(expected),
    waiting: waiting.length, stop: Boolean(reason), reason });
  return reason ? `${progress.CRITICAL_OVERRUN}${reason}` : null;
}

/** Whether a work package's attempt far past its expected turns goes on: null, or why it stops. */
export async function overrun(host: ReviewHost, run: ExecutionRun, node: TaskNode, modelId: string, expected: number, evidence: string,
  turns: number): Promise<string | null> {
  let reason: string | null;
  try {
    // The lead's call is not the step's work.
    const reply = await host.thinking(run.id, "overrun", node.id, () => activity.paused(() => host.askLead(run.id,
      supervisor.overrunMessage(node, turns, expected, evidence))));
    reason = progress.parse(reply);
  } catch (error) {
    if (isCancelled(error) || error instanceof BudgetExceeded || error instanceof StepLimitExceeded) throw error;
    reason = null; // without an answer the attempt goes on
  }
  host.emit(run.id, "node.overrun_check", { node_id: node.id, model_id: modelId, turns, expected, stop: Boolean(reason), reason });
  return reason;
}
