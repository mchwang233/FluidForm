// What models.ts's validators do to a record when it is read, and how values are read the way
// Pydantic reads them (lax.ts). Parity with the Python backend over whole databases:
// tools/parity-records.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeDatetime } from "../src/lax.js";
import {
  ArtifactContractSchema, CapabilityScoreSchema, EmployeeSchema, ExecutionRunSchema, folderId, NodeAttemptSchema,
  overall, partPath, routingReady, ModelProfileSchema, scoreFor, TaskNodeSchema, TaskPlanSchema, ToolCallSchema,
  utcnow, CapabilitySchema, EngineerJobSchema, LeadMessageSchema,
} from "../src/models.js";

const node = (extra: Record<string, unknown> = {}) =>
  TaskNodeSchema.parse({ id: "n", title: "t", instructions: "i", capability: "coding", ...extra });

test("records saved on the old zero-to-one scale are upgraded", () => {
  const scores = CapabilityScoreSchema.parse({ coding: 0.82, planning: 91.5 });
  assert.equal(scores.coding, 82);
  assert.equal(scores.planning, 91.5);
  assert.equal(node({ quality_threshold: 0.75 }).quality_threshold, 75);
});

test("a plan saved before difficulty existed takes it from its threshold", () => {
  assert.equal(node({ quality_threshold: 0.9 }).difficulty, "hard");
  assert.equal(node({ quality_threshold: 80 }).difficulty, "normal");
  assert.equal(node({ quality_threshold: 70 }).difficulty, "easy");
  assert.equal(node({ quality_threshold: 95, difficulty: "easy" }).difficulty, "easy");
  assert.equal(node().difficulty, "normal");
});

test("a tool call saved before status existed takes it from ok and running", () => {
  const status = (value: Record<string, unknown>) => ToolCallSchema.parse({ turn: 1, tool: "command", ...value }).status;
  assert.equal(status({ ok: true }), "succeeded");
  assert.equal(status({ ok: false }), "failed");
  assert.equal(status({ running: true }), "running");
  assert.equal(status({}), "unknown");
  assert.equal(status({ ok: true, status: "failed" }), "failed");
});

test("a saved attempt has ended even when its last event said running", () => {
  const attempt = NodeAttemptSchema.parse({ outcome: "error", tool_calls: [
    { turn: 1, tool: "command", running: true },
    { turn: 2, tool: "command", status: "running", diagnostic: "own words" },
    { turn: 3, tool: "command", ok: true },
  ] });
  const [first, second, third] = attempt.tool_calls;
  assert.deepEqual([first.status, first.running, first.ok], ["incomplete", false, null]);
  assert.match(first.diagnostic!, /No completion event/);
  assert.equal(second.diagnostic, "own words");
  assert.equal(third.status, "succeeded");
});

test("old records load: fields added since take their defaults", () => {
  assert.deepEqual(TaskPlanSchema.parse({ summary: "old", nodes: [] }).employees, []);
  const legacy = node({ contract_turns: 2 });
  assert.equal(legacy.contract_turns, 2);
  assert.equal(legacy.contract_tool_calls, 0);
  const run = ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "succeeded", budget_usd: 1,
    plan: { summary: "s", nodes: [] }, ignored_old_field: 1 });
  assert.ok(!("ignored_old_field" in run));
  assert.match(run.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{6})?Z$/);
});

test("contracts and team members are checked as in Python", () => {
  const contract = { inputs: [], outputs: [{ path: "a.v", kind: "file" }], acceptance_commands: ["make"], blocked_when: ["no license"],
    max_turns: 5, max_cost_usd: 1 };
  assert.ok(ArtifactContractSchema.safeParse(contract).success);
  assert.ok(!ArtifactContractSchema.safeParse({ ...contract, acceptance_commands: ["  "] }).success);
  assert.ok(!ArtifactContractSchema.safeParse({ ...contract, acceptance_commands: [] }).success);
  assert.ok(!ArtifactContractSchema.safeParse({ ...contract, max_turns: 2.5 }).success);
  assert.ok(!ArtifactContractSchema.safeParse({ ...contract, max_turns: "5" }).success); // strict int
  const employee = { id: "dev_1", name: "开发", role: "写代码", capabilities: ["coding"], model_id: "deepseek:flash" };
  assert.ok(EmployeeSchema.safeParse(employee).success);
  assert.ok(!EmployeeSchema.safeParse({ ...employee, id: "dev 1" }).success);
  assert.ok(!EmployeeSchema.safeParse({ ...employee, capabilities: [] }).success);
});

test("values are read leniently, as Pydantic does", () => {
  const model = ModelProfileSchema.parse({ id: "x", provider: "p", display_name: "X", enabled: "false",
    context_window: "128000", input_per_million: "0.5", release_date: "2026-05-01" });
  assert.equal(model.enabled, false);
  assert.equal(model.context_window, 128000);
  assert.equal(model.input_per_million, 0.5);
  assert.ok(!ModelProfileSchema.safeParse({ id: "x", provider: "p", display_name: "X", context_window: 0 }).success);
  assert.ok(!ModelProfileSchema.safeParse({ id: "x", provider: "p", display_name: "X", enabled: "maybe" }).success);
});

test("times are written back as Pydantic writes them", () => {
  assert.equal(normalizeDatetime("2026-11-20T01:23:34.647020+00:00"), "2026-11-20T01:23:34.647020Z");
  assert.equal(normalizeDatetime("2026-11-20T01:23:34.000000Z"), "2026-11-20T01:23:34Z");
  assert.equal(normalizeDatetime("2026-11-20 01:23:34.5"), "2026-11-20T01:23:34.500000");
  assert.equal(normalizeDatetime("2026-11-20T09:23:34+08:00"), "2026-11-20T09:23:34+08:00");
  assert.equal(normalizeDatetime(0), "1970-01-01T00:00:00Z");
  assert.match(utcnow(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{6})?Z$/);
});

test("what the models also say: scores, routing, plan parts, folders", () => {
  const scores = CapabilityScoreSchema.parse({ coding: 90 });
  assert.equal(scoreFor(scores, "coding"), 90);
  assert.equal(scoreFor(scores, "unknown"), 50);
  assert.equal(overall(scores), (90 + 50 * 6) / 7);
  const ready = { id: "x", provider: "p", display_name: "X", scores: {}, context_window: 1000, input_per_million: 1,
    output_per_million: 2 };
  assert.ok(routingReady(ModelProfileSchema.parse(ready)));
  assert.ok(!routingReady(ModelProfileSchema.parse({ ...ready, catalog_status: "retired" })));
  assert.ok(!routingReady(ModelProfileSchema.parse({ ...ready, available_via_api: false })));
  const plan = TaskPlanSchema.parse({ summary: "s", nodes: [], parts: [
    { id: "a", title: "A", goal: "g", status: "planned", estimated_cost_usd: 1 },
    { id: "b", title: "B", goal: "g", parent_id: "a", estimated_cost_usd: 2 },
    { id: "c", title: "C", goal: "g", status: "ready", estimated_cost_usd: 4 },
  ] });
  assert.deepEqual(partPath(plan, "b").map((part) => part.id), ["a", "b"]);
  const run = ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "draft", budget_usd: 1, plan: { summary: "s", nodes: [] } });
  assert.equal(folderId(run), "r");
  assert.equal(folderId({ ...run, folder_name: "f" }), "f");
  assert.equal(folderId({ ...run, folder_name: "f", workspace_id: "w" }), "w");
});

test("records saved before later features load with their defaults", () => {
  const stored = { id: "old", prompt: "p", status: "succeeded", budget_usd: 1, plan: { summary: "s", nodes: [] } };
  // before capabilities, chats, and files in messages existed
  const run = ExecutionRunSchema.parse(stored);
  assert.deepEqual([run.capability_proposals, run.kind], [[], "task"]);
  const old = CapabilitySchema.parse({ id: "x", name: "x", status: "active" });
  assert.deepEqual([old.source, old.entry, old.version], ["task", "", ""]);
  assert.deepEqual(EngineerJobSchema.parse({ request: "x", messages: [{ role: "user", text: "x" }] }).attachments, []);
  assert.deepEqual(LeadMessageSchema.parse({ role: "user", text: "x" }).attachments, []);
});
