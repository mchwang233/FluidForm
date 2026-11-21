// Request reservations shared by all calls of a run, including reviews and repairs.
import * as pricing from "./pricing.js";
import { AsyncEvent, pyDumps } from "./py.js";

export class ProviderError extends Error {
  constructor(message = "") {
    super(message);
    this.name = new.target.name;
  }
}

export class BudgetExceeded extends ProviderError {}

/** The pricing package did not answer: nothing more is spent (pricing.ts). */
export class PricingUnavailable extends BudgetExceeded {}

/** A declared step limit, independent of the run's budget approval flow. */
export class StepLimitExceeded extends ProviderError {}

/** A progress check cannot wait on the worker that is waiting on that check. */
export class StepReservationBusy extends ProviderError {}

export type Priced = {
  input_per_million: number | null;
  output_per_million: number | null;
  cached_input_per_million?: number | null;
};

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

  /** Whether the run may go on (Python's __call__): the pricing package decides from what is left.
   *  Usage is already charged by record(); without pricing nothing limits it. */
  async allows(): Promise<boolean> {
    if (!pricing.enabled()) return true;
    const answer = await pricing.allows({ remaining: this.remaining(), step_remaining: this.stepRemaining?.() ?? null });
    if (answer.stop === "step") throw new StepLimitExceeded(answer.message!);
    return Boolean(answer.ok);
  }

  /** The output tokens this call may ask for, holding their cost until record() or release(). */
  async reserve(modelId: string, payload: unknown, maximum = 4096): Promise<number> {
    if (!pricing.enabled()) return maximum;
    const model = this.model(modelId);
    // UTF-8 bytes plus protocol overhead bound the input tokens (pricing decides what they cost).
    const inputBytes = Buffer.byteLength(pyDumps(payload, false), "utf8");
    for (;;) {
      let held = 0;
      if (this.stepRemaining !== null) {
        for (const [key, value] of this.reservations) {
          if (key !== this && this.scope !== null && (key as { scope?: unknown }).scope === this.scope) held += value;
        }
      }
      const answer = await pricing.admit(model ? { ...model, id: modelId } : null, { input_bytes: inputBytes, maximum,
        remaining: this.remaining(), others: this.others(), step_remaining: this.stepRemaining?.() ?? null, step_held: held,
        wait_for_step: this.waitForStep });
      if ("output" in answer) {
        this.reservations.set(this, answer.reserve);
        return answer.output;
      }
      if ("wait" in answer) {
        // Another call may release unused output reservations: contention, not a request for the
        // user to raise the budget.
        this.changed.clear();
        await this.changed.wait();
        continue;
      }
      if (answer.stop === "step") throw new StepLimitExceeded(answer.message);
      if (answer.stop === "busy") throw new StepReservationBusy(answer.message);
      throw new BudgetExceeded(answer.message);
    }
  }

  /** Whether ``cost`` more (a picture, say) fits what is left, besides what others hold. */
  async canSpend(cost: number): Promise<boolean> {
    if (!pricing.enabled()) return true;
    return pricing.fits({ cost, remaining: this.remaining(), others: this.others(), step_remaining: this.stepRemaining?.() ?? null });
  }

  /** Something a tool paid for at a price of its own (a picture), not in tokens; only when priced. */
  async recordUsd(cost: number): Promise<void> {
    if (cost > 0 && pricing.enabled()) {
      await this.charge(cost);
      this.spent += cost;
    }
  }

  async record(modelId: string, inputTokens: number, outputTokens: number, cachedTokens = 0): Promise<void> {
    try {
      const model = this.model(modelId);
      if (pricing.enabled() && pricing.priced(model)) {
        const cost = await pricing.charge({ ...model!, id: modelId }, inputTokens, outputTokens, cachedTokens);
        await this.charge(cost);
        this.spent += cost;
      }
    } finally {
      this.release();
    }
  }

  release(): void {
    this.reservations.delete(this);
    this.changed.set();
  }
}
