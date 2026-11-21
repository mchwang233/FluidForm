// What FluidForm asks the chat capability (docs/design/chat-and-pricing-packages.md): which model a
// chat talks with, what it is told, what its answer's lines for FluidForm say, what it remembers about
// people, and whether a group message is meant for it are requests to the service package providing
// "chat" (packages/chat, services.ts). FluidForm keeps the pipes: the chats and their messages, the
// model calls (with its keys, charged), the tools, the files, the tasks it plans.
//
// Without a chat package there are no chats: none is started or continued (old ones can be read), and
// automations that need it cannot be enabled.
import * as capabilities from "./capabilities.js";
import { chatGuide as packageGuide } from "./capability-packages.js";
import { settings } from "./config.js";
import type { ExecutionRun, ModelProfile } from "./models.js";
import * as pricing from "./pricing.js";
import { pyStr } from "./py.js";
import * as services from "./services.js";

type Json = Record<string, any>;

export const WEB = "web";
export const NOT_ENABLED = "没有启用聊天能力：在 平台 → 能力 里装上并启用「聊天」。";

export class ChatUnavailable extends Error {
  override name = "ChatUnavailable";
}

export const deps = {
  // How a request reaches the package; the API sets it (services.ts), tests may answer in-process.
  ask: null as ((method: string, params: Json) => Promise<Json>) | null,
  enabled: () => services.available("chat"),
};

/** Whether chats can be held. */
export function enabled(): boolean {
  return deps.enabled();
}

export async function ask(method: string, params: Json = {}): Promise<Json> {
  if (!enabled() || !deps.ask) throw new ChatUnavailable(NOT_ENABLED);
  try {
    return await deps.ask(method, params);
  } catch (error) {
    if (error instanceof ChatUnavailable) throw error;
    throw new ChatUnavailable(`聊天能力没有回答：${(error as Error)?.message ?? error}`);
  }
}

export const automationKey = (capabilityId: string, conversation: string) => `${capabilityId}:${conversation}`;

/** The models a chat may talk with, best first (the package orders those FluidForm can reach). */
export async function order(models: ModelProfile[], automation = false): Promise<ModelProfile[]> {
  if (!models.length) return [];
  const given = models.map((model) => ({ id: model.id, channel: model.channel, planning: model.scores!.planning, reliability: model.scores!.reliability,
    rate: pricing.enabled() ? (model.input_per_million || 0) + (model.output_per_million || 0) : 0 }));
  const byId = new Map(models.map((model) => [model.id, model]));
  return ((await ask("chat.order", { models: given, automation })).ids as string[]).map((id) => byId.get(id)!).filter(Boolean);
}

/** What the package needs to know of a chat to say what its model is told. */
export function context(run: ExecutionRun, model: ModelProfile | null, tools: { folder: string; network: boolean; turns: number; seconds: number } | null): Json {
  const origin = (run.origin || {}) as Json;
  const automation = Boolean(origin.capability);
  return {
    chat: { automation, chat_type: origin.chat_type ?? null, project_dir: run.project_dir,
      session: run.supervisor ? { model_id: run.supervisor.model_id, previous: run.supervisor.previous, calls: run.supervisor.calls } : null,
      messages: run.lead_messages.map((item) => ({ role: item.role, text: item.text, status: item.status })) },
    model: model ? { id: model.id, display_name: model.display_name, channel: model.channel } : null,
    tools: tools ? { folder: tools.folder, network: tools.network, turns: tools.turns, seconds: tools.seconds } : null,
    settings: { user_memory: settings.user_memory, chat_action_tools: settings.chat_action_tools },
    guide: automation ? packageGuide(pyStr(origin.capability)) : "",
    capabilities: capabilities.section(),
  };
}

export const text = async (method: string, params: Json) => String((await ask(method, params)).text ?? "");

/** The finished messages of a chat, oldest first, as many of the latest as fit. */
export async function transcript(run: ExecutionRun): Promise<string> {
  return text("chat.transcript", { messages: run.lead_messages.map((item) => ({ role: item.role, text: item.text, status: item.status })) });
}

/** An answer without what it says it remembers about the people of ``place`` (kept by the package). */
export async function remember(place: string, answer: string, on = settings.user_memory): Promise<[string, string[]]> {
  const found = await ask("chat.remember", { place, text: answer, on });
  return [String(found.text ?? ""), (found.remembered ?? []) as string[]];
}

/** Where its lines for FluidForm begin in an answer being written, to cut them from what people see. */
export async function actionLines(): Promise<RegExp> {
  const found = await ask("chat.action_lines");
  return new RegExp(found.pattern, found.flags);
}

/** What of an answer being written the person sees, cut where ``lines`` begin. */
export function forPerson(answer: string, lines: RegExp): string {
  const found = lines.exec(answer || "");
  return found ? answer.slice(0, found.index).trimEnd() : answer;
}
