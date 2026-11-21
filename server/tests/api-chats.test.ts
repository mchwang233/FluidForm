// Chats through the API: started, answered, turned into a task, deciding chat or task, files sent
// along, and the models page's usage (test_chat.py, the tests that need the API).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as files from "../src/attachments.js";
import { settings } from "../src/config.js";
import { type Attachment, DiagnosisSchema, ExecutionRunSchema, folderId, type ModelProfile, ModelProfileSchema, type SupervisorSession, TaskPlanSchema } from "../src/models.js";
import { type ChatTools, ProviderResult } from "../src/providers.js";
import * as streaming from "../src/streaming.js";
import * as supervisor from "../src/supervisor.js";
import { CHAT_ROLE } from "./helpers/chat-package.js";
import { readKind } from "../src/triage.js";
import { conftest } from "./helpers/conftest.js";
import { taskApi } from "./helpers/task-api.js";
import { answered, BEST, type ConverseOptions, chatting, OTHER, triaging } from "./helpers/chatting.js";

const { folder } = conftest();
const ORIGIN = { origin: "http://localhost:5173" };
const PNG = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(64)]);
test("a chat is answered by the model chosen, without planning anything", async () => {
  const { api, client } = taskApi(folder());
  const sent = chatting(api, ["SQLite 的 WAL 模式允许读写并发。", "检查点会把日志写回主库。"]);

  assert.deepEqual((await client.get("/api/chats/models")).json().map((item: any) => item.id), ["x:best", "x:other"]);
  const response = await client.post("/api/chats", { json: { message: "WAL 是什么？\n顺便说说检查点", model_id: "x:other" }, headers: ORIGIN });
  assert.equal(response.status_code, 201, response.text);
  const chat = response.json();
  assert.deepEqual([chat.kind, chat.status, chat.plan.nodes, chat.plan.summary], ["chat", "draft", [], "WAL 是什么？"]);
  await answered(api, chat.id);
  assert.equal((await client.post(`/api/tasks/${chat.id}/lead`, { json: { message: "检查点呢？" }, headers: ORIGIN })).status_code, 202);
  await answered(api, chat.id);

  const run = api.db.getRun(chat.id)!;
  assert.deepEqual(run.lead_messages.map((m) => [m.role, m.status, m.text]), [
    ["user", "done", "WAL 是什么？\n顺便说说检查点"], ["lead", "done", "SQLite 的 WAL 模式允许读写并发。"],
    ["user", "done", "检查点呢？"], ["lead", "done", "检查点会把日志写回主库。"]]);
  // The chosen model answers as a conversation partner, told so once; not as a task's lead.
  assert.deepEqual(sent.map(([model]) => model), ["x:other", "x:other"]);
  assert.ok(sent[0][2].startsWith(CHAT_ROLE) && sent[0][2].includes("WAL 是什么") && !sent[0][2].includes("MESSAGE from the user"));
  assert.equal(sent[1][2], "检查点呢？");
  assert.ok(run.status === "draft" && run.supervisor!.model_id === "x:other");
});

test("a chat about a project reads it from its folder", async () => {
  const { api, client } = taskApi(folder());
  const sent = chatting(api);
  const project = join(folder(), "projects", "shop");
  mkdirSync(project, { recursive: true });
  settings.project_roots = [join(folder(), "projects")];
  const chat = (await client.post("/api/chats", { json: { message: "这个项目的入口在哪？", project_dir: project }, headers: ORIGIN })).json();
  await answered(api, chat.id);
  const [[model, cwd, prompt]] = sent;
  // The best model by default, in the project folder (a CLI's lead conversation there is read-only).
  assert.ok(model === "x:best" && cwd === realpathSync(project) && prompt.includes(realpathSync(project)));
});

test("a chat needs a model that can hold a conversation", async () => {
  const { api, client } = taskApi(folder());
  chatting(api);
  const response = await client.post("/api/chats", { json: { message: "你好", model_id: "x:missing" }, headers: ORIGIN });
  assert.ok(response.status_code === 422 && api.db.listRuns().length === 0);
});

test("a chat turns into a task planned with the conversation", async () => {
  const { api, client } = taskApi(folder());
  chatting(api, ["可以用 Redis 做缓存，命中率会更高。"]);
  const prompts: string[] = [];
  api.deps.autonomousPlan = async (prompt: string) => {
    prompts.push(prompt);
    return TaskPlanSchema.parse({ summary: "加缓存", folder: "add cache", nodes: [{ id: "a", title: "加缓存", instructions: "add a cache", capability: "coding" }] });
  };
  const chat = (await client.post("/api/chats", { json: { message: "接口太慢怎么办？" }, headers: ORIGIN })).json();
  await answered(api, chat.id);

  const response = await client.post(`/api/tasks/${chat.id}/promote`, { json: { prompt: "给商品接口加 Redis 缓存", budget_usd: 3 }, headers: ORIGIN });
  assert.equal(response.status_code, 200, response.text);
  const task = api.db.getRun(chat.id)!;
  assert.deepEqual([task.kind, task.status, task.prompt, task.budget_usd], ["task", "awaiting_confirmation", "给商品接口加 Redis 缓存", 3]);
  assert.ok(task.plan.nodes.map((node) => node.title).join() === "加缓存" && task.folder_name);
  // The planner, and later the steps' checks, know the conversation it grew out of.
  const [prompt] = prompts;
  assert.ok(prompt.includes("接口太慢怎么办") && prompt.includes("Redis 做缓存") && prompt.trimEnd().endsWith("给商品接口加 Redis 缓存"));
  assert.ok(task.background!.includes("Redis 做缓存"));
  // The conversation stays with it.
  assert.deepEqual(task.lead_messages.map((m) => m.text).slice(0, 2), ["接口太慢怎么办？", "可以用 Redis 做缓存，命中率会更高。"]);
  // Only once, and only a chat.
  assert.equal((await client.post(`/api/tasks/${chat.id}/promote`, { json: {}, headers: ORIGIN })).status_code, 409);
});

test("a chat can be deleted", async () => {
  const { api, client } = taskApi(folder());
  chatting(api);
  const chat = (await client.post("/api/chats", { json: { message: "随便聊聊" }, headers: ORIGIN })).json();
  await answered(api, chat.id);
  assert.ok([200, 204].includes((await client.delete(`/api/tasks/${chat.id}`, { headers: ORIGIN })).status_code));
  assert.equal(api.db.getRun(chat.id), null);
});

test("a question left to Super Partner becomes a chat", async () => {
  const { api, client } = taskApi(folder());
  const [sent, asked] = triaging(api, '{"kind": "chat"}');
  const response = await client.post("/api/start", { json: { prompt: "WAL 和回滚日志有什么区别？" }, headers: ORIGIN });
  assert.equal(response.status_code, 201, response.text);
  const run = response.json();
  await answered(api, run.id);
  // The cheapest model decided; deciding is paid by the chat, which the best chat model answers.
  assert.ok(asked.map(([model]) => model).join() === "x:cheap" && asked[0][1].includes("WAL 和回滚日志"));
  const saved = api.db.getRun(run.id)!;
  assert.deepEqual([saved.kind, saved.status, saved.auto_routed], ["chat", "draft", true]);
  assert.ok(saved.actual_cost_usd > 0 && sent[0][0] === "x:best");
});

test("work left to Super Partner is planned as a task, and can still become a chat", async () => {
  const { api, client } = taskApi(folder());
  const [sent] = triaging(api, '{"kind": "task"}');
  const run = (await client.post("/api/start", { json: { prompt: "给商品接口加 Redis 缓存" }, headers: ORIGIN })).json();
  const saved = api.db.getRun(run.id)!;
  assert.deepEqual([saved.kind, saved.status, saved.auto_routed], ["task", "awaiting_confirmation", true]);
  assert.deepEqual(saved.plan.nodes.map((node) => node.title), ["加缓存"]);

  // It was only a question after all: the plan goes, the request is answered as a chat.
  const response = await client.post(`/api/tasks/${run.id}/as-chat`, { headers: ORIGIN });
  assert.equal(response.status_code, 200, response.text);
  await answered(api, run.id);
  const chat = api.db.getRun(run.id)!;
  assert.deepEqual([chat.kind, chat.status, chat.plan.nodes], ["chat", "draft", []]);
  assert.ok(chat.lead_messages.map((m) => m.role).join() === "user,lead" && sent[0][2].includes("给商品接口加 Redis 缓存"));
  // Only a task waiting for confirmation.
  assert.equal((await client.post(`/api/tasks/${run.id}/as-chat`, { headers: ORIGIN })).status_code, 409);
});

test("without a clear answer it is a task", async () => {
  const { api, client } = taskApi(folder());
  const [, asked] = triaging(api, new Error("provider down"));
  const run = (await client.post("/api/start", { json: { prompt: "随便看看这个" }, headers: ORIGIN })).json();
  // The model was asked and failed: as before chats existed, it is planned as a task.
  assert.ok(asked.length === 1 && api.db.getRun(run.id)!.kind === "task");
  assert.deepEqual(['{"kind": "chat"}', "```json\n{\"kind\":\"chat\"}\n```", "chat", "", '{"kind": "task"}'].map(readKind), ["chat", "chat", "task", "task", "task"]);
});

test("a question about an attached screenshot is a chat that sees it", async () => {
  const { api, client } = taskApi(folder());
  const [sent, asked] = triaging(api, '{"kind": "chat"}');
  // The best talker cannot see images: the chat goes to one that can.
  api.models[BEST.id] = { ...BEST, supports_vision: false };
  const shot = files.save("error.png", PNG);
  const log = files.save("trace.log", Buffer.from("Traceback: KeyError 'id'\n"));
  const run = (await client.post("/api/start", { json: { prompt: "这个报错是什么意思？", attachments: [shot.id, log.id] }, headers: ORIGIN })).json();
  await answered(api, run.id);
  // Deciding knows files came with it; they do not make it a task.
  assert.ok(asked[0][1].includes("error.png") && asked[0][1].includes("trace.log"));
  const chat = api.db.getRun(run.id)!;
  assert.ok(chat.kind === "chat" && chat.attachments.map((item) => item.name).join() === "error.png,trace.log");
  assert.ok(sent[0][0] === "x:other");
  assert.deepEqual(sent.attached, [["error.png", "trace.log"]]);
  // Only the first message carries them; the conversation remembers.
  await client.post(`/api/tasks/${run.id}/lead`, { json: { message: "怎么修？" }, headers: ORIGIN });
  await answered(api, run.id);
  assert.deepEqual(sent.attached, [["error.png", "trace.log"], []]);
});

test("a chat with attachments hands them to the task it becomes", async () => {
  const { api, client } = taskApi(folder());
  chatting(api);
  const prompts: string[] = [];
  api.deps.autonomousPlan = async (prompt: string) => {
    prompts.push(prompt);
    return TaskPlanSchema.parse({ summary: "修复", nodes: [{ id: "a", title: "修复", instructions: "i", capability: "coding" }] });
  };
  const log = files.save("trace.log", Buffer.from("Traceback: KeyError 'id'\n"));
  const chat = (await client.post("/api/chats", { json: { message: "这个报错怎么回事？", attachments: [log.id] }, headers: ORIGIN })).json();
  await answered(api, chat.id);
  assert.equal((await client.post(`/api/tasks/${chat.id}/promote`, { json: { prompt: "修复这个 KeyError" }, headers: ORIGIN })).status_code, 200);
  const task = api.db.getRun(chat.id)!;
  assert.ok(task.attachments.map((item) => item.name).join() === "trace.log" && prompts[0].includes("trace.log"));
});

test("files sent later in a conversation reach the lead once and join the task", async () => {
  const { api, client } = taskApi(folder());
  const sent = chatting(api);
  const chat = (await client.post("/api/chats", { json: { message: "看看这个" }, headers: ORIGIN })).json();
  await answered(api, chat.id);
  const log = files.save("trace.log", Buffer.from("Traceback: KeyError 'id'\n"));
  // A file alone is a message.
  const response = await client.post(`/api/tasks/${chat.id}/lead`, { json: { message: "", attachments: [log.id] }, headers: ORIGIN });
  assert.equal(response.status_code, 202, response.text);
  await answered(api, chat.id);
  await client.post(`/api/tasks/${chat.id}/lead`, { json: { message: "怎么修？" }, headers: ORIGIN });
  await answered(api, chat.id);
  assert.deepEqual(sent.attached, [[], ["trace.log"], []]);
  const run = api.db.getRun(chat.id)!;
  assert.deepEqual(run.attachments.map((item) => item.name), ["trace.log"]);
  assert.deepEqual(run.lead_messages.filter((m) => m.role === "user").map((m) => [m.text, m.attachments.map((a) => a.name)]),
    [["看看这个", []], ["（见附件）", ["trace.log"]], ["怎么修？", []]]);
  // Sent with a task, it is the task's: not discarded on its own.
  assert.equal((await client.delete(`/api/attachments/${log.id}`, { headers: ORIGIN })).status_code, 409);
  assert.equal((await client.post(`/api/tasks/${chat.id}/lead`, { json: { message: "" }, headers: ORIGIN })).status_code, 422);
  assert.equal((await client.post(`/api/tasks/${chat.id}/lead`, { json: { message: "x", attachments: ["0".repeat(32)] }, headers: ORIGIN })).status_code, 422);
});

test("a lead that spoke before files could be sent along is not sent them again", async () => {
  const { api, client } = taskApi(folder());
  const sent = chatting(api);
  const chat = (await client.post("/api/chats", { json: { message: "看看", attachments: [files.save("a.log", Buffer.from("x\n")).id] }, headers: ORIGIN })).json();
  await answered(api, chat.id);
  const run = api.db.getRun(chat.id)!;
  (run as any).lead_seen_attachments = null; // as saved before
  api.db.saveRun(run);
  await client.post(`/api/tasks/${chat.id}/lead`, { json: { message: "然后呢？" }, headers: ORIGIN });
  await answered(api, chat.id);
  assert.deepEqual(sent.attached, [["a.log"], []]);
});

test("an answer to the lead's question can carry files", async () => {
  const { api, client } = taskApi(folder());
  api.db.saveRun(ExecutionRunSchema.parse({ id: "asked", prompt: "p", status: "paused", budget_usd: 1, waiting_diagnosis_id: "q",
    plan: { summary: "s", nodes: [{ id: "a", title: "a", instructions: "i", capability: "coding" }] },
    diagnoses: [DiagnosisSchema.parse({ id: "q", trigger: "lead", node_id: "a", question: "哪个界面？" })] }));
  const answers: string[] = [];
  api.executor.startLeadAnswer = (_runId, questionId) => void answers.push(questionId);
  const shot = files.save("screen.png", PNG);
  const response = await client.post("/api/tasks/asked/diagnoses/q/reply", { json: { attachments: [shot.id] }, headers: ORIGIN });
  assert.equal(response.status_code, 200, response.text);
  const saved = api.db.getRun("asked")!;
  assert.ok(answers.join() === "q" && saved.attachments.map((item) => item.name).join() === "screen.png");
  assert.deepEqual(saved.diagnoses[0].messages.at(-1)!.attachments.map((a) => a.name), ["screen.png"]);
});

test("a lead that cannot see images is told of them instead", async () => {
  const { api, client } = taskApi(folder());
  const sent = chatting(api);
  api.executor.modelLookup[BEST.id] = { ...BEST, supports_vision: false };
  const chat = (await client.post("/api/chats", { json: { message: "你好", model_id: BEST.id }, headers: ORIGIN })).json();
  await answered(api, chat.id);
  const shot = files.save("screen.png", PNG);
  const log = files.save("a.log", Buffer.from("x\n"));
  await client.post(`/api/tasks/${chat.id}/lead`, { json: { message: "看图", attachments: [shot.id, log.id] }, headers: ORIGIN });
  await answered(api, chat.id);
  assert.deepEqual(sent.attached.at(-1), ["a.log"]);
  assert.ok(sent.at(-1)![2].includes("images you cannot see: screen.png"));
});

test("the models page gets each model's calls, spend and work", async () => {
  const { api, client } = taskApi(folder());
  api.db.saveRun(ExecutionRunSchema.parse({ id: "ime", prompt: "p", status: "succeeded", budget_usd: 1, plan: { summary: "写输入法", title: "中文输入法", nodes: [] } }));
  const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().replace("Z", "+00:00");
  const call = (n: number, model: string, cost: number, run: string | null = "ime", daysAgo = 0, extra: Record<string, unknown> = {}) =>
    api.db.saveModelCall({ id: `c${n}`, model_id: model, run_id: run, cost_usd: cost, started_at: iso(daysAgo), ...extra });
  call(1, "x:best", 0.25);
  call(2, "x:best", 0.5);
  call(3, "cli:codex", 0.0, "ime", 0, { delegated: true }); // handed its work on: counted as the other model's
  call(4, "x:best", 9.0, "ime", 40); // too long ago
  call(5, "x:other", 0.1, null);
  const body = (await client.get("/api/models/usage")).json();
  assert.ok(body.days === 30 && Object.keys(body.models).sort().join() === "x:best,x:other");
  const best = body.models["x:best"];
  assert.deepEqual([best.calls, best.cost_usd, best.run_count], [2, 0.75, 1]);
  assert.deepEqual(best.runs, [{ id: "ime", title: "中文输入法", kind: "task", calls: 2 }]);
  assert.deepEqual(body.models["x:other"].runs, []);
  assert.equal((await client.get("/api/models/usage?days=60")).json().models["x:best"].calls, 3);
});

test("a chat model is told which model it is, and that earlier replies were not its own", async () => {
  // Regression: told nothing about itself, a chat model guessed its identity, and after a model change
  // took the previous model's self-description from the transcript as its own.
  const { api, client } = taskApi(folder());
  const sent = chatting(api, ["我是 X:OTHER。"]);
  const chat = (await client.post("/api/chats", { json: { message: "你是谁？", model_id: "x:other" }, headers: ORIGIN })).json();
  await answered(api, chat.id);
  assert.ok(sent[0][2].includes("X:OTHER (x:other, through its API)"));
  assert.ok(!sent[0][2].includes("How to talk here") && !sent[0][2].includes("group chat"));
  // Another model takes the conversation over: told who it is, and whose the earlier replies were.
  let run = api.db.getRun(chat.id)!;
  run.supervisor = supervisor.newSession(BEST, run.supervisor);
  api.db.saveRun(run);
  assert.equal((await client.post(`/api/tasks/${chat.id}/lead`, { json: { message: "你到底是谁？" }, headers: ORIGIN })).status_code, 202);
  await answered(api, chat.id);
  const [model, , prompt] = sent[1];
  assert.ok(model === "x:best" && prompt.includes("X:BEST (x:best, through its API)"));
  assert.ok(prompt.includes("x:other") && prompt.includes("我是 X:OTHER。") && prompt.includes("not yours"));
  // The same model again, in a conversation of its own: its earlier replies are named too.
  run = api.db.getRun(chat.id)!;
  run.supervisor = supervisor.newSession(BEST, run.supervisor);
  api.db.saveRun(run);
  assert.equal((await client.post(`/api/tasks/${chat.id}/lead`, { json: { message: "再说一次？" }, headers: ORIGIN })).status_code, 202);
  await answered(api, chat.id);
  assert.ok(sent[2][2].includes("another model (x:other, x:best)"));
});

test("with chat tools, an API chat does quick jobs in its own folder", async () => {
  const { api, client } = taskApi(folder());
  Object.assign(settings, { chat_tools: true, chat_tools_network: true, workspace_root: join(folder(), "ws") });
  const sent = chatting(api);
  const given: (ChatTools | null | undefined)[] = [];
  api.providers.converse = async (session: SupervisorSession, prompt: string, options: ConverseOptions = {}) => {
    sent.push([session.model_id, session.cwd, prompt]);
    given.push(options.tools);
    session.calls += 1;
    return new ProviderResult("北京：晴 18°C", 10, 10);
  };
  let chat = (await client.post("/api/chats", { json: { message: "北京天气怎么样？", model_id: "x:other" }, headers: ORIGIN })).json();
  await answered(api, chat.id);
  const [tools] = given;
  const run = api.db.getRun(chat.id)!;
  assert.ok(tools!.folder === join(folder(), "ws", folderId(run)) && statSync(tools!.folder).isDirectory());
  assert.deepEqual([tools!.network, tools!.turns, tools!.seconds], [true, settings.chat_tool_turns, settings.chat_tool_seconds]);
  assert.ok(sent[0][2].includes("Quick jobs you do yourself") && sent[0][2].includes(tools!.folder));
  assert.ok(sent[0][2].includes("can reach the internet") && sent[0][2].includes("turn this conversation into a task"));
  // A chat about a project only reads it: no tools.
  const project = join(folder(), "proj");
  mkdirSync(project);
  settings.project_roots = [folder()];
  chat = (await client.post("/api/chats", { json: { message: "这个项目是做什么的？", model_id: "x:other", project_dir: project }, headers: ORIGIN })).json();
  await answered(api, chat.id);
  assert.ok(!given.at(-1) && !sent.at(-1)![2].includes("Quick jobs"));
  assert.ok(existsSync(tools!.folder));
});

test("a chat's quick job shows what it is doing while it answers", async () => {
  const { api, client } = taskApi(folder());
  Object.assign(settings, { chat_tools: true, workspace_root: join(folder(), "ws") });
  chatting(api);
  let working!: () => void;
  const isWorking = new Promise<void>((done) => (working = done));
  let goOn!: () => void;
  const mayGoOn = new Promise<void>((done) => (goOn = done));
  const heard: string[] = [];
  api.providers.converse = async (session: SupervisorSession, _prompt: string, options: ConverseOptions = {}) => {
    const log = options.tools!.log as supervisor.ChatActivity;
    log.starting("Bash", "curl -s wttr.in/Beijing");
    working();
    await mayGoOn;
    log.push({ turn: 1, tool: "Bash", detail: "curl -s wttr.in/Beijing", ok: true, output: "晴 5°C" });
    session.calls += 1;
    return new ProviderResult("北京：晴 5°C", 10, 10);
  };
  const chat = (await streaming.listener.run((text: string) => void heard.push(text),
    () => client.post("/api/chats", { json: { message: "北京天气？", model_id: "x:other" }, headers: ORIGIN }))).json();
  await isWorking;
  const shown = (await client.get(`/api/tasks/${chat.id}/lead/activity`)).json();
  assert.ok(shown.running && shown.calls[0].tool === "Bash" && shown.calls[0].running);
  // Whoever waits for the answer (an automation's card) is told what it is doing.
  assert.deepEqual(heard, ["（正在运行命令：curl -s wttr.in/Beijing）"]);
  goOn();
  await answered(api, chat.id);
  // Done: the running call was replaced by its result, and nothing is shown any more.
  assert.deepEqual((await client.get(`/api/tasks/${chat.id}/lead/activity`)).json(), { running: false, total: 0, calls: [] });
});
