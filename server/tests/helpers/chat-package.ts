// The chat package's own functions (server/packages/chat/chat.mjs), as the tests of what moved there
// call them: what remembering.ts and supervisor.ts's chat parts used to be.
// @ts-expect-error: the package is plain JavaScript, with no types
import * as pkg from "../../packages/chat/chat.mjs";
import * as chat from "../../src/chat.js";
import { settings } from "../../src/config.js";
import type { ExecutionRun, ModelProfile } from "../../src/models.js";
import * as supervisor from "../../src/supervisor.js";

export const CHAT_ROLE: string = pkg.CHAT_ROLE;
export const MAX_CHAT_HANDOVER_CHARS: number = pkg.MAX_CHAT_HANDOVER_CHARS;
export const AUTOMATION_WORK: string = pkg.AUTOMATION_WORK;

/** What remembering.ts was: the package's memory, kept in the test's data folder. */
export const remembering = {
  WEB: pkg.WEB as string,
  MAX_FACTS: pkg.MAX_FACTS as number,
  split: (text: string) => pkg.splitMemory(text) as [string, string[], string[]],
  apply: (facts: string[], remembered: string[], forgotten: string[]) => pkg.applyMemory(facts, remembered, forgotten) as string[],
  told: (facts: string[]) => pkg.told(facts) as string,
  memory: () => new pkg.Memory(settings.data_dir),
  load: () => remembering.memory().load() as Record<string, string[]>,
  facts: (key: string) => remembering.memory().facts(key) as string[],
  update: (key: string, remembered: string[], forgotten: string[]) => remembering.memory().update(key, remembered, forgotten) as string[],
  remove: (key: string, fact: string) => remembering.memory().remove(key, fact) as boolean,
  take: (key: string, text: string) => remembering.memory().take(key, text, settings.user_memory)[0] as string,
};

/** What a chat's package is told of it, as FluidForm tells it. */
const ctx = async (run: ExecutionRun, model: ModelProfile | null) =>
  chat.context(run, model, model !== null && model.channel !== "cli" ? await supervisor.chatTools(run) : null);

export const chatGuide = async (run: ExecutionRun) => pkg.chatGuide(await ctx(run, null)) as string;
export const chatToolsNote = async (run: ExecutionRun, model: ModelProfile | null) => pkg.toolsNote(await ctx(run, model)) as string;
export const chatRole = async (run: ExecutionRun, model: ModelProfile | null = null) => pkg.role(await ctx(run, model)) as string;
export const chatOrder = (run: ExecutionRun, models: ModelProfile[]) => chat.order(models, Boolean((run.origin || {}).capability));
export const forPerson = (text: string) => pkg.forPerson(text) as string;
export const splitTask = (text: string) => pkg.splitTask(text) as [string, string | null];
export const splitSends = (text: string) => pkg.splitSends(text) as [string, string[]];
export const splitEngineer = (text: string) => pkg.splitEngineer(text) as [string, { kind: string; request: string } | null];
export const transcript = (run: ExecutionRun, limit?: number) => pkg.transcript(run.lead_messages, limit) as string;
