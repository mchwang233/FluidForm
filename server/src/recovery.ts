// What happens after an attempt of a step fails when the task's lead does not decide (no lead is
// available, or it sent a diagnosis to repair something): which model tries next, and what a
// diagnosis means for the step. Decisions only; the executor carries them out.
// With a lead, its decisions (leading) take the place of these rules.
import { settings } from "./config.js";
import { DiagnosisStatus, type ModelProfile, type NodeAttempt, Outcome, type TaskNode } from "./models.js";
import { pyRound } from "./py.js";
import { strongerThan, strongestFor } from "./routing.js";

// Turns of tool calls an API model gets for a node, as a multiple of api_agent_max_turns.
export const TURNS_BY_DIFFICULTY: Record<string, number> = { easy: 1.0, normal: 1.5, hard: 2.0 };
// Outcomes that say a model's attempt was not good enough. Provider limits (quota, unavailable),
// budget pauses, cancelled or superseded work, unverified reviews and unable steps do not.
export const MODEL_FAILURES = new Set<string>([Outcome.REJECTED, Outcome.VERIFY_FAILED, Outcome.ERROR]);
// Failures in a row of one model on a step, after which the step goes to another model.
export const SWITCH_AFTER = 2;
// Environment repairs per node that do not count as failed attempts.
export const MAX_ENVIRONMENT_FIXES = 2;

/** Turns of tool calls for an attempt, or null without a limit (the default). */
export function turnsFor(node: TaskNode): number | null {
  if (!settings.api_agent_max_turns) return null;
  return Math.max(1, pyRound(settings.api_agent_max_turns * (TURNS_BY_DIFFICULTY[node.difficulty] ?? 1.0)));
}

/** The step's model failures since its last accepted attempt, oldest first. Running out of turns
 *  is one too, whatever the model claimed at the end. */
export function recentFailures(node: TaskNode): NodeAttempt[] {
  let failures: NodeAttempt[] = [];
  for (const attempt of node.attempts) {
    if (attempt.outcome === Outcome.PASSED) failures = [];
    else if (MODEL_FAILURES.has(attempt.outcome) || attempt.turn_limit) failures.push(attempt);
  }
  return failures;
}

/** Models that failed the step SWITCH_AFTER times in a row since it last passed. */
export function failedModels(node: TaskNode): Set<string> {
  const failed = new Set<string>();
  let streak = 0;
  let previous: string | null | undefined;
  for (const attempt of recentFailures(node)) {
    streak = attempt.model_id === previous ? streak + 1 : 1;
    previous = attempt.model_id;
    if (streak >= SWITCH_AFTER && attempt.model_id) failed.add(attempt.model_id);
  }
  return failed;
}

/** The model for the step's next attempt: the strongest one for it, unless that one already failed
 *  it twice in a row; then the best other model, a membership CLI included. */
export async function retryModel(node: TaskNode, models: ModelProfile[], configured: Set<string>, needsVision = false): Promise<ModelProfile | null> {
  const excluded = failedModels(node);
  let pick = await strongestFor(node, models, configured, needsVision);
  if (pick === null || excluded.has(pick.id)) pick = (await strongerThan(node, models, configured, null, needsVision, excluded)) ?? pick;
  return pick;
}

export type AfterDiagnosis = "hold_for_platform" | "ask_user" | "switch_model" | "retry_fixed" | "unable" | "pause" | "pause_rework" | "retry";

/** What a diagnosis of a failed attempt means for the step. ``outcome`` is the attempt's,
 *  ``status`` the diagnosis's (null if it did not finish). */
export function afterDiagnosis(outcome: string, status: string | null,
  { hasModel, environmentFixes }: { hasModel: boolean; environmentFixes: number }): AfterDiagnosis {
  if (status === DiagnosisStatus.PLATFORM_PENDING) return "hold_for_platform";
  if (status === DiagnosisStatus.NEEDS_INPUT) return "ask_user";
  if ((status === DiagnosisStatus.QUOTA_EXHAUSTED || status === DiagnosisStatus.MODEL_UNAVAILABLE) && outcome === Outcome.ERROR && hasModel) {
    return "switch_model";
  }
  if (status === DiagnosisStatus.FIXED && environmentFixes < MAX_ENVIRONMENT_FIXES) return "retry_fixed";
  if (status === DiagnosisStatus.UNABLE || (outcome === Outcome.UNABLE && status !== DiagnosisStatus.RETRY)) return "unable";
  if (status === DiagnosisStatus.BLOCKED) return "pause";
  if (outcome === Outcome.VERIFY_FAILED) return "pause_rework";
  return "retry";
}
