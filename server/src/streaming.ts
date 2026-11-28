// Model replies as streams of server-sent events, put back together into the reply the provider
// would have sent without streaming, so the code reading replies stays the same.
//
// Streaming lets a long reply be told apart from a dead one: a model that thinks for many minutes
// keeps sending data, a provider that hangs sends nothing (ProviderRegistry.post).
import { ContextVar, head, isObject, pyDumps } from "./py.js";

type Json = Record<string, any>;

// Who hears a reply's text as it comes, in this context: called with all of it so far, once per
// piece (a new call starts again from its first piece). null: nobody (most calls).
export const listener = new ContextVar<((text: string) => void) | null>("reply_listener", null);

const list = (value: unknown): any[] => (Array.isArray(value) ? value : []);

/** The reply text one streamed event adds, in any of the three formats; "" for anything else
 *  (reasoning, tool calls, usage). */
export function textPiece(payload: Json): string {
  for (const choice of list(payload.choices)) { // OpenAI and those compatible with it
    const delta = choice?.delta || {};
    if (typeof delta.content === "string") return delta.content;
  }
  if (payload.type === "content_block_delta") { // Anthropic
    const delta = payload.delta || {};
    return delta.type === "text_delta" ? delta.text || "" : "";
  }
  for (const candidate of list(payload.candidates).slice(0, 1)) { // Gemini
    return list((candidate?.content || {}).parts)
      .filter((part) => typeof part?.text === "string" && !part.thought).map((part) => part.text).join("");
  }
  return "";
}

/** The provider reported an error inside the stream (for example Anthropic's overloaded_error). */
export class StreamError extends Error {
  override name = "StreamError";
}

/** The JSON payloads of a stream's ``data:`` lines; OpenAI's closing ``[DONE]`` is not one. */
export function events(lines: string[]): Json[] {
  const found: Json[] = [];
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const payload = JSON.parse(data);
      if (isObject(payload)) found.push(payload);
    } catch {
      // not JSON: skipped
    }
  }
  return found;
}

/** Chat completion chunks (OpenAI and the providers compatible with it) as one completion. */
export function openai(chunks: Json[]): Json {
  const content: string[] = [];
  const reasoning: string[] = [];
  const calls = new Map<unknown, Json>();
  let finish: unknown = null;
  let usage: Json = {};
  let last: unknown = null;
  for (const chunk of chunks) {
    if (chunk.error) throw new StreamError(head(pyDumps(chunk.error, false), 300));
    if (chunk.usage) usage = chunk.usage;
    for (const choice of list(chunk.choices)) {
      const delta = choice.delta || choice.message || {};
      if (typeof delta.content === "string") content.push(delta.content);
      if (typeof delta.reasoning_content === "string") reasoning.push(delta.reasoning_content);
      for (const call of list(delta.tool_calls)) {
        // Each call is sent in pieces under its index; some providers send it whole, without one.
        let key = call.index ?? null;
        if (key === null) key = call.id || last;
        if (!calls.has(key)) calls.set(key, { id: null, type: "function", function: { name: "", arguments: "" } });
        last = key;
        const slot = calls.get(key)!;
        const fn = call.function || {};
        slot.id = call.id || slot.id;
        slot.function.name = slot.function.name || fn.name || "";
        const args = fn.arguments;
        if (isObject(args)) slot.function.arguments = pyDumps(args, false);
        else if (args) slot.function.arguments += args;
      }
      finish = choice.finish_reason || finish;
    }
  }
  const message: Json = { role: "assistant", content: content.length ? content.join("") : null };
  if (reasoning.length) message.reasoning_content = reasoning.join("");
  if (calls.size) {
    message.tool_calls = [...calls.values()].map((call, index) => ({ ...call, id: call.id || `call_${index}` }));
  }
  return { choices: [{ message, finish_reason: finish }], usage };
}

/** Anthropic's message stream as one message: its content blocks, stop reason and usage. */
export function anthropic(items: Json[]): Json {
  const blocks = new Map<number, Json>();
  const partial = new Map<number, string>();
  const usage: Json = {};
  let stop: unknown = null;
  for (const item of items) {
    const kind = item.type;
    if (kind === "error") {
      const error = item.error || {};
      throw new StreamError(head(`${error.type ?? "error"}: ${error.message ?? ""}`, 300));
    }
    if (kind === "message_start") Object.assign(usage, (item.message || {}).usage || {});
    else if (kind === "content_block_start") blocks.set(item.index, { ...(item.content_block || {}) });
    else if (kind === "content_block_delta") {
      if (!blocks.has(item.index)) blocks.set(item.index, {});
      const block = blocks.get(item.index)!;
      const delta = item.delta || {};
      if (delta.type === "input_json_delta") partial.set(item.index, (partial.get(item.index) ?? "") + (delta.partial_json || ""));
      for (const field of ["text", "thinking", "signature"]) {
        if (field in delta) block[field] = (block[field] ?? "") + delta[field];
      }
    } else if (kind === "message_delta") {
      stop = (item.delta || {}).stop_reason || stop;
      for (const [key, value] of Object.entries(item.usage || {})) if (value !== null && value !== undefined) usage[key] = value;
    }
  }
  for (const [index, text] of partial) {
    let input: unknown = {};
    try {
      input = text.trim() ? JSON.parse(text) : {};
      if (!isObject(input)) input = { __invalid__: text };
    } catch {
      input = { __invalid__: text };
    }
    blocks.get(index)!.input = input;
  }
  return { content: [...blocks.keys()].sort((a, b) => a - b).map((index) => blocks.get(index)), stop_reason: stop, usage };
}

const onlyText = (part: Json) => Object.keys(part).length === 1 && "text" in part;

/** Gemini's streamed responses as one: their parts in order (neighbouring plain text joined),
 *  the last finish reason and usage. */
export function gemini(chunks: Json[]): Json {
  const parts: Json[] = [];
  let finish: unknown = null;
  let usage: Json = {};
  for (const chunk of chunks) {
    if (chunk.error) throw new StreamError(head(pyDumps(chunk.error, false), 300));
    usage = chunk.usageMetadata || usage;
    for (const candidate of list(chunk.candidates).slice(0, 1)) {
      finish = candidate.finishReason || finish;
      for (const part of list((candidate.content || {}).parts)) {
        if (onlyText(part) && parts.length && onlyText(parts[parts.length - 1])) {
          parts[parts.length - 1] = { text: parts[parts.length - 1].text + part.text };
        } else parts.push({ ...part });
      }
    }
  }
  const candidate: Json = { content: { role: "model", parts } };
  if (finish) candidate.finishReason = finish;
  return { candidates: [candidate], usageMetadata: usage };
}

export type Assemble = (items: Json[]) => Json;
