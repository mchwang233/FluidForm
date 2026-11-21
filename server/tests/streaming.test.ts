// streaming.ts: tests/test_streaming.py (text pieces), and replies put back together.
import assert from "node:assert/strict";
import { test } from "node:test";
import { anthropic, events, gemini, openai, StreamError, textPiece } from "../src/streaming.js";

test("the reply text of each provider's stream events", () => {
  assert.equal(textPiece({ choices: [{ delta: { content: "a" } }] }), "a");
  assert.equal(textPiece({ choices: [{ delta: { reasoning_content: "r" } }] }), "");
  assert.equal(textPiece({ type: "content_block_delta", delta: { type: "text_delta", text: "b" } }), "b");
  assert.equal(textPiece({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "t" } }), "");
  assert.equal(textPiece({ candidates: [{ content: { parts: [{ text: "c" }, { text: "x", thought: true }] } }] }), "c");
  assert.equal(textPiece({ usage: {} }), "");
});

test("data lines become events; [DONE], comments and broken lines do not", () => {
  assert.deepEqual(events(["data: {\"a\":1}", ": keep-alive", "data: [DONE]", "data: {broken", "event: x", "data: [1]"]), [{ a: 1 }]);
});

test("OpenAI chunks become one completion, tool calls in pieces or whole", () => {
  const done = openai([
    { choices: [{ delta: { reasoning_content: "想" } }] },
    { choices: [{ delta: { content: "好" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "Read", arguments: "{\"file" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "_path\":\"a\"}" } }] } }] },
    // Sent whole, without an index (some providers): its id keys it; without one, it joins the last.
    { choices: [{ delta: { tool_calls: [{ id: "c2", function: { name: "LS", arguments: { path: "." } } }] }, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 3 } },
  ]);
  const message = done.choices[0].message;
  assert.deepEqual([message.content, message.reasoning_content, done.choices[0].finish_reason, done.usage],
    ["好", "想", "tool_calls", { prompt_tokens: 3 }]);
  assert.deepEqual(message.tool_calls, [
    { id: "c1", type: "function", function: { name: "Read", arguments: '{"file_path":"a"}' } },
    { id: "c2", type: "function", function: { name: "LS", arguments: '{"path": "."}' } },
  ]);
  const joined = openai([{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "A", arguments: "{}" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ function: { arguments: "" } }] } }] }]);
  assert.deepEqual(joined.choices[0].message.tool_calls.map((call: { id: string }) => call.id), ["call_0"]);
  assert.equal(openai([]).choices[0].message.content, null);
  assert.throws(() => openai([{ error: { message: "overloaded" } }]), StreamError);
});

test("Anthropic's stream becomes one message with its blocks in order", () => {
  const message = anthropic([
    { type: "message_start", message: { usage: { input_tokens: 5 } } },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t", name: "Read" } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"a\":" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "1}" } },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7, cache_read_input_tokens: null } },
  ]);
  assert.deepEqual(message, { content: [{ type: "text", text: "你好" }, { type: "tool_use", id: "t", name: "Read", input: { a: 1 } }],
    stop_reason: "tool_use", usage: { input_tokens: 5, output_tokens: 7 } });
  assert.throws(() => anthropic([{ type: "error", error: { type: "overloaded_error", message: "busy" } }]), /overloaded_error: busy/);
});

test("Gemini's chunks join neighbouring plain text and keep other parts", () => {
  const reply = gemini([
    { candidates: [{ content: { parts: [{ text: "a" }] } }] },
    { candidates: [{ content: { parts: [{ text: "b" }, { functionCall: { name: "LS" } }] } }] },
    { candidates: [{ content: { parts: [{ text: "c", thought: true }] }, finishReason: "STOP" }], usageMetadata: { total: 1 } },
  ]);
  assert.deepEqual(reply, { candidates: [{ content: { role: "model", parts: [{ text: "ab" }, { functionCall: { name: "LS" } },
    { text: "c", thought: true }] }, finishReason: "STOP" }], usageMetadata: { total: 1 } });
});
