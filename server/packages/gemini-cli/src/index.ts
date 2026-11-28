// Gemini CLI (gemini) as a model: what FluidForm needs to know to call it (server/src/model-channels.ts).
// Called as it was before it became a package: the prompt as the -p argument, JSON output. Every call
// now runs in FluidForm's sandbox for it (before, unsandboxed). Not measured on a real gemini yet
// (none was installed): STATE and HOSTS are its documented login folder and API hosts; check them
// with skills/model-channel/SKILL.md once it is installed.
import { type ChannelCall, type ChannelReply, type ModelChannel, register } from "../../../src/extension-api.js";

// Where it keeps its login and settings, under the home.
export const STATE = [".gemini"];

// What it calls its model at: all a call without the internet reaches.
export const HOSTS = ["generativelanguage.googleapis.com", "cloudcode-pa.googleapis.com", "oauth2.googleapis.com", "www.googleapis.com"];

export const MAX_ARG_PROMPT_BYTES = 100_000;

export function args(call: ChannelCall): string[] {
  return ["-p", Buffer.byteLength(call.prompt, "utf8") > MAX_ARG_PROMPT_BYTES ? "" : call.prompt, "--output-format", "json"];
}

export function stdin(call: ChannelCall): string | null {
  return Buffer.byteLength(call.prompt, "utf8") > MAX_ARG_PROMPT_BYTES ? call.prompt : null;
}

/** Its answer: the JSON it printed ("response", or "result"/"text"), or the text as it is. */
export function parse(stdout: string): ChannelReply {
  const text = stdout.trim();
  let payload: any = null;
  try {
    payload = JSON.parse(text);
  } catch {
    // not JSON: the text as it is
  }
  if (!payload || typeof payload !== "object") return { text, usage: {}, sessionId: null, error: null, quota: false };
  const usage = payload.usage && typeof payload.usage === "object" ? payload.usage : null;
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const cached = usage ? count(usage.cache_read_input_tokens) ?? 0 : 0;
  const parsedUsage = usage && "input_tokens" in usage && "output_tokens" in usage
    ? { input_tokens: (count(usage.input_tokens) ?? 0) + cached, output_tokens: count(usage.output_tokens), cached_input_tokens: cached } : {};
  if (payload.error) {
    const errText = typeof payload.error === "string" ? payload.error
      : typeof payload.error?.message === "string" ? payload.error.message : JSON.stringify(payload.error);
    return { text: "", usage: parsedUsage, sessionId: null, error: errText, quota: /quota|rate.?limit|resource_exhausted|429/i.test(errText) };
  }
  const picked = payload.result !== undefined && payload.result !== null ? payload.result
    : payload.response !== undefined && payload.response !== null ? payload.response
    : payload.text !== undefined && payload.text !== null ? payload.text : text;
  return {
    text: String(picked),
    usage: parsedUsage,
    sessionId: null,
    error: null,
    quota: false,
  };
}

export const channel: ModelChannel = {
  id: "cli:gemini",
  executable: "gemini",
  auth_command: ["--version"],
  fallback_model_id: "google:gemini-pro",
  sessions: false,
  state: STATE,
  hosts: HOSTS,
  args,
  stdin,
  parse,
};

register(channel);
