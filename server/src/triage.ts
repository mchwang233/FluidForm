// Telling a conversation from a task, when the user leaves it to FluidForm (api.start).
// One short call to the cheapest API model (routing.briefWriter's choice). Anything that goes
// wrong, or no such model, means a task: what FluidForm did before chats existed. Either way the
// user can switch: a chat turns into a task, a task waiting for confirmation into a chat.
import * as pricing from "./pricing.js";
import { log } from "./log.js";
import type { ModelProfile } from "./models.js";
import { head, isObject, pyRegex, pyStr, splitlines, tail } from "./py.js";

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
async function ask(providers: Completer, model: ModelProfile, prompt: string) {
  const signal = AbortSignal.timeout(TIMEOUT_SECONDS * 1000);
  return Promise.race([
    providers.complete(model.id, prompt, { effort: "low", signal }),
    new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true })),
  ]);
}

const costOf = (model: ModelProfile, result: Awaited<ReturnType<Completer["complete"]>>) =>
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
  return [result.text || "", await costOf(model, result)];
}

const quickPrompt = (text: string) =>
  "Is this request work that one capable model can do by itself in one go, in a few minutes, with "
  + "a sandbox, the internet and an image tool, without anyone's project files: make one picture, "
  + "write one short document, convert or calculate something, look something up and summarise it, or "
  + "write one small program that stands on its own (a small game, a script, one web page)? "
  + "Not quick: several deliverables, larger software to build or change, long research, anything needing "
  + "the user's existing files, or anything unclear.\n"
  + 'Answer with only JSON: {"quick": true or false, "title": "a short title in the request\'s language", '
  + '"capability": "coding | research | chinese | tool_use | structured_output | planning", '
  + `"needs_images": true or false, "acceptance": "how to tell it is done, one sentence"}\n\nRequest:\n${text}`;

// With settings.solo_tasks: also work one model can carry through by itself with tools, at length.
const shapePrompt = (text: string, project: string, inProject: string) =>
  `How should this request be done? It goes to models with a sandbox, the internet, an image tool${project}.\n`
  + "- quick: one model in one go, a few minutes, without anyone's project files: one picture, one short "
  + "document, a conversion or calculation, look something up and summarise it, or one small program that "
  + "stands on its own (a small game such as snake, a script, a calculator, one web page).\n"
  + "- solo: one capable model carrying it through by itself with its tools, step after step, in up to an "
  + "hour: one coherent piece of work with one result that takes real work, such as fixing a bug, adding "
  + `one feature, a program of several parts, or one report from research${inProject}.\n`
  + "- plan: anything else: several separate deliverables, a system with several parts, work needing "
  + "several kinds of expertise in turn, or anything unclear. When unsure, plan.\n"
  + 'Answer with only JSON: {"shape": "quick | solo | plan", "title": "a short title in the request\'s language", '
  + '"capability": "coding | research | chinese | tool_use | structured_output | planning", '
  + `"needs_images": true or false, "acceptance": "how to tell it is done, one sentence"}\n\nRequest:\n${text}`;

export const QUICK_CAPABILITIES = new Set(["coding", "research", "chinese", "tool_use", "structured_output", "planning"]);
const OBJECT = pyRegex(String.raw`\{.*\}`, "s");

export type QuickStep = { shape: string; title: string; capability: string; needs_images: boolean; acceptance: string };

/** Whether a task is quick (one step, no plan needed), and the step if so; what deciding cost.
 *  With ``solo``, also whether one model can carry it through alone (shape "solo"); a task in a
 *  ``project`` can only be that. Anything unclear, or going wrong, means it is planned as usual (null). */
export async function quick(text: string, providers: Completer, model: ModelProfile | null, solo = false,
  project = false): Promise<[QuickStep | null, number]> {
  if (model === null || (project && !solo)) return [null, 0];
  const request = head(text, MAX_REQUEST_CHARS);
  const prompt = solo ? shapePrompt(request, project ? " and the user's project folder" : "", project ? " in the user's project" : "")
    : quickPrompt(request);
  let result;
  try {
    result = await ask(providers, model, prompt);
  } catch (error) {
    log.warning(`judging whether a task is quick with ${model.id} failed: ${(error as Error).message ?? error}`);
    return [null, 0];
  }
  const cost = await costOf(model, result);
  const found = OBJECT.exec(result.text || "");
  let step: unknown = null;
  try {
    step = found ? JSON.parse(found[0]) : null;
  } catch {
    step = null;
  }
  if (!isObject(step)) return [null, cost];
  const shape = solo ? step.shape : step.quick === true ? "quick" : null;
  if (!(project ? ["solo"] : ["quick", "solo"]).includes(shape as string)) return [null, cost];
  return [{
    shape: shape as string,
    title: head(pyStr(step.title || splitlines(text)[0] || ""), 80).trim() || "任务",
    capability: QUICK_CAPABILITIES.has(step.capability as string) ? (step.capability as string) : "tool_use",
    needs_images: step.needs_images === true,
    acceptance: head(pyStr(step.acceptance || ""), 500),
  }, cost];
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
