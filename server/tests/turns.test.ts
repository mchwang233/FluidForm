// The optional turn limit and the contract limits: tests/test_turns.py, ported.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, test } from "node:test";
import * as activity from "../src/activity.js";
import { StepLimitExceeded } from "../src/budget.js";
import { settings } from "../src/config.js";
import { Database } from "../src/db.js";
import { Executor } from "../src/executor.js";
import { ExecutionRunSchema, folderId, ModelProfileSchema, type TaskNode, TaskNodeSchema } from "../src/models.js";
import { type CompleteOptions, ProviderResult } from "../src/providers.js";
import { ModelUnavailable } from "../src/quota.js";
import { turnsFor } from "../src/recovery.js";
import { stepKey } from "../src/review.js";
import { contractNode, setupExecutor } from "./helpers/artifacts.js";
import { conftest } from "./helpers/conftest.js";

const { folder } = conftest();
// These tests are about the optional turn limit, which is off by default.
beforeEach(() => {
  settings.api_agent_max_turns = 40;
});

const model = (id: string, coding: number, channel = "api") => ModelProfileSchema.parse({ id, provider: id.split(":")[0], display_name: id, channel,
  context_window: 1_000_000, input_per_million: 1, output_per_million: 1, execution_priority: channel === "cli" ? 0 : 100, scores: { coding, planning: 80, reliability: 90 } });
const MODELS = Object.fromEntries([model("x:flash", 90), model("cli:claude", 96, "cli")].map((m) => [m.id, m]));
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const noOutput = async () => undefined;

/** The API model always runs out of turns; the CLI finishes. */
class Providers {
  calls: [string, number | null | undefined][] = [];
  configuredModels(ids: Iterable<string>) {
    return new Set(ids);
  }

  async complete(modelId: string, _prompt: string, options: CompleteOptions = {}): Promise<ProviderResult> {
    this.calls.push([modelId, options.max_turns]);
    if (modelId === "cli:claude") return new ProviderResult("done", 0, 0, modelId);
    options.tool_log!.push({ turn: 1, tool: "read_file", detail: "app.js", ok: true }, { turn: 2, tool: "run_command", detail: "pytest", ok: false });
    return new ProviderResult("进度：写完了 app.js，测试还没过", 10, 10, modelId, { turns: options.max_turns!, turn_limit: true });
  }
}

/** The build finishes; the flash verifier runs out of turns after writing a passing verdict. */
class VerifierProviders extends Providers {
  override async complete(modelId: string, _prompt: string, options: CompleteOptions = {}): Promise<ProviderResult> {
    this.calls.push([modelId, options.max_turns]);
    if (modelId === "cli:claude") return new ProviderResult("done\nVERDICT: PASS", 0, 0, modelId);
    return new ProviderResult("PASS 63 / FAIL 0，还在做收尾检查\nVERDICT: PASS", 10, 10, modelId, { turns: options.max_turns!, turn_limit: true });
  }
}

function unavailable(usage = true) {
  const error = new ModelUnavailable("test:worker", new Date(), "quota exhausted") as ModelUnavailable & { usage?: ProviderResult };
  if (usage) error.usage = new ProviderResult("", 1000, 1000, "test:worker", { turns: 1 });
  return error;
}

test("harder steps get more turns", () => {
  const turns = Object.fromEntries(["easy", "normal", "hard"].map((d) => [d, turnsFor(TaskNodeSchema.parse({ id: "n", title: "t", instructions: "i", capability: "coding", difficulty: d }))]));
  assert.deepEqual(turns, { easy: 40, normal: 60, hard: 80 });
});

test("a model out of turns twice makes way for a stronger one", async () => {
  Object.assign(settings, { workspace_root: join(folder(), "workspaces"), review_nodes: false, max_node_attempts: 3 });
  const db = new Database(join(folder(), "test.db"));
  db.saveRun(ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "queued", budget_usd: 1, use_cli: true,
    plan: { summary: "s", nodes: [{ id: "n", title: "Build", instructions: "build", capability: "coding", model_id: "x:flash", difficulty: "hard" }] } }));
  const providers = new Providers();
  await new Executor(db, providers, MODELS).execute("r");
  const node = db.getRun("r")!.plan.nodes[0];
  assert.equal(node.status, "succeeded");
  // The API-first policy kept the flash model for the first retry; two limits later the CLI takes over.
  assert.deepEqual(providers.calls.map((call) => call[0]), ["x:flash", "x:flash", "cli:claude"]);
  assert.equal(providers.calls[0][1], turnsFor(node));
  const first = node.attempts[0];
  // Unreviewed, a progress summary is not taken for finished work.
  assert.deepEqual([first.outcome, first.turn_limit, first.turns], ["rejected", true, turnsFor(node)]);
  assert.deepEqual(first.tool_calls.map((c) => [c.turn, c.tool, c.ok]), [[1, "read_file", true], [2, "run_command", false]]);
  assert.ok(node.attempts.at(-1)!.model_id === "cli:claude" && !node.attempts.at(-1)!.turn_limit);
});

test("a verifier out of turns is retried without sending back the work it verifies", async () => {
  Object.assign(settings, { workspace_root: join(folder(), "workspaces"), review_nodes: false, auto_diagnose: false, max_node_attempts: 3 });
  const db = new Database(join(folder(), "test.db"));
  db.saveRun(ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "queued", budget_usd: 1, use_cli: true, plan: { summary: "s", nodes: [
    { id: "a", title: "Build", instructions: "build", capability: "coding", model_id: "cli:claude" },
    { id: "v", title: "Check", instructions: "verify", capability: "coding", model_id: "x:flash", dependencies: ["a"], verifies: ["a"] }] } }));
  const executor = new Executor(db, new VerifierProviders(), MODELS);
  const events: string[] = [];
  const emit = executor.emit.bind(executor);
  executor.emit = (runId, kind, data = {}) => {
    events.push(kind);
    emit(runId, kind, data);
  };
  await executor.execute("r");
  const run = db.getRun("r")!;
  const [build, check] = run.plan.nodes;
  assert.ok(!events.includes("run.rework") && run.rework_rounds === 0);
  // The verified step keeps its result and generation; only the verifier is retried.
  assert.ok(build.status === "succeeded" && build.generation === 0 && build.attempts.length === 1);
  assert.deepEqual(check.attempts.map((a) => a.outcome), ["rejected", "rejected", "passed"]);
  // Two turn limits on the flash model hand the verification to the stronger CLI.
  assert.deepEqual(check.attempts.map((a) => a.model_id), ["x:flash", "x:flash", "cli:claude"]);
  assert.equal(check.status, "succeeded");
});

test("an artifact's turn limit adds up across retries, and resuming cannot reset it", async () => {
  const [executor, db, providers] = setupExecutor(folder(), [contractNode("vdb", undefined, [], undefined, { contract: { max_turns: 2 } })], noOutput);
  settings.max_node_attempts = 10;
  await executor.execute("artifacts");
  const run = db.getRun("artifacts")!;
  const node = run.plan.nodes[0];
  assert.ok(node.status === "blocked" && node.contract_turns === 2);
  assert.deepEqual(providers.calls, ["vdb", "vdb"]);
  assert.deepEqual(node.attempts.map((a) => a.outcome), ["unverified", "stopped"]);
  assert.ok(node.review!.includes("轮次上限") && node.attempts.at(-1)!.tool_calls.length);
  near(run.actual_cost_usd, node.attempts.reduce((sum, a) => sum + a.cost_usd, 0));
  run.status = "queued";
  node.status = "pending";
  node.failed_attempts = 0;
  db.saveRun(run);
  await new Executor(db, providers, executor.modelLookup).execute("artifacts");
  assert.deepEqual(providers.calls, ["vdb", "vdb"]);
  assert.equal(db.getRun("artifacts")!.plan.nodes[0].attempts.at(-1)!.outcome, "stopped");
});

test("a step stopped at its limit tells the user why and what they can do, not the model's instructions", async () => {
  const [executor, db] = setupExecutor(folder(), [contractNode("vdb", undefined, [], undefined, { contract: { max_turns: 2 } })], noOutput);
  settings.max_node_attempts = 10;
  await executor.execute("artifacts");
  const diagnosis = db.getRun("artifacts")!.diagnoses.find((item) => item.trigger === "artifact_contract")!;
  const report = diagnosis.report!;
  assert.ok(report.includes("轮次上限 2") && report.includes("coverage.vdb"), report);
  for (const instruction of ["Artifact contract", "acceptance_commands", "{", "Write every declared output"]) assert.ok(!report.includes(instruction), report);
  assert.ok(diagnosis.user_action && diagnosis.user_action.includes("负责人"), diagnosis.user_action ?? "");
});

test("an artifact's cost limit stops it instead of a budget pause or a retry", async () => {
  const [executor, db, providers] = setupExecutor(folder(), [contractNode("vdb", undefined, [], undefined, { contract: { max_cost_usd: 0.002 } })], noOutput);
  settings.auto_diagnose = true;
  await executor.execute("artifacts");
  const run = db.getRun("artifacts")!;
  assert.equal(run.status, "incomplete");
  assert.deepEqual(providers.calls, ["vdb"]);
  near(run.actual_cost_usd, 0.002);
  const node = run.plan.nodes[0];
  assert.ok(node.attempts.at(-1)!.outcome === "stopped" && node.review!.includes("费用上限"));
  near(node.contract_cost_usd, 0.002);
});

test("an artifact's quota error at its declared limit stops before switching models", async () => {
  const [executor, db, providers] = setupExecutor(folder(), [contractNode("vdb", undefined, [], undefined, { contract: { max_turns: 1 } })], async () => {
    throw unavailable();
  });
  await executor.execute("artifacts");
  const run = db.getRun("artifacts")!;
  assert.equal(run.status, "incomplete");
  assert.ok(providers.calls.length === 1 && run.plan.nodes[0].attempts.at(-1)!.outcome === "stopped");
  near(run.plan.nodes[0].attempts.at(-1)!.cost_usd, 0.002);
});

test("the tool allowance survives a retry, a switch, rework and a restart", async () => {
  const extraCalls: string[] = [];
  let providers!: ReturnType<typeof setupExecutor>[2];
  const [executor, db, made] = setupExecutor(folder(), [contractNode("vdb", undefined, [], undefined, { contract: { max_turns: 3 } })], async (node, workspace, options) => {
    await (options.spend_ok as { beginTool(): Promise<void> }).beginTool();
    extraCalls.push(node.id);
    writeFileSync(join(workspace, "partial.txt"), "keep partial work");
    providers.authorized.delete("test:worker");
    throw unavailable();
  });
  providers = made;
  const backup = ModelProfileSchema.parse({ ...executor.modelLookup["test:worker"], id: "test:backup" });
  executor.modelLookup[backup.id] = backup;
  providers.authorized.add(backup.id);
  await executor.execute("artifacts");
  const run = db.getRun("artifacts")!;
  const node = run.plan.nodes[0];
  assert.equal(run.status, "incomplete");
  assert.deepEqual(node.attempts.map((a) => a.model_id), ["test:worker", "test:backup"]);
  assert.equal(node.attempts.at(-1)!.outcome, "stopped");
  assert.ok(node.contract_tool_calls === 3 && node.contract_turns === 2);
  assert.equal(providers.actualCalls.length + extraCalls.length, 3);
  assert.ok(node.review!.includes("工具调用上限"));
  near(run.actual_cost_usd, 0.004);
  assert.equal(readFileSync(join(settings.workspace_root, folderId(run), "partial.txt"), "utf8"), "keep partial work");
  // A manual resume, a rework generation and a newly made executor keep both counters.
  run.status = "queued";
  node.status = "pending";
  node.failed_attempts = 0;
  node.generation += 1;
  db.saveRun(run);
  await new Executor(db, providers, executor.modelLookup).execute(run.id);
  const restored = db.getRun(run.id)!.plan.nodes[0];
  assert.ok(restored.contract_tool_calls === 3 && restored.contract_turns === 2);
  assert.ok(restored.attempts.length === 2 && providers.actualCalls.length + extraCalls.length === 3);
  const blocked = db.events(run.id).filter((e) => e.kind === "node.blocked").at(-1)!.data as Record<string, any>;
  assert.equal(blocked.started, false);
  assert.equal(blocked.actual_counts.vdb.tool_calls, 3);
  assert.equal(blocked.actual_counts.vdb.requests, 2);
});

test("parallel delegated tool calls share their ancestor's allowance, atomically", async () => {
  const parent = contractNode("parent", undefined, [], undefined, { contract: { max_turns: 3 } });
  const children: TaskNode[] = Array.from({ length: 6 }, (_, i) => TaskNodeSchema.parse({ id: `child-${i}`, title: "child", instructions: "work", capability: "coding",
    model_id: "test:worker", delegation_parent_id: parent.id }));
  const [executor, db] = setupExecutor(folder(), [parent, ...children]);
  const run = db.getRun("artifacts")!;
  const started: string[] = [];
  // Queue the requests on the same lock to exercise the check-and-debit race explicitly.
  let release!: () => void;
  const held = executor.locked(run.id, () => new Promise<void>((done) => (release = done)));
  const invoke = async (child: TaskNode, budget: { beginTool(): Promise<void> }) => {
    await budget.beginTool();
    started.push(child.id);
    await Promise.resolve();
    return new ProviderResult("done", 0, 0, "test:worker");
  };
  const pending = children.map((child) => executor.charged(run, child, child.model_id!, ((budget: never) => invoke(child, budget)) as never, { work: true }));
  await Promise.resolve();
  release();
  await held;
  const results = await Promise.allSettled(pending);
  assert.equal(started.length, 3);
  assert.equal(results.filter((item) => item.status === "rejected" && item.reason instanceof StepLimitExceeded).length, 3);
  assert.equal(db.getRun(run.id)!.plan.nodes[0].contract_tool_calls, 3);
  assert.equal(db.getRun(run.id)!.plan.nodes[0].contract_turns, 0);
  const restored = new Executor(db, executor.providers, executor.modelLookup);
  await assert.rejects(restored.charged(run, children.at(-1)!, "test:worker", ((budget: never) => invoke(children.at(-1)!, budget)) as never, { work: true }),
    (error: Error) => error instanceof StepLimitExceeded && error.message.includes("工具调用上限"));
  assert.equal(started.length, 3);
});

test("a request cap still holds when no tools are called", async () => {
  const [executor, db] = setupExecutor(folder(), [contractNode("vdb", undefined, [], undefined, { contract: { max_turns: 2 } })]);
  const run = db.getRun("artifacts")!;
  const node = run.plan.nodes[0];
  const requests: boolean[] = [];
  const request = (async (budget: { beginTurn(): Promise<void> }) => {
    await budget.beginTurn();
    requests.push(true);
    return new ProviderResult("no tools", 0, 0, "test:worker");
  }) as never;
  for (let i = 0; i < 2; i += 1) await executor.charged(run, node, node.model_id!, request, { work: true });
  await assert.rejects(executor.charged(run, node, node.model_id!, request, { work: true }),
    (error: Error) => error instanceof StepLimitExceeded && error.message.includes("轮次上限"));
  const saved = db.getRun(run.id)!.plan.nodes[0];
  assert.ok(requests.length === saved.contract_turns && saved.contract_turns === 2 && saved.contract_tool_calls === 0);
});

test("a failed save of an attempt keeps this answer and the unfinished tools", async () => {
  Object.assign(settings, { review_nodes: false, max_node_attempts: 1 });
  const db = new Database(join(folder(), "save.db"));
  db.saveRun(ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "queued", budget_usd: 1,
    plan: { summary: "s", nodes: [{ id: "n", title: "Build", instructions: "build", capability: "coding", model_id: "x:flash" }] } }));
  const saveRun = db.saveRun.bind(db);
  const failed: boolean[] = [];
  db.saveRun = (run) => {
    if (run.plan.nodes[0].attempts.length && !failed.length) {
      failed.push(true);
      throw new Error("simulated persistence failure");
    }
    saveRun(run);
  };
  class Answering extends Providers {
    override async complete(modelId: string, _prompt: string, options: CompleteOptions = {}): Promise<ProviderResult> {
      activity.noteLine('{"type":"item.started","item":{"id":"long","type":"command_execution","command":"check"}}');
      mkdirSync(dirname(options.tool_trace!), { recursive: true });
      writeFileSync(options.tool_trace!, "raw evidence\n");
      return new ProviderResult("THIS attempt's answer", 0, 0, modelId);
    }
  }
  const executor = new Executor(db, new Answering(), MODELS);
  await executor.execute("r");
  const saved = db.getRun("r")!.plan.nodes[0];
  assert.ok(failed.length && saved.attempts.length === 1);
  const [attempt] = saved.attempts;
  assert.equal(attempt.outcome, "error");
  assert.ok(attempt.reason!.includes("simulated persistence failure"));
  assert.equal(attempt.result, "THIS attempt's answer");
  assert.equal(saved.result, attempt.result);
  assert.equal(attempt.result_source, "provider");
  assert.equal(attempt.tool_calls.length, 1);
  assert.equal(attempt.tool_calls[0].ok, null);
  assert.equal(attempt.tool_calls[0].status, "incomplete");
  assert.ok(attempt.tool_calls[0].diagnostic);
  assert.ok(attempt.trace);
  assert.ok(!executor.toolLogs.has(stepKey("r", "n")));
});

test("taking a snapshot of the log does not use up the evidence before a save works", () => {
  const executor = new Executor(new Database(join(folder(), "snapshot.db")), new Providers(), MODELS);
  executor.toolLogs.set(stepKey("r", "n"), [{ turn: 0, tool: "command", ok: null, running: true }]);
  const first = executor.takeLog("r", "n");
  const second = executor.takeLog("r", "n");
  assert.deepEqual(first.tool_calls, second.tool_calls);
  assert.ok(first.tool_calls.length);
  assert.equal(executor.toolLogs.get(stepKey("r", "n"))![0].running, true);
});
