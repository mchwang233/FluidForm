// supervisor.ts: its tests in test_supervisor, test_chat, test_chat_actions, test_capability_packages,
// test_engineer, test_folders, test_leading, test_memory and test_progress, ported.
import assert from "node:assert/strict";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import * as agent from "../src/agent.js";
import * as chatActions from "../src/chat-actions.js";
import { settings } from "../src/config.js";
import { ExecutionRunSchema, ModelProfileSchema, SupervisorSessionSchema, TaskNodeSchema } from "../src/models.js";
import { ProviderRegistry, ProviderResult } from "../src/providers.js";
import { eligibleForNode } from "../src/routing.js";
import * as prompts from "../packages/lead/src/prompts.js";
import * as supervisor from "../src/supervisor.js";
import { conftest } from "./helpers/conftest.js";
import * as pkg from "./helpers/chat-package.js";
import { registryWith } from "./helpers/providers.js";

const { folder: tmp } = conftest();
let folder: string;
beforeEach(() => {
  folder = tmp();
});

const model = (id: string, scores: Record<string, number>, channel = "api", display = id) => ModelProfileSchema.parse({ id, provider: id.split(":")[0],
  display_name: display, channel, context_window: 1_000_000, input_per_million: 1, output_per_million: 1, execution_priority: channel === "cli" ? 0 : 100, scores });
/** test_supervisor's model: ranked by planning. */
const planner = (id: string, planning: number, channel = "api") => model(id, { coding: 90, planning, reliability: 90 }, channel);
/** test_turns' model: ranked by coding. */
const coder = (id: string, coding: number, channel = "api") => model(id, { coding, planning: 80, reliability: 90 }, channel);
/** test_chat's profile. */
const profile = (id: string, planning: number) => ModelProfileSchema.parse({ ...planner(id, planning), provider: "x", display_name: id.toUpperCase() });
const BEST = profile("x:best", 95);
const chat = (fields: Record<string, unknown> = {}) => ExecutionRunSchema.parse({ id: "c", prompt: "p", kind: "chat", status: "draft", budget_usd: 1,
  plan: { summary: "s", nodes: [] }, ...fields });
const decision = (action: string, fields: Record<string, unknown> = {}) => JSON.stringify({ action, reason: `理由：${action}`, ...fields });

test("leads are CLI conversations first, then API models", async () => {
  const models = [planner("x:api", 99), planner("cli:claude", 90, "cli"), planner("cli:codex", 92, "cli"), planner("cli:gemini", 99, "cli"), planner("mock:local", 100)];
  assert.deepEqual(supervisor.candidates(models, new Set(models.map((m) => m.id))).map((m) => m.id), ["cli:codex", "cli:claude", "x:api"]);
});

test("an API lead is sent its conversation and kept within bounds", async () => {
  process.env.DEEPSEEK_API_KEY = "test";
  const sent: string[] = [];
  const registry = registryWith((request) => {
    sent.push(request.body.messages[0].content);
    return { choices: [{ message: { content: `回答${sent.length}` }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
  });
  const session = SupervisorSessionSchema.parse({ model_id: "deepseek:deepseek-flash" });
  await registry.converse(session, "规划");
  await registry.converse(session, "第一步通过了");
  assert.equal(sent[0], "规划");
  assert.ok(sent[1].includes("[USER]\n规划\n\n[ASSISTANT]\n回答1") && sent[1].endsWith("第一步通过了"));
  for (let i = 0; i < 2; i += 1) session.history.push({ role: "user", content: "x".repeat(200_000) }, { role: "assistant", content: "ok" });
  supervisor.trim(session);
  const history = session.history as { content: string }[];
  assert.ok(history[0].content === "规划" && history[2].content.startsWith("[Earlier events"));
  assert.ok(history.reduce((sum, item) => sum + item.content.length, 0) <= supervisor.MAX_HISTORY_CHARS + 200);
});

test("chats in chat apps are short and answered by API models first", async () => {
  const group = chat({ origin: { capability: "fake-bot", chat_type: "group" } });
  assert.ok((await pkg.chatGuide(group)).includes("two or three sentences"));
  const cli = ModelProfileSchema.parse({ ...BEST, id: "cli:codex", channel: "cli" });
  assert.deepEqual((await pkg.chatOrder(group, [cli, BEST])).map((m) => m.id), [BEST.id, "cli:codex"]);
  assert.deepEqual((await pkg.chatOrder(chat({ origin: {} }), [cli, BEST])).map((m) => m.id), ["cli:codex", BEST.id]);
});

test("an automation chat's lines for FluidForm are kept from the person", async () => {
  const text = '好，我让它排个计划。\nTASK: {"request": "做一张海边女孩的头像"}';
  assert.equal(pkg.forPerson(text), "好，我让它排个计划。");
  assert.equal(pkg.forPerson("好，我让它排个计划。\nTAS"), "好，我让它排个计划。\nTAS");
  assert.deepEqual(pkg.splitTask(text), ["好，我让它排个计划。", "做一张海边女孩的头像"]);
  assert.deepEqual(pkg.splitTask("没有任务"), ["没有任务", null]);
  // A TASK line that cannot be read asks for nothing.
  assert.deepEqual(pkg.splitTask('好\nTASK: {"request": '), ["好", null]);
  assert.deepEqual(pkg.splitTask('好\nTASK: {"request": "  "}'), ["好", null]);
  assert.deepEqual(pkg.splitSends("给你。\nSEND: `cat.png`\nSEND: 表格.xlsx"), ["给你。", ["cat.png", "表格.xlsx"]]);
  assert.deepEqual(pkg.splitSends("没有文件"), ["没有文件", []]);
  assert.equal(pkg.forPerson("给你。\nSEND: cat.png"), "给你。");
});

test("a chat has tools only when allowed, and answered by an API model", async () => {
  const feishu = chat({ origin: { capability: "feishu-bot" } });
  assert.equal((await supervisor.chatTools(feishu)), null); // off by default
  settings.chat_tools = true;
  assert.equal((await supervisor.chatTools(feishu))!.network, false);
  const cli = ModelProfileSchema.parse({ ...profile("cli:codex", 90), channel: "cli" });
  assert.equal((await pkg.chatToolsNote(feishu, cli)), "");
  const note = (await pkg.chatToolsNote(feishu, BEST));
  assert.ok(note.includes("TASK line") && note.includes("no internet"));
});

test("a running call is replaced by its result", async () => {
  const log = new supervisor.ChatActivity();
  log.starting("mcp__minimax__text_to_image", "海边的女孩");
  log.starting("Read", "a.txt");
  log.push({ turn: 1, tool: "mcp__minimax__text_to_image", detail: "海边的女孩", ok: true });
  assert.deepEqual(log.map((item) => [item.tool, item.running ?? false]), [["mcp__minimax__text_to_image", false], ["Read", true]]);
});

test("tool calls become the lines the answer is read by", async () => {
  const registry = new ProviderRegistry();
  const offered: string[][] = [];
  registry.complete = async () => {
    // What the loop does: offer the tools, run the calls the model makes in its workspace.
    offered.push((await chatActions.offered()).map((tool) => tool.name));
    const workspace = new agent.Workspace(folder);
    assert.ok((await workspace.run("StartTask", { request: "做一个记账网站\n要能导出" }))[1]);
    assert.ok(!(await workspace.run("StartTask", { request: "再来一个" }))[1]);
    assert.ok((await workspace.run("SendFile", { name: "avatar.png" }))[1]);
    return new ProviderResult("好的，我来安排。", 1, 1);
  };
  const session = SupervisorSessionSchema.parse({ model_id: "x:best", cwd: folder });
  const result = await registry.converse(session, "帮我做个网站", { tools: { folder, network: false, turns: 5, seconds: 5, actions: ["StartTask", "SendFile"] } });
  assert.deepEqual(offered, [["StartTask", "SendFile"]]);
  const [text, request] = pkg.splitTask(result.text);
  assert.equal(request, "做一个记账网站\n要能导出");
  assert.deepEqual(pkg.splitSends(text), ["好的，我来安排。", ["avatar.png"]]);
  assert.equal(pkg.forPerson(result.text), "好的，我来安排。");
  // Outside that answer nothing is offered, and a call does nothing.
  assert.deepEqual(await chatActions.offered(), []);
  assert.ok(!(await new agent.Workspace(folder).run("StartTask", { request: "x" }))[1]);
});

test("an engineer call reads as its line", async () => {
  const lines: string[] = [];
  await chatActions.pending.run([lines, new Set(["CallEngineer"])], async () => {
    assert.ok((await chatActions.run("CallEngineer", { kind: "anything", request: "飞书收不到图片" }))[1]);
    assert.ok(!(await chatActions.run("SendFile", { name: "a.png" }))[1]);
  });
  const [, call] = pkg.splitEngineer(chatActions.withActions("我请平台工程师来看看。", lines));
  assert.deepEqual(call, { kind: "repair", request: "飞书收不到图片" });
  assert.equal(JSON.parse(lines[0].split(/:(.*)/s)[1]).kind, "repair");
});

test("which chats get which tools", async () => {
  Object.assign(settings, { chat_tools: true });
  const web = chat();
  const feishu = chat({ origin: { capability: "feishu-bot" } });
  assert.deepEqual((await supervisor.chatTools(feishu))!.actions, []); // off by default
  settings.chat_action_tools = true;
  assert.deepEqual((await supervisor.chatTools(web))!.actions, ["CallEngineer"]);
  assert.deepEqual((await supervisor.chatTools(feishu))!.actions, ["StartTask", "SendFile", "CallEngineer"]);
  settings.user_memory = true;
  assert.deepEqual((await supervisor.chatTools(web))!.actions, ["CallEngineer", "Remember", "Forget"]);
});

test("a component request needs to say what to add", async () => {
  assert.ok(prompts.parseDecision('{"action": "request_component", "instructions": "加一个 PDF 工具"}', new Set()));
  assert.equal(prompts.parseDecision('{"action": "request_component"}', new Set()), null);
});

test("a call for the engineer is read from a chat answer and from a decision", async () => {
  const [text, call] = supervisor.splitEngineer("沙箱连不到宿主机的许可证端口，我请平台工程师来修。\n"
    + 'ENGINEER: {"kind": "repair", "request": "放行许可证端口 26585"}');
  assert.equal(text, "沙箱连不到宿主机的许可证端口，我请平台工程师来修。");
  assert.deepEqual(call, { kind: "repair", request: "放行许可证端口 26585" });
  assert.equal(supervisor.splitEngineer("没有要找平台工程师的事")[1], null);
  const made = prompts.parseDecision('{"action": "accept", "reason": "代码写好了", "engineer": {"kind": "component", "request": "加 EDA 许可证检查"}}', new Set());
  assert.deepEqual(made!.engineer, { kind: "component", request: "加 EDA 许可证检查" });
});

test("call_engineer and the old actions are read", async () => {
  assert.equal(prompts.parseDecision(decision("call_engineer", { kind: "component", instructions: "加一个飞书工具" }), new Set())!.kind, "component");
  assert.equal(prompts.parseDecision(decision("call_engineer", { instructions: "x" }), new Set())!.kind, "repair");
  // Old decisions, and leads answering the old way, still read.
  settings.engineer_repairs = true;
  assert.equal(prompts.parseDecision(decision("repair_environment", { instructions: "x" }), new Set())!.action, "repair_environment");
  // Off: the three actions as before, and no call_engineer offered.
  settings.engineer_repairs = false;
  const offered = prompts.decisionFormat();
  assert.ok(offered.includes("repair_environment") && !offered.includes("call_engineer"));
});

test("a lead works outside the platform's folder", async () => {
  settings.lead_root = null;
  process.env.XDG_CACHE_HOME = join(folder, "cache");
  const session = supervisor.newSession(coder("cli:codex", 95, "cli"));
  const leads = join(folder, "cache", "fluidform", "leads");
  assert.ok(session.cwd!.startsWith(leads) && /^\d{8}-\d{6}-lead-codex$/.test(session.cwd!.split("/").at(-1)!));
  assert.ok(!session.cwd!.startsWith(settings.data_dir));
});

test("helper-only models never run or lead a task", async () => {
  const helper = coder("glm:glm-5.3-flash", 95);
  const worker = coder("x:api", 80);
  const step = TaskNodeSchema.parse({ id: "n", title: "t", instructions: "i", capability: "coding" });
  const configured = new Set([helper.id, worker.id]);
  assert.deepEqual(eligibleForNode(step, [helper, worker], configured).map((m) => m.id), ["x:api"]);
  assert.deepEqual(supervisor.candidates([helper, worker], configured).map((m) => m.id), ["x:api"]);
});
