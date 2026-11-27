// Whether a task needs a plan at all: one quick step, or one model carrying it through alone.
import {
  ask, type Completer, costOf, head, isObject, log, MAX_REQUEST_CHARS, type ModelProfile, pyRegex, pyStr, splitlines
} from "../../../src/extension-api.js";

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
