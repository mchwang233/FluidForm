// Streamed replies in providers.ts: tests/test_streaming.py, ported.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { settings } from "../src/config.js";
import { pyDumps } from "../src/py.js";
import { ModelUnavailable } from "../src/quota.js";
import * as streaming from "../src/streaming.js";
import { isolated, registryWith, type Sent } from "./helpers/providers.js";

const { folder } = isolated();
const WRITE = pyDumps({ file_path: "a.txt", content: "hi" });
const sse = (...payloads: unknown[]) => payloads.map((item) => `data: ${typeof item === "string" ? item : pyDumps(item)}\n\n`).join("");

/** A streamed reply sent piece by piece, ``delay`` seconds apart; after ``stallAfter`` pieces it goes silent. */
function streamed(body: string, delay = 0, stallAfter: number | null = null): Response {
  const pieces = body.split("\n\n").filter(Boolean).map((line) => line + "\n\n");
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index >= pieces.length) return controller.close();
      if (stallAfter !== null && index === stallAfter) await new Promise((done) => setTimeout(done, 30_000).unref());
      if (delay) await new Promise((done) => setTimeout(done, delay * 1000));
      controller.enqueue(new TextEncoder().encode(pieces[index]));
      index += 1;
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("an OpenAI-compatible stream is put back together", async () => {
  process.env.DEEPSEEK_API_KEY = "test";
  const sent: any[] = [];
  const first = sse({ choices: [{ delta: { reasoning_content: "write " } }] }, { choices: [{ delta: { reasoning_content: "it" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "Write", arguments: WRITE.slice(0, 10) } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: WRITE.slice(10) } }] }, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60 } }, "[DONE]");
  const second = sse({ choices: [{ delta: { content: "Wrote " } }] }, { choices: [{ delta: { content: "a.txt" }, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 150, completion_tokens: 5 } }, "[DONE]");
  const registry = registryWith([streamed(first), streamed(second)], sent);
  const result = await registry.complete("deepseek:deepseek-flash", "work", { workspace: folder(), act: true });
  assert.equal(readFileSync(join(folder(), "a.txt"), "utf8"), "hi");
  assert.deepEqual([result.text, result.input_tokens, result.output_tokens, result.cached_input_tokens], ["Wrote a.txt", 250, 25, 60]);
  assert.ok(sent[0].stream === true);
  assert.deepEqual(sent[0].stream_options, { include_usage: true });
  const reply = sent[1].messages[2];
  assert.equal(reply.reasoning_content, "write it");
  assert.equal(reply.tool_calls[0].function.arguments, WRITE);
});

test("a long reply that keeps coming is not stopped", async () => {
  // Longer in all than the deadline, but never silent for it: a model thinking hard.
  process.env.DEEPSEEK_API_KEY = "test";
  settings.api_reply_deadline = 0.3;
  const chunks = Array.from({ length: 8 }, () => ({ choices: [{ delta: { reasoning_content: "." } }] }));
  const body = sse(...chunks, { choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }, "[DONE]");
  const result = await registryWith([streamed(body, 0.1)]).complete("deepseek:deepseek-flash", "plan");
  assert.equal(result.text, "done");
});

test("a reply that goes silent is stopped and its model steps aside", async () => {
  process.env.DEEPSEEK_API_KEY = "test";
  settings.api_reply_deadline = 0.2;
  const body = sse({ choices: [{ delta: { content: "start" } }] }, { choices: [{ delta: { content: " more" } }] });
  const sent: any[] = [];
  const registry = registryWith([streamed(body, 0, 1)], sent);
  await assert.rejects(registry.complete("deepseek:deepseek-flash", "work", { workspace: folder(), act: true }),
    (error: Error) => error instanceof ModelUnavailable && error.message.includes("中途停了"));
  assert.equal(sent.length, 1);
});

test("an Anthropic stream is put back together, and its errors count", async () => {
  process.env.ANTHROPIC_API_KEY = "test";
  const write = pyDumps({ file_path: "a.txt", content: "hi" });
  const first = sse({ type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "Write", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: write.slice(0, 9) } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: write.slice(9) } },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } }, { type: "message_stop" });
  const second = sse({ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } });
  const overloaded = sse({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
  const sent: any[] = [];
  const registry = registryWith([streamed(first), streamed(second), streamed(overloaded)], sent);
  const result = await registry.complete("anthropic:claude-x", "work", { workspace: folder(), act: true });
  await assert.rejects(registry.complete("anthropic:claude-x", "plan"), ModelUnavailable);
  assert.equal(readFileSync(join(folder(), "a.txt"), "utf8"), "hi");
  assert.deepEqual([result.text, result.input_tokens, result.output_tokens], ["done", 105, 32]);
  assert.equal(sent[0].stream, true);
  assert.deepEqual(sent[1].messages[1].content[0], { type: "thinking", thinking: "plan", signature: "sig" });
});

test("a Gemini stream is put back together", async () => {
  process.env.GEMINI_API_KEY = "test";
  const first = sse({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "LS", args: {} }, thoughtSignature: "s" }] } }] },
    { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } });
  const second = sse({ candidates: [{ content: { parts: [{ text: "Found " }] } }] },
    { candidates: [{ content: { parts: [{ text: "it" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 } });
  const sent: any[] = [];
  const requests: Sent[] = [];
  const registry = registryWith([streamed(first), streamed(second)], sent, requests);
  const result = await registry.complete("google:gemini-x", "List files", { workspace: folder(), act: true });
  assert.deepEqual([result.text, result.input_tokens, result.output_tokens], ["Found it", 7, 3]);
  assert.ok(requests[0].url.pathname.endsWith(":streamGenerateContent") && requests[0].url.searchParams.get("alt") === "sse");
  assert.equal(sent[1].contents[1].parts[0].thoughtSignature, "s");
});

test("who waits for a reply hears its text as it comes, not its reasoning", async () => {
  process.env.DEEPSEEK_API_KEY = "test";
  const body = sse({ choices: [{ delta: { reasoning_content: "想一想" } }] }, { choices: [{ delta: { content: "**WAL** 是" } }] },
    { choices: [{ delta: { content: "预写日志。" }, finish_reason: "stop" }] }, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }, "[DONE]");
  const heard: string[] = [];
  const registry = registryWith([streamed(body)]);
  const result = await streaming.listener.run((text) => heard.push(text), () => registry.complete("deepseek:deepseek-flash", "WAL 是什么", { workspace: folder() }));
  assert.deepEqual(heard, ["**WAL** 是", "**WAL** 是预写日志。"]);
  assert.equal(result.text, "**WAL** 是预写日志。");
});

test("who shows the work hears each tool call as it starts", async () => {
  process.env.DEEPSEEK_API_KEY = "test";
  const first = sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "Write", arguments: WRITE } }] }, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }, "[DONE]");
  const second = sse({ choices: [{ delta: { content: "写好了" }, finish_reason: "stop" }] }, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }, "[DONE]");
  const registry = registryWith([streamed(first), streamed(second)]);
  const started: unknown[] = [];
  const log = Object.assign([] as any[], { starting: (name: string, detail: string) => started.push([name, detail, existsSync(join(folder(), "a.txt"))]) });
  await registry.complete("deepseek:deepseek-flash", "work", { workspace: folder(), act: true, tool_log: log });
  // Told before the tool ran, then given its result.
  assert.deepEqual(started, [["Write", "a.txt (2 bytes)", false]]);
  assert.deepEqual(log.map((entry) => entry.tool), ["Write"]);
  assert.equal(log[0].ok, true);
});

test("Gemini excludes thought parts from final text and sends key via header, and Anthropic rejects truncated tool JSON", async () => {
  process.env.GEMINI_API_KEY = "secret-gemini-key";
  const body = sse(
    { candidates: [{ content: { role: "model", parts: [{ text: "internal reasoning", thought: true }, { text: '{"passed": true}' }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4, thoughtsTokenCount: 6 } },
  );
  const requests: Sent[] = [];
  const res = await registryWith([streamed(body)], [], requests).complete("google:gemini-x", "review");
  assert.equal(res.text, '{"passed": true}');
  assert.equal(requests[0].url.searchParams.get("key"), null);
  assert.equal(requests[0].headers.get("x-goog-api-key"), "secret-gemini-key");

  const assembled = streaming.anthropic([
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "LS", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path": "src' } },
    { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 10 } },
  ]);
  assert.ok("__invalid__" in assembled.content[0].input);
});
