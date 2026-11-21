// recovery.ts, progress.ts and diagnosis.ts: tests from test_recovery, test_progress,
// test_diagnosis, test_diagnosis_interaction and test_call_runtime, ported.
import assert from "node:assert/strict";
import { test } from "node:test";
import { settings } from "../src/config.js";
import * as diagnosis from "../src/diagnosis.js";
import { DiagnosisMessageSchema, ExecutionRunSchema, ModelProfileSchema, NodeAttemptSchema, type TaskNode, TaskNodeSchema } from "../src/models.js";
import * as progress from "../src/progress.js";
import * as recovery from "../src/recovery.js";

// test_turns.model
const model = (id: string, coding: number, channel = "api") => ModelProfileSchema.parse({ id, provider: id.split(":")[0],
  display_name: id, channel, context_window: 1_000_000, input_per_million: 1, output_per_million: 1,
  execution_priority: channel === "cli" ? 0 : 100, scores: { coding, planning: 80, reliability: 90 } });
// API-first: the flash API model is tried before the stronger CLI, and the pro API model is weaker.
const MODELS = [model("x:flash", 90), model("x:pro", 85), model("cli:codex", 95, "cli")];
const CONFIGURED = new Set(MODELS.map((item) => item.id));
const step = (...attempts: [string, string][]): TaskNode => TaskNodeSchema.parse({ id: "n", title: "Build",
  instructions: "build", capability: "coding", model_id: "x:flash",
  attempts: attempts.map(([modelId, outcome]) => ({ model_id: modelId, outcome })) });

test("one failure keeps the strongest model", async () => {
  assert.equal((await recovery.retryModel(step(["x:flash", "rejected"]), MODELS, CONFIGURED))!.id, "x:flash");
});

test("two failures in a row hand the step to the best other model", async () => {
  const node = step(["x:flash", "rejected"], ["x:flash", "error"]);
  assert.deepEqual(recovery.failedModels(node), new Set(["x:flash"]));
  assert.equal((await recovery.retryModel(node, MODELS, CONFIGURED))!.id, "cli:codex");
  // The new model failing once does not send the step back to the one that failed twice.
  node.attempts.push(NodeAttemptSchema.parse({ model_id: "cli:codex", outcome: "rejected" }));
  assert.equal((await recovery.retryModel(node, MODELS, CONFIGURED))!.id, "cli:codex");
  node.attempts.push(NodeAttemptSchema.parse({ model_id: "cli:codex", outcome: "rejected" }));
  assert.equal((await recovery.retryModel(node, MODELS, CONFIGURED))!.id, "x:pro");
});

test("running out of turns counts, whatever the model claimed", async () => {
  const node = step(["x:flash", "unable"], ["x:flash", "unable"]);
  assert.deepEqual(recovery.failedModels(node), new Set());
  for (const attempt of node.attempts) attempt.turn_limit = true;
  assert.deepEqual(recovery.failedModels(node), new Set(["x:flash"]));
  assert.equal((await recovery.retryModel(node, MODELS, CONFIGURED))!.id, "cli:codex");
});

test("only the model's own failures count", async () => {
  // Provider limits, cancellations and unverified reviews say nothing about the model's work.
  assert.deepEqual(recovery.failedModels(step(["x:flash", "rejected"], ["x:flash", "quota"], ["x:flash", "cancelled"],
    ["x:flash", "unverified"])), new Set());
  // A passed attempt (before rework) starts the count again.
  assert.deepEqual(recovery.failedModels(step(["x:flash", "rejected"], ["x:flash", "passed"], ["x:flash", "verify_failed"])), new Set());
});

for (const [outcome, status, fixes, action] of [
  ["rejected", "platform_pending", 0, "hold_for_platform"], ["rejected", "needs_input", 0, "ask_user"],
  ["error", "quota_exhausted", 0, "switch_model"], ["rejected", "quota_exhausted", 0, "retry"],
  ["rejected", "fixed", 0, "retry_fixed"], ["rejected", "fixed", recovery.MAX_ENVIRONMENT_FIXES, "retry"],
  ["rejected", "unable", 0, "unable"], ["unable", "blocked", 0, "unable"], ["unable", "retry", 0, "retry"],
  ["rejected", "blocked", 0, "pause"], ["verify_failed", "retry", 0, "pause_rework"], ["rejected", null, 0, "retry"],
] as [string, string | null, number, string][]) {
  test(`what a diagnosis means for the step: ${outcome}/${status}/${fixes} → ${action}`, async () => {
    assert.equal(recovery.afterDiagnosis(outcome, status, { hasModel: true, environmentFixes: fixes }), action);
  });
}

test("a diagnosis is told when a step keeps failing", async () => {
  const run = ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "running", budget_usd: 1,
    plan: { summary: "s", nodes: [step(["x:flash", "rejected"], ["x:flash", "rejected"])] } });
  const node = run.plan.nodes[0];
  const text = diagnosis.repairPrompt(run, node, "/w", "/tools", [], []);
  assert.ok(text.includes("failed 2 times in a row") && text.includes("STATUS: UNABLE"));
  node.attempts = node.attempts.slice(0, 1);
  assert.ok(!diagnosis.repairPrompt(run, node, "/w", "/tools", [], []).includes("times in a row"));
});

test("the progress checker must explicitly permit continuation", async () => {
  assert.equal(progress.parse("还在写测试，进展正常。\nVERDICT: CONTINUE"), null);
  assert.equal(progress.parse("VERDICT: STOP: 连续 12 次运行同一条失败的命令"), "连续 12 次运行同一条失败的命令");
  assert.ok(progress.parse("看不出来")!.includes("未给出唯一有效结论"));
  assert.notEqual(progress.parse("I cannot decide"), null); // test_call_runtime: an invalid verdict cannot continue
});

test("there is no turn limit by default", async () => {
  assert.equal(settings.api_agent_max_turns, 0);
  assert.equal(recovery.turnsFor(TaskNodeSchema.parse({ id: "n", title: "t", instructions: "i", capability: "coding" })), null);
});

test("the checker is told a long regression with children is progressing", async () => {
  const text = progress.checkPrompt(TaskNodeSchema.parse({ id: "n", title: "t", instructions: "i", capability: "coding" }), 30, "e");
  assert.ok(text.includes("regression") && text.includes("child processes"));
});

const REPORT = "## 问题定位\n第 1 步失败\n## 根本原因\n缺少 node\n## 建议操作\n换模型\nNEXT_STEP: 先确认 node 可用再运行检查";

test("the advice and status lines are split from the report", async () => {
  const [report, advice, status] = diagnosis.parse(REPORT);
  assert.ok(report.endsWith("换模型") && advice === "先确认 node 可用再运行检查" && status === null);
  assert.deepEqual(diagnosis.parse(REPORT + "\nSTATUS: BLOCKED").slice(1), ["先确认 node 可用再运行检查", "blocked"]);
  assert.deepEqual(diagnosis.parse("## 修复内容\n装好了 node\n\nstatus: Fixed"), ["## 修复内容\n装好了 node", null, "fixed"]);
  assert.deepEqual(diagnosis.parse("模型漏了一步\nNEXT_STEP: 先写测试\nSTATUS: RETRY"), ["模型漏了一步", "先写测试", "retry"]);
  assert.deepEqual(diagnosis.parse("执行模型额度耗尽\nSTATUS: QUOTA_EXHAUSTED"), ["执行模型额度耗尽", null, "quota_exhausted"]);
  assert.deepEqual(diagnosis.parse("no advice here"), ["no advice here", null, null]);
});

test("a diagnosis is told where the full trace is", async () => {
  const attempt = NodeAttemptSchema.parse({ outcome: "rejected", turns: 2, tool_calls: [{ turn: 1, tool: "Bash", detail: "make" }],
    trace: "/data/traces/r/n-1.jsonl" });
  assert.ok(diagnosis.toolSummary(attempt, true).includes("/data/traces/r/n-1.jsonl"));
  assert.ok(!diagnosis.toolSummary({ ...attempt, trace: null }, true).includes("/data/traces"));
});

const QUESTION = "需要确认是否必须支持旧版接口。\nQUESTION: 旧版接口是否需要继续兼容？\n"
  + 'OPTIONS: ["保留兼容", "允许升级接口"]\nSTATUS: NEEDS_INPUT';

test("a question and its choices are structured and removed from the report", async () => {
  assert.deepEqual(diagnosis.interaction(QUESTION), ["旧版接口是否需要继续兼容？", ["保留兼容", "允许升级接口"]]);
  assert.deepEqual(diagnosis.parse(QUESTION), ["需要确认是否必须支持旧版接口。", null, "needs_input"]);
  assert.deepEqual(diagnosis.interaction("QUESTION: 你的要求？\nOPTIONS: [invalid]"), ["你的要求？", []]);
  assert.deepEqual(diagnosis.interaction('QUESTION: 要哪种？\nOPTIONS: ["甲", "甲", 1, "乙"]')[1], ["甲", "乙"]);
});

test("a reply to an older report is still in the next prompt", async () => {
  const run = ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "queued", budget_usd: 1, use_cli: true, plan: { summary: "s",
    nodes: [{ id: "n", title: "Check", instructions: "run node --check", capability: "coding", model_id: "x:api" }] },
    diagnoses: Array.from({ length: 8 }, (_, index) => ({ id: String(index), trigger: "manual", status: "done" })) });
  run.diagnoses[0].messages = [DiagnosisMessageSchema.parse({ text: "纠正最早的判断：保留旧接口。" })];
  assert.ok(diagnosis.repairPrompt(run, run.plan.nodes[0], "workspace", "tools", [], []).includes("纠正最早的判断：保留旧接口。"));
});

test("a repair is given the skills of the tools its failure is about", async () => {
  // A license server's ports are knowledge in skills/steps/flexlm-license, not code in the platform.
  const node = TaskNodeSchema.parse({ id: "n", title: "仿真", instructions: "运行 vcs 回归", capability: "coding",
    attempts: [NodeAttemptSchema.parse({ model_id: "x", outcome: "error", reason: "Failed to obtain license: FlexNet Licensing error:-15" })] });
  const run = ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "running", budget_usd: 1, plan: { summary: "s", nodes: [node] } });
  const prompt = diagnosis.repairPrompt(run, node, "/w", "/tools", [], []);
  assert.ok(prompt.includes("### Skill: flexlm-license") && prompt.includes("VENDOR snpslmd PORT=27021"));
  assert.ok(prompt.includes("### Skill: synopsys-vcs"));
  assert.ok(!prompt.includes("tracing `lmutil lmstat`"));
  const quiet = TaskNodeSchema.parse({ ...node, instructions: "写一个网页", attempts: [] });
  assert.ok(!diagnosis.repairPrompt({ ...run, plan: { ...run.plan, nodes: [quiet] } }, quiet, "/w", "/tools", [], []).includes("### Skill:"));
});
