// Routing a step that makes pictures, call-control.ts and attachments.ts: tests from test_images, test_call_runtime and
// test_recovery_regressions, ported.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import * as attachments from "../src/attachments.js";
import { ProviderError } from "../src/budget.js";
import { ProviderGate } from "../src/call-control.js";
import { settings } from "../src/config.js";
import { ModelProfileSchema, TaskNodeSchema } from "../src/models.js";
import { AsyncEvent } from "../src/py.js";
import * as routing from "../src/routing.js";

const PNG = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(32)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(32)]);
const saved = { mcp_servers: settings.mcp_servers, data_dir: settings.data_dir };
const env = { ZHIPU_API_KEY: process.env.ZHIPU_API_KEY, MINIMAX_API_KEY: process.env.MINIMAX_API_KEY };

beforeEach(() => {
  process.env.ZHIPU_API_KEY = "g";
  process.env.MINIMAX_API_KEY = "m";
  settings.data_dir = mkdtempSync(join(tmpdir(), "attachments-"));
});
afterEach(() => {
  Object.assign(settings, saved);
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

test("a step that makes pictures goes to an API model when an MCP server makes them", () => {
  const model = (id: string, channel: string) => ModelProfileSchema.parse({ id, provider: "x", display_name: id, channel,
    context_window: 1_000_000, input_per_million: 1, output_per_million: 1, scores: { coding: 90, planning: 90, reliability: 90 } });
  const models = [model("cli:codex", "cli"), model("x:api", "api")];
  const both = new Set(["cli:codex", "x:api"]);
  settings.mcp_servers = { minimax: { command: ["minimax-mcp"], makes_images: true } };
  const node = TaskNodeSchema.parse({ id: "n", title: "头像", instructions: "画", capability: "coding", needs_images: true });
  assert.deepEqual(routing.eligibleForNode(node, models, both).map((item) => item.id), ["x:api"]);
  // Other steps, or a machine without an image model, keep every model.
  const other = TaskNodeSchema.parse({ id: "o", title: "写", instructions: "写", capability: "coding" });
  assert.equal(routing.eligibleForNode(other, models, both).length, 2);
  settings.mcp_servers = {};
  assert.equal(routing.eligibleForNode(node, models, both).length, 2);
});

test("the provider gate takes turns, and a cancelled call releases its place", async () => {
  const gate = new ProviderGate();
  const entered = new AsyncEvent();
  const cancel = new AbortController();
  const first = gate.hold({ concurrency: 1 }, 10, async () => {
    entered.set();
    // Cancelled while it holds its place.
    await new Promise((_, reject) => cancel.signal.addEventListener("abort", () => reject(new Error("cancelled"))));
  });
  await entered.wait();
  let secondEntered = false;
  const second = gate.hold({ concurrency: 1 }, 10, async () => {
    secondEntered = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondEntered, false);
  cancel.abort();
  await assert.rejects(first, /cancelled/);
  await second;
  assert.ok(secondEntered);
  assert.equal(gate.active, 0);
});

test("RPM and TPM wait, and an impossible request is refused", async () => {
  const gate = new ProviderGate();
  await gate.hold({ rpm: 1, tpm: 100 }, 80, async () => undefined);
  const stop = new AbortController();
  const waiting = gate.hold({ rpm: 1, tpm: 100 }, 30, async () => assert.fail("rate gate admitted too early"), stop.signal);
  setTimeout(() => stop.abort(new Error("timed out")), 20);
  await assert.rejects(waiting, /timed out/);
  await assert.rejects(gate.hold({ tpm: 100 }, 101, async () => assert.fail("impossible request admitted")),
    (error: Error) => error instanceof ProviderError && /TPM/.test(error.message));
  assert.equal(gate.active, 0);
});

for (const name of ["meta.json", "content", "normal.txt"]) {
  test(`upload content never collides with metadata (${name})`, () => {
    const original = Buffer.from('{"user_content":"preserve me"}');
    const item = attachments.save(name, original);
    assert.deepEqual(attachments.get(item.id), item);
    assert.ok(readFileSync(attachments.path(item)).equals(original));
  });
}

test("existing upload paths remain readable", () => {
  const item = attachments.save("old.txt", Buffer.from("legacy"));
  const stored = attachments.path(item);
  renameSync(stored, join(dirname(dirname(stored)), item.name));
  rmdirSync(dirname(stored));
  assert.equal(readFileSync(attachments.path(attachments.get(item.id)!)).toString(), "legacy");
});
