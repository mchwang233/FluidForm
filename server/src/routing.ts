// Which model does what: a step's model by capability, threshold, difficulty and
// cost; retries, reviewers, diagnosers, engineers; and the task's estimate.
import { tokenCost } from "./budget.js";
import { settings } from "./config.js";
import { available as imageModels } from "./images.js";
import {
  CostEstimateSchema, DIFFICULTY_THRESHOLDS, type CostEstimate, type ModelProfile, overall, type PlanPart, routingReady,
  scoreFor, type TaskNode, TaskNodeSchema, type ExecutionRun,
} from "./models.js";
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

/** What one attempt of ``node`` on ``model`` should cost: one call, or for an API model that works
 *  through tools, every turn of its loop. */
export function nodeCost(node: TaskNode, model: ModelProfile): number {
  if (model.input_per_million === null || model.output_per_million === null) {
    throw new NoEligibleModelError(`Pricing is not available for ${model.id}`);
  }
  if (model.channel === "cli" || !canAct(model)) return tokenCost(model, node.estimated_input_tokens, node.estimated_output_tokens);
  const output = LOOP_TURN_OUTPUT[settings.reasoning_by_difficulty[node.difficulty] || ""] ?? 800;
  let context = LOOP_BASE_TOKENS + node.estimated_input_tokens;
  let cost = 0;
  for (let turn = 0; turn < deps.loopTurns(node); turn += 1) {
    cost += tokenCost(model, context, output, turn ? context - LOOP_TURN_GROWTH : 0);
    context += LOOP_TURN_GROWTH;
  }
  // The final answer, a summary of the work.
  return cost + tokenCost(model, context, node.estimated_output_tokens, context - LOOP_TURN_GROWTH);
}

export function eligibleForNode(node: TaskNode, models: ModelProfile[], configured: Set<string>, needsVision = false): ModelProfile[] {
  const pictures = Boolean(node.needs_images && imageModels().length);
  return models.filter((model) => model.enabled
    && routingReady(model)
    && configured.has(model.id)
    && !settings.helper_only_models.includes(model.id)
    && model.context_window! >= node.estimated_input_tokens + node.estimated_output_tokens
    // Work on the project's files needs a CLI agent, or an API model working through tools.
    && (!node.needs_workspace || canAct(model))
    // Attached images reach API models only as image inputs; CLIs open the files themselves.
    && (!needsVision || model.channel === "cli" || model.supports_vision !== false)
    // Pictures are made with the GenerateImage tool, which only API models are given.
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

export function routeNode(node: TaskNode, models: ModelProfile[], configured: Set<string>, needsVision = false,
  { feedback = null }: { feedback?: Feedback | null } = {}): TaskNode {
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
  const selected = minBy(pool, (model) => [model.execution_priority, expectedCost(node, model, nodeCost(node, model), feedback),
    -score(model, node.capability), -model.scores!.reliability]);
  node.model_id = selected.id;
  node.estimated_cost_usd = pyRound(nodeCost(node, selected), 6);
  const label = CAPABILITY_LABELS[node.capability] ?? node.capability;
  const fit = `${label} ${formatG(score(selected, node.capability))} ≥ 门槛 ${formatG(node.quality_threshold)}`;
  const rule = node.difficulty === "hard" ? `在比最高分低不超过 ${formatG(settings.hard_score_margin)} 分的模型中选最便宜的` : "选最便宜的";
  if (cliNeeded) {
    const api = available.filter((model) => model.channel !== "cli");
    const bestApi = api.length ? Math.max(...api.map((model) => score(model, node.capability))) : null;
    const why = bestApi === null ? "没有可用的 API 模型能做这一步" : `API 模型最高只有 ${label} ${formatG(bestApi)}，达不到门槛`;
    node.routing_note = `${why}，改用会员 CLI（${rule}）。${fit}。`;
  } else if (settings.subtasks_prefer_api && selected.channel !== "cli") {
    node.routing_note = `子任务优先用 API 模型，在达标的 API 模型中${rule}。${fit}。`;
  } else {
    const order = node.difficulty !== "hard" ? "优先会员 CLI，其次最便宜" : "选分最高的";
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
export function spreadTo(node: TaskNode, models: ModelProfile[], configured: Set<string>, busy: Set<string>,
  needsVision = false): ModelProfile | null {
  const current = models.find((model) => model.id === node.model_id);
  if (!current) return null;
  const ceiling = nodeCost(node, current) * settings.spread_cost_factor;
  const pool = eligibleForNode(node, models, configured, needsVision).filter((model) => model.channel !== "cli"
    && !busy.has(model.provider) && score(model, node.capability) >= node.quality_threshold
    && nodeCost(node, model) <= ceiling + 1e-12);
  if (!pool.length) return null;
  if (node.difficulty === "hard") {
    return minBy(pool, (model) => [-score(model, node.capability), -model.scores!.reliability, nodeCost(node, model)]);
  }
  return minBy(pool, (model) => [nodeCost(node, model), -score(model, node.capability)]);
}

/** The models scoring within settings.hard_score_margin of the best for the node's capability. */
export function closeToBest(pool: ModelProfile[], node: TaskNode): ModelProfile[] {
  const best = pool.length ? Math.max(...pool.map((model) => score(model, node.capability))) : 0;
  return pool.filter((model) => score(model, node.capability) >= best - settings.hard_score_margin);
}

/** The best model for a retry: highest score for the capability, cost only breaking ties. Under
 *  the API-first policy a CLI is used only if no API model clears the threshold. */
export function strongestFor(node: TaskNode, models: ModelProfile[], configured: Set<string>, needsVision = false): ModelProfile | null {
  const available = eligibleForNode(node, models, configured, needsVision);
  if (!available.length) return null;
  const meeting = available.filter((model) => score(model, node.capability) >= node.quality_threshold);
  const [pool] = meeting.length ? preferApi(meeting) : [available];
  return minBy(pool, (model) => [-score(model, node.capability), -model.scores!.reliability, model.execution_priority, nodeCost(node, model)]);
}

/** The best other model for a node its current model (and any in ``exclude``) keeps failing at.
 *  The API-first policy does not apply: a membership CLI is often the way out. */
export function strongerThan(node: TaskNode, models: ModelProfile[], configured: Set<string>, current: string | null,
  needsVision = false, exclude: ReadonlySet<string> = new Set()): ModelProfile | null {
  const available = eligibleForNode(node, models, configured, needsVision).filter((model) => model.id !== current && !exclude.has(model.id));
  if (!available.length) return null;
  return minBy(available, (model) => [score(model, node.capability) < node.quality_threshold, -score(model, node.capability),
    -model.scores!.reliability, model.channel !== "cli", nodeCost(node, model)]);
}

/** Ability is a gate. Prefer an independent eligible judge, otherwise use a fresh conversation
 *  with the producer. An unavailable capable judge leaves work unverified. */
export function pickReviewer(models: ModelProfile[], configured: Set<string>, exclude: string | null, tokens: number): ModelProfile | null {
  let available = models.filter((model) => model.enabled && routingReady(model) && configured.has(model.id) && model.context_window! >= tokens);
  if (!available.length) return null;
  const checked = models.find((model) => model.id === exclude);
  const floor = checked ? overall(checked.scores!) : 0;
  available = available.filter((model) => overall(model.scores!) >= floor);
  if (!available.length) return null;
  return minBy(available, (model) => [model.id === exclude,
    settings.subtasks_prefer_api ? model.channel === "cli" : model.execution_priority,
    model.input_per_million! + model.output_per_million!, -model.scores!.reliability]);
}

/** Who writes the project brief: the cheapest API model with a large enough context, the most
 *  reliable among equally cheap ones. Plain summaries need no strong model. */
export function briefWriter(models: ModelProfile[], configured: Set<string>): ModelProfile | null {
  const available = models.filter((model) => model.enabled && routingReady(model) && configured.has(model.id) && model.channel !== "cli"
    && model.provider !== "mock" && (model.context_window || 0) >= BRIEF_CONTEXT
    && model.input_per_million !== null && model.output_per_million !== null);
  return available.length ? minBy(available, (model) => [model.input_per_million! + model.output_per_million!, -model.scores!.reliability]) : null;
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
export function fitAndRoute(node: TaskNode, models: ModelProfile[], configured: Set<string>, needsVision = false): string | null {
  let note: string | null = null;
  const available = eligibleForNode(node, models, configured, needsVision);
  if (available.length) {
    const best = Math.max(...available.map((model) => score(model, node.capability)));
    if (node.quality_threshold > best) {
      note = `Adjusted ${node.title} ${node.capability} threshold from ${formatG(node.quality_threshold)} to ${formatG(best)} for available models`;
      node.quality_threshold = best;
    }
  }
  routeNode(node, models, configured, needsVision);
  return note;
}

/** The task's estimate again, after its plan changed. */
export function reestimate(run: ExecutionRun): void {
  const plan = run.plan;
  plan.estimate = estimate(plan.nodes, run.budget_usd, plan.planning_cost_usd);
}

export function estimate(nodes: TaskNode[], budget: number, planningCost = 0, extra = 0): CostEstimate {
  const base = planningCost + extra + nodes.reduce((sum, node) => sum + node.estimated_cost_usd, 0);
  const retry = base * 0.25;
  const tools = Math.max(0.01, base * 0.1);
  return CostEstimateSchema.parse({ base_usd: pyRound(base, 6), retry_reserve_usd: pyRound(retry, 6),
    tool_reserve_usd: pyRound(tools, 6), low_usd: pyRound(base + tools, 6), high_usd: pyRound(base + retry + tools, 6),
    hard_limit_usd: pyRound(budget, 2) });
}
