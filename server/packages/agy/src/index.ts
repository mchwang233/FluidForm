// The Antigravity CLI (agy) as a model: what FluidForm needs to know to call it
// (server/src/model-channels.ts). Measured on agy 1.5.18; see skills/model-channel/SKILL.md.
//
// - Print mode always turns agy's own terminal sandbox on, and it cannot keep a command inside it:
//   its Auto mode lets a reviewer send commands out, and with command(*) allowed they all run outside.
//   So commands run outside it, inside FluidForm's sandbox, which is the boundary (model-channels.ts).
//   Default mode ("agentMode": "") with command(*) allowed: no reviewer, nothing waits for approval.
// - The prompt goes in on stdin as one stream-json message ("--print=" with no text): an argument
//   is limited to 128 KiB.
// - Its model is called through the proxy in the environment; with no internet it needs only HOSTS.
import { type ChannelCall, type ChannelReply, type ModelChannel, register } from "../../../src/extension-api.js";

export const MODEL = "gemini-4-neon-high";

// Its file tools may read anywhere: without read_file(/), a read outside its folder waits for an approval
// nobody gives headless, is denied, and agy ends with an empty answer (2026-11-27, a preflight's empty
// report). What it can see is FluidForm's sandbox's to decide. A repair, outside every sandbox, may write too.
const settingsFor = (repair: boolean) => JSON.stringify({ agentMode: "", enableTerminalSandbox: false,
  permissions: { allow: ["command(*)", "read_file(/)", ...(repair ? ["write_file(/)"] : [])] } });

// Where it keeps its login, conversations and settings, under the home.
export const STATE = [".gemini/antigravity-cli", ".gemini/config"];

// What it calls when it answers (measured through a logging proxy): the model, its sign-in.
export const HOSTS = ["aicode.googleapis.com", "cloudcode-pa.googleapis.com", "daily-cloudcode-pa.googleapis.com", "www.googleapis.com",
  "oauth2.googleapis.com"];

// "You have exhausted your quota on this model.", and Google's own words for it.
const QUOTA = /exhausted your quota|quota (?:exceeded|exhausted)|RESOURCE_EXHAUSTED|rate limit/i;

export function args(call: ChannelCall): string[] {
  const given = ["--print=", "--input-format", "stream-json", "--output-format", "stream-json", "--model", MODEL,
    "--disable-slash-commands", "--settings", settingsFor(Boolean(call.repair))];
  // A step edits files without asking; the lead's folder is read-only to it anyway.
  if (!call.lead) given.push("--mode", "accept-edits");
  for (const folder of call.readable) given.push("--add-dir", folder);
  if (call.sessionId) given.push("--conversation", call.sessionId);
  return given;
}

export function stdin(call: ChannelCall): string {
  return JSON.stringify({ event: "user", message: { content: call.prompt } }) + "\n";
}

/** Its answer: the last "result" event of the stream. */
export function parse(stdout: string): ChannelReply {
  let result: Record<string, any> | null = null;
  let session: string | null = null;
  // What it said along the way, by step: the answer when the result's own is empty.
  const said = new Map<number, string>();
  for (const line of stdout.split("\n")) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    if (typeof event.conversation_id === "string" && event.conversation_id) session = event.conversation_id;
    if (event.event === "result" && event.result && typeof event.result === "object") result = event.result;
    const step = event.step_update;
    if (step && step.step_type === "agent_response" && typeof step.text_delta === "string" && Number.isInteger(step.step_index)) {
      said.set(step.step_index, (said.get(step.step_index) ?? "") + step.text_delta);
    }
  }
  if (!result) return { text: "", usage: {}, sessionId: session, error: "agy printed no answer", quota: false };
  const usage = result.usage && typeof result.usage === "object" ? result.usage : {};
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const failed = result.status !== "SUCCESS";
  let text = typeof result.response === "string" ? result.response : "";
  if (!text.trim() && said.size) text = said.get(Math.max(...said.keys()))!.trim();
  // An empty answer is no answer: say what it was denied, if anything.
  const denied = Array.isArray(result.denied_actions) ? result.denied_actions.map((item: any) => item?.display_name || item?.action).filter(Boolean) : [];
  const error = failed ? String(result.error || result.finished_reason || result.status || "agy failed")
    : !text.trim() ? `agy 没有给出回答${denied.length ? `（被拒绝的操作：${[...new Set(denied)].join("、")}）` : ""}` : null;
  return {
    text,
    usage: { input_tokens: count(usage.input_tokens), output_tokens: count(usage.output_tokens), cached_input_tokens: count(usage.cache_read_tokens) },
    sessionId: (typeof result.conversation_id === "string" && result.conversation_id) || session,
    error,
    quota: Boolean(error && QUOTA.test(error)),
  };
}

export const channel: ModelChannel = {
  id: "cli:agy",
  executable: "agy",
  auth_command: ["models"],
  fallback_model_id: "google:gemini-pro",
  sessions: true,
  state: STATE,
  hosts: HOSTS,
  args,
  stdin,
  parse,
};

register(channel);
