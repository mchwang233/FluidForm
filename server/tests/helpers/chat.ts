// The chat package (server/packages/chat) answering in the test process: every test chats with the
// package's own code, as FluidForm does over JSON-RPC (services.ts), without a process for each.
// Requests and answers go through JSON, as on the wire; what it remembers is kept in the test's data
// folder. tests/chat-package.test.ts runs it as a real service; ``withoutChat`` switches it off.
import * as chat from "../../src/chat.js";
import { settings } from "../../src/config.js";
// @ts-expect-error: the package is plain JavaScript, with no types
import { methods } from "../../packages/chat/chat.mjs";

const wire = (value: unknown) => JSON.parse(JSON.stringify(value ?? {}));

export function inProcess(): void {
  chat.deps.enabled = () => true;
  chat.deps.ask = async (method, params) => {
    const answer = (methods(settings.data_dir) as Record<string, (params: unknown) => unknown>)[method];
    if (!answer) throw new Error(`聊天包没有 ${method}`);
    return wire(answer(wire(params)));
  };
}

/** For the calling test only: FluidForm with no chat package. */
export function withoutChat(): () => void {
  const saved = { ...chat.deps };
  chat.deps.enabled = () => false;
  return () => Object.assign(chat.deps, saved);
}
