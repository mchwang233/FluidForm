// providers.ts: tests/test_providers.py, ported (those that need no executor).
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ProviderError } from "../src/budget.js";
import { settings } from "../src/config.js";
import { ModelProfileSchema } from "../src/models.js";
import * as providers from "../src/providers.js";
import { anthropicReply, deepseek, isolated, jsonReply, registryWith, WRITE_CALL } from "./helpers/providers.js";

const { folder } = isolated();

/** A spend check whose reservation caps output, as the task budget does. */
function reserving(cap: number) {
  return { asked: [] as number[], recorded: [] as number[][], allows: () => true,
    async reserve(_modelId: string, _payload: unknown, maximum: number) {
      this.asked.push(maximum);
      return Math.min(maximum, cap);
    },
    async record(_modelId: string, input: number, output: number, cached = 0) {
      this.recorded.push([input, output, cached]);
    } };
}

test("requests ask for the model's own output ceiling, and the budget can lower it", async () => {
  process.env.DEEPSEEK_API_KEY = "test";
  settings.api_agent_max_output_tokens = 32768;
  const sent: any[] = [];
  const done = deepseek({ content: "done" }, "stop");
  const registry = registryWith([done, done, done, done], sent);
  const flash = ModelProfileSchema.parse({ id: "deepseek:deepseek-flash", provider: "deepseek", display_name: "Flash", max_output_tokens: 393216 });
  Object.assign(registry.models, { [flash.id]: flash });
  const budget = reserving(2000);
  await registry.complete("deepseek:deepseek-flash", "work", { workspace: folder(), act: true });
  await registry.complete("deepseek:deepseek-flash", "work", { workspace: folder(), act: true, spend_ok: budget });
  await registry.complete("deepseek:deepseek-flash", "plain");
  // A model whose ceiling the catalog does not give gets the configured cap.
  await registry.complete("deepseek:deepseek-chat", "work", { workspace: folder(), act: true });
  assert.equal(sent[0].max_tokens, 393216);
  assert.deepEqual(budget.asked, [393216]);
  assert.equal(sent[1].max_tokens, 2000);
  assert.ok(sent[2].max_tokens === 393216 && !("tools" in sent[2]));
  assert.equal(sent[3].max_tokens, 32768);
});

test("a length-cut turn without tool calls is an error, not an empty success", async () => {
  process.env.DEEPSEEK_API_KEY = "test";
  const registry = registryWith([deepseek({ content: "", reasoning_content: "thinking..." }, "length")]);
  await assert.rejects(registry.complete("deepseek:deepseek-flash", "work", { workspace: folder(), act: true }), (error: any) => {
    assert.ok(error instanceof ProviderError && error.message.includes("截断"));
    assert.equal(error.usage.output_tokens, 4096);
    return true;
  });
});

test("thinking written into the answer is kept for the model but not returned", async () => {
  // MiniMax puts its thinking in the content as <think>...</think>: the tool loop sends it back, as
  // MiniMax asks, but the answer the platform reads (a summary, a JSON plan) leaves it out.
  process.env.MINIMAX_API_KEY = "test";
  const sent: any[] = [];
  const registry = registryWith([deepseek({ content: "<think>\nwrite it\n</think>\n", tool_calls: [WRITE_CALL] }, "tool_calls"),
    deepseek({ content: "<think>\ndone?\n</think>\n\nWrote mail.py" }, "stop"), deepseek({ content: '<think>plan</think>{"steps": []}' }, "stop")], sent);
  const acted = await registry.complete("minimax:MiniMax-M3", "work", { workspace: folder(), act: true });
  const plain = await registry.complete("minimax:MiniMax-M3", "plan");
  assert.equal(acted.text, "Wrote mail.py");
  assert.equal(plain.text, '{"steps": []}');
  assert.equal(sent[1].messages[2].content, "<think>\nwrite it\n</think>\n");
});

const breakpoints = (body: any) => [...(body.system ?? []), ...body.messages.flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))]
  .filter((block: any) => "cache_control" in block).length;

test("Anthropic tool loops read the conversation from the prompt cache", async () => {
  // Anthropic caches only up to blocks marked cache_control: the system prompt (with the tools before
  // it) and, each turn, the newest message. At most four marks are allowed, so older turns lose theirs.
  process.env.ANTHROPIC_API_KEY = "test";
  const sent: any[] = [];
  const write = { type: "tool_use", id: "t1", name: "Write", input: { file_path: "a.txt", content: "x" } };
  const registry = registryWith([anthropicReply([write], "tool_use"), anthropicReply([{ ...write, id: "t2" }], "tool_use"),
    anthropicReply([{ type: "text", text: "done" }])], sent);
  const result = await registry.complete("anthropic:claude-x", "work", { workspace: folder(), act: true });
  assert.equal(result.text, "done");
  for (const body of sent) {
    assert.deepEqual(body.system.at(-1).cache_control, { type: "ephemeral" });
    assert.deepEqual(body.messages.at(-1).content.at(-1).cache_control, { type: "ephemeral" });
    assert.equal(breakpoints(body), 2);
  }
  // The marks are added to what is sent, not kept in the conversation.
  assert.ok(!JSON.stringify(sent[2].messages.slice(0, -1)).includes("cache_control"));
});

test("each provider is asked for the effort in its own fields", async () => {
  for (const name of ["ZHIPU_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "MINIMAX_API_KEY"]) process.env[name] = "test";
  const sent: any[] = [];
  const done = deepseek({ content: "ok" }, "stop");
  const registry = registryWith([done, done, done, anthropicReply([{ type: "text", text: "ok" }]),
    { candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: {} }], sent);
  await registry.complete("glm:glm-5.3", "plan", { effort: "medium" });
  await registry.complete("openai:gpt-x", "plan", { effort: "max" });
  await registry.complete("minimax:MiniMax-M3", "plan"); // no effort asked: none sent
  await registry.complete("anthropic:claude-x", "plan", { effort: "none" });
  await registry.complete("google:gemini-x", "plan", { effort: "high" });
  assert.equal(sent[0].reasoning_effort, "high"); // GLM: low, high or max
  assert.equal(sent[1].reasoning_effort, "xhigh");
  assert.ok(!("reasoning_effort" in sent[2]));
  assert.deepEqual(sent[3].output_config, { effort: "low" });
  assert.deepEqual(sent[4].generationConfig.thinkingConfig, { thinkingLevel: "high" });
  assert.ok(sent[4].generationConfig.maxOutputTokens > 0);
});

test("a model that rejects the effort answers without it from then on", async () => {
  process.env.ZHIPU_API_KEY = "test";
  const sent: any[] = [];
  const rejected = jsonReply(400, { error: { code: "1210", message: "该模型始终思考，不支持关闭思考；请使用 low、high 或 max。" } });
  const done = deepseek({ content: "ok" }, "stop");
  const registry = registryWith([rejected, done, done], sent);
  const first = await registry.complete("glm:glm-x", "plan", { effort: "medium" });
  const second = await registry.complete("glm:glm-x", "plan", { effort: "medium" });
  assert.ok(first.text === "ok" && second.text === "ok");
  assert.equal(sent[0].reasoning_effort, "high");
  assert.ok(!("reasoning_effort" in sent[1]) && !("reasoning_effort" in sent[2]));
});

test("the full trace keeps every call and its whole output", async () => {
  // The stored tool calls keep the start of the first ones; the trace keeps everything.
  process.env.DEEPSEEK_API_KEY = "test";
  providers.limits.MAX_LOGGED_CALLS = 1;
  writeFileSync(join(folder(), "big.txt"), ("x".repeat(100) + "\n").repeat(30) + "END");
  const read = { id: "c1", type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: "big.txt" }) } };
  const log: any[] = [];
  const trace = join(folder(), "trace", "n-1.jsonl");
  const registry = registryWith([deepseek({ content: null, tool_calls: [read, { ...read, id: "c2" }] }, "tool_calls"), deepseek({ content: "done" }, "stop")]);
  await registry.complete("deepseek:deepseek-flash", "work", { workspace: folder(), act: true, tool_log: log, tool_trace: trace });
  providers.limits.MAX_LOGGED_CALLS = 300;
  assert.ok(log.length === 1 && !log[0].output.includes("END"));
  const calls = readFileSync(trace, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(calls.length === 2 && calls.every((call) => call.output.endsWith("END") && call.tool === "Read"));
});

test("tool calls continue, and reasoning goes back to DeepSeek", async () => {
  process.env.DEEPSEEK_API_KEY = "test";
  const sent: any[] = [];
  const registry = registryWith([deepseek({ content: null, reasoning_content: "plan", tool_calls: [WRITE_CALL] }, "tool_calls"),
    deepseek({ content: "Wrote mail.py" }, "stop")], sent);
  const result = await registry.complete("deepseek:deepseek-flash", "work", { workspace: folder(), act: true });
  assert.equal(result.text, "Wrote mail.py");
  assert.equal(readFileSync(join(folder(), "mail.py"), "utf8"), "ok");
  assert.equal(sent[1].messages[2].reasoning_content, "plan");
});

test("a model with a lower output ceiling is retried with a smaller cap", async () => {
  process.env.DEEPSEEK_API_KEY = "test";
  settings.api_agent_max_output_tokens = 32768;
  const sent: any[] = [];
  const rejected = () => jsonReply(400, { error: { message: "Invalid max_tokens value, the valid range of max_tokens is [1, 8192]" } });
  const registry = registryWith([rejected(), rejected(), deepseek({ content: null, tool_calls: [WRITE_CALL] }, "tool_calls"), deepseek({ content: "done" }, "stop")], sent);
  const result = await registry.complete("deepseek:deepseek-chat", "work", { workspace: folder(), act: true });
  assert.equal(result.text, "done");
  assert.deepEqual(sent.map((body) => body.max_tokens), [32768, 16384, 8192, 8192]);
});

test("Anthropic stopping at max_tokens without a tool use is an error", async () => {
  process.env.ANTHROPIC_API_KEY = "test";
  settings.api_agent_max_output_tokens = 32768;
  const sent: any[] = [];
  const registry = registryWith([{ content: [{ type: "thinking", thinking: "..." }], stop_reason: "max_tokens", usage: { input_tokens: 5, output_tokens: 32768 } }], sent);
  await assert.rejects(registry.complete("anthropic:claude-x", "work", { workspace: folder(), act: true }), /截断/);
  assert.equal(sent[0].max_tokens, 32768);
});

test("DeepSeek thinks as hard as configured", async () => {
  process.env.DEEPSEEK_API_KEY = "test";
  const sent: any[] = [];
  const done = deepseek({ content: "done" }, "stop");
  const registry = registryWith([done, done, done], sent);
  const plain = ModelProfileSchema.parse({ id: "deepseek:plain", provider: "deepseek", display_name: "Plain", supports_reasoning: false });
  Object.assign(registry.models, { [plain.id]: plain });
  await registry.complete("deepseek:deepseek-flash", "work", { workspace: folder(), act: true });
  settings.deepseek_reasoning_effort = "none";
  await registry.complete("deepseek:deepseek-flash", "plain");
  // A model known not to reason is not sent the parameter.
  await registry.complete("deepseek:plain", "plain");
  assert.equal(sent[0].reasoning_effort, "max");
  assert.equal(sent[1].reasoning_effort, "none");
  assert.ok(!("reasoning_effort" in sent[2]));
});

test("each provider reports its cache hits, and the budget hears them", async () => {
  process.env.DEEPSEEK_API_KEY = "test";
  process.env.ANTHROPIC_API_KEY = "test";
  const spend = reserving(4096);
  const registry = registryWith([
    { choices: [{ message: { content: "好了" }, finish_reason: "stop" }], usage: { prompt_tokens: 7159, completion_tokens: 20, prompt_cache_hit_tokens: 6912 } },
    { content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: { input_tokens: 300, output_tokens: 50, cache_read_input_tokens: 9000, cache_creation_input_tokens: 700 } }]);
  const ds = await registry.complete("deepseek:deepseek-flash", "hi", { spend_ok: spend });
  const claude = await registry.complete("anthropic:claude-x", "hi", { spend_ok: spend });
  assert.deepEqual([ds.input_tokens, ds.cached_input_tokens], [7159, 6912]);
  // Anthropic's input_tokens leaves out what was read from and written to the cache.
  assert.deepEqual([claude.input_tokens, claude.cached_input_tokens], [10_000, 9000]);
  assert.deepEqual(spend.recorded, [[7159, 20, 6912], [10_000, 50, 9000]]);
});

test("OpenAI-compatible cache fields", () => {
  assert.equal(providers.cachedTokens({ prompt_cache_hit_tokens: 12 }), 12);
  assert.equal(providers.cachedTokens({ prompt_tokens_details: { cached_tokens: 34 } }), 34);
  assert.equal(providers.cachedTokens({ prompt_tokens: 5 }), 0);
});
