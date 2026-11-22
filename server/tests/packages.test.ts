// Packages of work and artifact contracts in a plan: tests/test_packages.py, ported.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as contracts from "../src/contracts.js";
import { ModelProfileSchema, type TaskNode, TaskNodeSchema, TaskPlanSchema } from "../src/models.js";
import { autonomousPlan, scopeProblems, validatePlan } from "../packages/planning/src/planner.js";
import { expectedTurns } from "../src/progress.js";
import { ProviderResult } from "../src/providers.js";
import { nodePrompt } from "../src/quality.js";
import { contractNode, coverageNodes } from "./helpers/artifacts.js";
import { conftest } from "./helpers/conftest.js";
import { leadDatabase } from "./helpers/lead-run.js";

const { folder } = conftest();
const model = (id: string, planning: number, channel = "api") => ModelProfileSchema.parse({ id, provider: id.split(":")[0], display_name: id, channel,
  context_window: 1_000_000, input_per_million: 1, output_per_million: 1, execution_priority: channel === "cli" ? 0 : 100, scores: { coding: 90, planning, reliability: 90 } });
const MODELS = [model("x:api", 99), model("cli:claude", 90, "cli"), model("cli:codex", 92, "cli"), model("cli:gemini", 99, "cli"), model("mock:local", 100)];
const CONFIGURED = new Set(MODELS.map((m) => m.id));
/** artifact_helpers.raw: a step as a planner writes it. */
const raw = (node: TaskNode): Record<string, any> => {
  const { id, ...rest } = JSON.parse(JSON.stringify(node));
  return { ...rest, key: id };
};
const rawCoverage = () => coverageNodes().map(raw);

test("a package hears what came before, in brief", () => {
  const run = leadDatabase(folder()).getRun("r")!;
  const before = run.plan.nodes[0];
  before.result = "很长的过程说明。".repeat(1000);
  before.provides = "GET /api/admin/mail-settings -> {host, port}";
  const step = TaskNodeSchema.parse({ id: "b", title: "B", instructions: "做设置页", capability: "coding", dependencies: ["a"], files: ["app.js"] });
  run.plan.nodes.push(step);
  const [prompt] = nodePrompt(step, run, 4000);
  assert.ok(prompt.includes("It provides: GET /api/admin/mail-settings -> {host, port}"));
  assert.ok(prompt.split("很长的过程说明").length - 1 < 200); // 1500 characters of it, not the whole result
  // Its answer is the result the user reads: in the task's language, headed in it too.
  assert.ok(prompt.includes("in the language the task was asked in") && prompt.includes("改动 / 提供 / 检查"));
  assert.ok(!prompt.includes("Changed:") && !prompt.includes("Provides:"));
});

test("the lead is asked only about scoped packages", () => {
  const step = TaskNodeSchema.parse({ id: "b", title: "B", instructions: "i", capability: "coding", difficulty: "hard", files: ["a.py"] });
  assert.equal(expectedTurns(step), 25);
  assert.equal(expectedTurns({ ...step, files: [] }), null);
  assert.equal(expectedTurns({ ...step, verifies: ["a"] }), null);
});

test("an artifact's flat plan keeps three distinct jobs and the folder contract", () => {
  const planned = validatePlan({ nodes: rawCoverage() });
  const [vdb, report, audit] = planned.nodes;
  assert.deepEqual(planned.nodes.map((n) => n.artifact_contract!.stage), ["coverage_vdb", "urg_report", "delivery_audit"]);
  assert.equal(vdb.artifact_contract!.outputs[0].kind, "directory");
  assert.ok(report.dependencies[0] === vdb.id && report.dependencies.length === 1 && audit.dependencies[0] === report.id);
  assert.deepEqual(audit.verifies, [report.id]);
  assert.deepEqual(scopeProblems(planned), []);
});

test("an artifact contract missing a declaration is rejected", () => {
  for (const missing of ["inputs", "outputs", "acceptance_commands", "blocked_when", "max_turns", "max_cost_usd"]) {
    const nodes = rawCoverage();
    delete nodes[0].artifact_contract[missing];
    assert.throws(() => validatePlan({ nodes }), /artifact_contract/, missing);
  }
});

test("an artifact contract needs its real producer as a dependency, and a separate audit", () => {
  let nodes = rawCoverage();
  nodes[1].dependencies = [];
  assert.throws(() => validatePlan({ nodes }), /producer dependency/);
  nodes = rawCoverage();
  nodes[0].title = "VDB 采集、URG 文本报告生成及交付审计";
  assert.throws(() => validatePlan({ nodes }), /separate artifact stages/);
});

test("a report reading a VDB is not taken for producing one", () => {
  for (const title of ["从真实 VDB 生成并复现 URG 文本报告", "基于已验收VDB生成URG报告", "读取 VDB 生成 URG 文本报告", "Generate URG report from existing VDB",
    "Generate URG text report using the accepted VDB"]) {
    const nodes = coverageNodes();
    nodes[1].title = title;
    assert.deepEqual(contracts.stages(nodes[1]), new Set(["urg_report"]), title);
    assert.equal(validatePlan({ nodes: nodes.map(raw) }).nodes.length, 3);
    nodes[1].artifact_contract = null;
    assert.deepEqual(contracts.stages(nodes[1]), new Set(["urg_report"]));
    assert.deepEqual(contracts.nodeProblems(nodes[1]), [`${title}: artifact_contract is required`]);
  }
});

test("wording about inputs cannot hide producing artifacts together", () => {
  for (const title of ["从 RTL 生成 VDB 并生成 URG 报告", "Generate VDB and URG report from RTL", "收集 VDB，然后从 VDB 生成 URG 报告"]) {
    const nodes = coverageNodes();
    nodes[1].title = title;
    assert.throws(() => validatePlan({ nodes: nodes.map(raw) }), /separate artifact stages/, title);
  }
});

test("the correction for a missing .vdb suffix explains the format needed", () => {
  const [producer, report] = coverageNodes();
  producer.files = ["artifacts/coverage"];
  producer.artifact_contract!.outputs[0].path = producer.files[0];
  report.reads = ["artifacts/coverage"];
  report.artifact_contract!.inputs[0].path = report.reads[0];
  for (const node of [producer, report]) assert.ok(contracts.nodeProblems(node).some((message) => message.includes(".vdb")));
  assert.ok(contracts.RULES.includes("path ending in .vdb"));
});

test("a report from an external VDB needs no collecting step, and old records still load", () => {
  const [, report, audit] = coverageNodes();
  report.dependencies = [];
  report.artifact_contract!.inputs[0].source = "external";
  const planned = validatePlan({ nodes: [raw(report), raw(audit)] });
  assert.ok(planned.nodes.length === 2 && planned.nodes[0].dependencies.length === 0);
  const old = TaskNodeSchema.parse({ id: "old", title: "coverage overview", instructions: "summarize", capability: "research" });
  assert.ok(old.artifact_contract === null && old.contract_turns === 0);
  assert.deepEqual(scopeProblems(TaskPlanSchema.parse({ summary: "old", nodes: [old] })), []);
});

test("an invalid flat artifact plan cannot fall back to unbounded work", async () => {
  const nodes = rawCoverage();
  delete nodes[0].artifact_contract;
  const bad = { complete: async (modelId: string) => new ProviderResult(JSON.stringify({ nodes }), 1, 1, modelId) };
  const configured = new Set([...CONFIGURED].filter((id) => id !== "mock:local"));
  await assert.rejects(autonomousPlan("Collect VDB then generate URG report", MODELS, configured, bad as never), /Artifact planning blocked/);
});

test("preparing a report does not erase an explicit contract or real report outputs", () => {
  const node = contractNode("helper", "urg_report", [], "parse_report.py");
  node.title = "实现 URG 文本解析器";
  assert.deepEqual(contracts.stages(node), new Set(["urg_report"]));
  assert.ok(contracts.nodeProblems(node).some((problem) => problem.includes("must consume a VDB")));
  node.artifact_contract = null;
  node.files.push("reports/result.txt");
  assert.deepEqual(contracts.stages(node), new Set(["urg_report"]));
  assert.deepEqual(contracts.nodeProblems(node), [`${node.title}: artifact_contract is required`]);
});
