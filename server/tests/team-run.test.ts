// Employees delegating work while a task runs: tests/test_team.py, ported.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { StepLimitExceeded } from "../src/budget.js";
import { settings } from "../src/config.js";
import { Database } from "../src/db.js";
import { Executor } from "../src/executor.js";
import { CapabilityScoreFields, DecisionSchema, type ExecutionRun, ExecutionRunSchema, ModelProfileSchema, NodeAttemptSchema, TaskNodeSchema } from "../src/models.js";
import { ProviderResult } from "../src/providers.js";
import type { Task } from "../src/tasks.js";
import * as team from "../packages/planning/src/team-planning.js";
import { contractNode } from "./helpers/artifacts.js";
import { conftest } from "./helpers/conftest.js";

const { folder } = conftest();
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const all95 = Object.fromEntries(Object.keys(CapabilityScoreFields).map((key) => [key, 95]));
const models = () => ["build", "verify"].map((name) => ModelProfileSchema.parse({ id: `test:${name}`, provider: "test", display_name: name, scores: all95,
  scores_source: "artificial_analysis", context_window: 200000, max_output_tokens: 4096, input_per_million: 1, output_per_million: 1, supports_tools: true }));
const lookup = () => Object.fromEntries(models().map((m) => [m.id, m]));
const ids = () => new Set(models().map((m) => m.id));
const employees = () => [{ id: "builder", name: "开发", role: "实现模块并集成", model_id: "test:build", capabilities: ["coding"] },
  { id: "tester", name: "验证", role: "独立检验", model_id: "test:verify", capabilities: ["coding", "research"] }];
const request = (overrides: Record<string, unknown> = {}) => ({ request_id: "check-parser", reason: "需要独立研究", tasks: [{ key: "research", title: "检验解析逻辑",
  instructions: "check parser semantics", capability: "research", difficulty: "normal", employee_id: "tester", acceptance_criteria: "给出边界情况和证据", dependencies: [], ...overrides }] });
const runWithTeam = (): ExecutionRun => ExecutionRunSchema.parse({ id: "team-run", prompt: "完成完整模块，保留兼容性", budget_usd: 10, status: "queued",
  plan: { summary: "module", nodes: [{ id: "parent", title: "实现模块", instructions: "build", capability: "coding", files: ["app.py"], employee_id: "builder", model_id: "test:build" }],
    employees: employees(), team_brief: "接口不变；通过独立验证才交付" } });
const nobody = {} as never;
const within = <T>(work: Promise<T>, seconds = 5) => Promise.race([work, new Promise<never>((_, fail) => setTimeout(() => fail(new Error("timed out")), seconds * 1000).unref())]);

class Workers {
  calls: [string, string][] = [];
  constructor(readonly answer: (calls: number) => string) {}
  configuredModels() {
    return ids();
  }

  async complete(modelId: string, prompt: string): Promise<ProviderResult> {
    this.calls.push([modelId, prompt]);
    return new ProviderResult(this.answer(this.calls.length), 100, 100, modelId);
  }
}

test("a parent hands off; the child runs on its employee; then the parent finishes", async () => {
  Object.assign(settings, { review_nodes: false, lead_decisions: false });
  const db = new Database(join(folder(), "team.db"));
  db.saveRun(runWithTeam());
  const workers = new Workers((n) => (n === 1 ? "DELEGATE_TASKS\n" + JSON.stringify(request()) : n === 2 ? "子任务证据已确认" : "完成集成"));
  await within(new Executor(db, workers, lookup()).execute("team-run"));
  const run = db.getRun("team-run")!;
  assert.equal(run.status, "succeeded", run.error ?? "");
  assert.deepEqual(workers.calls.map(([id]) => id), ["test:build", "test:verify", "test:build"]);
  assert.ok(workers.calls[2][1].includes("子任务证据已确认"));
  assert.deepEqual(run.plan.nodes[0].attempts.map((a) => a.outcome), ["delegated", "passed"]);
  near(run.actual_cost_usd, 0.0006);
});

test("a cancelled task turns down a late delegation but keeps its usage", async () => {
  const db = new Database(join(folder(), "cancel.db"));
  const given = runWithTeam();
  given.status = "cancelled";
  db.saveRun(given);
  await new Executor(db, nobody, lookup()).delegateResult(given.id, "parent", request(), new ProviderResult("request", 100, 100, "test:build"), [], [], 0.0002, 0);
  const run = db.getRun(given.id)!;
  assert.ok(run.status === "cancelled" && run.plan.nodes.length === 1);
  assert.equal(run.plan.nodes[0].attempts[0].outcome, "cancelled");
  near(run.actual_cost_usd, 0.0002);
});

test("a restart resumes the parent's own history with the child's verified result", async () => {
  const db = new Database(join(folder(), "resume.db"));
  const run = runWithTeam();
  db.saveRun(run);
  const conversation = new Executor(db, nobody, lookup()).conversation(run, run.plan.nodes[0]);
  conversation.modelId = "test:build";
  conversation.state = { provider: "openai", history: [{ role: "assistant", content: "saved-progress" }] };
  conversation.save();
  const [child] = await team.delegate(run, run.plan.nodes[0], request(), models(), ids());
  run.plan.nodes[0].attempts.push(NodeAttemptSchema.parse({ model_id: "test:build", outcome: "delegated" }));
  child.status = "succeeded";
  child.result = "checked boundary evidence";
  child.attempts.push(NodeAttemptSchema.parse({ model_id: "test:verify", outcome: "passed" }));
  db.saveRun(run);
  const saved = db.getRun(run.id)!;
  const restored = new Executor(db, nobody, lookup()).conversation(saved, saved.plan.nodes[0]);
  assert.equal((restored.state as any).history[0].content, "saved-progress");
  assert.ok(restored.followup!.includes("checked boundary evidence"));
});

test("dispatch runs an employee's tasks together, within the provider's capacity", async () => {
  for (const [capacity, expected] of [[1, ["parent"]], [3, ["parent", "next", "other"]]] as const) {
    settings.provider_limits = { test: { concurrency: capacity } };
    const db = new Database(join(folder(), `dispatch-${capacity}.db`));
    const run = runWithTeam();
    run.plan.nodes.push(TaskNodeSchema.parse({ ...run.plan.nodes[0], id: "next" }), TaskNodeSchema.parse({ ...run.plan.nodes[0], id: "other", employee_id: "tester", model_id: "test:verify" }));
    db.saveRun(run);
    const executor = new Executor(db, nobody, lookup());
    const started: string[] = [];
    let release!: () => void;
    const released = new Promise<void>((done) => (release = done));
    executor.executeNode = async (_runId, nodeId) => {
      started.push(nodeId);
      await released;
    };
    const running = new Map<Task<void>, string>();
    executor.dispatch(run, running);
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(started, expected);
    release();
    await Promise.all([...running.keys()].map((task) => task.promise));
  }
});

test("delegated requests share their ancestor's cost and turn limits after a restart", async () => {
  const db = new Database(join(folder(), "budget.db"));
  const run = runWithTeam();
  const parent = contractNode("parent", null as never, [], "app.py", { employee_id: "builder" });
  parent.model_id = "test:build";
  parent.artifact_contract!.max_turns = 2;
  run.plan.nodes = [parent];
  const [child] = await team.delegate(run, parent, request(), models(), ids());
  db.saveRun(run);
  const call = (async (budget: { beginTurn(): Promise<void>; record(id: string, input: number, output: number): Promise<void> }) => {
    await budget.beginTurn();
    await budget.record("test:verify", 100, 100);
    return new ProviderResult("done", 100, 100, "test:verify");
  }) as never;
  let executor!: Executor;
  for (let i = 0; i < 2; i += 1) {
    executor = new Executor(db, nobody, lookup());
    await executor.charged(run, child, "test:verify", call, { work: true });
  }
  await assert.rejects(executor.charged(run, child, "test:verify", call, { work: true }), StepLimitExceeded);
  const saved = db.getRun(run.id)!;
  near(saved.actual_cost_usd, 0.0004);
  near(saved.plan.nodes[0].contract_cost_usd, 0.0004);
  assert.equal(saved.plan.nodes[0].contract_turns, 2);
});

test("a failed child keeps its parent from claiming it is done", async () => {
  Object.assign(settings, { review_nodes: false, lead_decisions: false });
  const db = new Database(join(folder(), "child-failure.db"));
  db.saveRun(runWithTeam());
  const workers = new Workers((n) => (n === 1 ? "DELEGATE_TASKS\n" + JSON.stringify(request()) : "BLOCKED: missing evidence"));
  await within(new Executor(db, workers, lookup()).execute("team-run"));
  const saved = db.getRun("team-run")!;
  assert.equal(saved.status, "incomplete");
  assert.deepEqual(workers.calls.map(([id]) => id), ["test:build", "test:verify"]);
  assert.notEqual(saved.plan.nodes[0].status, "succeeded");
});

test("a step already finished cannot publish a second graph of children", async () => {
  const db = new Database(join(folder(), "late.db"));
  const run = runWithTeam();
  run.status = "running";
  run.plan.nodes[0].status = "succeeded";
  db.saveRun(run);
  await new Executor(db, nobody, lookup()).delegateResult(run.id, "parent", request(), new ProviderResult("request", 0, 0, "test:build"), [], [], 0, 0);
  const restored = db.getRun(run.id)!;
  assert.equal(restored.plan.nodes.length, 1);
  assert.equal(restored.plan.nodes[0].status, "succeeded");
});

/** A step under a turn limit on ``builder``, which the lead moved from the stronger CLI to a weaker one. */
function switchedRun(): [ExecutionRun, Record<string, ReturnType<typeof ModelProfileSchema.parse>>] {
  const scored = (id: string, score: number) => ModelProfileSchema.parse({ id, provider: id.split(":")[0], display_name: id, channel: "cli",
    scores: { ...all95, coding: score }, scores_source: "artificial_analysis", context_window: 200000, max_output_tokens: 4096,
    input_per_million: 0, output_per_million: 0, supports_tools: true });
  const strong = scored("cli:strong", 97.6);
  const weak = scored("cli:weak", 88.1);
  const run = runWithTeam();
  run.status = "running";
  const step = contractNode("verify", "coverage_vdb", [], "out.txt", { employee_id: "builder", quality_threshold: 90, contract: { max_turns: 90, max_cost_usd: 4 } });
  step.model_id = weak.id;
  run.plan.nodes = [step];
  run.plan.employees = [{ ...employees()[0], model_id: strong.id }];
  run.decisions.push(DecisionSchema.parse({ node_id: step.id, event: "failed", action: "switch_model", model_id: weak.id }));
  return [run, { [strong.id]: strong, [weak.id]: weak }];
}

test("a model the lead switched a limited step to keeps it, below the quality threshold", async () => {
  const [run, models] = switchedRun();
  const db = new Database(join(folder(), "switched.db"));
  db.saveRun(run);
  const providers = { configuredModels: () => new Set(Object.keys(models)) } as never;
  const executor = new Executor(db, providers, models);
  assert.ok(await executor.admitToolChannel(run, run.plan.nodes[0]));
  assert.equal(run.plan.nodes[0].model_id, "cli:weak");
  // Without the lead's decision the threshold still holds: the step goes to the model that meets it.
  run.decisions = [];
  assert.ok(await executor.admitToolChannel(run, run.plan.nodes[0]));
  assert.equal(run.plan.nodes[0].model_id, "cli:strong");
});
