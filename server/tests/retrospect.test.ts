// retrospect.ts: tests/test_retrospect.py, ported. Finished tasks are looked back on, so a problem
// that keeps coming back is seen as one.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { builtinModels } from "../src/catalog.js";
import { Database } from "../src/db.js";
import { repairPrompt } from "../packages/engineer/src/prompts.js";
import { CapabilityScoreSchema, DiagnosisSchema, EventSchema, ExecutionRunSchema, type ExecutionRun, type ModelProfile, TaskNodeSchema,
  type TaskNode } from "../src/models.js";
import * as retrospect from "../src/retrospect.js";
import * as retrospectPackage from "../packages/learning/src/naming.js";
// @ts-expect-error: the pricing package is plain JavaScript
import { calibration } from "../packages/pricing/pricing.mjs";
import * as pricing from "../src/pricing.js";

const fresh = () => new Database(join(mkdtempSync(join(tmpdir(), "retro-")), "t.db"));

function finished(runId: string, nodes: TaskNode[], daysAgo = 0, fields: Record<string, unknown> = {}): ExecutionRun {
  const created = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  return ExecutionRunSchema.parse({ id: runId, prompt: "写一个 FIFO", budget_usd: 2, plan: { summary: "s", nodes }, created_at: created,
    updated_at: created, status: "succeeded", ...fields });
}

const vcsStep = (nodeId = "n", turns = 40, cost = 0.3) => TaskNodeSchema.parse({
  id: nodeId, title: "冒烟测试", instructions: "i", capability: "coding", model_id: "deepseek:flash", status: "succeeded",
  estimated_cost_usd: 0.01, difficulty: "normal",
  attempts: [{ model_id: "glm:glm", outcome: "unavailable", reason: "glm request failed: 5 分钟没有回复" },
    { model_id: "deepseek:flash", outcome: "passed", cost_usd: cost, turns, tool_calls: [
      { turn: 1, tool: "Bash", detail: "source /eda/.edarc && which vcs", ok: false },
      { turn: 2, tool: "Bash", detail: "vcs -sverilog tb.sv", ok: false }] }],
});
const platformStep = (nodeId = "p") => TaskNodeSchema.parse({ id: nodeId, title: "仿真", instructions: "i", capability: "coding",
  model_id: "deepseek:flash", status: "succeeded", attempts: [{ model_id: "deepseek:flash", outcome: "passed" }] });
const diagnosis = (fields: Record<string, unknown>) => DiagnosisSchema.parse({ trigger: "auto", node_id: "n", status: "done", verdict: "fixed", ...fields });

test("a finished task is summed up with its problems", () => {
  const run = finished("r", [vcsStep()], 0, { diagnoses: [diagnosis({ id: "d", report: "## 根因\n沙箱里找不到 vcs 命令" })] });
  const events = [EventSchema.parse({ run_id: "r", kind: "approval.required", data: { reason: "diagnosis_unresolved", node_id: "n" } }),
    EventSchema.parse({ run_id: "r", kind: "approval.required", data: { reason: "user_paused" } }),
    EventSchema.parse({ run_id: "r", kind: "node.progress_check", data: { model_id: "deepseek:flash", stop: true, node_id: "n", reason: "反复运行同一条命令" } })];
  const body = retrospect.review(run, events);
  const [step] = body.steps;
  assert.deepEqual([step.estimated_usd, step.actual_usd, step.turns, step.expected_turns], [0.01, 0.3, 40, 15]);
  assert.deepEqual(new Set(body.problems.map((item) => `${item.kind}|${item.key}`)), new Set(["estimate_low|deepseek:flash", "turns_over|deepseek:flash",
    "model_unavailable|glm:glm", "environment|vcs", "paused|diagnosis_unresolved", "stuck|deepseek:flash"]));
  const environment = body.problems.find((item) => item.kind === "environment")!;
  assert.ok(environment.repaired);
  assert.equal(environment.label, "沙箱里找不到 vcs 命令");
});

test("a step its lead let through without passing is a problem of its own", () => {
  const let_through = TaskNodeSchema.parse({ id: "a", title: "综合", instructions: "i", capability: "coding", model_id: "minimax:m3", status: "succeeded",
    accepted_by_lead: true, review: "负责人接受：实质交付已完成", attempts: [{ model_id: "minimax:m3", outcome: "error" }] });
  const body = retrospect.review(finished("r", [let_through, platformStep()]), []);
  assert.deepEqual(body.steps.map((step) => step.accepted_by_lead ?? false), [true, false]);
  const found = body.problems.filter((item) => item.kind === "accepted_unpassed");
  assert.equal(found.length, 1);
  assert.equal(found[0].key, "minimax:m3");
  assert.equal(found[0].label, "未通过（error），负责人放行：实质交付已完成");
});

test("the program a failing command was about", () => {
  assert.equal(retrospect.program("source /eda/.edarc && which vcs && vcs -ID"), "vcs");
  assert.equal(retrospect.program("cd /work; PATH=/x:$PATH /opt/bin/iverilog -g2012 a.v"), "iverilog");
  assert.equal(retrospect.program("echo hi"), null);
  assert.equal(retrospect.program("bash -lc 'set -euo pipefail; source /eda/.edarc >/dev/null 2>&1; vcs -sverilog -full64 a.sv'"), "vcs");
  assert.equal(retrospect.program("cd /work && ./run.sh"), "run.sh");
});

test("a repair names the area it touched", () => {
  assert.deepEqual(retrospect.repairedAreas(["backend/super_partner/agent.py", "tests/test_agent.py", "docs/ARCHITECTURE.md", "bin/ssh", "sandbox.json"]),
    [["platform", "agent"], ["environment", "ssh"], ["environment", "sandbox"]]);
  // Since the switch to TS: the same module names, so a problem's repairs before and after count together.
  assert.deepEqual(retrospect.repairedAreas(["server/src/agent.ts", "server/src/cli-channels.ts", "server/tests/agent.test.ts"]),
    [["platform", "agent"], ["platform", "cli_channels"]]);
  // A module keeps its name in an extension's folder too.
  assert.deepEqual(retrospect.repairedAreas(["server/packages/planning/src/team-planning.ts"]), [["platform", "team_planning"]]);
});

test("recurring problems makes no retrospectives for cancelled tasks", () => {
  const db = fresh();
  db.saveRun(finished("cancelled", [vcsStep()], 0, { status: "cancelled" }));
  db.saveRun(finished("natural", [vcsStep()]));
  retrospect.recurring(db);
  assert.equal(db.retrospective("cancelled"), null);
  assert.notEqual(db.retrospective("natural"), null);
});

test("a problem that comes back after a repair is marked", () => {
  const db = fresh();
  for (const [runId, days] of [["first", 3], ["second", 1], ["third", 0]] as const) db.saveRun(finished(runId, [vcsStep()], days));
  // The sandbox was repaired in the first task and again in the second: it did not hold.
  for (const runId of ["first", "second"]) {
    db.saveSharedRepair({ id: `rep-${runId}`, run_id: runId, scope: "fluidform", status: "activated", files: ["backend/super_partner/agent.py"],
      report: "根本原因：沙箱没有加载 EDA 环境", created_at: new Date().toISOString() });
  }
  const groups = new Map(retrospect.recurring(db).map((group) => [`${group.kind}|${group.key}`, group]));
  const sandbox = groups.get("platform|agent")!;
  assert.deepEqual([sandbox.runs, sandbox.repaired_in], [["first", "second"], ["first", "second"]]);
  assert.equal(sandbox.recurred_after_repair, true);
  assert.equal(groups.get("estimate_low|deepseek:flash")!.runs.length, 3);
  assert.equal(groups.get("estimate_low|deepseek:flash")!.recurred_after_repair, false);
  // Kept, even when its task is deleted: later tasks learn from it.
  db.deleteRun("first");
  assert.equal(db.retrospective("first")!.run_id, "first");
});

test("a diagnosis is told about the same problem in earlier tasks", () => {
  const db = fresh();
  db.saveRun(finished("earlier", [vcsStep()], 2, { diagnoses: [diagnosis({ id: "d1", report: "根本原因：沙箱里没有加载 .edarc，所以找不到 vcs" })] }));
  const now = finished("now", [vcsStep()], 0, { status: "running" });
  const lines = retrospect.similar(db, now, now.plan.nodes[0]);
  const [line] = lines.filter((item) => item.startsWith("- environment:vcs"));
  assert.ok(line.includes("1 earlier task") && line.includes("沙箱里没有加载 .edarc"));
  const prompt = repairPrompt(now, now.plan.nodes[0], "/w", "/tools", [], [], [], "", "", lines);
  assert.ok(prompt.includes("The same kind of problem in earlier tasks") && prompt.includes("沙箱里没有加载 .edarc"));
  assert.ok(!repairPrompt(now, now.plan.nodes[0], "/w", "/tools", [], []).includes("The same kind of problem"));
});

const SCORE_KEYS = Object.keys(CapabilityScoreSchema.parse({}));
function cheapModels(): [ModelProfile[], Set<string>] {
  const models = builtinModels().map((model) => (model.scores === null
    ? { ...model, scores: CapabilityScoreSchema.parse(Object.fromEntries(SCORE_KEYS.map((key) => [key, 90]))) } : model));
  return [models, new Set(models.map((model) => model.id))];
}

/** A cheap model that names problems: the EDA ones alike, whatever the records call them. */
function namer(reply: string | null = null) {
  const prompts: [string, string][] = [];
  const call = async (modelId: string, prompt: string) => {
    prompts.push([modelId, prompt]);
    if (reply !== null) return { text: reply, input_tokens: 10, output_tokens: 5 };
    const lines = prompt.split("Problems:\n")[1].split("\n\n")[0].split("\n");
    const names = lines.map((line) => (line.includes("vcs") || line.includes("platform:agent") || line.includes(".edarc") ? "新思 EDA 环境未加载" : "其他"));
    return { text: JSON.stringify({ names }), input_tokens: 10, output_tokens: 5 };
  };
  return Object.assign(call, { prompts });
}

test("one cause under two names is counted as one", async () => {
  const db = fresh();
  const [models, configured] = cheapModels();
  const name = namer();
  db.saveRun(finished("first", [vcsStep()], 2, { diagnoses: [diagnosis({ id: "d1", report: "沙箱里没有加载 .edarc" })] }));
  db.saveRun(finished("second", [platformStep()], 1));
  retrospect.record(db, "first");
  db.saveRetrospective("second", retrospect.review(db.getRun("second")!, [], [{ id: "j", files: ["backend/super_partner/agent.py"], report: "步骤沙箱加载 .edarc", node_id: "p" }]));
  for (const runId of ["first", "second"]) await retrospectPackage.nameProblems(db, name, models, configured, runId);
  assert.ok(name.prompts[1][1].includes("新思 EDA 环境未加载")); // the names given so far are offered again
  const [eda] = retrospect.topics(db).filter((group) => group.topic === "新思 EDA 环境未加载");
  assert.deepEqual(eda.runs, ["first", "second"]);
  assert.ok(eda.members.includes("environment:vcs") && eda.members.includes("platform:agent") && eda.recurred_after_repair);
  // A third task's diagnosis of a failing VCS step hears of the sandbox repair too.
  const now = finished("now", [vcsStep()], 0, { status: "running" });
  const [line] = retrospect.similar(db, now, now.plan.nodes[0]).filter((item) => item.startsWith("- 「新思 EDA"));
  assert.ok(line.includes("platform:agent") && line.includes("2 earlier task"));
  // Recorded again, the problems keep their names.
  retrospect.record(db, "first");
  assert.ok((db.retrospective("first")!.problems as any[]).every((item) => item.topic));
  assert.ok((db.retrospective("first")!.topics_cost_usd as number) >= 0);
});

test("a bad naming reply leaves the retrospective as it was", async () => {
  for (const reply of ["not json", '{"names": ["只有一个"]}']) {
    const db = fresh();
    const [models, configured] = cheapModels();
    db.saveRun(finished("r", [vcsStep()]));
    const before = retrospect.record(db, "r")!;
    assert.ok(before.problems.length > 1);
    await retrospectPackage.nameProblems(db, namer(reply), models, configured, "r");
    assert.deepEqual(db.retrospective("r"), JSON.parse(JSON.stringify(before)));
    assert.deepEqual(retrospect.topics(db), []);
  }
});

const history = (runId: string, modelId: string, estimated: number, actual: number[], total: number) =>
  ({ run_id: runId, actual_usd: total, steps: actual.map((spent) => ({ model_id: modelId, estimated_usd: estimated, actual_usd: spent })) });
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);

test("the calibration learns each model's overrun and the work outside steps", async () => {
  const reviews = [history("a", "cli:codex", 0.1, [1.0, 2.0, 3.0], 12.0), history("b", "x:api", 0.1, [0.2, 0.2], 0.4),
    history("c", "x:api", 0.1, [0.0], 0.0)]; // never ran: says nothing
  const cal = calibration(reviews);
  assert.deepEqual(Object.keys(cal.models), ["cli:codex"]); // x:api has only two steps that ran
  near(cal.models["cli:codex"], 20);
  near(cal.overall!, 6.4 / 0.5);
  near(cal.overhead, 12.4 / 6.4);
  const run = finished("new", [TaskNodeSchema.parse({ id: "n1", title: "t", instructions: "i", capability: "coding", model_id: "cli:codex", estimated_cost_usd: 0.5 }),
    TaskNodeSchema.parse({ id: "n2", title: "t", instructions: "i", capability: "coding", model_id: "x:api", estimated_cost_usd: 0.1 })], 0, { status: "awaiting_confirmation" });
  run.plan.estimate = await pricing.estimate(run.plan.nodes, 2, 0.2);
  const expected = (0.5 * 20 + 0.1 * 12.8 + 0.2 * 12.8) * (12.4 / 6.4);
  const [calibrated] = await pricing.calibrated(reviews, [run]);
  assert.ok(Math.abs(calibrated! - expected) <= 1e-4 * expected);
});

test("without enough history there is no calibration, and a task never calibrates itself", async () => {
  const reviews = [history("a", "cli:codex", 0.1, [1.0, 2.0, 3.0], 6.0)];
  assert.equal(calibration([]).overall, null);
  assert.equal(calibration(reviews, "a").overall, null);
  const own = finished("a", []);
  own.plan.estimate = await pricing.estimate([], 2, 0.2);
  assert.deepEqual(await pricing.calibrated(reviews, [own]), [null]);
});
