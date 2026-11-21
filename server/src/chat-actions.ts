// What a chat asks FluidForm to do, as tool calls instead of lines it writes
// (settings.chat_action_tools).
//
// A chat model with tools (supervisor.chat_tools) gets StartTask, SendFile, CallEngineer, and with
// settings.user_memory Remember and Forget. Each call is noted as the line the chat would have
// written (TASK, SEND, ENGINEER, REMEMBER, FORGET) and added to the end of its answer
// (Providers.converse), so one place reads them, whichever way they were asked for.
import { ContextVar, pyDumps } from "./py.js";

export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

export const TOOLS: Record<string, ToolSpec> = {
  StartTask: {
    name: "StartTask",
    description:
      "Has FluidForm plan and do bigger work as a task (a program, a document of several parts, "
      + "long research), after your answer. The request is all the planner sees besides this "
      + "conversation: write in it everything it depends on that was said or sent here (what, for "
      + "whom, style, constraints, which pictures). Say in your answer what you are having planned. "
      + "At most once per answer; never for what you can answer or do yourself.",
    parameters: { type: "object", properties: {
      request: { type: "string", description: "The work, complete and self-contained" },
    }, required: ["request"] },
  },
  SendFile: {
    name: "SendFile",
    description: "Sends the person a picture or a file you saved in your folder, with your answer. "
      + "At most 5 per answer; a picture as png or jpg.",
    parameters: { type: "object", properties: {
      name: { type: "string", description: "Its name in your folder, e.g. avatar.png" },
    }, required: ["name"] },
  },
  CallEngineer: {
    name: "CallEngineer",
    description: "Brings FluidForm's platform engineer into this conversation, to repair FluidForm "
      + "itself or add a capability it lacks. Only when the person asks for it, or FluidForm "
      + "itself is at fault.",
    parameters: { type: "object", properties: {
      kind: { type: "string", enum: ["repair", "component"] },
      request: { type: "string", description: "What to repair or add, why, and the evidence" },
    }, required: ["kind", "request"] },
  },
  Remember: {
    name: "Remember",
    description: "Keeps a lasting fact or preference someone told you (how they like answers, their "
      + "role, what they work on), for later conversations here. Never a secret.",
    parameters: { type: "object", properties: {
      fact: { type: "string", description: "<who>: <the fact, one short sentence>" },
    }, required: ["fact"] },
  },
  Forget: {
    name: "Forget",
    description: "Drops a fact you kept that they corrected or asked you to forget.",
    parameters: { type: "object", properties: {
      words: { type: "string", description: "Words from that fact" },
    }, required: ["words"] },
  },
};

// The calls of the answer being written, and which tools it has: set by Providers.converse.
export const pending = new ContextVar<[string[], ReadonlySet<string>] | null>("chat_actions", null);
export const MAX_SENDS = 5;

/** The action tools for the answer being written, if any. */
export function offered(): ToolSpec[] {
  const current = pending.get();
  return Object.keys(TOOLS).filter((name) => current && current[1].has(name)).map((name) => TOOLS[name]);
}

/** Note one call as its line; it happens after the answer. */
export function run(name: string, args: Record<string, unknown>): [string, boolean] {
  const current = pending.get();
  if (!current || !current[1].has(name)) return [`Error: ${name} is not available here`, false];
  const [lines] = current;
  const text = typeof args.request === "string" ? args.request.trim() : "";
  if (name === "StartTask") {
    if (!text) return ["Error: request is required", false];
    if (lines.some((line) => line.startsWith("TASK:"))) return ["Error: one task per answer; put everything in the first request", false];
    lines.push("TASK: " + pyDumps({ request: text }, false));
    return ["Noted: FluidForm plans it after your answer. Say in your answer what you are having planned.", true];
  }
  if (name === "SendFile") {
    const file = args.name;
    if (typeof file !== "string" || !file.trim() || file.includes("\n")) return ["Error: name is required", false];
    if (lines.filter((line) => line.startsWith("SEND:")).length >= MAX_SENDS) return [`Error: at most ${MAX_SENDS} files per answer`, false];
    lines.push(`SEND: ${file.trim()}`);
    return ["Noted: it is sent with your answer.", true];
  }
  if (name === "Remember" || name === "Forget") {
    const value = args[name === "Remember" ? "fact" : "words"];
    if (typeof value !== "string" || !value.trim() || value.trim().includes("\n")) return ["Error: one line of text is required", false];
    lines.push(`${name === "Remember" ? "REMEMBER" : "FORGET"}: ${value.trim()}`);
    return ["Noted.", true];
  }
  if (!text) return ["Error: request is required", false];
  const kind = args.kind === "repair" || args.kind === "component" ? args.kind : "repair";
  lines.push("ENGINEER: " + pyDumps({ kind, request: text }, false));
  return ["Noted: the platform engineer joins this conversation after your answer.", true];
}

/** An answer with the lines its tool calls stand for at its end. */
export function withActions(text: string, lines: string[]): string {
  return lines.length ? [text.trimEnd(), ...lines].join("\n") : text;
}
