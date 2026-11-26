// Pausing, continuing, diagnosing, resuming and changing a task through the API (test_diagnosis.py,
// test_diagnosis_interaction.py, test_resume.py, test_network.py, test_followup.py,
// test_direct_planning.py: the tests of those that need the API).
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BudgetExceeded } from "../src/budget.js";
import { settings } from "../src/config.js";
import type { Database } from "../src/db.js";
import { NETWORK_CHOICE } from "../src/diagnosis.js";
import { repairPrompt } from "../packages/engineer/src/prompts.js";
import { Executor } from "../src/executor.js";
import {
  CapabilityScoreSchema, DiagnosisSchema, EventSchema, type ExecutionRun, ExecutionRunSchema, folderId, ModelProfileSchema, NodeAttemptSchema,
  type SupervisorSession, SupervisorSessionSchema, TaskNodeSchema, TaskPlanSchema,
} from "../src/models.js";
import { autonomousPlan } from "../packages/planning/src/planner.js";
import { type CompleteOptions, ProviderResult } from "../src/providers.js";
import * as quality from "../src/quality.js";
import * as pricing from "../src/pricing.js";
import { Task } from "../src/tasks.js";
import { conftest } from "./helpers/conftest.js";
import { taskApi } from "./helpers/task-api.js";

const { folder } = conftest();
const ORIGIN = { origin: "http://localhost:5173" };
const model = (id: string, planning: number, channel = "api") => ModelProfileSchema.parse({ id, provider: id.split(":")[0], display_name: id, channel,
  context_window: 1_000_000, input_per_million: 1, output_per_million: 1, execution_priority: channel === "cli" ? 0 : 100, scores: { coding: 90, planning, reliability: 90 } });
const MODELS = Object.fromEntries([model("x:api", 99), model("cli:claude", 90, "cli")].map((m) => [m.id, m]));
const REPORT = "## 问题定位\n第 1 步失败\n## 根本原因\n缺少 node\n## 建议操作\n换模型\nNEXT_STEP: 先确认 node 可用再运行检查";
const all = (ids: Iterable<string>) => new Set(ids);

/** A task's work, standing in for asyncio's never-finishing future: it ends once cancelled. */
const waiting = () => new Task<void>((signal) => new Promise((_done, fail) => signal.addEventListener("abort", () => fail(signal.reason))));
const settle = (tasks: Map<string, Task<unknown>>) => Promise.all([...tasks.values()].map((task) => task.promise));

class Providers {
  calls: string[] = [];
  configuredModels(ids: Iterable<string>): Set<string> {
    return new Set(ids);
  }

  async complete(modelId: string, prompt: string, _options: CompleteOptions = {}): Promise<ProviderResult> {
    this.calls.push(modelId);
    if (prompt.includes("You were asked to find out why")) return new ProviderResult(REPORT, 0, 0, modelId);
    throw new Error("node is not installed");
  }
}

function oneNodeRun(db: Database): void {
  db.saveRun(ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "queued", budget_usd: 1, use_cli: true,
    plan: { summary: "s", nodes: [{ id: "n", title: "Check", instructions: "run node --check", capability: "coding", model_id: "x:api" }] } }));
}

function runningRun(status = "running"): ExecutionRun {
  return ExecutionRunSchema.parse({ id: "r1", prompt: "p", status, budget_usd: 1, plan: { summary: "s", nodes: [
    { id: "a", title: "A", instructions: "a", capability: "coding", model_id: "cli:claude", status: "running" },
    { id: "b", title: "B", instructions: "b", capability: "coding", model_id: "cli:claude", dependencies: ["a"] }] } });
}

// ---- test_diagnosis.py ----

test("pausing lets running steps finish, and continuing keeps the same loop", async () => {
  const { api, client } = taskApi(folder());
  api.models = MODELS;
  api.providers.configuredModels = all;
  api.db.saveRun(runningRun());
  const response = await client.post("/api/tasks/r1/pause", { headers: ORIGIN });
  assert.ok(response.status_code === 200 && response.json().status === "paused");
  const event = api.db.events("r1").at(-1)!;
  assert.deepEqual([event.kind, event.data], ["approval.required", { reason: "user_paused", running: ["a"] }]);
  assert.equal((await client.post("/api/tasks/r1/pause", { headers: ORIGIN })).status_code, 409);

  // The executor loop is still waiting for step A, so continuing hands the run back to it.
  const loop = waiting();
  api.executor.tasks.set("r1", loop);
  const continued = await client.post("/api/tasks/r1/confirm", { json: { budget_usd: 1 }, headers: ORIGIN });
  assert.equal(continued.json().status, "running");
  loop.cancel();
  api.executor.tasks.delete("r1");
});

test("a manual diagnosis starts once, and its advice reaches the resumed step", async () => {
  const { api, client } = taskApi(folder());
  const started: string[] = [];
  api.models = MODELS;
  Object.assign(api.executor.modelLookup, MODELS);
  api.providers.configuredModels = all;
  api.executor.startDiagnosis = (_runId, diagnosisId) => void started.push(diagnosisId);
  const run = runningRun("failed");
  run.plan.nodes[0].status = "failed";
  run.plan.nodes[0].attempts = [NodeAttemptSchema.parse({ model_id: "cli:claude", outcome: "error", reason: "node missing" })];
  api.db.saveRun(run);

  const response = await client.post("/api/tasks/r1/diagnose", { headers: ORIGIN });
  assert.equal(response.status_code, 200);
  const [diagnosis] = response.json().diagnoses;
  assert.deepEqual([diagnosis.trigger, diagnosis.node_id, diagnosis.model_id, diagnosis.status], ["manual", "a", "cli:claude", "running"]);
  assert.deepEqual(started, [diagnosis.id]);

  const pending = waiting();
  api.executor.diagnosing.set("r1", pending);
  assert.equal((await client.post("/api/tasks/r1/diagnose", { headers: ORIGIN })).status_code, 409);
  pending.cancel();
  api.executor.diagnosing.delete("r1");

  const stored = api.db.getRun("r1")!;
  stored.diagnoses = [DiagnosisSchema.parse({ id: "d1", trigger: "auto", node_id: "a", status: "done", report: "r", advice: "先安装 node" })];
  api.db.saveRun(stored);
  api.executor.start = () => {};
  assert.equal((await client.post("/api/tasks/r1/resume", { json: { budget_usd: 1 }, headers: ORIGIN })).status_code, 200);
  assert.equal(api.db.getRun("r1")!.plan.nodes[0].feedback, "node missing\n诊断建议：先安装 node");
});

test("continuing a task paused by a diagnosis reruns the failed step with its advice", async () => {
  const { api, client } = taskApi(folder());
  api.models = MODELS;
  api.providers.configuredModels = all;
  api.executor.start = () => {};
  const run = runningRun("paused");
  Object.assign(run.plan.nodes[0], { status: "failed", failed_attempts: 3, environment_fixes: 2,
    attempts: [NodeAttemptSchema.parse({ model_id: "cli:claude", outcome: "error", reason: "node missing" })] });
  run.error = "步骤「A」诊断认为需要你先处理，任务已暂停。";
  run.diagnoses = [DiagnosisSchema.parse({ id: "d1", trigger: "auto", node_id: "a", status: "done", report: "r", advice: "先安装 node", verdict: "blocked" })];
  api.db.saveRun(run);

  const response = await client.post("/api/tasks/r1/confirm", { json: { budget_usd: 1 }, headers: ORIGIN });
  assert.ok(response.status_code === 200 && response.json().status === "queued");
  const stored = api.db.getRun("r1")!;
  assert.ok(stored.error === null && stored.plan.nodes[0].status === "pending" && stored.plan.nodes[0].failed_attempts === 0);
  assert.equal(stored.plan.nodes[0].environment_fixes, 0);
  assert.equal(stored.plan.nodes[0].feedback, "node missing\n诊断建议：先安装 node");
});

test("continuing after the decision limit clears the pause message", async () => {
  // The decision limit leaves its step pending, not failed; its message must not outlive the pause.
  const { api, client } = taskApi(folder());
  api.models = MODELS;
  api.providers.configuredModels = all;
  api.executor.start = () => {};
  const run = runningRun("paused");
  run.plan.nodes[0].status = "pending";
  run.error = "步骤「A」已决策 5 次仍未解决，任务已暂停。看过情况后点“按此预算继续”，负责人会接着处理。";
  api.db.saveRun(run);
  const response = await client.post("/api/tasks/r1/confirm", { json: { budget_usd: 1 }, headers: ORIGIN });
  assert.ok(response.status_code === 200 && response.json().error === null);
  assert.equal(api.db.getRun("r1")!.error, null);
});

test("a task read through the API carries its estimate calibrated by history", async () => {
  const { api, client } = taskApi(folder());
  api.db.saveRetrospective("old", { run_id: "old", started_at: "2026-01-01", actual_usd: 3.0,
    steps: Array(3).fill({ model_id: "cli:claude", estimated_usd: 0.1, actual_usd: 1.0 }) });
  const run = runningRun("awaiting_confirmation");
  for (const node of run.plan.nodes) Object.assign(node, { status: "pending", estimated_cost_usd: 0.2 });
  run.plan.estimate = await pricing.estimate(run.plan.nodes, 1);
  api.db.saveRun(run);

  const [listed] = (await client.get("/api/tasks")).json();
  const single = (await client.get("/api/tasks/r1")).json();
  assert.ok(Math.abs(listed.plan.estimate.calibrated_usd - 4.0) < 1e-6);
  assert.equal(single.plan.estimate.calibrated_usd, listed.plan.estimate.calibrated_usd);
  // Only shown, never kept: the stored estimate stays as planned.
  assert.equal(api.db.getRun("r1")!.plan.estimate!.calibrated_usd, null);
});

// ---- test_diagnosis_interaction.py ----

const QUESTION = "需要确认是否必须支持旧版接口。\nQUESTION: 旧版接口是否需要继续兼容？\n"
  + "OPTIONS: [\"保留兼容\", \"允许升级接口\"]\nSTATUS: NEEDS_INPUT";

class InteractiveProviders extends Providers {
  repaired = false;
  workCalls = 0;
  replyPrompts: string[] = [];
  stepPrompts: string[] = [];

  override async complete(modelId: string, prompt: string, options: CompleteOptions = {}): Promise<ProviderResult> {
    if (options.repair) {
      if (prompt.includes("User's reply:")) {
        this.replyPrompts.push(prompt);
        this.repaired = true;
        return new ProviderResult("已按你的兼容性要求修复。\nSTATUS: FIXED", 0, 0, modelId);
      }
      return new ProviderResult(QUESTION, 0, 0, modelId);
    }
    this.workCalls += 1;
    this.stepPrompts.push(prompt);
    if (!this.repaired) throw new Error("legacy interface missing");
    return new ProviderResult("checked", 0, 0, modelId);
  }
}

test("the user's choice and text continue the actual repair and the task", async () => {
  const { api, client } = taskApi(folder());
  Object.assign(settings, { auto_diagnose: true, review_nodes: false });
  const providers = new InteractiveProviders();
  const executor = new Executor(api.db, providers, MODELS);
  api.executor = executor;
  oneNodeRun(api.db);
  await executor.execute("r");
  const run = api.db.getRun("r")!;
  const diagnosis = run.diagnoses.at(-1)!;
  assert.equal(run.status, "paused");
  assert.equal(run.waiting_diagnosis_id, diagnosis.id);
  assert.equal(run.plan.nodes[0].status, "pending");
  assert.equal(providers.workCalls, 1); // No guessing and no automatic retry before an answer.
  assert.equal((await client.post("/api/tasks/r/confirm", { json: {}, headers: ORIGIN })).status_code, 409);

  const response = await client.post(`/api/tasks/r/diagnoses/${diagnosis.id}/reply`, { headers: ORIGIN,
    json: { choice: "保留兼容", text: "已有三个项目依赖旧接口，请不要改调用方。" } });
  assert.equal(response.status_code, 200);
  await settle(executor.diagnosing);
  await settle(executor.tasks);
  const completed = api.db.getRun("r")!;
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.waiting_diagnosis_id, null);
  assert.equal(providers.workCalls, 2);
  assert.ok(providers.replyPrompts[0].includes("保留兼容") && providers.replyPrompts[0].includes("请不要改调用方"));
  assert.ok(providers.stepPrompts.at(-1)!.includes("请不要改调用方"));
  assert.equal(completed.diagnoses[0].messages[0].choice, "保留兼容");
  assert.equal(completed.diagnoses[0].question, diagnosis.question);
  assert.equal(completed.diagnoses.length, 2);
});

for (const outOfBudget of [false, true]) {
  test(`an answer to a general diagnosis ${outOfBudget ? "leaves the budget controls when out of budget" : "resumes the task"}`, async () => {
    const { api, client } = taskApi(folder());
    settings.review_nodes = false;
    class GeneralDiagnosis extends Providers {
      override async complete(modelId: string, prompt: string): Promise<ProviderResult> {
        if (prompt.includes("You were asked to find out why")) {
          if (prompt.includes("User's reply:")) {
            if (outOfBudget) throw new BudgetExceeded("剩余预算不足");
            return new ProviderResult("已明确兼容性要求，可以继续。\nSTATUS: RETRY", 0, 0, modelId);
          }
          return new ProviderResult(QUESTION, 0, 0, modelId);
        }
        assert.ok(prompt.includes("保留兼容"));
        return new ProviderResult("checked", 0, 0, modelId);
      }
    }
    const executor = new Executor(api.db, new GeneralDiagnosis(), MODELS);
    api.executor = executor;
    oneNodeRun(api.db);
    assert.equal((await client.post("/api/tasks/r/diagnose", { headers: ORIGIN })).status_code, 200);
    await settle(executor.diagnosing);
    const run = api.db.getRun("r")!;
    assert.equal(run.status, "paused");
    assert.equal(run.diagnoses.at(-1)!.node_id, null);
    const identifier = run.waiting_diagnosis_id;
    assert.ok(identifier);

    assert.equal((await client.post(`/api/tasks/r/diagnoses/${identifier}/reply`, { headers: ORIGIN, json: { choice: "保留兼容" } })).status_code, 200);
    await settle(executor.diagnosing);
    await settle(executor.tasks);
    const completed = api.db.getRun("r")!;
    assert.equal(completed.waiting_diagnosis_id, null);
    assert.equal(completed.status, outOfBudget ? "paused" : "succeeded");
    if (outOfBudget) assert.ok(completed.diagnoses.at(-1)!.error!.includes("预算"));
  });
}

for (const [body, status] of [[{ text: "只修复平台，不改项目配置" }, 200], [{ choice: "保留兼容" }, 200], [{ text: "  " }, 422], [{ choice: "不存在的方案" }, 422]] as const) {
  test(`a reply is checked and kept: ${JSON.stringify(body)}`, async () => {
    const { api, client } = taskApi(folder());
    oneNodeRun(api.db);
    const run = api.db.getRun("r")!;
    run.status = "paused";
    run.diagnoses = [DiagnosisSchema.parse({ id: "d", trigger: "manual", node_id: "n", status: "done", question: "是否保持兼容？", choices: ["保留兼容", "允许升级接口"] })];
    api.db.saveRun(run);
    Object.assign(api.executor.modelLookup, MODELS);
    api.providers.configuredModels = all;
    const started: unknown[] = [];
    api.executor.startDiagnosis = (...args) => void started.push(args);
    const response = await client.post("/api/tasks/r/diagnoses/d/reply", { json: body, headers: ORIGIN });
    assert.equal(response.status_code, status);
    assert.equal(api.db.getRun("r")!.diagnoses[0].messages.length, status === 200 ? 1 : 0);
    assert.equal(started.length, status === 200 ? 1 : 0);
    assert.equal((await client.post("/api/tasks/r/diagnoses/missing/reply", { json: { text: "x" }, headers: ORIGIN })).status_code, 404);
  });
}

test("a busy diagnosis neither accepts nor loses a reply", async () => {
  const { api, client } = taskApi(folder());
  oneNodeRun(api.db);
  const run = api.db.getRun("r")!;
  run.diagnoses = [DiagnosisSchema.parse({ id: "d", trigger: "manual", status: "done" })];
  api.db.saveRun(run);
  const busy = waiting();
  api.executor.diagnosing.set("r", busy);
  try {
    const response = await client.post("/api/tasks/r/diagnoses/d/reply", { json: { text: "补充内容" }, headers: ORIGIN });
    assert.equal(response.status_code, 409);
    assert.deepEqual(api.db.getRun("r")!.diagnoses[0].messages, []);
  } finally {
    busy.cancel();
    api.executor.diagnosing.delete("r");
  }
});

// ---- test_resume.py ----

function failedRun(status = "failed"): ExecutionRun {
  return ExecutionRunSchema.parse({ id: "r1", prompt: "p", status, budget_usd: 1, actual_cost_usd: 0.2, rework_rounds: 2, error: "1 task node(s) failed",
    use_cli: false, plan: { summary: "s", nodes: [
      { id: "a", title: "A", instructions: "a", capability: "coding", model_id: "x:one", status: "succeeded", result: "done" },
      { id: "b", title: "B", instructions: "b", capability: "coding", model_id: "x:gone", dependencies: ["a"], status: "failed", failed_attempts: 3,
        estimated_cost_usd: 0.5, attempts: [{ model_id: "x:gone", outcome: "error", reason: "node --check needs approval" }] },
      { id: "c", title: "C", instructions: "c", capability: "coding", model_id: "x:one", dependencies: ["b"], estimated_cost_usd: 0.25 }] } });
}

const scored = (id: string) => ModelProfileSchema.parse({ id, provider: "x", display_name: id, context_window: 200_000, input_per_million: 1, output_per_million: 1,
  scores: Object.fromEntries(Object.keys(CapabilityScoreSchema.parse({})).map((key) => [key, 90])) });

test("a failed task resumes from the failed node", async () => {
  const { api, client } = taskApi(folder());
  const started: string[] = [];
  api.executor.start = (runId) => void started.push(runId);
  api.models = { "x:one": scored("x:one") };
  api.providers.configuredModels = all;
  api.db.saveRun(failedRun());

  const response = await client.post("/api/tasks/r1/resume", { json: { budget_usd: 2 }, headers: ORIGIN });

  assert.equal(response.status_code, 200, response.text);
  const run = api.db.getRun("r1")!;
  const [a, b, c] = run.plan.nodes;
  assert.ok(run.status === "queued" && started.join() === "r1");
  assert.deepEqual([run.budget_usd, run.rework_rounds, run.error], [2, 0, null]);
  assert.ok(a.status === "succeeded" && a.result === "done");
  assert.ok(b.status === "pending" && b.failed_attempts === 0);
  assert.ok(b.feedback === "node --check needs approval" && b.attempts.length === 1);
  // Its model is gone, so it was routed again.
  assert.ok(b.model_id === "x:one" && c.status === "pending");
  assert.equal(api.db.events("r1").at(-1)!.kind, "run.resumed");
});

test("resuming a contract step stopped at its tool-call limit grants it more calls", async () => {
  const { api, client } = taskApi(folder());
  api.executor.start = () => {};
  api.models = { "x:one": scored("x:one") };
  api.providers.configuredModels = all;
  const run = failedRun("incomplete");
  const b = run.plan.nodes[1];
  Object.assign(b, { status: "blocked", model_id: "x:one", contract_tool_calls: 50, contract_turns: 21, contract_cost_usd: 0.05,
    artifact_contract: { inputs: [], outputs: [{ path: "sw/build", kind: "directory" }], acceptance_commands: ["test -d sw/build"],
      blocked_when: ["no assembler"], max_turns: 50, max_cost_usd: 1 } });
  assert.ok(Executor.contractLimitReason(b));
  api.db.saveRun(run);

  assert.equal((await client.post("/api/tasks/r1/resume", { json: { budget_usd: 2 }, headers: ORIGIN })).status_code, 200);

  const resumed = api.db.getRun("r1")!.plan.nodes[1];
  assert.equal(resumed.status, "pending");
  assert.ok(resumed.artifact_contract!.max_turns > resumed.contract_tool_calls);
  assert.ok(resumed.artifact_contract!.max_cost_usd > 1);
  assert.equal(Executor.contractLimitReason(resumed), null);
});

test("resuming checks the status and the budget", async () => {
  const { api, client } = taskApi(folder());
  api.executor.start = () => {};
  api.models = { "x:one": scored("x:one"), "x:gone": scored("x:gone") };
  api.providers.configuredModels = all;
  api.db.saveRun(failedRun());
  const low = await client.post("/api/tasks/r1/resume", { json: { budget_usd: 0.5 }, headers: ORIGIN });
  assert.ok(low.status_code === 409 && low.json().detail.includes("needed to finish"));
  assert.equal(api.db.getRun("r1")!.status, "failed");

  api.db.saveRun({ ...failedRun("cancelled"), id: "r2" });
  assert.equal((await client.post("/api/tasks/r2/resume", { json: {}, headers: ORIGIN })).status_code, 200);
  api.db.saveRun({ ...failedRun("succeeded"), id: "r3" });
  assert.equal((await client.post("/api/tasks/r3/resume", { json: {}, headers: ORIGIN })).status_code, 409);
});

test("the timeline lists a task's events in order", async () => {
  const { api, client } = taskApi(folder());
  api.db.saveRun(failedRun());
  api.db.addEvent(EventSchema.parse({ run_id: "r1", kind: "node.started", data: { node_id: "b", attempt: 1 } }));
  api.db.addEvent(EventSchema.parse({ run_id: "r1", kind: "node.failed", data: { node_id: "b", error: "boom" } }));
  const events = (await client.get("/api/tasks/r1/timeline")).json();
  assert.deepEqual(events.map((e: any) => [e.kind, e.data.node_id]), [["node.started", "b"], ["node.failed", "b"]]);
  assert.ok(events[0].created_at && events[0].id < events[1].id);
  const later = (await client.get("/api/tasks/r1/timeline", { params: { after: events[0].id } })).json();
  assert.deepEqual(later.map((e: any) => e.kind), ["node.failed"]);
  assert.equal((await client.get("/api/tasks/missing/timeline")).status_code, 404);
});

// ---- test_network.py and test_followup.py ----

const AGENT = ModelProfileSchema.parse({ id: "x:agent", provider: "x", display_name: "Agent", channel: "api", context_window: 1_000_000, input_per_million: 1,
  output_per_million: 1, execution_priority: 100, scores: { coding: 90, planning: 90, reliability: 90 } });

function finishedTask(api: ReturnType<typeof taskApi>["api"], status = "succeeded"): ExecutionRun {
  const run = ExecutionRunSchema.parse({ id: "parent", prompt: "写一个待办事项网页", status, budget_usd: 3, use_cli: false,
    final_result: "完成了 index.html 和 app.js，支持增删待办。",
    plan: { summary: "待办网页", nodes: [{ id: "a", title: "页面", instructions: "i", capability: "coding" }] } });
  const workspace = join(settings.workspace_root, run.id);
  mkdirSync(join(workspace, "static"), { recursive: true });
  writeFileSync(join(workspace, "static", "app.js"), "// todo app\n");
  writeFileSync(join(workspace, "index.html"), "<!doctype html>\n");
  api.db.saveRun(run);
  return run;
}

function planning(api: ReturnType<typeof taskApi>["api"], prompts: string[]): void {
  api.deps.autonomousPlan = async (prompt: string) => {
    prompts.push(prompt);
    return TaskPlanSchema.parse({ summary: "加提醒", nodes: [{ id: "b", title: "提醒", instructions: "add reminders", capability: "coding" }] });
  };
  api.models = { [AGENT.id]: AGENT };
  api.providers.configuredModels = () => new Set([AGENT.id]);
}

const NETWORK_ASK = "这一步要调用外部天气接口，本任务不允许联网。\nQUESTION: 是否允许本任务联网？\n"
  + `OPTIONS: ["${NETWORK_CHOICE}", "改用本地样例数据"]\nSTATUS: NEEDS_INPUT`;

/** The step only works with the network; the diagnosis asks for it. */
class NetworkProviders extends Providers {
  work: boolean[] = [];
  repairPrompts: string[] = [];

  override async complete(modelId: string, prompt: string, options: CompleteOptions = {}): Promise<ProviderResult> {
    if (options.repair) {
      assert.ok(!("network" in options)); // Repairs have the host's network anyway.
      this.repairPrompts.push(prompt);
      return new ProviderResult(prompt.includes("User's reply:") ? "已允许联网。\nSTATUS: FIXED" : NETWORK_ASK, 0, 0, modelId);
    }
    this.work.push(Boolean(options.network));
    if (!options.network) throw new Error("curl: (6) Could not resolve host: api.weather.example");
    return new ProviderResult("fetched", 0, 0, modelId);
  }
}

test("a diagnosis can ask to allow the network, and the answer turns it on", async () => {
  const { api, client } = taskApi(folder());
  Object.assign(settings, { auto_diagnose: true, review_nodes: false });
  const providers = new NetworkProviders();
  const executor = new Executor(api.db, providers, MODELS);
  api.executor = executor;
  oneNodeRun(api.db);
  await executor.execute("r");
  const run = api.db.getRun("r")!;
  assert.ok(run.status === "paused" && !run.allow_network);
  assert.ok(run.diagnoses.at(-1)!.choices.includes(NETWORK_CHOICE) && providers.repairPrompts[0].includes(NETWORK_CHOICE));

  const response = await client.post(`/api/tasks/r/diagnoses/${run.diagnoses.at(-1)!.id}/reply`, { headers: ORIGIN, json: { choice: NETWORK_CHOICE } });
  assert.ok(response.status_code === 200 && response.json().allow_network === true);
  await settle(executor.diagnosing);
  await settle(executor.tasks);
  const done = api.db.getRun("r")!;
  assert.ok(done.status === "succeeded" && done.allow_network);
  assert.deepEqual(providers.work, [false, true]);
});

test("network access is chosen per task and carried into a change", async () => {
  const { api, client } = taskApi(folder());
  const parent = finishedTask(api);
  planning(api, []);
  assert.ok(!parent.allow_network);
  const response = await client.put(`/api/tasks/${parent.id}/network`, { json: { allow: true }, headers: ORIGIN });
  assert.ok(response.status_code === 200 && api.db.getRun(parent.id)!.allow_network);
  assert.ok(repairPrompt(api.db.getRun(parent.id)!, parent.plan.nodes[0], "w", "t", [], []).includes("allows the internet"));
  assert.ok(repairPrompt(parent, parent.plan.nodes[0], "w", "t", [], []).includes("does not allow the internet"));

  let child = (await client.post(`/api/tasks/${parent.id}/followup`, { json: { prompt: "抓取天气" }, headers: ORIGIN })).json();
  assert.equal(child.allow_network, true);
  child = (await client.post(`/api/tasks/${parent.id}/followup`, { json: { prompt: "离线版本", allow_network: false }, headers: ORIGIN })).json();
  assert.equal(child.allow_network, false);
  assert.equal(child.use_cli, false); // The earlier task's setting.
  child = (await client.post(`/api/tasks/${parent.id}/followup`, { json: { prompt: "可以用 CLI", use_cli: true }, headers: ORIGIN })).json();
  assert.ok(child.use_cli === true && child.allow_network === true);
  const created = (await client.post("/api/tasks", { json: { prompt: "写一个网页", allow_network: true }, headers: ORIGIN })).json();
  assert.equal(created.allow_network, true);
  assert.equal((await client.put("/api/tasks/missing/network", { json: { allow: true }, headers: ORIGIN })).status_code, 404);
});

test("a requirement change builds on the finished task, in its folder", async () => {
  const { api, client } = taskApi(folder());
  const parent = finishedTask(api);
  const prompts: string[] = [];
  planning(api, prompts);

  const response = await client.post(`/api/tasks/${parent.id}/followup`, { json: { prompt: "增加到期提醒" }, headers: ORIGIN });
  assert.equal(response.status_code, 201, response.text);
  const child = api.db.getRun(response.json().id)!;
  assert.deepEqual([child.prompt, child.parent_run_id, child.workspace_id, child.budget_usd], ["增加到期提醒", "parent", "parent", 3]);
  assert.equal(child.status, "awaiting_confirmation");
  // The planner knows what exists and what is new.
  const [prompt] = prompts;
  for (const part of ["写一个待办事项网页", "index.html", "static/app.js", "完成了 index.html 和 app.js"]) assert.ok(prompt.includes(part), part);
  assert.ok(prompt.trimEnd().endsWith("新需求：\n增加到期提醒"));
  // Its steps work in the same folder, can change files, and are told so.
  assert.equal(folderId(child), parent.id);
  assert.ok(child.plan.nodes.every((node) => node.needs_workspace && node.model_id === "x:agent"));
  const [stepPrompt] = quality.nodePrompt(child.plan.nodes[0], child, 4000);
  assert.ok(stepPrompt.includes("this task changes an earlier task") && stepPrompt.includes("写一个待办事项网页"));

  // A change of the change stays in the first folder and keeps the earlier background.
  child.status = "succeeded";
  api.db.saveRun(child);
  const again = await client.post(`/api/tasks/${child.id}/followup`, { json: { prompt: "提醒改成邮件" }, headers: ORIGIN });
  const grandchild = api.db.getRun(again.json().id)!;
  assert.ok(grandchild.workspace_id === "parent" && grandchild.background!.includes("更早的背景"));
  assert.ok(grandchild.background!.includes("增加到期提醒"));
});

test("a task still running cannot be changed", async () => {
  const { api, client } = taskApi(folder());
  const parent = finishedTask(api, "running");
  planning(api, []);
  assert.equal((await client.post(`/api/tasks/${parent.id}/followup`, { json: { prompt: "增加到期提醒" }, headers: ORIGIN })).status_code, 409);
});

// ---- test_direct_planning.py ----

const SCORES = Object.fromEntries(Object.keys(CapabilityScoreSchema.parse({})).map((key) => [key, 95]));
const TEAM_MODELS = ["first", "second"].map((name) => ModelProfileSchema.parse({ id: `test:${name}`, provider: "test", display_name: name, scores: SCORES,
  scores_source: "artificial_analysis", context_window: 100000, input_per_million: 1, output_per_million: 1 }));
const CONFIGURED = new Set(TEAM_MODELS.map((m) => m.id));
const ROSTER = { team_brief: "保持接口并独立验收", employees: [{ id: "builder", name: "开发", role: "实现模块", model_id: "test:first", capabilities: ["coding"] }] };
const TASKS = { summary: "交付模块", title: "小模块交付。", folder: "small-module", requires: ["python --version"], nodes: [
  { key: "build", title: "实现模块", instructions: "完成模块和本任务自测", capability: "coding", employee_id: "builder", acceptance_criteria: "功能通过自测", provides: "public interface" },
  { key: "check", title: "验收模块", instructions: "根据依赖产物进行验收", capability: "coding", employee_id: "builder", dependencies: ["build"], verifies: ["build"],
    acceptance_criteria: "列出验收证据" }] };

class Planner {
  async converse(session: SupervisorSession, text: string): Promise<ProviderResult> {
    return new ProviderResult(JSON.stringify(text.includes("TEAM_SETUP") ? ROSTER : TASKS), 10, 10, session.model_id);
  }

  async complete(): Promise<ProviderResult> {
    throw new Error("no single-call planner here");
  }
}

test("the API keeps an employee's model at creation and at confirmation", async () => {
  const { api, client } = taskApi(folder());
  settings.employee_teams = true; // direct_policy
  const catalog = TEAM_MODELS.map((m, i) => ({ ...m, input_per_million: i === 0 ? 10 : 1, output_per_million: i === 0 ? 10 : 1 }));
  api.deps.autonomousPlan = () => autonomousPlan("实现模块", TEAM_MODELS, CONFIGURED, new Planner() as any, null, SupervisorSessionSchema.parse({}));
  api.models = Object.fromEntries(catalog.map((m) => [m.id, m]));
  api.providers.configuredModels = () => CONFIGURED;
  api.executor.start = () => {};
  const response = await client.post("/api/tasks", { json: { prompt: "实现模块", use_cli: false, budget_usd: 10 }, headers: ORIGIN });
  assert.equal(response.status_code, 201, response.text);
  const body = response.json();
  assert.ok(body.plan.nodes.every((n: any) => n.model_id === "test:first"));
  // An unavailable employee must be reassigned explicitly, not silently replaced at confirm.
  api.providers.configuredModels = () => new Set(["test:second"]);
  const rejected = await client.post(`/api/tasks/${body.id}/confirm`, { json: {}, headers: ORIGIN });
  assert.equal(rejected.status_code, 422, rejected.text);
  assert.equal(api.db.getRun(body.id)!.status, "awaiting_confirmation");
});

test("the user answers the plan's choices and it is planned again, in place", async () => {
  const { api, client } = taskApi(folder());
  const choices = [{ question: "AXI4 还是 AXI4-Lite？", assumed: "完整 AXI4", alternative: "AXI4-Lite" },
    { question: "apb_mux 是什么？", assumed: "一主多从", alternative: "多主一从" }];
  const node = TaskNodeSchema.parse({ id: "n", title: "old", instructions: "i", capability: "coding" });
  api.db.saveRun(ExecutionRunSchema.parse({ id: "r", prompt: "交付 axi to apb", status: "awaiting_confirmation", budget_usd: 5,
    plan: { summary: "old", nodes: [node], choices } }));
  const asked: [string, string][] = [];
  api.makePlan = async (body, _parent = null, decided = "") => {
    asked.push([body.prompt, decided]);
    return { plan: TaskPlanSchema.parse({ summary: "lite", nodes: [{ ...node, title: "new" }] }), session: SupervisorSessionSchema.parse({}), attached: [],
      projectDir: null, background: null, lessons: [] };
  };
  const same = await client.post("/api/tasks/r/choices", { json: { picks: ["assumed", "assumed"] } });
  assert.ok(same.json().plan.summary === "old" && asked.length === 0); // nothing changed: no new plan
  assert.equal((await client.post("/api/tasks/r/choices", { json: { picks: ["assumed"] } })).status_code, 422);
  const changed = await client.post("/api/tasks/r/choices", { json: { picks: ["alternative", "两主两从，固定优先级"] } });
  assert.ok(changed.status_code === 200 && changed.json().plan.summary === "lite" && changed.json().id === "r");
  const [[prompt, decided]] = asked;
  assert.ok(prompt === "交付 axi to apb" && decided.includes("→ AXI4-Lite") && decided.includes("→ 两主两从，固定优先级"));
  assert.ok(api.db.events("r").some((e) => e.kind === "plan.replanned"));
});
