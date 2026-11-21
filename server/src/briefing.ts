// The project brief: what each file of a working directory is for, written once by a
// cheap model and kept current, so that every step, whichever model runs it, starts knowing the
// project instead of reading it again. Only files whose content changed are summarized again; the
// brief is kept per working directory under the data folder and reused by later tasks.
//
// The brief is for whoever plans (``planningBrief``): with it the lead cuts the task into small work
// packages that each name their files, and each step then gets only the full text of those files
// (``attachedFiles``), not the project.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BINARY_SUFFIXES, projectMap } from "./agent.js";
import { tokenCost, type Priced } from "./budget.js";
import { log } from "./log.js";
import type { ExecutionRun, TaskNode } from "./models.js";
import { head, pyDumps, pyRegex, pyStr, suffix, truthy } from "./py.js";
import { reviewPath, SKIP_DIRS } from "./quality.js";

// Files worth a summary: source, configuration and documentation, not logs or data dumps.
export const SUMMARIZED = new Set([".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".vue", ".svelte", ".css", ".scss", ".html",
  ".md", ".rst", ".sh", ".bash", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".service", ".sql", ".go", ".rs", ".java", ".kt", ".c",
  ".h", ".cpp", ".hpp", ".cs", ".rb", ".php", ".swift", ".v", ".sv", ".vhd", ".tcl", ".r", ".lua", ".dockerfile", ".example", ".json"]);
export const SUMMARIZED_NAMES = new Set(["Dockerfile", "Makefile", "Procfile", "requirements.txt", "package.json", "pyproject.toml"]);
export const MAX_SUMMARIZED_BYTES = 200_000;
export const MAX_SMALL_JSON = 20_000;
export const MAX_SUMMARIZED_FILES = 300;
// What a summarizing request carries: whole files up to this much text, in this many at a time.
export const BATCH_CHARS = 120_000;
export const FILE_CHARS = 40_000;
export const PARALLEL = 4;
// Full text attached to a step.
export const ATTACH_CHARS = 100_000;
export const ATTACH_FILE_CHARS = 64_000;
export const MAX_ATTACHED = 13;
// A scoped work package gets all its files, however long each is, within this.
export const SCOPED_ATTACH_CHARS = 200_000;

export type Ask = (text: string) => Promise<string>;
export type Brief = { files: Record<string, { sha: string; summary: string }>; overview?: string; [key: string]: unknown };
const length = (text: string) => [...text].length;
const hidden = (part: string) => part.startsWith(".") || SKIP_DIRS.has(part);

function summarized(root: string, relative: string, name: string): boolean {
  if (relative.split("/").some(hidden)) return false;
  const lower = name.toLowerCase();
  const kind = suffix(name).toLowerCase() || (lower === "dockerfile" ? "." + lower : "");
  if (!SUMMARIZED_NAMES.has(name) && !SUMMARIZED.has(kind)) return false;
  let size: number;
  try {
    size = statSync(join(root, relative)).size;
  } catch {
    return false;
  }
  if (size > (kind === ".json" ? MAX_SMALL_JSON : MAX_SUMMARIZED_BYTES)) return false;
  // Never send credentials or private files to a model.
  return reviewPath(root, relative) !== null;
}

/** os.walk, top down: each folder's files (sorted), then its folders (sorted, ``keep`` ones only). */
function walk(root: string, visit: (relative: string, name: string) => boolean | void, keep: (name: string) => boolean, sorted = true): void {
  const inner = (relative: string): boolean => {
    let entries;
    try {
      entries = readdirSync(relative ? join(root, relative) : root, { withFileTypes: true });
    } catch {
      return false;
    }
    const order = (names: string[]) => (sorted ? names.sort() : names);
    const files = order(entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name));
    const dirs = order(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)).filter(keep);
    for (const name of files) if (visit(relative ? `${relative}/${name}` : name, name) === true) return true;
    for (const name of dirs) if (inner(relative ? `${relative}/${name}` : name)) return true;
    return false;
  };
  inner("");
}

/** {path: [content hash, text]} of the files worth a summary. */
export function scan(root: string): Map<string, [string, string]> {
  const found = new Map<string, [string, string]>();
  walk(root, (relative, name) => {
    if (BINARY_SUFFIXES.has(suffix(name).toLowerCase()) || !summarized(root, relative, name)) return;
    let data: Buffer;
    try {
      data = readFileSync(join(root, relative));
    } catch {
      return;
    }
    if (data.subarray(0, 4096).includes(0)) return;
    found.set(relative, [createHash("sha1").update(data).digest("hex"), data.toString("utf8")]);
    return found.size >= MAX_SUMMARIZED_FILES;
  }, (name) => !SKIP_DIRS.has(name) && !name.startsWith("."));
  return found;
}

export type Writer = Priced & { id: string };
export type Completer = { complete(modelId: string, prompt: string, options: { effort?: string }): Promise<{ text: string; input_tokens: number;
  output_tokens: number; cached_input_tokens?: number }> };

/** The brief of ``root`` for planning, brought up to date by ``writer`` (null for just the file list),
 *  and what writing it cost. */
export async function planningBrief(root: string, dataDir: string, providers: Completer, writer: Writer | null): Promise<[string, number]> {
  let spent = 0;
  const ask: Ask = async (text) => {
    const result = await providers.complete(writer!.id, text, { effort: "low" });
    spent += tokenCost(writer, result.input_tokens, result.output_tokens, result.cached_input_tokens ?? 0);
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

export const BRIEF_NOTE = "Project brief, written from the files' current contents so you need not open every file to "
  + "find your way. Use it to decide what to read; read a file before you edit it unless its full "
  + "text is attached below.";

/** The brief as given to a step: the overview, then every file with its length and summary. */
export function render(root: string, brief: Brief | null): string {
  const summaries = Object.fromEntries(Object.entries(brief?.files ?? {}).map(([name, entry]) => [name, entry.summary]));
  const files = projectMap(root, summaries);
  if (!Object.keys(summaries).length) return files;
  const overview = brief?.overview;
  return [BRIEF_NOTE, overview ? `Overview:\n${overview}` : "", files].filter(Boolean).join("\n\n");
}

const PATH_LIKE = pyRegex(String.raw`[\w./-]*[\w-]\.[A-Za-z0-9]{1,8}\b`, "g");
const stripChars = (text: string, chars: string) => {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text[start])) start += 1;
  while (end > start && chars.includes(text[end - 1])) end -= 1;
  return text.slice(start, end);
};
const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** The files a step the planner did not scope most likely needs: those its instructions name, then
 *  those the steps it depends on changed. */
export function likelyFiles(root: string, node: TaskNode, run: ExecutionRun): string[] {
  const text = `${node.instructions}\n${node.acceptance_criteria}`;
  const wanted: string[] = [];
  let names: Map<string, string[]> | null = null;
  for (const match of text.matchAll(PATH_LIKE)) {
    const token = stripChars(match[0], "./");
    if (isFile(join(root, token))) wanted.push(token);
    else if (!token.includes("/") && /\.[A-Za-z]/.test(token)) {
      // A bare file name: the file of that name, if only one has it.
      if (names === null) {
        const found = new Map<string, string[]>();
        walk(root, (relative, name) => {
          found.set(name, [...(found.get(name) ?? []), relative]);
        }, (name) => !SKIP_DIRS.has(name) && !name.startsWith("."), false);
        names = found;
      }
      const same = names.get(token) ?? [];
      if (same.length === 1) wanted.push(same[0]);
    }
  }
  const byId = new Map(run.plan.nodes.map((item) => [item.id, item]));
  for (const dependency of node.dependencies) wanted.push(...(byId.get(dependency)?.changed_files ?? []));
  return [...new Set(wanted)];
}

/** Full text of the files ``names`` that exist, in order, while they fit: no file longer than
 *  ``fileChars``, none past ``totalChars`` in all. Never binary, hidden or private files. */
export function attachedFiles(root: string, names: string[], totalChars = ATTACH_CHARS, fileChars = ATTACH_FILE_CHARS): string {
  const sections: string[] = [];
  let total = 0;
  for (const name of new Set(names)) {
    const path = join(root, name);
    if (sections.length >= MAX_ATTACHED || !isFile(path) || BINARY_SUFFIXES.has(suffix(name).toLowerCase()) || reviewPath(root, name) === null) continue;
    let data: Buffer;
    try {
      data = readFileSync(path);
    } catch {
      continue;
    }
    if (data.subarray(0, 4096).includes(0) || data.length > fileChars || total + data.length > totalChars) continue;
    total += data.length;
    sections.push(`=== ${name} (full text, current) ===\n${data.toString("utf8")}`);
  }
  if (!sections.length) return "";
  return "Files attached in full, as they are now; do not read them again unless they change:\n\n" + sections.join("\n\n");
}
