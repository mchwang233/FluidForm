// Telling a conversation from a task, when the user leaves it to FluidForm (api.start).
// One short call to the cheapest API model (routing.briefWriter's choice). Anything that goes
// wrong, or no such model, means a task: what FluidForm did before chats existed. Either way the
// user can switch: a chat turns into a task, a task waiting for confirmation into a chat.
import * as pricing from "./pricing.js";
import { log } from "./log.js";
import type { ModelProfile } from "./models.js";
import { head, isObject, pyRegex } from "./py.js";

// The answer is a few tokens; a slow model is not worth waiting for.
export const TIMEOUT_SECONDS = 20;
// Characters of the request the model is shown.
export const MAX_REQUEST_CHARS = 4000;

/** What triage needs of the providers: one call, cancelled by ``signal``. */
export type Completer = {
  complete(modelId: string, prompt: string, options: { effort?: string; signal?: AbortSignal }):
    Promise<{ text: string | null; input_tokens: number; output_tokens: number; cached_input_tokens?: number }>;
};

export const PROMPT =
  "Classify a request a user typed into FluidForm, a tool that either chats with a model or "
  + "plans and runs a task (models change files, build, test, write documents).\n"
  + "task: it asks for work to be done or something to be produced: write, change, fix, build, "
  + "implement, generate, refactor, migrate, deploy, test, or research and write up a deliverable.\n"
  + "chat: it asks a question, an explanation, an opinion, advice or a comparison that is answered "
  + "in a reply, with nothing to produce or change.\n"
  + "If it is both or unclear, it is a task.\n"
  + 'Answer with only {"kind": "chat"} or {"kind": "task"}.\n\nRequest:\n';
const KIND = pyRegex(String.raw`"kind"\s*:\s*"(chat|task)"`);

/** ``complete`` on ``model``, at low effort, given up (and cancelled) after TIMEOUT_SECONDS. */
export async function ask(providers: Completer, model: ModelProfile, prompt: string) {
  const signal = AbortSignal.timeout(TIMEOUT_SECONDS * 1000);
  return Promise.race([
    providers.complete(model.id, prompt, { effort: "low", signal }),
    new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true })),
  ]);
}

export const costOf = (model: ModelProfile, result: Awaited<ReturnType<Completer["complete"]>>) =>
  pricing.charge(model, result.input_tokens, result.output_tokens, result.cached_input_tokens ?? 0);

/** What ``model`` answers to the chat package's question whether a group message nobody
 *  @-mentioned the assistant in is meant for it (``prompt``), and what asking cost. Anything that goes
 *  wrong, or no model, is no answer: the message is not for it. */
export async function addressed(prompt: string, providers: Completer, model: ModelProfile | null): Promise<[string, number]> {
  if (model === null) return ["", 0];
  let result;
  try {
    result = await ask(providers, model, prompt);
  } catch (error) {
    log.warning(`deciding whether to answer with ${model.id} failed: ${(error as Error).message ?? error}`);
    return ["", 0];
  }
  return [result.text || "", await pricing.countOnly(() => costOf(model, result), 0)];
}

/** "chat" only when the answer clearly says so. */
export function readKind(text: string | null | undefined): "chat" | "task" {
  const match = KIND.exec(text || "");
  if (match) return match[1] as "chat" | "task";
  let value: unknown;
  try {
    value = JSON.parse(text ?? "");
  } catch {
    return "task";
  }
  return isObject(value) && value.kind === "chat" ? "chat" : "task";
}

/** ["chat" | "task", what deciding cost]. */
export async function classify(text: string, providers: Completer, model: ModelProfile | null): Promise<["chat" | "task", number]> {
  if (model === null) return ["task", 0];
  let result;
  try {
    result = await ask(providers, model, PROMPT + head(text, MAX_REQUEST_CHARS));
  } catch (error) { // any failure leaves the request a task, as before
    log.warning(`triage with ${model.id} failed: ${(error as Error).message ?? error}`);
    return ["task", 0];
  }
  return [readKind(result.text), await costOf(model, result)];
}
