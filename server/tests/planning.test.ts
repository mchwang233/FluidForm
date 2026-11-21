// planner.ts, task-planning.ts, lead-planning.ts and team.form: tests/test_direct_planning.py and
// tests/test_planning_latency.py, ported.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { settings } from "../src/config.js";
import { ContractError, unwrittenScripts } from "../src/contracts.js";
import { CapabilityScoreSchema, ModelProfileSchema, type SupervisorSession, SupervisorSessionSchema, TaskPlanSchema } from "../src/models.js";
import { autonomousPlan, planChoices } from "../src/planner.js";
import { ProviderResult } from "../src/providers.js";
import { PROMPT } from "../src/task-planning.js";
import { Cancelled } from "../src/tasks.js";
import { conftest } from "./helpers/conftest.js";

conftest();
const SCORES = Object.fromEntries(Object.keys(CapabilityScoreSchema.parse({})).map((key) => [key, 95]));
const MODELS = ["first", "second"].map((name) => ModelProfileSchema.parse({ id: `test:${name}`, provider: "test", display_name: name, scores: SCORES,
  scores_source: "artificial_analysis", context_window: 100000, input_per_million: 1, output_per_million: 1 }));
const CONFIGURED = new Set(MODELS.map((m) => m.id));
const ROSTER = { team_brief: "保持接口并独立验收", employees: [{ id: "builder", name: "开发", role: "实现模块", model_id: "test:first", capabilities: ["coding"] }] };
const clone = <T>(value: T): T => structuredClone(value);
type Call = [string | null, boolean | string, string | null, Record<string, unknown>];

/** test_planning_latency's lead: the team, then its one task. */
class Lead {
  calls: Call[] = [];
  sessions: SupervisorSession[] = [];
  payload: unknown = { summary: "模块", nodes: [{ key: "t1", title: "实现模块", instructions: "实现模块并自测", capability: "coding", employee_id: "builder", acceptance_criteria: "自测通过" }] };
  messages: string[] = [];

  async converse(session: SupervisorSession, text: string, options: Record<string, unknown> = {}): Promise<ProviderResult> {
    const { signal: _, ...kwargs } = options;
    this.calls.push([session.model_id, text.includes("TEAM_SETUP"), session.reasoning_effort, kwargs]);
    this.sessions.push(session);
    this.messages.push(text);
    return new ProviderResult(JSON.stringify(text.includes("TEAM_SETUP") ? ROSTER : this.payload), 10, 10, session.model_id);
  }

  async complete(): Promise<ProviderResult> {
    throw new Error("no single-call planner here");
  }
}

const TASKS = { summary: "交付模块", title: "小模块交付。", folder: "small-module", requires: ["python --version"], nodes: [
  { key: "build", title: "实现模块", instructions: "完成模块和本任务自测", capability: "coding", employee_id: "builder", acceptance_criteria: "功能通过自测", provides: "public interface" },
  { key: "check", title: "验收模块", instructions: "根据依赖产物进行验收", capability: "coding", employee_id: "builder", dependencies: ["build"], verifies: ["build"],
    acceptance_criteria: "列出验收证据" }] };
const CHAIN = { summary: "交付 Mesh", nodes: [
  { key: "rtl", title: "实现 RTL", instructions: "实现全部 RTL", capability: "coding", difficulty: "hard", employee_id: "builder", acceptance_criteria: "编译通过" },
  { key: "verify", title: "验证并闭合覆盖率", instructions: "搭建环境、回归、闭合", capability: "coding", difficulty: "hard", employee_id: "builder", dependencies: ["rtl"],
    acceptance_criteria: "覆盖率 100%" },
  { key: "report", title: "生成报告", instructions: "生成报告", capability: "coding", employee_id: "builder", dependencies: ["verify"], acceptance_criteria: "报告完整" }] };
const OVERLAPPED = { ...CHAIN, nodes: [CHAIN.nodes[0], { ...CHAIN.nodes[1], key: "env", title: "按接口契约搭建验证环境", dependencies: [] },
  { ...CHAIN.nodes[1], key: "close", title: "回归并闭合覆盖率", dependencies: ["rtl", "env"] }, { ...CHAIN.nodes[2], dependencies: ["close"] }] };

/** test_direct_planning's planner: the team, then ``payload`` (or each of ``replies`` in turn). */
function planner(payload: unknown = TASKS, ...replies: unknown[]): Lead {
  const lead = new Lead();
  lead.payload = clone(payload);
  if (replies.length) {
    const queue = replies.map(clone);
    const converse = lead.converse.bind(lead);
    lead.converse = async (session, text, options) => {
      if (!text.includes("TEAM_SETUP")) lead.payload = queue.shift();
      return converse(session, text, options);
    };
  }
  return lead;
}
const planned = (provider: Lead = planner(), prompt = "实现模块") => {
  settings.employee_teams = true; // test_direct_planning's direct_policy
  return autonomousPlan(prompt, MODELS, CONFIGURED, provider, null, SupervisorSessionSchema.parse({}));
};

test("the team, then tasks with their dependencies, without refinement", async () => {
  const provider = planner();
  const plan = await planned(provider);
  assert.equal(provider.messages.length, 2);
  assert.ok(provider.messages[1].includes("DIRECT_TASK_PLAN") && !provider.messages[1].includes("10-15 tool turns"));
  assert.ok(!plan.parts.length && plan.nodes.length === 2);
  assert.deepEqual(plan.nodes[1].dependencies, [plan.nodes[0].id]);
  assert.deepEqual(plan.nodes[1].verifies, [plan.nodes[0].id]);
  assert.ok(plan.nodes.every((n) => n.employee_id === "builder"));
  assert.deepEqual(plan.requires, ["python --version"]);
  assert.equal(plan.folder, "small-module");
  assert.ok(plan.title === "小模块交付" && provider.messages[1].includes('"title"'));
  assert.ok(plan.planning_note!.includes("按依赖直接执行"));
  assert.deepEqual(TaskPlanSchema.parse(JSON.parse(JSON.stringify(plan))), plan);
});

test("one complete task is enough, without forced splitting", async () => {
  const plan = await planned(planner({ ...TASKS, nodes: TASKS.nodes.slice(0, 1) }));
  assert.ok(plan.nodes.length === 1 && !plan.parts.length);
});

test("verifying transitive dependencies needs no correction from the model", async () => {
  const payload = { ...TASKS, nodes: [TASKS.nodes[0], { ...TASKS.nodes[0], key: "report", dependencies: ["build"] },
    { ...TASKS.nodes[1], dependencies: ["report"], verifies: ["build", "report"] }] };
  const provider = planner(payload);
  const plan = await planned(provider);
  assert.equal(provider.messages.length, 2); // team and tasks, no regeneration of a valid graph
  const [first, second, audit] = plan.nodes;
  assert.deepEqual(new Set(audit.dependencies), new Set([first.id, second.id]));
  assert.deepEqual(new Set(audit.verifies), new Set([first.id, second.id]));
  assert.deepEqual(payload.nodes.at(-1)!.dependencies, ["report"]); // raw input is not rewritten
});

test("a verification cannot add unknown or unrelated work", async () => {
  for (const verified of ["missing", "independent"]) {
    const payload = { ...TASKS, nodes: [{ ...TASKS.nodes[0], key: "independent" }, TASKS.nodes[0], { ...TASKS.nodes[1], verifies: [verified] }] };
    await assert.rejects(planned(planner(payload)), ContractError);
  }
});

test("an invalid task graph or assignment is not executed", async () => {
  for (const change of [{ dependencies: ["missing"] }, { employee_id: "missing" }, { dependencies: ["build"] }, { acceptance_criteria: "" }]) {
    await assert.rejects(planned(planner({ ...TASKS, nodes: [{ ...TASKS.nodes[0], ...change }] })), ContractError, JSON.stringify(change));
  }
});

test("open scope choices are kept for the user, and independent deliverables run alongside", () => {
  const choices = planChoices({ choices: [{ question: "AXI4 还是 AXI4-Lite？", assumed: "完整 AXI4", alternative: "AXI4-Lite" }, { question: "", assumed: "x" }, "bad",
    ...Array.from({ length: 9 }, (_, i) => ({ question: `q${i}`, assumed: "a" }))] });
  assert.ok(choices[0].assumed === "完整 AXI4" && choices[0].alternative === "AXI4-Lite" && choices.length === 5);
  assert.ok(PROMPT.includes("own line of") && PROMPT.includes('"choices"'));
});

test("employees are named by their job", () => {
  assert.ok(readFileSync(new URL("../src/team-planning.ts", import.meta.url), "utf8").includes("never a person's name"));
});

test("a single line of hard tasks is sent back once, to run work side by side", async () => {
  assert.ok(PROMPT.includes("Plan for concurrency") && PROMPT.includes("serial_reason"));
  const provider = planner(TASKS, CHAIN, OVERLAPPED);
  const plan = await planned(provider);
  assert.equal(provider.messages.length, 3); // team, tasks, one correction
  assert.ok(provider.messages[2].includes("no two run at the same time"));
  assert.deepEqual(plan.nodes.map((n) => n.title).slice(0, 2), ["实现 RTL", "按接口契约搭建验证环境"]);
  assert.ok(plan.planning_note!.includes("最多 2 个任务可同时进行"));
});

test("a plan that truly cannot overlap says why, and is never lost", async () => {
  let provider = planner(TASKS, { ...CHAIN, serial_reason: "每一步都需要上一步的真实结果" });
  let plan = await planned(provider);
  assert.ok(provider.messages.length === 2 && plan.nodes.length === 3);
  assert.ok(plan.planning_note!.includes("任务依次进行（每一步都需要上一步的真实结果）"));
  provider = planner(TASKS, CHAIN, CHAIN); // asked once; the same answer again is kept
  plan = await planned(provider);
  assert.ok(provider.messages.length === 3 && plan.nodes.length === 3);
  assert.ok(plan.planning_note!.includes("任务依次进行"));
});

test("short or easy lines are not questioned", async () => {
  const easy = { ...CHAIN, nodes: CHAIN.nodes.map((n) => ({ ...n, difficulty: "normal" })) };
  for (const payload of [easy, { ...CHAIN, nodes: CHAIN.nodes.slice(0, 2) }]) {
    const provider = planner(TASKS, payload);
    await planned(provider);
    assert.equal(provider.messages.length, 2);
  }
});

test("tasks whose files are not known yet own folders, so they can run together", async () => {
  const nodes = [{ ...TASKS.nodes[0], key: "core", title: "核", folders: ["rtl/core", "./tests/core/", "../x", ".git"] },
    { ...TASKS.nodes[0], key: "periph", title: "外设", folders: ["rtl/periph/"] }];
  const provider = planner({ ...TASKS, nodes });
  const plan = await planned(provider);
  assert.ok(provider.messages[1].includes('"folders"'));
  assert.deepEqual(plan.nodes.map((n) => n.folders), [["rtl/core/", "tests/core/"], ["rtl/periph/"]]);
  assert.ok(plan.nodes.every((n) => !n.files.length));
});

test("a folder named as a file or read is kept as that folder", async () => {
  const plan = await planned(planner({ ...TASKS, nodes: [{ ...TASKS.nodes[0], files: ["fw/", "src/main.c"], reads: ["docs/"] }] }));
  assert.deepEqual([plan.nodes[0].files, plan.nodes[0].reads], [["fw", "src/main.c"], ["docs"]]);
});

test("the lead is told which paths are not allowed, and can correct them", async () => {
  const provider = planner(TASKS, { ...TASKS, nodes: [{ ...TASKS.nodes[0], reads: ["rtl/*.sv", "../secret"] }] }, { ...TASKS, nodes: [{ ...TASKS.nodes[0], reads: ["rtl/top.sv"] }] });
  const plan = await planned(provider);
  assert.ok(provider.messages[2].includes("rtl/*.sv, ../secret"));
  assert.deepEqual(plan.nodes[0].reads, ["rtl/top.sv"]);
});

test("a check that runs a script no step writes is sent back when planning", async () => {
  // The axi-to-apb task: a step's check ran verification/runs/check_collection.py, which no step was
  // allowed to write, so the step did its work for 21 minutes and then could not pass.
  const unwritten = { ...TASKS, nodes: [{ ...TASKS.nodes[0], files: ["runs/coverage.txt"], check: "python3 runs/check_collection.py && test -s runs/coverage.txt" }, TASKS.nodes[1]] };
  const fixed = { ...unwritten, nodes: [{ ...unwritten.nodes[0], files: ["runs/coverage.txt", "runs/check_collection.py"] }, TASKS.nodes[1]] };
  const provider = planner(TASKS, unwritten, fixed);
  const plan = await planned(provider);
  assert.ok(provider.messages[2].includes("runs/check_collection.py") && provider.messages[2].includes("no step writes"));
  assert.ok(plan.nodes[0].files.includes("runs/check_collection.py"));
  // A script a dependency writes, or one already in the project, is fine.
  const built = { ...plan.nodes[0], check: "" };
  const checked = { ...plan.nodes[1], check: "bash runs/check_collection.py -v" };
  assert.deepEqual(unwrittenScripts(TaskPlanSchema.parse({ summary: "s", nodes: [built, checked] })), []);
  assert.deepEqual(unwrittenScripts(TaskPlanSchema.parse({ summary: "s", nodes: [checked], in_project: true })), []);
  assert.ok(unwrittenScripts(TaskPlanSchema.parse({ summary: "s", nodes: [{ ...checked, dependencies: [] }] })).length);
});

// test_planning_latency
const stageSettings = () => Object.assign(settings, { employee_teams: true, team_reasoning_effort: "medium", planning_reasoning_effort: "high", planning_call_timeout: 1.0 });
const plan = (provider: Lead, session = SupervisorSessionSchema.parse({})) => autonomousPlan("实现模块", MODELS, CONFIGURED, provider, null, session);

test("planning uses each stage's effort without changing the later lead's", async () => {
  stageSettings();
  const provider = new Lead();
  const session = SupervisorSessionSchema.parse({});
  await plan(provider, session);
  assert.deepEqual(provider.calls.map(([, team, effort]) => [team, effort]), [[true, "medium"], [false, "high"]]);
  // The deadline grows with the effort: 1 s at medium, twice that at high.
  assert.deepEqual(provider.calls.map(([, , , kwargs]) => kwargs.timeout), [1.0, 2.0]);
  assert.equal(session.reasoning_effort, null);
  assert.ok(provider.sessions.every((s) => s.reasoning_effort === null));
});

test("a planning fallback reuses the validated team and keeps the cost so far", async () => {
  stageSettings();
  const provider = new Lead();
  const converse = provider.converse.bind(provider);
  provider.converse = async (session, text, options) => {
    const result = await converse(session, text, options);
    if (session.model_id === "test:first" && !text.includes("TEAM_SETUP")) throw new Error("planning unavailable");
    if (session.model_id === "test:second") assert.ok(text.includes("保持接口并独立验收") && text.includes("builder"));
    return result;
  };
  const made = await plan(provider);
  assert.deepEqual(provider.calls.map(([model, team]) => [model, team]), [["test:first", true], ["test:first", false], ["test:second", false]]);
  assert.equal(made.employees[0].model_id, "test:first");
  assert.equal(made.planner_model_id, "test:second");
  assert.ok(Math.abs(made.planning_cost_usd - 0.00004) < 1e-12);
  assert.ok(provider.sessions.every((s) => s.reasoning_effort === null));
});

test("the deadline cancels a slow provider before the next lead is used", async () => {
  stageSettings();
  settings.planning_call_timeout = 0.02;
  const cancelled: string[] = [];
  const provider = new Lead();
  const converse = provider.converse.bind(provider);
  provider.converse = async (session, text, options = {}) => {
    const result = await converse(session, text, options);
    if (session.model_id === "test:first" && !text.includes("TEAM_SETUP")) {
      // The provider ignores the timeout it is given, but hears the cancellation.
      const signal = options.signal as AbortSignal;
      await new Promise<void>((done, fail) => {
        const timer = setTimeout(done, 150);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          cancelled.push(session.model_id!);
          fail(signal.reason);
        }, { once: true });
      });
    }
    return result;
  };
  const made = await plan(provider);
  assert.deepEqual(cancelled, ["test:first"]);
  assert.equal(made.planner_model_id, "test:second");
  assert.equal(provider.calls.filter(([, team]) => team).length, 1);
  assert.ok(provider.sessions.every((s) => s.reasoning_effort === null));
});

test("a team that did not validate is formed again by another lead", async () => {
  stageSettings();
  const provider = new Lead();
  const converse = provider.converse.bind(provider);
  provider.converse = async (session, text, options) => {
    const result = await converse(session, text, options);
    if (session.model_id === "test:first") throw new Error("staffing unavailable");
    return result;
  };
  const made = await plan(provider);
  assert.deepEqual(provider.calls.map(([model, team]) => [model, team]), [["test:first", true], ["test:second", true], ["test:second", false]]);
  assert.ok(made.employees.length && made.planner_model_id === "test:second");
});

test("a cancellation starts no other planner", async () => {
  stageSettings();
  const provider = new Lead();
  const converse = provider.converse.bind(provider);
  provider.converse = async (session, text, options) => {
    await converse(session, text, options);
    throw new Cancelled();
  };
  await assert.rejects(plan(provider), Cancelled);
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.sessions[0].reasoning_effort, null);
});

test("an unset policy keeps the lead's defaults", async () => {
  Object.assign(settings, { employee_teams: true, team_reasoning_effort: "", planning_reasoning_effort: "", planning_call_timeout: 0 });
  const provider = new Lead();
  await plan(provider);
  assert.ok(provider.calls.every(([, , effort, kwargs]) => effort === null && Object.keys(kwargs).length === 0));
});

/** A lead that rates the request ``difficulty`` before it plans. */
function judged(difficulty: string): Lead {
  const provider = new Lead();
  const converse = provider.converse.bind(provider);
  provider.converse = async (session, text, options = {}) => {
    if (text.includes("rate how hard it is to PLAN")) {
      const { signal: _, ...kwargs } = options;
      provider.calls.push([session.model_id, "difficulty", session.reasoning_effort, kwargs]);
      provider.sessions.push(session);
      return new ProviderResult(JSON.stringify({ difficulty, reason: "接口简单" }), 1, 1, session.model_id);
    }
    return converse(session, text, options);
  };
  return provider;
}

test("auto plans at the effort the request's difficulty calls for", async () => {
  for (const [difficulty, effort] of [["easy", "low"], ["normal", "medium"], ["hard", "high"], ["exceptional", "max"], ["unreadable", "high"]]) {
    stageSettings();
    settings.planning_reasoning_effort = "auto";
    const provider = judged(difficulty);
    const made = await plan(provider);
    const [judge, team, tasks] = provider.calls;
    assert.deepEqual([judge.slice(1, 3), team.slice(1, 3), tasks[2]], [["difficulty", "medium"], [true, "medium"], effort]);
    // The judgement has a conversation of its own; the plan's conversation starts with the plan.
    assert.notEqual(provider.sessions[0], provider.sessions[2]);
    assert.ok(made.planning_note!.includes(`用 ${effort} 强度规划`), made.planning_note!);
  }
});

test("auto staffing thinks as hard as the plan", async () => {
  for (const [difficulty, effort] of [["easy", "low"], ["exceptional", "max"]]) {
    stageSettings();
    Object.assign(settings, { planning_reasoning_effort: "auto", team_reasoning_effort: "auto" });
    const provider = judged(difficulty);
    await plan(provider);
    const [, team, tasks] = provider.calls;
    assert.deepEqual([team.slice(1, 3), tasks[2]], [[true, effort], effort]);
  }
});
