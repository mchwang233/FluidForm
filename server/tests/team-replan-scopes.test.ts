// team.form and team.delegate (team-planning.ts), replan.ts and scopes.ts: tests/test_team.py,
// tests/test_replan.py and tests/test_scopes.py, ported.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { settings } from "../src/config.js";
import { CapabilityScoreSchema, EmployeeSchema, type ExecutionRun, ExecutionRunSchema, folderId, ModelProfileSchema, SupervisorSessionSchema,
  TaskNodeSchema } from "../src/models.js";
import { autonomousPlan, PlanProblem } from "../src/planner.js";
import { ProviderResult } from "../src/providers.js";
import { changePlan, PlanError } from "../src/replan.js";
import * as scopes from "../src/scopes.js";
import * as teamPlanning from "../src/team-planning.js";
import { conftest } from "./helpers/conftest.js";

const { folder } = conftest();
const SCORES = Object.fromEntries(Object.keys(CapabilityScoreSchema.parse({})).map((key) => [key, 95]));
const models = () => ["build", "verify"].map((name) => ModelProfileSchema.parse({ id: `test:${name}`, provider: "test", display_name: name, scores: SCORES,
  scores_source: "artificial_analysis", context_window: 200000, max_output_tokens: 4096, input_per_million: 1, output_per_million: 1, supports_tools: true }));
const configured = () => new Set(models().map((m) => m.id));
const employees = () => [EmployeeSchema.parse({ id: "builder", name: "开发", role: "实现模块并集成", model_id: "test:build", capabilities: ["coding"] }),
  EmployeeSchema.parse({ id: "tester", name: "验证", role: "独立检验", model_id: "test:verify", capabilities: ["coding", "research"] })];
const runWithTeam = (): ExecutionRun => ExecutionRunSchema.parse({ id: "team-run", prompt: "完成完整模块，保留兼容性", budget_usd: 10, status: "queued",
  plan: { summary: "module", nodes: [{ id: "parent", title: "实现模块", instructions: "build", capability: "coding", files: ["app.py"], employee_id: "builder",
    model_id: "test:build" }], employees: employees(), team_brief: "接口不变；通过独立验证才交付" } });
const request = (overrides: Record<string, unknown> = {}) => ({ request_id: "check-parser", reason: "需要独立研究", tasks: [{ key: "research", title: "检验解析逻辑",
  instructions: "check parser semantics", capability: "research", difficulty: "normal", employee_id: "tester", acceptance_criteria: "给出边界情况和证据",
  dependencies: [], ...overrides }] });

test("the team is decided before any tasks are planned", async () => {
  settings.employee_teams = true;
  const messages: string[] = [];
  const provider = {
    async converse(session: { model_id: string | null }, text: string) {
      messages.push(text);
      const payload = messages.length === 1 ? { team_brief: "保持公开接口并独立验收", employees: employees() }
        : { summary: "module", nodes: [{ key: "t1", title: "模块", employee_id: "builder", instructions: "实现模块", capability: "coding", acceptance_criteria: "自测通过" }] };
      return new ProviderResult(JSON.stringify(payload), 10, 10, session.model_id);
    },
    async complete(): Promise<ProviderResult> {
      throw new Error("not used");
    },
  };
  const plan = await autonomousPlan("实现模块", models(), configured(), provider, null, SupervisorSessionSchema.parse({}));
  assert.equal(messages.length, 2);
  assert.ok(messages[0].includes("TEAM_SETUP") && messages[0].includes("Do not split"));
  // Staffed by module and responsibility, not cut down to the fewest people.
  assert.ok(messages[0].includes("one employee for each module or area of responsibility") && !messages[0].includes("smallest"));
  assert.ok(messages[1].includes("builder") && messages[1].includes("tester"));
  assert.deepEqual(plan.employees.map((e) => e.model_id), ["test:build", "test:verify"]);
  assert.equal(plan.nodes[0].employee_id, "builder");
});

test("delegation is atomic, gives the work to another employee and waits for its delivery", async () => {
  const run = runWithTeam();
  const children = (await teamPlanning.delegate(run, run.plan.nodes[0], request(), models(), configured()));
  const [child] = children;
  assert.ok(child.employee_id === "tester" && child.model_id === "test:verify" && child.delegation_parent_id === "parent");
  assert.deepEqual(run.plan.nodes[0].dependencies, [child.id]);
  assert.deepEqual((await teamPlanning.delegate(run, run.plan.nodes[0], request(), models(), configured())), children);
  assert.equal(run.plan.nodes.length, 2);
});

test("an invalid delegation never changes part of the plan", async () => {
  for (const override of [{ employee_id: "missing" }, { employee_id: "builder" }, { dependencies: ["parent"] }, { files: ["../outside.txt"] }, { capability: "planning" }]) {
    const run = runWithTeam();
    const before = JSON.stringify(run);
    await assert.rejects(teamPlanning.delegate(run, run.plan.nodes[0], request(override), models(), configured()), PlanProblem, JSON.stringify(override));
    assert.equal(JSON.stringify(run), before);
  }
});

test("a missing recipient selects another capable employee", async () => {
  const run = runWithTeam();
  assert.equal((await teamPlanning.delegate(run, run.plan.nodes[0], request({ employee_id: null }), models(), configured()))[0].employee_id, "tester");
});

test("the same request id cannot be reused for other work", async () => {
  const run = runWithTeam();
  await teamPlanning.delegate(run, run.plan.nodes[0], request(), models(), configured());
  await assert.rejects(teamPlanning.delegate(run, run.plan.nodes[0], request({ instructions: "unrelated work" }), models(), configured()), /different delegation/);
  assert.equal(run.plan.nodes.length, 2);
});

test("the delegation depth is bounded", async () => {
  settings.team_max_delegation_depth = 1;
  const run = runWithTeam();
  const [child] = (await teamPlanning.delegate(run, run.plan.nodes[0], request(), models(), configured()));
  await assert.rejects(teamPlanning.delegate(run, child, request({ employee_id: "builder", capability: "coding", files: ["helper.py"] }), models(), configured()), /depth limit/);
});

test("replanning keeps an employee's assignment and its explicit model", async () => {
  const run = runWithTeam();
  (await changePlan(run, { add: [{ key: "new", title: "research", instructions: "investigate", employee_id: "tester", capability: "research", acceptance_criteria: "evidence" }] },
    models(), configured()));
  assert.ok(run.plan.nodes.at(-1)!.employee_id === "tester" && run.plan.nodes.at(-1)!.model_id === "test:verify");
});

// test_replan: test_leading's MODELS (test_turns' model: ranked by coding).
const coder = (id: string, coding: number, channel = "api") => ModelProfileSchema.parse({ id, provider: id.split(":")[0], display_name: id, channel,
  context_window: 1_000_000, input_per_million: 1, output_per_million: 1, execution_priority: channel === "cli" ? 0 : 100, scores: { coding, planning: 80, reliability: 90 } });
const MODELS = [coder("x:api", 90), coder("cli:claude", 96, "cli")];
const CONFIGURED = new Set(MODELS.map((m) => m.id));
const step = (id: string, status = "pending", deps: string[] = []) => TaskNodeSchema.parse({ id, title: id.toUpperCase(), instructions: "do", capability: "coding",
  model_id: "x:api", status, dependencies: deps });
const plan = (...nodes: ReturnType<typeof step>[]) => ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "running", budget_usd: 1, plan: { summary: "s", nodes } });

test("a missing prerequisite is added before a waiting step", async () => {
  const current = plan(step("a", "succeeded"), step("b", "pending", ["a"]));
  const changes = (await changePlan(current, { add: [{ key: "db", title: "建表", instructions: "建好表", dependencies: ["a"], difficulty: "easy" }],
    update: [{ id: "b", dependencies: ["a", "db"], instructions: "用新表" }] }, MODELS, CONFIGURED));
  const added = current.plan.nodes.at(-1)!;
  assert.deepEqual(changes, { added: ["建表"], removed: [], updated: ["B"] });
  assert.ok(added.model_id && added.difficulty === "easy");
  assert.deepEqual(added.dependencies, ["a"]);
  assert.deepEqual(current.plan.nodes[1].dependencies, ["a", added.id]);
  assert.equal(current.plan.nodes[1].instructions, "用新表");
});

test("finished work stays, and the plan stays acyclic", async () => {
  const current = plan(step("a", "succeeded"), step("b", "pending", ["a"]), step("c", "pending", ["b"]));
  await assert.rejects(changePlan(current, { remove: ["a"] }, MODELS, CONFIGURED), (e: Error) => e instanceof PlanError && e.message.includes("finished or running"));
  await assert.rejects(changePlan(current, { update: [{ id: "b", dependencies: ["c"] }] }, MODELS, CONFIGURED), /cycle/);
  await assert.rejects(changePlan(current, { add: [{ key: "x", instructions: "i", dependencies: ["zzz"] }] }, MODELS, CONFIGURED), /unknown or removed/);
  // Removing a step that has not run drops it from what depended on it.
  await changePlan(current, { remove: ["b"] }, MODELS, CONFIGURED);
  assert.deepEqual(current.plan.nodes.map((n) => n.id), ["a", "c"]);
  assert.deepEqual(current.plan.nodes[1].dependencies, []);
});

test("a changed check must run a script that is written or already there", async () => {
  settings.workspace_root = folder();
  const current = plan(step("a", "succeeded"), step("b", "pending", ["a"]));
  const change = { update: [{ id: "b", check: "python3 checks/run.py" }] };
  await assert.rejects(changePlan(current, change, MODELS, CONFIGURED), /checks\/run.py, which no step writes/);
  // An earlier step already left it in the task's folder.
  mkdirSync(join(folder(), folderId(current), "checks"), { recursive: true });
  writeFileSync(join(folder(), folderId(current), "checks", "run.py"), "print('ok')");
  await changePlan(current, change, MODELS, CONFIGURED);
  assert.equal(current.plan.nodes[1].check, "python3 checks/run.py");
});

test("what clashes", async () => {
  const css = new scopes.Scope(["style.css"]);
  const js = new scopes.Scope(["app.js"], ["style.css"]);
  assert.ok(!css.clashes(new scopes.Scope(["app.py"])));
  assert.ok(css.clashes(js)); // one changes what the other reads
  assert.ok(!new scopes.Scope([], ["a.py"]).clashes(new scopes.Scope([], ["a.py"]))); // two readers
  assert.ok(new scopes.Scope().clashes(new scopes.Scope(["x"]))); // no scope: the folder to itself
});

test("what steps alongside changed and what they read is known to each", async () => {
  const lock = new scopes.FolderLock();
  const writer = new scopes.Scope(["rtl/"], [], "写 RTL");
  const reader = new scopes.Scope(["tb/"], ["spec/in.txt"], "读规格");
  await lock.hold(reader, async () => {
    await lock.hold(writer, async () => {
      // Only the writer was there with the reader, and the reader does not write its input.
      assert.deepEqual(writer.intrusions(["rtl/a.sv", "spec/in.txt", "notes.md"]), [["spec/in.txt", "读规格"]]);
      writer.changed = ["rtl/a.sv", "notes.md"];
    });
    // What the writer changed beyond its declared files is not the reader's.
    assert.deepEqual(reader.own(["notes.md", "tb/tb.sv"]), ["tb/tb.sv"]);
  });
  const third = new scopes.Scope(["fw/"], [], "固件");
  third.alongside = [reader, writer];
  reader.alongside = [];
  // With another step there that could have changed it, nobody is blamed.
  assert.deepEqual(third.intrusions(["spec/in.txt"]), []);
});
