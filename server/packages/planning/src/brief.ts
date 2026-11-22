// The project brief as planning has it written: summaries by a cheap model, kept current per working
// directory. What a step is shown of a project is FluidForm's (briefing.ts).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Ask, BATCH_CHARS, type Brief, FILE_CHARS, PARALLEL, render, scan } from "../../../src/briefing.js";
import type { Priced } from "../../../src/budget.js";
import { log } from "../../../src/log.js";
import * as pricing from "../../../src/pricing.js";
import { head, pyDumps, pyRegex, pyStr, truthy } from "../../../src/py.js";

const length = (text: string) => [...text].length;

export type Writer = Priced & { id: string };
export type Completer = { complete(modelId: string, prompt: string, options: { effort?: string }): Promise<{ text: string; input_tokens: number;
  output_tokens: number; cached_input_tokens?: number }> };

/** The brief of ``root`` for planning, brought up to date by ``writer`` (null for just the file list),
 *  and what writing it cost. */
export async function planningBrief(root: string, dataDir: string, providers: Completer, writer: Writer | null): Promise<[string, number]> {
  let spent = 0;
  const ask: Ask = async (text) => {
    const result = await providers.complete(writer!.id, text, { effort: "low" });
    spent += await pricing.charge(writer, result.input_tokens, result.output_tokens, result.cached_input_tokens ?? 0);
    return result.text;
  };
  let brief: Brief | null = null;
  if (writer) {
    try {
      brief = await refresh(root, dataDir, ask);
    } catch (error) {
      log.warning(`project brief unavailable for planning: ${(error as Error).message ?? error}`);
    }
  }
  return [render(root, brief), spent];
}

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

export function storePath(dataDir: string, root: string): string {
  return join(dataDir, "briefs", `${createHash("sha1").update(real(root)).digest("hex").slice(0, 16)}.json`);
}

export function load(path: string): Brief {
  try {
    const brief = JSON.parse(readFileSync(path, "utf8"));
    return brief && typeof brief === "object" && !Array.isArray(brief) && brief.files && typeof brief.files === "object" && !Array.isArray(brief.files)
      ? brief : { files: {} };
  } catch {
    return { files: {} };
  }
}

export const SUMMARY_PROMPT = `You are writing a project brief that other models read instead of opening every file.
For each file below, write a dense summary in English of at most 3 lines: what it is for, and its
main contents (functions, classes, endpoints, commands, settings or sections, by name) so a reader
knows whether to open it. Do not describe code style. Answer with one JSON object only, mapping each
file path exactly as given to its summary.

`;

export const OVERVIEW_PROMPT = `You are writing the overview of a project brief that other models read before working on
the project. From the file list and summaries below, write at most 25 lines in English: what the
project is, how it is organised, how to run it and its tests (exact commands when they can be
inferred), and conventions worth following. Answer with the overview text only.

`;

export function batches(texts: Map<string, string>): Map<string, string>[] {
  const found: Map<string, string>[] = [];
  let current = new Map<string, string>();
  let size = 0;
  for (const [path, whole] of texts) {
    const text = head(whole, FILE_CHARS);
    if (current.size && size + length(text) > BATCH_CHARS) {
      found.push(current);
      current = new Map();
      size = 0;
    }
    current.set(path, text);
    size += length(text);
  }
  return current.size ? [...found, current] : found;
}

const OBJECT = pyRegex(String.raw`\{.*\}`, "s");

export function parse(text: string | null | undefined, paths: Iterable<string>): Map<string, string> {
  const match = OBJECT.exec(text || "");
  let data: unknown = {};
  try {
    data = match ? JSON.parse(match[0]) : {};
  } catch {
    return new Map();
  }
  const found = new Map<string, string>();
  if (!data || typeof data !== "object" || Array.isArray(data)) return found;
  for (const path of paths) {
    const value = (data as Record<string, unknown>)[path];
    if (Object.hasOwn(data, path) && truthy(value)) found.set(path, head(pyStr(value).trim(), 600));
  }
  return found;
}

/** At most ``count`` of ``work`` at once (asyncio.Semaphore). */
function limited(count: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    while (running >= count) await new Promise<void>((done) => waiting.push(done));
    running += 1;
    try {
      return await work();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };
}

const FENCE = pyRegex("^```\\w*\\n|\\n?```$", "g");

/** The brief of ``root``, with the files that are new or changed since it was written summarized again
 *  and the files that are gone dropped. A summary that fails is left out (and tried again next time)
 *  rather than failing the step. */
export async function refresh(root: string, dataDir: string, ask: Ask): Promise<Brief> {
  const path = storePath(dataDir, root);
  const brief = load(path);
  const current = scan(root);
  const files: Brief["files"] = Object.fromEntries(Object.entries(brief.files).filter(([name]) => current.has(name)));
  const stale = new Map([...current].filter(([name, [sha]]) => files[name]?.sha !== sha).map(([name, [, text]]) => [name, text]));
  let changed = stale.size > 0 || Object.keys(files).length !== Object.keys(brief.files).length;
  if (stale.size) {
    const limit = limited(PARALLEL);
    const summarize = (batch: Map<string, string>) => limit(async () => {
      const prompt = SUMMARY_PROMPT + [...batch].map(([name, text]) => `=== ${name} ===\n${text}`).join("\n\n");
      try {
        return parse(await ask(prompt), batch.keys());
      } catch (error) {
        if ((error as Error)?.name === "AbortError") throw error;
        // a missing summary only costs a read later
        log.warning(`project brief summaries failed: ${(error as Error).message ?? error}`);
        return new Map<string, string>();
      }
    });
    for (const summaries of await Promise.all(batches(stale).map(summarize))) {
      for (const [name, summary] of summaries) files[name] = { sha: current.get(name)![0], summary };
    }
  }
  if (Object.keys(files).length && (!brief.overview || stale.size > Math.max(3, Math.floor(current.size / 5)))) {
    const listing = Object.keys(files).sort().map((name) => `${name}: ${files[name].summary}`).join("\n");
    try {
      const overview = (await ask(OVERVIEW_PROMPT + listing)).trim().replace(FENCE, "");
      brief.overview = head(overview.trim(), 4000);
      changed = true;
    } catch (error) {
      if ((error as Error)?.name === "AbortError") throw error;
      log.warning(`project brief overview failed: ${(error as Error).message ?? error}`);
    }
  }
  brief.files = files;
  if (changed) {
    mkdirSync(join(dataDir, "briefs"), { recursive: true });
    writeFileSync(path, pyDumps(brief, false));
  }
  return brief;
}
