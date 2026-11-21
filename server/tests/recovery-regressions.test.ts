// Costs kept and work resumed across failures: tests/test_recovery_regressions.py, ported.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { settings } from "../src/config.js";
import { Database } from "../src/db.js";
import * as environment from "../src/environment.js";
import { Executor } from "../src/executor.js";
import { type ExecutionRun, ExecutionRunSchema, type ModelProfile, ModelProfileSchema, type TaskNode, TaskNodeSchema } from "../src/models.js";
import { type CompleteOptions, ProviderResult } from "../src/providers.js";
import * as quality from "../src/quality.js";
import { QuotaTracker } from "../src/quota.js";
import { turnsFor } from "../src/recovery.js";
import { conftest } from "./helpers/conftest.js";
import { type Given, registryWith, type Sent } from "./helpers/providers.js";

const { folder } = conftest();
const originalState = quality.files.state;
beforeEach(() => {
  Object.assign(settings, { workspace_root: join(folder(), "workspaces"), review_nodes: false, max_node_attempts: 1 });
  process.env.DEEPSEEK_API_KEY = "test-only";
});
afterEach(() => {
  quality.files.state = originalState;
});

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const model = (id = "deepseek:primary", score = 95, fields: Partial<ModelProfile> = {}) => ModelProfileSchema.parse({ id, provider: id.split(":")[0], display_name: id,
  context_window: 1_000_000, input_per_million: 1, output_per_million: 1, scores: { planning: score, coding: score, reliability: score }, ...fields });
const lookup = (...models: ModelProfile[]) => Object.fromEntries(models.map((m) => [m.id, m]));
const node = (id = "n", fields: Record<string, unknown> = {}): TaskNode => TaskNodeSchema.parse({ id, title: id, instructions: `work on ${id}`, capability: "coding", model_id: "deepseek:primary", ...fields });
const run = (nodes: TaskNode[], status = "queued", fields: Record<string, unknown> = {}): ExecutionRun =>
  ExecutionRunSchema.parse({ id: "r", prompt: "review fixture", budget_usd: 1, status, plan: { summary: "fixture", nodes }, ...fields });
const newDb = () => new Database(join(folder(), "db"));

function response(text = "done", tools = false): Given {
  const message: Record<string, unknown> = { content: text };
  if (tools) message.tool_calls = [{ id: "c1", type: "function", function: { name: "list_dir", arguments: "{}" } }];
  return { choices: [{ message }], usage: { prompt_tokens: 1000, completion_tokens: 50 } };
}

function registry(handler: (request: Sent) => Given | Promise<Given>) {
  const providers = registryWith(handler);
  providers.configuredModels = (ids) => new Set([...ids].filter((id) => !providers.quota.exhausted(id)));
  providers.maxAttempts = 1;
  return providers;
}

class Script {
  calls: [string, CompleteOptions][] = [];
  quota = new QuotaTracker();
  constructor(readonly reply = "done") {}

  configuredModels(ids: Iterable<string>) {
    return new Set([...ids].filter((id) => !this.quota.exhausted(id)));
  }

  async complete(modelId: string, _prompt: string, options: CompleteOptions = {}): Promise<ProviderResult> {
    this.calls.push([modelId, options]);
    return new ProviderResult(this.reply, 100, 0, modelId);
  }
}

test("paid rounds are kept on a failure and a model switch", async () => {
  for (const failure of ["error", "outage", "turn_limit"]) {
    const calls: string[] = [];
    settings.api_agent_max_turns = 2;
    const providers = registry((request) => {
      const id = request.body.model as string;
      calls.push(id);
      if (id === "backup") return response();
      if (calls.filter((call) => call === id).length === 1 || failure === "turn_limit") return response("done", true);
      return new Response("provider failure", { status: failure === "outage" ? 503 : 400 });
    });
    const db = new Database(join(folder(), `db-${failure}`));
    db.saveRun(run([node()]));
    await new Executor(db, providers, lookup(model(), model("deepseek:backup", 90))).execute("r");
    const saved = db.getRun("r")!;
    // Out of turns, the model is paid for every turn plus the one asking for its progress summary.
    const expected = { error: 0.00105, outage: 0.0021, turn_limit: 0.00105 * (turnsFor(node())! + 1) }[failure]!;
    near(saved.actual_cost_usd, expected);
    near(saved.actual_cost_usd, saved.plan.nodes[0].attempts.reduce((sum, a) => sum + a.cost_usd, 0));
    if (failure === "outage") {
      assert.equal(saved.status, "succeeded");
      assert.deepEqual(calls, ["primary", "primary", "backup"]);
    } else assert.equal(saved.status, "failed", failure);
  }
});

test("the budget refuses a request before the network, and pauses without a quality retry", async () => {
  const requests: Sent[] = [];
  const providers = registry((request) => {
    requests.push(request);
    return response();
  });
  const db = newDb();
  db.saveRun(run([node()], "queued", { budget_usd: 0.00001 }));
  await new Executor(db, providers, lookup(model())).execute("r");
  const saved = db.getRun("r")!;
  assert.ok(requests.length === 0 && saved.actual_cost_usd === 0);
  assert.ok(saved.status === "paused" && saved.plan.nodes[0].status === "pending");
  assert.ok(saved.plan.nodes[0].failed_attempts === 0 && saved.plan.nodes[0].attempts.at(-1)!.outcome === "budget");
});

test("parallel requests share reservations", async () => {
  let requested!: () => void;
  let release!: () => void;
  const asked = new Promise<void>((done) => (requested = done));
  const released = new Promise<void>((done) => (release = done));
  const requests: Record<string, any>[] = [];
  const providers = registry(async (request) => {
    requests.push(request.body);
    requested();
    await released;
    return response();
  });
  const db = newDb();
  const current = run([node()], "queued", { budget_usd: 0.0045 });
  db.saveRun(current);
  const executor = new Executor(db, providers, lookup(model()));
  const first = executor.complete(current, current.plan.nodes[0], "deepseek:primary", "first", folder());
  let second: Promise<ProviderResult> | null = null;
  try {
    await asked;
    second = executor.complete(current, current.plan.nodes[0], "deepseek:primary", "second", folder());
    await new Promise((done) => setTimeout(done, 20));
    assert.ok(requests.length === 1 && requests[0].max_tokens > 0 && requests[0].max_tokens < settings.api_agent_max_output_tokens);
    release();
    await Promise.all([first, second]);
    assert.ok(requests.length === 2 && requests[1].max_tokens < requests[0].max_tokens);
    assert.equal(executor.reservations.get("r")!.size, 0);
    near(db.getRun("r")!.actual_cost_usd, 0.0021);
  } finally {
    release();
    await Promise.allSettled([first, second].filter(Boolean) as Promise<unknown>[]);
  }
});

test("cancelling keeps the paid rounds and releases the reservations", async () => {
  let waiting!: () => void;
  const reached = new Promise<void>((done) => (waiting = done));
  let calls = 0;
  const providers = registry(async () => {
    calls += 1;
    if (calls === 1) return response("done", true);
    waiting();
    return new Promise<Given>(() => undefined); // held until the call is cancelled
  });
  const db = newDb();
  db.saveRun(run([node()]));
  const executor = new Executor(db, providers, lookup(model()));
  executor.start("r");
  await reached;
  const current = db.getRun("r")!;
  near(current.actual_cost_usd, 0.00105);
  current.status = "cancelled";
  db.saveRun(current);
  executor.cancel("r");
  await assert.rejects(executor.tasks.get("r")!.promise, { name: "AbortError" });
  const saved = db.getRun("r")!;
  near(saved.actual_cost_usd, 0.00105);
  near(saved.plan.nodes[0].attempts.at(-1)!.cost_usd, 0.00105);
  assert.equal(executor.reservations.get("r")!.size, 0);
});

test("rework cancels the consumers in flight and runs them again", async () => {
  const db = newDb();
  const executor = new Executor(db, new Script(), lookup(model()));
  let started!: () => void;
  const begun = new Promise<void>((done) => (started = done));
  const calls: Record<string, number> = { a: 0, b: 0, v: 0, c: 0 };
  const cancelled: string[] = [];
  executor.work = async (_current, item, modelId, prompt, _fallback, _conversation, _headStart, signal) => {
    calls[item.id] += 1;
    let text: string;
    if (item.id === "a") text = "a-v2";
    else if (item.id === "b") {
      if (calls.b === 1) {
        assert.ok(prompt.includes("a-v1"));
        started();
        await new Promise<void>((_, fail) => signal!.addEventListener("abort", () => {
          cancelled.push("b");
          fail(signal!.reason);
        }));
      }
      assert.ok(prompt.includes("a-v2"));
      text = "b from a-v2";
    } else if (item.id === "v") {
      await begun;
      text = calls.v === 1 ? "VERDICT: FAIL: a-v1 is wrong" : "VERDICT: PASS";
    } else text = prompt;
    return [new ProviderResult(text, 0, 0, modelId), [], 0, folder()];
  };
  db.saveRun(run([node("a", { status: "succeeded", result: "a-v1" }), node("v", { dependencies: ["a"], verifies: ["a"] }),
    node("b", { dependencies: ["a"] }), node("c", { dependencies: ["b", "v"] })]));
  await Promise.race([executor.execute("r"), new Promise((_, fail) => setTimeout(() => fail(new Error("timed out")), 3000).unref())]);
  const saved = db.getRun("r")!;
  assert.ok(saved.status === "succeeded" && calls.b === 2);
  assert.deepEqual(cancelled, ["b"]);
  assert.ok(saved.final_result!.includes("b from a-v2"));
  assert.equal(saved.plan.nodes[2].attempts[0].outcome, "superseded");
});

test("a turned-off model is chosen again before the step runs", async () => {
  const providers = new Script();
  const db = newDb();
  db.saveRun(run([node()]));
  await new Executor(db, providers, lookup(model("deepseek:primary", 95, { enabled: false }), model("deepseek:backup"))).execute("r");
  assert.deepEqual(providers.calls.map(([id]) => id), ["deepseek:backup"]);
  assert.equal(db.getRun("r")!.status, "succeeded");
});

test("a failed snapshot after a paid call keeps the attempt's cost", async () => {
  const snapshots: string[] = [];
  quality.files.state = (root: string) => {
    snapshots.push(root);
    if (snapshots.length > 1) throw new Error("snapshot failed");
    return new Map();
  };
  const db = newDb();
  db.saveRun(run([node()]));
  await new Executor(db, new Script(), lookup(model())).execute("r");
  const saved = db.getRun("r")!;
  assert.equal(saved.status, "failed");
  near(saved.actual_cost_usd, 0.0001);
  near(saved.plan.nodes[0].attempts[0].cost_usd, 0.0001);
});

test("real work never falls back to a demo review", async () => {
  settings.review_nodes = true;
  class Reviewer extends Script {
    override async complete(modelId: string, _prompt: string, options: CompleteOptions = {}): Promise<ProviderResult> {
      this.calls.push([modelId, options]);
      return new ProviderResult(modelId.startsWith("mock:") ? '{"passed": true}' : "Unparseable reply", 100, 0, modelId);
    }
  }
  const providers = new Reviewer();
  const db = newDb();
  db.saveRun(run([node()]));
  await new Executor(db, providers, lookup(model(), model("mock:local"))).execute("r");
  assert.equal(db.getRun("r")!.status, "failed");
  assert.equal(db.getRun("r")!.plan.nodes[0].review_passed, null);
  assert.ok(providers.calls.every(([id]) => !id.startsWith("mock:")));
});

const within = <T>(work: Promise<T>, seconds = 3) => Promise.race([work, new Promise<never>((_, fail) => setTimeout(() => fail(new Error("timed out")), seconds * 1000).unref())]);

test("a diagnosis the user asked for switches the model and continues the original work", async () => {
  class Repair extends Script {
    override async complete(modelId: string, _prompt: string, options: CompleteOptions = {}): Promise<ProviderResult> {
      this.calls.push([modelId, options]);
      return new ProviderResult(options.repair ? "额度用完\nSTATUS: QUOTA_EXHAUSTED" : "original task completed", 100, 0, modelId);
    }
  }
  const providers = new Repair();
  const db = newDb();
  db.saveRun(run([node("n", { status: "failed", attempts: [{ model_id: "deepseek:primary", outcome: "error", reason: "E_NEW_LIMIT" }] })], "paused",
    { diagnoses: [{ id: "d", trigger: "manual", node_id: "n", model_id: "deepseek:backup" }] }));
  const executor = new Executor(db, providers, lookup(model(), model("deepseek:backup")));
  executor.startDiagnosis("r", "d");
  await within(executor.diagnosing.get("r")!.promise);
  await within(executor.tasks.get("r")!.promise);
  const saved = db.getRun("r")!;
  assert.ok(saved.status === "succeeded" && saved.final_result === "original task completed");
  assert.ok(providers.quota.exhausted("deepseek:primary"));
  assert.equal(providers.quota.classify("deepseek:primary", "E_NEW_LIMIT"), "quota");
  assert.ok(saved.diagnoses[0].verdict === "quota_exhausted" && providers.calls[0][1].repair);
  near(saved.actual_cost_usd, 0.0002);
});

test("an environment repair the user asked for is shared and resumes the step", async () => {
  class Repair extends Script {
    override async complete(modelId: string, _prompt: string, options: CompleteOptions = {}): Promise<ProviderResult> {
      if (options.repair) {
        writeFileSync(join(environment.prepare(), "bin", "check_env"), "#!/bin/sh\necho ready\n");
        return new ProviderResult("已安装并验证共享工具。\nSTATUS: FIXED", 100, 0, modelId);
      }
      return new ProviderResult("original work finished", 100, 0, modelId);
    }
  }
  const db = newDb();
  db.saveRun(run([node("n", { status: "failed", attempts: [{ outcome: "error", reason: "missing tool" }] })], "failed",
    { diagnoses: [{ id: "d", trigger: "manual", node_id: "n", model_id: "deepseek:primary" }] }));
  const executor = new Executor(db, new Repair(), lookup(model()));
  executor.startDiagnosis("r", "d");
  await within(executor.diagnosing.get("r")!.promise);
  await within(executor.tasks.get("r")!.promise);
  const saved = db.getRun("r")!;
  assert.ok(saved.status === "succeeded" && saved.diagnoses[0].verdict === "fixed");
  assert.deepEqual((db.sharedRepairs()[0] as Record<string, unknown>).files, ["bin/check_env"]);
  near(saved.actual_cost_usd, 0.0002);
});

test("a repair the user asked for without budget stays paused without using a retry", async () => {
  const requests: Sent[] = [];
  const providers = registry((request) => {
    requests.push(request);
    return response();
  });
  const db = newDb();
  db.saveRun(run([node("n", { status: "failed", attempts: [{ outcome: "error", reason: "missing tool" }] })], "paused",
    { budget_usd: 0.00001, diagnoses: [{ id: "d", trigger: "manual", node_id: "n", model_id: "deepseek:primary" }] }));
  const executor = new Executor(db, providers, lookup(model()));
  executor.startDiagnosis("r", "d");
  await within(executor.diagnosing.get("r")!.promise);
  const saved = db.getRun("r")!;
  assert.ok(requests.length === 0 && saved.status === "paused" && !executor.tasks.has("r"));
  assert.equal(saved.plan.nodes[0].failed_attempts, 0);
  assert.ok(saved.diagnoses[0].status === "failed" && saved.diagnoses[0].error!.includes("预算"));
});

