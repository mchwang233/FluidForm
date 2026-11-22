// What a chat's API model is sent, each turn (docs/design/chat-context.md): asserted on the request
// itself, through the real provider adapters.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as files from "../src/attachments.js";
import { settings } from "../src/config.js";
import { Database } from "../src/db.js";
import { Executor } from "../src/executor.js";
import { ExecutionRunSchema, LeadMessageSchema, ModelProfileSchema } from "../src/models.js";
// @ts-expect-error: the package is plain JavaScript, with no types
import * as pkg from "../packages/chat/chat.mjs";
import { deepseek, isolated, registryWith } from "./helpers/providers.js";

const { folder } = isolated();
const ID = "deepseek:deepseek-flash";
const said = (role: string, text: string, fields: Record<string, unknown> = {}) => LeadMessageSchema.parse({ role, text, ...fields });

/** The bodies sent for ``text`` asked in a chat that went as ``messages``. */
async function asked(messages: any[], text: string, { attachments = [] as any[], supervisor = {} as any, origin = { capability: "bot", chat_type: "p2p" } as any,
  summary = null as any, replies = ["好"] } = {}) {
  process.env.DEEPSEEK_API_KEY = "test";
  Object.assign(settings, { chat_tools: true, workspace_root: join(folder(), "workspaces") });
  const model = ModelProfileSchema.parse({ id: ID, provider: "deepseek", display_name: "Flash", context_window: 128000,
    scores: { coding: 80, planning: 80, reliability: 80 } });
  const sent: any[] = [];
  const registry = registryWith(replies.map((reply) => deepseek({ content: reply }, "stop")), sent);
  Object.assign(registry.models, { [ID]: model });
  const db = new Database(join(folder(), `chat-${Math.random()}.db`));
  db.saveRun(ExecutionRunSchema.parse({ id: "c", prompt: "你好", kind: "chat", status: "draft", budget_usd: 1, origin, attachments,
    ...(summary ? { chat_summary: summary } : {}), supervisor: { model_id: ID, cwd: join(folder(), "lead"), ...supervisor },
    plan: { summary: "聊天", nodes: [] }, lead_messages: messages }));
  const executor = new Executor(db, registry as any, { [ID]: model });
  executor.startLeadChat("c", text);
  await executor.leadTasks.get("c")!.settled();
  await executor.chatSummaries.get("c")?.settled();
  return { sent, run: db.getRun("c")!, body: sent[0].messages as { role: string; content: string }[] };
}

test("a chat is sent as a system prompt and real turns, not one text of labelled turns", async () => {
  const { body, run } = await asked([said("user", "北京的简介"), said("lead", "北京是首都。")], "历史呢");
  assert.deepEqual(body.map((item) => item.role), ["system", "user", "assistant", "user"]);
  assert.equal(body[1].content, "北京的简介");
  assert.equal(body[2].content, "北京是首都。");
  assert.ok(body[3].content.endsWith("历史呢") && !body[3].content.includes("[USER]"));
  // Its own system prompt, not a coding agent's.
  assert.ok(body[0].content.includes("How to talk") || body[0].content.includes("private chat"));
  assert.ok(!body[0].content.includes("run the tests") && !body[0].content.includes("nothing is planned or run"));
  assert.ok(body[0].content.includes("TASK:"));
  assert.equal(run.supervisor!.history.length, 0);
});

test("what an older version kept as sent is not sent again", async () => {
  const { body, run } = await asked([said("user", "你好"), said("lead", "在的")], "hello", { supervisor: { calls: 9,
    history: [{ role: "user", content: "旧人设 ".repeat(40000) + "我是只读模式" }, { role: "assistant", content: "在的" }] } });
  const all = JSON.stringify(body);
  assert.ok(!all.includes("旧人设") && !all.includes("我是只读模式") && all.length < 20000);
  assert.ok(run.supervisor!.history[0].content.includes("我是只读模式")); // still there to be read
});

test("an attachment is given in full with its message, later only by name, where it can be read", async () => {
  settings.data_dir = join(folder(), "data");
  const log = files.save("rt_shell.log", Buffer.from("LOADING pkgIndex\n".repeat(3000)));
  const now = await asked([], "看看这个日志", { attachments: [log] });
  assert.ok(now.body.at(-1)!.content.includes("LOADING pkgIndex"));
  const later = await asked([said("user", "看看这个日志", { attachments: [log] }), said("lead", "是启动日志")], "hello", { attachments: [log],
    supervisor: { calls: 1 } });
  const all = JSON.stringify(later.body);
  assert.ok(!all.includes("LOADING pkgIndex") && all.includes("rt_shell.log"));
  const path = /attachments\/[\w.-]*rt_shell\.log/.exec(all)![0];
  const copy = join(settings.workspace_root, "c", path);
  assert.ok(existsSync(copy) && readFileSync(copy, "utf8").startsWith("LOADING pkgIndex"));
});

test("the time is with the message, so what comes before it stays the same for the cache", async () => {
  const first = await asked([said("user", "一"), said("lead", "二")], "今天几号");
  const second = await asked([said("user", "一"), said("lead", "二")], "明天呢");
  assert.deepEqual(first.body.slice(0, 3), second.body.slice(0, 3));
  assert.match(first.body.at(-1)!.content, /20\d\d-\d\d-\d\d \d\d:\d\d/);
});

test("a long chat keeps its latest turns as said, and what came before as a summary", async () => {
  const turns = Array.from({ length: 80 }, (_, n) => [said("user", `问题${n} ${"问".repeat(300)}`), said("lead", `回答${n} ${"答".repeat(300)}`)]).flat();
  const { body, sent, run } = await asked(turns, "继续", { replies: ["好", "用户问了很多问题。"] });
  const text = JSON.stringify(body);
  assert.ok(text.includes("回答79") && !text.includes("问题0 ") && text.length < 60000);
  assert.equal(sent.length, 2); // the summary, after the answer
  assert.equal(run.chat_summary!.text, "用户问了很多问题。");
  const next = await asked(run.lead_messages, "再继续", { summary: run.chat_summary });
  assert.equal(next.body[0].role, "system");
  // What people said is never made a system prompt.
  assert.ok(next.body[1].content.includes("用户问了很多问题。") && !next.body[0].content.includes("用户问了很多问题。"));
  assert.ok(JSON.stringify(next.body).includes("回答79"));
});

test("a chat app's conversation starts afresh after two idle hours, at four each day, and when asked", () => {
  const at = (text: string) => Date.parse(`2026-11-${text}:00Z`) / 1000;
  const fresh = (last: string | null, now: string, text = "你好") => pkg.session({ last_at: last && at(last), now: at(now), utc_offset: 0, text });
  assert.equal(fresh(null, "22T10:00").fresh, false);
  assert.equal(fresh("22T09:00", "22T10:30").fresh, false);
  assert.equal(fresh("22T09:00", "22T11:01").fresh, true);
  assert.equal(fresh("22T03:30", "22T04:10").fresh, true);
  assert.equal(fresh("22T04:10", "22T05:00").fresh, false);
  for (const word of ["/new", "/reset", "新对话"]) {
    const found = fresh("22T10:00", "22T10:01", word);
    assert.ok(found.fresh && found.reply);
  }
  assert.equal(fresh("22T10:00", "22T10:01", "新对话怎么开").fresh, false);
});

test("a chat's tool call runs, shown as it goes", async () => {
  // Regression: since the switch to TS every tool call of a chat failed (the method lost its object).
  process.env.DEEPSEEK_API_KEY = "test";
  Object.assign(settings, { chat_tools: true, chat_action_tools: true, workspace_root: join(folder(), "workspaces") });
  const call = { id: "c1", type: "function", function: { name: "StartTask", arguments: JSON.stringify({ request: "写一个贪吃蛇小游戏" }) } };
  const sent: any[] = [];
  const registry = registryWith([deepseek({ content: "", tool_calls: [call] }, "tool_calls"), deepseek({ content: "我去排计划。" }, "stop")], sent);
  const model = ModelProfileSchema.parse({ id: ID, provider: "deepseek", display_name: "Flash", context_window: 128000,
    scores: { coding: 80, planning: 80, reliability: 80 } });
  Object.assign(registry.models, { [ID]: model });
  const db = new Database(join(folder(), "tool.db"));
  db.saveRun(ExecutionRunSchema.parse({ id: "c", prompt: "你好", kind: "chat", status: "draft", budget_usd: 1, origin: { capability: "bot" },
    supervisor: { model_id: ID, cwd: join(folder(), "lead") }, plan: { summary: "聊天", nodes: [] } }));
  const executor = new Executor(db, registry as any, { [ID]: model });
  executor.startLeadChat("c", "帮我写一个贪吃蛇");
  await executor.leadTasks.get("c")!.settled();
  const answer = db.getRun("c")!.lead_messages.at(-1)!;
  assert.equal(answer.status, "done", answer.text);
  assert.ok(answer.text.includes("我去排计划。") && answer.text.includes("TASK:"));
  assert.equal(sent.length, 2);
});
