// Conservative observational routing feedback; cohorts never cross capability/difficulty
//.
import type { Database } from "./db.js";
import { Outcome, type TaskNode } from "./models.js";

export const MIN_SAMPLES = 8;
const OUTCOMES = new Set<string>([Outcome.PASSED, Outcome.REJECTED, Outcome.VERIFY_FAILED, Outcome.UNVERIFIED, Outcome.UNABLE, Outcome.ERROR]);

export type Stats = { samples: number; successes: number; cost_usd: number; seconds: number; timed: number };
/** By model, capability and difficulty (key: feedbackKey). */
export type Feedback = Map<string, Stats>;

export const feedbackKey = (modelId: string | null, capability: string, difficulty: string) =>
  JSON.stringify([modelId, capability, difficulty]);

export function collect(db: Pick<Database, "listRuns">): Feedback {
  const groups: Feedback = new Map();
  for (const run of db.listRuns().slice(0, 200)) {
    for (const node of run.plan.nodes) {
      // A difficult step with many retries is ONE observed job per model, not many independent samples.
      const byModel = new Map<string | null, typeof node.attempts>();
      for (const attempt of node.attempts) {
        if (OUTCOMES.has(attempt.outcome)) {
          if (!byModel.has(attempt.model_id)) byModel.set(attempt.model_id, []);
          byModel.get(attempt.model_id)!.push(attempt);
        }
      }
      for (const [modelId, attempts] of byModel) {
        const key = feedbackKey(modelId, node.capability, node.difficulty);
        if (!groups.has(key)) groups.set(key, { samples: 0, successes: 0, cost_usd: 0, seconds: 0, timed: 0 });
        const stats = groups.get(key)!;
        stats.samples += 1;
        stats.successes += attempts.some((item) => item.outcome === Outcome.PASSED) ? 1 : 0;
        stats.cost_usd += attempts.reduce((sum, item) => sum + item.cost_usd, 0);
        const timed = attempts.map((item) => item.duration_seconds).filter((value): value is number => value !== null);
        if (timed.length) {
          stats.seconds += timed.reduce((sum, value) => sum + value, 0);
          stats.timed += 1;
        }
      }
    }
  }
  return groups;
}

type NodeLike = Pick<TaskNode, "capability" | "difficulty">;

export function expectedCost(node: NodeLike, model: { id: string }, base: number, feedback: Feedback | null): number {
  const stats = feedback?.get(feedbackKey(model.id, node.capability, node.difficulty));
  if (!stats || stats.samples < MIN_SAMPLES) return base;
  const count = stats.samples;
  const success = (stats.successes + 2) / (count + 2);
  // Theoretical costs form a prior; include observed rework even if estimates were optimistic.
  const cost = Math.max(base, (stats.cost_usd + base * 2) / (count + 2)) / success;
  // Latency is a bounded tie-break incentive, never an arbitrary dollar value for time.
  const timed = stats.timed ?? 0;
  const latency = timed >= MIN_SAMPLES ? Math.min((stats.seconds ?? 0) / timed / 300, 2) : 0;
  return cost * (1 + 0.1 * latency);
}

export function note(node: NodeLike, model: { id: string }, feedback: Feedback | null): string {
  const stats = feedback?.get(feedbackKey(model.id, node.capability, node.difficulty));
  if (!stats || stats.samples < MIN_SAMPLES) return "";
  return ` 同类历史 ${stats.samples} 个步骤、${stats.successes} 个通过；已结合返工费用和有记录的耗时排序（观察数据，非因果结论）。`;
}
