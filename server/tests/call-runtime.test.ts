// providers.ts's call records, continued conversations and compaction: their tests in
// test_call_runtime and test_continue, ported.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { BudgetExceeded, ProviderError, StepLimitExceeded } from "../src/budget.js";
import { cliUsage, codexOutput } from "../src/cli-channels.js";
import { settings } from "../src/config.js";
import * as memory from "../src/conversation.js";
import { Conversation, SUMMARY_KEYS } from "../src/conversation.js";
import { Database } from "../src/db.js";
import { CapabilityScoreSchema, ExecutionRunSchema, ModelProfileSchema } from "../src/models.js";
import { cliResult, ProviderRegistry } from "../src/providers.js";
import { PROVIDER_ENV } from "../src/secret-names.js";
import { anthropicReply, deepseek, isolated, jsonReply, registryWith } from "./helpers/providers.js";

const { folder } = isolated();
const textReply = (status: number, text: string) => new Response(text, { status, headers: { "content-type": "text/plain" } });

test("a rejected effort is visible on every affected request", async () => {
  process.env.ZHIPU_API_KEY = "test";
  const registry = registryWith([textReply(400, "unsupported reasoning_effort"), deepseek({ content: "ok" }, "stop"), deepseek({ content: "ok" }, "stop")]);
  const db = new Database(join(folder(), "calls.db"));
  const withDb = new ProviderRegistry(db);
  withDb.fetch = registry.fetch;
  withDb.retryBaseDelay = 0;
  const first = await withDb.complete("glm:test", "test", { effort: "max" });
  const second = await withDb.complete("glm:test", "test", { effort: "max" });
  assert.ok(first.warnings.length && second.warnings.length);
  const calls = [...db.modelCalls()].reverse() as any[];
  assert.equal(calls.length, 2);
  assert.equal(calls[0].requested_effort, "max");
  assert.equal(calls[0].effective_effort, "provider_default");
  assert.equal(calls[0].requests, 2);
  assert.ok(calls[1].warnings.length);
});

test("an interrupted tool's completion is unknown, not claimed unrun", () => {
  const state: any = { history: [{ role: "assistant", tool_calls: [{}] }], calls: [["a", "Bash", { command: "change" }]] };
  memory.reopen(state, "continue");
  assert.ok(state.results[0][2].toLowerCase().includes("unknown"));
});

for (const provider of ["deepseek", "anthropic", "google"]) {
  test(`the native protocol is restored after a tool was interrupted (${provider})`, async () => {
    process.env[PROVIDER_ENV[provider]] = "test";
    const state: any = { provider, calls: [["c", "Bash", { command: "do once" }]], results: null };
    let reply: Record<string, unknown>;
    if (provider === "anthropic") {
      state.history = [{ role: "user", content: "work" }, { role: "assistant", content: [{ type: "tool_use", id: "c", name: "Bash", input: { command: "do once" } }] }];
      reply = anthropicReply([{ type: "text", text: "done" }]);
    } else if (provider === "google") {
      state.history = [{ role: "user", parts: [{ text: "work" }] }, { role: "model", parts: [{ functionCall: { name: "Bash", args: { command: "do once" } } }] }];
      reply = { candidates: [{ content: { parts: [{ text: "done" }] } }], usageMetadata: {} };
    } else {
      state.history = [{ role: "user", content: "work" }, { role: "assistant", tool_calls: [{ id: "c", type: "function", function: { name: "Bash", arguments: "{}" } }] }];
      reply = deepseek({ content: "done" }, "stop");
    }
    const sent: any[] = [];
    const registry = registryWith([reply], sent);
    const conversation = new Conversation({ modelId: `${provider}:test`, state, followup: "resume safely" });
    const result = await registry.complete(conversation.modelId!, "work", { workspace: folder(), act: true, conversation });
    assert.equal(result.text, "done");
    assert.ok(JSON.stringify(sent[0]).includes(JSON.stringify(memory.UNKNOWN).slice(1, -1)));
    assert.ok(JSON.stringify(sent[0]).includes("resume safely"));
  });
}

const model = (name: string, score: number, contextWindow = 200_000) => ModelProfileSchema.parse({ id: name, provider: name.split(":")[0], display_name: name,
  channel: "api", context_window: contextWindow, input_per_million: 1, output_per_million: 1,
  scores: Object.fromEntries(Object.keys(CapabilityScoreSchema.parse({})).map((key) => [key, score])) });

function savedRun(db: Database) {
  db.saveRun(ExecutionRunSchema.parse({ id: "r", prompt: "build", status: "running", budget_usd: 10,
    plan: { summary: "build", nodes: [{ id: "n", title: "Build", instructions: "keep the public API", capability: "coding", model_id: "deepseek:test" }] } }));
}

test("structured compaction keeps the constraints and the original history", async () => {
  const db = new Database(join(folder(), "state.db"));
  savedRun(db);
  const registry = new ProviderRegistry(db, { "x:test": model("x:test", 90, 10000) });
  const state: any = { provider: "openai", history: [{ role: "user", content: "Keep API unchanged" }, { role: "tool", content: "evidence ".repeat(4000) }] };
  const conversation = new Conversation({ modelId: "x:test", state, archive: (body) => db.archiveConversation("r", "n", body) });
  const step = async (summary: any): Promise<any> => {
    assert.ok(summary.prompt.includes("evidence"));
    return [JSON.stringify(Object.fromEntries(SUMMARY_KEYS.map((key) => [key, ["important fact"]]))), [], 100, 20, false];
  };
  assert.deepEqual(await registry.compactContext("x:test", state, step, null, conversation), [100, 20, 0]);
  assert.equal(state.history[0].content, "Keep API unchanged");
  assert.ok(JSON.stringify(state.history).includes("RecallHistory archive_id="));
  assert.ok(((db.conversationArchive("r", "n", 1) as any).state.history[1].content as string).length > 10000);
  // Invalid compaction leaves the original history intact.
  state.history.push({ role: "tool", content: "original evidence".repeat(3000) });
  const before = JSON.stringify(state.history);
  const invalid = async (): Promise<any> => ['{"goals": []}', [], 10, 2, false];
  await assert.rejects(registry.compactContext("x:test", state, invalid, null, conversation), (error: Error) => error instanceof ProviderError && error.message.includes("结构验证"));
  assert.equal(JSON.stringify(state.history), before);
});

test("a summary cannot spend the last hard turn", async () => {
  const registry = new ProviderRegistry(null, { "x:test": model("x:test", 90, 1000) });
  const state: any = { history: [{ role: "tool", content: "x".repeat(10000) }] };
  const conversation = new Conversation({ state, archive: () => 1 });
  await assert.rejects(registry.compactContext("x:test", state, null as any, { allows: () => true, turnRemaining: () => 1 }, conversation), StepLimitExceeded);
});

test("CLI usage and missing usage are told apart", () => {
  const result = cliResult(codexOutput([JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 70, output_tokens: 20 } })].join("\n")), "cli:codex");
  assert.deepEqual([result.text, result.input_tokens, result.cached_input_tokens, result.usage_known], ["done", 100, 70, true]);
  assert.ok(!cliResult({ text: "plain output", usage: {} }, "cli:other").usage_known);
  assert.equal(cliUsage({ usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 } }).input_tokens, 60);
});

test("strict effort mode never retries without reasoning", async () => {
  process.env.ZHIPU_API_KEY = "test";
  settings.reasoning_fallback = "strict";
  const sent: any[] = [];
  const registry = registryWith([textReply(400, "unsupported reasoning_effort")], sent);
  await assert.rejects(registry.complete("glm:test", "work", { effort: "max" }), /禁止自动降级/);
  assert.ok(sent.length === 1 && sent[0].reasoning_effort === "max");
});

const FLASH = "deepseek:deepseek-flash";
const READ = { id: "c", type: "function", function: { name: "list_dir", arguments: JSON.stringify({ path: "." }) } };
const reply = (message: Record<string, unknown>) => ({ choices: [{ message, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });

/** A DeepSeek stand-in: answers in turn from ``replies`` and records each request's messages. */
function api(...replies: [number, Record<string, unknown> | null][]) {
  process.env.DEEPSEEK_API_KEY = "test";
  const requests: any[][] = [];
  const registry = registryWith((request) => {
    requests.push(request.body.messages);
    const [status, message] = replies.shift()!;
    return status === 200 ? reply(message!) : jsonReply(status, { error: "bad" });
  });
  return { registry, requests };
}

test("the next attempt continues the same conversation", async () => {
  const { registry, requests } = api([200, { content: null, tool_calls: [READ] }], [200, { content: "第一次做完了" }], [200, { content: "按要求改好了" }]);
  const conversation = new Conversation();
  await registry.complete(FLASH, "写一个工具", { workspace: folder(), act: true, conversation });
  conversation.followup = "验证没通过：补上空文件的处理";
  const result = await registry.complete(FLASH, "写一个工具（重新开始）", { workspace: folder(), act: true, conversation });
  const sent = requests.at(-1)!;
  assert.equal(result.text, "按要求改好了");
  assert.deepEqual(sent.map((m) => m.role), ["system", "user", "assistant", "tool", "assistant", "user"]);
  assert.ok(sent[4].content === "第一次做完了" && sent[5].content === "验证没通过：补上空文件的处理");
  assert.ok(!JSON.stringify(sent).includes("重新开始"));
});

test("calls that never ran are closed before continuing", async () => {
  const { registry, requests } = api([200, { content: null, tool_calls: [READ] }], [200, { content: "继续做完了" }]);
  const checks = [true, false]; // the budget runs out right after the model asked for a tool
  const conversation = new Conversation();
  await assert.rejects(registry.complete(FLASH, "写一个工具", { workspace: folder(), act: true, conversation,
    spend_ok: { allows: () => checks.shift() ?? true } }), BudgetExceeded);
  conversation.followup = "预算已追加，接着做";
  await registry.complete(FLASH, "写一个工具", { workspace: folder(), act: true, conversation });
  const sent = requests.at(-1)!;
  assert.deepEqual(sent.map((m) => m.role), ["system", "user", "assistant", "tool", "user"]);
  assert.equal(sent[3].content, memory.UNKNOWN);
});

test("a conversation the provider refuses starts afresh", async () => {
  const { registry, requests } = api([200, { content: "做完了" }], [400, null], [200, { content: "重新做完了" }]);
  const conversation = new Conversation();
  await registry.complete(FLASH, "写一个工具", { workspace: folder(), act: true, conversation });
  conversation.followup = "再改一下";
  const result = await registry.complete(FLASH, "写一个工具（完整说明）", { workspace: folder(), act: true, conversation });
  assert.equal(result.text, "重新做完了");
  assert.deepEqual(requests.at(-1)!.map((m) => m.role), ["system", "user"]);
  assert.ok(requests.at(-1)![1].content.includes("完整说明"));
});
