// Which model does what: a step's model by capability, threshold, difficulty and
// cost; retries, reviewers, diagnosers, engineers; and the task's estimate.
import { settings } from "./config.js";
import { imageServers } from "./mcp.js";
import {
  CostEstimateSchema, DIFFICULTY_THRESHOLDS, type CostEstimate, type ModelProfile, overall, type PlanPart, routingReady,
  scoreFor, type TaskNode, TaskNodeSchema, type ExecutionRun,
} from "./models.js";
import * as pricing from "./pricing.js";
import { EXPECTED_TURNS, expectedTurns } from "./progress.js";
import { formatG, maxBy, minBy, pyRound, sortedBy } from "./py.js";
import { expectedCost, type Feedback, note as feedbackNote } from "./routing-feedback.js";

// Context the project brief's writer needs for a batch of whole files (briefing.BATCH_CHARS).
export const BRIEF_CONTEXT = 64_000;

export class NoEligibleModelError extends Error {
  override name = "NoEligibleModelError";
}

// How an API model's tool loop costs grow, turn by turn: its prompt, instructions and tool
// definitions; what each turn adds to the conversation (tool output and the model's own message);
// and what it writes each turn, by reasoning effort. Each turn resends the conversation, all but
// the newest part of it read from the provider's prompt cache. Fitted to measured runs (DeepSeek
// Flash at max effort, 2026-10-21: about 1,500 tokens written and 1,300 added per turn).
export const LOOP_BASE_TOKENS = 3_000;
export const LOOP_TURN_GROWTH = 1_300;
export const LOOP_TURN_OUTPUT: Record<string, number> = { none: 250, minimal: 250, low: 400, medium: 750, high: 1_100, max: 1_500 };

const score = (model: ModelProfile, capability: string) => scoreFor(model.scores!, capability);

/** The tool turns a step is expected to take. */
export function loopTurns(node: TaskNode): number {
  return expectedTurns(node) || (EXPECTED_TURNS[node.difficulty] ?? EXPECTED_TURNS.normal);
}

// What tests replace.
export const deps = { loopTurns };

/** What one attempt of ``node`` costs on each of ``models`` (the pricing package decides): one call,
 *  or for an API model that works through tools, every turn of its loop. Nulls without pricing. */
export function costsFor(node: TaskNode, models: ModelProfile[]): Promise<pricing.Costs> {
  const turnOutput = LOOP_TURN_OUTPUT[settings.reasoning_by_difficulty[node.difficulty] || ""] ?? 800;
  return pricing.costs(node, models, { turns: deps.loopTurns(node), turnOutput, acts: (model) => canAct(model as ModelProfile) });
}

/** What one attempt of ``node`` on ``model`` should cost; 0 without pricing. */
export async function nodeCost(node: TaskNode, model: ModelProfile): Promise<number> {
  return (await costsFor(node, [model]))[model.id] ?? 0;
}

const costOf = (costs: pricing.Costs, model: ModelProfile) => costs[model.id] ?? 0;

export function eligibleForNode(node: TaskNode, models: ModelProfile[], configured: Set<string>, needsVision = false): ModelProfile[] {
  const pictures = Boolean(node.needs_images && imageServers().length);
  return models.filter((model) => model.enabled
    && routingReady(model)
    && configured.has(model.id)
    && !settings.helper_only_models.includes(model.id)
    && model.context_window! >= node.estimated_input_tokens + node.estimated_output_tokens
    // Work on the project's files needs a CLI agent, or an API model working through tools.
    && (!node.needs_workspace || canAct(model))
    // Attached images reach API models only as image inputs; CLIs open the files themselves.
    && (!needsVision || model.channel === "cli" || model.supports_vision !== false)
    // Pictures are made with an MCP server's image tool, which only API models are given.
    && (!node.needs_images || model.channel !== "cli" || !pictures));
}

/** Whether the model can edit files and run commands itself. */
export function canAct(model: ModelProfile): boolean {
  return model.channel === "cli" || (settings.api_agent && model.provider !== "mock" && model.supports_tools !== false);
}

export const CAPABILITY_LABELS: Record<string, string> = {
  coding: "代码", planning: "规划", research: "调研", chinese: "中文",
  tool_use: "工具使用", structured_output: "结构化输出", reliability: "可靠性",
};

/** Keep only API models when any qualify and the API-first policy is on; the flag says whether a
 *  CLI had to be used because no API model qualified. */
export function preferApi(candidates: ModelProfile[]): [ModelProfile[], boolean] {
  if (!settings.subtasks_prefer_api) return [candidates, false];
  const api = candidates.filter((model) => model.channel !== "cli");
  return api.length ? [api, false] : [candidates, candidates.some((model) => model.channel === "cli")];
}

export async function routeNode(node: TaskNode, models: ModelProfile[], configured: Set<string>, needsVision = false,
  { feedback = null }: { feedback?: Feedback | null } = {}): Promise<TaskNode> {
  const available = eligibleForNode(node, models, configured, needsVision);
  const eligible = available.filter((model) => score(model, node.capability) >= node.quality_threshold);
  if (!eligible.length) {
    if (!available.length && node.needs_workspace) {
      throw new NoEligibleModelError(`${node.title} must work inside the project directory, which requires an `
        + "enabled membership CLI or an API model that supports tool calls.");
    }
    if (!available.length) {
      throw new NoEligibleModelError("No enabled and configured model can run this node. Enable a membership CLI, "
        + "configure an API key, or enable the Local Demo Model.");
    }
    const best = maxBy(available, (model) => score(model, node.capability));
    throw new NoEligibleModelError(`No configured model meets ${node.capability} >= ${formatPython(node.quality_threshold)}; `
      + `best available is ${best.id} at ${formatPython(score(best, node.capability))}`);
  }
  let [pool, cliNeeded] = preferApi(eligible);
  // Hard tasks take the strongest model for the capability, or a cheaper one scoring within
  // hard_score_margin of it; easy and normal tasks the cheapest that clears the threshold. Cost
  // (with what was observed) breaks the rest either way.
  if (node.difficulty === "hard") pool = closeToBest(pool, node);
  const costs = await costsFor(node, pool);
  const selected = minBy(pool, (model) => [model.execution_priority, expectedCost(node, model, costOf(costs, model), feedback),
    -score(model, node.capability), -model.scores!.reliability]);
  node.model_id = selected.id;
  node.estimated_cost_usd = pyRound(costOf(costs, selected), 6);
  const label = CAPABILITY_LABELS[node.capability] ?? node.capability;
  const fit = `${label} ${formatG(score(selected, node.capability))} ≥ 门槛 ${formatG(node.quality_threshold)}`;
  // Without pricing nothing is cheaper: the scores alone choose.
  const cheapest = pricing.enabled() ? "选最便宜的" : "选分最高的";
  const rule = node.difficulty === "hard" ? `在比最高分低不超过 ${formatG(settings.hard_score_margin)} 分的模型中${cheapest}` : cheapest;
  if (cliNeeded) {
    const api = available.filter((model) => model.channel !== "cli");
    const bestApi = api.length ? Math.max(...api.map((model) => score(model, node.capability))) : null;
    const why = bestApi === null ? "没有可用的 API 模型能做这一步" : `API 模型最高只有 ${label} ${formatG(bestApi)}，达不到门槛`;
    node.routing_note = `${why}，改用会员 CLI（${rule}）。${fit}。`;
  } else if (settings.subtasks_prefer_api && selected.channel !== "cli") {
    node.routing_note = `子任务优先用 API 模型，在达标的 API 模型中${rule}。${fit}。`;
  } else {
    const order = node.difficulty !== "hard" ? (pricing.enabled() ? "优先会员 CLI，其次最便宜" : "优先会员 CLI，其次分最高") : "选分最高的";
    node.routing_note = `在达到门槛的模型中${order}。${fit}。`;
  }
  node.routing_note += feedbackNote(node, selected, feedback);
  return node;
}

/** str(float) in an error message: 80.0 for 80, as Python prints a float. */
function formatPython(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

/** Another model for ``node`` while the providers in ``busy`` carry enough of the task's running
 *  steps: one of another API provider that clears the node's threshold, chosen as routeNode would
 *  choose, for at most settings.spread_cost_factor times the cost of the node's own model. null
 *  when there is no such model: the node then stays where it is. */
export async function spreadTo(node: TaskNode, models: ModelProfile[], configured: Set<string>, busy: Set<string>,
  needsVision = false): Promise<ModelProfile | null> {
  const current = models.find((model) => model.id === node.model_id);
  // Without pricing there is no cost to stay within.
  if (!current || !pricing.enabled()) return null;
  const candidates = eligibleForNode(node, models, configured, needsVision).filter((model) => model.channel !== "cli"
    && !busy.has(model.provider) && score(model, node.capability) >= node.quality_threshold);
  const costs = await costsFor(node, [current, ...candidates]);
  const ceiling = costOf(costs, current) * settings.spread_cost_factor;
  const pool = candidates.filter((model) => costOf(costs, model) <= ceiling + 1e-12);
  if (!pool.length) return null;
  if (node.difficulty === "hard") {
    return minBy(pool, (model) => [-score(model, node.capability), -model.scores!.reliability, costOf(costs, model)]);
  }
  return minBy(pool, (model) => [costOf(costs, model), -score(model, node.capability)]);
}

/** The models scoring within settings.hard_score_margin of the best for the node's capability. */
export function closeToBest(pool: ModelProfile[], node: TaskNode): ModelProfile[] {
  const best = pool.length ? Math.max(...pool.map((model) => score(model, node.capability))) : 0;
  return pool.filter((model) => score(model, node.capability) >= best - settings.hard_score_margin);
}

/** The best model for a retry: highest score for the capability, cost only breaking ties. Under
 *  the API-first policy a CLI is used only if no API model clears the threshold. */
export async function strongestFor(node: TaskNode, models: ModelProfile[], configured: Set<string>, needsVision = false): Promise<ModelProfile | null> {
  const available = eligibleForNode(node, models, configured, needsVision);
  if (!available.length) return null;
  const meeting = available.filter((model) => score(model, node.capability) >= node.quality_threshold);
  const [pool] = meeting.length ? preferApi(meeting) : [available];
  const costs = await costsFor(node, pool);
  return minBy(pool, (model) => [-score(model, node.capability), -model.scores!.reliability, model.execution_priority, costOf(costs, model)]);
}

/** The best other model for a node its current model (and any in ``exclude``) keeps failing at.
 *  The API-first policy does not apply: a membership CLI is often the way out. */
export async function strongerThan(node: TaskNode, models: ModelProfile[], configured: Set<string>, current: string | null,
  needsVision = false, exclude: ReadonlySet<string> = new Set()): Promise<ModelProfile | null> {
  const available = eligibleForNode(node, models, configured, needsVision).filter((model) => model.id !== current && !exclude.has(model.id));
  if (!available.length) return null;
  const costs = await costsFor(node, available);
  return minBy(available, (model) => [score(model, node.capability) < node.quality_threshold, -score(model, node.capability),
    -model.scores!.reliability, model.channel !== "cli", costOf(costs, model)]);
}

/** Ability is a gate. Prefer an independent eligible judge, otherwise use a fresh conversation
 *  with the producer. An unavailable capable judge leaves work unverified. */
export async function pickReviewer(models: ModelProfile[], configured: Set<string>, exclude: string | null, tokens: number): Promise<ModelProfile | null> {
  let available = models.filter((model) => model.enabled && routingReady(model) && configured.has(model.id) && model.context_window! >= tokens);
  if (!available.length) return null;
  const checked = models.find((model) => model.id === exclude);
  const floor = checked ? overall(checked.scores!) : 0;
  available = available.filter((model) => overall(model.scores!) >= floor);
  if (!available.length) return null;
  const rates = await pricing.rates(available);
  return minBy(available, (model) => [model.id === exclude,
    settings.subtasks_prefer_api ? model.channel === "cli" : model.execution_priority,
    rates[model.id] ?? 0, -model.scores!.reliability]);
}

/** Who writes the project brief: the cheapest API model with a large enough context, the most
 *  reliable among equally cheap ones. Plain summaries need no strong model. */
export async function briefWriter(models: ModelProfile[], configured: Set<string>): Promise<ModelProfile | null> {
  const available = models.filter((model) => model.enabled && routingReady(model) && configured.has(model.id) && model.channel !== "cli"
    && model.provider !== "mock" && (model.context_window || 0) >= BRIEF_CONTEXT);
  if (!available.length) return null;
  const rates = await pricing.rates(available);
  return minBy(available, (model) => [rates[model.id] ?? 0, -model.scores!.reliability]);
}

/** Strong models to diagnose a stuck task, best first: membership CLIs (they can look at the files
 *  and cost nothing extra), then the best planners, then the most reliable. */
export function diagnosers(models: ModelProfile[], configured: Set<string>): ModelProfile[] {
  const available = models.filter((model) => model.enabled && routingReady(model) && configured.has(model.id) && model.provider !== "mock");
  return sortedBy(available, (model) => [model.channel !== "cli", -model.scores!.planning, -model.scores!.reliability]);
}

// How far below the strongest a model's coding score may be to change FluidForm's own source.
export const ENGINEER_SCORE_MARGIN = 5.0;

/** Models that may change FluidForm's own source, best first: every membership CLI, then API
 *  models that can act and code within ENGINEER_SCORE_MARGIN of the strongest that can. */
export function engineers(models: ModelProfile[], configured: Set<string>): ModelProfile[] {
  const acting = diagnosers(models, configured).filter(canAct);
  if (!acting.length) return [];
  const best = Math.max(...acting.map((model) => score(model, "coding")));
  return acting.filter((model) => model.channel === "cli" || score(model, "coding") >= best - ENGINEER_SCORE_MARGIN);
}

export function pickDiagnoser(models: ModelProfile[], configured: Set<string>): ModelProfile | null {
  return diagnosers(models, configured)[0] ?? null;
}

/** Route ``node``, first lowering its quality threshold to the best available score when no
 *  available model reaches it. A note saying so, or null. */
export async function fitAndRoute(node: TaskNode, models: ModelProfile[], configured: Set<string>, needsVision = false): Promise<string | null> {
  let note: string | null = null;
  const available = eligibleForNode(node, models, configured, needsVision);
  if (available.length) {
    const best = Math.max(...available.map((model) => score(model, node.capability)));
    if (node.quality_threshold > best) {
      note = `Adjusted ${node.title} ${node.capability} threshold from ${formatG(node.quality_threshold)} to ${formatG(best)} for available models`;
      node.quality_threshold = best;
    }
  }
  await routeNode(node, models, configured, needsVision);
  return note;
}

