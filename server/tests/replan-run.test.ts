// The lead changing the plan while a task runs: tests/test_replan.py, ported.
import assert from "node:assert/strict";
import { test } from "node:test";
import { settings } from "../src/config.js";
import { type ExecutionRun, ExecutionRunSchema, type TaskNode } from "../src/models.js";
import { changePlan, PlanError } from "../src/replan.js";
import { coverageNodes } from "./helpers/artifacts.js";
import { conftest } from "./helpers/conftest.js";
import { decision, leadDatabase, MODELS, run, Team } from "./helpers/lead-run.js";

const { folder } = conftest();
const CONFIGURED = new Set(Object.keys(MODELS));
const SPLIT = { remove: ["a"], add: [{ key: "one", title: "上半部分", instructions: "先做解析" }, { key: "two", title: "下半部分", instructions: "再做输出", dependencies: ["one"] }] };
const plan = (...nodes: TaskNode[]): ExecutionRun => ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "running", budget_usd: 1, plan: { summary: "s", nodes } });
const raw = (node: TaskNode): Record<string, any> => {
  const { id, ...rest } = JSON.parse(JSON.stringify(node));
  return { ...rest, key: id };
};
const firstLine = (text: string) => text.split("\n", 1)[0];

test("an artifact replan cannot remove a contract, a handoff or the acceptance", async () => {
  for (const change of [{ remove: ["report"] }, { update: [{ id: "report", dependencies: [] }] }, { update: [{ id: "report", artifact_contract: null }] },
    { update: [{ id: "report", acceptance_criteria: "Trust the claim" }] }]) {
    const current = plan(...coverageNodes());
    const before = JSON.stringify(current);
    await assert.rejects(changePlan(current, change, Object.values(MODELS), CONFIGURED), PlanError, JSON.stringify(change));
    assert.equal(JSON.stringify(current), before);
  }
});

test("an artifact replan keeps the usage on an allowed change of instructions", async () => {
  const current = plan(...coverageNodes());
  current.plan.nodes[1].contract_turns = 2;
  current.plan.nodes[1].contract_cost_usd = 0.5;
  await changePlan(current, { update: [{ id: "report", instructions: "Parse only the declared VDB" }] }, Object.values(MODELS), CONFIGURED);
  assert.equal(current.plan.nodes[1].contract_turns, 2);
  assert.equal(current.plan.nodes[1].contract_cost_usd, 0.5);
});

test("an artifact replan cannot copy a used-up deliverable with fresh limits", async () => {
  const nodes = coverageNodes();
  const current = plan(...nodes);
  current.plan.nodes[0].contract_turns = 3;
  await assert.rejects(changePlan(current, { add: [{ ...raw(nodes[0]), key: "fresh" }] }, Object.values(MODELS), CONFIGURED), /duplicate artifact producer/);
  assert.ok(current.plan.nodes.length === 3 && current.plan.nodes[0].contract_turns === 3);
});

test("the lead splits a step that is too big", async () => {
  const db = leadDatabase(folder());
  const team = new Team([decision("replan", { plan: SPLIT })]);
  const [, result] = await run(db, team);
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.plan.nodes.map((node) => node.title), ["上半部分", "下半部分"]);
  assert.deepEqual(team.work.slice(1).map((work) => firstLine(work[1])), ["Task: 先做解析", "Task: 再做输出"]);
  assert.ok(db.events("r").some((event) => event.kind === "run.plan_changed"));
});

test("a plan change that cannot be made is sent back with why", async () => {
  const team = new Team([decision("replan", { plan: { add: [{ key: "x", instructions: "i", dependencies: ["nope"] }] } }), decision("retry", { instructions: "再试一次" })]);
  const [, result] = await run(leadDatabase(folder()), team);
  assert.ok(team.lead[1].includes("cannot be made: step x dependencies: unknown or removed step nope"));
  assert.ok(result.decisions[0].action === "retry" && result.status === "succeeded");
});

test("the lead confirms the whole result before the task ends", async () => {
  const team = new Team([JSON.stringify({ action: "done", reason: "需求都做到了" })], 0);
  const [, result] = await run(leadDatabase(folder()), team);
  assert.equal(result.status, "succeeded");
  assert.ok(team.lead[0].includes("EVENT: every step has finished") && team.lead[0].includes("写一个工具"));
  assert.deepEqual(result.decisions.map((item) => [item.event, item.action]), [["all_done", "done"]]);
  assert.equal(result.final_result, result.plan.nodes.at(-1)!.result); // no summary: the steps' output, as before
});

test("the task ends with the lead's summary, not the last step's output", async () => {
  // The axi-to-apb task ended with the last rework's note about a rebuild script; what the module does
  // and how far it was verified was only in the lead's reason.
  const summary = "AXI4→APB4 桥已完成，53 次回归通过；功能覆盖率 100%，代码覆盖率未到 100%，原因见报告。";
  const team = new Team([JSON.stringify({ action: "done", reason: "整体验收通过", summary })], 0);
  const [, result] = await run(leadDatabase(folder()), team);
  assert.ok(team.lead[0].includes("summary") && team.lead[0].includes("what was delivered"));
  assert.ok(result.final_result!.startsWith(summary));
  assert.equal(result.decisions.at(-1)!.summary, summary);
});

test("the lead sends finished work back when the whole falls short", async () => {
  const team = new Team([decision("rework", { targets: ["a"], instructions: "README 里补上安装步骤" }), decision("done")], 0);
  const [, result] = await run(leadDatabase(folder()), team);
  assert.ok(result.status === "succeeded" && team.work.length === 2);
  assert.ok(team.work[1][1].includes("负责人检查整体结果后要求返工：README 里补上安装步骤"));
});

test("the lead adds what is missing at the end", async () => {
  const added = { add: [{ key: "docs", title: "写说明", instructions: "写使用说明", dependencies: ["a"] }] };
  const team = new Team([decision("replan", { plan: added }), decision("done")], 0);
  const [, result] = await run(leadDatabase(folder()), team);
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.plan.nodes.map((node) => node.title), ["实现", "写说明"]);
  assert.deepEqual(team.work.map((work) => firstLine(work[1])), ["Task: 写代码", "Task: 写使用说明"]);
});

test("without a lead a finished task ends as before", async () => {
  const db = leadDatabase(folder());
  settings.lead_decisions = false;
  const team = new Team([], 0);
  const [, result] = await run(db, team);
  assert.ok(result.status === "succeeded" && team.lead.length === 0);
});
