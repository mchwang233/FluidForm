// What FluidForm asks the chat capability (docs/design/chat-and-pricing-packages.md): which model a
// chat talks with, what it is told, what its answer's lines for FluidForm say, what it remembers about
// people, and whether a group message is meant for it are requests to the service package providing
// "chat" (packages/chat, services.ts). FluidForm keeps the pipes: the chats and their messages, the
// model calls (with its keys, charged), the tools, the files, the tasks it plans.
//
// Without a chat package there are no chats: none is started or continued (old ones can be read), and
// automations that need it cannot be enabled.
import * as attachments from "./attachments.js";
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
export function context(run: ExecutionRun, model: ModelProfile | null, tools: { folder: string; network: boolean; turns: number; seconds: number; made?: string[] } | null): Json {
  const origin = (run.origin || {}) as Json;
  const automation = Boolean(origin.capability);
  return {
    chat: { automation, chat_type: origin.chat_type ?? null, project_dir: run.project_dir,
      place: automation ? (origin.conversation ? automationKey(pyStr(origin.capability), pyStr(origin.conversation)) : null) : WEB,
      summary: run.chat_summary ?? null,
      session: run.supervisor ? { model_id: run.supervisor.model_id, previous: run.supervisor.previous, calls: run.supervisor.calls } : null,
      messages: run.lead_messages.map((item) => ({ role: item.role, text: item.text, status: item.status })) },
    model: model ? { id: model.id, display_name: model.display_name, channel: model.channel, vision: model.supports_vision !== false } : null,
    tools: tools ? { folder: tools.folder, network: tools.network, turns: tools.turns, seconds: tools.seconds, made: tools.made ?? [] } : null,
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

/** The time as the package is told it: this machine's. */
export const clock = (now = new Date()) => ({ now: now.getTime() / 1000, utc_offset: -now.getTimezoneOffset() * 60 });

/** A chat's messages before the one being answered, with their files as ``paths`` has them. A chat's
 *  first files are kept on the chat, not on its first message. */
export function history(run: ExecutionRun, paths: Record<string, string> = {}): Json[] {
  let end = run.lead_messages.length;
  for (let index = end - 1; index > 0; index -= 1) {
    if (run.lead_messages[index].status !== "pending") continue;
    end = index - 1; // the message asked, and the answer being written
    break;
  }
  const placed = new Set(run.lead_messages.flatMap((item) => item.attachments.map((file) => file.id)));
  const first = run.lead_messages.findIndex((item) => item.role === "user");
  return run.lead_messages.slice(0, end).map((item, index) => ({ id: item.id, role: item.role, text: item.text, status: item.status,
    files: [...item.attachments, ...(index === first ? run.attachments.filter((file) => !placed.has(file.id)) : [])]
      .map((file) => ({ id: file.id, name: file.name, kind: file.kind, path: paths[file.id] ?? null,
        ...(file.kind === "image" ? { show: attachments.showable(file) } : {}) })) }));
}

/** Whether ``run``'s next turn shows pictures sent before (the chat package says which). */
export async function showsPictures(run: ExecutionRun): Promise<boolean> {
  if (!run.attachments.some((file) => file.kind === "image")) return false;
  const ctx = context(run, null, null);
  ctx.chat.history = history(run);
  return Boolean(((await ask("chat.pictures", { ctx })).ids ?? []).length);
}
