// Automation packages through the API: installed, enabled with their secrets, run, answering in their
// conversations, planning work and hearing how it ended (test_capability_packages.py, the tests that
// need the API).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import * as files from "../src/attachments.js";
import { BudgetExceeded, ProviderError } from "../src/budget.js";
import * as pricing from "../src/pricing.js";
import * as capabilities from "../src/capabilities.js";
import * as packages from "../src/capability-packages.js";
import * as runners from "../src/capability-runner.js";
import * as sandbox from "../src/capability-sandbox.js";
import { settings } from "../src/config.js";
import { type Capability, folderId, LeadMessageSchema, type SupervisorSession } from "../src/models.js";
import { ProviderResult } from "../src/providers.js";
import { remembering } from "./helpers/chat-package.js";
import * as secrets from "../src/secrets.js";
import * as streaming from "../src/streaming.js";
import { CHAT_ROLE, chatGuide, MAX_CHAT_HANDOVER_CHARS } from "./helpers/chat-package.js";
import { type Api, BEST, OTHER, type Sent, triaging } from "./helpers/chatting.js";
import { conftest } from "./helpers/conftest.js";
import { type Client, taskApi } from "./helpers/task-api.js";
import { type Entry, zipOf } from "./helpers/zip-writer.js";

const { folder } = conftest();
const ORIGIN = { origin: "http://localhost:5173" };
const PNG = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(32)]);
const b64 = (data: Buffer) => data.toString("base64");
const saved = { sandbox: { ...sandbox.deps }, limits: { ...runners.limits }, runWorker: secrets.deps.runWorker };
const running: runners.Runner[] = [];
afterEach(async () => {
  for (const runner of running.splice(0)) await runner.stopAll();
  Object.assign(sandbox.deps, saved.sandbox);
  Object.assign(runners.limits, saved.limits);
  secrets.deps.runWorker = saved.runWorker;
  secrets.sessionSecrets.clear();
});

const ASK_FOR_WORK = '好，我让 FluidForm 排个计划。\nTASK: {"request": "给商品接口加 Redis 缓存：缓存商品详情 5 分钟，改价时清掉"}';
const FAKE = String.raw`
import base64, json, os, sys
data = os.environ["SP_DATA_DIR"]
def note(name, value):
    with open(os.path.join(data, name), "a") as out:
        out.write(json.dumps(value, ensure_ascii=False) + "\n")
note("env.jsonl", {"token": os.environ.get("TOKEN"), "proxy": os.environ.get("HTTPS_PROXY")})
print(json.dumps({"op": "status", "text": "就绪"}), flush=True)
print("plain output goes to the log", flush=True)
asks = json.load(open("asks.json"))
for n, ask in enumerate(asks):
    # Files sent along: written to its data folder, then named in the message (as feishu-bot does).
    for name, content in ask.get("files", {}).items():
        os.makedirs(os.path.dirname(os.path.join(data, name)), exist_ok=True)
        with open(os.path.join(data, name), "wb") as out:
            out.write(base64.b64decode(content))
    message = {"op": "message", "id": str(n), "conversation": ask["conversation"], "text": ask["text"],
               "origin": {"message_id": "om_%d" % n}}
    if "files" in ask or "refs" in ask:
        message["attachments"] = list(ask.get("files", {})) + ask.get("refs", [])
    for key in ("addressed", "sender"):
        if key in ask:
            message[key] = ask[key]
    print(json.dumps(message), flush=True)
    while True:
        heard = json.loads(sys.stdin.readline())
        if heard.get("re") == str(n):
            note("replies.jsonl", heard)
            break
        note("events.jsonl", heard)
for line in sys.stdin:
    note("events.jsonl", json.loads(line))
`;

type Ask = { conversation: string; text: string; files?: Record<string, string>; refs?: string[]; addressed?: boolean; sender?: string };

/** A package zip; ``extra`` adds more entries. */
function pkg(asks: Ask[] = [], { manifest = {}, extra = [], top = "pkg/" }: { manifest?: Record<string, unknown>; extra?: Entry[]; top?: string } = {}): Buffer {
  const body = { id: "fake-bot", name: "假机器人", kind: "automation", version: "1.0", summary: "测试用", entry: "python3 fake.py", secrets: ["TOKEN"],
    domains: ["*.example.com"], ...manifest };
  return zipOf([{ name: top + "capability.json", data: JSON.stringify(body) }, { name: top + "fake.py", data: FAKE },
    { name: top + "asks.json", data: JSON.stringify(asks) }, ...extra]);
}

/** The keyring, in memory: the real one is never read or written in a test. */
function keyring(): Map<string, string> {
  const kept = new Map<string, string>();
  secrets.deps.runWorker = async (args, input) => {
    const { provider, value } = JSON.parse(input);
    if (args[0] === "set") kept.set(provider, value);
    else if (args[0] === "delete") kept.delete(provider);
    return { code: 0, stdout: JSON.stringify({ value: null }), timedOut: false };
  };
  return kept;
}

/** The API with packages allowed, run without bwrap (tests never need it), with the environment the
 *  sandbox gives; and its runner, stopped after the test. */
function withPackages(): { api: Api; client: Client; runner: runners.Runner; kept: Map<string, string> } {
  const { api, client } = taskApi(folder());
  settings.capability_packages = true;
  sandbox.deps.missing = () => "";
  sandbox.deps.wrap = (where, _data, command, env) => ["env", "-i", ...Object.entries({ ...env, PATH: process.env.PATH! }).map(([name, value]) => `${name}=${value}`),
    "/bin/bash", "-c", `cd '${where}' && ${command}`];
  const kept = keyring();
  const runner = api.automations.runner;
  running.push(runner);
  api.executor.endListeners.push((runId, kind) => api.automations.taskEnded(runId, kind));
  return { api, client, runner, kept };
}

/** Real routing and chat lifecycle, with fake API and membership conversations. */
async function modelBot() {
  const given = withPackages();
  const [sent, classified] = triaging(given.api, '{"kind": "chat"}');
  given.api.models["cli:codex"] = { ...BEST, id: "cli:codex", display_name: "Codex CLI", channel: "cli" };
  await upload(given.client, pkg());
  return { ...given, sent, classified };
}

const upload = (client: Client, data: Buffer) => client.post("/api/capabilities/upload", { content: data, headers: ORIGIN });

async function enable(client: Client, values: Record<string, string> = { TOKEN: "t0ken-value" }) {
  await client.put("/api/capabilities/fake-bot/secrets", { json: { values }, headers: ORIGIN });
  return client.patch("/api/capabilities/fake-bot", { json: { enabled: true, confirmed: true }, headers: ORIGIN });
}

const chooseModel = (client: Client, modelId: string | null, capabilityId = "fake-bot") =>
  client.put(`/api/capabilities/${capabilityId}/model`, { json: { model_id: modelId }, headers: ORIGIN });

function lines(name: string, capabilityId = "fake-bot"): any[] {
  const path = join(packages.dataFolder(capabilityId), name);
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

async function eventually<T>(check: () => T, seconds = 10): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("timed out");
}

const ask = (fields: Partial<runners.Asked> & { conversation: string; text: string }) => runners.asked(fields);
const message = (api: Api, runner: runners.Runner, fields: Partial<runners.Asked> & { conversation: string; text: string }, capabilityId = "fake-bot") =>
  api.automations.message(capabilities.load(capabilityId)!, ask(fields), runner.get(capabilityId));
async function botMessage(api: Api, runner: runners.Runner, text: string, conversation = "c1"): Promise<[string | null, number]> {
  const [reply, cost] = await message(api, runner, { conversation, text });
  return [reply, cost];
}

// Oldest first.
const tasks = (api: Api) => api.db.listRuns().filter((run) => run.kind === "task").sort((a, b) => (a.created_at < b.created_at ? -1 : 1));

test("uploaded, it is installed switched off, and a new version keeps its secrets", async () => {
  const { client, kept } = withPackages();
  // Without the machine's setting nothing is uploaded.
  settings.capability_packages = false;
  assert.equal((await upload(client, pkg())).status_code, 409);
  settings.capability_packages = true;
  const response = await upload(client, pkg());
  assert.equal(response.status_code, 201, response.text);
  const item = response.json();
  assert.deepEqual([item.id, item.status, item.source, item.version], ["fake-bot", "disabled", "upload", "1.0"]);
  const where = join(capabilities.root(), "fake-bot");
  assert.ok(statSync(join(where, "fake.py")).isFile() && readFileSync(join(where, "SKILL.md"), "utf8").includes("假机器人"));
  // Enabling needs the user's confirmation, then its secrets.
  assert.equal((await client.patch("/api/capabilities/fake-bot", { json: { enabled: true }, headers: ORIGIN })).status_code, 409);
  const refused = await client.patch("/api/capabilities/fake-bot", { json: { enabled: true, confirmed: true }, headers: ORIGIN });
  assert.ok(refused.status_code === 409 && refused.json().detail.includes("TOKEN"));
  assert.equal((await client.put("/api/capabilities/fake-bot/secrets", { json: { values: { OTHER: "x" } }, headers: ORIGIN })).status_code, 422);
  await client.put("/api/capabilities/fake-bot/secrets", { json: { values: { TOKEN: "t0ken-value" } }, headers: ORIGIN });
  assert.deepEqual(Object.fromEntries(kept), { "capability/fake-bot/TOKEN": "t0ken-value" });
  // Never in a file, nor in FluidForm's environment.
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : entry.isFile() ? [join(dir, entry.name)] : []);
  assert.ok(!walk(settings.data_dir).some((path) => readFileSync(path, "latin1").includes("t0ken-value")));
  assert.ok(!Object.values(process.env).includes("t0ken-value"));
  // A new version replaces the code, keeps the secrets, and is off until enabled again.
  const second = await upload(client, pkg([], { manifest: { version: "2.0" } }));
  assert.equal(second.json().version, "2.0");
  assert.deepEqual(Object.fromEntries(kept), { "capability/fake-bot/TOKEN": "t0ken-value" });
  const runtime = (await client.get("/api/capabilities/runtime")).json();
  assert.ok(runtime.capabilities["fake-bot"].secrets.TOKEN === true && runtime.available === true);
});

test("uninstalled, it leaves nothing behind", async () => {
  const { api, client, runner, kept } = withPackages();
  await upload(client, pkg([{ conversation: "c1", text: "在吗" }]));
  triaging(api, '{"kind": "chat"}');
  assert.equal((await enable(client)).status_code, 200);
  await eventually(() => lines("replies.jsonl").length);
  assert.ok(statSync(runners.statePath("fake-bot")).isFile());
  assert.equal((await client.delete("/api/capabilities/fake-bot", { headers: ORIGIN })).status_code, 204);
  assert.ok(!runner.running("fake-bot") && !existsSync(join(capabilities.root(), "fake-bot")));
  assert.ok(!existsSync(packages.dataFolder("fake-bot")) && !existsSync(runners.statePath("fake-bot")));
  assert.ok(kept.size === 0 && capabilities.library().length === 0);
});

test("an image sent to an automation reaches its chat and leaves its data folder", async () => {
  const { api, client, runner } = withPackages();
  const [sent] = triaging(api, '{"kind": "chat"}');
  const outside = join(folder(), "outside.txt");
  writeFileSync(outside, "not its file");
  await upload(client, pkg([
    { conversation: "c1", text: "这张图里是什么？", files: { "img/shot.png": b64(PNG) }, refs: [outside, "../x"] },
    { conversation: "c1", text: "", files: { "img/only.png": b64(PNG) } }]));
  assert.equal((await enable(client)).status_code, 200);
  const replies = await eventually(() => lines("replies.jsonl").length === 2 && lines("replies.jsonl"));
  assert.ok(replies.every((item: any) => item.reply));
  // The images went to the model with the messages; nothing else did.
  assert.deepEqual(sent.attached, [["shot.png"], ["only.png"]]);
  const chat = api.db.getRun(runner.get("fake-bot").state.chats.c1)!;
  assert.deepEqual(chat.attachments.map((item) => item.name), ["shot.png", "only.png"]);
  assert.deepEqual(chat.lead_messages.filter((m) => m.role === "user").map((m) => m.text), ["这张图里是什么？", "（见附件）"]);
  // Taken out of its data folder; what was outside it stays, and is logged as refused.
  assert.deepEqual(readdirSync(join(packages.dataFolder("fake-bot"), "img")), []);
  assert.equal(readFileSync(outside, "utf8"), "not its file");
  const log = runner.get("fake-bot").log.join("\n");
  assert.ok(log.includes("outside.txt 没收下") && log.includes("../x 没收下"));
});

test("a picture sent alone is answered in the chat, not planned as work", async () => {
  // Regression: with no words, the classifier saw only "（见附件）" and planned a task.
  const { api, client } = withPackages();
  const [sent, classified] = triaging(api, '{"kind": "task"}');
  await upload(client, pkg([{ conversation: "c1", text: "", files: { "shot.png": b64(PNG) } }]));
  await enable(client);
  const [reply] = await eventually(() => lines("replies.jsonl").length && lines("replies.jsonl"));
  assert.ok(reply.reply === "好的。" && classified.length === 0);
  assert.equal(tasks(api).length, 0);
  assert.deepEqual(sent.attached, [["shot.png"]]);
});

test("an answer being written reaches the automation before it is done", async () => {
  const { api, client } = withPackages();
  triaging(api, '{"kind": "chat"}');
  runners.limits.PROGRESS_SECONDS = 0;
  api.providers.converse = async (session: SupervisorSession) => {
    const hear = streaming.listener.get()!;
    for (const text of ["**WAL**", "**WAL** 是预写日志。"]) {
      hear(text);
      await new Promise((done) => setTimeout(done, 50));
    }
    session.calls += 1;
    return new ProviderResult("**WAL** 是预写日志。", 10, 10);
  };
  await upload(client, pkg([{ conversation: "c1", text: "WAL 是什么？" }]));
  await enable(client);
  const [reply] = await eventually(() => lines("replies.jsonl").length && lines("replies.jsonl"));
  assert.equal(reply.reply, "**WAL** 是预写日志。");
  // Heard as it was written, before the answer itself.
  assert.deepEqual(lines("events.jsonl").filter((line) => "progress" in line), [{ progress: "0", text: "**WAL**" }, { progress: "0", text: "**WAL** 是预写日志。" }]);
  assert.equal(streaming.listener.get(), null);
});

/** The cheap model's answers: whether a group message is meant for it, else "a chat". */
function judging(api: Api, meant: (prompt: string) => boolean, judged: string[] = [], classified: string[] = []): void {
  api.providers.complete = async (_modelId: string, prompt: string) => {
    if (prompt.startsWith("You are 假机器人, an assistant in a group chat")) {
      judged.push(prompt);
      return new ProviderResult(meant(prompt) ? '{"reply": true}' : '{"reply": false}', 100, 5);
    }
    classified.push(prompt);
    return new ProviderResult('{"kind": "chat"}', 100, 5);
  };
}

test("in a group it answers only what is meant for it, knowing what was said before", async () => {
  const { api, client, runner } = withPackages();
  const [sent] = triaging(api, '{"kind": "chat"}');
  const judged: string[] = [];
  judging(api, (prompt) => prompt.split("New message:").at(-1)!.includes("助手"), judged);
  await upload(client, pkg([
    { conversation: "g1", text: "今天三点开会，记得带电脑", addressed: false, sender: "成员1" },
    { conversation: "g1", text: "好的", addressed: false, sender: "成员2" },
    { conversation: "g1", text: "助手，几点开会？", addressed: false, sender: "成员2" },
    { conversation: "g1", text: "谢谢", addressed: true }]));
  await enable(client);
  const replies = await eventually(() => lines("replies.jsonl").length === 4 && lines("replies.jsonl"));
  // Talk among members is not answered; what is meant for it is, and @ it always is.
  assert.deepEqual(replies.map((item: any) => item.reply), [null, null, "好的。", "嗯。"]);
  assert.ok(judged.length === 3 && judged[1].includes("成员1：今天三点开会"));
  // The model answering is told what the group said before.
  assert.ok(sent[0][2].includes("群里此前的消息") && sent[0][2].includes("成员1：今天三点开会，记得带电脑") && sent[0][2].includes("成员2：助手，几点开会？"));
  assert.ok(sent[1][2].endsWith("谢谢"));
  const state = runner.get("fake-bot").state;
  assert.ok(Object.keys(state.heard).length === 0 && Object.keys(state.spent).length);
});

test("a picture sent in a group without @ is seen when it is asked about", async () => {
  // Regression: a picture cannot @ the bot, and the question about it, asked next, came without it.
  const { api, client, runner } = withPackages();
  const [sent] = triaging(api, '{"kind": "chat"}');
  judging(api, () => false);
  await upload(client, pkg([
    { conversation: "g1", text: "", files: { "cat.png": b64(PNG) }, addressed: false, sender: "成员1" },
    { conversation: "g1", text: "这是什么猫？", sender: "成员1" }]));
  await enable(client);
  const replies = await eventually(() => lines("replies.jsonl").length === 2 && lines("replies.jsonl"));
  assert.deepEqual(replies.map((item: any) => item.reply), [null, "好的。"]);
  // The picture came with the question, and the model was told it was sent before.
  assert.deepEqual(sent.attached, [["cat.png"]]);
  assert.ok(sent[0][2].includes("成员1：（见附件）（附 1 张图片）") && !sent[0][2].includes("cat.png"));
  const automation = runner.get("fake-bot");
  assert.ok(Object.keys(automation.state.heard_files).length === 0 && automation.log.some((line) => line.includes("记作上下文")));
});

test("only @ it, and it answers what the group said before", async () => {
  // Regression: a message that only @-ed it was dropped, so it never answered.
  const { api, client } = withPackages();
  const [sent] = triaging(api, '{"kind": "task"}');
  const classified: string[] = [];
  judging(api, () => false, [], classified);
  await upload(client, pkg([
    { conversation: "g1", text: "周五团建去哪儿好？", addressed: false, sender: "成员1" },
    { conversation: "g1", text: "", sender: "成员2" }]));
  await enable(client);
  const replies = await eventually(() => lines("replies.jsonl").length === 2 && lines("replies.jsonl"));
  assert.deepEqual(replies.map((item: any) => item.reply), [null, "好的。"]);
  // Answered in the chat, never planned as work, knowing what the group asked.
  assert.ok(classified.length === 0 && tasks(api).length === 0);
  assert.ok(sent[0][2].includes("成员1：周五团建去哪儿好？") && sent[0][2].includes(runners.CALLED_ONLY));
});

test("its chats are told how to talk there, and whether it is a group", async () => {
  const { api, client, runner, sent } = await modelBot();
  const guide = "话没说完时，只回一句「嗯，你说」。";
  await upload(client, pkg([], { extra: [{ name: "pkg/CHAT.md", data: guide }] }));
  for (const [conversation, kind] of [["g1", "group"], ["p1", "p2p"]]) {
    await message(api, runner, { conversation, text: "我想问下", origin: { chat_type: kind } });
  }
  const [group, privately] = [sent.at(-2)![2], sent.at(-1)![2]];
  assert.ok(group.includes(guide) && group.includes("This is a group chat"));
  assert.ok(privately.includes(guide) && privately.includes("This is a private chat") && !privately.includes("group chat"));
  // A chat started before it said where it is learns it with its next message.
  const chat = api.db.getRun(runner.get("fake-bot").state.chats.g1)!;
  chat.origin = { capability: "fake-bot" };
  api.db.saveRun(chat);
  await message(api, runner, { conversation: "g1", text: "在吗", origin: { chat_type: "group" } });
  assert.deepEqual(api.db.getRun(chat.id)!.origin, { capability: "fake-bot", chat_type: "group", conversation: "g1" });
  // Chats it did not bring, and packages without the file, are told nothing of it.
  assert.ok(packages.chatGuide("other") === "" && packages.chatGuide("../x") === "");
});

test("a chat sends the pictures it made, and only from its own folder", async () => {
  const { api, client, runner } = withPackages();
  triaging(api, '{"kind": "chat"}');
  settings.chat_tools = true;
  const outside = join(folder(), "secret.txt");
  writeFileSync(outside, "not for them");
  const prompts: string[] = [];
  api.providers.converse = async (session: SupervisorSession, prompt: string, options: { tools?: { folder: string } | null; dialogue?: { system: string } | null } = {}) => {
    prompts.push(`${options.dialogue?.system ?? ""}\n\n${prompt}`);
    writeFileSync(join(options.tools!.folder, "cat.png"), PNG);
    session.calls += 1;
    return new ProviderResult(`画好了，给你。\nSEND: cat.png\nSEND: ${outside}\nSEND: ../x`, 10, 10);
  };
  await upload(client, pkg([{ conversation: "c1", text: "画一只猫给我" }]));
  await enable(client);
  const [reply] = await eventually(() => lines("replies.jsonl").length && lines("replies.jsonl"));
  // The answer, without its SEND lines, and the picture, in its data folder for it to send.
  assert.equal(reply.reply, "画好了，给你。\n\n（发了：cat.png）");
  const [path] = reply.files;
  assert.ok(path.startsWith("outbox/") && readFileSync(join(packages.dataFolder("fake-bot"), path)).equals(PNG));
  assert.ok(prompts[0].includes("SEND: <its name in your folder>"));
  // What is outside the chat's folder is not sent, and the log says so.
  const log = runner.get("fake-bot").log.join("\n");
  assert.ok(log.includes("secret.txt") && log.includes("没发出") && log.includes("../x"));
  const chat = api.db.getRun(runner.get("fake-bot").state.chats.c1)!;
  assert.equal(chat.lead_messages.at(-1)!.text, reply.reply);
});

test("work sent with an image is planned with it", async () => {
  const { api, client } = withPackages();
  triaging(api, '{"kind": "chat"}', ['好的。\nTASK: {"request": "照附件里的设计图改首页"}']);
  await upload(client, pkg([{ conversation: "c1", text: "照这张图改首页", files: { "design.png": b64(PNG) } }]));
  await enable(client);
  await eventually(() => lines("replies.jsonl").length);
  const [task] = tasks(api);
  assert.deepEqual(task.attachments.map((item) => item.name), ["design.png"]);
});

test("an image goes to a model that can see it when the chosen one cannot", async () => {
  const { api, client, runner, sent } = await modelBot();
  api.models[OTHER.id] = { ...api.models[OTHER.id], supports_vision: false };
  assert.equal((await chooseModel(client, OTHER.id)).status_code, 200);
  const image = files.save("shot.png", PNG);
  const [reply] = await message(api, runner, { conversation: "c1", text: "看看这个", attachments: [image] });
  assert.ok(sent.at(-1)![0] !== OTHER.id);
  assert.deepEqual(sent.attached.at(-1), ["shot.png"]);
  // The owner reads of the switch in the log; the people chatting are not told.
  assert.ok(!reply!.includes("本次由") && runner.get("fake-bot").log.some((line) => line.includes("本次由")));
  // While the picture is shown again, one that sees answers; without it, the chosen model is back.
  await botMessage(api, runner, "谢谢");
  assert.notEqual(sent.at(-1)![0], OTHER.id);
  await botMessage(api, runner, "/new");
  await botMessage(api, runner, "谢谢");
  assert.equal(sent.at(-1)![0], OTHER.id);
});

test("files outside its data folder, links and oversized ones are refused", () => {
  withPackages();
  const item = new runners.Automation("fake-bot");
  const data = packages.dataFolder("fake-bot");
  mkdirSync(join(data, "in"), { recursive: true });
  const secret = join(folder(), "secret.png");
  writeFileSync(secret, PNG);
  mkdirSync(join(folder(), "elsewhere"));
  writeFileSync(join(folder(), "elsewhere", "far.png"), PNG);
  writeFileSync(join(data, "in", "ok.png"), PNG);
  symlinkSync(secret, join(data, "in", "link.png"));
  symlinkSync(join(folder(), "elsewhere"), join(data, "dirlink"));
  writeFileSync(join(data, "in", "big.png"), Buffer.concat([PNG, Buffer.alloc(files.MAX_ATTACHMENT_BYTES)]));
  const taken = runners.takeFiles(item, "fake-bot", ["in/ok.png", "in/link.png", "dirlink/far.png", "in/big.png", secret, "in/none.png"]);
  assert.deepEqual(taken.map((attachment) => attachment.name), ["ok.png"]);
  assert.ok(readFileSync(files.path(taken[0])).equals(PNG));
  // Its own files are gone; nothing outside its folder was touched.
  assert.deepEqual(readdirSync(join(data, "in")), []);
  assert.ok(readFileSync(secret).equals(PNG) && existsSync(join(folder(), "elsewhere", "far.png")));
  assert.equal(item.log.filter((line) => line.includes("没收下")).length, 5);
  assert.deepEqual(runners.takeFiles(item, "fake-bot", "in/ok.png"), []);
});

test("an automation's model setting survives a reload and an upgrade, and is its own", async () => {
  const { api, client, runner } = await modelBot();
  await upload(client, pkg([], { manifest: { id: "other-bot" } }));
  // A host state from before model settings existed still loads, with its budget and chats.
  const path = runners.statePath("fake-bot");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ daily_budget_usd: 3, chats: { old: "old-chat" }, handled: 7 }));
  assert.equal(runner.get("fake-bot").public().model_id, null);
  const saved = await chooseModel(client, OTHER.id);
  assert.equal(saved.status_code, 200, saved.text);
  assert.equal(saved.json().model_id, OTHER.id);
  const runtime = (await client.get("/api/capabilities/runtime")).json().capabilities;
  assert.ok(runtime["fake-bot"].model_id === OTHER.id && runtime["other-bot"].model_id === null);
  await upload(client, pkg([], { manifest: { version: "2.0" } }));
  const reloaded = new runners.Runner((c, a, i) => api.automations.message(c, a, i)).get("fake-bot");
  assert.equal(reloaded.public().model_id, OTHER.id);
  assert.deepEqual(reloaded.state.chats, { old: "old-chat" });
  assert.ok(reloaded.public().handled === 7); // an older version's state, its limit included, still loads
  assert.equal((await chooseModel(client, null)).json().model_id, null);
  assert.equal(new runners.Automation("fake-bot").public().model_id, null);
});

for (const unavailable of ["unknown", "disabled", "unconfigured", "unscored", "helper", "no_session"]) {
  test(`an automation's model setting refuses an unusable model (${unavailable}) and keeps the saved choice`, async () => {
    const { api, client, runner } = await modelBot();
    assert.equal((await chooseModel(client, OTHER.id)).status_code, 200);
    const model = { ...BEST, id: "x:invalid" };
    if (unavailable === "disabled") model.enabled = false;
    else if (unavailable === "unscored") model.scores = null;
    else if (unavailable === "helper") settings.helper_only_models = [model.id];
    else if (unavailable === "no_session") Object.assign(model, { id: "cli:no-session", channel: "cli" });
    if (unavailable !== "unknown") api.models[model.id] = model;
    if (unavailable === "unconfigured") api.providers.configuredModels = () => new Set(Object.keys(api.models).filter((id) => id !== model.id));
    const response = await chooseModel(client, model.id);
    assert.ok(response.status_code === 422 && response.json().detail.includes("模型"));
    assert.equal(runner.get("fake-bot").public().model_id, OTHER.id);
    assert.equal(new runners.Automation("fake-bot").public().model_id, OTHER.id);
  });
}

test("an automation's model setting needs an uploaded automation", async () => {
  const { client, runner } = await modelBot();
  assert.equal((await chooseModel(client, OTHER.id, "missing")).status_code, 404);
  await upload(client, pkg([], { manifest: { id: "tool", kind: "tool", entry: "" } }));
  assert.equal((await chooseModel(client, OTHER.id, "tool")).status_code, 422);
  const capability = capabilities.load("fake-bot")!;
  capability.source = "task";
  capabilities.save(capability);
  assert.equal((await chooseModel(client, OTHER.id)).status_code, 422);
  assert.equal(runner.automations.size, 0);
});

for (const modelId of [OTHER.id, "cli:codex"]) {
  test(`an automation uses the selected model (${modelId}), and deciding stays apart`, async () => {
    const { api, client, runner, sent, classified } = await modelBot();
    assert.equal((await chooseModel(client, modelId)).status_code, 200);
    const [first, cost] = await botMessage(api, runner, "WAL 是什么？");
    const [second] = await botMessage(api, runner, "检查点呢？");
    assert.deepEqual(sent.map((item) => item[0]), [modelId, modelId]);
    assert.ok(first === "好的。" && second === "嗯。" && cost > 0);
    assert.equal(classified.length, 0); // every message goes to the chat; its model asks for work itself
    assert.ok(sent[0][2].startsWith(CHAT_ROLE) && sent[1][2].endsWith("检查点呢？"));
    const chat = api.db.getRun(runner.get("fake-bot").state.chats.c1)!;
    assert.ok(chat.kind === "chat" && chat.plan.nodes.length === 0 && chat.supervisor!.model_id === modelId);
  });
}

for (const [firstModel, nextModel] of [[OTHER.id, "cli:codex"], ["cli:codex", OTHER.id]]) {
  test(`switching an automation's model (${firstModel} to ${nextModel}) waits for the reply and hands the context on`, async () => {
    const { api, client, runner } = await modelBot();
    assert.equal((await chooseModel(client, firstModel)).status_code, 200);
    let entered!: () => void;
    const isEntered = new Promise<void>((done) => (entered = done));
    let release!: () => void;
    const released = new Promise<void>((done) => (release = done));
    const calls: [SupervisorSession, string][] = [];
    api.providers.converse = async (session: SupervisorSession, asked: string, options: any = {}) => {
      // An API model is told the rules and what was said each turn; a membership CLI only once.
      const prompt = options.dialogue ? [options.dialogue.system, ...options.dialogue.messages.map((item: any) => item.content), asked].join("\n\n") : asked;
      calls.push([structuredClone(session), prompt]);
      if (calls.length === 1) {
        entered();
        await released;
      }
      const answer = calls.length === 1 ? "记住了，项目名是海棠。" : "接着聊海棠。";
      session.calls += 1;
      session.session_id = `native-${session.model_id}`;
      session.history.push({ role: "user", content: prompt }, { role: "assistant", content: answer });
      return new ProviderResult(answer, 10, 10);
    };
    const first = botMessage(api, runner, "项目名是海棠，请记住。");
    let second: Promise<unknown> | null = null;
    let done = [false, false];
    void first.then(() => (done[0] = true));
    try {
      await isEntered;
      // The next message is already queued when the owner saves a different model.
      second = botMessage(api, runner, "它叫什么？");
      void second.then(() => (done[1] = true));
      await new Promise((resolve) => setImmediate(resolve));
      const saved = await chooseModel(client, nextModel);
      assert.equal(saved.status_code, 200);
      const runId = runner.get("fake-bot").state.chats.c1;
      assert.equal(api.db.getRun(runId)!.supervisor!.model_id, firstModel);
      assert.ok(calls.length === 1 && !done[0] && !done[1]);
    } finally {
      release();
      await Promise.all([first, second]);
    }
    assert.equal((await first)[0], "记住了，项目名是海棠。");
    const [session, prompt] = calls[1];
    assert.ok(session.model_id === nextModel && session.session_id === null && session.calls === 0 && session.history.length === 0);
    assert.deepEqual(session.previous, [firstModel]);
    assert.ok(prompt.startsWith(CHAT_ROLE) && prompt.includes("项目名是海棠，请记住。"));
    assert.ok(prompt.includes("记住了，项目名是海棠。") && prompt.includes("它叫什么？"));
    await botMessage(api, runner, "再确认一次。");
    assert.ok(calls[2][0].session_id === `native-${nextModel}` && calls[2][1].endsWith("再确认一次。"));
    if (nextModel.startsWith("cli:")) assert.equal(calls[2][1], "再确认一次。");
    done = [true, true];
  });
}

test("restoring automatic after a reload switches existing chats, with bounded history", async () => {
  const { api, client, runner, sent } = await modelBot();
  assert.equal((await chooseModel(client, OTHER.id)).status_code, 200);
  await botMessage(api, runner, "项目名是海棠。");
  const runId = runner.get("fake-bot").state.chats.c1;
  const chat = api.db.getRun(runId)!;
  chat.lead_messages.unshift(LeadMessageSchema.parse({ role: "user", text: "旧内容".repeat(MAX_CHAT_HANDOVER_CHARS) }));
  api.db.saveRun(chat);
  // Applied preferences survive a restart too; restoring automatic must not stay pinned.
  runner.automations.clear();
  assert.equal((await chooseModel(client, null)).status_code, 200);
  await botMessage(api, runner, "项目名是什么？");
  assert.equal(sent.at(-1)![0], BEST.id); // chosen automatically: an API model first, people wait for answers
  const prompt = sent.at(-1)![2];
  assert.ok(prompt.includes("项目名是海棠。") && prompt.includes("好的。") && prompt.split("旧内容").length <= 2001); // one long message is cut
  assert.ok(prompt.length < MAX_CHAT_HANDOVER_CHARS);
});

for (const failure of ["call", "disabled", "removed"]) {
  test(`an automation's fallback (${failure}) reports the actual model and keeps the preference`, async () => {
    const { api, client, runner, sent } = await modelBot();
    assert.equal((await chooseModel(client, OTHER.id)).status_code, 200);
    await botMessage(api, runner, "先聊一句。");
    const converse = api.providers.converse;
    if (failure === "call") {
      api.providers.converse = async (session: SupervisorSession, prompt: string, options: any) => {
        if (session.model_id === OTHER.id) throw new ProviderError("selected model unavailable");
        return converse(session, prompt, options);
      };
    } else if (failure === "disabled") api.models[OTHER.id] = { ...OTHER, enabled: false };
    else delete api.models[OTHER.id];
    let [reply] = await botMessage(api, runner, "继续聊。");
    // The next model is an API one (people wait for answers); the switch goes to the log only.
    assert.ok(sent.at(-1)![0] === BEST.id && sent.at(-1)![2].includes("先聊一句。"));
    assert.ok(!reply!.includes("暂不可用") && runner.get("fake-bot").log.some((line) => line.includes(BEST.display_name) && line.includes("暂不可用")));
    assert.equal(runner.get("fake-bot").public().model_id, OTHER.id);
    // A new conversation also falls back if the saved choice is no longer available.
    [reply] = await botMessage(api, runner, "新话题。", "c2");
    assert.ok(sent.at(-1)![0] === BEST.id && !reply!.includes("暂不可用"));
  });
}

test("automatic, an automation keeps the conversation it fell back to", async () => {
  const { api, runner, sent } = await modelBot();
  const converse = api.providers.converse;
  api.providers.converse = async (session: SupervisorSession, prompt: string, options: any) => {
    if (session.model_id === "cli:codex") throw new ProviderError("CLI unavailable");
    return converse(session, prompt, options);
  };
  const [reply] = await botMessage(api, runner, "你好。");
  assert.ok(!reply!.includes("暂不可用"));
  await botMessage(api, runner, "接着说。");
  assert.deepEqual(sent.map((item) => item[0]), [BEST.id, BEST.id]);
  assert.ok(sent.at(-1)![2].endsWith("接着说。"));
  assert.equal(runner.get("fake-bot").public().model_id, null);
});

test("an automation's model does not change how its work is planned", async () => {
  const { api, client, runner } = await modelBot();
  assert.equal((await chooseModel(client, OTHER.id)).status_code, 200);
  const [sent] = triaging(api, '{"kind": "chat"}', [ASK_FOR_WORK]);
  const [reply] = await botMessage(api, runner, "给商品接口加 Redis 缓存");
  assert.ok(reply!.includes("回复「开始」就开工"));
  assert.ok(!reply!.includes("$"), "no amounts in the chat app");
  assert.deepEqual(sent.map((item) => item[0]), [OTHER.id]);
  const [task] = tasks(api);
  assert.equal(task.status, "awaiting_confirmation");
});

test("an automation asks FluidForm, and a conversation goes on in one chat", async () => {
  const { api, client, runner } = withPackages();
  triaging(api, '{"kind": "chat"}');
  await upload(client, pkg([{ conversation: "c1", text: "WAL 是什么？" }, { conversation: "c1", text: "检查点呢？" }, { conversation: "c2", text: "你好" }]));
  assert.equal((await enable(client)).status_code, 200);
  const replies = await eventually(() => lines("replies.jsonl").length === 3 && lines("replies.jsonl"));
  assert.ok(replies.map((item: any) => item.re).join() === "0,1,2" && replies.every((item: any) => ["好的。", "嗯。"].includes(item.reply)));
  // Its secret, and the proxy as its only way out.
  assert.deepEqual(lines("env.jsonl"), [{ token: "t0ken-value", proxy: `http://127.0.0.1:${sandbox.PROXY_PORT}` }]);
  const automation = runner.get("fake-bot");
  assert.ok(Object.keys(automation.state.chats).length === 2 && automation.state.handled === 3 && automation.spentToday() > 0);
  const chat = api.db.getRun(automation.state.chats.c1)!;
  assert.ok(chat.kind === "chat" && chat.plan.title!.startsWith("假机器人 · WAL") && chat.project_dir === null);
  assert.deepEqual(chat.lead_messages.filter((m) => m.role === "user").map((m) => m.text), ["WAL 是什么？", "检查点呢？"]);
  assert.deepEqual(chat.origin, { message_id: "om_0", capability: "fake-bot", conversation: "c1" });
  const runtime = (await client.get("/api/capabilities/runtime")).json().capabilities["fake-bot"];
  assert.ok(runtime.status === "running" && runtime.text === "就绪");
  assert.ok(runtime.log.some((line: string) => line.includes("plain output goes to the log")));
  // Switched off, it stops.
  await client.patch("/api/capabilities/fake-bot", { json: { enabled: false }, headers: ORIGIN });
  assert.ok(!runner.running("fake-bot"));
});

test("work is asked for by the chat with the whole conversation, and its end is told there", async () => {
  // Regression: a fragment ("关于戏剧的") was classified alone and planned as a task without what was
  // said before; the chat never knew of the task, nor of how it ended.
  const { api, client, runner } = withPackages();
  const [sent, classified] = triaging(api, '{"kind": "task"}', ["哪类接口？", ASK_FOR_WORK, "好的。"]);
  await upload(client, pkg([{ conversation: "c1", text: "商品接口太慢了" }, { conversation: "c1", text: "详情页那个，加个缓存" }]));
  await enable(client);
  const replies = await eventually(() => lines("replies.jsonl").length === 2 && lines("replies.jsonl"));
  // A fragment is answered in the chat; work is asked for by the chat's model, said plainly.
  assert.ok(replies[0].reply === "哪类接口？" && classified.length === 0);
  assert.ok(replies[1].reply.startsWith("好，我让 FluidForm 排个计划。") && replies[1].reply.includes("回复「开始」就开工"));
  assert.ok(!replies[1].reply.includes("TASK"));
  assert.ok(!replies[1].reply.includes("$"), "no amounts in the chat app");
  const [task] = tasks(api);
  assert.equal(task.prompt, "给商品接口加 Redis 缓存：缓存商品详情 5 分钟，改价时清掉");
  // The planner saw the conversation, not only the request.
  assert.ok(sent.planned[0].includes("商品接口太慢了") && sent.planned[0].includes("新需求"));
  const chatId = runner.get("fake-bot").state.chats.c1;
  assert.deepEqual(task.origin, { message_id: "om_1", capability: "fake-bot", conversation: "c1", chat_run: chatId });
  const chat = api.db.getRun(chatId)!;
  assert.ok(chat.lead_messages.at(-1)!.text.includes("计划「加缓存」排好了") && !chat.lead_messages.at(-1)!.text.includes("TASK"));
  // Its end: the automation hears it, the chat shows it, its model is told with the next message.
  Object.assign(task, { status: "succeeded", final_result: "缓存加好了，命中率 92%。" });
  api.db.saveRun(task);
  api.executor.emit(task.id, "run.succeeded");
  const [event] = await eventually(() => lines("events.jsonl").length && lines("events.jsonl"));
  assert.ok(event.event === "task_ended" && event.origin.message_id === "om_1");
  assert.equal(event.text, "「加缓存」做完了。\n\n缓存加好了，命中率 92%。");
  assert.equal(api.db.getRun(chatId)!.lead_messages.at(-1)!.text, event.text);
  assert.deepEqual(runner.get("fake-bot").state.notes, { c1: [event.text] });
  await message(api, runner, { conversation: "c1", text: "命中率怎么样？" });
  assert.ok(sent.at(-1)![2].includes("这之后发生了") && sent.at(-1)![2].includes("命中率 92%"));
  assert.deepEqual(runner.get("fake-bot").state.notes, {});
});

/** The models answer as real providers do: asking the budget before, recording what was used after. */
function metered(api: Api): void {
  const converse = api.providers.converse!.bind(api.providers);
  api.providers.converse = async (session: SupervisorSession, prompt: string, options: any = {}) => {
    if (!(await options.spend_ok.allows())) throw new BudgetExceeded("已达到任务可用的预算，模型调用被中止。");
    await options.spend_ok.reserve(session.model_id, { prompt }, 4096);
    const result = await converse(session, prompt, options);
    await options.spend_ok.record(session.model_id, 500_000, 100_000, 0);
    return result;
  };
}

test("an automation counts what it spends and is never held back by it", async () => {
  const { api, client, runner } = withPackages();
  triaging(api, '{"kind": "chat"}');
  metered(api);
  await upload(client, pkg([{ conversation: "c1", text: "在吗" }, { conversation: "c1", text: "再问一句" }]));
  // What an older version kept as its limit, long passed.
  Object.assign(runner.get("fake-bot").state, { daily_budget_usd: 0, spent: { [runners.today()]: 500 } });
  await enable(client);
  const replies = await eventually(() => lines("replies.jsonl").length === 2 && lines("replies.jsonl"));
  assert.deepEqual(replies.map((item: any) => item.reply), ["好的。", "嗯。"]);
  assert.ok(replies.every((item: any) => !item.over_budget));
  assert.ok(runner.get("fake-bot").spentToday() > 500);
  assert.equal("daily_budget_usd" in runner.get("fake-bot").public(), false);
});

test("an automation answers when pricing does not, and a chat on the page still stops", async () => {
  const { api, client, runner } = withPackages();
  triaging(api, '{"meant": true}');
  metered(api);
  const ask = pricing.deps.ask;
  pricing.deps.ask = async () => {
    throw new Error("连不上");
  };
  try {
    await upload(client, pkg([{ conversation: "c1", text: "在吗" }, { conversation: "g1", text: "随便聊聊", addressed: false }]));
    await enable(client);
    const [first, second] = await eventually(() => lines("replies.jsonl").length === 2 && lines("replies.jsonl"));
    assert.equal(first.reply, "好的。");
    // Not called on: judged all the same, without an error said in the group.
    assert.ok(!String(second.reply ?? "").includes("没能处理"), second.reply);
    assert.equal(runner.get("fake-bot").spentToday(), 0);
    const page = await client.post("/api/chats", { json: { message: "你好", budget_usd: 1 }, headers: ORIGIN });
    await api.executor.leadTasks.get(page.json().id)!.settled();
    assert.match(api.db.getRun(page.json().id)!.lead_messages.at(-1)!.text, /停止花钱/);
  } finally {
    pricing.deps.ask = ask;
  }
});

test("a crashing automation is restarted a few times, then left stopped", async () => {
  const { client, runner } = withPackages();
  Object.assign(runners.limits, { RESTART_PAUSE: 0.01, MAX_RESTARTS: 3 });
  await upload(client, pkg([], { manifest: { entry: "echo 坏了 >&2; exit 3" } }));
  await enable(client);
  const item = runner.get("fake-bot");
  await eventually(() => item.status === "error");
  assert.ok(item.error.includes("连续退出了 3 次") && item.log.filter((line) => line.includes("坏了")).length === 3);
});

test("started with the service only when the machine allows it", async () => {
  const { api, client, runner } = withPackages();
  await upload(client, pkg());
  await enable(client);
  await runner.stopAll();
  settings.capability_packages = false;
  api.automations.startAll();
  assert.ok(!runner.running("fake-bot"));
  settings.capability_packages = true;
  api.automations.startAll();
  assert.ok(runner.running("fake-bot"));
});

test("an automation's chat remembers what people tell it, for its next chats", async () => {
  const { api, client, runner } = withPackages();
  settings.user_memory = true;
  const [sent] = triaging(api, '{"kind": "chat"}', [
    "好，以后简短回答。\nREMEMBER: 成员1: 喜欢简短的回答\nREMEMBER: 成员1: 密码是 hunter2", "嗯。", "好的。\nFORGET: 简短"]);
  await upload(client, pkg([{ conversation: "c1", text: "以后回答短一点" }]));
  await enable(client);
  const [reply] = await eventually(() => lines("replies.jsonl").length && lines("replies.jsonl"));
  // The person sees the answer without its lines; the fact is kept, the secret is not.
  assert.equal(reply.reply, "好，以后简短回答。");
  const automation = runner.get("fake-bot");
  assert.deepEqual(remembering.facts("fake-bot:c1"), ["成员1: 喜欢简短的回答"]);
  const chat = api.db.getRun(automation.state.chats.c1)!;
  assert.equal(chat.lead_messages.at(-1)!.text, "好，以后简短回答。");
  assert.ok(sent[0][2].includes("REMEMBER:") || (await chatGuide(chat)).includes("REMEMBER:"));
  // A new chat of that conversation (another day, another model) is told it first.
  delete automation.state.chats.c1;
  await api.automations.message(capabilities.load("fake-bot")!, ask({ conversation: "c1", text: "你好" }), automation);
  assert.ok(sent.at(-1)![2].includes("你记得的") && sent.at(-1)![2].includes("喜欢简短的回答"));
  await api.automations.message(capabilities.load("fake-bot")!, ask({ conversation: "c1", text: "还是详细点吧" }), automation);
  assert.deepEqual(remembering.facts("fake-bot:c1"), []);
});

test("in a group, a reply to its own question is answered without an @", async () => {
  // Regression: it asked "在广场哪一侧？", and "西侧" (no @) was taken as not meant for it.
  const { api, client, runner } = withPackages();
  const [sent, asked] = triaging(api, '{"kind": "chat"}', ["应该是国博。在广场哪一侧？", "那就是人民大会堂。", "好。"]);
  await upload(client, pkg());
  const bot = capabilities.load("fake-bot") as Capability;
  const state = runner.get("fake-bot");
  const say = (text: string, sender = "成员1", addressed = false) =>
    api.automations.message(bot, ask({ conversation: "g1", text, origin: { chat_type: "group" }, addressed, sender }), state);
  await say("这是哪栋楼？", "成员1", true);
  let [reply] = await say("西侧");
  assert.ok(reply === "那就是人民大会堂。" && sent.at(-1)![2].includes("西侧"));
  // Someone else's aside is still judged, now knowing what it last said.
  [reply] = await say("哈哈", "成员2");
  assert.ok(reply === null && asked.at(-1)![1].includes("刚才回答 成员1：那就是人民大会堂。"));
  // What the chat keeps is what was said, not what the model was told around it.
  await say("继续说", "成员1", true);
  const chat = api.db.getRun(state.state.chats.g1)!;
  assert.equal(chat.lead_messages.at(-2)!.text, "成员2：哈哈\n成员1：继续说");
  assert.ok(!chat.lead_messages.some((m) => m.role === "user" && m.text.includes("群里此前的消息")));
});

test("in a group, the chat is told whose names an @ reaches", async () => {
  // Regression: told to @ 叶玉文, it wrote "@叶玉文" as plain words.
  const { api, client, runner } = withPackages();
  const [sent] = triaging(api, '{"kind": "chat"}', ["@叶玉文 在吗？", "好。"]);
  await upload(client, pkg());
  const bot = capabilities.load("fake-bot")!;
  const state = runner.get("fake-bot");
  const people = runners.groupPeople(["张三", "叶玉文", "叶玉文", 3, " 李\n四 ", "x".repeat(99)]);
  assert.deepEqual(people, ["张三", "叶玉文", "李 四", "x".repeat(runners.MAX_PERSON_CHARS)]);
  assert.ok(runners.groupPeople("张三").length === 0 && runners.groupPeople(null).length === 0);
  const [answer] = await api.automations.message(bot, ask({ conversation: "g3", text: "@叶玉文 一下", origin: { chat_type: "group" }, sender: "张三", people }), state);
  assert.equal(answer, "@叶玉文 在吗？");
  assert.ok(sent.at(-1)![2].includes("群里的人：张三、叶玉文、李 四、x") && sent.at(-1)![2].includes("（要 @ 谁就写 @ 加这里的名字"));
  assert.ok(sent.at(-1)![2].includes("发出去就是真正的 @")); // Regression: it said it could only send plain text.
  // Told, not kept: what the chat shows is what was said.
  const chat = api.db.getRun(state.state.chats.g3)!;
  assert.ok(!chat.lead_messages.some((m) => m.text.includes("群里的人")));
  await api.automations.message(bot, ask({ conversation: "g3", text: "谢谢", sender: "张三" }), state);
  assert.ok(!sent.at(-1)![2].includes("群里的人"));
});

test("only an @ with nothing new gets a short answer", async () => {
  // Regression: an @ alone made it describe every picture of the conversation again.
  const { api, client, runner } = withPackages();
  const [sent] = triaging(api, '{"kind": "chat"}') as [Sent, unknown];
  await upload(client, pkg());
  const [reply, cost] = await message(api, runner, { conversation: "g2", text: runners.CALLED_ONLY, sender: "成员1" });
  assert.deepEqual([reply, cost], ["在呢，要我做什么？", 0]);
  assert.equal(sent.length, 0);
});

test("/new begins a new chat, and what is remembered is still told", async () => {
  const { api, runner, sent } = await modelBot();
  settings.user_memory = true;
  remembering.update("fake-bot:c1", ["用户: 喜欢简短"], []);
  await botMessage(api, runner, "先聊一句。");
  const first = runner.get("fake-bot").state.chats.c1;
  const asked = sent.length;
  const [reply] = await botMessage(api, runner, "/new");
  assert.ok(reply!.includes("开了新对话") && sent.length === asked);
  await botMessage(api, runner, "你好");
  const second = runner.get("fake-bot").state.chats.c1;
  assert.notEqual(second, first);
  assert.ok(api.db.getRun(first)); // the old one stays to be read
  assert.ok(sent.at(-1)![2].includes("喜欢简短") && !sent.at(-1)![2].includes("先聊一句。"));
});

test("idle two hours, a conversation goes on in a new chat", async () => {
  const { api, runner, sent } = await modelBot();
  await botMessage(api, runner, "看看这个日志。");
  const first = runner.get("fake-bot").state.chats.c1;
  const chat = api.db.getRun(first)!;
  for (const item of chat.lead_messages) item.created_at = new Date(Date.now() - 3 * 3600_000).toISOString();
  api.db.saveRun(chat);
  await botMessage(api, runner, "hello");
  assert.notEqual(runner.get("fake-bot").state.chats.c1, first);
  assert.ok(!sent.at(-1)![2].includes("看看这个日志。"));
});

test("/memory on keeps an idle conversation in the same chat; /new still begins one; /memory off as before", async () => {
  const { api, sent, held, say, asking, item, prompts } = await live();
  await say("m", "/memory on");
  assert.ok(sent.m.reply.includes("开了永久记忆") && prompts.length === 0 && item.state.permanent_memory?.c1 === true);
  await say("q", "永久记忆");
  assert.ok(sent.q.reply.includes("开着永久记忆"));
  const idle = async (id: string, text: string, count: number) => {
    const chat = api.db.getRun(item.state.chats.c1)!;
    for (const message of chat.lead_messages) message.created_at = new Date(Date.now() - 30 * 3600_000).toISOString();
    api.db.saveRun(chat);
    const answered = say(id, text);
    await asking(count);
    held[count - 1].finish("好。");
    await answered;
  };
  const first = say("a", "看看这个日志。");
  await asking(1);
  held[0].finish("看了。");
  await first;
  const chat = item.state.chats.c1;
  await idle("b", "接着说", 2);
  assert.equal(item.state.chats.c1, chat);
  // Another conversation is not touched by it.
  assert.ok(!item.state.permanent_memory?.c2);
  await say("n", "/new");
  assert.ok(!item.state.chats.c1 && item.state.permanent_memory?.c1 === true);
  await say("o", "关闭永久记忆");
  assert.ok(sent.o.reply.includes("关了永久记忆") && !item.state.permanent_memory?.c1);
  const third = say("c", "新的问题");
  await asking(3);
  held[2].finish("嗯。");
  await third;
  const renewed = item.state.chats.c1;
  await idle("d", "隔了很久", 4);
  assert.notEqual(item.state.chats.c1, renewed);
});

test("/help and /status say whether this conversation begins afresh by itself", async () => {
  const { sent, say } = await live();
  await say("h", "/help");
  assert.ok(sent.h.reply.includes("闲置 2 小时") && sent.h.reply.includes("/memory"));
  await say("m", "打开永久记忆");
  await say("k", "/help");
  await say("s", "/status");
  assert.ok(!sent.k.reply.includes("闲置 2 小时") && sent.k.reply.includes("永久记忆"));
  assert.ok(sent.s.reply.includes("永久记忆"));
  assert.ok(!runners.MEMORY_COMMAND.test("/memory 一下") && !runners.MEMORY_COMMAND.test("永久记忆是什么"));
});

/** Messages as they arrive from the app, and what is sent back for each; a model that answers when let. */
async function live() {
  const given = withPackages();
  triaging(given.api, '{"reply": true}');
  await upload(given.client, pkg());
  const sent: Record<string, any> = {};
  given.runner.send = async (_item, payload: any) => {
    if (payload.re) sent[payload.re] = payload;
  };
  const prompts: string[] = [];
  const held: { write(text: string): void; finish(text: string): void }[] = [];
  given.api.providers.converse = async (session: SupervisorSession, prompt: string, options: any = {}) => {
    prompts.push([...(options.dialogue?.messages ?? []).map((item: any) => item.content), prompt].join("\n"));
    const hear = streaming.listener.get();
    const answer = await new Promise<string>((finish, fail) => {
      held.push({ write: (text) => hear?.(text), finish });
      const stop = () => fail(options.signal.reason);
      if (options.signal?.aborted) stop();
      options.signal?.addEventListener("abort", stop, { once: true });
    });
    session.calls += 1;
    return new ProviderResult(answer, 10, 10);
  };
  const item = given.runner.get("fake-bot");
  const say = (id: string, text: string, fields: Record<string, unknown> = {}) =>
    given.runner.ask(item, capabilities.load("fake-bot")!, { id, conversation: "c1", text, ...fields });
  const asking = (count: number) => eventually(() => held.length >= count && held);
  return { ...given, sent, prompts, held, say, asking, item };
}

test("sent again before anything was written, the first is stopped and both are answered as one", async () => {
  const { api, sent, prompts, held, say, asking, item } = await live();
  const first = say("a", "北京明天");
  await asking(1);
  const second = say("b", "会下雨吗");
  await asking(2);
  held[1].finish("不会。");
  await Promise.all([first, second]);
  assert.ok(sent.a.superseded && sent.a.reply === null);
  assert.equal(sent.b.reply, "不会。");
  assert.equal(prompts[1].split("北京明天").length, 2); // once
  const chat = api.db.getRun(item.state.chats.c1)!;
  assert.deepEqual(chat.lead_messages.map((m) => [m.role, m.status, m.text]), [["user", "done", "北京明天\n会下雨吗"], ["lead", "done", "不会。"]]);
});

test("sent again while it writes, the next waits its turn, and what waits is taken together", async () => {
  const { sent, held, say, asking, prompts } = await live();
  const first = say("a", "讲讲北京");
  await asking(1);
  held[0].write("北京是");
  const second = say("b", "再讲上海");
  const third = say("c", "还有广州");
  held[0].finish("北京是首都。");
  await asking(2);
  held[1].finish("都讲了。");
  await Promise.all([first, second, third]);
  assert.equal(sent.a.reply, "北京是首都。");
  assert.ok(sent.b.superseded && sent.c.reply === "都讲了。");
  assert.ok(prompts[1].includes("再讲上海\n还有广州"));
});

test("/stop ends what is being answered where it is, and the next message is answered", async () => {
  const { api, sent, held, say, asking, item } = await live();
  const first = say("a", "写个长的");
  await asking(1);
  held[0].write("第一段");
  await say("s", "/stop");
  await first;
  assert.ok(sent.a.reply.startsWith("第一段") && sent.a.reply.includes("已停下") && sent.s.reply);
  const next = say("b", "你好");
  await asking(2);
  held[1].finish("在的。");
  await next;
  assert.equal(sent.b.reply, "在的。");
  const chat = api.db.getRun(item.state.chats.c1)!;
  assert.ok(chat.lead_messages.every((m) => m.status !== "pending") && chat.lead_messages[1].text.includes("停下"));
});

test("/new stops what is being answered; /status and an idle /stop ask no model", async () => {
  const { sent, say, asking, prompts } = await live();
  await say("s", "/stop");
  await say("i", "/status");
  assert.ok(sent.s.reply && sent.i.reply.includes("/new") && !sent.i.reply.includes("$") && prompts.length === 0);
  const first = say("a", "讲个故事");
  await asking(1);
  await say("n", "/new");
  await first;
  assert.ok(sent.n.reply.includes("开了新对话") && sent.a.superseded);
});

test("/help lists every command in the chat, without asking a model", async () => {
  const { sent, say, prompts } = await live();
  await say("h", "/help");
  await say("z", "帮助");
  for (const command of ["/stop", "/new", "/status", "/memory", "/help", "开始", "取消"]) assert.ok(sent.h.reply.includes(command), command);
  assert.equal(sent.z.reply, sent.h.reply);
  assert.ok(sent.h.reply.includes("/help") && sent.h.reply.split("\n").length > 3 && prompts.length === 0);
  await say("s", "/status");
  assert.ok(sent.s.reply.includes("/help"));
});

test("one person's message does not stop another's in a group", async () => {
  const { sent, held, say, asking } = await live();
  const first = say("a", "甲的问题", { sender: "甲" });
  await asking(1);
  const second = say("b", "乙的问题", { sender: "乙" });
  held[0].finish("答甲。");
  await asking(2);
  held[1].finish("答乙。");
  await Promise.all([first, second]);
  assert.deepEqual([sent.a.reply, sent.b.reply], ["答甲。", "答乙。"]);
});

test("what the group said before is still told when the question is sent on before its answer", async () => {
  const { held, say, asking, prompts, item } = await live();
  item.state.heard = { c1: ["成员1：三点开会"] };
  const first = say("a", "几点", { sender: "成员2" });
  await asking(1);
  const second = say("b", "开会", { sender: "成员2" });
  await asking(2);
  held[1].finish("三点。");
  await Promise.all([first, second]);
  assert.ok(prompts[1].includes("三点开会"));
  assert.ok(!item.state.heard.c1?.length);
});

test("only words that point at a picture wait for one", () => {
  for (const text of ["这张图是什么", "这张是谁", "图里是什么猫", "看看截图", "我发你张截图", "what is in this picture"]) assert.ok(runners.PICTURE_WORDS.test(text), text);
  for (const text of ["帮我生成一张图片", "怎么截图", "这张表怎么算", "照片怎么压缩", "apec全家福照片发我一下"]) assert.ok(!runners.PICTURE_WORDS.test(text), text);
});

test("while a picture is being talked about, the model is one that sees", async () => {
  const { api, client, runner } = await modelBot();
  api.models[OTHER.id] = { ...OTHER, supports_vision: false };
  assert.equal((await chooseModel(client, OTHER.id)).status_code, 200);
  settings.data_dir ||= folder();
  const heron = files.save("heron.png", PNG);
  const used: (string | null)[] = [];
  api.providers.converse = async (session: SupervisorSession) => {
    used.push(session.model_id);
    session.calls += 1;
    return new ProviderResult("是苍鹭。", 10, 10);
  };
  await message(api, runner, { conversation: "c1", text: "（见附件）", attachments: [heron] });
  await message(api, runner, { conversation: "c1", text: "这是什么鸟" });
  assert.deepEqual(used, [BEST.id, BEST.id]);
});

/** A task planned in a conversation, as the chat's model asks for it. */
async function planned(api: Api, runner: runners.Runner, fields: Record<string, unknown> = {}) {
  triaging(api, '{"kind": "chat"}', [ASK_FOR_WORK, "好的。", "好的。", "好的。"]);
  await message(api, runner, { conversation: "c1", text: "给商品接口加个缓存", ...fields });
  return tasks(api).at(-1)!;
}

test("who asked for a task starts it, or calls it off, in the chat", async () => {
  const { api, client, runner } = withPackages();
  await upload(client, pkg());
  const task = await planned(api, runner);
  assert.equal(task.status, "awaiting_confirmation");
  const [started] = await message(api, runner, { conversation: "c1", text: "开始" });
  assert.ok(started!.includes("开工") && ["queued", "running", "succeeded"].includes(api.db.getRun(task.id)!.status));
  const next = await planned(api, runner);
  const [called] = await message(api, runner, { conversation: "c1", text: "取消" });
  assert.ok(called!.includes("不做了") && api.db.getRun(next.id)!.status === "cancelled");
  // Without a task waiting, "开始" is said to the chat as anything else.
  const [said] = await message(api, runner, { conversation: "c1", text: "开始" });
  assert.equal(said, "好的。");
});

test("in a group only who asked for it can start it", async () => {
  const { api, client, runner } = withPackages();
  await upload(client, pkg());
  const task = await planned(api, runner, { sender: "甲", sender_id: "ou_a", origin: { chat_type: "group" } });
  const [other] = await message(api, runner, { conversation: "c1", text: "开始", sender: "乙", sender_id: "ou_b", origin: { chat_type: "group" } });
  assert.ok(other!.includes("甲") && api.db.getRun(task.id)!.status === "awaiting_confirmation");
  await message(api, runner, { conversation: "c1", text: "开始", sender: "甲", sender_id: "ou_a", origin: { chat_type: "group" } });
  assert.notEqual(api.db.getRun(task.id)!.status, "awaiting_confirmation");
});

test("what a task made is sent to the chat it came from, and no path of this machine is said", async () => {
  const { api, client, runner } = withPackages();
  await upload(client, pkg());
  const task = await planned(api, runner);
  const folder = join(settings.workspace_root, folderId(task));
  mkdirSync(join(folder, "face"), { recursive: true });
  writeFileSync(join(folder, "face.zip"), "zip");
  writeFileSync(join(folder, "face", "README.md"), "readme");
  const run = api.db.getRun(task.id)!;
  run.status = "succeeded";
  run.final_result = `已打包：[下载 face.zip](${join(folder, "face.zip")})。按 [README](${join(folder, "face", "README.md")}) 安装；日志在 ${join(folder, "run.log")}。别处的 [x](/etc/passwd)`;
  api.db.saveRun(run);
  const events: any[] = [];
  runner.notify = (_id, event) => events.push(event);
  api.automations.taskEnded(task.id, "run.succeeded");
  const [event] = events;
  assert.equal(event.files.length, 2); // a short result goes as it is, without a copy of itself
  assert.ok(event.files.every((path: string) => path.startsWith("outbox/") && existsSync(join(packages.dataFolder("fake-bot"), path))));
  assert.ok(!event.text.includes(settings.workspace_root) && !event.text.includes("/etc/passwd") && event.text.includes("face.zip"));
});

test("a task takes the files of the last turns, not every file the chat ever had", async () => {
  const { api, client, runner } = withPackages();
  await upload(client, pkg());
  triaging(api, '{"kind": "chat"}', ["好的。", "好的。", ASK_FOR_WORK]);
  await message(api, runner, { conversation: "c1", text: "看看", attachments: [files.save("old.png", PNG)] });
  for (const text of ["一", "二", "三", "四"]) await message(api, runner, { conversation: "c1", text });
  triaging(api, '{"kind": "chat"}', [ASK_FOR_WORK]);
  await message(api, runner, { conversation: "c1", text: "照这个做", attachments: [files.save("new.png", PNG)] });
  assert.deepEqual(tasks(api).at(-1)!.attachments.map((item) => item.name), ["new.png"]);
});

test("a result that names its files as the PPT task did sends them, briefly, and the chat can send them again", async () => {
  // Regression: `china_economy_2026.pptx` in a table was not found, the whole report went to the chat, and
  // asked to send it the chat said it was lost and planned it again.
  const { api, client, runner } = withPackages();
  await upload(client, pkg());
  const task = await planned(api, runner);
  const folder = join(settings.workspace_root, folderId(task));
  mkdirSync(join(folder, "output"), { recursive: true });
  for (const name of ["china_economy_2026.pptx", "数据来源清单.md", "output/china_economy_2026.pdf", "build_deck.py", "make_charts.py", "data.py"]) writeFileSync(join(folder, name), name);
  const run = api.db.getRun(task.id)!;
  run.status = "succeeded";
  run.final_result = "交付完成。`china_economy_2026.pptx` 已生成并通过校验，放在项目文件夹根目录。\n\n## 交付物\n\n| 文件 | 说明 |\n|---|---|\n"
    + "| `china_economy_2026.pptx` | 13 页 |\n| `数据来源清单.md` | 来源 |\n| `output/china_economy_2026.pdf` | 校验用 |\n| `build_deck.py` / `make_charts.py` / `data.py` | 脚本 |\n\n## 校验结果\n\n- 13 页";
  api.db.saveRun(run);
  const events: any[] = [];
  runner.notify = (_id, event) => events.push(event);
  api.automations.taskEnded(task.id, "run.succeeded");
  const names = events[0].files.map((path: string) => path.split("/").at(-1)!.split("-").slice(1).join("-"));
  assert.deepEqual(names, ["china_economy_2026.pptx", "数据来源清单.md", "china_economy_2026.pdf", "build_deck.py", "make_charts.py", "结果说明.md"]);
  assert.ok(!events[0].text.includes("##") && !events[0].text.includes("| 文件") && events[0].text.length < 700);
  // Asked for it later, the chat has it in its folder.
  settings.chat_tools = true;
  triaging(api, '{"kind": "chat"}', ["好的。"]);
  const chat = api.db.getRun(run.origin!.chat_run)!;
  await message(api, runner, { conversation: "c1", text: "发送给我" });
  const kept = join(settings.workspace_root, folderId(chat), "tasks");
  const [taskFolder] = readdirSync(kept);
  assert.ok(readdirSync(join(kept, taskFolder)).includes("china_economy_2026.pptx"));
});
