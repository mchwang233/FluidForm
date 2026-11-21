// Shared by the tests of model calls: a ProviderRegistry whose HTTP replies are given in order
// (Python's httpx.MockTransport), and settings and environment restored after each test.
import { conftest } from "./conftest.js";
import { ProviderRegistry } from "../../src/providers.js";

/** A reply: a JSON body (status 200), or a Response as it is. */
export type Given = Record<string, unknown> | Response;
export type Sent = { url: URL; headers: Headers; body: any };

/** A registry answering each request with the next of ``replies``; ``sent`` collects the bodies. */
export function registryWith(replies: Given[] | ((request: Sent) => Given | Promise<Given>), sent: any[] = [], requests: Sent[] = []): ProviderRegistry {
  const queue = Array.isArray(replies) ? [...replies] : null;
  const registry = new ProviderRegistry();
  registry.retryBaseDelay = 0;
  registry.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const request: Sent = { url: new URL(String(input)), headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : null };
    sent.push(request.body);
    requests.push(request);
    const reply = queue ? queue.shift() : await (replies as (request: Sent) => Given | Promise<Given>)(request);
    if (reply === undefined) throw new Error("no reply left");
    return reply instanceof Response ? reply : new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return registry;
}

export const jsonReply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** An OpenAI-compatible reply (DeepSeek's form). */
export const deepseek = (message: Record<string, unknown>, finishReason: string) =>
  ({ choices: [{ message, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 4096 } });

export const anthropicReply = (blocks: unknown[], stop = "end_turn") =>
  ({ content: blocks, stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 } });

export const WRITE_CALL = { id: "c1", type: "function", function: { name: "Write", arguments: JSON.stringify({ file_path: "mail.py", content: "ok" }) } };

/** Settings, the environment and a temporary data folder as conftest gives every test. */
export function isolated(): { folder: () => string } {
  return conftest();
}
