// What chats remember about the people they talk with (settings.user_memory).
//
// A chat writes a REMEMBER line for a lasting preference or fact someone tells it, a FORGET line
// to drop one (or calls the Remember and Forget tools: chat-actions.ts). FluidForm keeps them in
// <data_dir>/memory.json, by where they were said: WEB for the owner's own chats on the web page,
// "<capability>:<conversation>" for a conversation an automation brings. Every new chat there is
// told them, so a chat started afresh (another model, a day later) still knows them; the owner
// sees and deletes them on the 记住的事 page (GET/DELETE /api/memory).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { settings } from "./config.js";
import { head, isObject, pyRegex } from "./py.js";

export const WEB = "web";
export const MAX_FACTS = 30;
export const MAX_FACT_CHARS = 300;
const REMEMBER_LINE = pyRegex(String.raw`^\s*REMEMBER:\s*(.+?)\s*$`, "mg");
const FORGET_LINE = pyRegex(String.raw`^\s*FORGET:\s*(.+?)\s*$`, "mg");
// Never kept, whatever the chat writes: what looks like a secret.
const SECRET = pyRegex("(password|passwd|secret|token|api[_ -]?key|密码|口令|密钥|sk-[A-Za-z0-9]{8,})", "i");

export const GUIDE =
  "Remembering: when someone tells you something lasting about themselves or how they want to be "
  + "helped (how they like answers, their role, what they work on, names they use), or asks you to "
  + "remember something, end your answer with one line per fact:\n"
  + "REMEMBER: <who>: <the fact, one short sentence>\n"
  + "and to drop one they correct or ask you to forget: FORGET: <words from that fact>. Not for what "
  + "matters only now, and never a password, key or other secret. You are told what you remember "
  + "when a conversation starts.\n\n";

/** An answer without its REMEMBER and FORGET lines, and what they say. */
export function split(text: string | null | undefined): [string, string[], string[]] {
  const source = text || "";
  const remembered = [...source.matchAll(REMEMBER_LINE)].map((found) => head(found[1].trim(), MAX_FACT_CHARS));
  const forgotten = [...source.matchAll(FORGET_LINE)].map((found) => found[1].trim());
  if (!remembered.length && !forgotten.length) return [text as string, [], []];
  const shown = source.replace(REMEMBER_LINE, "").replace(FORGET_LINE, "").trim();
  return [shown, remembered.filter(Boolean), forgotten.filter(Boolean)];
}

/** The facts kept after an answer: forgotten ones dropped, new ones added (no secrets, no
 *  repeats), the oldest dropped past MAX_FACTS. */
export function apply(facts: string[], remembered: string[], forgotten: string[]): string[] {
  const kept = facts.filter((fact) => !forgotten.some((words) => fact.toLowerCase().includes(words.toLowerCase())));
  for (const fact of remembered) {
    if (SECRET.test(fact) || kept.includes(fact)) continue;
    kept.push(fact);
  }
  return kept.slice(-MAX_FACTS);
}

/** What a new chat is told first, or "" when there is nothing. */
export function told(facts: string[]): string {
  if (!facts.length) return "";
  return "你记得的（这段对话里的人以前告诉你的，可能已过时）：\n" + facts.map((fact) => `- ${fact}`).join("\n") + "\n\n";
}

const path = () => join(settings.data_dir, "memory.json");

/** Every place's facts; a missing or broken file is nothing remembered. */
export function load(): Record<string, string[]> {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path(), "utf8"));
  } catch {
    return {};
  }
  if (!isObject(data)) return {};
  return Object.fromEntries(Object.entries(data).filter(([, facts]) => Array.isArray(facts))
    .map(([key, facts]) => [key, (facts as unknown[]).filter((fact): fact is string => typeof fact === "string")]));
}

function save(data: Record<string, string[]>): void {
  const file = path();
  mkdirSync(dirname(file), { recursive: true });
  const temporary = file.replace(/\.json$/, ".tmp");
  writeFileSync(temporary, JSON.stringify(Object.fromEntries(Object.entries(data).filter(([, facts]) => facts.length)), null, 1));
  renameSync(temporary, file);
}

// Node runs one thing at a time: a read, change and write with no await between them is atomic.

export function facts(key: string): string[] {
  return load()[key] ?? [];
}

export function update(key: string, remembered: string[], forgotten: string[]): string[] {
  const data = load();
  data[key] = apply(data[key] ?? [], remembered, forgotten);
  save(data);
  return data[key];
}

/** Drop one fact, as the owner asked on the page; whether it was there. */
export function remove(key: string, fact: string): boolean {
  const data = load();
  if (!(data[key] ?? []).includes(fact)) return false;
  data[key] = data[key].filter((item) => item !== fact);
  save(data);
  return true;
}

/** An answer without its REMEMBER and FORGET lines, which update what is kept at ``key`` when
 *  settings.user_memory is on (off, the lines are only taken out). */
export function take(key: string, text: string): string {
  const [shown, remembered, forgotten] = split(text);
  if (shown !== text && settings.user_memory && (remembered.length || forgotten.length)) update(key, remembered, forgotten);
  return shown;
}

export function automationKey(capabilityId: string, conversation: string): string {
  return `${capabilityId}:${conversation}`;
}
