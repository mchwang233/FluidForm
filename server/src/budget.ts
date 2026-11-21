// Request reservations shared by all calls of a run, including reviews and repairs.
import { AsyncEvent, pyDumps } from "./py.js";

export class ProviderError extends Error {
  constructor(message = "") {
    super(message);
    this.name = new.target.name;
  }
}

export class BudgetExceeded extends ProviderError {}

/** A declared step limit, independent of the run's budget approval flow. */
export class StepLimitExceeded extends ProviderError {}

/** A progress check cannot wait on the worker that is waiting on that check. */
export class StepReservationBusy extends ProviderError {}

export type Priced = {
  input_per_million: number | null;
  output_per_million: number | null;
  cached_input_per_million?: number | null;
};

/** What a call cost: uncached input at the input price, input read from the provider's prompt
 *  cache at its cache price (the input price when the catalog has none), and output. */
export function tokenCost(model: Priced | null | undefined, inputTokens: number, outputTokens: number, cachedTokens = 0): number {
  if (!model || model.input_per_million === null || model.output_per_million === null) return 0;
  const cached = Math.min(Math.max(cachedTokens || 0, 0), inputTokens);
  const cachedPrice = model.cached_input_per_million ?? model.input_per_million;
  return ((inputTokens - cached) * model.input_per_million + cached * cachedPrice
    + outputTokens * model.output_per_million) / 1_000_000;
}

const EPSILON = 0.0000005;

export type RequestBudgetOptions = {
  models: Map<string, Priced> | Record<string, Priced>;
  remaining: () => number;
  reservations: Map<unknown, number>;
  charge: (cost: number) => Promise<void> | void;
  changed: AsyncEvent;
  stepRemaining?: (() => number) | null;
  turnRemaining?: (() => number) | null;
  useTurn?: (() => Promise<void> | void) | null;
  scope?: unknown;
  waitForStep?: boolean;
};

export class RequestBudget {
  readonly models: RequestBudgetOptions["models"];
  readonly remaining: () => number;
  readonly reservations: Map<unknown, number>;
  readonly charge: RequestBudgetOptions["charge"];
  readonly changed: AsyncEvent;
  spent = 0;
  readonly stepRemaining: (() => number) | null;
  readonly turnRemaining: (() => number) | null;
  readonly useTurn: (() => Promise<void> | void) | null;
  readonly scope: unknown;
  readonly waitForStep: boolean;

  constructor(options: RequestBudgetOptions) {
    this.models = options.models;
    this.remaining = options.remaining;
    this.reservations = options.reservations;
    this.charge = options.charge;
    this.changed = options.changed;
    this.stepRemaining = options.stepRemaining ?? null;
    this.turnRemaining = options.turnRemaining ?? null;
    this.useTurn = options.useTurn ?? null;
    this.scope = options.scope ?? null;
    this.waitForStep = options.waitForStep ?? true;
  }

  private model(id: string): Priced | undefined {
    return this.models instanceof Map ? this.models.get(id) : this.models[id];
  }

  private others(): number {
    let sum = 0;
    for (const [key, value] of this.reservations) if (key !== this) sum += value;
    return sum;
  }

  async beginTurn(): Promise<void> {
    if (this.turnRemaining !== null) {
      if (this.turnRemaining() <= 0) throw new StepLimitExceeded("达到声明轮次上限，停止工作包，禁止自动续跑。");
      await this.useTurn?.();
    }
  }

  /** Whether the run may go on (Python's __call__). Usage is already charged by record();
   *  equality permits returning a final reply. */
  allows(): boolean {
    if (this.stepRemaining !== null && this.stepRemaining() < -EPSILON) {
      throw new StepLimitExceeded("达到声明费用上限，停止工作包，禁止自动续跑。");
    }
    return this.remaining() >= -EPSILON;
  }

  async reserve(modelId: string, payload: unknown, maximum = 4096): Promise<number> {
    const model = this.model(modelId);
    if (!model || model.input_per_million === null || model.output_per_million === null) {
      throw new BudgetExceeded(`缺少 ${modelId} 的价格，无法核验请求预算。`);
    }
    // UTF-8 bytes plus protocol overhead conservatively bound textual input tokens.
    // Inline images are deliberately included, rather than silently budgeted as free.
    const inputBound = Buffer.byteLength(pyDumps(payload, false), "utf8") + 256;
    const inputCost = inputBound * model.input_per_million / 1_000_000;
    const outputPrice = model.output_per_million / 1_000_000;
    for (;;) {
      const other = this.others();
      const remaining = this.remaining();
      let available = remaining - other;
      if (this.stepRemaining !== null) {
        const stepLeft = this.stepRemaining();
        if (stepLeft < inputCost + outputPrice) {
          throw new StepLimitExceeded("声明的步骤费用不足以发起下一轮请求，停止工作包并保留诊断。");
        }
        let held = 0;
        for (const [key, value] of this.reservations) {
          if (key !== this && this.scope !== null && (key as { scope?: unknown }).scope === this.scope) held += value;
        }
        if (held && !this.waitForStep && Math.min(available, stepLeft - held) < inputCost + outputPrice) {
          throw new StepReservationBusy("本步骤的请求仍占用预算，跳过本次付费进度检查。");
        }
        available = Math.min(available, stepLeft - held);
      }
      const output = outputPrice ? Math.min(maximum, Math.floor((available - inputCost) / outputPrice)) : maximum;
      if (inputCost <= available && output >= 1) {
        this.reservations.set(this, inputCost + output * outputPrice);
        return output;
      }
      if (other && remaining >= inputCost + outputPrice) {
        // Another call may release unused output reservations. Wait automatically;
        // this is contention, not a request for the user to raise the budget.
        this.changed.clear();
        await this.changed.wait();
        continue;
      }
      throw new BudgetExceeded("剩余预算不足以发起下一轮模型请求，任务已暂停。");
    }
  }

  /** Whether ``cost`` more (a picture, say) fits what is left, besides what others hold. */
  canSpend(cost: number): boolean {
    if (this.stepRemaining !== null && this.stepRemaining() < cost) return false;
    return this.remaining() - this.others() >= cost;
  }

  /** Something a tool paid for at a price of its own (a picture), not in tokens. */
  async recordUsd(cost: number): Promise<void> {
    if (cost > 0) {
      await this.charge(cost);
      this.spent += cost;
    }
  }

  async record(modelId: string, inputTokens: number, outputTokens: number, cachedTokens = 0): Promise<void> {
    const model = this.model(modelId);
    if (model && model.input_per_million !== null && model.output_per_million !== null) {
      const cost = tokenCost(model, inputTokens, outputTokens, cachedTokens);
      await this.charge(cost);
      this.spent += cost;
    }
    this.release();
  }

  release(): void {
    this.reservations.delete(this);
    this.changed.set();
  }
}
