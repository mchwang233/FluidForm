// The chat package (server/packages/chat) as FluidForm runs it: shipped, installed and enabled at the
// first start, answering over JSON-RPC in the capabilities' sandbox, keeping what it remembers in its
// own data folder; and FluidForm without it (docs/design/chat-and-pricing-packages.md).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import * as bundled from "../src/bundled.js";
import * as capabilities from "../src/capabilities.js";
import * as packages from "../src/capability-packages.js";
import * as sandbox from "../src/capability-sandbox.js";
import * as chat from "../src/chat.js";
import { settings } from "../src/config.js";
import { LeadMessageSchema } from "../src/models.js";
import * as secrets from "../src/secrets.js";
import * as services from "../src/services.js";
import { withoutChat } from "./helpers/chat.js";
import { CHAT_ROLE } from "./helpers/chat-package.js";
import { answered, chatting, triaging } from "./helpers/chatting.js";
import { conftest } from "./helpers/conftest.js";
import { type Client, taskApi } from "./helpers/task-api.js";

const { folder } = conftest();
const ORIGIN = { origin: "http://localhost:5173" };
const saved = { sandbox: { ...sandbox.deps }, chat: { ...chat.deps }, runWorker: secrets.deps.runWorker };
const hosts: services.ServiceHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stopAll();
  Object.assign(sandbox.deps, saved.sandbox);
  Object.assign(chat.deps, saved.chat);
  secrets.deps.runWorker = saved.runWorker;
});

/** The API with the shipped packages offered, run without bwrap; chats asked of the real service. */
async function shipped(): Promise<{ api: ReturnType<typeof taskApi>["api"]; client: Client }> {
  const given = taskApi(folder());
  settings.capability_packages = true;
  sandbox.deps.missing = () => "";
  sandbox.deps.wrap = (where, _data, command, env) => ["env", "-i", ...Object.entries({ ...env, PATH: `${env.PATH}:${process.env.PATH}` })
    .map(([name, value]) => `${name}=${value}`), "/bin/bash", "-c", `cd '${where}' && ${command}`];
  secrets.deps.runWorker = async () => ({ code: 0, stdout: '{"value": null}', timedOut: false });
  hosts.push(given.api.services);
  chat.deps.enabled = () => services.available("chat");
  chat.deps.ask = (method, params) => given.api.services.request("chat", method, params);
  for (const item of await bundled.offer()) given.api.services.start(item);
  return given;
}

test("the chat package ships enabled, and a chat is held through it, in its sandbox", async () => {
  // What FluidForm remembered before the package: carried into the package's own folder.
  mkdirSync(settings.data_dir, { recursive: true });
  writeFileSync(join(settings.data_dir, "memory.json"), JSON.stringify({ web: ["用户: 喜欢简短"] }));
  settings.user_memory = true;
  const { api, client } = await shipped();
  const installed = capabilities.load("chat")!;
  assert.deepEqual([installed.kind, installed.status, installed.provides], ["service", "active", ["chat"]]);
  assert.ok(!existsSync(join(settings.data_dir, "memory.json")));
  const sent = chatting(api, ["好。\nREMEMBER: 用户: 写代码用 TypeScript"]);
  const created = await client.post("/api/chats", { json: { message: "你好" }, headers: ORIGIN });
  assert.equal(created.status_code, 201, created.text);
  await answered(api, created.json().id);
  // Told its role and what it remembers, by the package; the line it wrote is kept from the user.
  assert.ok(sent[0][2].startsWith(CHAT_ROLE) && sent[0][2].includes("用户: 喜欢简短") && sent[0][2].endsWith("你好"));
  assert.equal(api.db.getRun(created.json().id)!.lead_messages.at(-1)!.text, "好。");
  const kept = JSON.parse(readFileSync(join(packages.dataFolder("chat"), "memory.json"), "utf8"));
  assert.deepEqual(kept, { web: ["用户: 喜欢简短", "用户: 写代码用 TypeScript"] });
  assert.deepEqual((await client.get("/api/memory")).json().places.map((item: any) => item.facts), [kept.web]);
});

test("without the chat package nothing is chatted, and old chats can still be read", async () => {
  const { api, client } = taskApi(folder());
  const sent = chatting(api, ["好的。"]);
  const old = (await client.post("/api/chats", { json: { message: "你好" }, headers: ORIGIN })).json();
  await answered(api, old.id);
  const restore = withoutChat();
  try {
    for (const response of [await client.post("/api/chats", { json: { message: "在吗" }, headers: ORIGIN }),
      await client.post(`/api/tasks/${old.id}/lead`, { json: { message: "还在吗" }, headers: ORIGIN }),
      await client.post(`/api/tasks/${old.id}/promote`, { json: { prompt: "把它做成网站" }, headers: ORIGIN })]) {
      assert.ok(response.status_code === 409 && response.json().detail.includes("没有启用聊天能力"), response.text);
    }
    assert.deepEqual((await client.get("/api/chats/models")).json(), []);
    assert.equal((await client.get(`/api/tasks/${old.id}`)).json().lead_messages.at(-1).text, "好的。");
    assert.equal((await client.get("/api/memory")).json().available, false);
    assert.equal(sent.length, 1);
  } finally {
    restore();
  }
});

test("without the chat package, what is typed on the start page is a task", async () => {
  const { api, client } = taskApi(folder());
  const [, classified] = triaging(api, '{"kind": "chat"}');
  const restore = withoutChat();
  try {
    const started = await client.post("/api/start", { json: { prompt: "WAL 是什么？" }, headers: ORIGIN });
    assert.equal(started.status_code, 201, started.text);
    assert.equal(started.json().kind, "task");
    assert.equal(classified.length, 0); // nothing asked whether it is a chat
  } finally {
    restore();
  }
});

test("the package answers what FluidForm asks, whatever the order", async () => {
  // A chat's earlier messages, as a new conversation is told them.
  const run = { lead_messages: [LeadMessageSchema.parse({ role: "user", text: "一" }), LeadMessageSchema.parse({ role: "lead", text: "二" })] };
  assert.equal(await chat.transcript(run as any), "用户：一\n\n助手：二");
});
