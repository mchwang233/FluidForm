// The API models' tool loop in providers.ts: its tests in test_agent, test_tools, test_executor,
// test_core, test_quota and test_projects, ported.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import * as agent from "../src/agent.js";
import { ProviderError } from "../src/budget.js";
import { builtinModels } from "../src/catalog.js";
import { CliError } from "../src/cli-channels.js";
import { settings } from "../src/config.js";
import * as environment from "../src/environment.js";
import * as providers from "../src/providers.js";
import { ProviderRegistry } from "../src/providers.js";
import { ModelUnavailable, QuotaExhausted } from "../src/quota.js";
import { isolated, jsonReply, registryWith } from "./helpers/providers.js";

const { folder } = isolated();
const deps = { ...agent.deps };
const overrides = environment.deps.overrides;
afterEach(() => {
  Object.assign(agent.deps, deps);
  environment.deps.overrides = overrides;
});
const write = (path: string, text: string) => writeFileSync(join(folder(), path), text);

for (const provider of ["openai", "anthropic", "google"]) {
  test(`command output reaches the next model turn (${provider})`, { skip: !agent.sandboxAvailable() }, async () => {
    const root = join(folder(), "command work");
    mkdirSync(root);
    Object.assign(settings, { sandbox_env: [], sandbox_profiles: [] });
    agent.deps.sandboxPorts = async () => [];
    agent.deps.networkAvailable = () => false;
    environment.deps.overrides = () => ({});
    const command = { command: "echo model-stdout; echo model-stderr >&2; exit 3" };
    let replies: Record<string, unknown>[];
    if (provider === "openai") {
      process.env.OPENAI_API_KEY = "test";
      replies = [{ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "Bash", arguments: JSON.stringify(command) } }] } }] },
        { choices: [{ message: { content: "received" } }] }];
    } else if (provider === "anthropic") {
      process.env.ANTHROPIC_API_KEY = "test";
      replies = [{ content: [{ type: "tool_use", id: "c1", name: "Bash", input: command }], usage: { input_tokens: 1, output_tokens: 1 } },
        { content: [{ type: "text", text: "received" }], usage: { input_tokens: 1, output_tokens: 1 } }];
    } else {
      process.env.GEMINI_API_KEY = "test";
      process.env.GOOGLE_API_KEY = "test";
      replies = [{ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "Bash", args: command } }] } }] },
        { candidates: [{ content: { role: "model", parts: [{ text: "received" }] } }] }];
    }
    const sent: any[] = [];
    const result = await registryWith(replies, sent).complete(`${provider}:test-model`, "Run the command", { workspace: root, act: true, network: true });
    assert.equal(result.text, "received");
    const expected = "Exit code 3\nmodel-stdout\nmodel-stderr";
    if (provider === "openai") assert.equal(sent[1].messages.at(-1).content, expected);
    else if (provider === "anthropic") assert.equal(sent[1].messages.at(-1).content[0].content, expected);
    else assert.equal(sent[1].contents.at(-1).parts[0].functionResponse.response.result, expected);
  });
}

test("OpenAI-compatible models call tools until done", async () => {
  process.env.OPENAI_API_KEY = "test";
  const sent: any[] = [];
  const registry = registryWith([
    { choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "Write", arguments: JSON.stringify({ file_path: "hello.txt", content: "hi" }) } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 } },
    { choices: [{ message: { content: "Wrote hello.txt" } }], usage: { prompt_tokens: 20, completion_tokens: 3 } }], sent);
  const result = await registry.complete("openai:gpt-x", "Create hello.txt", { workspace: folder(), act: true });
  assert.equal(readFileSync(join(folder(), "hello.txt"), "utf8"), "hi");
  assert.deepEqual([result.text, result.input_tokens, result.output_tokens], ["Wrote hello.txt", 30, 8]);
  const names = new Set(sent[0].tools.map((tool: any) => tool.function.name));
  for (const name of ["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS"]) assert.ok(names.has(name), name);
  assert.deepEqual(sent[1].messages.at(-1), { role: "tool", tool_call_id: "c1", content: "Created hello.txt (1 lines)" });
});

test("Anthropic and Gemini models call tools until done", async () => {
  for (const name of ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]) process.env[name] = "test";
  write("notes.md", "remember this");
  const sent: any[] = [];
  const registry = registryWith([
    { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "notes.md" } }], usage: { input_tokens: 5, output_tokens: 2 } },
    { content: [{ type: "text", text: "It says remember this" }], usage: { input_tokens: 7, output_tokens: 4 } },
    { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "LS", args: {} } }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } },
    { candidates: [{ content: { role: "model", parts: [{ text: "Found notes.md" }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 } }], sent);
  const claude = await registry.complete("anthropic:claude-x", "Read the notes", { workspace: folder(), act: true });
  const gemini = await registry.complete("google:gemini-x", "List files", { workspace: folder(), act: true });
  assert.deepEqual([claude.text, claude.input_tokens, claude.output_tokens], ["It says remember this", 12, 6]);
  assert.deepEqual(sent[1].messages.at(-1).content[0], { type: "tool_result", tool_use_id: "t1", content: "     1\tremember this", cache_control: { type: "ephemeral" } });
  assert.equal(sent[0].tools[0].input_schema.type, "object");
  assert.equal(gemini.text, "Found notes.md");
  assert.equal(sent[3].contents.at(-1).parts[0].functionResponse.name, "LS");
  assert.ok(sent[3].contents.at(-1).parts[0].functionResponse.response.result.includes("notes.md"));
});

test("tool loops stop at the budget and the turn limit", async () => {
  process.env.OPENAI_API_KEY = "test";
  settings.api_agent_max_turns = 3;
  const looping = { choices: [{ message: { content: null, tool_calls: [{ id: "c", type: "function", function: { name: "LS", arguments: "{}" } }] } }],
    usage: { prompt_tokens: 100, completion_tokens: 100 } };
  const registry = registryWith(() => looping);
  await assert.rejects(registry.complete("openai:gpt-x", "loop", { workspace: folder(), act: true }), (error: Error) => error instanceof ProviderError && error.message.includes("3 轮"));
  await assert.rejects(registry.complete("openai:gpt-x", "loop", { workspace: folder(), act: true, spend_ok: { allows: () => false } }), /预算/);
  // Without act it is a single plain call, with no tools offered.
  const plain = await registry.complete("openai:gpt-x", "loop", { workspace: folder() });
  assert.equal(plain.input_tokens, 100);
});

const toolTurn = (text: string | null, call = true) => ({ choices: [{ message: { content: text, ...(call ? { tool_calls: [{ id: "c1", type: "function", function: { name: "LS", arguments: "{}" } }] } : {}) },
  finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

/** A model that lists the directory every turn until request ``answerAt``. */
async function runTurns(maxTurns: number, answerAt: number) {
  process.env.DEEPSEEK_API_KEY = "sk-test";
  const bodies: any[] = [];
  const registry = registryWith((request) => {
    bodies.push(request.body);
    return toolTurn("进度：完成了一半", bodies.length < answerAt);
  });
  const log: any[] = [];
  const result = await registry.complete("deepseek:deepseek-chat", "do it", { workspace: folder(), act: true, max_turns: maxTurns, tool_log: log });
  return { result, bodies, log };
}

test("out of turns, the model is asked for a progress summary", async () => {
  const { result, bodies, log } = await runTurns(3, 4);
  assert.deepEqual([result.text, result.turns, result.turn_limit], ["进度：完成了一半", 3, true]);
  assert.equal(bodies.length, 4);
  assert.deepEqual(log.map((call) => call.turn), [1, 2, 3]);
  assert.deepEqual(log[0], { turn: 1, tool: "LS", detail: ".", ok: true, output: "./\n(empty)" });
  assert.ok(JSON.stringify(bodies[0]).includes("You have at most 3 turns"));
  assert.ok(JSON.stringify(bodies[3].messages.at(-1)).includes("No turns of tool calls are left"));
});

test("five turns before the limit, the model is told to wrap up", async () => {
  const { result, bodies } = await runTurns(8, 5);
  assert.ok(!result.turn_limit && result.turns === 5);
  assert.ok(JSON.stringify(bodies[3].messages.at(-1)).includes("Only 5 turns of tool calls are left"));
  assert.ok(!JSON.stringify(bodies[2].messages.at(-1)).includes("Only 5 turns"));
});

test("a model that keeps calling tools after the limit fails with the turn limit", async () => {
  await assert.rejects(runTurns(2, 99), /在 2 轮工具调用后仍未完成/);
});

test("new Chinese providers are routable", () => {
  for (const name of ["ZHIPU_API_KEY", "MINIMAX_API_KEY", "MOONSHOT_API_KEY"]) process.env[name] = "test";
  const configured = new ProviderRegistry().configuredModels(builtinModels().map((model) => model.id));
  for (const id of ["glm:glm-5.2", "minimax:MiniMax-M2.7", "kimi:kimi-k3"]) assert.ok(configured.has(id), id);
});

test("the provider retries rate-limited requests", async () => {
  process.env.DEEPSEEK_API_KEY = "test-key";
  const calls: unknown[] = [];
  const registry = registryWith([jsonReply(429, {}, { "retry-after": "0" }), jsonReply(503, {}),
    { choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }], calls);
  const result = await registry.complete("deepseek:deepseek-chat", "hello");
  assert.equal(result.text, "done");
  assert.equal(calls.length, 3);
});

test("the provider gives up after its attempts", async () => {
  process.env.DEEPSEEK_API_KEY = "test-key";
  const registry = registryWith(() => jsonReply(500, {}));
  await assert.rejects(registry.complete("deepseek:deepseek-chat", "hello"), (error: Error) => error instanceof ModelUnavailable && error.message.includes("500"));
  assert.ok(registry.quota.exhausted("deepseek:deepseek-chat"));
});

test("a CLI failure without fallback never calls the API", async () => {
  const cli = join(folder(), "claude");
  writeFileSync(cli, "#!/bin/sh\necho boom >&2\nexit 1\n");
  chmodSync(cli, 0o755);
  process.env.PATH = folder();
  process.env.ANTHROPIC_API_KEY = "test-key";
  const calls: unknown[] = [];
  const registry = registryWith(() => jsonReply(500, {}), calls);
  await assert.rejects(registry.complete("cli:claude", "edit", { workspace: folder(), allow_api_fallback: false }),
    (error: Error) => error instanceof ProviderError && error.message.includes("boom"));
  assert.deepEqual(calls, []);
});

test("the registry marks a model out of quota and leaves it out of routing", async () => {
  const registry = new ProviderRegistry();
  registry.cli.availableModelIds = () => new Set(["cli:claude"]);
  const calls: string[] = [];
  registry.completeOnce = async (modelId: string) => {
    calls.push(modelId);
    throw new CliError("claude failed: Claude AI usage limit reached");
  };
  await assert.rejects(registry.complete("cli:claude", "hi"), (error: any) => {
    assert.ok(error instanceof QuotaExhausted && error.modelId === "cli:claude" && error.message.includes("额度用完"));
    return true;
  });
  assert.ok(!registry.configuredModels([]).has("cli:claude"));
  // Asked again, it does not even try until the reset.
  await assert.rejects(registry.complete("cli:claude", "hi"), QuotaExhausted);
  assert.deepEqual(calls, ["cli:claude"]);
  const [entry] = registry.quota.public();
  assert.equal(entry.model_id, "cli:claude");
});

test("how to use the tools is a system prompt for every provider", async () => {
  for (const name of ["DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]) process.env[name] = "test";
  const sent: any[] = [];
  const registry = registryWith([{ choices: [{ message: { content: "好了" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    { content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
    { candidates: [{ content: { role: "model", parts: [{ text: "done" }] } }] }], sent);
  for (const model of ["deepseek:deepseek-flash", "anthropic:claude-x", "google:gemini-x"]) await registry.complete(model, "写一个待办工具", { workspace: folder(), act: true });
  const [deepseek, anthropic, gemini] = sent;
  assert.ok(deepseek.messages[0].role === "system" && deepseek.messages[0].content.includes("Bash, Read, Write"));
  assert.deepEqual(deepseek.messages[1], { role: "user", content: "写一个待办工具" });
  assert.ok(anthropic.system[0].text.includes("Bash, Read, Write"));
  assert.deepEqual(anthropic.messages[0].content, [{ type: "text", text: "写一个待办工具", cache_control: { type: "ephemeral" } }]);
  assert.ok(gemini.systemInstruction.parts[0].text.includes("Bash, Read, Write"));
  assert.ok(deepseek.messages[0].content.includes("batch them"));
});
