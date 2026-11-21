// The executor's small pieces: the ready tests of tests/test_engineer.py, test_safety.py,
// test_call_runtime.py and test_acceptance_off.py, ported.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Workspace } from "../src/agent.js";
import { builtinModels } from "../src/catalog.js";
import { settings } from "../src/config.js";
import { recall, reopen } from "../src/conversation.js";
import { Database } from "../src/db.js";
import { commit, EngineerError, plainLines, readReply } from "../src/engineer.js";
import { Executor } from "../src/executor.js";
import { type ExecutionRun, ExecutionRunSchema, NodeAttemptSchema, type TaskNode, TaskNodeSchema } from "../src/models.js";
import { ProviderResult } from "../src/providers.js";
import { Cancelled } from "../src/tasks.js";
import { contractNode, mockAcceptance, restoreAcceptance, setupExecutor } from "./helpers/artifacts.js";
import { conftest, scoredModels } from "./helpers/conftest.js";
import { MODELS } from "./helpers/lead-run.js";

const { folder } = conftest();
const realRun = Workspace.prototype.run;
afterEach(() => {
  Workspace.prototype.run = realRun;
  restoreAcceptance();
});
const nobody = null as never;
const newDb = (name = "test.db") => new Database(join(folder(), name));

// --- test_engineer ---------------------------------------------------------------------------
const PLAN = "- 目标: 加一个导出按钮\n- 改动: frontend/x.tsx\n- 测试: 导出测试\n- 风险: 无\nSTATUS: PLAN";

test("replies are read with their status and question", () => {
  assert.equal(readReply(PLAN)[1], "plan");
  assert.ok(readReply(PLAN)[0].endsWith("风险: 无"));
  assert.deepEqual(readReply("改好了\nSTATUS: FIXED").slice(0, 2), ["改好了", "fixed"]);
});

test("requests need an engineer that is available, and words", () => {
  const engineer = { configuredModels: (ids: Iterable<string>) => new Set(ids), complete: async () => assert.fail("not called") };
  const executor = new Executor(newDb(), engineer as never, MODELS);
  assert.throws(() => executor.engineerRequest("加一个按钮", "component", "user"), (error: Error) => error instanceof EngineerError && error.message.includes("不可用"));
});

test("a commit takes only the changed files", () => {
  const root = folder();
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(root, "a.py"), "a = 1\n");
  writeFileSync(join(root, "staged.py"), "s = 1\n");
  git("add", "a.py", "staged.py");
  git("commit", "-qm", "start");
  writeFileSync(join(root, "a.py"), "a = 2\n");
  writeFileSync(join(root, "new.py"), "n = 1\n");
  writeFileSync(join(root, "staged.py"), "s = 2\n");
  git("add", "staged.py");
  const sha = commit(root, ["a.py", "new.py"], "平台改动");
  assert.equal(git("rev-parse", "HEAD").trim(), sha);
  assert.deepEqual(git("show", "--name-only", "--format=", "HEAD").split(/\s+/).filter(Boolean).sort(), ["a.py", "new.py"]);
  // The user's own staged change stays staged, outside the commit.
  assert.deepEqual(git("diff", "--cached", "--name-only").split(/\s+/).filter(Boolean), ["staged.py"]);
});

test("a reply without plain lines is kept whole", () => {
  assert.deepEqual(plainLines("改了 api.py\nSTATUS: FIXED"), ["", "", "改了 api.py\nSTATUS: FIXED"]);
});

test("a stopped platform repair says why", () => {
  const db = newDb("t.db");
  const executor = new Executor(db, nobody, {});
  const task = (status: string) => db.saveRun(ExecutionRunSchema.parse({ id: "r", prompt: "p", status, budget_usd: 1, plan: { summary: "s", nodes: [] } }));
  task("cancelled");
  assert.ok(executor.whyStopped("r", new Cancelled()).includes("任务被取消或删除了"));
  task("running");
  assert.ok(executor.whyStopped("r", new Cancelled()).includes("服务重启或停止打断了"));
  assert.ok(executor.whyStopped("r", new TypeError()).includes("TypeError"));
});

// --- test_safety -----------------------------------------------------------------------------
function cliRun(budget: number, actual = 0, otherRunningCost = 0): ExecutionRun {
  return ExecutionRunSchema.parse({ id: "run", prompt: "demo", status: "running", budget_usd: budget, actual_cost_usd: actual, plan: { summary: "demo", nodes: [
    { id: "cli", title: "CLI", instructions: "do", capability: "coding", model_id: "cli:claude" },
    { id: "api", title: "API", instructions: "do", capability: "coding", model_id: "anthropic:claude-sonnet-5", status: "running", estimated_cost_usd: otherRunningCost }] } });
}
function fallbackExecutor(overrides: Record<string, boolean> = {}): Executor {
  const catalog = Object.fromEntries(scoredModels().map((model) => [model.id, model]));
  for (const [id, enabled] of Object.entries(overrides)) catalog[id].enabled = enabled;
  return new Executor(newDb(), nobody, catalog);
}
const allowed = (executor: Executor, run: ExecutionRun, node: TaskNode) => executor.fallbackAllowed(run, node);

test("the fallback needs the API model turned on", () => {
  const run = cliRun(100);
  assert.ok(allowed(fallbackExecutor(), run, run.plan.nodes[0]));
  assert.ok(!allowed(fallbackExecutor({ "anthropic:claude-sonnet-5": false }), run, run.plan.nodes[0]));
});

test("the fallback must fit the budget left by spent and running steps", () => {
  const executor = fallbackExecutor();
  assert.ok(!allowed(executor, cliRun(1e-9), cliRun(1e-9).plan.nodes[0]));
  assert.ok(!allowed(executor, cliRun(1, 1), cliRun(1).plan.nodes[0]));
  const crowded = cliRun(1, 0, 1);
  assert.ok(!allowed(executor, crowded, crowded.plan.nodes[0]));
});

test("steps not on a CLI are unaffected", () => {
  const run = cliRun(0.0001);
  assert.ok(allowed(fallbackExecutor(), run, run.plan.nodes[1]));
});

test("an artifact's acceptance keeps the task's network and host permissions", async () => {
  const checks: [string, boolean, boolean][] = [];
  mockAcceptance(checks);
  const [executor] = setupExecutor(folder(), [contractNode()]);
  await executor.execute("artifacts");
  assert.deepEqual(checks, [["validate coverage.vdb", false, false]]);
});

// --- test_call_runtime -----------------------------------------------------------------------
function savedRun(db: Database): [ExecutionRun, TaskNode] {
  const run = ExecutionRunSchema.parse({ id: "r", prompt: "build", status: "running", budget_usd: 10,
    plan: { summary: "build", nodes: [{ id: "n", title: "Build", instructions: "keep the public API", capability: "coding", model_id: "deepseek:test" }] } });
  db.saveRun(run);
  return [run, run.plan.nodes[0]];
}

test("the executor restores a checkpoint in flight, and a new generation drops it", () => {
  const db = newDb("state.db");
  const [run, node] = savedRun(db);
  const conversation = new Executor(db, nobody, {}).conversation(run, node);
  conversation.modelId = node.model_id;
  conversation.state = { history: [{ role: "user", content: "a critical decision" }] };
  conversation.save();
  const restarted = new Executor(db, nobody, {});
  const restored = restarted.conversation(run, node);
  assert.ok((restored.state as any).history[0].content.includes("critical decision"));
  assert.ok(restored.followup!.includes("restarted"));
  node.generation += 1;
  assert.equal(restarted.conversation(run, node).state, null);
});

test("a model switch's handoff and recall are scoped", () => {
  const db = newDb("state.db");
  const [run, node] = savedRun(db);
  const executor = new Executor(db, nobody, {});
  const original = executor.conversation(run, node);
  original.modelId = node.model_id;
  original.state = { history: [{ role: "assistant", content: "Do not repeat failed check X" }] };
  original.save();
  node.model_id = "anthropic:other";
  const following = executor.conversation(run, node);
  assert.ok(following.handoff!.includes("failed check X") && following.handoff!.includes("RecallHistory"));
  const archiveId = Number(following.handoff!.split("archive_id=").at(-1)!.replace(/\.$/, ""));
  assert.ok(recall(following, { archive_id: archiveId })[1]);
  assert.equal(db.conversationArchive(run.id, "other-node", archiveId), null);
});

test("a declared check that fails blocks a claimed success", async () => {
  const db = newDb("state.db");
  const [run, node] = savedRun(db);
  node.check = "test -f required-output";
  const calls: [string, Record<string, unknown>][] = [];
  Workspace.prototype.run = async function (name: string, args: Record<string, unknown>) {
    calls.push([name, args]);
    return ["required-output missing", false];
  };
  const executor = new Executor(db, nobody, {});
  mkdirSync(folder(), { recursive: true });
  const verdict = await executor.checkResult(run, node, "All tests passed, done!", [], folder());
  assert.ok(!verdict.passed && !verdict.verified && verdict.reason.includes("验收命令失败"));
  assert.deepEqual(calls, [["Bash", { command: node.check }]]);
  assert.equal(executor.toolLogs.get(`${run.id}\0${node.id}`)!.at(-1)!.ok, false);
});

test("a graceful interruption restores without replaying the tools that finished", () => {
  const db = newDb("state.db");
  const [run, node] = savedRun(db);
  const held = new Executor(db, nobody, {}).conversation(run, node);
  held.modelId = node.model_id;
  held.state = { history: [{ role: "user", content: "work" }], calls: [["a", "Write", {}], ["b", "Bash", {}]], results: [["a", "Write", "written"]], provider: "openai" };
  held.save();
  node.attempts.push(NodeAttemptSchema.parse({ model_id: node.model_id, outcome: "cancelled", interrupted: true }));
  const restored = new Executor(db, nobody, {}).conversation(run, node);
  assert.ok(restored.followup && (restored.state as any).calls.length);
  reopen(restored.state as never, "resume");
  assert.deepEqual((restored.state as any).results[0], ["a", "Write", "written"]);
  assert.ok((restored.state as any).results[1][2].toLowerCase().includes("unknown"));
});

// --- test_acceptance_off ---------------------------------------------------------------------
const step = (key: string, fields: Record<string, unknown> = {}) => TaskNodeSchema.parse({ id: key, title: `Step ${key}`, instructions: `do ${key}`, capability: "research",
  model_id: "mock:local", ...fields });

async function runOff(nodes: TaskNode[], replies: Record<string, string>) {
  Object.assign(settings, { acceptance: false, review_nodes: true }); // even so: acceptance off wins
  const db = newDb("t.db");
  db.saveRun(ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "queued", budget_usd: 5, plan: { summary: "s", nodes } }));
  const workers = { prompts: [] as string[], async complete(modelId: string, prompt: string) {
    this.prompts.push(prompt);
    const title = Object.keys(replies).find((key) => prompt.includes(key));
    return new ProviderResult(title ? replies[title] : "done", 10, 10, modelId);
  } };
  const executor = new Executor(db, workers, Object.fromEntries(builtinModels().map((m) => [m.id, m])));
  const finals: string[] = [];
  executor.finalReview = async (runId) => {
    finals.push(runId);
    return false;
  };
  await executor.execute("r");
  return [db.getRun("r")!, workers, finals] as const;
}

test("with acceptance off a finished step passes without a review or its declared check", async () => {
  const [result, workers, finals] = await runOff([step("a", { check: "false", acceptance_criteria: "must be perfect" })], {});
  const [node] = result.plan.nodes;
  assert.ok(result.status === "succeeded" && node.status === "succeeded");
  assert.ok(node.review === "平台未开启验收。" && node.review_passed === null);
  assert.equal(workers.prompts.length, 1); // the step itself, no reviewer
  assert.deepEqual(finals, ["r"]); // the lead's final check of the whole result is still made
});

test("with acceptance off a failing verification sends nothing back", async () => {
  const [result, workers] = await runOff([step("a"), step("v", { dependencies: ["a"], verifies: ["a"] })], { "do v": "Checked.\nVERDICT: FAIL: a is wrong" });
  assert.ok(result.status === "succeeded" && result.rework_rounds === 0);
  assert.equal(workers.prompts.length, 2);
});

test("with acceptance off a step that says it cannot do its work still fails", async () => {
  const [result] = await runOff([step("a")], { "do a": "UNABLE: vcs is not installed here" });
  assert.ok(result.plan.nodes[0].status !== "succeeded" && result.status !== "succeeded");
});

test("with acceptance off a contract step takes its inputs from a finished step with no acceptance evidence", async () => {
  const producer = contractNode("rtl", null as never, [], "rtl.sv");
  const consumer = contractNode("sim", null as never, [{ path: "rtl.sv", kind: "file", source: "dependency" }], "sim.log", { dependencies: ["rtl"] });
  const [executor, db] = setupExecutor(folder(), [producer, consumer]);
  settings.acceptance = false;
  await executor.execute("artifacts");
  const run = db.getRun("artifacts")!;
  assert.deepEqual(run.plan.nodes.map((n) => n.status), ["succeeded", "succeeded"]);
  assert.ok(!run.plan.nodes[0].artifact_evidence || !run.plan.nodes[0].artifact_evidence.accepted);
});
