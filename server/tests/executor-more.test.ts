// The executor's remaining tests from tests/test_agent.py, test_briefing.py, test_capabilities.py,
// test_continue.py, test_critical_path.py, test_direct_planning.py, test_platform_repair.py,
// test_progress.py, test_projects.py, test_quick.py, test_recovery.py, test_retrospect.py,
// test_spread.py, test_supervisor.py and test_tools.py, ported.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as briefing from "../src/briefing.js";
import * as capabilities from "../src/capabilities.js";
import { builtinModels } from "../src/catalog.js";
import { SessionLost } from "../src/cli-channels.js";
import { settings } from "../src/config.js";
import { ContractError } from "../src/contracts.js";
import { Conversation } from "../src/conversation.js";
import { Database } from "../src/db.js";
import { Executor } from "../src/executor.js";
import { CapabilityScoreFields, EngineerJobSchema, type ExecutionRun, ExecutionRunSchema, type ModelProfile, ModelProfileSchema, NodeAttemptSchema,
  PreflightCheckSchema, type SupervisorSession, SupervisorSessionSchema, type TaskNode, TaskNodeSchema } from "../src/models.js";
import { autonomousPlan } from "../src/planner.js";
import * as preflight from "../src/preflight.js";
import * as progress from "../src/progress.js";
import { type CompleteOptions, ProviderResult } from "../src/providers.js";
import * as quality from "../src/quality.js";
import { ModelUnavailable } from "../src/quota.js";
import { criticalCheck } from "../src/review.js";
import { spreadTo } from "../src/routing.js";
import * as selfRepair from "../src/self-repair.js";
import { stepKey } from "../src/review.js";
import { Task } from "../src/tasks.js";
import { contractNode, coverageNodes, setupExecutor } from "./helpers/artifacts.js";
import { conftest, scoredModels } from "./helpers/conftest.js";
import { leadDatabase, MODELS as LEAD_MODELS, model as turnsModel, Team } from "./helpers/lead-run.js";
import { registryWith } from "./helpers/providers.js";

const { folder } = conftest();
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const lookup = (...models: ModelProfile[]) => Object.fromEntries(models.map((m) => [m.id, m]));
const nobody = null as never;
const within = <T>(work: Promise<T>, seconds = 3) => Promise.race([work, new Promise<never>((_, fail) => setTimeout(() => fail(new Error("timed out")), seconds * 1000).unref())]);
const lateEnough = (seconds: number) => new Promise((done) => setTimeout(done, seconds * 1000));

// test_diagnosis's models and one-step task.
const planningModel = (id: string, planning: number, channel = "api") => ModelProfileSchema.parse({ id, provider: id.split(":")[0], display_name: id, channel,
  context_window: 1_000_000, input_per_million: 1, output_per_million: 1, execution_priority: channel === "cli" ? 0 : 100, scores: { coding: 90, planning, reliability: 90 } });
const DIAGNOSIS_MODELS = lookup(planningModel("x:api", 99), planningModel("cli:claude", 90, "cli"));
function oneNodeRun(db: Database): void {
  db.saveRun(ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "queued", budget_usd: 1, use_cli: true,
    plan: { summary: "s", nodes: [{ id: "n", title: "Check", instructions: "run node --check", capability: "coding", model_id: "x:api" }] } }));
}

// --- test_agent ------------------------------------------------------------------------------
test("an API model does project work through tools", async () => {
  process.env.OPENAI_API_KEY = "test";
  Object.assign(settings, { workspace_root: join(folder(), "workspaces"), review_nodes: false });
  const project = join(folder(), "project");
  mkdirSync(project);
  const registry = registryWith([
    { choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "Write", arguments: JSON.stringify({ file_path: "feature.py", content: "print(1)\n" }) } }] } }],
      usage: { prompt_tokens: 1000, completion_tokens: 100 } },
    { choices: [{ message: { content: "Added feature.py" } }], usage: { prompt_tokens: 1000, completion_tokens: 50 } }]);
  const gpt = ModelProfileSchema.parse({ id: "openai:gpt-x", provider: "openai", display_name: "GPT X", context_window: 200_000, input_per_million: 1, output_per_million: 2,
    scores: { coding: 90 } });
  const db = new Database(join(folder(), "test.db"));
  db.saveRun(ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "queued", budget_usd: 1, project_dir: project,
    plan: { summary: "s", nodes: [{ id: "n", title: "Add feature", instructions: "add it", capability: "coding", model_id: gpt.id, needs_workspace: true }] } }));
  await new Executor(db, registry, lookup(gpt)).execute("r");
  const run = db.getRun("r")!;
  assert.ok(run.status === "succeeded" && run.plan.nodes[0].status === "succeeded");
  assert.equal(readFileSync(join(project, "feature.py"), "utf8"), "print(1)\n");
  assert.deepEqual(run.plan.nodes[0].changed_files, ["feature.py"]);
  near(run.actual_cost_usd, (2000 * 1 + 150 * 2) / 1_000_000);
});

// --- test_briefing ---------------------------------------------------------------------------
function briefProject(root: string): string {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "app.py"), "def main():\n    pass\n");
  writeFileSync(join(root, "README.md"), "# Tool\n");
  writeFileSync(join(root, "out.log"), "noise\n");
  writeFileSync(join(root, ".env"), "KEY=secret\n");
  return root;
}

test("an unscoped step gets the files it names and what came before changed", async () => {
  const db = leadDatabase(folder());
  const root = briefProject(join(folder(), "brief"));
  mkdirSync(join(root, "lib"));
  writeFileSync(join(root, "lib", "util.py"), "x = 1\n");
  writeFileSync(join(root, "big.js"), "y\n".repeat(40_000));
  const run = db.getRun("r")!;
  run.plan.nodes[0].changed_files = ["lib/util.py"];
  const step = TaskNodeSchema.parse({ id: "b", title: "B", instructions: "改 app.py 和 big.js，别动 .env", capability: "coding", dependencies: [run.plan.nodes[0].id] });
  const text = briefing.attachedFiles(root, briefing.likelyFiles(root, step, run));
  assert.ok(text.includes("=== app.py (full text, current) ===\ndef main()") && text.includes("=== lib/util.py"));
  assert.ok(!text.includes("big.js") && !text.includes("secret")); // too long to attach; never secrets
});

test("a work package gets its own files and not the project", async () => {
  const db = leadDatabase(folder());
  settings.lead_decisions = false;
  const root = briefProject(join(folder(), "proj"));
  writeFileSync(join(root, "other.py"), "unrelated = True\n");
  const run = db.getRun("r")!;
  run.project_dir = root;
  // The platform now runs the check: this fixture has an app but no pytest suite.
  Object.assign(run.plan.nodes[0], { needs_workspace: true, files: ["app.py"], reads: ["README.md"], check: "python3 -m py_compile app.py" });
  db.saveRun(run);
  const prompts: string[] = [];
  const team = { configuredModels: (ids: Iterable<string>) => new Set(ids), async complete(modelId: string, prompt: string) {
    prompts.push(prompt);
    return new ProviderResult("做完了", 0, 0, modelId);
  } };
  await new Executor(db, team, LEAD_MODELS).execute("r");
  const [prompt, ...more] = prompts;
  assert.equal(more.length, 0);
  assert.ok(prompt.includes("Change only these files (create them if they do not exist): app.py"));
  assert.ok(prompt.includes("=== app.py (full text, current) ===") && prompt.includes("=== README.md"));
  assert.ok(!prompt.includes("other.py") && prompt.includes("Before you finish, run: python3 -m py_compile app.py"));
  assert.ok(prompt.includes("at most 15 lines"));
});

// --- test_capabilities -----------------------------------------------------------------------
const CARD = { name: "飞书发消息", kind: "tool", summary: "向飞书群发一条消息。", usage: "python send.py --chat <id> --text <内容>",
  guide: "- 群 ID 在飞书群设置里\n- 一条消息最多 4000 字", files: ["feishu"], check: "python3 feishu/send.py --help", secrets: ["FEISHU_APP_ID", "FEISHU_APP_SECRET"],
  domains: ["open.feishu.cn"] };

/** A team whose lead names what the task built when asked. */
class Lead extends Team {
  constructor(readonly reply: string) {
    super([], 0);
  }

  override async converse(session: SupervisorSession, prompt: string): Promise<ProviderResult> {
    if (prompt.includes(capabilities.PROMPT)) {
      this.lead.push(prompt);
      return new ProviderResult(this.reply, 0, 0, session.model_id);
    }
    return super.converse(session, prompt);
  }
}

test("a task that succeeded gets its lead's proposals when they are on", async () => {
  const db = leadDatabase(folder());
  settings.capability_proposals = true;
  const executor = new Executor(db, new Lead(JSON.stringify({ capabilities: [CARD] })), LEAD_MODELS);
  await executor.execute("r");
  assert.equal(db.getRun("r")!.status, "succeeded");
  await executor.capabilityTasks.get("r")!.promise;
  const [proposal, ...more] = db.getRun("r")!.capability_proposals;
  assert.equal(more.length, 0);
  assert.ok(proposal.name === "飞书发消息" && proposal.status === "proposed");
  assert.equal(db.events("r").at(-1)!.kind, "run.capabilities_proposed");
});

test("without the setting the lead is not asked", async () => {
  const db = leadDatabase(folder());
  settings.capability_proposals = false;
  const team = new Lead(JSON.stringify({ capabilities: [CARD] }));
  const executor = new Executor(db, team, LEAD_MODELS);
  await executor.execute("r");
  assert.ok(executor.capabilityTasks.size === 0 && !team.lead.some((prompt) => prompt.includes(capabilities.PROMPT)));
  assert.deepEqual(db.getRun("r")!.capability_proposals, []);
});

// --- test_continue ---------------------------------------------------------------------------
const attempt = (fields: Record<string, unknown> = {}) => NodeAttemptSchema.parse({ model_id: "x:api", outcome: "rejected", reason: "缺少 --verbose", turns: 3, tool_calls: [
  { turn: 1, tool: "Read", detail: "app.py (from line 1)", ok: true }, { turn: 2, tool: "Edit", detail: "app.py", ok: true },
  { turn: 3, tool: "Bash", detail: "pytest -q", ok: false }], ...fields });

test("a fresh attempt is told what the last one did", async () => {
  const run = leadDatabase(folder()).getRun("r")!;
  const node = run.plan.nodes[0];
  node.attempts.push(attempt());
  const [prompt] = quality.nodePrompt(node, run, 4000);
  assert.ok(prompt.includes("Files it wrote or edited (still in the working directory): app.py"));
  assert.ok(prompt.includes("failed: pytest -q") && !prompt.includes("Files it read")); // app.py was also edited
});

test("a step goes on only where that still makes sense", async () => {
  const db = leadDatabase(folder());
  const executor = new Executor(db, nobody, LEAD_MODELS);
  const run = db.getRun("r")!;
  const node = run.plan.nodes[0];
  node.model_id = "x:api";
  const held = () => {
    executor.conversations.set(stepKey(run.id, node.id), new Conversation({ modelId: "x:api", state: { history: [{ role: "user" }] } }));
    return executor.conversation(run, node).followup;
  };
  node.attempts = [attempt()];
  assert.ok(held()!.includes("continues in a new attempt") && held()!.includes("缺少 --verbose"));
  node.attempts = [attempt({ reason: progress.STOPPED + "一直在重复同一条命令" })];
  assert.equal(held(), null);
  node.attempts = [attempt({ outcome: "superseded" })];
  assert.equal(held(), null);
  node.attempts = [attempt()];
  node.model_id = "cli:claude";
  assert.equal(held(), null);
  node.model_id = "x:api";
  const later = new Date(new Date(node.attempts.at(-1)!.finished_at).getTime() + 60_000).toISOString();
  run.plan.nodes.push(TaskNodeSchema.parse({ ...run.plan.nodes[0], id: "up", attempts: [attempt({ finished_at: later })] }));
  node.dependencies = ["up"];
  assert.equal(held(), null);
});

// --- test_critical_path ----------------------------------------------------------------------
function waitingTask(blocked = true) {
  const db = new Database(join(folder(), "t.db"));
  db.saveRun(ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "running", budget_usd: 5, supervisor: { model_id: "cli:codex", cwd: folder() }, plan: { summary: "s", nodes: [
    { id: "rtl", title: "实现 RTL", instructions: "i", capability: "coding", difficulty: "hard", status: "running", model_id: "glm:glm" },
    { id: "sva", title: "SVA 断言", instructions: "i", capability: "coding", dependencies: blocked ? ["rtl"] : [] }] } }));
  const lead = { configuredModels: (ids: Iterable<string>) => new Set(ids), converse: async () => assert.fail("not used") };
  const executor = new Executor(db, lead as never, {});
  return [db, executor, db.getRun("r")!.plan.nodes[0]] as const;
}

test("a step others wait for is put to the lead when far past its time", async () => {
  const [db, executor, node] = waitingTask();
  const asked: string[] = [];
  executor.askLead = async (_runId, message) => {
    asked.push(message);
    return "还在调试自己的临时测试平台，拖住了后面所有步骤\nVERDICT: STOP: 太慢，换更快的模型";
  };
  const expected = 25 * settings.minutes_per_turn; // a hard step's turns
  const count = [0];
  // Not yet far past its time: nothing asked.
  assert.equal(await criticalCheck(executor, "r", node, "glm:glm", expected * 1.5, "t17 Edit tb.sv", count), null);
  const reason = await criticalCheck(executor, "r", node, "glm:glm", expected * 2.1, "t17 Edit tb.sv", count);
  assert.ok(reason!.startsWith("这一步挡着后面的步骤") && reason!.includes("换更快的模型"));
  const [message, ...more] = asked;
  assert.equal(more.length, 0);
  assert.ok(message.includes("SVA 断言") && message.includes("glm:glm") && message.includes("switch_model"));
  const [event] = db.events("r").filter((e) => e.kind === "node.critical_overrun_check");
  const data = event.data as Record<string, unknown>;
  assert.ok(data.stop && data.waiting === 1);
});

test("a step nothing waits for runs as long as it needs", async () => {
  const [, executor, node] = waitingTask(false);
  executor.askLead = async () => assert.fail("the lead is not asked");
  assert.equal(await criticalCheck(executor, "r", node, "glm:glm", 500, "evidence", [0]), null);
});

// --- test_direct_planning --------------------------------------------------------------------
const all95 = Object.fromEntries(Object.keys(CapabilityScoreFields).map((key) => [key, 95]));
const PLANNING_MODELS = ["first", "second"].map((name) => ModelProfileSchema.parse({ id: `test:${name}`, provider: "test", display_name: name, scores: all95,
  scores_source: "artificial_analysis", context_window: 100000, input_per_million: 1, output_per_million: 1 }));
const PLANNING_CONFIGURED = new Set(PLANNING_MODELS.map((m) => m.id));
const ROSTER = { team_brief: "保持接口并独立验收", employees: [{ id: "builder", name: "开发", role: "实现模块", model_id: "test:first", capabilities: ["coding"] }] };
const TASKS = { summary: "交付模块", title: "小模块交付。", folder: "small-module", requires: ["python --version"], nodes: [
  { key: "build", title: "实现模块", instructions: "完成模块和本任务自测", capability: "coding", employee_id: "builder", acceptance_criteria: "功能通过自测", provides: "public interface" },
  { key: "check", title: "验收模块", instructions: "根据依赖产物进行验收", capability: "coding", employee_id: "builder", dependencies: ["build"], verifies: ["build"],
    acceptance_criteria: "列出验收证据" }] };
class Planner {
  messages: string[] = [];
  constructor(readonly payload: unknown = TASKS) {}
  async converse(session: SupervisorSession, text: string): Promise<ProviderResult> {
    this.messages.push(text);
    return new ProviderResult(JSON.stringify(text.includes("TEAM_SETUP") ? ROSTER : this.payload), 10, 10, session.model_id);
  }
}
const planned = (provider: Planner = new Planner(), prompt = "实现模块") => {
  settings.employee_teams = true;
  return autonomousPlan(prompt, PLANNING_MODELS, PLANNING_CONFIGURED, provider as never, null, SupervisorSessionSchema.parse({}));
};
const raw = (node: TaskNode): Record<string, any> => {
  const { id, ...rest } = JSON.parse(JSON.stringify(node));
  return { ...rest, key: id };
};

test("a direct plan keeps artifact handoffs and limits", async () => {
  const payload = { summary: "coverage", nodes: coverageNodes().map((n) => ({ ...raw(n), employee_id: "builder" })) };
  const plan = await planned(new Planner(payload), "Collect VDB, produce URG report, audit the delivery");
  assert.deepEqual(plan.nodes.map((n) => n.artifact_contract!.stage), ["coverage_vdb", "urg_report", "delivery_audit"]);
  assert.deepEqual(plan.nodes.at(-1)!.verifies, [plan.nodes[1].id]);
  assert.ok(plan.nodes.every((n) => n.artifact_contract!.max_turns === 3));
  await assert.rejects(planned(new Planner(), "Collect VDB and produce URG report"), ContractError);
});

test("direct tasks are dispatched in dependency order, without a refiner", async () => {
  const given = await planned();
  for (const node of given.nodes) node.model_id = "test:first";
  const run = ExecutionRunSchema.parse({ id: "direct", prompt: "实现模块", status: "running", plan: given, budget_usd: 10 });
  const plan = run.plan;
  const executor = new Executor(new Database(join(folder(), "task.db")), new Planner() as never, lookup(...PLANNING_MODELS));
  const started: string[] = [];
  executor.executeNode = async (_runId, nodeId) => {
    started.push(nodeId);
  };
  let running = new Map<Task<void>, string>();
  await executor.dispatch(run, running);
  await Promise.all([...running.keys()].map((task) => task.promise));
  assert.deepEqual(started, [plan.nodes[0].id]);
  plan.nodes[0].status = "succeeded";
  running = new Map();
  await executor.dispatch(run, running);
  await Promise.all([...running.keys()].map((task) => task.promise));
  assert.deepEqual(started, plan.nodes.map((n) => n.id));
});

// --- test_platform_repair --------------------------------------------------------------------
class DiagnosisProviders {
  configuredModels(ids: Iterable<string>) {
    return new Set(ids);
  }
  async complete(): Promise<ProviderResult> {
    throw new Error("node is not installed");
  }
}

test("a retrospective's change outlives its cancelled source only with the matching job", async () => {
  for (const [origin, matching, exists, allowed] of [["retrospective", true, true, true], ["user", true, true, false], ["retrospective", false, true, false],
    ["retrospective", true, false, false]] as const) {
    const label = `${origin} ${matching} ${exists}`;
    const db = new Database(join(folder(), `${label.replaceAll(" ", "-")}.db`));
    if (exists) {
      oneNodeRun(db);
      const run = db.getRun("r")!;
      run.status = "cancelled";
      db.saveRun(run);
    }
    const executor = new Executor(db, new DiagnosisProviders(), DIAGNOSIS_MODELS);
    const record = { id: "repair", run_id: "r", engineer_job_id: "engineer", status: "validated" } as Record<string, any>;
    db.saveEngineerJob(EngineerJobSchema.parse({ id: "engineer", origin, request: "Improve later tasks", status: "applying", run_id: "r", repair_id: matching ? "repair" : "another" }));
    const launched: unknown[] = [];
    const stopped: unknown[] = [];
    executor.platform.launch = async (job) => {
      launched.push(job);
    };
    executor.platform.save = () => undefined;
    executor.watchPlatform = async () => undefined;
    executor.finishPlatform = (job) => {
      stopped.push(job);
    };
    executor.waitToApply = async () => undefined;
    await executor.activatePlatform(record as never);
    assert.equal(Boolean(launched.length), allowed, label);
    assert.equal(Boolean(stopped.length), !allowed, label);
    if (exists) assert.equal(db.getRun("r")!.status, "cancelled");
    if (!allowed) assert.equal(record.status, "cancelled");
  }
});

test("a change waits only for what a restart must not cut off", async () => {
  // Regression: applying waited until every running task had finished its steps (30 minutes once, hours
  // behind a long regression), though such a task goes on by itself after the restart.
  const db = new Database(join(folder(), "test.db"));
  const executor = new Executor(db, new DiagnosisProviders(), DIAGNOSIS_MODELS);
  const saved = selfRepair.limits.APPLY_WAIT_SECONDS;
  selfRepair.limits.APPLY_WAIT_SECONDS = 0.3;
  settings.resume_after_restart = true;
  try {
    for (const [runId, project] of [["free", null], ["project", folder()]] as const) {
      db.saveRun(ExecutionRunSchema.parse({ id: runId, prompt: "p", status: "paused", budget_usd: 1, project_dir: project, plan: { summary: "s", nodes: [] } }));
    }
    let release!: () => void;
    const forever = new Promise<void>((done) => (release = done));
    // Python's awaits can be cancelled; here the waiting listens for it.
    const waitForever = () => new Task<void>((signal) => new Promise<void>((done, fail) => {
      void forever.then(done);
      signal.addEventListener("abort", () => fail(signal.reason));
    }));
    executor.tasks.set("free", waitForever());
    // A step of a task in no project is cut off once its time is up.
    await within(executor.waitToApply());
    // A step of a task in a project is waited for, as is one when tasks do not go on by themselves.
    const project = waitForever();
    executor.tasks.set("project", project);
    let waiting = executor.waitToApply();
    let done = false;
    void waiting.then(() => (done = true));
    await lateEnough(1);
    assert.ok(!done);
    project.cancel();
    await project.settled();
    await within(waiting);
    settings.resume_after_restart = false;
    waiting = executor.waitToApply();
    done = false;
    void waiting.then(() => (done = true));
    await lateEnough(1);
    assert.ok(!done);
    release();
    await within(waiting);
  } finally {
    selfRepair.limits.APPLY_WAIT_SECONDS = saved;
  }
});

// --- test_progress ---------------------------------------------------------------------------
test("the executor asks another model and records the check", async () => {
  settings.workspace_root = join(folder(), "workspaces");
  const db = new Database(join(folder(), "test.db"));
  oneNodeRun(db);
  const asked: [string, string][] = [];
  const efforts: unknown[] = [];
  const checker = { configuredModels: (ids: Iterable<string>) => new Set(ids), async complete(modelId: string, prompt: string, options: CompleteOptions = {}) {
    asked.push([modelId, prompt]);
    efforts.push(options.effort);
    return new ProviderResult("同一条命令失败了 9 次\nVERDICT: STOP: 反复运行同一条失败的命令", 0, 0, modelId);
  } };
  const executor = new Executor(db, checker, DIAGNOSIS_MODELS);
  const run = db.getRun("r")!;
  const reason = await executor.progressWatch(run, run.plan.nodes[0], "x:api")("- turn 9: run_command node --check app.js  (failed)");
  assert.equal(reason, "反复运行同一条失败的命令");
  // This fixture's CLI is weaker. A fresh call to the producer sees the step and the evidence.
  const [[who, prompt], ...more] = asked;
  assert.equal(more.length, 0);
  assert.ok(who === "x:api" && prompt.includes("run node --check") && prompt.includes("turn 9"));
  assert.deepEqual(efforts, ["low"]); // a quick yes or no, not the step's effort
  const data = db.events("r").filter((e) => e.kind === "node.progress_check").at(-1)!.data as Record<string, unknown>;
  assert.ok(data.stop === true && data.reason === reason);
});

test("a long attempt goes on when no model can check it", async () => {
  // The producing model has no peer able to check it: a check that cannot be made must let the attempt
  // go on (the task's budget still bounds it), never stop work that keeps producing evidence.
  settings.workspace_root = join(folder(), "workspaces");
  const db = new Database(join(folder(), "test.db"));
  oneNodeRun(db);
  const noChecker = { configuredModels: () => new Set<string>(), complete: async () => assert.fail("no model can check this attempt") };
  const executor = new Executor(db, noChecker as never, {});
  const run = db.getRun("r")!;
  const watch = executor.progressWatch(run, run.plan.nodes[0], "cli:codex");
  for (let i = 0; i < 3; i += 1) assert.equal(await watch("回归日志仍在增长，子进程还在运行"), null);
  const checks = db.events("r").filter((event) => event.kind === "node.progress_check").map((event) => event.data as Record<string, unknown>);
  assert.equal(checks.length, 3);
  assert.ok(checks.every((data) => data.stop === false && data.checked === false && data.checker_model_id === null));
});

test("an artifact's limit survives a provider failure after a plain reply", async () => {
  const { ProviderError } = await import("../src/budget.js");
  const [executor, db, providers] = setupExecutor(folder(), [contractNode("vdb", undefined, [], undefined, { contract: { max_turns: 1 } })], async () => {
    throw Object.assign(new ProviderError("truncated reply"), { usage: new ProviderResult("", 1000, 1000, "test:worker", { turns: 1 }) });
  });
  await executor.execute("artifacts");
  const node = db.getRun("artifacts")!.plan.nodes[0];
  assert.ok(node.status === "blocked");
  assert.deepEqual(providers.calls, ["vdb"]);
  assert.ok(node.attempts[0].turns === node.contract_turns && node.contract_turns === 1);
  near(node.attempts[0].cost_usd, 0.002);
  assert.ok(node.review!.includes("truncated reply"));
});

// --- test_projects ---------------------------------------------------------------------------
test("a project's steps run one at a time in the project, without a fallback", async () => {
  const root = join(folder(), "home");
  mkdirSync(join(root, "app"), { recursive: true });
  Object.assign(settings, { project_roots: [root], data_dir: join(root, "app", ".super-partner"), workspace_root: join(folder(), "scratch"), review_nodes: false });
  const project = join(root, "app");
  const nodes = [...[0, 1, 2].map((i) => ({ id: `edit${i}`, title: `Edit ${i}`, instructions: "edit", capability: "coding", model_id: "cli:codex", needs_workspace: true })),
    { id: "notes", title: "Notes", instructions: "write notes", capability: "research", model_id: "cli:gemini" }];
  const db = new Database(join(folder(), "test.db"));
  db.saveRun(ExecutionRunSchema.parse({ id: "proj", prompt: "demo", status: "queued", budget_usd: 1, plan: { summary: "proj", nodes }, project_dir: project }));
  const providers = { calls: [] as [string, boolean, string][], active: 0, peak: 0, async complete(modelId: string, prompt: string, options: CompleteOptions = {}) {
    this.calls.push([options.workspace!, options.allow_api_fallback ?? true, prompt]);
    const inProject = options.workspace === project ? 1 : 0;
    this.active += inProject;
    this.peak = Math.max(this.peak, this.active);
    await lateEnough(0.02);
    this.active -= inProject;
    return new ProviderResult("ok", 0, 0, modelId);
  } };
  await new Executor(db, providers, lookup(...builtinModels())).execute("proj");
  const result = db.getRun("proj")!;
  assert.equal(result.status, "succeeded");
  assert.deepEqual(new Set(result.plan.nodes.map((node) => node.status)), new Set(["succeeded"]));
  const inProject = providers.calls.filter((call) => call[0] === project);
  assert.equal(inProject.length, 3);
  assert.ok(inProject.every(([, fallback, prompt]) => !fallback && prompt.includes(project)));
  assert.equal(providers.peak, 1);
  assert.deepEqual(providers.calls.filter((call) => call[0] !== project).map((call) => call[0]), [join(settings.workspace_root, "proj")]);
  const snapshot = db.events("proj").find((event) => event.kind === "workspace.snapshot")!;
  assert.equal((snapshot.data as Record<string, unknown>).project_dir, project);
});

// --- test_quick ------------------------------------------------------------------------------
function quickSaved(db: Database, difficulty: string): [ExecutionRun, TaskNode] {
  const run = ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "running", budget_usd: 1,
    plan: { summary: "p", nodes: [{ id: "n", title: "头像", instructions: "画", capability: "tool_use", model_id: "x:api", difficulty }] } });
  db.saveRun(run);
  return [run, run.plan.nodes[0]];
}

test("an easy step stands on its own result when easy reviews are off", async () => {
  const db = new Database(join(folder(), "t.db"));
  const executor = new Executor(db, nobody, {}); // no providers: a review would fail
  settings.review_easy_steps = false;
  let [run, node] = quickSaved(db, "easy");
  let verdict = await executor.checkResult(run, node, "画好了 avatar.jpg", [], folder());
  assert.ok(verdict.passed && verdict.reason.includes("简单步骤"));
  // A normal step is still reviewed by another model (here none can: it is left unverified).
  [run, node] = quickSaved(db, "normal");
  verdict = await executor.checkResult(run, node, "画好了", [], folder());
  assert.ok(!verdict.reason.includes("简单步骤") && !(verdict.passed && verdict.verified));
});

test("a passed check stands for the next task alike until it expires", async () => {
  Object.assign(settings, { preflight: true, workspace_root: join(folder(), "ws"), preflight_cache_minutes: 60 });
  preflight.PASSED.clear();
  const db = new Database(join(folder(), "t.db"));
  const executor = new Executor(db, nobody, {});
  const ran: string[] = [];
  executor.allChecks = async (run) => {
    ran.push(run.id);
    return [PreflightCheckSchema.parse({ name: "步骤沙箱", command: "(内置)", ok: true })];
  };
  executor.prepareSkills = async () => [];
  const task = (runId: string, network = false) => db.saveRun(ExecutionRunSchema.parse({ id: runId, prompt: "p", status: "queued", budget_usd: 1, allow_network: network,
    plan: { summary: "s", nodes: [{ id: "n", title: "t", instructions: "i", capability: "coding", model_id: "x:api" }] } }));
  for (const runId of ["a", "b"]) {
    task(runId);
    assert.ok(await executor.preflight(runId));
  }
  assert.deepEqual(ran, ["a"]);
  assert.ok(db.getRun("b")!.preflight!.cached && !db.getRun("a")!.preflight!.cached);
  // A task with other settings is checked; so is one after the cache expires, or with it off.
  task("c", true);
  assert.ok(await executor.preflight("c"));
  assert.deepEqual(ran, ["a", "c"]);
  settings.preflight_cache_minutes = 0;
  task("d");
  assert.ok(await executor.preflight("d"));
  assert.deepEqual(ran, ["a", "c", "d"]);
  preflight.PASSED.clear();
});

// --- test_recovery ---------------------------------------------------------------------------
const RECOVERY_MODELS = [turnsModel("x:flash", 90), turnsModel("x:pro", 85), turnsModel("cli:codex", 95, "cli")];

test("a step failing twice on an API model moves to a CLI", async () => {
  Object.assign(settings, { subtasks_prefer_api: true, workspace_root: join(folder(), "workspaces"), review_nodes: false, auto_diagnose: false, max_node_attempts: 3 });
  const db = new Database(join(folder(), "test.db"));
  db.saveRun(ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "queued", budget_usd: 1, use_cli: true,
    plan: { summary: "s", nodes: [{ id: "n", title: "Build", instructions: "build", capability: "coding", model_id: "x:flash" }] } }));
  const calls: string[] = [];
  const { ProviderError } = await import("../src/budget.js");
  const providers = { configuredModels: (ids: Iterable<string>) => new Set(ids), async complete(modelId: string) {
    calls.push(modelId);
    if (modelId === "x:flash") throw new ProviderError("wrote nothing");
    return new ProviderResult("done", 0, 0, modelId);
  } };
  await new Executor(db, providers, lookup(...RECOVERY_MODELS)).execute("r");
  assert.deepEqual(calls, ["x:flash", "x:flash", "cli:codex"]);
  assert.equal(db.getRun("r")!.plan.nodes[0].status, "succeeded");
});

test("a diagnosis can end a step that cannot be done here", async () => {
  Object.assign(settings, { subtasks_prefer_api: true, workspace_root: join(folder(), "workspaces"), review_nodes: false, auto_diagnose: true });
  const db = new Database(join(folder(), "test.db"));
  const node = (id: string, title: string, deps: string[] = []) => ({ id, title, instructions: title, capability: "coding", model_id: "x:api", dependencies: deps });
  db.saveRun(ExecutionRunSchema.parse({ id: "r", prompt: "做一个网站并部署", status: "queued", budget_usd: 5, use_cli: true, plan: { summary: "网站", nodes: [
    node("build", "构建网站"), node("deploy", "部署上线", ["build"]), node("check", "检查线上页面", ["deploy"]), node("docs", "写使用说明")] } }));
  const calls: string[] = [];
  const { ProviderError } = await import("../src/budget.js");
  const workers = { configuredModels: (ids: Iterable<string>) => new Set(ids), async complete(modelId: string, prompt: string, options: CompleteOptions = {}) {
    if (options.repair) {
      calls.push("diagnose");
      return new ProviderResult("沙箱里没有 iverilog，没有 root 也装不上。\nUSER_ACTION: ROOT: 安装 iverilog\nSTATUS: UNABLE", 0, 0, modelId);
    }
    if (prompt.startsWith("Task: 部署上线")) {
      calls.push("部署上线");
      throw new ProviderError("iverilog: command not found");
    }
    return new ProviderResult(`${prompt.split("\n", 1)[0].replace(/^Task: /, "")}完成`, 0, 0, modelId);
  } };
  await new Executor(db, workers, lookup(...RECOVERY_MODELS, turnsModel("x:api", 90))).execute("r");
  const run = db.getRun("r")!;
  const deploy = run.plan.nodes.find((item) => item.id === "deploy")!;
  assert.ok(run.status === "incomplete" && deploy.status === "unable");
  assert.ok(deploy.unable_reason!.includes("需要你处理：ROOT: 安装 iverilog"));
  assert.equal(calls.filter((c) => c === "部署上线").length, 1);
});

// --- test_retrospect -------------------------------------------------------------------------
test("a task is looked back on when it ends", async () => {
  settings.review_nodes = false; // only the end matters here
  const db = new Database(join(folder(), "t.db"));
  db.saveRun(ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "queued", budget_usd: 1,
    plan: { summary: "s", nodes: [{ id: "n", title: "n", instructions: "i", capability: "planning", model_id: "mock:local" }] } }));
  await new Executor(db, { complete: async (modelId: string) => new ProviderResult("ok", 1, 1, modelId) }, lookup(...builtinModels())).execute("r");
  assert.equal(db.getRun("r")!.status, "succeeded");
  assert.equal((db.retrospective("r") as Record<string, any>).steps[0].id, "n");
});

test("a task's problems are named when it ends", async () => {
  settings.problem_naming = true;
  const db = new Database(join(folder(), "t.db"));
  const models = scoredModels();
  const configured = new Set(models.map((m) => m.id));
  const vcsStep = TaskNodeSchema.parse({ id: "n", title: "冒烟测试", instructions: "i", capability: "coding", model_id: "deepseek:flash", status: "succeeded",
    estimated_cost_usd: 0.01, difficulty: "normal", attempts: [{ model_id: "glm:glm", outcome: "unavailable", reason: "glm request failed: 5 分钟没有回复" },
      { model_id: "deepseek:flash", outcome: "passed", cost_usd: 0.3, turns: 40, tool_calls: [{ turn: 1, tool: "Bash", detail: "source /eda/.edarc && which vcs", ok: false },
        { turn: 2, tool: "Bash", detail: "vcs -sverilog tb.sv", ok: false }] }] });
  db.saveRun(ExecutionRunSchema.parse({ id: "r", prompt: "写一个 FIFO", budget_usd: 2, status: "running", plan: { summary: "s", nodes: [vcsStep] } }));
  const calls: [string, CompleteOptions][] = [];
  const cheap = { configuredModels: () => configured, async complete(modelId: string, prompt: string, options: CompleteOptions = {}) {
    calls.push([modelId, options]);
    const count = prompt.split("Problems:\n")[1].split("\n\n")[0].split("\n").length;
    return new ProviderResult(JSON.stringify({ names: Array(count).fill("步骤费用估算偏低") }), 10, 5, modelId);
  } };
  const executor = new Executor(db, cheap, lookup(...models));
  const run = db.getRun("r")!;
  run.status = "succeeded";
  db.saveRun(run);
  executor.emit("r", "run.succeeded");
  await Promise.all([...executor.namingTasks.values()].map((task) => task.promise));
  const [[modelId, options], ...more] = calls;
  assert.equal(more.length, 0);
  assert.ok(options.effort === "low" && !modelId.startsWith("cli:") && !modelId.startsWith("mock:"));
  assert.deepEqual(new Set((db.retrospective("r") as Record<string, any>).problems.map((p: Record<string, string>) => p.topic)), new Set(["步骤费用估算偏低"]));
});

// --- test_spread -----------------------------------------------------------------------------
const api = (id: string, price: number, coding = 90) => ModelProfileSchema.parse({ id, provider: id.split(":")[0], display_name: id, context_window: 1_000_000,
  input_per_million: price, output_per_million: price * 4, cached_input_per_million: price / 10, scores: { coding, planning: 85, reliability: 90 } });
const [CHEAP, NEAR, DEAR, WEAK] = [api("deepseek:flash", 0.15), api("minimax:m3", 0.3), api("glm:glm", 1.2), api("kimi:k", 0.2, 60)];
const SPREAD_MODELS = lookup(CHEAP, NEAR, DEAR, WEAK);
const spreadStep = (id: string, status = "pending", difficulty = "normal") => TaskNodeSchema.parse({ id, title: id, instructions: "i", capability: "coding", model_id: CHEAP.id,
  status, difficulty, quality_threshold: 80 });
function started(name: string, nodes: TaskNode[]) {
  const db = new Database(join(folder(), `${name}.db`));
  db.saveRun(ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "running", budget_usd: 5, use_cli: false, plan: { summary: "s", nodes } }));
  return [db, new Executor(db, { configuredModels: (ids: Iterable<string>) => new Set(ids) } as never, SPREAD_MODELS)] as const;
}

test("a step past its provider's share goes to another provider", async () => {
  settings.max_steps_per_provider = 2;
  const [db, executor] = started("t", [spreadStep("a", "running"), spreadStep("b", "running"), spreadStep("c")]);
  const run = db.getRun("r")!;
  const node = run.plan.nodes[2];
  await executor.spread(run, node);
  // The cheapest other provider that clears the threshold; the weak one does not, the dear one costs too much.
  assert.equal(node.model_id, "minimax:m3");
  const data = db.events("r").filter((e) => e.kind === "node.model_switched").at(-1)!.data as Record<string, unknown>;
  assert.ok(data.reason === "spread_across_providers" && data.model_id === "deepseek:flash");
});

test("a step stays when its provider has room or no other fits", async () => {
  settings.max_steps_per_provider = 2;
  let [db, executor] = started("t", [spreadStep("a", "running"), spreadStep("b")]);
  let run = db.getRun("r")!;
  await executor.spread(run, run.plan.nodes[1]);
  assert.equal(run.plan.nodes[1].model_id, CHEAP.id); // one running on it: room for another
  // Past the share, but the only other able model costs more than spread_cost_factor times as much.
  const busy = new Set(["deepseek"]);
  assert.equal((await spreadTo(spreadStep("c"), [CHEAP, DEAR, WEAK], new Set(Object.keys(SPREAD_MODELS)), busy)), null);
  settings.spread_cost_factor = 20.0;
  assert.equal((await spreadTo(spreadStep("c"), [CHEAP, DEAR, WEAK], new Set(Object.keys(SPREAD_MODELS)), busy))!.id, "glm:glm");
  // Off when the setting is 0.
  settings.max_steps_per_provider = 0;
  [db, executor] = started("off", [spreadStep("a", "running"), spreadStep("b", "running"), spreadStep("c")]);
  run = db.getRun("r")!;
  await executor.spread(run, run.plan.nodes[2]);
  assert.equal(run.plan.nodes[2].model_id, CHEAP.id);
});

// --- test_supervisor -------------------------------------------------------------------------
const SUPERVISOR_MODELS = lookup(planningModel("x:api", 99), planningModel("cli:claude", 90, "cli"), planningModel("cli:codex", 92, "cli"),
  planningModel("cli:gemini", 99, "cli"), planningModel("mock:local", 100));

/** Each model keeps conversations by id; ``fail`` maps a model to the error it throws. */
class Leads {
  messages: [string, string | null, string][] = [];
  replies: string[];
  fail: Map<string, Error>;
  constructor(replies: string[] = [], fail: Record<string, Error> = {}) {
    this.replies = [...replies];
    this.fail = new Map(Object.entries(fail));
  }
  configuredModels(ids: Iterable<string>) {
    return new Set(ids);
  }
  async converse(session: SupervisorSession, prompt: string): Promise<ProviderResult> {
    this.messages.push([session.model_id, session.session_id, prompt]);
    const error = this.fail.get(session.model_id);
    if (error) {
      this.fail.delete(session.model_id);
      throw error;
    }
    session.session_id = session.session_id || `${session.model_id}-conversation`;
    session.calls += 1;
    return new ProviderResult(this.replies.length ? this.replies.shift()! : "好的", 0, 0, session.model_id);
  }
}

function supervised(lead: Record<string, unknown>): Database {
  Object.assign(settings, { data_dir: join(folder(), "data"), workspace_root: join(folder(), "workspaces") });
  const db = new Database(join(folder(), "test.db"));
  db.saveRun(ExecutionRunSchema.parse({ id: "r", prompt: "写一个待办网页", status: "running", budget_usd: 1, supervisor: { cwd: join(folder(), "lead"), ...lead },
    plan: { summary: "待办网页", nodes: [{ id: "a", title: "页面", instructions: "写页面", capability: "coding" }] } }));
  return db;
}

test("asking goes on with the saved conversation", async () => {
  const db = supervised({ model_id: "cli:claude", session_id: "s1" });
  const leads = new Leads(["继续第二步"]);
  const executor = new Executor(db, leads as never, SUPERVISOR_MODELS);
  assert.equal(await executor.askLead("r", "第一步通过了，接下来？"), "继续第二步");
  assert.deepEqual(leads.messages, [["cli:claude", "s1", "第一步通过了，接下来？"]]);
  assert.equal(db.getRun("r")!.supervisor!.calls, 1);
  assert.ok(!db.events("r").some((e) => e.kind === "run.lead_changed"));
});

test("a lost conversation is rebuilt from the task's record", async () => {
  const db = supervised({ model_id: "cli:claude", session_id: "gone" });
  const leads = new Leads([], { "cli:claude": new SessionLost("No conversation found with session ID: gone") });
  const executor = new Executor(db, leads as never, SUPERVISOR_MODELS);
  await executor.askLead("r", "第一步通过了，接下来？");
  const [, rebuilt] = leads.messages;
  // Same model, new conversation, briefed on the task first.
  assert.ok(rebuilt[0] === "cli:claude" && rebuilt[1] === null);
  assert.ok(rebuilt[2].includes("taking over") && rebuilt[2].includes("写一个待办网页") && rebuilt[2].endsWith("第一步通过了，接下来？"));
  const lead = db.getRun("r")!.supervisor!;
  assert.equal(lead.session_id, "cli:claude-conversation");
  assert.deepEqual(lead.previous, ["cli:claude"]);
});

test("a lead that is not available hands the task to the next", async () => {
  const db = supervised({ model_id: "cli:codex", session_id: "s1" });
  const leads = new Leads([], { "cli:codex": new ModelUnavailable("cli:codex", new Date(), "额度用完") });
  const executor = new Executor(db, leads as never, SUPERVISOR_MODELS);
  await executor.askLead("r", "接下来？");
  assert.equal(db.getRun("r")!.supervisor!.model_id, "cli:claude");
  const data = db.events("r").filter((e) => e.kind === "run.lead_changed").at(-1)!.data as Record<string, unknown>;
  assert.deepEqual([data.model_id, data.previous_model_id], ["cli:claude", "cli:codex"]);
});

// --- test_tools ------------------------------------------------------------------------------
test("a step's reasoning effort follows its difficulty", async () => {
  // Thinking as hard as possible on every turn of an easy step only makes it slower.
  const db = leadDatabase(folder());
  const asked: unknown[] = [];
  const provider = { configuredModels: (ids: Iterable<string>) => new Set(ids), async complete(modelId: string, _prompt: string, options: CompleteOptions = {}) {
    asked.push(options.effort);
    return new ProviderResult("做完了", 0, 0, modelId);
  } };
  const run = db.getRun("r")!;
  run.plan.nodes[0].difficulty = "easy";
  db.saveRun(run);
  await new Executor(db, provider, LEAD_MODELS).execute("r");
  assert.equal(asked[0], "low");
});

// --- the tests themselves --------------------------------------------------------------------
test("a test finds no real membership CLI, only the fakes it makes", async () => {
  const cliChannels = await import("../src/cli-channels.js");
  for (const name of ["claude", "codex", "gemini"]) assert.equal(cliChannels.deps.which(name), null, name);
  const bin = join(folder(), "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), "#!/bin/sh\n", { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  assert.equal(cliChannels.deps.which("codex"), join(bin, "codex"));
});
