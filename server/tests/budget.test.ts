// budget.ts: tests/test_providers.py (prompt cache price) and tests/test_safety.py (reservations), ported.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BudgetExceeded, RequestBudget, StepLimitExceeded, StepReservationBusy, tokenCost } from "../src/budget.js";
import { AsyncEvent } from "../src/py.js";

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) <= 1e-12 + 1e-6 * Math.abs(b), `${a} != ${b}`);
const model = { input_per_million: 1, output_per_million: 1 };
const models = { "test:model": model };
const charge = async () => undefined;

test("input read from the prompt cache costs the cache price", () => {
  const flash = { input_per_million: 0.15, output_per_million: 0.6, cached_input_per_million: 0.003 };
  // 10,000 input tokens of which 9,000 cached, 100 output.
  near(tokenCost(flash, 10_000, 100, 9_000), (1_000 * 0.15 + 9_000 * 0.003 + 100 * 0.6) / 1e6);
  // Without a cache price, cached input costs the input price; cached never exceeds input.
  near(tokenCost({ ...flash, cached_input_per_million: null }, 10_000, 0, 9_000), 10_000 * 0.15 / 1e6);
  near(tokenCost(flash, 100, 0, 500), 100 * 0.003 / 1e6);
  assert.equal(tokenCost({ input_per_million: null, output_per_million: 1 }, 100, 100), 0);
  assert.equal(tokenCost(null, 100, 100), 0);
});

test("a step's cost limit and the task's budget each hold, whatever the other leaves", async () => {
  // Plenty of task budget cannot buy a request forbidden by the work package's limit.
  let budget = new RequestBudget({ models, remaining: () => 10, reservations: new Map(), charge,
    changed: new AsyncEvent(), stepRemaining: () => 0.000001 });
  await assert.rejects(budget.reserve("test:model", { input: "test" }), StepLimitExceeded);
  // Plenty of step budget cannot bypass the run budget either.
  budget = new RequestBudget({ models, remaining: () => 0.000001, reservations: new Map(), charge,
    changed: new AsyncEvent(), stepRemaining: () => 10 });
  await assert.rejects(budget.reserve("test:model", { input: "test" }), BudgetExceeded);
  const reservations = new Map<unknown, number>([[{}, 0.999]]);
  budget = new RequestBudget({ models, remaining: () => 1, reservations, charge, changed: new AsyncEvent(),
    stepRemaining: () => 0.002 });
  const maximum = await budget.reserve("test:model", { input: "test" }, 4096);
  assert.ok(maximum >= 1 && maximum < 1000);
  assert.ok([...reservations.values()].reduce((a, b) => a + b) <= 1);
  budget.release();
  await assert.rejects(budget.reserve("unknown:model", {}), BudgetExceeded);
});

test("simultaneous progress checks share the step's reservations", async () => {
  const reservations = new Map<unknown, number>();
  const changed = new AsyncEvent();
  const make = () => new RequestBudget({ models, remaining: () => 10, reservations, charge, changed,
    stepRemaining: () => 0.001, scope: "node" });
  const work = make();
  const check = make();
  await work.reserve("test:model", { input: "work" }, 1000);
  let done = false;
  const pending = check.reserve("test:model", { input: "check" }, 1000).then(() => (done = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  work.release();
  await pending;
  assert.ok([...reservations.values()].reduce((a, b) => a + b, 0) <= 0.001);
  check.release();
});

test("a progress check cannot deadlock waiting on its worker", async () => {
  const reservations = new Map<unknown, number>();
  const make = (wait: boolean) => new RequestBudget({ models, remaining: () => 10, reservations, charge,
    changed: new AsyncEvent(), stepRemaining: () => 0.001, scope: "node", waitForStep: wait });
  const worker = make(true);
  const checker = make(false);
  await worker.reserve("test:model", { input: "work" }, 1000);
  await assert.rejects(checker.reserve("test:model", { input: "check" }, 1000), StepReservationBusy);
  worker.release();
});

test("turns, spending and recording", async () => {
  let turns = 2;
  const charged: number[] = [];
  const budget = new RequestBudget({ models, remaining: () => 1, reservations: new Map(), charge: async (cost) => {
    charged.push(cost);
  }, changed: new AsyncEvent(), turnRemaining: () => turns, useTurn: async () => {
    turns -= 1;
  } });
  await budget.beginTurn();
  await budget.beginTurn();
  await assert.rejects(budget.beginTurn(), StepLimitExceeded);
  assert.ok(budget.canSpend(0.5) && !budget.canSpend(2));
  await budget.record("test:model", 1000, 1000);
  await budget.recordUsd(0.01);
  await budget.recordUsd(0);
  near(budget.spent, 0.002 + 0.01);
  assert.equal(charged.length, 2);
  assert.ok(budget.allows());
  const over = new RequestBudget({ models, remaining: () => -1, reservations: new Map(), charge, changed: new AsyncEvent() });
  assert.equal(over.allows(), false);
  const stepOver = new RequestBudget({ models, remaining: () => 1, reservations: new Map(), charge, changed: new AsyncEvent(),
    stepRemaining: () => -1 });
  assert.throws(() => stepOver.allows(), StepLimitExceeded);
});
