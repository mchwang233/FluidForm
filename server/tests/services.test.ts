// Service packages (services.ts): what they provide and require, and JSON-RPC both ways with a
// process in the capabilities' sandbox (docs/design/chat-and-pricing-packages.md).
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as packages from "../src/capability-packages.js";
import * as runners from "../src/capability-runner.js";
import * as sandbox from "../src/capability-sandbox.js";
import { settings } from "../src/config.js";
import * as secrets from "../src/secrets.js";
import * as services from "../src/services.js";
import { conftest } from "./helpers/conftest.js";
import { type Client, taskApi } from "./helpers/task-api.js";
import { zipOf } from "./helpers/zip-writer.js";

const { folder } = conftest();
const ORIGIN = { origin: "http://localhost:5173" };
const saved = { sandbox: { ...sandbox.deps }, limits: { ...runners.limits }, builtIn: new Set(services.builtIn), runWorker: secrets.deps.runWorker };
const hosts: { stopAll(): Promise<void> }[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stopAll();
  Object.assign(sandbox.deps, saved.sandbox);
  Object.assign(runners.limits, saved.limits);
  services.builtIn.clear();
  for (const name of saved.builtIn) services.builtIn.add(name);
  secrets.deps.runWorker = saved.runWorker;
});

// A service speaking JSON-RPC: it answers "echo", asks FluidForm for "add" when asked "sum", never
// answers "hang", and exits on "crash".
const SERVICE = String.raw`
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
send({ method: "status", params: { text: "就绪" } });
console.error("started on stderr");
let next = 1000;
const asked = new Map();
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "echo") send({ id: message.id, result: message.params });
  else if (message.method === "sum") {
    next += 1;
    asked.set(next, message.id);
    send({ id: next, method: "fluidform.add", params: message.params });
  } else if (message.method === "missing") {
    next += 1;
    asked.set(next, message.id);
    send({ id: next, method: "fluidform.nothing", params: {} });
  } else if (message.method === "crash") process.exit(3);
  else if (message.method === "hang") {}
  else if (!message.method && asked.has(message.id)) {
    const original = asked.get(message.id);
    asked.delete(message.id);
    send({ id: original, result: { via: "fluidform", ...(message.result || {}), ...(message.error ? { error: message.error.message } : {}) } });
  }
});
`;

function pkg(id: string, fields: Record<string, unknown>): Buffer {
  const manifest = { id, name: id, kind: "service", version: "1.0", summary: "测试用", entry: "node service.js", ...fields };
  return zipOf([{ name: "pkg/capability.json", data: JSON.stringify(manifest) }, { name: "pkg/service.js", data: SERVICE }]);
}

/** The API with packages allowed, run without bwrap, and nothing kept in the real keyring. */
function withPackages(): { api: ReturnType<typeof taskApi>["api"]; client: Client } {
  const given = taskApi(folder());
  settings.capability_packages = true;
  sandbox.deps.missing = () => "";
  sandbox.deps.wrap = (where, _data, command, env) => ["env", "-i", ...Object.entries({ ...env, PATH: process.env.PATH! }).map(([name, value]) => `${name}=${value}`),
    "/bin/bash", "-c", `cd '${where}' && ${command}`];
  secrets.deps.runWorker = async () => ({ code: 0, stdout: '{"value": null}', timedOut: false });
  hosts.push(given.api.services, given.api.automations.runner);
  return given;
}

const upload = (client: Client, data: Buffer) => client.post("/api/capabilities/upload", { content: data, headers: ORIGIN });
const enable = (client: Client, id: string, enabled = true) =>
  client.patch(`/api/capabilities/${id}`, { json: { enabled, confirmed: true }, headers: ORIGIN });

async function eventually<T>(check: () => T, seconds = 10): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 30));
  }
  throw new Error("timed out");
}

test("a package says what it provides and requires, and only what FluidForm knows", () => {
  const read = (fields: Record<string, unknown>) => packages.read(pkg("svc", fields));
  assert.deepEqual([read({ provides: ["chat"] }).provides, read({ provides: ["chat"], requires: ["pricing"] }).requires], [["chat"], ["pricing"]]);
  assert.throws(() => read({}), /provides/);
  assert.throws(() => read({ provides: ["weather"] }), /没有这种能力：weather/);
  assert.throws(() => read({ provides: ["chat"], requires: ["chat"] }), /自己提供/);
  assert.throws(() => read({ kind: "automation", provides: ["chat"] }), /只有服务/);
  assert.deepEqual(read({ kind: "automation", requires: ["chat"] }).requires, ["chat"]);
  assert.throws(() => read({ provides: ["chat"], entry: "" }), /entry/);
});

test("what a package requires must be there, and what others need keeps its provider on", async () => {
  const { client } = withPackages();
  // FluidForm still provides chat itself: a package needing it is enabled.
  assert.equal((await upload(client, pkg("bot", { kind: "automation", requires: ["chat"], entry: "sleep 60" }))).status_code, 201);
  services.builtIn.delete("chat");
  const refused = await enable(client, "bot");
  assert.ok(refused.status_code === 409 && refused.json().detail.includes("需要先启用聊天能力"), refused.text);
  // A package providing chat, enabled: now it can be.
  await upload(client, pkg("chat-a", { provides: ["chat"] }));
  assert.equal((await enable(client, "chat-a")).status_code, 200);
  assert.deepEqual((await client.get("/api/capabilities/provided")).json(), { chat: "chat-a", pricing: null });
  assert.equal((await enable(client, "bot")).status_code, 200);
  // Another provider of chat waits until the first is off.
  await upload(client, pkg("chat-b", { provides: ["chat"] }));
  const twice = await enable(client, "chat-b");
  assert.ok(twice.status_code === 409 && twice.json().detail.includes("chat-a"));
  // The provider stays while the bot needs it: neither switched off nor removed.
  for (const response of [await enable(client, "chat-a", false), await client.delete("/api/capabilities/chat-a", { headers: ORIGIN })]) {
    assert.ok(response.status_code === 409 && response.json().detail.includes("「bot」需要聊天能力"), response.text);
  }
  assert.equal((await enable(client, "bot", false)).status_code, 200);
  assert.equal((await enable(client, "chat-a", false)).status_code, 200);
});

test("FluidForm and a service ask each other, over JSON-RPC in its sandbox", async () => {
  const { api, client } = withPackages();
  api.services.handle("fluidform.add", (params, service) => ({ sum: params.a + params.b, from: service.id }));
  await upload(client, pkg("chat-a", { provides: ["chat"] }));
  assert.equal((await enable(client, "chat-a")).status_code, 200);
  const service = api.services.get("chat-a");
  await eventually(() => service.status === "running" && service.text === "就绪");
  assert.deepEqual(await api.services.request("chat", "echo", { x: 1 }), { x: 1 });
  // It asks FluidForm in turn; a method FluidForm does not have is an error it is told of.
  assert.deepEqual(await api.services.request("chat", "sum", { a: 2, b: 3 }), { via: "fluidform", sum: 5, from: "chat-a" });
  assert.deepEqual(await api.services.request("chat", "missing"), { via: "fluidform", error: "FluidForm 没有 fluidform.nothing" });
  // Not answered in time: an error, and the service goes on.
  await assert.rejects(api.services.request("chat", "hang", {}, 0.2), /没有回答/);
  assert.ok(service.log.some((line) => line.includes("started on stderr")));
  const runtime = (await client.get("/api/capabilities/runtime")).json();
  assert.ok(runtime.capabilities["chat-a"].status === "running" && runtime.provided.chat === "chat-a");
  // Nobody provides pricing by a package: asking it is an error, not a wait.
  await assert.rejects(api.services.request("pricing", "estimate"), /没有启用计价能力/);
});

test("a service that exits is started again, and what waited for it fails at once", async () => {
  const { api, client } = withPackages();
  Object.assign(runners.limits, { RESTART_PAUSE: 0.05 });
  await upload(client, pkg("chat-a", { provides: ["chat"] }));
  await enable(client, "chat-a");
  const service = api.services.get("chat-a");
  await eventually(() => service.status === "running");
  await assert.rejects(api.services.request("chat", "crash", {}, 5), /服务停了/);
  await eventually(() => service.log.some((line) => line.includes("返回 3")));
  await eventually(() => service.status === "running");
  assert.deepEqual(await api.services.request("chat", "echo", { again: true }), { again: true });
  // Switched off, it stops.
  await enable(client, "chat-a", false);
  assert.ok(!api.services.running("chat-a"));
});
