// executor.ts: tests/test_executor.py, ported (those that need no API routes).
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { builtinModels } from "../src/catalog.js";
import { settings } from "../src/config.js";
import { Database } from "../src/db.js";
import { Executor } from "../src/executor.js";
import { ExecutionRunSchema, type ExecutionRun, ModelProfileSchema, type TaskNode, TaskNodeSchema } from "../src/models.js";
import { heuristicPlan } from "../src/planner.js";
import { type CompleteOptions, ProviderRegistry, ProviderResult } from "../src/providers.js";
import { estimate, routeNode } from "../src/routing.js";
import { sleep } from "../src/tasks.js";
import { contractNode, coverageNodes, mockAcceptance, restoreAcceptance, setupExecutor } from "./helpers/artifacts.js";
import { conftest } from "./helpers/conftest.js";

const { folder } = conftest();
// test_executor's execution_only: scheduler doubles supply no reviewers; acceptance is tested elsewhere.
beforeEach(() => {
  settings.review_nodes = false;
});
afterEach(() => restoreAcceptance());
const catalog = () => Object.fromEntries(builtinModels().map((m) => [m.id, m]));
const newDb = (name = "test.db") => new Database(join(folder(), name));

class Slow {
  active = 0;
  peak = 0;
  calls = 0;

  constructor(readonly delay = 0.05, readonly tokens: [number, number] = [10, 10]) {}

  async complete(modelId: string, _prompt: string, options: CompleteOptions = {}): Promise<ProviderResult> {
    this.calls += 1;
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    try {
      await sleep(this.delay, options.signal);
    } finally {
      this.active -= 1;
    }
    return new ProviderResult("ok", this.tokens[0], this.tokens[1], modelId);
  }
}

class Fixed {
  constructor(readonly used: string | null = null) {}

  async complete(modelId: string, prompt: string): Promise<ProviderResult> {
    return new ProviderResult(`out ${prompt.split(/\s+/)[1]}`, 1000, 1000, this.used || modelId);
  }
}

function wideRun(db: Database, width: number, cost: number, budget: number, modelId = "mock:local"): ExecutionRun {
  const nodes = Array.from({ length: width }, (_, i) => ({ id: `n${i}`, title: `Node ${i}`, instructions: "work", capability: "planning", model_id: modelId, estimated_cost_usd: cost }));
  const run = ExecutionRunSchema.parse({ id: "wide", prompt: "demo", status: "queued", plan: { summary: "wide", nodes }, budget_usd: budget });
  db.saveRun(run);
  return run;
}
const graphRun = (nodes: TaskNode[], budget = 1.0) => ExecutionRunSchema.parse({ id: "graph", prompt: "demo", status: "queued", budget_usd: budget, plan: { summary: "graph", nodes } });
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("an artifact pipeline makes its own missing outputs and audits only accepted reports", async () => {
  const checks: [string, boolean, boolean][] = [];
  mockAcceptance(checks);
  const [executor, db, providers] = setupExecutor(folder());
  await executor.execute("artifacts");
  const run = db.getRun("artifacts")!;
  assert.equal(run.status, "succeeded", run.error ?? "");
  assert.deepEqual(providers.calls, ["vdb", "report", "audit"]);
  assert.ok(run.plan.nodes.every((n) => n.artifact_evidence?.accepted));
  assert.deepEqual(checks.map((c) => c[0]), ["validate coverage.vdb", "validate report.txt", "validate audit.txt"]);
  near(run.actual_cost_usd, 0.006);
  assert.ok(run.plan.nodes.every((n) => n.contract_turns === 1));
});

test("a missing external input blocks without model calls or the downstream audit", async () => {
  const [, report, audit] = coverageNodes();
  report.dependencies = [];
  report.artifact_contract!.inputs[0].source = "external";
  const [executor, db, providers] = setupExecutor(folder(), [report, audit]);
  settings.auto_diagnose = true;
  await executor.execute("artifacts");
  const run = db.getRun("artifacts")!;
  assert.ok(run.status === "incomplete" && providers.calls.length === 0);
  assert.ok(run.plan.nodes.every((n) => n.status === "blocked"));
  assert.equal(run.plan.nodes[0].attempts[0].outcome, "blocked");
  assert.ok(run.diagnoses[0].report!.includes("coverage.vdb"));
  assert.equal(run.actual_cost_usd, 0);
});

test("a membership CLI runs a contract step bounded by time", async () => {
  const node = contractNode();
  node.model_id = "cli:codex";
  const [executor, db] = setupExecutor(folder(), [node]);
  executor.modelLookup[node.model_id] = ModelProfileSchema.parse({ ...executor.modelLookup["test:worker"], id: node.model_id, provider: "cli", channel: "cli" });
  const run = db.getRun("artifacts")!;
  run.use_cli = true;
  db.saveRun(run);
  mockAcceptance([]);
  await executor.execute("artifacts");
  const done = db.getRun("artifacts")!.plan.nodes[0];
  // The lead's assignment holds: no switch to an API model that can count tool calls.
  assert.deepEqual(done.attempts.map((a) => a.model_id), ["cli:codex"]);
  assert.ok(!db.events("artifacts").some((e) => e.kind === "node.model_switched"));
});

test("a CLI contract step stops past the time its calls allow", async () => {
  const [executor, db] = setupExecutor(folder(), [contractNode()]);
  const run = db.getRun("artifacts")!;
  const checked: string[] = [];
  executor.progressWatch = () => async (evidence) => {
    checked.push(evidence);
    return null;
  };
  assert.equal(await executor.timedWatch(run, run.plan.nodes[0], "cli:codex")("busy"), null);
  assert.deepEqual(checked, ["busy"]);
  // Module constants cannot be replaced in ESM: a contract with no calls allowed has no time either.
  const none = { ...run.plan.nodes[0], artifact_contract: { ...run.plan.nodes[0].artifact_contract!, max_turns: 0 } };
  assert.ok((await executor.timedWatch(run, none, "cli:codex")("busy"))!.includes("用时上限"));
  // An API model counts its calls: no time limit.
  assert.equal(await executor.timedWatch(run, run.plan.nodes[0], "test:worker")("busy"), null);
});

test("tool-limit admission blocks before dispatch, with structured evidence", async () => {
  for (const declaration of [{}, { counting_unit: "request", hard_limit: true }, { counting_unit: "tool_call", hard_limit: false }]) {
    const [executor, db, providers] = setupExecutor(join(folder(), JSON.stringify(declaration).replace(/\W/g, "")));
    providers.capabilities["test:worker"] = declaration;
    executor.executeNode = async () => assert.fail("incompatible work was dispatched");
    await executor.execute("artifacts");
    const run = db.getRun("artifacts")!;
    assert.equal(run.status, "incomplete");
    assert.ok(!providers.calls.length && !providers.actualCalls.length);
    assert.ok(run.plan.nodes.every((n) => n.status === "blocked" && !n.attempts.length && n.started_at === null));
    const events = db.events(run.id);
    assert.ok(!events.some((e) => e.kind === "node.started"));
    const data = events.find((e) => e.kind === "node.blocked")!.data as Record<string, any>;
    assert.ok(data.started === false && data.code === "tool_limit_incompatible");
    assert.deepEqual(data.required_capabilities, { counting_unit: "tool_call", hard_limit: true });
    assert.deepEqual(data.channels[0].declared_capabilities, declaration);
    assert.deepEqual(data.actual_counts.vdb, { requests: 0, tool_calls: 0, cost_usd: 0, limit: 3 });
    assert.deepEqual(data.affected_dependencies, ["audit", "report"]);
    assert.equal(run.actual_cost_usd, 0);
  }
});

test("tool-limit admission checks again after the final channel changes", async () => {
  const [executor, db, providers] = setupExecutor(folder(), [contractNode()]);
  executor.spread = (_run, node) => {
    providers.capabilities[node.model_id!] = { counting_unit: "request", hard_limit: false };
  };
  await executor.execute("artifacts");
  const node = db.getRun("artifacts")!.plan.nodes[0];
  assert.ok(node.status === "blocked" && !node.attempts.length && node.started_at === null);
  assert.ok(!providers.calls.length && !providers.actualCalls.length);
  assert.ok(!db.events("artifacts").some((e) => e.kind === "node.started"));
});

test("a compatible consumer does not start without its upstream's acceptance", async () => {
  const [executor, db, providers] = setupExecutor(folder());
  const run = db.getRun("artifacts")!;
  run.plan.nodes[0].status = "succeeded"; // a status alone is not accepted evidence
  db.saveRun(run);
  await executor.execute(run.id);
  const saved = db.getRun(run.id)!;
  assert.ok(saved.status === "incomplete" && !providers.calls.length);
  assert.equal(saved.plan.nodes[0].status, "succeeded");
  assert.ok(saved.plan.nodes.slice(1).every((n) => n.status === "blocked" && !n.attempts.length && n.started_at === null));
  assert.ok(!db.events(run.id).some((e) => e.kind === "node.started"));
});

test("an artifact worker's blocked result keeps its cost and log, without automatic recovery", async () => {
  const [executor, db, providers] = setupExecutor(folder(), [contractNode()], async (_node, _workspace, options) => {
    options.tool_log!.push({ turn: 1, tool: "Bash", detail: "check license", ok: false, output: "license missing" });
    return new ProviderResult("BLOCKED: license missing", 1000, 1000, "test:worker", { turns: 1 });
  });
  settings.auto_diagnose = true;
  await executor.execute("artifacts");
  const node = db.getRun("artifacts")!.plan.nodes[0];
  assert.ok(providers.calls.length === 1 && providers.calls[0] === "vdb" && node.status === "blocked");
  near(node.attempts[0].cost_usd, 0.002);
  assert.equal(node.attempts[0].tool_calls[0].output, "license missing");
});

test("an artifact's blocked claim never runs the downstream audit", async () => {
  const calls: string[] = [];
  const providers = { async complete(modelId: string, prompt: string) {
    calls.push(prompt);
    return new ProviderResult("BLOCKED: upstream evidence missing", 0, 0, modelId);
  } };
  const node = TaskNodeSchema.parse({ id: "report", title: "Report", instructions: "Generate text", capability: "research", model_id: "mock:local" });
  const audit = TaskNodeSchema.parse({ id: "audit", title: "Audit", instructions: "Audit delivery", capability: "research", model_id: "mock:local", dependencies: ["report"] });
  const db = newDb("blocked.db");
  db.saveRun(ExecutionRunSchema.parse({ id: "blocked", prompt: "delivery", status: "queued", budget_usd: 1, plan: { summary: "delivery", nodes: [node, audit] } }));
  await new Executor(db, providers, catalog()).execute("blocked");
  assert.equal(db.getRun("blocked")!.status, "incomplete");
  assert.equal(calls.length, 1);
  assert.equal(db.getRun("blocked")!.plan.nodes[1].status, "blocked");
});

test("a demo execution completes", async () => {
  const db = newDb();
  const models = builtinModels();
  const plan = heuristicPlan("Research and implement a small feature");
  for (const node of plan.nodes) {
    // As the API does, lower thresholds the only model (the demo, at 80) cannot reach.
    node.quality_threshold = Math.min(node.quality_threshold, 80);
    routeNode(node, models, new Set(["mock:local"]));
  }
  plan.estimate = estimate(plan.nodes, 1);
  db.saveRun(ExecutionRunSchema.parse({ id: "demo", prompt: "demo", status: "queued", plan, budget_usd: 1 }));
  await new Executor(db, new ProviderRegistry(), catalog()).execute("demo");
  const result = db.getRun("demo")!;
  assert.equal(result.status, "succeeded");
  assert.ok(result.final_result && result.plan.nodes.every((node) => node.result));
});

test("resuming runs the steps an interruption cut off again", async () => {
  const db = newDb();
  const plan = heuristicPlan("Analyze this task");
  for (const node of plan.nodes) routeNode(node, builtinModels(), new Set(["mock:local"]));
  for (const node of plan.nodes.slice(0, -1)) {
    node.status = "succeeded";
    node.result = "done";
  }
  plan.nodes.at(-1)!.status = "running";
  db.saveRun(ExecutionRunSchema.parse({ id: "resumed", prompt: "demo", status: "queued", plan, budget_usd: 1 }));
  await new Executor(db, new ProviderRegistry(), catalog()).execute("resumed");
  const result = db.getRun("resumed")!;
  assert.ok(result.status === "succeeded" && result.plan.nodes.at(-1)!.status === "succeeded" && result.final_result);
});

test("every ready step starts at once by default", async () => {
  assert.equal(settings.max_parallel_nodes, 0);
  const db = newDb();
  const run = wideRun(db, 8, 0, 1);
  const providers = new Slow(0.1);
  await new Executor(db, providers, catalog()).execute(run.id);
  assert.ok(db.getRun(run.id)!.status === "succeeded" && providers.peak === 8);
});

test("the executor keeps to the parallel limit", async () => {
  settings.max_parallel_nodes = 2;
  const db = newDb();
  const run = wideRun(db, 5, 0, 1);
  const providers = new Slow();
  await new Executor(db, providers, catalog()).execute(run.id);
  assert.equal(db.getRun(run.id)!.status, "succeeded");
  assert.ok(providers.calls === 5 && providers.peak === 2);
});

test("the executor holds back steps that would go over the budget", async () => {
  const db = newDb();
  const run = wideRun(db, 3, 0.4, 1, "openai:gpt-5.6-sol");
  // 20k input and 16k output tokens on GPT-5.6 Sol cost exactly the $0.40 estimate.
  const providers = new Slow(0, [20_000, 16_000]);
  await new Executor(db, providers, catalog()).execute(run.id);
  const result = db.getRun(run.id)!;
  assert.equal(result.status, "paused");
  assert.equal(providers.calls, 2);
  assert.equal(result.plan.nodes.filter((node) => node.status === "pending").length, 1);
  assert.equal(db.events(run.id).at(-1)!.kind, "approval.required");
});

test("cancelling stops the running steps", async () => {
  const db = newDb();
  const run = wideRun(db, 2, 0, 1);
  const providers = new Slow(30);
  const executor = new Executor(db, providers, catalog());
  executor.start(run.id);
  while (providers.active < 2) await sleep(0.01);
  const cancelled = db.getRun(run.id)!;
  cancelled.status = "cancelled";
  db.saveRun(cancelled);
  executor.cancel(run.id);
  await assert.rejects(executor.tasks.get(run.id)!.promise, { name: "AbortError" });
  const result = db.getRun(run.id)!;
  assert.equal(providers.active, 0);
  assert.equal(result.status, "cancelled");
  assert.deepEqual(new Set(result.plan.nodes.map((node) => node.status)), new Set(["cancelled"]));
});

test("a cancelled attempt keeps its turns, tool calls and trace", async () => {
  // What an attempt did is kept however it ends, so the task can be looked back on.
  const db = newDb();
  const run = wideRun(db, 1, 0, 1);
  let started!: () => void;
  const begun = new Promise<void>((done) => (started = done));
  const working = { async complete(modelId: string, _prompt: string, options: CompleteOptions = {}): Promise<ProviderResult> {
    options.tool_log!.push({ turn: 3, tool: "Bash", detail: "make test", ok: false, output: "1 failed" });
    mkdirSync(dirname(options.tool_trace!), { recursive: true });
    writeFileSync(options.tool_trace!, '{"turn": 3, "tool": "Bash", "output": "the whole output"}\n');
    started();
    try {
      await sleep(30, options.signal);
    } catch (error) {
      (error as Record<string, unknown>).usage = new ProviderResult("", 100, 20, modelId, { turns: 7 });
      throw error;
    }
    return new ProviderResult("", 0, 0, modelId);
  } };
  const executor = new Executor(db, working, catalog());
  executor.start(run.id);
  await begun;
  const cancelled = db.getRun(run.id)!;
  cancelled.status = "cancelled";
  db.saveRun(cancelled);
  executor.cancel(run.id);
  await assert.rejects(executor.tasks.get(run.id)!.promise, { name: "AbortError" });
  const [attempt] = db.getRun(run.id)!.plan.nodes[0].attempts;
  assert.equal(attempt.turns, 7);
  assert.deepEqual(attempt.tool_calls.map((call) => call.detail), ["make test"]);
  assert.ok(attempt.trace && readFileSync(attempt.trace, "utf8").includes("the whole output"));
  assert.ok(attempt.trace.startsWith(join(folder(), "data")));
});

test("the final result comes from the graph's end steps, not the list's order", async () => {
  const nodes = [TaskNodeSchema.parse({ id: "report", title: "Report", instructions: "report", capability: "research", model_id: "mock:local", dependencies: ["data"] }),
    TaskNodeSchema.parse({ id: "data", title: "Data", instructions: "data", capability: "research", model_id: "mock:local" })];
  const db = newDb();
  db.saveRun(graphRun(nodes));
  await new Executor(db, new Fixed(), catalog()).execute("graph");
  assert.equal(db.getRun("graph")!.final_result, "out report");
});

test("parallel end steps are all in the final result", async () => {
  const nodes = ["left", "right"].map((key) => TaskNodeSchema.parse({ id: key, title: key[0].toUpperCase() + key.slice(1), instructions: key, capability: "research", model_id: "mock:local" }));
  const db = newDb();
  db.saveRun(graphRun(nodes));
  await new Executor(db, new Fixed(), catalog()).execute("graph");
  assert.equal(db.getRun("graph")!.final_result, "Left:\nout left\n\nRight:\nout right");
});

test("finished work is kept when the model it used left the catalog", async () => {
  const node = TaskNodeSchema.parse({ id: "only", title: "Only", instructions: "only", capability: "coding", model_id: "cli:codex", estimated_cost_usd: 0.25 });
  const db = newDb();
  db.saveRun(graphRun([node]));
  await new Executor(db, new Fixed("openai:removed"), catalog()).execute("graph");
  const result = db.getRun("graph")!;
  assert.ok(result.status === "succeeded" && result.plan.nodes[0].result === "out only");
  assert.equal(result.actual_cost_usd, 0.25);
});

test("a CLI contract call gets cost limits but no call counting", async () => {
  // The provider refuses a call that must count tool calls on a channel that cannot.
  const [executor, db] = setupExecutor(folder(), [contractNode()]);
  const run = db.getRun("artifacts")!;
  const seen: Record<string, any> = {};
  const call = async (budget: Record<string, any>) => {
    seen[budget.context.purpose] = budget;
    return new ProviderResult("ok", 1, 1, "x");
  };
  await executor.charged(run, run.plan.nodes[0], "cli:codex", call as never, { work: true });
  const cli = seen.work;
  assert.ok(cli.turnRemaining === null && cli.beginTool === null && cli.toolRemaining === null);
  assert.ok(cli.stepRemaining !== null);
  await executor.charged(run, run.plan.nodes[0], "test:worker", call as never, { work: true });
  assert.ok(seen.work.turnRemaining !== null && seen.work.beginTool !== null);
});
