// The rest of the API's routes: a task's files and publishing them, what chats remember and the
// profile, restarts, learning, recovery, look-backs, a step's activity, model calls, a blocked plan,
// keys, the model list and an incomplete task (the tests of test_publish.py, test_memory.py,
// test_durable.py, test_learning.py, test_recovery_regressions.py, test_retrospect.py,
// test_activity.py, test_call_runtime.py, test_core.py, test_quota.py, test_scoring.py and
// test_unable.py that need the API).
import * as apiProviders from "../src/api-providers.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { settings } from "../src/config.js";
import { ContractError } from "../src/contracts.js";
import type { Database } from "../src/db.js";
import { Executor } from "../src/executor.js";
import {
  CapabilityScoreSchema, DiagnosisSchema, type ExecutionRun, ExecutionRunSchema, ModelProfileSchema, type TaskNode, TaskNodeSchema,
} from "../src/models.js";
import { type CompleteOptions, ProviderResult } from "../src/providers.js";
import { QuotaTracker } from "../src/quota.js";
import * as quality from "../src/quality.js";
import { remembering } from "./helpers/chat-package.js";
import * as retrospect from "../src/retrospect.js";
import { stepKey } from "../src/review.js";
import { AA_SOURCE } from "../packages/research/src/scoring.js";
import * as secrets from "../src/secrets.js";
import { ZipFile } from "../src/zip.js";
import { answered, chatting } from "./helpers/chatting.js";
import { conftest } from "./helpers/conftest.js";
import { model as rankedModel } from "./helpers/lead-run.js";
import { taskApi } from "./helpers/task-api.js";

const { folder } = conftest();
const ORIGIN = { origin: "http://localhost:5173" };
type Api = ReturnType<typeof taskApi>["api"];

// ---- test_publish.py ----

function finishedRun(runId = "done", projectDir: string | null = null, status = "succeeded", changed: string[] = []): ExecutionRun {
  return ExecutionRunSchema.parse({ id: runId, prompt: "写一个游戏", status, budget_usd: 1, project_dir: projectDir, final_result: "Game is ready",
    plan: { summary: "Tetris game", nodes: [{ id: "n", title: "Build", instructions: "build", capability: "coding", model_id: "cli:codex",
      status: "succeeded", result: "Built the game", changed_files: changed }] } });
}

/** A finished scratch task with a game, and the agents' folders beside it. */
function scratch() {
  const given = taskApi(folder());
  const root = join(settings.workspace_root, "done");
  mkdirSync(join(root, "tetris"), { recursive: true });
  writeFileSync(join(root, "tetris", "index.html"), "<canvas></canvas>");
  writeFileSync(join(root, "tetris", "logo.bin"), Buffer.from([0, 1]));
  mkdirSync(join(root, ".review"));
  writeFileSync(join(root, ".review", "note.txt"), "internal");
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude", "settings.json"), "{}");
  given.api.db.saveRun(finishedRun());
  return given;
}

const git = (...args: string[]) => spawnSync("git", args, { encoding: "utf8" });

test("output files skip the agents' folders and stay inside", async () => {
  const { client } = scratch();
  const listing = (await client.get("/api/tasks/done/files")).json();
  assert.deepEqual(listing.files.map((item: any) => item.path), ["tetris/index.html", "tetris/logo.bin"]);
  assert.equal(listing.in_project, false);
  assert.equal((await client.get("/api/tasks/done/files/content", { params: { path: "tetris/index.html" } })).json().text, "<canvas></canvas>");
  for (const path of ["../../etc/passwd", ".review/note.txt", "tetris/../.claude/settings.json"]) {
    assert.equal((await client.get("/api/tasks/done/files/content", { params: { path } })).status_code, 400, path);
  }
  const binary = await client.get("/api/tasks/done/files/content", { params: { path: "tetris/logo.bin" } });
  assert.ok(binary.json().detail.includes("二进制"));
});

test("the archive holds the output and a result record", async () => {
  const { client } = scratch();
  const response = await client.get("/api/tasks/done/archive");
  assert.equal(response.headers["content-type"], "application/zip");
  assert.ok(response.headers["content-disposition"].startsWith('attachment; filename="tetris-game-'));
  const bundle = new ZipFile(response.content);
  assert.deepEqual(bundle.infolist().map((entry) => entry.filename).sort(), ["RESULT.md", "tetris/index.html", "tetris/logo.bin"]);
  const record = bundle.read("RESULT.md").toString("utf8");
  assert.ok(record.includes("Game is ready") && record.includes("Built the game") && record.includes("写一个游戏"));
});

test("project tasks only output the files they changed", async () => {
  const { api, client } = taskApi(folder());
  const project = join(folder(), "project");
  mkdirSync(project);
  writeFileSync(join(project, "app.py"), "changed");
  writeFileSync(join(project, "untouched.py"), "mine");
  api.db.saveRun(finishedRun("proj", project, "succeeded", ["app.py", "deleted.py"]));
  assert.deepEqual((await client.get("/api/tasks/proj/files")).json().files.map((item: any) => item.path), ["app.py"]);
  assert.equal((await client.post("/api/tasks/proj/github", { json: { name: "x" }, headers: ORIGIN })).status_code, 409);
});

test("publishing creates the repository and pushes the output", async () => {
  const { api, client } = scratch();
  const remote = join(folder(), "remote.git");
  assert.equal(git("init", "-q", "--bare", remote).status, 0);
  const created: [string | null, unknown][] = [];
  api.providers.fetch = (async (_url: string | URL | Request, init: RequestInit = {}) => {
    created.push([new Headers(init.headers).get("authorization"), JSON.parse(String(init.body))]);
    return new Response(JSON.stringify({ html_url: "https://github.com/me/tetris", clone_url: remote }), { status: 201, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  process.env.GITHUB_TOKEN = "ghp_test_token_value";
  const response = await client.post("/api/tasks/done/github", { json: { name: "tetris", private: true }, headers: ORIGIN });

  assert.equal(response.status_code, 200, response.text);
  assert.deepEqual(response.json(), { url: "https://github.com/me/tetris" });
  assert.deepEqual(created, [["Bearer ghp_test_token_value", { name: "tetris", private: true, description: "Tetris game", auto_init: false }]]);
  assert.deepEqual(git("--git-dir", remote, "ls-tree", "-r", "--name-only", "main").stdout.split(/\s+/).filter(Boolean),
    ["RESULT.md", "tetris/index.html", "tetris/logo.bin"]);
  assert.equal(api.db.getRun("done")!.github_url, "https://github.com/me/tetris");
  assert.equal((await client.get("/api/tasks/done/files")).json().github_url, "https://github.com/me/tetris");
});

test("publishing without a token needs an existing repository", async () => {
  const { api, client } = scratch();
  delete process.env.GITHUB_TOKEN;
  let response = await client.post("/api/tasks/done/github", { json: { name: "tetris" }, headers: ORIGIN });
  assert.ok(response.status_code === 400 && response.json().detail.includes("令牌"));
  response = await client.post("/api/tasks/done/github", { json: { remote: "https://evil.example/x.git" }, headers: ORIGIN });
  assert.ok(response.status_code === 400 && response.json().detail.includes("GitHub 仓库地址"));
  api.db.saveRun(finishedRun("running", null, "running"));
  assert.equal((await client.post("/api/tasks/running/github", { json: { name: "x" }, headers: ORIGIN })).status_code, 409);
});

test("the GitHub token is kept with the other secrets", async (t) => {
  const { client } = taskApi(folder());
  const writes: [string, string][] = [];
  const original = secrets.deps.runWorker;
  t.after(() => (secrets.deps.runWorker = original));
  secrets.deps.runWorker = async (args, input) => {
    writes.push([args[0], JSON.parse(input).provider]);
    return { code: 0, stdout: "", timedOut: false };
  };
  delete process.env.GITHUB_TOKEN;
  assert.equal((await client.get("/api/github")).json().token, false);
  assert.deepEqual((await client.put("/api/github/token", { json: { token: "ghp_saved_token_1" }, headers: ORIGIN })).json(), { stored: "keyring" });
  assert.equal((await client.get("/api/github")).json().token, true);
  assert.deepEqual((await client.delete("/api/github/token", { headers: ORIGIN })).json(), { removed: "keyring" });
  assert.deepEqual(writes, [["set", "github"], ["delete", "github"]]);
  assert.equal((await client.get("/api/github")).json().token, false);
});

// ---- test_memory.py ----

test("the owner's chats remember, and a new chat is told", async () => {
  const { api, client } = taskApi(folder());
  settings.user_memory = true;
  const sent = chatting(api, ["好的，记住了。\nREMEMBER: 用户: 写代码用 TypeScript", "好。"]);
  const chat = (await client.post("/api/chats", { json: { message: "我写代码都用 TypeScript", model_id: "x:other" }, headers: ORIGIN })).json();
  await answered(api, chat.id);
  assert.ok(sent[0][2].includes("REMEMBER:"));
  assert.equal(api.db.getRun(chat.id)!.lead_messages.at(-1)!.text, "好的，记住了。");
  assert.deepEqual(remembering.facts(remembering.WEB), ["用户: 写代码用 TypeScript"]);
  const other = (await client.post("/api/chats", { json: { message: "写个排序", model_id: "x:other" }, headers: ORIGIN })).json();
  await answered(api, other.id);
  assert.ok(sent[1][2].includes("你记得的") && sent[1][2].includes("TypeScript"));
  // The page lists it, and deletes it.
  const listed = (await client.get("/api/memory")).json();
  assert.ok(listed.enabled);
  assert.deepEqual(listed.places, [{ key: "web", label: "网页对话", facts: ["用户: 写代码用 TypeScript"] }]);
  const forgot = await client.post("/api/memory/forget", { json: { key: "web", fact: "用户: 写代码用 TypeScript" }, headers: ORIGIN });
  assert.ok(forgot.status_code === 200 && forgot.json().places.length === 0);
  assert.equal((await client.post("/api/memory/forget", { json: { key: "web", fact: "x" }, headers: ORIGIN })).status_code, 404);
});

test("without the setting nothing is kept or told", async () => {
  const { api, client } = taskApi(folder());
  const sent = chatting(api, ["好。\nREMEMBER: 用户: x"]);
  const chat = (await client.post("/api/chats", { json: { message: "你好", model_id: "x:other" }, headers: ORIGIN })).json();
  await answered(api, chat.id);
  assert.ok(!sent[0][2].includes("REMEMBER:"));
  assert.deepEqual(remembering.load(), {});
  assert.equal(api.db.getRun(chat.id)!.lead_messages.at(-1)!.text, "好。");
});

test("a profile picked on the page applies now and after a restart", async () => {
  const { client } = taskApi(folder());
  const names = ["profile", "quick_tasks", "solo_tasks", "acceptance", "review_easy_steps", "preflight_cache_minutes", "resume_after_restart",
    "chat_tools", "chat_action_tools"];
  const given = settings.given;
  // Here only solo_tasks is given on its own: the profile leaves it.
  Object.defineProperty(settings, "given", { value: new Set([...given].filter((name) => !names.includes(name)).concat("solo_tasks")), configurable: true });
  try {
    Object.assign(settings, { chat_tools: false, solo_tasks: true });
    const picked = await client.put("/api/settings/profile", { json: { profile: "careful" }, headers: ORIGIN });
    assert.ok(picked.status_code === 200 && picked.json().profile === "careful");
    assert.deepEqual(picked.json().given_alone.careful, ["solo_tasks"]);
    assert.ok(settings.acceptance && !settings.quick_tasks && settings.solo_tasks);
    // Back to the defaults: what careful set goes back to them.
    await client.put("/api/settings/profile", { json: { profile: "" }, headers: ORIGIN });
    assert.ok(!settings.acceptance && settings.quick_tasks && settings.preflight_cache_minutes === 60);
    // A former profile is the defaults.
    assert.equal((await client.put("/api/settings/profile", { json: { profile: "fast" }, headers: ORIGIN })).json().profile, "");
    // Saved: a restart picks it up again.
    await client.put("/api/settings/profile", { json: { profile: "careful" }, headers: ORIGIN });
    settings.useProfile("");
    settings.loadSavedProfile();
    assert.ok(settings.profile === "careful" && settings.acceptance);
    assert.equal((await client.put("/api/settings/profile", { json: { profile: "turbo" }, headers: ORIGIN })).status_code, 422);
  } finally {
    Object.defineProperty(settings, "given", { value: given, configurable: true });
  }
});

// ---- test_durable.py ----

function interrupted(api: Api, runId: string, fields: Record<string, unknown> = {}): void {
  api.db.saveRun(ExecutionRunSchema.parse({ id: runId, prompt: "p", status: "running", budget_usd: 1, ...fields, plan: { summary: "s", nodes: [
    { id: "done", title: "a", instructions: "i", capability: "coding", status: "succeeded" },
    { id: "cut", title: "b", instructions: "i", capability: "coding", status: "running" }] } }));
}

test("a task cut off by a restart goes on by itself", async () => {
  const { api } = taskApi(folder());
  settings.catalog_auto_sync = false; // model research looks nothing up at start
  settings.resume_after_restart = true;
  const started: string[] = [];
  api.executor.start = (runId) => void started.push(runId);
  interrupted(api, "free");
  interrupted(api, "project", { project_dir: folder() });
  interrupted(api, "asking", { waiting_diagnosis_id: "d1" });
  api.start();
  try {
    assert.deepEqual(started, ["free"]);
    const run = api.db.getRun("free")!;
    assert.ok(run.status === "queued" && run.plan.nodes[0].status === "succeeded");
    assert.deepEqual(api.db.events("free").map((event) => event.kind), ["run.restart_resumed"]);
    for (const runId of ["project", "asking"]) assert.equal(api.db.getRun(runId)!.status, "paused");
  } finally {
    await api.close();
  }
});

test("without the setting every cut-off task waits", async () => {
  const { api } = taskApi(folder());
  settings.catalog_auto_sync = false; // model research looks nothing up at start
  const started: string[] = [];
  api.executor.start = (runId) => void started.push(runId);
  interrupted(api, "free");
  api.start();
  try {
    assert.ok(started.length === 0 && api.db.getRun("free")!.status === "paused");
  } finally {
    await api.close();
  }
});

// ---- test_learning.py ----

const LEARNING_MODELS = Object.fromEntries([rankedModel("x:writer", 90), rankedModel("y:reviewer", 92)].map((m) => [m.id, m]));
const lesson = (kind = "rule") => ({ kind, title: "Keep the compile check small", rationale: "Step n spent 40 turns on setup",
  content: "Run a small compile check before the full check; keep both acceptance checks.", tools: ["fakecompiler"], capability: "coding",
  source_nodes: ["n"], problem_kind: "turns_over", problem_key: "x:writer" });

class Models {
  prompts: [string, string][] = [];
  configuredModels(ids: Iterable<string>): Set<string> {
    return new Set(ids);
  }

  async complete(modelId: string, prompt: string, _options: CompleteOptions = {}): Promise<ProviderResult> {
    this.prompts.push([modelId, prompt]);
    let text = "completed";
    if (prompt.includes("learning:analyze")) {
      text = JSON.stringify({ conclusion: "Repeated setup cost too many turns; reuse a checked command.", improvements: [lesson()] });
    } else if (prompt.includes("learning:validate")) text = JSON.stringify({ passed: true, reason: "The evidence supports the bounded advice." });
    return new ProviderResult(text, 10, 10, modelId);
  }
}

function learnedFrom(db: Database): void {
  const node = TaskNodeSchema.parse({ id: "n", title: "compile", instructions: "Use fakecompiler to compile a fixture", capability: "coding", model_id: "x:writer",
    status: "succeeded", estimated_cost_usd: 0.01, attempts: [{ model_id: "x:writer", outcome: "passed", turns: 40, cost_usd: 0.2 }] });
  db.saveRun(ExecutionRunSchema.parse({ id: "first", prompt: "Use fakecompiler", plan: { summary: "s", nodes: [node] }, status: "succeeded", budget_usd: 1,
    actual_cost_usd: 0.2 }));
  retrospect.record(db, "first");
}

test("the API can start, show, disable and delete a lesson", async () => {
  const { api, client } = taskApi(folder());
  learnedFrom(api.db);
  const executor = new Executor(api.db, new Models(), LEARNING_MODELS);
  api.executor = executor;
  assert.equal((await client.put("/api/improvements/settings", { json: { enabled: true, budget_usd: 0.1 } })).status_code, 200);
  assert.equal((await client.post("/api/tasks/first/learning")).status_code, 202);
  await executor.learningTasks.get("first")!.promise;
  const body = (await client.get("/api/tasks/first/learning")).json();
  assert.ok(body.review.status === "done" && body.retrospective.run_id === "first");
  const [item] = body.improvements;
  // In use, it is stopped before it can be deleted.
  assert.equal((await client.delete(`/api/improvements/${item.id}`)).status_code, 409);
  assert.equal((await client.post(`/api/improvements/${item.id}/disable`)).json().status, "disabled");
  assert.equal((await client.delete(`/api/improvements/${item.id}`)).status_code, 204);
  assert.equal(api.db.improvement(item.id), null);
  assert.equal((await client.delete(`/api/improvements/${item.id}`)).status_code, 404);
  assert.equal((await client.get("/api/tasks/missing/learning")).status_code, 404);
});

for (const active of [false, true]) {
  test(`a user's cancel never starts the automatic look back (${active ? "while running" : "before"})`, async () => {
    const { api, client } = taskApi(folder());
    let started!: () => void;
    const begun = new Promise<void>((done) => (started = done));
    class Waiting extends Models {
      override async complete(modelId: string, prompt: string, options: CompleteOptions = {}): Promise<ProviderResult> {
        if (prompt.includes("learning:")) return super.complete(modelId, prompt, options);
        started();
        return new Promise((_done, fail) => options.signal?.addEventListener("abort", () => fail(options.signal!.reason)));
      }
    }
    const models = new Waiting();
    const executor = new Executor(api.db, models, LEARNING_MODELS);
    api.executor = executor;
    api.db.saveLearningSettings({ enabled: true });
    api.db.saveRun(ExecutionRunSchema.parse({ id: "stop", prompt: "p", status: "queued", budget_usd: 1,
      plan: { summary: "s", nodes: [{ id: "n", title: "work", instructions: "work", capability: "coding", model_id: "x:writer" }] } }));
    try {
      if (active) {
        executor.start("stop");
        await begun;
      }
      assert.equal((await client.post("/api/tasks/stop/cancel")).status_code, 200);
      if (active) await executor.tasks.get("stop")!.settled();
      executor.emit("stop", "run.cancelled");
      executor.finishLearning("stop");
      await new Promise((done) => setImmediate(done));
      assert.ok(!executor.learningTasks.has("stop"));
      assert.ok(api.db.learningReview("stop") === null && api.db.retrospective("stop") === null);
      assert.ok(api.db.improvements("stop").length === 0 && models.prompts.length === 0);
      const body = (await client.get("/api/tasks/stop/learning")).json();
      assert.ok(body.automatic_eligible === false && body.retrospective === null);
      assert.equal(body.automatic_skip_reason, "任务已手动取消，不自动复盘。");
      assert.equal(api.db.getRun("stop")!.status, "cancelled");
    } finally {
      await executor.shutdown();
    }
  });
}

// ---- test_recovery_regressions.py ----

const scoredModel = (id = "deepseek:primary", score = 95, fields: Record<string, unknown> = {}) => ModelProfileSchema.parse({ id, provider: id.split(":")[0],
  display_name: id, context_window: 1_000_000, input_per_million: 1, output_per_million: 1, scores: { planning: score, coding: score, reliability: score }, ...fields });
const workNode = (fields: Record<string, unknown> = {}) => TaskNodeSchema.parse({ id: "n", title: "n", instructions: "work on n", capability: "coding",
  model_id: "deepseek:primary", ...fields });
const reviewRun = (nodes: TaskNode[], status: string, fields: Record<string, unknown> = {}) => ExecutionRunSchema.parse({ id: "r", prompt: "review fixture",
  budget_usd: 1, status, plan: { summary: "fixture", nodes }, ...fields });

test("confirming reselects disabled models before the budget is estimated", async () => {
  const { api, client } = taskApi(folder());
  Object.assign(settings, { review_nodes: false, max_node_attempts: 1 });
  api.models = Object.fromEntries([scoredModel("deepseek:primary", 95, { enabled: false }), scoredModel("deepseek:backup")].map((m) => [m.id, m]));
  api.providers.configuredModels = (ids) => new Set(ids);
  api.executor.start = () => {};
  api.db.saveRun(reviewRun([workNode()], "awaiting_confirmation"));
  assert.equal((await client.post("/api/tasks/r/confirm", { json: {} })).status_code, 200);
  assert.equal(api.db.getRun("r")!.plan.nodes[0].model_id, "deepseek:backup");
});

for (const repair of [false, true]) {
  test(`cancelling stops a manual diagnosis${repair ? " (a repair)" : ""}, and deleting waits for it`, async () => {
    const { api, client } = taskApi(folder());
    Object.assign(settings, { review_nodes: false, max_node_attempts: 1 });
    process.env.DEEPSEEK_API_KEY = "test-only";
    let started!: () => void;
    const begun = new Promise<void>((done) => (started = done));
    const quota = new QuotaTracker();
    const delayed = {
      quota,
      configuredModels: (ids: Iterable<string>) => new Set([...ids].filter((id) => !quota.exhausted(id))),
      complete: (_modelId: string, _prompt: string, options: CompleteOptions = {}) => {
        started();
        return new Promise<ProviderResult>((_done, fail) => options.signal?.addEventListener("abort", () => fail(options.signal!.reason)));
      },
    };
    const executor = new Executor(api.db, delayed, { "deepseek:primary": scoredModel() });
    api.executor = executor;
    api.db.saveRun(reviewRun([workNode()], "failed", { diagnoses: [DiagnosisSchema.parse({ id: "d", trigger: "manual", node_id: repair ? "n" : null,
      model_id: "deepseek:primary" })] }));
    executor.startDiagnosis("r", "d");
    const task = executor.diagnosing.get("r")!;
    await begun;
    assert.equal((await client.delete("/api/tasks/r")).status_code, 409);
    assert.equal((await client.post("/api/tasks/r/cancel")).status_code, 200);
    await assert.rejects(task.promise);
    assert.equal(api.db.getRun("r")!.diagnoses[0].status, "failed");
    assert.equal(api.db.getRun("r")!.actual_cost_usd, 0);
    assert.equal((await client.delete("/api/tasks/r")).status_code, 204);
  });
}

// ---- test_retrospect.py ----

function lookedBack(runId: string, daysAgo = 0): ExecutionRun {
  const created = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  return ExecutionRunSchema.parse({ id: runId, prompt: "写一个 FIFO", budget_usd: 2, status: "succeeded", created_at: created, updated_at: created, plan: { summary: "s", nodes: [{
    id: "n", title: "冒烟测试", instructions: "i", capability: "coding", model_id: "deepseek:flash", status: "succeeded", estimated_cost_usd: 0.01, difficulty: "normal",
    attempts: [{ model_id: "glm:glm", outcome: "unavailable", reason: "glm request failed: 5 分钟没有回复" },
      { model_id: "deepseek:flash", outcome: "passed", cost_usd: 0.3, turns: 40, tool_calls: [
        { turn: 1, tool: "Bash", detail: "source /eda/.edarc && which vcs", ok: false }, { turn: 2, tool: "Bash", detail: "vcs -sverilog tb.sv", ok: false }] }] }] } });
}

test("the API lists recurring problems and a task's look back", async () => {
  const { api, client } = taskApi(folder());
  for (const [runId, days] of [["a", 2], ["b", 1]] as const) api.db.saveRun(lookedBack(runId, days));
  const recurring = (await client.get("/api/retrospectives/recurring")).json();
  assert.ok(recurring.some((group: any) => group.kind === "estimate_low" && group.key === "deepseek:flash"));
  assert.ok(recurring.every((group: any) => group.runs.length >= 2));
  const body = (await client.get("/api/tasks/a/retrospective")).json();
  assert.ok(body.run_id === "a" && body.steps[0].turns === 40);
  assert.equal((await client.get("/api/tasks/missing/retrospective")).status_code, 404);
});

test("the API lists problems by what they are about", async () => {
  const { api, client } = taskApi(folder());
  api.db.saveRun(lookedBack("a"));
  const body = retrospect.record(api.db, "a")!;
  for (const problem of body.problems) problem.topic = "新思 EDA 环境未加载";
  api.db.saveRetrospective("a", body);
  const [group] = (await client.get("/api/retrospectives/topics")).json();
  assert.ok(group.topic === "新思 EDA 环境未加载" && group.runs.join() === "a" && group.members.includes("estimate_low:deepseek:flash"));
});

// ---- test_activity.py, test_call_runtime.py, test_core.py, test_quota.py, test_scoring.py ----

test("the activity of a running step is served", async () => {
  const { api, client } = taskApi(folder());
  api.db.saveRun(ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "running", budget_usd: 1,
    plan: { summary: "s", nodes: [{ id: "n", title: "t", instructions: "i", capability: "coding" }] } }));
  assert.deepEqual((await client.get("/api/tasks/r/nodes/n/activity")).json(), { running: false, total: 0, calls: [] });
  api.executor.toolLogs.set(stepKey("r", "n"), [{ turn: 1, tool: "Bash", detail: "ls", ok: true }]);
  const body = (await client.get("/api/tasks/r/nodes/n/activity")).json();
  assert.ok(body.running && body.calls[0].detail === "ls");
  assert.equal((await client.get("/api/tasks/r/nodes/missing/activity")).status_code, 404);
});

test("the calls API is per task and marks unknown usage", async () => {
  const { api, client } = taskApi(folder());
  api.db.saveRun(ExecutionRunSchema.parse({ id: "r", prompt: "build", status: "running", budget_usd: 10,
    plan: { summary: "build", nodes: [{ id: "n", title: "Build", instructions: "keep the public API", capability: "coding", model_id: "deepseek:test" }] } }));
  api.db.saveModelCall({ id: "c", run_id: "r", node_id: "n", started_at: "now", requests: 1, usage_known: false, cost_usd: 0, input_tokens: 0, output_tokens: 0,
    cached_input_tokens: 0, retries: 0 });
  const response = await client.get("/api/tasks/r/calls");
  assert.equal(response.status_code, 200);
  assert.equal(response.json().summary.unknown_usage, 1);
  assert.equal((await client.get("/api/tasks/missing/calls")).status_code, 404);
});

test("a plan whose artifacts do not hold is returned as blocked, not run some other way", async () => {
  const { api, client } = taskApi(folder());
  api.deps.autonomousPlan = async () => {
    throw new ContractError("missing accepted report dependency");
  };
  const response = await client.post("/api/tasks", { json: { prompt: "Generate a coverage report", budget_usd: 1 } });
  assert.equal(response.status_code, 422);
  assert.equal(response.json().detail.status, "blocked");
  assert.ok(response.json().detail.reason.includes("report dependency"));
});

test("saving a new key puts its models back in routing", async () => {
  const { api, client } = taskApi(folder());
  api.providers.quota.mark("deepseek:deepseek-flash", "deepseek returned 402: Insufficient Balance");
  api.deps.setProviderKey = async () => "session";
  assert.equal((await client.get("/api/models/quota")).json()[0].model_id, "deepseek:deepseek-flash");
  assert.equal((await client.put("/api/providers/deepseek/key", { json: { api_key: "sk-new-key-123" }, headers: ORIGIN })).status_code, 200);
  assert.deepEqual((await client.get("/api/models/quota")).json(), []);
});

test("the model list shows only models scored from AA", async () => {
  const { api, client } = taskApi(folder());
  const scored = Object.values(api.models).find((m) => m.channel === "api")!;
  const original = [scored.scores, scored.scores_source] as const;
  Object.assign(scored, { scores: CapabilityScoreSchema.parse({}), scores_source: AA_SOURCE });
  let listed;
  try {
    listed = (await client.get("/api/models")).json();
  } finally {
    [scored.scores, scored.scores_source] = original;
  }
  const ids = new Set(listed.map((m: any) => m.id));
  assert.ok(ids.has(scored.id) && !ids.has("mock:local"));
  assert.ok(listed.every((m: any) => m.scores_source === AA_SOURCE));
  // Each with its provider's name from the registry, for the page.
  const entry = listed.find((m: any) => m.id === scored.id);
  assert.equal(entry.provider_name, apiProviders.byId(scored.provider)!.label);
});

// ---- test_unable.py ----

const DEPLOY = "部署脚本 deploy.sh 已就绪，配置也写好了。\nUNABLE: 沙箱不能联网，没有实际部署到服务器；允许联网并提供服务器凭据后可以部署。";
const unableModel = (id: string, planning: number, channel = "api") => ModelProfileSchema.parse({ id, provider: id.split(":")[0], display_name: id, channel,
  context_window: 1_000_000, input_per_million: 1, output_per_million: 1, execution_priority: channel === "cli" ? 0 : 100, scores: { coding: 90, planning, reliability: 90 } });
const DIAGNOSIS_MODELS = Object.fromEntries([unableModel("x:api", 99), unableModel("cli:claude", 90, "cli")].map((m) => [m.id, m]));

/** Deploying needs the internet; everything else works. */
class Workers {
  calls: string[] = [];
  configuredModels(ids: Iterable<string>): Set<string> {
    return new Set(ids);
  }

  async complete(modelId: string, prompt: string): Promise<ProviderResult> {
    assert.ok(!prompt.startsWith(quality.REVIEW_MARKER));
    const title = prompt.split("\n", 1)[0].replace(/^Task: /, "");
    this.calls.push(title);
    return new ProviderResult(title === "部署上线" ? DEPLOY : `${title}完成`, 0, 0, modelId);
  }
}

test("an incomplete task can be resumed or changed once the limit is lifted", async () => {
  const { api, client } = taskApi(folder());
  Object.assign(settings, { auto_diagnose: false, review_nodes: false });
  const node = (id: string, title: string, deps: string[] = []) => ({ id, title, instructions: title, capability: "coding", model_id: "x:api", dependencies: deps });
  api.db.saveRun(ExecutionRunSchema.parse({ id: "r", prompt: "做一个网站并部署", status: "queued", budget_usd: 5, use_cli: true, plan: { summary: "网站", nodes: [
    node("build", "构建网站"), node("deploy", "部署上线", ["build"]), node("check", "检查线上页面", ["deploy"]), node("docs", "写使用说明")] } }));
  const executor = new Executor(api.db, new Workers(), DIAGNOSIS_MODELS);
  api.executor = executor;
  api.models = DIAGNOSIS_MODELS;
  api.providers.configuredModels = (ids) => new Set(ids);
  await executor.execute("r");
  assert.equal(api.db.getRun("r")!.status, "incomplete");

  const started: string[] = [];
  executor.start = (runId) => void started.push(runId);
  const response = await client.post("/api/tasks/r/resume", { json: {}, headers: ORIGIN });
  assert.equal(response.status_code, 200, response.text);
  const nodes = Object.fromEntries(api.db.getRun("r")!.plan.nodes.map((item) => [item.id, item]));
  assert.ok(nodes.deploy.status === "pending" && nodes.check.status === "pending");
  assert.ok(nodes.deploy.feedback!.includes("上次这一步无法完成") && nodes.deploy.unable_reason === null);
  assert.ok(nodes.build.status === "succeeded" && started.join() === "r");
});
