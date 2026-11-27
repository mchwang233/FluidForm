// The API's tasks as the console reads them, attachments, and deleting a task (test_attachments.py,
// test_task_deletion.py, test_console_load.py).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import * as files from "../src/attachments.js";
import { builtinModels } from "../src/catalog.js";
import { withAttachments as claudeAttachments } from "../packages/claude-code/src/index.js";
import { withAttachments as codexAttachments } from "../packages/codex/src/index.js";
import { settings } from "../src/config.js";
import { Database } from "../src/db.js";
import {
  DecisionSchema, EngineerJobSchema, EventSchema, type ExecutionRun, ExecutionRunSchema, LeadMessageSchema, NodeAttemptSchema, SupervisorSessionSchema,
  TaskNodeSchema, TaskPlanSchema, ToolCallSchema,
} from "../src/models.js";
import { ModelProfileSchema } from "../src/models.js";
import { Task } from "../src/tasks.js";
import { Mutex } from "../src/tasks.js";
import { BEST, triaging, useModels } from "./helpers/chatting.js";
import { conftest } from "./helpers/conftest.js";
import { registryWith } from "./helpers/providers.js";
import { type Client, taskApi } from "./helpers/task-api.js";

const { folder } = conftest();

const ORIGIN = { origin: "http://localhost:5173" };
const PNG = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(32)]);

async function upload(client: Client, name: string, data: Buffer): Promise<Record<string, any>> {
  const response = await client.post("/api/attachments", { params: { name }, content: data, headers: ORIGIN });
  assert.equal(response.status_code, 201, response.text);
  return response.json();
}

test("uploads are typed by content and only images display inline", async () => {
  const { client } = taskApi(folder());
  const image = await upload(client, "../../shot.txt", PNG);
  const text = await upload(client, "notes.md", Buffer.from("# 需求\n登录页"));
  const svg = await upload(client, "logo.svg", Buffer.from("<svg onload='alert(1)'/>"));
  const binary = await upload(client, "a.bin", Buffer.from([0, 1, 2]));
  assert.deepEqual([image.kind, image.media_type, image.name], ["image", "image/png", "shot.txt"]);
  assert.deepEqual([text.kind, svg.kind, binary.kind], ["text", "text", "file"]);

  const shown = await client.get(`/api/attachments/${image.id}/content`);
  assert.ok(shown.headers["content-type"] === "image/png" && shown.content.equals(PNG));
  assert.ok(shown.headers["content-disposition"].startsWith("inline"));
  const script = await client.get(`/api/attachments/${svg.id}/content`);
  assert.equal(script.headers["content-type"], "application/octet-stream");
  assert.ok(script.headers["content-disposition"].startsWith("attachment"));
  assert.equal(script.headers["x-content-type-options"], "nosniff");
  assert.equal((await client.get("/api/attachments/../meta.json/content")).status_code, 404);

  assert.equal((await client.delete(`/api/attachments/${binary.id}`, { headers: ORIGIN })).status_code, 204);
  assert.equal(files.get(binary.id), null);
});

test("uploads are refused from other sites and when too large", async () => {
  const { client } = taskApi(folder());
  assert.equal((await client.post("/api/attachments", { content: PNG, headers: { origin: "https://evil.example" } })).status_code, 403);
  const big = await client.post("/api/attachments", { content: Buffer.alloc(files.MAX_ATTACHMENT_BYTES + 1), headers: ORIGIN });
  assert.deepEqual([big.status_code, big.json().detail], [413, "单个附件不能超过 20 MB。"]);
});

test("a task keeps its attachments and deleting it removes them", async () => {
  const { api, client } = taskApi(folder());
  const demo = builtinModels().find((model) => model.id === "mock:local")!;
  api.models = { [demo.id]: demo };
  api.providers.configuredModels = () => new Set([demo.id]);
  const image = await upload(client, "screen.png", PNG);

  const response = await client.post("/api/tasks", { json: { prompt: "Describe the screenshot", use_cli: false, attachments: [image.id] }, headers: ORIGIN });
  assert.equal(response.status_code, 201, response.text);
  const run = response.json();
  assert.deepEqual(run.attachments.map((item: any) => item.id), [image.id]);
  assert.equal((await client.delete(`/api/attachments/${image.id}`, { headers: ORIGIN })).status_code, 409);
  assert.equal((await client.post(`/api/tasks/${run.id}/cancel`, { headers: ORIGIN })).status_code, 200);
  assert.equal((await client.delete(`/api/tasks/${run.id}`, { headers: ORIGIN })).status_code, 204);
  assert.equal(files.get(image.id), null);

  const missing = await client.post("/api/tasks", { json: { prompt: "Describe it", attachments: ["0".repeat(32)] }, headers: ORIGIN });
  assert.equal(missing.status_code, 400);
});

test("API models get images as inputs and text inline", async () => {
  taskApi(folder());
  const image = files.save("screen.png", PNG);
  const note = files.save("spec.txt", Buffer.from("必须支持暗色模式"));
  const sent: Record<string, any> = {};
  process.env.OPENAI_API_KEY = "test";
  process.env.ANTHROPIC_API_KEY = "test";
  const registry = registryWith((request) => {
    sent[request.url.host] = request.body;
    if (request.url.host === "api.anthropic.com") return { content: [{ text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } };
    return { choices: [{ message: { content: "ok" } }], usage: {} };
  });
  await registry.complete("openai:gpt-x", "Review", { attachments: [image, note] });
  await registry.complete("anthropic:claude-x", "Review", { attachments: [image, note] });

  const openaiParts = sent["api.openai.com"].messages[0].content;
  assert.ok(openaiParts[1].image_url.url.startsWith("data:image/png;base64,"));
  assert.ok(openaiParts[0].text.includes("必须支持暗色模式") && openaiParts[0].text.includes("screen.png"));
  const anthropicParts = sent["api.anthropic.com"].messages[0].content;
  assert.equal(anthropicParts[0].source.media_type, "image/png");
  assert.ok(anthropicParts[1].text.includes("必须支持暗色模式"));
});

test("CLI agents are pointed at the attached files", () => {
  taskApi(folder());
  const image = files.save("screen.png", PNG);
  const note = files.save("spec.txt", Buffer.from("spec"));
  assert.deepEqual(codexAttachments(["exec", "--color", "never", "-"], [image, note]),
    ["exec", `--image=${files.path(image)}`, "--color", "never", "-"]);
  const claude = claudeAttachments(["-p"], [image, note]);
  assert.deepEqual(claude.slice(0, 2), ["-p", "--add-dir"]);
  assert.ok(claude.includes(dirname(files.path(note))));
  assert.ok(files.describe([image, note], true).includes(files.path(note)));
});

// ---- Deleting a task ----

function savedRun(db: Database, runId = "finished", status = "succeeded", projectDir: string | null = null): ExecutionRun {
  const run = ExecutionRunSchema.parse({ id: runId, prompt: "Implement a feature", status, plan: { summary: "Finished project", nodes: [] }, budget_usd: 1,
    project_dir: projectDir, final_result: "Completed output" });
  db.saveRun(run);
  db.addEvent(EventSchema.parse({ run_id: run.id, kind: "plan.created" }));
  db.addEvent(EventSchema.parse({ run_id: run.id, kind: `run.${status}` }));
  return run;
}

for (const status of ["succeeded", "failed", "cancelled"]) {
  test(`deleting finished history (${status}) keeps the files and the other records`, async () => {
    const { api, client } = taskApi(folder());
    const project = join(folder(), "project");
    mkdirSync(project);
    const projectFile = join(project, "main.py");
    writeFileSync(projectFile, "print('keep me')");
    const workspace = join(settings.workspace_root, "finished");
    mkdirSync(workspace, { recursive: true });
    const artifact = join(workspace, "result.txt");
    writeFileSync(artifact, "keep artifact");
    const run = savedRun(api.db, "finished", status, project);
    const other = savedRun(api.db, "other");
    const traces = Object.fromEntries([run.id, other.id].map((id) => [id, join(settings.data_dir, "traces", id)]));
    for (const trace of Object.values(traces)) {
      mkdirSync(trace, { recursive: true });
      writeFileSync(join(trace, "n-1.jsonl"), "{}\n");
    }

    const response = await client.delete(`/api/tasks/${run.id}`);

    assert.ok(response.status_code === 204 && response.content.length === 0);
    assert.equal((await client.get(`/api/tasks/${run.id}`)).status_code, 404);
    assert.equal((await client.get(`/api/tasks/${run.id}/events`)).status_code, 404);
    assert.deepEqual((await client.get("/api/tasks")).json().map((item: any) => item.id), [other.id]);
    assert.deepEqual(api.db.events(run.id), []);
    assert.equal(api.db.events(other.id).length, 2);
    assert.equal(readFileSync(projectFile, "utf8"), "print('keep me')");
    assert.equal(readFileSync(artifact, "utf8"), "keep artifact");
    // Its tool traces go with it; the other task keeps its own.
    assert.ok(!existsSync(traces[run.id]) && existsSync(join(traces[other.id], "n-1.jsonl")));
    const reopened = new Database(settings.dbPath);
    try {
      assert.equal(reopened.getRun(run.id), null);
      assert.deepEqual(reopened.events(run.id), []);
      assert.deepEqual(reopened.getRun(other.id), other);
    } finally {
      reopened.close();
    }
  });
}

for (const status of ["awaiting_confirmation", "queued", "running", "paused", "draft"]) {
  test(`deleting refuses an unfinished task (${status}) and changes nothing`, async () => {
    const { api, client } = taskApi(folder());
    const run = savedRun(api.db, "finished", status);
    const events = api.db.events(run.id);
    assert.equal((await client.delete(`/api/tasks/${run.id}`)).status_code, 409);
    assert.deepEqual(api.db.getRun(run.id), run);
    assert.deepEqual(api.db.events(run.id), events);
  });
}

test("deleting a missing or already deleted record is 404", async () => {
  const { api, client } = taskApi(folder());
  const other = savedRun(api.db, "other");
  assert.equal((await client.delete("/api/tasks/missing")).status_code, 404);
  assert.equal((await client.delete(`/api/tasks/${other.id}`)).status_code, 204);
  assert.equal((await client.delete(`/api/tasks/${other.id}`)).status_code, 404);
});

test("deleting waits for a cancel's cleanup and releases the executor's state", async () => {
  const { api, client } = taskApi(folder());
  const run = savedRun(api.db, "finished", "cancelled");
  let release!: () => void;
  const cleanup = new Promise<void>((done) => (release = done));
  const task = new Task(() => cleanup);
  api.executor.tasks.set(run.id, task as Task<void>);
  api.executor.locks.set(run.id, new Mutex());
  try {
    assert.equal((await client.delete(`/api/tasks/${run.id}`)).status_code, 409);
    assert.deepEqual(api.db.getRun(run.id), run);
    assert.equal(api.db.events(run.id).length, 2);
  } finally {
    release();
    await task.promise;
  }
  assert.equal((await client.delete(`/api/tasks/${run.id}`)).status_code, 204);
  assert.ok(!api.executor.tasks.has(run.id) && !api.executor.locks.has(run.id));
});

test("an event stream that is open ends once its task is deleted", async () => {
  const { api, client } = taskApi(folder());
  const run = savedRun(api.db);
  const stream = api.events(run.id);
  assert.ok(String((await stream.next()).value).includes("plan.created"));
  assert.equal((await client.delete(`/api/tasks/${run.id}`)).status_code, 204);
  // The stream may have already buffered the final event, then must finish without keepalives.
  const remaining: string[] = [];
  for await (const message of stream) remaining.push(message);
  assert.ok(remaining.every((message) => !message.includes("keepalive")));
});

// ---- What the console loads ----

function heavyRun(runId = "r"): ExecutionRun {
  const calls = Array.from({ length: 20 }, (_, turn) => ToolCallSchema.parse({ turn, tool: "command", detail: "make", output: "x".repeat(5000) }));
  const node = TaskNodeSchema.parse({ id: "a", title: "实现", instructions: "写代码", capability: "coding",
    changed_files: Array.from({ length: 2000 }, (_, i) => `src/file${i}.py`),
    attempts: [NodeAttemptSchema.parse({ model_id: "cli:codex", outcome: "passed", tool_calls: calls, result: "做完了" })] });
  node.result = "做完了";
  return ExecutionRunSchema.parse({ id: runId, prompt: "写个模块", status: "succeeded", budget_usd: 1, plan: TaskPlanSchema.parse({ summary: "s", nodes: [node] }),
    decisions: [DecisionSchema.parse({ event: "all_done", action: "done", reason: "好" })],
    lead_messages: [LeadMessageSchema.parse({ role: "user", text: "z".repeat(20000) })],
    supervisor: SupervisorSessionSchema.parse({ model_id: "cli:claude", history: [{ role: "user", content: "y".repeat(50000) }] }) });
}

test("the task list is brief and a task in full", async () => {
  const { api, client } = taskApi(folder());
  api.db.saveRun(heavyRun());
  const full = (await client.get("/api/tasks")).json()[0];
  const brief = await client.get("/api/tasks", { params: { brief: "true" } });
  const listed = brief.json()[0];
  assert.ok(brief.content.length < 5000);
  const step = listed.plan.nodes[0];
  assert.ok(step.changed_files.length === 0 && step.attempts[0].tool_calls.length === 0);
  assert.ok(step.attempts[0].result === null && step.attempts[0].outcome === "passed");
  assert.ok(listed.supervisor.model_id === "cli:claude" && listed.supervisor.history.length === 0);
  assert.ok(step.result === null && listed.decisions.length === 0 && listed.plan.employees.length === 0);
  assert.deepEqual(listed.lead_messages.map((message: any) => message.role), ["user"]);
  assert.equal(listed.lead_messages[0].text, "");
  // The task opened is read in full, but for its changed files: the page shows 50 and the count.
  const detail = (await client.get("/api/tasks/r")).json();
  const opened = detail.plan.nodes[0];
  assert.ok(opened.attempts[0].result === "做完了" && opened.attempts[0].tool_calls.length === 20);
  assert.ok(detail.supervisor.model_id === "cli:claude" && detail.supervisor.history.length === 0);
  assert.ok(opened.changed_files.length === 50 && opened.changed_files_total === 2000);
  assert.equal(full.plan.nodes[0].changed_files_total, null); // nothing cut, nothing said
});

test("nothing is sent again when nothing changed", async () => {
  const { api, client } = taskApi(folder());
  api.db.saveRun(heavyRun());
  const tags: Record<string, string> = {};
  for (const [url, params] of [["/api/tasks", { brief: "true" }], ["/api/tasks/r", {}], ["/api/engineer", {}]] as const) {
    const first = await client.get(url, { params });
    tags[url] = first.headers.etag;
    const again = await client.get(url, { params, headers: { "If-None-Match": tags[url] } });
    assert.ok(again.status_code === 304 && again.content.length === 0, url);
  }
  const run = api.db.getRun("r")!;
  run.final_result = "改了";
  api.db.saveRun(run);
  // A change is sent, whether or not the task's time was updated with it.
  const changed = await client.get("/api/tasks/r", { headers: { "If-None-Match": tags["/api/tasks/r"] } });
  assert.ok(changed.status_code === 200 && changed.json().final_result === "改了");
  const listed = await client.get("/api/tasks", { params: { brief: "true" }, headers: { "If-None-Match": tags["/api/tasks"] } });
  assert.ok(listed.status_code === 200 && listed.json()[0].final_result === "改了");
});

test("engineer jobs are listed without their diff", async () => {
  const { api, client } = taskApi(folder());
  api.db.saveEngineerJob(EngineerJobSchema.parse({ id: "j1", title: "修", request: "修一下", diff: "+".repeat(400_000) }));
  const overview = await client.get("/api/engineer");
  const [job] = overview.json().jobs;
  assert.ok(overview.content.length < 20_000 && job.diff === null && job.has_diff === true);
  assert.deepEqual((await client.get("/api/engineer/jobs/j1/diff")).json(), { diff: "+".repeat(400_000) });
});

test("an opened task leaves tool output to be read when shown", async () => {
  // The server-IME task opened was 2.8 MB, 60% of it tool output few people open.
  const { api, client } = taskApi(folder());
  const run = heavyRun();
  run.plan.nodes[0].attempts[0].tool_calls[3].detail = "c".repeat(2000);
  api.db.saveRun(run);
  const opened = await client.get("/api/tasks/r");
  assert.ok(opened.content.length < 60_000);
  const calls = opened.json().plan.nodes[0].attempts[0].tool_calls;
  assert.ok(calls.length === 20 && calls[0].tool === "command" && calls[0].output === "");
  assert.ok(calls[0].output_size === 5000 && calls[3].detail.length <= 301);
  assert.deepEqual((await client.get("/api/tasks/r/nodes/a/attempts/0/calls/0/output")).json(), { output: "x".repeat(5000) });
  assert.equal((await client.get("/api/tasks/r/nodes/a/attempts/0/calls/99/output")).status_code, 404);
});

test("a task keeps to the models it was asked for: named ones, or only membership CLIs", async () => {
  const { api, client } = taskApi(folder());
  triaging(api, '{"kind": "task"}');
  const cli = ModelProfileSchema.parse({ ...BEST, id: "cli:codex", provider: "openai", channel: "cli", execution_priority: 0 });
  useModels(api, { ...api.models, [cli.id]: cli });
  const plan = async (choice: Record<string, unknown>) => client.post("/api/tasks", { json: { prompt: "给接口加缓存", ...choice }, headers: ORIGIN });
  const named = (await plan({ only_models: ["x:other"] })).json();
  assert.deepEqual([named.only_models, named.plan.nodes.map((node: any) => node.model_id)], [["x:other"], ["x:other"]]);
  // Its later routing keeps to it too.
  assert.deepEqual([...api.executor.configured(api.db.getRun(named.id)!)], ["x:other"]);
  const clis = (await plan({ cli_only: true, use_cli: false })).json();
  assert.deepEqual([clis.cli_only, clis.use_cli, clis.plan.nodes[0].model_id], [true, true, "cli:codex"]);
  const refused = await plan({ only_models: ["x:nope"] });
  assert.ok(refused.status_code === 422 && refused.json().detail.includes("x:nope"), refused.text);
});
