// Routing scores from Artificial Analysis results.
//
// Routing scores come only from Artificial Analysis (AA); a model AA has not scored has no scores
// and is not routed. AA reports 0-100 values on its own scales, so each metric is converted by
// rank: the model's percentile among every AA-scored model is placed linearly within SCORE_RANGES
// for that capability. Membership CLIs run whatever model the account defaults to, so each
// inherits the scores of the strongest AA-scored model from the same vendor.
import { isDeepStrictEqual } from "node:util";
import { type CapabilityScore, CapabilityScoreSchema, type ModelProfile } from "../../../src/models.js";
import { formatG, pyRound } from "../../../src/py.js";

import { AA_SOURCE } from "../../../src/catalog.js";

export { AA_SOURCE };
export const INTELLIGENCE = "artificial_analysis_intelligence_index";
// AA metrics behind each routing capability. AA has no Chinese-language or structured-output
// evaluation, so those two follow the overall intelligence index.
export const CAPABILITY_METRICS: Record<string, string[]> = {
  coding: ["artificial_analysis_coding_index", "aa_scicode", "aa_terminalbench_4"],
  planning: [INTELLIGENCE, "aa_hle"],
  research: ["aa_knowledge_accuracy", "aa_lcr", "aa_hle"],
  chinese: [INTELLIGENCE],
  tool_use: ["artificial_analysis_agentic_index", "aa_terminalbench_4"],
  structured_output: [INTELLIGENCE],
  reliability: ["aa_non_hallucination"],
};
export const CAPABILITY_LABELS: Record<string, string> = {
  coding: "代码", planning: "规划", research: "调研", chinese: "中文",
  tool_use: "工具使用", structured_output: "结构化输出", reliability: "可靠性",
};
// Score span (0-100) per capability, from the lowest- to the highest-ranked AA model. Kept at the
// span the former hand-written scores covered, so planner quality thresholds keep their meaning.
export const SCORE_RANGES: Record<string, [number, number]> = {
  coding: [74, 97], planning: [70, 96], research: [72, 94], chinese: [76, 97],
  tool_use: [78, 98], structured_output: [82, 96], reliability: [78, 94],
};
// Fixed scores are kept only for the offline demo model, which has no real results.
export const FIXED_SCORE_PROVIDERS = new Set(["mock"]);

export type BenchmarkRow = { source: string; metrics: { key: string; value: number }[] };
type Population = Map<string, number[]>;

function aaRows(rows: Iterable<BenchmarkRow>): Map<string, number>[] {
  return [...rows].filter((row) => row.source === AA_SOURCE)
    .map((row) => new Map(row.metrics.map((metric) => [metric.key, metric.value])));
}

function bisectLeft(values: number[], value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (values[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function bisectRight(values: number[], value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (value < values[middle]) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** Mid-rank percentile, so ties share a position and the scale runs 0..1. */
function percentile(values: number[], value: number): number {
  const below = bisectLeft(values, value);
  const through = bisectRight(values, value);
  return (below + (through - below) / 2) / values.length;
}

/** Scores and a short explanation for one model, or null without an AA intelligence index. */
export function deriveScores(matchedRows: BenchmarkRow[], population: Population): [CapabilityScore, string, number] | null {
  const candidates = aaRows(matchedRows).filter((row) => row.has(INTELLIGENCE));
  if (!candidates.length) return null;
  // Several AA rows can match one model (reasoning-effort variants); use the strongest (the first).
  const best = candidates.reduce((top, row) => (row.get(INTELLIGENCE)! > top.get(INTELLIGENCE)! ? row : top));
  const scores: Record<string, number> = {};
  const notes: string[] = [];
  for (const [capability, keys] of Object.entries(CAPABILITY_METRICS)) {
    let used = keys.filter((key) => best.has(key) && (population.get(key)?.length ?? 0) > 0);
    if (!used.length) used = [INTELLIGENCE];
    const rank = used.reduce((sum, key) => sum + percentile(population.get(key)!, best.get(key)!), 0) / used.length;
    const [low, high] = SCORE_RANGES[capability];
    scores[capability] = pyRound(low + rank * (high - low), 1);
    notes.push(`${CAPABILITY_LABELS[capability]}前 ${Math.max(1, pyRound((1 - rank) * 100))}%`);
  }
  const index = best.get(INTELLIGENCE)!;
  const basis = `按 Artificial Analysis 成绩换算（综合智能指数 ${formatG(index)}）：${notes.join("，")}。按在全部 AA 已评测模型中的排名换算为调度分。`;
  return [CapabilityScoreSchema.parse(scores), basis, index];
}

/** Score every model from AA, CLIs from their vendor's best AA model, and clear the rest.
 *  Changes the live model objects and returns the changed ones for the caller to persist. */
export function applyAaScores(models: Record<string, ModelProfile>, matches: Map<string, BenchmarkRow[]>,
  allRows: Iterable<BenchmarkRow>): ModelProfile[] {
  const population: Population = new Map();
  for (const row of aaRows(allRows)) {
    for (const [key, value] of row) {
      if (!population.has(key)) population.set(key, []);
      population.get(key)!.push(value);
    }
  }
  for (const values of population.values()) values.sort((a, b) => a - b);
  // No AA results cached yet (first start offline, failed fetch): keep the last scores.
  if (!population.get(INTELLIGENCE)?.length) return [];
  const changed: ModelProfile[] = [];
  const derived = new Map<string, [CapabilityScore, string, number]>();
  for (const model of Object.values(models)) {
    if (model.channel === "cli") continue;
    const result = deriveScores(matches.get(model.id) ?? [], population);
    if (result) derived.set(model.id, result);
  }
  // A membership CLI inherits from the strongest AA-scored API model of its vendor.
  const flagships = new Map<string, ModelProfile>();
  for (const [modelId, [, , index]] of derived) {
    const model = models[modelId];
    const current = flagships.get(model.provider);
    if (!current || index > derived.get(current.id)![2]) flagships.set(model.provider, model);
  }
  for (const model of Object.values(models)) {
    if (FIXED_SCORE_PROVIDERS.has(model.provider)) {
      if (model.scores_source !== "demo") {
        model.scores_source = "demo";
        model.scores_basis = null;
        changed.push(model);
      }
      continue;
    }
    const flagship = model.channel === "cli" ? flagships.get(model.provider) : undefined;
    let scores: CapabilityScore | null = null;
    let basis: string | null = null;
    if (derived.has(model.id)) [scores, basis] = derived.get(model.id)!;
    else if (flagship) {
      const [flagScores, flagBasis] = derived.get(flagship.id)!;
      scores = flagScores;
      basis = `CLI 使用会员账户的默认模型，沿用同厂商 AA 成绩最好的 ${flagship.display_name} 的调度分。${flagBasis}`;
    }
    const source = scores ? AA_SOURCE : "none";
    if (!isDeepStrictEqual([model.scores, model.scores_source, model.scores_basis], [scores, source, basis])) {
      model.scores = scores;
      model.scores_source = source;
      model.scores_basis = basis;
      changed.push(model);
    }
  }
  return changed;
}

/** What scoring needs of the benchmark cache (benchmarks.ts, a later phase). */
export type Benchmarks = {
  results(): BenchmarkRow[];
  matchModels(models: ModelProfile[]): Map<string, BenchmarkRow[]>;
};

/** Re-derive AA scores from the benchmark cache and persist what changed. */
export function rescore(models: Record<string, ModelProfile>, benchmarks: Benchmarks, db: { saveModels(models: ModelProfile[]): void }): ModelProfile[] {
  const changed = applyAaScores(models, benchmarks.matchModels(Object.values(models)), benchmarks.results());
  db.saveModels(changed);
  return changed;
}
