// The records FluidForm keeps: their schemas in model-schemas.ts, the validators in model-hooks.ts,
// and here what the models also say.
import type { CapabilityScore, ExecutionRun, ModelProfile, PlanPart, TaskPlan } from "./model-schemas.js";

export * from "./model-schemas.js";
export { difficultyFor, toPercentScale } from "./model-hooks.js";
export { nowIso as utcnow } from "./lax.js";

/** Task difficulty sets the minimum routing score (0-100) for the task's capability. */
export const DIFFICULTY_THRESHOLDS: Record<string, number> = { easy: 70, normal: 80, hard: 90 };

export const FINISHED = new Set(["succeeded", "failed", "cancelled", "incomplete"]);

/** How an attempt of a step ended (NodeAttempt.outcome). */
export const Outcome = {
  PASSED: "passed",
  DELEGATED: "delegated", // yielded to accepted child work; not a failure
  REJECTED: "rejected", // the reviewer did not accept the result
  VERIFY_FAILED: "verify_failed", // a verification step found problems
  UNVERIFIED: "unverified", // no reviewer could give a verdict
  UNABLE: "unable", // the step cannot be done in this environment
  ERROR: "error", // the model call failed
  BUDGET: "budget", // not enough budget left for the next request
  SUPERSEDED: "superseded", // upstream rework made the attempt stale
  CANCELLED: "cancelled",
  QUOTA: "quota", // the model ran out of usage; another takes over
  UNAVAILABLE: "unavailable", // the model's service is down; another takes over
  BLOCKED: "blocked", // missing artifact evidence or an unenforceable contract
  STOPPED: "stopped", // a declared work-package limit was reached
} as const;

/** A diagnosis's conclusion (Diagnosis.verdict), from its STATUS line or the platform repair. */
export const DiagnosisStatus = {
  FIXED: "fixed",
  RETRY: "retry",
  UNABLE: "unable",
  BLOCKED: "blocked",
  NEEDS_INPUT: "needs_input",
  QUOTA_EXHAUSTED: "quota_exhausted",
  MODEL_UNAVAILABLE: "model_unavailable",
  PLATFORM_REPAIR: "platform_repair",
  PLATFORM_PENDING: "platform_pending",
  PLATFORM_FIXED: "platform_fixed",
  PLATFORM_FAILED: "platform_failed",
} as const;

// Engineer jobs in these states are over; those in WAITING wait for the user.
export const ENGINEER_DONE = new Set(["applied", "failed", "rejected", "cancelled"]);
export const ENGINEER_WAITING = new Set(["plan_ready", "ready", "needs_input"]);

export function scoreFor(scores: CapabilityScore, capability: string): number {
  const value = (scores as Record<string, unknown>)[capability];
  return typeof value === "number" ? value : scores.reliability;
}

/** The mean of all scores: how capable the model is in general. */
export function overall(scores: CapabilityScore): number {
  return (scores.coding + scores.planning + scores.research + scores.chinese + scores.tool_use
    + scores.structured_output + scores.reliability) / 7;
}

// Whether anything is priced (pricing.ts sets it): only then must a model have a price to be chosen.
export const hooks = { priced: () => true };

export function routingReady(model: ModelProfile): boolean {
  return model.scores !== null && model.context_window !== null
    && (!hooks.priced() || (model.input_per_million !== null && model.output_per_million !== null))
    && !["deprecated", "retired"].includes(model.catalog_status)
    && model.available_via_api !== false;
}

/** The parts from the top level down to ``partId``. */
export function partPath(plan: TaskPlan, partId: string | null): PlanPart[] {
  const byId = new Map(plan.parts.map((part) => [part.id, part]));
  const path: PlanPart[] = [];
  let id = partId;
  while (id !== null && byId.has(id) && path.length < 10) {
    const part = byId.get(id)!;
    path.unshift(part);
    id = part.parent_id;
  }
  return path;
}

/** Name of the scratch folder under workspace_root; shared along a chain of changes. */
export function folderId(run: ExecutionRun): string {
  return run.workspace_id || run.folder_name || run.id;
}

// A diagnosis or repair that changed FluidForm itself: "fluidform", or "fluidform" in records made
// before it was renamed.
export const PLATFORM_SCOPE = "fluidform";
export const isPlatformScope = (scope: unknown) => scope === PLATFORM_SCOPE || scope === "super_partner";
