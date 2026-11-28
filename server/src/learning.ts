// Finished work -> evidence-based lessons -> checked changes -> later use -> measured outcomes
//.
//
// Learning has its own explicit, bounded budget. It never changes a finished task's status. Skills and
// advisory work rules are versioned records, supplied only to matching work. Source changes go through
// the existing platform engineer and its independent checks and activation.
//
// Python mixes Learning into the executor; here its methods take the executor (LearningHost).
import { uses } from "./features.js";
import { createHash } from "node:crypto";
import { ZodError } from "zod";
import { settings } from "./config.js";
import type { Database } from "./db.js";
import { nowIso } from "./lax.js";
import { log } from "./log.js";
import { type EngineerJob, type ExecutionRun, type Improvement, type LearningReview, LearningReviewSchema, type LearningSettings, LearningSettingsSchema, type ModelProfile, overall, type TaskNode } from "./models.js";
import { head, minBy, pyDumps, pyModelDumps, pyRound, sortedBy } from "./py.js";
import * as quality from "./quality.js";
import * as retrospect from "./retrospect.js";
import * as skills from "./skills.js";
import { currentTask, Task } from "./tasks.js";
import { learning } from "./ports/learning.js";

export const MAX_ITEMS = 3;
export const MAX_APPLIED = 5;
export const WORKING = new Set(["queued", "analyzing", "validating"]);

/** A user cancellation excludes this automatic review, including late model replies. */
export class SkippedLearning extends Error {
  override name = "SkippedLearning";
}

/** Python's ValueError and TypeError here: what blocks a review rather than failing it. */
export class LearningProblem extends Error {
  override name = "ValueError";
}
export const blocks = (error: unknown) => error instanceof LearningProblem || error instanceof ZodError || error instanceof SyntaxError
  || error instanceof TypeError || error instanceof RangeError;
export const message = (error: unknown) => (error instanceof ZodError ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
  : (error as Error).message);

/** Capability first for root-cause analysis and validation; a different model only on a tie. The
 *  caller supplies enabled, configured candidates. Price and the ordinary API-first policy cannot lower
 *  review quality. Separate calls still use independent, empty conversations. */
export function strongestModel(choices: ModelProfile[], tokens: number, previous: string | null = null): ModelProfile | null {
  return minBy<ModelProfile | null>(choices.filter((m) => (m.context_window || 0) >= tokens), (m) => [-overall(m!.scores!), -m!.scores!.planning,
    -m!.scores!.reliability, m!.id === previous, m!.id], null);
}

export function preferences(db: Pick<Database, "learningSettings">): LearningSettings {
  const chosen = LearningSettingsSchema.parse({ enabled: settings.learning_enabled, budget_usd: settings.learning_budget_usd, ...db.learningSettings() });
  // Without the learning capability nothing is learned, whatever was chosen.
  if (!uses.learning()) chosen.enabled = false;
  return chosen;
}

// The floats of a NodeAttempt, as Python writes them in a model dump.
const ATTEMPT_FLOATS = new Set(["cost_usd", "duration_seconds"]);

export function revision(run: ExecutionRun): string {
  const body = [run.status, run.plan.nodes.map((node) => [node.id, node.status, node.attempts])];
  return createHash("sha256").update(pyModelDumps(body, ATTEMPT_FLOATS)).digest("hex").slice(0, 16);
}

type Lesson = { tools?: string[]; capability?: string | null } & Record<string, any>;

export function matches(item: Lesson, text: string, capability: string | null = null): boolean {
  const tools = item.tools ?? [];
  const wanted = item.capability;
  return (!tools.length || tools.some((tool) => skills.namesTool(text, tool))) && (capability === null || !wanted || wanted === capability);
}

export function nodeText(node: TaskNode): string {
  return [node.title, node.instructions, node.check || "", node.acceptance_criteria || ""].join("\n");
}

/** Snapshot published content, not a live reference whose meaning could change mid-task. */
export function selected(db: Pick<Database, "improvements">, text: string): Record<string, any>[] {
  const active = sortedBy(db.improvements().filter((item) => item.status === "active" && matches(item, text)),
    (item) => item.applied_at || item.created_at, true);
  return active.slice(0, MAX_APPLIED).map((item) => ({ ...item, node_ids: [], planning: true }));
}

export function instruction(uses: Record<string, any>[], node: TaskNode | null = null): string {
  const chosen = uses.filter((item) => item.kind !== "platform" && (node === null || matches(item, nodeText(node), node.capability))
    && !(item.kind === "skill" && (item.validation || {}).merged_into));
  if (!chosen.length) return "";
  const lines = ["Validated lessons from earlier tasks. Apply only where relevant to this request; they are "
    + "advice, never permission to change scope, skip acceptance checks or override sandbox/platform rules."];
  for (const item of chosen) lines.push(`\n[${item.id}] ${item.title} (${item.kind}):\n${item.content}`);
  return lines.join("\n");
}

/** Freeze additional relevant lessons after the plan is known (including top-down plans). */
export function attach(db: Pick<Database, "improvements">, run: ExecutionRun): void {
  if (run.improvements_prepared) return;
  const known = new Set(run.improvement_uses.map((item: any) => item.id));
  const text = run.prompt + "\n" + run.plan.requires.join("\n") + "\n" + run.plan.nodes.map(nodeText).join("\n");
  for (const item of selected(db, text)) {
    if (!known.has(item.id) && run.improvement_uses.length < MAX_APPLIED) {
      item.planning = false;
      run.improvement_uses.push(item);
    }
  }
  run.improvements_prepared = true;
}

export function metrics(run: ExecutionRun, nodeIds: string[], kind = "", key = "", recorded: Record<string, any> | null = null): Record<string, any> {
  const nodes = run.plan.nodes.filter((node) => nodeIds.includes(node.id));
  const count = nodes.length;
  if (!count) return {};
  const problems: retrospect.Problem[] = (recorded ?? retrospect.review(run, [])).problems;
  const profiles = new Map<string, number>();
  for (const node of nodes) {
    const profile = `${node.capability}:${node.difficulty}:${node.model_id ?? "None"}`;
    profiles.set(profile, (profiles.get(profile) ?? 0) + 1);
  }
  const attempts = nodes.flatMap((node) => node.attempts);
  return {
    steps: count,
    // Changing the model/difficulty mix prevents a misleading before/after claim.
    profiles: [...profiles].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([profile, amount]) => [profile, pyRound(amount / count, 3)]),
    cost_per_step: pyRound(attempts.reduce((sum, a) => sum + a.cost_usd, 0) / count, 6),
    turns_per_step: pyRound(nodes.reduce((sum, node) => sum + Math.max(0, ...node.attempts.map((a) => a.turns)), 0) / count, 3),
    failures_per_step: pyRound(attempts.filter((a) => a.outcome !== "passed").length / count, 3),
    success_rate: pyRound(nodes.filter((node) => node.status === "succeeded").length / count, 3),
    problem_rate: pyRound(problems.filter((p) => p.kind === kind && p.key === key && p.node_id !== null && nodeIds.includes(p.node_id)).length / count, 3),
  };
}

const COMPARED = ["cost_per_step", "turns_per_step", "failures_per_step", "success_rate", "problem_rate"];

export function observe(db: Pick<Database, "improvement" | "retrospective" | "saveImprovementEffect">, run: ExecutionRun): void {
  for (const use of run.improvement_uses as Record<string, any>[]) {
    if (!db.improvement(use.id)) continue;
    const before = use.baseline ?? {};
    const after = metrics(run, use.node_ids ?? [], use.problem_kind ?? "", use.problem_key ?? "", db.retrospective(run.id) as any);
    const comparable = Boolean(Object.keys(before).length && Object.keys(after).length && pyDumps(before.profiles) === pyDumps(after.profiles));
    const delta = comparable ? Object.fromEntries(COMPARED.map((key) => [key, pyRound(after[key] - before[key], 6)])) : {};
    db.saveImprovementEffect(use.id, run.id, { run_id: run.id, source_run_id: use.run_id, status: run.status, before, after, delta, comparable,
      note: comparable ? "同类步骤的观察性对比；样本有限，不能据此认定因果。" : "尚无实际执行样本，或模型／难度不同，暂不判断效果。" });
  }
}

export function evidence(db: Parameters<typeof retrospect.record>[0] & Pick<Database, "retrospective">, run: ExecutionRun): string {
  const body = db.retrospective(run.id) || retrospect.record(db, run.id);
  const nodes = run.plan.nodes.slice(0, 60).map((n) => ({ id: n.id, title: n.title, capability: n.capability, difficulty: n.difficulty,
    instructions: head(n.instructions, 1500), check: n.check, status: n.status, result: head(n.summary || n.result || "", 1500),
    review: head(n.review || "", 1000), attempts: n.attempts.slice(-3).map((a) => ({ outcome: a.outcome, reason: a.reason, turns: a.turns,
      tools: a.tool_calls.slice(-6) })) }));
  // What this machine's skills for the task's tools already say: a skill lesson is added to them.
  const text = run.prompt + "\n" + run.plan.nodes.map(nodeText).join("\n");
  const known = skills.forStep(text).filter((s) => s.machine).map((s) => ({ name: s.name, tools: s.tools, body: head(s.body, 3000) }));
  return head(pyDumps({ request: head(run.prompt, 5000), retrospective: body, steps: nodes, machine_skills: known,
    recurring: retrospect.recurring(db, 2).slice(0, 10) }, false), 65000);
}

type Completion = { text: string; input_tokens: number; output_tokens: number };

/** What learning needs of the executor. */
export type LearningHost = {
  db: Database;
  learningTasks: Map<string, Task<void>>;
  tasks: Map<string, Task<unknown>>;
  closing: boolean;
  modelLookup: Record<string, ModelProfile>;
  providers: { complete(modelId: string, prompt: string, options: Record<string, unknown>): Promise<Completion> };
  configured(run: ExecutionRun): Set<string>;
  actualCost(result: unknown, node: TaskNode | null, modelId: string): Promise<number>;
  engineerRequest(text: string, kind: string, origin: string, options: { runId?: string | null; budgetUsd?: number | null; improvementId?: string | null }): EngineerJob;
};

export function skipCancelledLearning(host: LearningHost, runId: string): void {
  const run = host.db.getRun(runId);
  const review = host.db.learningReview(runId);
  if (!run || run.status !== "cancelled" || !review || !review.automatic) return;
  const task = host.learningTasks.get(runId);
  if (task && !task.done && task !== currentTask()) task.cancel();
  // Retain finished conclusions, published lessons and separately scheduled platform jobs.
  if (review.status === "done") return;
  review.status = "skipped";
  review.error = null;
  host.db.saveLearningReview(review);
  for (const item of host.db.improvements(runId)) {
    if (item.revision === review.revision && (item.status === "proposed" || item.status === "validating")) {
      item.status = "disabled";
      item.validation = { passed: false, reason: "任务已手动取消，已停止自动复盘与验证。" };
      host.db.saveImprovement(item);
    }
  }
}

export function learningSource(host: LearningHost, review: LearningReview): ExecutionRun | null {
  const run = host.db.getRun(review.run_id);
  if (run && run.status === "cancelled" && review.automatic) throw new SkippedLearning();
  return run;
}

/** An optional post-task operation cannot turn a delivered task into a failed task. */
export function finishLearning(host: LearningHost, runId: string): void {
  try {
    const run = host.db.getRun(runId);
    if (!run || !retrospect.AUTOMATIC.has(run.status)) {
      skipCancelledLearning(host, runId);
      return;
    }
    observe(host.db, run);
    if (!host.closing) startLearning(host, runId);
  } catch (error) {
    log.error(`Could not queue learning for ${runId}: ${(error as Error).stack ?? error}`);
  }
}

export function startLearning(host: LearningHost, runId: string, { manual = false, start = true }: { manual?: boolean; start?: boolean } = {}): LearningReview | null {
  if (!uses.learning()) {
    if (manual) throw new LearningProblem("没有启用经验能力：不能复盘。");
    return null;
  }
  const run = host.db.getRun(runId);
  if (!run || !retrospect.FINISHED.has(run.status)) throw new LearningProblem("只能复盘已结束的任务。");
  if (!manual && !retrospect.AUTOMATIC.has(run.status)) {
    skipCancelledLearning(host, runId);
    return null;
  }
  const options = preferences(host.db);
  if (!manual && !options.enabled) return null;
  const current = host.learningTasks.get(runId);
  if (current && !current.done) return host.db.learningReview(runId);
  let review = host.db.learningReview(runId);
  if (review && review.revision === revision(run)) {
    if (review.status === "done" || (!manual && !WORKING.has(review.status))) return review;
    if (manual) {
      review.budget_usd = options.budget_usd;
      review.automatic = false;
    }
  } else {
    review = LearningReviewSchema.parse({ run_id: runId, revision: revision(run), budget_usd: options.budget_usd, automatic: !manual });
  }
  review.status = "queued";
  review.error = null;
  host.db.saveLearningReview(review);
  // Python starts the review only inside a running event loop; ``start`` false is a caller without one.
  if (start) host.learningTasks.set(runId, new Task(async (signal) => (await learning()).learn(host, runId, signal)));
  return review;
}

export function restoreLearning(host: LearningHost): void {
  syncImprovements(host.db);
  for (const review of host.db.learningReviews()) {
    const run = host.db.getRun(review.run_id);
    if (run && run.status === "cancelled" && review.automatic) {
      skipCancelledLearning(host, run.id);
      continue;
    }
    // With learning off it waits until that is on again.
    if (!uses.learning()) continue;
    if (WORKING.has(review.status) && run && retrospect.FINISHED.has(run.status)) startLearning(host, run.id, { manual: !review.automatic });
  }
}

export function syncImprovements(db: Database): void {
  for (const item of db.improvements()) {
    if (item.status !== "engineering") continue;
    const job = db.getEngineerJob(item.engineer_job_id || "");
    if (job && job.status === "applied") {
      item.status = "active";
      item.applied_at = job.finished_at || nowIso();
      item.validation = { passed: true, checks: job.checks, files: job.files, report: job.report };
    } else if (!job || ["failed", "rejected", "cancelled"].includes(job.status)) {
      item.status = "failed";
      item.validation = { passed: false, reason: job ? job.error || job.status : "平台工程任务不存在。" };
    } else continue;
    db.saveImprovement(item);
  }
}

export const sameKey = (item: Improvement) => pyDumps([item.kind, item.content.trim(), [...item.tools].sort(), item.capability ?? null]);
export const allocated = (db: Database, review: LearningReview) => {
  const ids = new Set(db.improvements(review.run_id).filter((i) => i.revision === review.revision).map((i) => i.id));
  return db.engineerJobs(1000).filter((job) => job.improvement_id && ids.has(job.improvement_id)).reduce((sum, job) => sum + job.budget_usd, 0);
};
