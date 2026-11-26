// leading.ts: tests/test_leading.py, ported.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { settings } from "../src/config.js";
import type { Database } from "../src/db.js";
import { Executor } from "../src/executor.js";
import { DiagnosisMessageSchema, DiagnosisSchema, NodeAttemptSchema, type SupervisorSession, TaskNodeSchema } from "../src/models.js";
import { type CompleteOptions, ProviderResult } from "../src/providers.js";
import * as quality from "../src/quality.js";
import { BEYOND_THE_BAR, failureMessage } from "../packages/lead/src/prompts.js";
import { contractNode, restoreAcceptance, setupExecutor } from "./helpers/artifacts.js";
import { conftest } from "./helpers/conftest.js";
import { decision, leadDatabase, MODELS, run, Team } from "./helpers/lead-run.js";

const { folder } = conftest();
afterEach(() => restoreAcceptance());

const database = () => leadDatabase(folder());

/** The task with a verification of its step. */
function checked(): Database {
  const db = database();
  const current = db.getRun("r")!;
  current.plan.nodes.push(TaskNodeSchema.parse({ id: "v", title: "验证", instructions: "跑测试", capability: "coding", model_id: "x:api", dependencies: ["a"], verifies: ["a"] }));
  db.saveRun(current);
  return db;
}

/** A build that always finishes, and a verification answering from ``verdicts`` in order. */
class Checked extends Team {
  verifications: string[] = [];
  verdicts: string[];

  constructor(decisions: string[], verdicts: string[]) {
    super(decisions, 0);
    this.verdicts = [...verdicts];
  }

  override async complete(modelId: string, prompt: string, options: CompleteOptions = {}): Promise<ProviderResult> {
    if (prompt.includes("You are verifying")) {
      this.verifications.push(prompt);
      return new ProviderResult(this.verdicts.length ? this.verdicts.shift()! : "VERDICT: PASS", 0, 0, modelId);
    }
    return super.complete(modelId, prompt, options);
  }
}


test("the lead decides to retry, with instructions", async () => {
  const team = new Team([decision("retry", { instructions: "先运行测试看清哪三个失败" })]);
  const [, result] = await run(database(), team);
  assert.ok(result.status === "succeeded" && team.work.length === 2);
  assert.ok(team.work[1][1].includes("负责人要求：先运行测试看清哪三个失败"));
  // It was told what failed and could choose among the models for the step.
  assert.ok(team.lead[0].includes("tests failed: 3 errors") && team.lead[0].includes("cli:claude"));
  const [made] = result.decisions;
  assert.deepEqual([made.action, made.node_id, made.lead_model_id], ["retry", "a", "cli:claude"]);
  assert.equal(result.diagnoses.length, 0); // no separate diagnosis any more
});

test("the lead hands the step to another model", async () => {
  const team = new Team([decision("switch_model", { model_id: "cli:claude", instructions: "换个更强的模型" })]);
  const [, result] = await run(database(), team);
  assert.deepEqual(team.work.map((work) => work[0]), ["x:api", "cli:claude"]);
  assert.equal(result.status, "succeeded");
});

test("the lead can accept work a check rejected", async () => {
  const db = database();
  settings.review_nodes = true;
  const team = new Team([decision("accept")], 0, { passed: false, reason: "要求再加一个 --verbose 选项" });
  const [, result] = await run(db, team);
  const node = result.plan.nodes[0];
  assert.ok(result.status === "succeeded" && node.result === "做完了" && node.review === "负责人接受：理由：accept");
  assert.equal(team.work.length, 1);
});

test("the lead ends a step that cannot be done here", async () => {
  const team = new Team([decision("unable", { user_action: "把摄像头接入这台机器" })]);
  const [, result] = await run(database(), team);
  const node = result.plan.nodes[0];
  assert.ok(result.status === "incomplete" && node.status === "unable");
  assert.ok(node.unable_reason!.includes("需要你处理：把摄像头接入这台机器") && team.work.length === 1);
});

test("the lead asks the user and acts on the answer", async () => {
  const db = database();
  const team = new Team([decision("ask_user", { question: "用 SQLite 还是 JSON 存数据？", options: ["SQLite", "JSON"] }), decision("retry", { instructions: "用 SQLite" })]);
  const [executor, result] = await run(db, team);
  const question = result.diagnoses.at(-1)!;
  assert.ok(result.status === "paused" && result.waiting_diagnosis_id === question.id);
  assert.deepEqual([question.trigger, question.choices], ["lead", ["SQLite", "JSON"]]);
  question.messages.push(DiagnosisMessageSchema.parse({ text: "", choice: "SQLite" }));
  result.waiting_diagnosis_id = null;
  db.saveRun(result);
  await (executor as any).leadAnswer("r", question.id);
  await executor.tasks.get("r")!.promise;
  const final = db.getRun("r")!;
  assert.ok(final.status === "succeeded" && team.lead[1].includes("Their answer: SQLite"));
  assert.deepEqual(final.decisions.map((item) => item.event), ["attempt_failed", "user_answer"]);
});

test("a repair the lead decides on after the user's answer runs", async () => {
  // The answer is handled in the task's diagnosis slot; the repair it leads to must not wait for that
  // slot to free up, which would be waiting for itself.
  const db = database();
  const team = new Team([decision("ask_user", { question: "许可证服务没起来，怎么办？", options: ["修环境"] }),
    decision("repair_environment", { instructions: "让步骤能连上许可证服务" })]);
  const [executor, result] = await run(db, team);
  const question = result.diagnoses.at(-1)!;
  question.messages.push(DiagnosisMessageSchema.parse({ text: "交给平台修", choice: null }));
  result.waiting_diagnosis_id = null;
  db.saveRun(result);
  executor.startLeadAnswer("r", question.id);
  await Promise.race([executor.diagnosing.get("r")!.promise, new Promise((_, fail) => setTimeout(() => fail(new Error("waited for itself")), 5000).unref())]);
  const final = db.getRun("r")!;
  assert.ok(team.diagnoses.length === 1 && team.diagnoses[0].includes("让步骤能连上许可证服务"));
  assert.deepEqual(final.diagnoses.map((item) => item.trigger), ["lead", "lead_repair"]);
  if (executor.tasks.has("r")) await executor.tasks.get("r")!.promise;
  assert.equal(db.getRun("r")!.status, "succeeded");
});

test("the lead sends a repair session to fix the environment", async () => {
  const team = new Team([decision("repair_environment", { instructions: "装上 iverilog" })]);
  const [, result] = await run(database(), team);
  assert.ok(result.status === "succeeded" && team.diagnoses.length === 1 && team.diagnoses[0].includes("装上 iverilog"));
});

test("without a valid decision the usual diagnosis takes over", async () => {
  const team = new Team(["我觉得还行", "嗯"]);
  const [, result] = await run(database(), team);
  assert.deepEqual(result.decisions.map((item) => item.action), ["fallback"]);
  assert.ok(team.diagnoses.length === 1 && result.status === "succeeded");
  // Asked twice about the failure; then, with every step done, asked to check the whole result.
  assert.ok(team.lead[0].includes("EVENT: an attempt failed") && team.lead[2].includes("EVENT: every step has finished"));
});

test("past the decision limit the task pauses for the user", async () => {
  const db = database();
  settings.max_node_decisions = 2;
  const team = new Team(Array(5).fill(decision("retry", { instructions: "再试" })), 10);
  const [, result] = await run(db, team);
  assert.ok(result.status === "paused" && result.error!.includes("已决策 2 次"));
  assert.ok(result.decisions.length === 2 && team.work.length === 3);
});

test("the lead sends work back with what to change", async () => {
  const db = checked();
  // Rework rounds no longer cap it: the lead's decision limits do.
  settings.max_rework_rounds = 0;
  const team = new Checked([decision("rework", { targets: ["a"], instructions: "补上空文件的处理" })], ["VERDICT: FAIL: 空文件会崩溃"]);
  const [, result] = await run(db, team);
  assert.ok(result.status === "succeeded" && result.rework_rounds === 1);
  assert.ok(team.work.length === 2 && team.work[1][1].includes("负责人要求：补上空文件的处理"));
  assert.ok(team.lead[0].includes("空文件会崩溃") && team.lead[0].includes('"targets"'));
  assert.deepEqual(result.decisions.map((item) => item.action), ["rework"]);
});

test("the lead overrules a verification that asks for too much", async () => {
  const team = new Checked([decision("accept")], ["VERDICT: FAIL: 还应该支持 Windows 路径"]);
  const [, result] = await run(checked(), team);
  const verifier = result.plan.nodes[1];
  assert.ok(result.status === "succeeded" && team.work.length === 1 && result.rework_rounds === 0);
  assert.ok(verifier.review!.startsWith("负责人接受"));
});

test("the lead reruns a verification that got it wrong", async () => {
  const team = new Checked([decision("retry", { instructions: "先装依赖再跑测试" })], ["VERDICT: FAIL: 测试找不到模块"]);
  const [, result] = await run(checked(), team);
  assert.ok(result.status === "succeeded" && team.work.length === 1 && team.verifications.length === 2);
  assert.ok(team.verifications[1].includes("负责人要求：先装依赖再跑测试"));
});

test("without a decision a failed verification sends the work back as before", async () => {
  const team = new Checked(["随便", decision("rework", { targets: ["nope"] })], ["VERDICT: FAIL: 空文件会崩溃"]);
  const [, result] = await run(checked(), team);
  assert.deepEqual(result.decisions.map((item) => item.action), ["fallback"]);
  assert.ok(result.status === "succeeded" && result.rework_rounds === 1 && team.work.length === 2);
});

test("the user talks with the lead in its conversation", async () => {
  const db = database();
  const team = new Team(["空文件的处理我会在下一次决策时要求补上。"]);
  const executor = new Executor(db, team, MODELS);
  assert.ok(executor.startLeadChat("r", "记得要处理空文件"));
  // One message at a time: the lead is still answering.
  assert.ok(!executor.startLeadChat("r", "还有别的吗"));
  assert.deepEqual(db.getRun("r")!.lead_messages.map((m) => [m.role, m.status]), [["user", "done"], ["lead", "pending"]]);
  await executor.leadTasks.get("r")!.promise;
  const [asked, answered] = db.getRun("r")!.lead_messages;
  assert.ok(asked.text === "记得要处理空文件" && answered.status === "done" && answered.text.includes("空文件"));
  assert.ok(team.lead[0].includes("MESSAGE from the user") && team.lead[0].includes("记得要处理空文件"));
});

test("the panel shows the lead deciding until it has", async () => {
  const db = database();
  const seen: unknown[] = [];
  class Watched extends Team {
    override async converse(session: SupervisorSession, prompt: string): Promise<ProviderResult> {
      seen.push(db.getRun("r")!.lead_thinking);
      return super.converse(session, prompt);
    }
  }
  const [, result] = await run(db, new Watched([decision("retry", { instructions: "再试" })]));
  const first = seen[0] as { event: string; node_id: string };
  assert.deepEqual([first.event, first.node_id], ["attempt_failed", "a"]);
  assert.equal(result.lead_thinking, null);
  assert.ok(db.events("r").some((event) => event.kind === "run.lead_thinking"));
});

test("a repair that did not work goes back to the lead before the step runs", async () => {
  class Failing extends Team {
    override async complete(modelId: string, prompt: string, options: CompleteOptions = {}): Promise<ProviderResult> {
      if (options.repair) {
        this.diagnoses.push(prompt);
        return new ProviderResult("## 修复内容\n没找到可用的 SSH 私钥\nSTATUS: RETRY", 0, 0, modelId);
      }
      return super.complete(modelId, prompt, options);
    }
  }
  const team = new Failing([decision("repair_environment", { instructions: "把私钥放进工作目录" }), decision("unable", { user_action: "提供服务器登录凭据" })], 10);
  const [, result] = await run(database(), team);
  const repair = result.diagnoses.at(-1)!;
  assert.deepEqual([repair.trigger, repair.decision_id], ["lead_repair", result.decisions[0].id]);
  assert.ok(team.lead.at(-1)!.includes("EVENT: the repair you asked for") && team.lead.at(-1)!.includes("没找到可用的 SSH 私钥"));
  // The step was not sent back to meet the same wall: the lead ended it.
  assert.ok(team.work.length === 1 && result.plan.nodes[0].status === "unable");
  assert.deepEqual(result.decisions.map((item) => item.event), ["attempt_failed", "repair_done"]);
});

function atLimit(fields: Record<string, number> = {}) {
  const node = contractNode();
  Object.assign(node, fields);
  node.status = "running";
  const [executor, db, providers] = setupExecutor(folder(), [node]);
  const run = db.getRun("artifacts")!;
  run.status = "running";
  db.saveRun(run);
  return [executor, db, providers] as const;
}

test("an artifact's lead cannot accept missing evidence", async () => {
  const [executor, db, providers] = atLimit({ contract_turns: 3 });
  await executor.applyDecision("artifacts", "vdb", { action: "accept", options: [] }, quality.verdict({ passed: false, reason: "not delivered" }), "rejected", "attempt_failed");
  assert.ok(db.getRun("artifacts")!.plan.nodes[0].status === "blocked" && providers.calls.length === 0);
});

test("running a step at its limit again grants it more calls", async () => {
  for (const action of ["retry", "switch_model"]) {
    const [executor, db] = atLimit({ contract_turns: 3, contract_tool_calls: 3, contract_cost_usd: 0.2 });
    await executor.applyDecision("artifacts", "vdb", { action, model_id: "test:worker", options: [] }, quality.verdict({ passed: false, reason: "limit" }), "stopped", "attempt_failed");
    const node = db.getRun("artifacts")!.plan.nodes[0];
    // contract_node is "normal": 3 used and 40 more; the cost limit ($1 for 3 calls) grows with them.
    assert.ok(node.status === "pending" && node.artifact_contract!.max_turns === 43, action);
    assert.ok(Math.abs(node.artifact_contract!.max_cost_usd - (1 + 40 / 3)) < 1e-3);
    assert.ok(db.events("artifacts").some((e) => e.kind === "node.limit_extended"));
  }
});

test("a step at its limit goes to the lead and stops without a decision", async () => {
  const [executor, db] = atLimit({ contract_tool_calls: 3 });
  executor.canLead = () => true;
  const asked: string[] = [];
  executor.askForDecision = async (_runId, _nodeId, prompt) => {
    asked.push(prompt);
    return null;
  };
  await executor.finish("artifacts", "vdb", null, quality.verdict({ passed: false, reason: "limit" }), [], [], 0, "stopped");
  assert.ok(asked.length === 1 && asked[0].includes("declared limit") && asked[0].includes("coverage.vdb"));
  assert.equal(db.getRun("artifacts")!.plan.nodes[0].status, "blocked");
});

test("a step already at its limit before it starts goes to the lead, not straight to a stop", async () => {
  // Its calls were used before it started (a head start, say): the lead decides, here to run it again.
  const node = contractNode();
  Object.assign(node, { contract_tool_calls: 3 });
  const [executor, db, providers] = setupExecutor(folder(), [node]);
  executor.canLead = () => true;
  const asked: string[] = [];
  executor.askForDecision = async (_runId, _nodeId, prompt) => {
    asked.push(prompt);
    return { action: "retry", reason: "almost done", options: [] } as never;
  };
  await executor.execute("artifacts");
  const run = db.getRun("artifacts")!;
  assert.ok(asked.length === 1 && asked[0].includes("declared limit"), asked.join("\n---\n"));
  assert.ok(db.events("artifacts").some((e) => e.kind === "node.limit_reached") && db.events("artifacts").some((e) => e.kind === "node.limit_extended"));
  assert.ok(run.plan.nodes[0].artifact_contract!.max_turns > 3 && providers.calls.includes("vdb"));
  assert.notEqual(run.status, "incomplete", run.error ?? "");
  assert.equal(run.plan.nodes[0].attempts[0].outcome, "stopped"); // the stop before it started, in its history
});

test("without a lead a step already at its limit stops as declared", async () => {
  const node = contractNode();
  Object.assign(node, { contract_tool_calls: 3 });
  const [executor, db, providers] = setupExecutor(folder(), [node]);
  executor.canLead = () => false;
  await executor.execute("artifacts");
  const run = db.getRun("artifacts")!;
  assert.equal(run.plan.nodes[0].status, "blocked");
  assert.equal(run.status, "incomplete");
  assert.deepEqual(providers.calls, []);
});

/** A report step blocked by a coverage gap, after the step that produced the coverage. */
function blockedRun(made: unknown) {
  const vdb = contractNode();
  vdb.status = "succeeded";
  const report = contractNode("report", null as never, [{ path: "coverage.vdb", kind: "directory", source: "dependency" }], "report.txt", { dependencies: ["vdb"] });
  report.status = "running";
  const [executor, db] = setupExecutor(folder(), [vdb, report]);
  const run = db.getRun("artifacts")!;
  run.status = "running";
  db.saveRun(run);
  executor.canLead = () => true;
  const asked: [string, Set<string> | null][] = [];
  executor.askForDecision = async (_runId, _nodeId, prompt, _modelIds, targets = null) => {
    asked.push([prompt, targets]);
    return made as never;
  };
  return [executor, db, asked] as const;
}

test("a blocked step goes to the lead, who can send back what it builds on", async () => {
  const made = { action: "rework", reason: "覆盖率差两个条件", targets: ["vdb"], instructions: "补两个定向 case 覆盖 77、78 行", options: [] };
  const [executor, db, asked] = blockedRun(made);
  await executor.finish("artifacts", "report", null, quality.verdict({ passed: false, reason: "BLOCKED: 条件覆盖 16/18，未到 100%" }), [], [], 0, "blocked");
  const [[prompt, targets]] = asked;
  assert.deepEqual(targets, new Set(["vdb"]));
  assert.ok(prompt.includes("BLOCKED") && prompt.includes("rework"));
  const run = db.getRun("artifacts")!;
  const [vdb, report] = run.plan.nodes;
  assert.ok(vdb.status === "pending" && report.status === "pending" && vdb.feedback!.includes("77、78"));
  assert.ok(run.rework_rounds === 1 && db.events("artifacts").some((e) => e.kind === "run.rework"));
});

test("a blocked step without a decision stops as declared", async () => {
  const [executor, db, asked] = blockedRun(null);
  await executor.finish("artifacts", "report", null, quality.verdict({ passed: false, reason: "BLOCKED: 缺少 VDB" }), [], [], 0, "blocked");
  assert.equal(asked.length, 1);
  assert.equal(db.getRun("artifacts")!.plan.nodes[1].status, "blocked");
});

test("the lead calls the platform engineer, which finds where to repair", async () => {
  const db = database();
  settings.engineer_repairs = true;
  const team = new Team([decision("call_engineer", { kind: "repair", instructions: "iverilog: command not found" })]);
  const [, result] = await run(db, team);
  assert.ok(result.status === "succeeded" && team.diagnoses.length === 1);
  // It decides where the fault is, with the lead's evidence.
  assert.ok(team.diagnoses[0].startsWith("You are FluidForm's platform engineer"));
  assert.ok(team.diagnoses[0].includes("whether this machine or FluidForm itself is at fault") && team.diagnoses[0].includes("iverilog: command not found"));
  assert.equal(result.decisions[0].action, "call_engineer");
  // The lead is offered the one action, not the three it replaces.
  assert.ok(team.lead[0].includes("call_engineer") && !team.lead[0].includes("repair_environment"));
});

test("a component asked for with call_engineer waits for the engineer", async () => {
  const db = database();
  settings.engineer_repairs = true;
  const asked: string[] = [];
  const team = new Team([decision("call_engineer", { kind: "component", instructions: "需要一个读飞书文档的工具" })]);
  const executor = new Executor(db, team, MODELS);
  // null back: the engineer cannot take it here, the step ends as unable.
  executor.engineerForLead = (_run, _node, request) => {
    asked.push(request);
    return null;
  };
  await executor.execute("r");
  assert.deepEqual(asked, ["需要一个读飞书文档的工具"]);
  assert.equal(team.diagnoses.length, 0);
});

test("the lead hears what the engineer found when the user called it", async () => {
  // Regression: a look the user asked for (or one before the first step) was never told to the lead,
  // which then sent the engineer to repair the same thing again.
  const db = database();
  const record = db.getRun("r")!;
  record.diagnoses.push(DiagnosisSchema.parse({ id: "d1", trigger: "manual", node_id: "a", status: "done", verdict: "fixed",
    report: "许可证服务器没启动，已重启 lmgrd 并记入 sandbox.json" }));
  db.saveRun(record);
  const team = new Team([decision("retry", { instructions: "再跑一次" })]);
  await run(db, team);
  assert.ok(team.lead[0].includes("What the platform engineer (平台工程师) found and did here so far:"));
  assert.ok(team.lead[0].includes("the user asked: fixed. 许可证服务器没启动"));
});

test("a requirement a step set itself is not the bar", () => {
  // The axi-to-apb task: the step building the test bench wrote "every legal parameter combination"
  // into its own requirements list; the report step then stopped twice over it.
  const task = database().getRun("r")!;
  const step = task.plan.nodes[0];
  step.acceptance_criteria = "报告每项覆盖率都有原始数据依据";
  const [prompt] = quality.nodePrompt(step, task, 4000);
  assert.ok(prompt.includes(quality.OWN_BAR));
  const verdict = { reason: "R25 要求全部合法参数配置", fix: null };
  step.attempts = [NodeAttemptSchema.parse({ model_id: "cli:codex", outcome: "blocked", reason: verdict.reason })];
  const told = failureMessage(task, step, step.attempts.at(-1)!, verdict, Object.values(MODELS), [3, 10]);
  assert.ok(told.includes(BEYOND_THE_BAR) && told.includes("as you set them: 报告每项覆盖率都有原始数据依据"));
  step.attempts.at(-1)!.outcome = "error";
  assert.ok(!failureMessage(task, step, step.attempts.at(-1)!, verdict, Object.values(MODELS), [3, 10]).includes(BEYOND_THE_BAR));
});
