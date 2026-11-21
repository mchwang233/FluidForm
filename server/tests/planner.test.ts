// planner.ts's single-call planner, its fallback and the plan's fields: its tests in test_core,
// test_projects, test_packages, test_supervisor, test_quality, test_images, test_preflight, test_folders,
// test_attachments, test_cli_quota, test_acceptance_off and test_recovery_regressions, ported.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { builtinModels } from "../src/catalog.js";
import { settings } from "../src/config.js";
import { ContractError } from "../src/contracts.js";
import { Database } from "../src/db.js";
import { CapabilityScoreSchema, ExecutionRunSchema, ModelProfileSchema, SupervisorSessionSchema, TaskNodeSchema, TaskPlanSchema } from "../src/models.js";
import { autonomousPlan, heuristicPlan, NO_ACCEPTANCE_NOTE, scopeProblems, taskNode, validatePlan } from "../src/planner.js";
import { ProviderResult } from "../src/providers.js";
import { QuotaTracker } from "../src/quota.js";
import { eligibleForNode, NoEligibleModelError, routeNode } from "../src/routing.js";
import * as pricing from "../src/pricing.js";
import * as supervisor from "../src/supervisor.js";
import { planTasks } from "../src/task-planning.js";
import { form } from "../src/team-planning.js";
import { conftest, scoredModels } from "./helpers/conftest.js";

const { folder } = conftest();
const noLead = { converse: undefined as never };
const completing = (complete: (modelId: string, prompt: string) => Promise<ProviderResult>) => ({ ...noLead, complete }) as any;

test("the fallback planner builds a valid dependency graph", async () => {
  const plan = heuristicPlan("Research the options and implement the code");
  const seen = new Set<string>();
  for (const node of plan.nodes) {
    assert.ok(node.dependencies.every((id) => seen.has(id)));
    seen.add(node.id);
  }
  assert.equal(plan.nodes.at(-1)!.capability, "structured_output");
});

test("the router chooses the cheapest eligible API model", async () => {
  const models = scoredModels();
  const node = heuristicPlan("Analyze this task").nodes[0];
  const configured = new Set(models.filter((m) => m.provider !== "mock").map((m) => m.id));
  await routeNode(node, models, configured);
  const api = models.filter((m) => m.channel !== "cli" && configured.has(m.id));
  const cheapest = api.reduce((best, m) => (m.input_per_million! * 1500 + m.output_per_million! * 800 < best.input_per_million! * 1500 + best.output_per_million! * 800 ? m : best));
  assert.equal(node.model_id, cheapest.id);
  assert.ok(node.routing_note!.startsWith("子任务优先用 API 模型"));
});

test("steps use a CLI only when no API model qualifies", async () => {
  const models = scoredModels();
  const luna = models.find((m) => m.id === "openai:gpt-5.6-luna")!;
  const node = heuristicPlan("Implement this feature").nodes[0];
  await routeNode(node, models, new Set(["cli:claude", luna.id]));
  assert.equal(node.model_id, luna.id);
  luna.scores = { ...luna.scores!, [node.capability]: node.quality_threshold - 5 };
  await routeNode(node, models, new Set(["cli:claude", luna.id]));
  assert.equal(node.model_id, "cli:claude");
  assert.ok(node.routing_note!.includes("API 模型最高只有") && node.routing_note!.includes("改用会员 CLI"));
  // With the policy off, the free membership CLI comes first again.
  settings.subtasks_prefer_api = false;
  luna.scores = { ...luna.scores!, [node.capability]: 95 };
  await routeNode(node, models, new Set(["cli:claude", luna.id]));
  assert.equal(node.model_id, "cli:claude");
});

test("the router can leave out every CLI, and never picks a disabled model", async () => {
  let models = scoredModels();
  let node = heuristicPlan("Implement this feature").nodes[0];
  await routeNode(node, models, new Set(["openai:gpt-5.6-luna", "mock:local"]));
  assert.equal(node.model_id, "openai:gpt-5.6-luna");
  models = scoredModels();
  models.find((m) => m.id === "cli:codex")!.enabled = false;
  node = heuristicPlan("Implement this feature").nodes[0];
  await routeNode(node, models, new Set(["cli:codex", "cli:claude"]));
  assert.equal(node.model_id, "cli:claude");
});

test("the estimate includes reserves", async () => {
  const nodes = heuristicPlan("Analyze this task").nodes;
  for (const node of nodes) node.estimated_cost_usd = 0.01;
  const quote = await pricing.estimate(nodes, 2);
  assert.ok(quote.high_usd > quote.base_usd);
  assert.equal(quote.hard_limit_usd, 2);
});

test("the single-call planner builds the model's graph", async () => {
  const text = '{"summary":"Build it","nodes":[{"key":"n1","title":"Inspect","instructions":"Inspect inputs","capability":"planning","dependencies":[],'
    + '"estimated_input_tokens":900,"estimated_output_tokens":400,"quality_threshold":0.7},{"key":"n2","title":"Implement","instructions":"Implement and test",'
    + '"capability":"coding","dependencies":["n1"],"estimated_input_tokens":2400,"estimated_output_tokens":1600,"quality_threshold":0.8}]}';
  const plan = await autonomousPlan("Build it", scoredModels(), new Set(["openai:gpt-5.6-sol"]),
    completing(async () => new ProviderResult(text, 100, 100, "openai:gpt-5.6-sol")));
  assert.ok(plan.planning_method === "model" && plan.planner_model_id === "openai:gpt-5.6-sol");
  assert.deepEqual(plan.nodes[1].dependencies, [plan.nodes[0].id]);
  assert.ok(plan.planning_cost_usd > 0);
});

test("a run with a fallback plan round-trips through the database", async () => {
  const db = new Database(join(folder(), "test.db"));
  db.saveRun(ExecutionRunSchema.parse({ id: "run-1", prompt: "Analyze this task", status: "awaiting_confirmation", plan: heuristicPlan("Analyze this task"), budget_usd: 1 }));
  assert.equal(db.getRun("run-1")!.prompt, "Analyze this task");
  assert.equal(db.listRuns()[0].id, "run-1");
});

test("a planner's difficulty sets the threshold, and old plans derive it", async () => {
  const plan = validatePlan({ nodes: [{ key: "a", instructions: "x", difficulty: "hard" }, { key: "b", instructions: "y", dependencies: ["a"], difficulty: "Easy" },
    { key: "c", instructions: "z", quality_threshold: 0.8 }] });
  assert.deepEqual(plan.nodes.map((n) => [n.difficulty, n.quality_threshold]), [["hard", 90], ["easy", 70], ["normal", 80]]);
  const saved = TaskNodeSchema.parse({ id: "n", title: "t", instructions: "i", capability: "coding", quality_threshold: 0.92 });
  assert.deepEqual([saved.difficulty, saved.quality_threshold], ["hard", 92]);
});

test("project steps need a model that can act", async () => {
  const node = heuristicPlan("Implement this feature", true).nodes[0];
  assert.ok(node.needs_workspace);
  const models = scoredModels();
  // API models act through tools, so they take project work before a CLI does; the demo model never acts.
  await routeNode(node, models, new Set(["cli:qwen", "openai:gpt-5.6-sol", "mock:local"]));
  assert.equal(node.model_id, "openai:gpt-5.6-sol");
  await routeNode(node, models, new Set(["cli:qwen", "mock:local"]));
  assert.equal(node.model_id, "cli:qwen");
  models.find((m) => m.id === "openai:gpt-5.6-sol")!.supports_tools = false;
  await assert.rejects(routeNode(node, models, new Set(["openai:gpt-5.6-sol", "mock:local"])), (e: Error) => e instanceof NoEligibleModelError
    && e.message.includes("membership CLI or an API model"));
  // With API tools turned off, only CLIs can work in the project.
  settings.api_agent = false;
  models.find((m) => m.id === "openai:gpt-5.6-sol")!.supports_tools = null;
  await assert.rejects(routeNode(node, models, new Set(["openai:gpt-5.6-sol", "mock:local"])), NoEligibleModelError);
});

test("the planner reads needs_workspace only as true", async () => {
  const plan = validatePlan({ nodes: [{ key: "a", instructions: "edit", needs_workspace: true }, { key: "b", instructions: "sum up", dependencies: ["a"], needs_workspace: "yes" }] });
  assert.deepEqual(plan.nodes.map((n) => n.needs_workspace), [true, false]);
});

test("the planner marks project steps only for project runs", async () => {
  const none = completing(async () => assert.fail("mock planner should not be called"));
  const scratch = await autonomousPlan("Implement a fix", builtinModels(), new Set(["mock:local"]), none);
  const project = await autonomousPlan("Implement a fix", builtinModels(), new Set(["mock:local"]), none, "Target project: /x");
  assert.ok(!scratch.nodes.some((n) => n.needs_workspace));
  assert.ok(project.nodes.some((n) => n.needs_workspace));
});

test("what makes a package too broad", async () => {
  const step = (fields: Record<string, unknown> = {}) => TaskNodeSchema.parse({ id: "n", title: "T", instructions: "i", capability: "coding", needs_workspace: true, ...fields });
  const plan = (...nodes: ReturnType<typeof step>[]) => TaskPlanSchema.parse({ summary: "s", nodes });
  assert.deepEqual(scopeProblems(plan(step({ files: ["a.py"], reads: ["b.py"] }))), []);
  const [missing] = scopeProblems(plan(step()));
  const [many] = scopeProblems(plan(step({ files: Array.from({ length: 6 }, (_, i) => `${i}.py`) })));
  assert.ok(missing.includes("lists no files") && many.includes("changes 6 files"));
  // A new task's code needs a scope too; verifications and steps that write nothing do not.
  assert.ok(scopeProblems(plan(step({ needs_workspace: false })))[0].includes("lists no files"));
  assert.deepEqual(scopeProblems(plan(step({ verifies: ["x"] }), step({ needs_workspace: false, capability: "research" }))), []);
});

test("explicit coverage collection and report require artifact contracts", async () => {
  assert.throws(() => validatePlan({ nodes: [{ key: "vdb", title: "VDB 采集", instructions: "Run simulation", files: ["sim.vdb"] },
    { key: "report", title: "URG 文本报告", instructions: "Generate report", dependencies: ["vdb"] }] }), /artifact_contract/);
});

test("artifact work without a planner gets no unbounded fallback plan", async () => {
  await assert.rejects(autonomousPlan("Generate URG text report", [], new Set(), {} as any), (e: Error) => e instanceof ContractError && e.message.includes("Artifact planning blocked"));
});

// test_supervisor's leads.
const planner = (id: string, planning: number, channel = "api") => ModelProfileSchema.parse({ id, provider: id.split(":")[0], display_name: id, channel,
  context_window: 1_000_000, input_per_million: 1, output_per_million: 1, execution_priority: channel === "cli" ? 0 : 100, scores: { coding: 90, planning, reliability: 90 } });
const LEAD_MODELS = [planner("x:api", 99), planner("cli:claude", 90, "cli"), planner("cli:codex", 92, "cli"), planner("cli:gemini", 99, "cli"), planner("mock:local", 100)];
const LEAD_CONFIGURED = new Set(LEAD_MODELS.map((m) => m.id));
const PLAN = JSON.stringify({ summary: "待办网页", nodes: [{ key: "a", title: "页面", instructions: "写页面", capability: "coding", difficulty: "normal", files: ["index.html"] },
  { key: "b", title: "检查", instructions: "检查页面", capability: "coding", difficulty: "easy", dependencies: ["a"], files: ["test_index.py"], reads: ["index.html"] }] });

/** Each model keeps conversations by id; ``fail`` maps a model to the error it throws. */
function leads(replies: string[] = [], fail: Record<string, Error> = {}) {
  const messages: [string | null, string | null, string][] = [];
  return { messages, configuredModels: (ids: Iterable<string>) => new Set(ids),
    async converse(session: any, prompt: string) {
      messages.push([session.model_id, session.session_id, prompt]);
      const error = fail[session.model_id];
      if (error) {
        delete fail[session.model_id];
        throw error;
      }
      session.session_id = session.session_id || `${session.model_id}-conversation`;
      session.calls += 1;
      return new ProviderResult(replies.length ? replies.shift()! : "好的", 0, 0, session.model_id);
    },
    async complete(modelId: string) {
      return new ProviderResult(PLAN, 0, 0, modelId);
    } };
}

test("the lead plans in the conversation it keeps", async () => {
  const session = SupervisorSessionSchema.parse({});
  // The lead's task list says how each task is accepted (task-planning.ts).
  const tasks = JSON.parse(PLAN);
  for (const node of tasks.nodes) node.acceptance_criteria = "页面能用";
  const lead = leads(["我先想想……", JSON.stringify(tasks)]);
  const plan = await autonomousPlan("写一个待办网页", LEAD_MODELS, LEAD_CONFIGURED, lead, null, session);
  assert.deepEqual(plan.nodes.map((n) => n.title), ["页面", "检查"]);
  assert.ok(plan.planner_model_id === "cli:codex" && !plan.parts.length && plan.request!.startsWith("写一个待办网页"));
  assert.deepEqual([session.model_id, session.session_id], ["cli:codex", "cli:codex-conversation"]);
  // It was told it leads the task, and asked again in the same conversation for a valid plan.
  const [[, firstId, first], [, secondId, second]] = lead.messages;
  assert.ok(first.startsWith(supervisor.ROLE) && first.includes("写一个待办网页") && first.includes("DIRECT_TASK_PLAN"));
  assert.ok(firstId === null && secondId === "cli:codex-conversation" && second.includes("not a valid plan"));
});

test("without a lead, the usual planner plans", async () => {
  const session = SupervisorSessionSchema.parse({});
  const quota = new QuotaTracker();
  const out = (id: string) => quota.mark(id, "额度用完");
  const lead = leads([], { "cli:codex": out("cli:codex"), "cli:claude": out("cli:claude"), "x:api": out("x:api") });
  const plan = await autonomousPlan("写一个待办网页", LEAD_MODELS, LEAD_CONFIGURED, lead, null, session);
  assert.ok(plan.nodes.length && session.model_id === null);
});

test("a planner keeps acceptance criteria and verifies only its dependencies", async () => {
  const plan = validatePlan({ nodes: [{ key: "a", instructions: "x", acceptance_criteria: "tests pass" }, { key: "b", instructions: "y" },
    { key: "c", instructions: "z", dependencies: ["a"], verifies: ["a", "b", "zzz"] }] });
  const [a, , c] = plan.nodes;
  assert.equal(a.acceptance_criteria, "tests pass");
  assert.deepEqual(c.verifies, [a.id]);
});

test("the plan says which steps make pictures", async () => {
  const raw = { title: "头像", instructions: "画一张", capability: "coding", needs_images: true };
  assert.equal(taskNode(raw, "t1", [], []).needs_images, true);
  assert.equal(taskNode({ ...raw, needs_images: "yes" }, "t1", [], []).needs_images, false);
  // Old plans load.
  assert.equal(TaskNodeSchema.parse({ id: "n", title: "t", instructions: "i", capability: "coding" }).needs_images, false);
});

const oneStep = (extra: Record<string, unknown>) => async () => JSON.stringify({ summary: "FIFO", ...extra, nodes: [{ key: "t1", title: "RTL", instructions: "写 FIFO 的 RTL",
  capability: "coding", acceptance_criteria: "仿真通过", files: ["rtl/fifo.v"] }] });

test("the plan names the commands that check the tools, and the task's folder", async () => {
  const multiLine = "python3 -c 'import sys\nprint(sys.version)\n' && echo " + "y".repeat(400);
  const plan = await planTasks(oneStep({ requires: ["make --version", "make --version", multiLine] }), "");
  assert.ok(plan.requires[0] === "make --version" && plan.requires.length === 2);
  assert.ok(plan.requires[1].startsWith("python3 -c 'import sys") && plan.requires[1].endsWith("y".repeat(400)));
  assert.equal((await planTasks(oneStep({ folder: "async-fifo-uvm" }), "")).folder, "async-fifo-uvm");
});

test("images go only to models that can see them", async () => {
  const scores = Object.fromEntries(Object.keys(CapabilityScoreSchema.parse({})).map((key) => [key, 90]));
  const api = (id: string, vision: boolean | null) => ModelProfileSchema.parse({ id, provider: "x", display_name: id, context_window: 200_000, input_per_million: 1,
    output_per_million: 1, supports_vision: vision, scores });
  const models = [api("blind", false), api("seeing", true), api("unknown", null)];
  const node = heuristicPlan("Describe it").nodes[0];
  const configured = new Set(models.map((m) => m.id));
  assert.deepEqual(new Set(eligibleForNode(node, models, configured).map((m) => m.id)), configured);
  assert.deepEqual(new Set(eligibleForNode(node, models, configured, true).map((m) => m.id)), new Set(["seeing", "unknown"]));
});

test("the lead sees a CLI's quota when choosing the team", async () => {
  const scores = Object.fromEntries(Object.keys(CapabilityScoreSchema.parse({})).map((key) => [key, 95]));
  const models = ["first", "second"].map((name) => ModelProfileSchema.parse({ id: `test:${name}`, provider: "test", display_name: name, scores,
    scores_source: "artificial_analysis", context_window: 100000, input_per_million: 1, output_per_million: 1 }));
  const codex = { ...builtinModels().find((m) => m.id === "cli:codex")!, usage_note: "周额度已用 75%；额度紧张，优先给其他模型", scores: models[0].scores };
  const asked: string[] = [];
  await form(async (text) => {
    asked.push(text);
    return JSON.stringify({ team_brief: "保持接口并独立验收", employees: [{ id: "builder", name: "开发", role: "实现模块", model_id: "test:first", capabilities: ["coding"] }] });
  }, "实现模块", [...models, codex], new Set([...models.map((m) => m.id), codex.id]));
  assert.ok(asked[0].includes('"membership_usage": "周额度已用 75%；额度紧张，优先给其他模型"'));
  assert.ok(asked[0].includes("when its quota is tight give the work to other suitable models"));
});

test("without acceptance, the plan is asked for without verification steps", async () => {
  Object.assign(settings, { acceptance: false, review_nodes: true });
  const scores = Object.fromEntries(Object.keys(CapabilityScoreSchema.parse({})).map((key) => [key, 95]));
  const lead = ModelProfileSchema.parse({ id: "test:lead", provider: "test", display_name: "lead", context_window: 100000, scores, scores_source: "artificial_analysis",
    input_per_million: 1, output_per_million: 1 });
  const asked: string[] = [];
  await autonomousPlan("实现模块", [lead], new Set([lead.id]), { async converse(session: any, text: string) {
    asked.push(text);
    return new ProviderResult(JSON.stringify({ summary: "s", nodes: [{ key: "a", title: "A", instructions: "do", capability: "coding", acceptance_criteria: "ok", dependencies: [] }] }),
      1, 1, session.model_id);
  } } as any, null, SupervisorSessionSchema.parse({}));
  assert.ok(asked.at(-1)!.includes(NO_ACCEPTANCE_NOTE.trim()));
});

test("the planner uses a backup when its service is down", async () => {
  const quota = new QuotaTracker();
  const calls: string[] = [];
  const model = (id: string, score: number) => ModelProfileSchema.parse({ id, provider: id.split(":")[0], display_name: id, context_window: 1_000_000,
    input_per_million: 1, output_per_million: 1, scores: { planning: score, coding: score, reliability: score } });
  const models = [model("deepseek:primary", 95), model("deepseek:backup", 90)];
  const plan = await autonomousPlan("review project", models, new Set(models.map((m) => m.id)), completing(async (id) => {
    calls.push(id);
    if (id === "deepseek:primary") throw quota.mark(id, "deepseek returned 503: unavailable", "unavailable");
    return new ProviderResult(JSON.stringify({ summary: "backup plan", nodes: [{ key: "a", instructions: "first" }, { key: "b", instructions: "second", dependencies: ["a"] }] }), 0, 0, id);
  }));
  assert.ok(plan.planning_method === "model" && plan.planner_model_id === "deepseek:backup");
  assert.deepEqual(calls, ["deepseek:primary", "deepseek:backup"]);
});
