// FluidForm's pricing (docs/design/chat-and-pricing-packages.md): what a model call costs, what a
// step and a task should cost, whether a call fits what is left of the budget, what a membership
// CLI's tokens cost by its plan, and how far past tasks went over their estimates. Plain functions
// of what FluidForm sends; service.mjs answers FluidForm's requests with them. FluidForm keeps the
// budget's state (what was spent, what other calls hold) and reads this machine; this decides.

export const EPSILON = 0.0000005;
// A step's tool loop: the context it starts with, how much each turn adds, and its last answer.
export const LOOP_BASE_TOKENS = 3_000;
export const LOOP_TURN_GROWTH = 1_300;
// Of a plan's base cost: what is set aside for retries, and for tools.
export const RETRY_SHARE = 0.25;
export const TOOL_SHARE = 0.1;
export const MIN_TOOL_RESERVE = 0.01;
// A membership's cached input, weighted against the plan's quota.
export const CACHED_WEIGHT = 0.1;
export const WEEKS_PER_MONTH = 52 / 12;
export const MIN_CALIBRATION_PERCENT = 2.0;
// A model's overrun counts once this many of its steps have run.
export const CALIBRATION_STEPS = 3;

/** round(value, digits) as Python rounds: exact ties to even. */
export function pyRound(value, digits = 0) {
  if (!Number.isFinite(value)) return value;
  const exact = Math.abs(value).toFixed(Math.min(100, digits + 60));
  const point = exact.indexOf(".");
  const rest = exact.slice(point + 1 + digits);
  if (/^50*$/.test(rest)) {
    const kept = exact.slice(0, point + 1 + digits).replace(/\.$/, "");
    const last = Number(kept[kept.length - 1]);
    const down = Number(kept);
    const step = 10 ** -digits;
    const result = last % 2 === 0 ? down : Number((down + step).toFixed(Math.max(digits, 0)));
    return value < 0 ? -result : result;
  }
  return Number(value.toFixed(digits));
}

const priced = (model) => Boolean(model) && model.input_per_million != null && model.output_per_million != null;

/** What a call cost: uncached input at the input price, input read from the provider's cache at its
 *  cache price (the input price when there is none), and output. A model without a price costs 0. */
export function tokenCost(model, inputTokens, outputTokens, cachedTokens = 0) {
  if (!priced(model)) return 0;
  const cached = Math.min(Math.max(cachedTokens || 0, 0), inputTokens);
  const cachedPrice = model.cached_input_per_million ?? model.input_per_million;
  return ((inputTokens - cached) * model.input_per_million + cached * cachedPrice
    + outputTokens * model.output_per_million) / 1_000_000;
}

/** What one attempt of ``node`` on ``model`` should cost, or null without a price: one call, or for
 *  a model that works through tools (``model.acts``), every turn of its loop. ``node.turns`` and
 *  ``node.turn_output`` are the turns expected and each turn's output. */
export function nodeCost(node, model) {
  if (!priced(model)) return null;
  if (model.channel === "cli" || !model.acts) return tokenCost(model, node.estimated_input_tokens, node.estimated_output_tokens);
  let context = LOOP_BASE_TOKENS + node.estimated_input_tokens;
  let cost = 0;
  for (let turn = 0; turn < node.turns; turn += 1) {
    cost += tokenCost(model, context, node.turn_output, turn ? context - LOOP_TURN_GROWTH : 0);
    context += LOOP_TURN_GROWTH;
  }
  // The final answer, a summary of the work.
  return cost + tokenCost(model, context, node.estimated_output_tokens, context - LOOP_TURN_GROWTH);
}

/** A model's price per million input plus output tokens, or null: to pick the cheapest. */
export function rate(model) {
  return priced(model) ? model.input_per_million + model.output_per_million : null;
}

/** A task's estimate from its steps' estimated costs, planning and anything else already spent. */
export function estimate(stepCosts, budget, planningCost = 0, extra = 0) {
  const base = planningCost + extra + stepCosts.reduce((sum, cost) => sum + cost, 0);
  const retry = base * RETRY_SHARE;
  const tools = Math.max(MIN_TOOL_RESERVE, base * TOOL_SHARE);
  return { base_usd: pyRound(base, 6), retry_reserve_usd: pyRound(retry, 6), tool_reserve_usd: pyRound(tools, 6),
    low_usd: pyRound(base + tools, 6), high_usd: pyRound(base + retry + tools, 6), hard_limit_usd: pyRound(budget, 2) };
}

/** Whether a call of ``model`` sending ``input_bytes`` may go, and with how many output tokens (at
 *  most ``maximum``). ``remaining`` is what the task has left, ``others`` what its other calls hold;
 *  for a step with a declared cost limit, ``step_remaining`` and ``step_held`` (what the step's other
 *  calls hold). The answer: ``{output, reserve}``; ``{wait: true}`` while other calls may release
 *  enough; or ``{stop, message}`` (``budget``, ``step``, ``busy``). */
export function admit({ model, input_bytes, maximum = 4096, remaining, others = 0, step_remaining = null, step_held = 0, wait_for_step = true }) {
  if (!priced(model)) return { stop: "budget", message: `缺少 ${model?.id ?? "这个模型"} 的价格，无法核验请求预算。` };
  // UTF-8 bytes plus protocol overhead conservatively bound textual input tokens; inline images are
  // included rather than budgeted as free.
  const inputCost = (input_bytes + 256) * model.input_per_million / 1_000_000;
  const outputPrice = model.output_per_million / 1_000_000;
  let available = remaining - others;
  if (step_remaining !== null && step_remaining !== undefined) {
    if (step_remaining < inputCost + outputPrice) return { stop: "step", message: "声明的步骤费用不足以发起下一轮请求，停止工作包并保留诊断。" };
    if (step_held && !wait_for_step && Math.min(available, step_remaining - step_held) < inputCost + outputPrice) {
      return { stop: "busy", message: "本步骤的请求仍占用预算，跳过本次付费进度检查。" };
    }
    available = Math.min(available, step_remaining - step_held);
  }
  const output = outputPrice ? Math.min(maximum, Math.floor((available - inputCost) / outputPrice)) : maximum;
  if (inputCost <= available && output >= 1) return { output, reserve: inputCost + output * outputPrice };
  // Another call may release unused output reservations: wait, this is contention, not a request to
  // raise the budget.
  if (others && remaining >= inputCost + outputPrice) return { wait: true };
  return { stop: "budget", message: "剩余预算不足以发起下一轮模型请求，任务已暂停。" };
}

/** Whether ``cost`` more (a picture, say) fits what is left besides what others hold. */
export function fits({ cost, remaining, others = 0, step_remaining = null }) {
  if (step_remaining !== null && step_remaining !== undefined && step_remaining < cost) return false;
  return remaining - others >= cost;
}

/** Whether the task (and the step, under a declared cost limit) may go on; equality permits a last
 *  answer. ``{ok}``, or ``{stop: "step", message}`` past the step's limit. */
export function allows({ remaining, step_remaining = null }) {
  if (step_remaining !== null && step_remaining !== undefined && step_remaining < -EPSILON) {
    return { stop: "step", message: "达到声明费用上限，停止工作包，禁止自动续跑。" };
  }
  return { ok: remaining >= -EPSILON };
}

/** A membership CLI's price by its plan. ``monthly_usd`` is the plan's fee; ``longest_minutes`` its
 *  longest quota window; ``tokens`` the weighted tokens spent while ``used_since`` percent of that
 *  window went; ``saved`` the tokens a full window held when last measured; ``set`` the plan's own
 *  [input, output] until it calibrates; ``api`` the prices of the provider's API models (a
 *  subscription is never dearer than paying the API). The answer: ``price`` per million (null until
 *  it can be measured), ``per_window``, ``capped`` (the measured price was dearer than the API), and
 *  ``input``/``output``/``cached`` per million to charge (null to keep the catalog's). */
export function cliPrice({ monthly_usd, longest_minutes = null, tokens = 0, used_since = 0, saved = null, set = null, api = [] }) {
  let perWindow = saved;
  if (longest_minutes && used_since >= MIN_CALIBRATION_PERCENT && tokens > 0) perWindow = tokens / (used_since / 100);
  let price = null;
  if (perWindow && longest_minutes) {
    const windowUsd = (monthly_usd / WEEKS_PER_MONTH) * (longest_minutes / (7 * 24 * 60));
    price = (windowUsd / perWindow) * 1_000_000;
  }
  const charged = api.filter((model) => model.input_per_million && model.output_per_million);
  const ceiling = charged.length ? [Math.max(...charged.map((model) => model.input_per_million)), Math.max(...charged.map((model) => model.output_per_million)),
    Math.max(...charged.map((model) => model.cached_input_per_million || model.input_per_million * CACHED_WEIGHT))] : null;
  const capped = price !== null && ceiling !== null && price > ceiling[0];
  let terms = [null, null, null];
  if (price !== null) {
    terms = ceiling ? [pyRound(Math.min(price, ceiling[0]), 6), pyRound(Math.min(price, ceiling[1]), 6), pyRound(Math.min(price * CACHED_WEIGHT, ceiling[2]), 6)]
      : [pyRound(price, 6), pyRound(price, 6), pyRound(price * CACHED_WEIGHT, 6)];
  } else if (set) terms = [set[0], set[1], set[0] * CACHED_WEIGHT];
  return { price, per_window: perWindow, capped, input: terms[0], output: terms[1], cached: terms[2] };
}

/** How far past tasks went beyond their estimates: per model, the real cost of its steps over their
 *  estimate (``models``, with ``overall`` for models seen too rarely), and the whole task's cost over
 *  its steps' (``overhead``). Steps that never ran say nothing; nor does the task ``exclude``. */
export function calibration(reviews, exclude = null) {
  const estimated = new Map();
  const spent = new Map();
  const counted = new Map();
  let inSteps = 0;
  let inTotal = 0;
  for (const item of reviews) {
    if (item.run_id === exclude) continue;
    const steps = item.steps || [];
    for (const step of steps.filter((entry) => entry.estimated_usd && entry.actual_usd)) {
      const model = step.model_id;
      estimated.set(model, (estimated.get(model) ?? 0) + step.estimated_usd);
      spent.set(model, (spent.get(model) ?? 0) + step.actual_usd);
      counted.set(model, (counted.get(model) ?? 0) + 1);
    }
    const stepsCost = steps.reduce((sum, step) => sum + (step.actual_usd || 0), 0);
    if (stepsCost > 0) {
      inSteps += stepsCost;
      inTotal += Math.max(item.actual_usd || 0, stepsCost);
    }
  }
  const total = (values) => [...values.values()].reduce((sum, value) => sum + value, 0);
  const enough = total(counted) >= CALIBRATION_STEPS;
  return {
    models: Object.fromEntries([...counted].filter(([, count]) => count >= CALIBRATION_STEPS).map(([model]) => [model, spent.get(model) / estimated.get(model)])),
    overall: enough ? total(spent) / total(estimated) : null,
    overhead: inSteps ? inTotal / inSteps : 1.0,
  };
}

/** A task's estimate as past tasks suggest it will really go, or null without enough history.
 *  ``steps`` are [model id, estimated cost]; ``base_usd`` the estimate's base. */
export function calibratedCost({ steps, base_usd }, cal) {
  const overall = cal.overall;
  if (overall === null || base_usd === null || base_usd === undefined) return null;
  const stepsCost = steps.reduce((sum, [, cost]) => sum + cost, 0);
  let scaled = steps.reduce((sum, [model, cost]) => sum + cost * (cal.models[model] ?? overall), 0);
  // Planning and parts not yet split have no model of their own: the overall overrun.
  scaled += Math.max(0, base_usd - stepsCost) * overall;
  return pyRound(scaled * cal.overhead, 6);
}

/** Calibrate ``runs`` against ``reviews`` in O(|reviews| + |runs|) instead of O(|reviews| * |runs|),
 *  excluding each run's own review(s) when present. */
export function calibratedEach(reviews, runs) {
  if (!runs.length) return [];
  const totalEst = new Map();
  const totalSpent = new Map();
  const totalCount = new Map();
  const byRun = new Map();
  let allCount = 0;
  let allEst = 0;
  let allSpent = 0;
  let allInSteps = 0;
  let allInTotal = 0;
  for (const item of reviews) {
    const steps = item.steps || [];
    let entry = item.run_id != null ? byRun.get(item.run_id) : undefined;
    if (item.run_id != null && !entry) {
      entry = { models: new Map(), count: 0, est: 0, spent: 0, inSteps: 0, inTotal: 0 };
      byRun.set(item.run_id, entry);
    }
    for (const step of steps) {
      if (!step.estimated_usd || !step.actual_usd) continue;
      const model = step.model_id;
      totalEst.set(model, (totalEst.get(model) ?? 0) + step.estimated_usd);
      totalSpent.set(model, (totalSpent.get(model) ?? 0) + step.actual_usd);
      totalCount.set(model, (totalCount.get(model) ?? 0) + 1);
      allCount += 1;
      allEst += step.estimated_usd;
      allSpent += step.actual_usd;
      if (entry) {
        const prev = entry.models.get(model) ?? { est: 0, spent: 0, count: 0 };
        prev.est += step.estimated_usd;
        prev.spent += step.actual_usd;
        prev.count += 1;
        entry.models.set(model, prev);
        entry.count += 1;
        entry.est += step.estimated_usd;
        entry.spent += step.actual_usd;
      }
    }
    const stepsCost = steps.reduce((sum, step) => sum + (step.actual_usd || 0), 0);
    if (stepsCost > 0) {
      const runTotal = Math.max(item.actual_usd || 0, stepsCost);
      allInSteps += stepsCost;
      allInTotal += runTotal;
      if (entry) {
        entry.inSteps += stepsCost;
        entry.inTotal += runTotal;
      }
    }
  }
  const baseModels = Object.fromEntries([...totalCount].filter(([, count]) => count >= CALIBRATION_STEPS)
    .map(([model]) => [model, totalSpent.get(model) / totalEst.get(model)]));
  const baseCal = {
    models: baseModels,
    overall: allCount >= CALIBRATION_STEPS ? allSpent / allEst : null,
    overhead: allInSteps > 0 ? allInTotal / allInSteps : 1.0,
  };
  return runs.map((run) => {
    const own = run.id != null ? byRun.get(run.id) : undefined;
    if (!own) return calibratedCost(run, baseCal);
    const remCount = allCount - own.count;
    const remEst = allEst - own.est;
    const remSpent = allSpent - own.spent;
    const remInSteps = allInSteps - own.inSteps;
    const remInTotal = allInTotal - own.inTotal;
    const models = { ...baseModels };
    for (const [model, delta] of own.models) {
      const c = (totalCount.get(model) ?? 0) - delta.count;
      if (c >= CALIBRATION_STEPS) models[model] = ((totalSpent.get(model) ?? 0) - delta.spent) / ((totalEst.get(model) ?? 0) - delta.est);
      else delete models[model];
    }
    return calibratedCost(run, {
      models,
      overall: remCount >= CALIBRATION_STEPS ? remSpent / remEst : null,
      overhead: remInSteps > 0 ? remInTotal / remInSteps : 1.0,
    });
  });
}

/** FluidForm's requests, by method: what service.mjs answers. */
export const METHODS = {
  "pricing.charge": ({ model, input_tokens = 0, output_tokens = 0, cached_tokens = 0 }) =>
    ({ cost: tokenCost(model, input_tokens || 0, output_tokens || 0, cached_tokens || 0), priced: priced(model) }),
  "pricing.costs": ({ node, models }) => ({ costs: Object.fromEntries(models.map((model) => [model.id, nodeCost(node, model)])) }),
  "pricing.rates": ({ models }) => ({ rates: Object.fromEntries(models.map((model) => [model.id, rate(model)])) }),
  "pricing.estimate": ({ step_costs, budget, planning_cost = 0, extra = 0 }) => ({ estimate: estimate(step_costs, budget, planning_cost, extra) }),
  "pricing.admit": (params) => admit(params),
  "pricing.fits": (params) => ({ ok: fits(params) }),
  "pricing.allows": (params) => allows(params),
  "pricing.cli_price": (params) => cliPrice(params),
  "pricing.calibrated_each": ({ reviews, runs }) => ({ calibrated: calibratedEach(reviews, runs) }),
};
