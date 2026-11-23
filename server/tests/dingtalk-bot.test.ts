// The shipped DingTalk adapter, installed like any other automation. No real app, keyring or network.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";
import * as packages from "../src/capability-packages.js";
import * as sandbox from "../src/capability-sandbox.js";
import { settings } from "../src/config.js";
import { CapabilitySchema } from "../src/models.js";
import { conftest } from "./helpers/conftest.js";
import { taskApi } from "./helpers/task-api.js";
import { triaging } from "./helpers/chatting.js";

const { folder } = conftest();
const execute = promisify(execFile);
const source = fileURLToPath(new URL("../packages/dingtalk-bot/", import.meta.url));
const saved = { ...sandbox.deps };
afterEach(() => Object.assign(sandbox.deps, saved));

test("DingTalk ships an installable automation with an offline check and scoped secrets", async () => {
  const manifest = JSON.parse(readFileSync(source + "capability.json", "utf8"));
  assert.equal(manifest.id, "dingtalk-bot");
  assert.equal(manifest.kind, "automation");
  assert.deepEqual(manifest.requires, ["chat"]);
  assert.deepEqual(manifest.secrets, ["DINGTALK_CLIENT_ID", "DINGTALK_CLIENT_SECRET"]);
  assert.deepEqual(manifest.domains, ["api.dingtalk.com", "oapi.dingtalk.com", "wss-open-connection.dingtalk.com"]);
  sandbox.deps.missing = () => "";
  sandbox.deps.run = async (where, _data, command, _timeout, options) => {
    assert.equal(options?.domains?.length ?? 0, 0, "installation checks must be offline");
    const { stdout } = await execute("/bin/sh", ["-c", command], { cwd: where, encoding: "utf8",
      env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" }, timeout: 20_000 });
    return [stdout, true];
  };
  const installed = await packages.installFolder(source);
  assert.equal(installed.check_ok, true, installed.check_output);
  assert.equal(installed.status, "disabled");
  assert.equal(installed.entry, "python3 -B bot.py");
});

test("DingTalk callbacks, replies, notifications and proxy transport pass without external services", async () => {
  const { stdout } = await execute("python3", ["-B", "check.py"], { cwd: source, encoding: "utf8",
    env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" }, timeout: 20_000 });
  assert.match(stdout, /DingTalk checks passed/);
});

// Only the DingTalk network is replaced. Actual adapter JSON lines go through Runner.ask,
// the chat/task API and back through the adapter's real reply/notification routing.
const FAKE_NETWORK = String.raw`
import json, sys
sys.path.insert(0, sys.argv[1])
from bot import Bridge, DingTalk
def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)
def request(url, body, headers=None):
    if url.endswith('/accessToken'):
        return {'accessToken': 'test-token', 'expireIn': 7200}
    emit({'delivered': {'url': url, 'body': body}})
    return {'processQueryKey': 'accepted'}
client = DingTalk('test-client', 'test-secret', request)
bridge = Bridge(emit, client.send)
for line in sys.stdin:
    event = json.loads(line)
    if 'incoming' in event:
        bridge.receive(event['incoming'])
    else:
        bridge.reply(event)
`;

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "DingTalk round trip timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("DingTalk round trip keeps chats, resets and stops, enforces task requester and returns the result", async () => {
  const { api } = taskApi(folder());
  settings.capability_packages = true;
  const capability = CapabilitySchema.parse(JSON.parse(readFileSync(source + "capability.json", "utf8")));
  const runner = api.automations.runner;
  const item = runner.get(capability.id);
  const [sent] = triaging(api, '{"kind":"chat"}', ["第一条回答", "第二条回答", "好，排计划。\nTASK: {\"request\":\"给商品接口加缓存\"}", "重新聊"]);
  // Confirm the task through the real API, but do not dispatch a real step in this test.
  const started: string[] = [];
  api.executor.start = (id: string) => { started.push(id); };
  const child = spawn("python3", ["-B", "-c", FAKE_NETWORK, source], {
    env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"] });
  item.process = child;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const delivered: any[] = [];
  const received: any[] = [];
  const failures: unknown[] = [];
  const pending = new Set<Promise<void>>();
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  child.on("error", (error) => failures.push(error));
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    if (value.delivered) delivered.push(value.delivered);
    if (value.op === "message") {
      received.push(value);
      const call = runner.ask(item, capability, value).catch((error) => { failures.push(error); });
      pending.add(call);
      void call.finally(() => pending.delete(call));
    }
  });
  let number = 0;
  const ask = async (text: string, sender = "person") => {
    const before = delivered.length;
    child.stdin.write(JSON.stringify({ incoming: { conversationId: "group", conversationType: "2", msgId: String(++number),
      senderStaffId: sender, senderNick: sender === "person" ? "小林" : "小陈", chatbotCorpId: "corp", isInAtList: true,
      msgtype: "text", text: { content: text } } }) + "\n");
    await eventually(() => failures.length > 0 || delivered.length > before);
    assert.deepEqual(failures, []);
    return JSON.parse(delivered.at(-1).body.msgParam).content as string;
  };
  try {
    assert.equal(await ask("你好"), "第一条回答");
    const conversation = received[0].conversation;
    const firstChat = item.state.chats[conversation];
    assert.equal(await ask("继续"), "第二条回答");
    assert.equal(item.state.chats[conversation], firstChat);
    assert.ok(sent[1][2].includes("第一条回答"));
    assert.match(await ask("给商品接口加缓存"), /开始/);
    const task = api.db.listRuns().find((run) => run.kind === "task")!;
    assert.equal(task.status, "awaiting_confirmation");
    assert.equal(task.origin?.requester, "person");
    assert.match(await ask("开始", "other"), /小林/);
    assert.equal(api.db.getRun(task.id)!.status, "awaiting_confirmation");
    assert.equal(started.length, 0);
    assert.match(await ask("开始"), /开工/);
    assert.deepEqual(started, [task.id]);
    const finished = api.db.getRun(task.id)!;
    finished.status = "succeeded";
    finished.final_result = "缓存已完成";
    api.db.saveRun(finished);
    const before = delivered.length;
    api.automations.taskEnded(task.id, "run.succeeded");
    await eventually(() => delivered.length > before);
    assert.match(JSON.parse(delivered.at(-1).body.msgParam).content, /缓存已完成/);
    assert.equal(delivered.at(-1).body.openConversationId, "group");
    await ask("/new");
    assert.equal(item.state.chats[conversation], undefined);
    assert.equal(await ask("重新聊"), "重新聊");
    assert.notEqual(item.state.chats[conversation], firstChat);
    const calls = sent.length;
    assert.match(await ask("/stop"), /停|没有/);
    assert.equal(sent.length, calls, "stop does not call a model");
    assert.ok(delivered.every((value) => value.url.endsWith("/robot/groupMessages/send")));
    assert.ok(!JSON.stringify(api.db.listRuns()).includes("test-secret"));
    assert.equal(stderr, "");
  } finally {
    await Promise.allSettled(pending);
    child.stdin.end();
    child.kill();
    await closed;
    item.process = null;
    lines.close();
  }
});
