// What a chat asks FluidForm to do, as tool calls instead of lines it writes
// (settings.chat_action_tools). The chat package says which tools there are and what each call
// stands for (packages/chat: StartTask, SendFile, CallEngineer, Remember, Forget); each call is noted
// as the line the chat would have written (TASK, SEND, ENGINEER, REMEMBER, FORGET) and added to the
// end of its answer (Providers.converse), so one place reads them, whichever way they were asked for.
import * as chat from "./chat.js";
import { ContextVar } from "./py.js";

export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

// The calls of the answer being written, and which tools it has: set by Providers.converse.
export const pending = new ContextVar<[string[], ReadonlySet<string>] | null>("chat_actions", null);

/** Whether ``name`` is one of the action tools of the answer being written. */
export function has(name: string): boolean {
  return Boolean(pending.get()?.[1].has(name));
}

/** The action tools for the answer being written, if any. */
export async function offered(): Promise<ToolSpec[]> {
  const current = pending.get();
  if (!current || !current[1].size) return [];
  return (await chat.ask("chat.tools", { names: [...current[1]] })).tools ?? [];
}

/** Note one call as its line; it happens after the answer. */
export async function run(name: string, args: Record<string, unknown>): Promise<[string, boolean]> {
  const current = pending.get();
  if (!current || !current[1].has(name)) return [`Error: ${name} is not available here`, false];
  const [lines, allowed] = current;
  const found = await chat.ask("chat.action", { name, args, lines, allowed: [...allowed] });
  lines.splice(0, lines.length, ...((found.lines ?? lines) as string[]));
  return [String(found.reply ?? ""), Boolean(found.ok)];
}

/** An answer with the lines its tool calls stand for at its end. */
export function withActions(text: string, lines: string[]): string {
  return lines.length ? [text.trimEnd(), ...lines].join("\n") : text;
}
