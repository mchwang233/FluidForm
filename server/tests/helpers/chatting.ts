// test_chat.py's chatting and triaging: API models that talk, the cheap one that tells a chat from a
// task, and a stub planner.
import type { Dialogue } from "../../src/providers.js";
import type { Attachment, ModelProfile, SupervisorSession } from "../../src/models.js";
import { ModelProfileSchema, TaskPlanSchema } from "../../src/models.js";
import { type ChatTools, ProviderResult } from "../../src/providers.js";
import type { taskApi } from "./task-api.js";

export const profile = (id: string, planning: number) => ModelProfileSchema.parse({ id, provider: "x", display_name: id.toUpperCase(), channel: "api",
  context_window: 1_000_000, input_per_million: 1, output_per_million: 1, execution_priority: 100, scores: { coding: 90, planning, reliability: 90 } });
export const BEST = profile("x:best", 95);
export const OTHER = profile("x:other", 80);
export const CHEAP = ModelProfileSchema.parse({ id: "x:cheap", provider: "x", display_name: "Cheap", channel: "api", context_window: 1_000_000, input_per_million: 0.1,
  output_per_million: 0.1, execution_priority: 10, scores: { coding: 50, planning: 50, reliability: 80 } });

export type Api = ReturnType<typeof taskApi>["api"];
export type ConverseOptions = { attachments?: Attachment[]; tools?: ChatTools | null; dialogue?: Dialogue | null };
/** (model, cwd, prompt) of every message sent; ``attached``: the attachment names of each. */
export type Sent = [string | null, string | null, string][] & { attached: string[][]; planned: string[] };

export const answered = (api: Api, runId: string) => api.executor.leadTasks.get(runId)!.promise;

export function useModels(api: Api, models: Record<string, ModelProfile>): void {
  // One catalog, as the API's: what a test adds to it, every part sees.
  api.models = models;
  Object.assign(api.executor, { modelLookup: models });
  api.providers.configuredModels = () => new Set(Object.keys(models));
}

/** Two API models that can talk; returns what was sent to them. */
export function chatting(api: Api, answers: string[] = ["好的。"]): Sent {
  const sent = Object.assign([], { attached: [] as string[][], planned: [] as string[] }) as Sent;
  const replies = [...answers];
  useModels(api, { [BEST.id]: BEST, [OTHER.id]: OTHER });
  api.providers.converse = async (session: SupervisorSession, prompt: string, options: ConverseOptions = {}) => {
    // All the model is told: for an API model the system prompt and the turns before, then the message
    // (without the time put before it).
    const asked = prompt.replace(/^（现在：[^）]*）\n\n/, "");
    const before = options.dialogue ? [options.dialogue.system, ...options.dialogue.messages.map((item) => item.content)] : [];
    sent.push([session.model_id, session.cwd, [...before, asked].join("\n\n")]);
    sent.attached.push((options.attachments ?? []).map((item) => item.name));
    session.calls += 1;
    return new ProviderResult(replies.length ? replies.shift()! : "嗯。", 10, 10);
  };
  return sent;
}

/** ``chatting``, plus the cheap model that tells a chat from a task and a stub planner, whose prompts
 *  are ``sent.planned``. */
export function triaging(api: Api, verdict: string | Error, answers: string[] = ["好的。"]): [Sent, [string, string][]] {
  const sent = chatting(api, answers);
  useModels(api, { ...api.models, [CHEAP.id]: CHEAP });
  const asked: [string, string][] = [];
  api.providers.complete = async (modelId: string, prompt: string) => {
    asked.push([modelId, prompt]);
    if (verdict instanceof Error) throw verdict;
    return new ProviderResult(verdict, 1000, 10);
  };
  api.deps.autonomousPlan = async (prompt: string) => {
    sent.planned.push(prompt);
    return TaskPlanSchema.parse({ summary: "加缓存", nodes: [{ id: "a", title: "加缓存", instructions: "i", capability: "coding" }] });
  };
  return [sent, asked];
}

