// routing.ts: tests from test_core, test_critical_path, test_briefing, test_call_runtime,
// test_diagnosis, test_engineer and test_tools, ported.
import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error: the pricing package is plain JavaScript
import { estimate, tokenCost } from "../packages/pricing/pricing.mjs";
import { builtinModels } from "../src/catalog.js";
import { settings } from "../src/config.js";
import { CapabilityScoreSchema, type ModelProfile, ModelProfileSchema, TaskNodeSchema } from "../src/models.js";
import * as routing from "../src/routing.js";
import { feedbackKey } from "../src/routing-feedback.js";

const SCORES = ["coding", "planning", "research", "chinese", "tool_use", "structured_output", "reliability"];
const ids = (models: ModelProfile[]) => new Set(models.map((model) => model.id));
const node = (fields: Record<string, unknown> = {}) =>
  TaskNodeSchema.parse({ id: "n", title: "t", instructions: "i", capability: "coding", ...fields });

/** test_call_runtime.model: every score the same. */
const uniform = (name: string, score: number, channel = "api", price = 1) => ModelProfileSchema.parse({
  id: name, provider: name.split(":")[0], display_name: name, channel, context_window: 200_000,
  input_per_million: price, output_per_million: price, scores: Object.fromEntries(SCORES.map((key) => [key, score])),
});

async function withSetting<T>(name: keyof typeof settings, value: unknown, work: () => T | Promise<T>): Promise<T> {
  const before = settings[name];
  (settings as any)[name] = value;
  try {
    return await work();
  } finally {
    (settings as any)[name] = before;
  }
}

test("the brief is written by the cheapest API model", async () => {
  const cheap = uniform("cheap:api", 80);
  const dear = uniform("dear:api", 95);
  cheap.input_per_million = 0.1;
  dear.input_per_million = 3.0;
  const cli = uniform("cli:claude", 96, "cli");
  assert.equal((await routing.briefWriter([dear, cheap, cli], new Set(["cheap:api", "dear:api", "cli:claude"])))!.id, "cheap:api");
  assert.equal((await routing.briefWriter([cli], new Set(["cli:claude"]))), null);
});

test("review quality is a gate before API preference and independence", async () => {
  const strong = uniform("cli:codex", 96, "cli", 0);
  const weak = uniform("api:cheap", 89);
  const models = [strong, weak];
  assert.equal((await routing.pickReviewer(models, ids(models), strong.id, 100))!.id, strong.id);
  assert.equal((await routing.pickReviewer(models, new Set([weak.id]), strong.id, 100)), null);
});

test("route feedback has a sample floor and penalizes rework", async () => await withSetting("api_agent", false, async () => {
  const cheap = uniform("x:cheap", 90, "api", 0.8);
  const reliable = uniform("x:reliable", 90, "api", 1);
  const step = node({ difficulty: "normal" });
  const stats = { samples: 7, successes: 0, cost_usd: 0.1, seconds: 0, timed: 0 };
  const feedback = new Map([[feedbackKey("x:cheap", "coding", "normal"), stats]]);
  await routing.routeNode(step, [cheap, reliable], ids([cheap, reliable]), false, { feedback });
  assert.equal(step.model_id, cheap.id);
  stats.samples = 8;
  await routing.routeNode(step, [cheap, reliable], ids([cheap, reliable]), false, { feedback });
  assert.equal(step.model_id, reliable.id);
}));

test("the estimate includes the planning cost", async () => {
  assert.equal(estimate([], 2, 0.25).base_usd, 0.25);
});

const priced = (id: string, priority: number, price: number, coding: number) => ModelProfileSchema.parse({
  id, provider: "x", display_name: id, context_window: 200_000, input_per_million: price, output_per_million: price,
  execution_priority: priority, scores: { coding, reliability: 90 },
});

test("difficulty decides between the cheapest and the strongest model", async () => {
  const models = [priced("cheap", 100, 0.1, 82), priced("strong", 100, 5, 97), priced("cli", 0, 0, 91)];
  const configured = ids(models);
  const routed = async (difficulty: string) => (await routing.routeNode(node({ difficulty,
    quality_threshold: ({ easy: 70, normal: 80, hard: 90 } as Record<string, number>)[difficulty] }), models, configured)).model_id;
  // Easy and normal: membership CLI first, then the cheapest that clears the threshold.
  assert.equal((await routed("easy")), "cli");
  assert.equal((await routed("normal")), "cli");
  const withoutCli = models.filter((model) => model.id !== "cli");
  assert.equal((await routing.routeNode(node({ quality_threshold: 80 }), withoutCli, configured)).model_id, "cheap");
  // Hard: the highest score wins even though it costs more than the free CLI.
  assert.equal((await routed("hard")), "strong");
});

test("a result is checked by a model no weaker than the one that made it", async () => {
  // A cheap model scoring high on reliability alone is not a fit judge of a generally stronger model's work.
  const api = (id: string, all: number, reliability: number, price: number) => ModelProfileSchema.parse({
    id, provider: id.split(":")[0], display_name: id, context_window: 1_000_000, input_per_million: price,
    output_per_million: price * 4, cached_input_per_million: price / 10,
    scores: { ...Object.fromEntries(SCORES.slice(0, 6).map((key) => [key, all])), reliability },
  });
  const models = [api("deepseek:flash", 92, 87.5, 0.15), api("minimax:m3", 88, 93.5, 0.3), api("glm:glm", 93, 92.4, 1.2),
    api("kimi:k3", 95, 89, 3.0)];
  const all = ids(models);
  // The cheapest one at least as capable as the model checked, not the most reliable.
  assert.equal((await routing.pickReviewer(models, all, "deepseek:flash", 1000))!.id, "glm:glm");
  // With no equally capable independent judge, use a fresh conversation with the producer.
  assert.equal((await routing.pickReviewer(models, all, "kimi:k3", 1000))!.id, "kimi:k3");
  assert.equal((await routing.pickReviewer(models, new Set(["deepseek:flash", "minimax:m3"]), "deepseek:flash", 1000))!.id, "deepseek:flash");
  assert.equal((await routing.pickReviewer(models, new Set(["minimax:m3"]), "deepseek:flash", 1000)), null);
});

test("reviews also go to API models first", async () => {
  // conftest.scored_models: the built-in catalog with uniform stand-in scores.
  const models = builtinModels().map((model) => (model.scores === null
    ? { ...model, scores: CapabilityScoreSchema.parse(Object.fromEntries(SCORES.map((key) => [key, 90]))) } : model));
  assert.equal((await routing.pickReviewer(models, new Set(["cli:claude", "openai:gpt-5.6-luna"]), "openai:gpt-6", 1000))!.id, "openai:gpt-5.6-luna");
  assert.equal((await routing.pickReviewer(models, new Set(["cli:claude"]), null, 1000))!.id, "cli:claude");
});

test("a hard step takes a cheaper model a point or two below the best", async () => {
  const api = (id: string, coding: number, price: number) => ModelProfileSchema.parse({ id, provider: id.split(":")[0],
    display_name: id, context_window: 1_000_000, input_per_million: price, output_per_million: price * 4,
    cached_input_per_million: price / 10, scores: { coding, planning: 90, reliability: 90 } });
  const hard = () => node({ title: "RTL", difficulty: "hard", quality_threshold: 90 });
  const flash = api("deepseek:flash", 92.3, 0.15);
  const glm = api("glm:glm", 93.9, 1.2);
  const kimi = api("kimi:k", 96.5, 3.0);
  const all = ids([flash, glm, kimi]);
  // 93.9 against 92.3: DeepSeek Flash, many times cheaper, is close enough.
  assert.equal((await routing.routeNode(hard(), [flash, glm], all)).model_id, "deepseek:flash");
  // A model far above the rest is still worth its price.
  assert.equal((await routing.routeNode(hard(), [flash, glm, kimi], all)).model_id, "kimi:k");
  await withSetting("hard_score_margin", 1.0, async () => assert.equal((await routing.routeNode(hard(), [flash, glm], all)).model_id, "glm:glm"));
});

test("a diagnosis prefers a membership CLI, then the best planner", async () => {
  const model = (id: string, planning: number, channel = "api") => ModelProfileSchema.parse({ id, provider: id.split(":")[0],
    display_name: id, channel, context_window: 1_000_000, input_per_million: 1, output_per_million: 1,
    execution_priority: channel === "cli" ? 0 : 100, scores: { coding: 90, planning, reliability: 90 } });
  const models = [model("x:api", 99), model("cli:claude", 90, "cli")];
  assert.equal(routing.pickDiagnoser(models, ids(models))!.id, "cli:claude");
  assert.equal(routing.pickDiagnoser(models, new Set(["x:api"]))!.id, "x:api");
  assert.equal(routing.pickDiagnoser(models, new Set()), null);
});

test("only strong models change FluidForm's source", async () => {
  // Regression: changes to FluidForm's source fell back to the weakest model that could act.
  const one = (id: string, channel: string, coding: number) => ModelProfileSchema.parse({ id, provider: id.split(":")[0],
    display_name: id, channel, context_window: 200000, input_per_million: 1, output_per_million: 1,
    scores: { coding, planning: coding, reliability: 90 } });
  const cli = one("cli:codex", "cli", 80);
  const strong = one("x:strong", "api", 92);
  const near = one("x:near", "api", 88);
  const weak = one("x:flash", "api", 70);
  const everything = [weak, near, strong, cli];
  assert.deepEqual(routing.engineers(everything, ids(everything)).map((model) => model.id), ["cli:codex", "x:strong", "x:near"]);
  // Without a CLI the strongest API models still may; a weak one never.
  assert.deepEqual(routing.engineers(everything, new Set(["x:flash", "x:strong"])).map((model) => model.id), ["x:strong"]);
  assert.deepEqual(routing.engineers([weak], new Set(["x:flash"])).map((model) => model.id), ["x:flash"]);
});

const flash = () => ModelProfileSchema.parse({ id: "deepseek:flash", provider: "deepseek", display_name: "flash",
  context_window: 1_000_000, input_per_million: 0.15, output_per_million: 0.6, cached_input_per_million: 0.003 });

test("an API step is estimated turn by turn with its cache", async () => {
  const api = flash();
  const cli = ModelProfileSchema.parse({ id: "cli:claude", provider: "anthropic", display_name: "cli", channel: "cli",
    context_window: 1_000_000, input_per_million: 0, output_per_million: 0 });
  const step = node({ id: "a", title: "A", difficulty: "normal", estimated_input_tokens: 4000, estimated_output_tokens: 800 });
  const oneCall = tokenCost(api, 4000, 800);
  const looped = await routing.nodeCost(step, api);
  // Fifteen turns of a growing, mostly cached conversation: far more than one call.
  assert.ok(looped > 5 * oneCall);
  let context = routing.LOOP_BASE_TOKENS + 4000;
  let expected = 0;
  for (let turn = 0; turn < 15; turn += 1) {
    expected += tokenCost(api, context, routing.LOOP_TURN_OUTPUT.medium, turn ? context - routing.LOOP_TURN_GROWTH : 0);
    context += routing.LOOP_TURN_GROWTH;
  }
  expected += tokenCost(api, context, 800, context - routing.LOOP_TURN_GROWTH);
  assert.equal(looped, expected);
  assert.equal((await routing.nodeCost(step, cli)), 0);
  // A hard step takes more turns and thinks harder.
  assert.ok((await routing.nodeCost({ ...step, difficulty: "hard" }, api)) > looped);
});

for (const [turns, actual] of [[10, 0.01382], [12, 0.01341], [10, 0.01099]]) {
  test(`an API step's estimate matches what measured runs cost (${turns} turns, $${actual})`, async () => {
    // DeepSeek Flash at its highest effort on small coding tasks (2026-10-21): 10-12 turns of the
    // tool loop cost $0.011-0.014. Given the turns, the estimate is within a quarter of that.
    const step = node({ id: "a", title: "A", difficulty: "hard", estimated_input_tokens: 1500, estimated_output_tokens: 800 });
    const original = routing.deps.loopTurns;
    routing.deps.loopTurns = () => turns;
    try {
      const ratio = (await routing.nodeCost(step, flash())) / actual;
      assert.ok(ratio >= 0.8 && ratio <= 1.25, String(ratio));
    } finally {
      routing.deps.loopTurns = original;
    }
  });
}
