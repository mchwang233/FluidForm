// tests/test_scoring.py (scores from Artificial Analysis), ported.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CapabilityScoreSchema, type ModelProfile, ModelProfileSchema, routingReady } from "../src/models.js";
import { pyRound } from "../src/py.js";
import { AA_SOURCE, applyAaScores, type BenchmarkRow, INTELLIGENCE, SCORE_RANGES } from "../src/scoring.js";

const aaRow = (index: number, details: Record<string, number> = {}): BenchmarkRow => ({
  source: AA_SOURCE, metrics: Object.entries({ [INTELLIGENCE]: index, ...details }).map(([key, value]) => ({ key, value })),
});

const model = (id: string, scores: Record<string, number> | null = null, fields: Record<string, unknown> = {}) =>
  ModelProfileSchema.parse({ id, provider: id.split(":")[0], display_name: id, scores, context_window: 200_000,
    input_per_million: 1, output_per_million: 2, ...fields });

const map = (entries: Record<string, ModelProfile>) => ({ ...entries });
const matches = (entries: Record<string, BenchmarkRow[]>) => new Map(Object.entries(entries));

// A population of ten AA-scored models with intelligence index 10, 20, ..., 100.
const POPULATION = Array.from({ length: 10 }, (_, step) => aaRow(10 * (step + 1), { aa_non_hallucination: 10 * (step + 1) }));

test("AA results become routing scores by rank", () => {
  const models = map({ "kimi:k": model("kimi:k", { coding: 50, planning: 50 }), "minimax:m3": model("minimax:m3") });
  const changed = applyAaScores(models, matches({ "kimi:k": [aaRow(100, { aa_non_hallucination: 100 })],
    "minimax:m3": [aaRow(10, { aa_non_hallucination: 10 })] }), POPULATION);
  const top = models["kimi:k"];
  const bottom = models["minimax:m3"];
  assert.deepEqual(new Set(changed.map((item) => item.id)), new Set(["kimi:k", "minimax:m3"]));
  assert.ok(top.scores_source === AA_SOURCE && bottom.scores_source === AA_SOURCE);
  // Highest of ten sits at the 95th percentile, lowest at the 5th, inside the score span.
  const [low, high] = SCORE_RANGES.planning;
  assert.equal(top.scores!.planning, pyRound(low + 0.95 * (high - low), 1));
  assert.equal(bottom.scores!.planning, pyRound(low + 0.05 * (high - low), 1));
  assert.ok(top.scores!.reliability > bottom.scores!.reliability);
  assert.ok(top.scores_basis!.includes("综合智能指数 100") && top.scores_basis!.includes("前 5%"));
  assert.ok(routingReady(bottom));
});

test("the strongest matched variant is used and other sources are ignored", () => {
  const models = map({ "openai:x": model("openai:x") });
  applyAaScores(models, matches({ "openai:x": [aaRow(30), aaRow(90),
    { source: "superclue", metrics: [{ key: INTELLIGENCE, value: 100 }] }] }), POPULATION);
  assert.ok(models["openai:x"].scores_basis!.includes("综合智能指数 90"));
});

test("models without AA results lose their scores and are not routed", () => {
  const stale = model("deepseek:deepseek-chat", { coding: 82 }, { scores_source: "preset" });
  const demo = model("mock:local", { coding: 80 }, { scores_source: "demo" });
  const models = map({ "deepseek:deepseek-chat": stale, "minimax:m3": model("minimax:m3"), "mock:local": demo });
  applyAaScores(models, matches({ "minimax:m3": [aaRow(50)] }), POPULATION);
  assert.ok(stale.scores === null && stale.scores_source === "none" && !routingReady(stale));
  assert.ok(routingReady(models["minimax:m3"]));
  assert.deepEqual(demo.scores, CapabilityScoreSchema.parse({ coding: 80 }));
  const changed = applyAaScores(models, new Map(), POPULATION);
  assert.deepEqual(changed.map((item) => item.id), ["minimax:m3"]);
  assert.ok(models["minimax:m3"].scores === null && !routingReady(models["minimax:m3"]));
});

test("a CLI inherits the strongest AA model of its vendor", () => {
  const cli = model("cli:codex", null, { provider: "openai", channel: "cli" });
  const models = map({ "cli:codex": cli, "openai:big": model("openai:big"), "openai:small": model("openai:small"),
    "cli:qwen": model("cli:qwen", null, { provider: "qwen", channel: "cli" }) });
  applyAaScores(models, matches({ "openai:big": [aaRow(90)], "openai:small": [aaRow(20)], "cli:codex": [aaRow(10)] }), POPULATION);
  assert.deepEqual(cli.scores, models["openai:big"].scores);
  assert.ok(cli.scores_source === AA_SOURCE && cli.scores_basis!.includes("openai:big"));
  // No AA-scored Qwen model in the catalog: the Qwen CLI is not routed.
  assert.equal(models["cli:qwen"].scores, null);
});

test("rescoring with unchanged results changes nothing", () => {
  const models = map({ "minimax:m3": model("minimax:m3") });
  const found = matches({ "minimax:m3": [aaRow(50)] });
  assert.ok(applyAaScores(models, found, POPULATION).length);
  assert.deepEqual(applyAaScores(models, found, POPULATION), []);
});

test("without cached AA results the last scores are kept", () => {
  const kept = model("minimax:m3", { coding: 90 }, { scores_source: AA_SOURCE });
  const models = map({ "minimax:m3": kept, "minimax:new": model("minimax:new") });
  assert.deepEqual(applyAaScores(models, matches({ "minimax:new": [aaRow(50)] }), []), []);
  assert.deepEqual(kept.scores, CapabilityScoreSchema.parse({ coding: 90 }));
  assert.equal(models["minimax:new"].scores, null);
});
