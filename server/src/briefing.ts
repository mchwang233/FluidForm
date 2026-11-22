// The project brief: what each file of a working directory is for, written once by a
// cheap model and kept current, so that every step, whichever model runs it, starts knowing the
// project instead of reading it again. Only files whose content changed are summarized again; the
// brief is kept per working directory under the data folder and reused by later tasks.
//
// The brief is for whoever plans (written by the planning extension, packages/planning/src/brief.ts): with it the lead cuts the task into small work
// packages that each name their files, and each step then gets only the full text of those files
// (``attachedFiles``), not the project.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { BINARY_SUFFIXES, projectMap } from "./agent.js";
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
