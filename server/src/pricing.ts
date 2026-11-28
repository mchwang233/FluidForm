// What FluidForm asks the pricing capability (docs/design/chat-and-pricing-packages.md): every price,
// estimate, budget check and charge is a request to the service package providing "pricing"
// (packages/pricing, services.ts). FluidForm keeps the budget's state (what a task spent, what its
// calls hold) and the readings of this machine; the package decides from them.
//
// Without a pricing package nothing is priced: no estimates, nothing charged, no budget limit, and
// models are chosen by their scores alone. With one that does not answer, spending stops.
import { PricingUnavailable } from "./budget.js";
import type { CostEstimate, ExecutionRun, ModelProfile, TaskNode } from "./models.js";
import { log } from "./log.js";
import { CostEstimateSchema } from "./model-schemas.js";
import { hooks as modelHooks } from "./models.js";
import * as services from "./services.js";

type Json = Record<string, any>;

/** A model's terms as the package reads them. */
export type Terms = Pick<ModelProfile, "id"> & Partial<Pick<ModelProfile, "provider" | "channel" | "input_per_million"
  | "output_per_million" | "cached_input_per_million">>;
/** What each model would cost (by id), or null where it has no price. */
export type Costs = Record<string, number | null>;

export { PricingUnavailable };

export const deps = {
  // How a request reaches the package; the API sets it (services.ts), tests may answer in-process.
  ask: null as ((method: string, params: Json) => Promise<Json>) | null,
  enabled: () => services.available("pricing"),
};

/** Whether anything is priced. */
export function enabled(): boolean {
  return deps.enabled();
}
modelHooks.priced = enabled;

async function ask(method: string, params: Json): Promise<Json> {
  if (!deps.ask) throw new PricingUnavailable("计价能力还没有连上，停止花钱。");
  try {
    return await deps.ask(method, params);
  } catch (error) {
    throw new PricingUnavailable(`计价能力没有回答（${(error as Error)?.message ?? error}），停止花钱。`);
  }
}

const terms = (model: Terms) => ({ id: model.id, provider: model.provider ?? "", channel: model.channel ?? "api",
  input_per_million: model.input_per_million ?? null, output_per_million: model.output_per_million ?? null,
  cached_input_per_million: model.cached_input_per_million ?? null });

/** ``work`` where pricing only keeps count (an automation's chat): when it does not answer, nothing
 *  stops; ``otherwise`` stands in, so that one time is not counted. */
export async function countOnly<T>(work: () => Promise<T>, otherwise: T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof PricingUnavailable)) throw error;
    log.warning(`not counted: ${error.message}`);
    return otherwise;
  }
}

/** What a call cost; 0 without pricing, or for a model without a price. */
export async function charge(model: Terms | null | undefined, inputTokens: number, outputTokens: number, cachedTokens = 0): Promise<number> {
  if (!enabled() || !model) return 0;
  return Number((await ask("pricing.charge", { model: terms(model), input_tokens: inputTokens || 0, output_tokens: outputTokens || 0,
    cached_tokens: cachedTokens || 0 })).cost) || 0;
}

/** Whether the package charges ``model`` at all (it has a price). */
export function priced(model: Partial<Pick<ModelProfile, "input_per_million" | "output_per_million">> | null | undefined): boolean {
  return Boolean(model) && model!.input_per_million != null && model!.output_per_million != null;
}

/** What one attempt of ``node`` costs on each of ``models``: ``turns`` and ``turnOutput`` describe its
 *  tool loop, ``acts`` which models work through one. All null without pricing. */
export async function costs(node: Pick<TaskNode, "estimated_input_tokens" | "estimated_output_tokens">, models: Terms[],
  loop: { turns: number; turnOutput: number; acts: (model: Terms) => boolean }): Promise<Costs> {
  if (!enabled() || !models.length) return Object.fromEntries(models.map((model) => [model.id, null]));
  const given = { estimated_input_tokens: node.estimated_input_tokens, estimated_output_tokens: node.estimated_output_tokens,
    turns: loop.turns, turn_output: loop.turnOutput };
  const found = (await ask("pricing.costs", { node: given, models: models.map((model) => ({ ...terms(model), acts: loop.acts(model) })) })).costs ?? {};
  return Object.fromEntries(models.map((model) => [model.id, typeof found[model.id] === "number" ? found[model.id] : null]));
}

/** Each model's price per million input plus output tokens, to pick the cheapest; null without pricing. */
export async function rates(models: Terms[]): Promise<Costs> {
  if (!enabled() || !models.length) return Object.fromEntries(models.map((model) => [model.id, null]));
  const found = (await ask("pricing.rates", { models: models.map(terms) })).rates ?? {};
  return Object.fromEntries(models.map((model) => [model.id, typeof found[model.id] === "number" ? found[model.id] : null]));
}

/** A task's estimate from its steps' estimated costs; null without pricing. */
export async function estimate(nodes: Pick<TaskNode, "estimated_cost_usd">[], budget: number, planningCost = 0, extra = 0): Promise<CostEstimate | null> {
  if (!enabled()) return null;
  const answer = await ask("pricing.estimate", { step_costs: nodes.map((node) => node.estimated_cost_usd), budget, planning_cost: planningCost, extra });
  return CostEstimateSchema.parse(answer.estimate);
}

/** The task's estimate again, after its plan changed. */
export async function reestimate(run: ExecutionRun): Promise<void> {
  run.plan.estimate = await estimate(run.plan.nodes, run.budget_usd, run.plan.planning_cost_usd);
}

export type Admission = { output: number; reserve: number } | { wait: true } | { stop: "budget" | "step" | "busy"; message: string };

/** Whether a call of ``model`` sending ``inputBytes`` fits what is left (see packages/pricing). */
export async function admit(model: Terms | null | undefined, params: { input_bytes: number; maximum: number; remaining: number; others: number;
  step_remaining: number | null; step_held: number; wait_for_step: boolean }): Promise<Admission> {
  if (!enabled()) return { output: params.maximum, reserve: 0 };
  return (await ask("pricing.admit", { model: model ? terms(model) : null, ...params })) as Admission;
}

/** Whether ``cost`` more fits what is left besides what others hold. */
export async function fits(params: { cost: number; remaining: number; others: number; step_remaining: number | null }): Promise<boolean> {
  if (!enabled()) return true;
  return Boolean((await ask("pricing.fits", params)).ok);
}

/** Whether the task may go on: ``{ok}``, or ``{stop: "step", message}`` past a step's declared limit. */
export async function allows(params: { remaining: number; step_remaining: number | null }): Promise<{ ok?: boolean; stop?: string; message?: string }> {
  if (!enabled()) return { ok: true };
  return ask("pricing.allows", params);
}

/** A membership CLI's terms by its plan (see cliPrice in packages/pricing). */
export async function cliPrice(params: { monthly_usd: number; longest_minutes: number | null; tokens: number; used_since: number;
  saved: number | null; set: [number, number] | null; api: Terms[] }): Promise<{ price: number | null; per_window: number | null; capped: boolean;
  input: number | null; output: number | null; cached: number | null }> {
  return ask("pricing.cli_price", { ...params, api: params.api.map(terms) }) as any;
}

/** Each run's estimate as past tasks suggest it will go (null without enough history), each judged
 *  without itself; nulls without pricing. */
export async function calibrated(reviews: Json[], runs: ExecutionRun[]): Promise<(number | null)[]> {
  if (!enabled() || !runs.length) return runs.map(() => null);
  const given = runs.map((run) => ({ id: run.id, steps: run.plan.nodes.map((node) => [node.model_id, node.estimated_cost_usd]),
    base_usd: run.plan.estimate?.base_usd ?? null }));
  return (await ask("pricing.calibrated_each", { reviews, runs: given })).calibrated;
}
