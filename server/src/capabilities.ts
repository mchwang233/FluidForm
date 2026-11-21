// Capabilities: what a finished task leaves the platform able to do (docs/design/capabilities.md;
// capabilities.ts). A task's lead proposes them when it succeeds; the user solidifies one: its
// files are copied into <tools_dir>/capabilities/<id>/ with a capability.json, and its check runs
// in a step's sandbox. Active tools are told to every later step and planner (section); tools_dir
// is readable from the steps' sandbox.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { settings } from "./config.js";
import { toolsDir } from "./environment.js";
import { slug } from "./folders.js";
import { timeKey } from "./lax.js";
import { log } from "./log.js";
import { type Capability, type CapabilityCard, CapabilityCardFields, type CapabilityProposal, CapabilityProposalSchema,
  CapabilitySchema, type ExecutionRun, folderId } from "./models.js";
import { head, isObject, pyRegex, pyStr, sortedBy, tail } from "./py.js";

export const KINDS = new Set(["tool", "automation"]);
export const MAX_PROPOSALS = 3;
// What one capability may copy from its task's folder.
export const MAX_CAPABILITY_BYTES = 20 * 1024 * 1024;
export const CHECK_SECONDS = 60;
// Characters of a capability's manual.
export const MAX_GUIDE = 6000;
export const MANUAL = "SKILL.md";
// Characters of a check's output kept with the capability.
export const MAX_CHECK_OUTPUT = 4000;

export const PROMPT =
  "The task is finished. Did it build something reusable beyond this task: a tool that later "
  + "tasks or chats could run (a command-line program, a script, a client for a service), or an "
  + "automation that should keep running (replying to messages, a scheduled job)? Only something "
  + "that works on its own and would be useful again, not the task's product itself (a report, a "
  + "web page, a design). Most tasks build none.\n"
  + "Reply with JSON only, no fences: {\"capabilities\": []} or\n"
  + "{\"capabilities\": [{\"name\": \"short name in the user's language\", \"kind\": \"tool | automation\", "
  + "\"summary\": \"what it does, one sentence\", \"usage\": \"how to run it from its folder: the command "
  + "and its arguments\", \"guide\": \"its manual for whoever uses it next, a few short Markdown lines: inputs, "
  + "outputs, limits, common mistakes\", \"files\": [\"paths relative to the task's folder that make it up: its "
  + "code and what the code needs\"], "
  + "\"check\": \"a command, run in its folder, that shows it works without side effects or network\", "
  + "\"secrets\": [\"environment variables it needs\"], \"domains\": [\"hosts it must reach\"]}]}\n"
  + `At most ${MAX_PROPOSALS}.`;

/** How a capability's check runs: in a step's sandbox without network (agent.Workspace, phase 2). */
export const deps = {
  sandboxAvailable: (): boolean => false,
  runInSandbox: async (_folder: string, _command: string, _timeoutMs: number): Promise<[string, boolean]> => ["", false],
};

export function root(): string {
  return join(toolsDir(), "capabilities");
}

const text = (value: unknown) => pyStr(value || "").trim();
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The lead's cards, cleaned; [] for anything unreadable. */
export function readCards(given: string | null | undefined): CapabilityProposal[] {
  const source = given || "";
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  let payload: unknown = {};
  try {
    payload = start >= 0 && 0 < end ? JSON.parse(source.slice(start, end + 1)) : {};
  } catch {
    return [];
  }
  const cards: CapabilityProposal[] = [];
  for (const item of list(isObject(payload) ? payload.capabilities : null)) {
    if (!isObject(item) || !text(item.name)) continue;
    const files = list(item.files).map((path) => pyStr(path).trim()).filter(Boolean);
    if (!files.length) continue;
    const kind = pyStr(item.kind || "tool").split("|")[0].trim();
    cards.push(CapabilityProposalSchema.parse({
      name: head(pyStr(item.name).trim(), 60), kind: KINDS.has(kind) ? kind : "tool",
      summary: head(text(item.summary), 500), usage: head(text(item.usage), 2000), guide: head(text(item.guide), MAX_GUIDE),
      files: files.slice(0, 50), check: head(text(item.check), 500),
      secrets: list(item.secrets).map((name) => head(pyStr(name).trim(), 80)).filter(Boolean).slice(0, 10),
      domains: list(item.domains).map((host) => head(pyStr(host).trim(), 200)).filter(Boolean).slice(0, 10),
    }));
  }
  return cards.slice(0, MAX_PROPOSALS);
}

export function taskFolder(run: ExecutionRun): string {
  return run.project_dir ? run.project_dir : join(settings.workspace_root, folderId(run));
}

/** Path.resolve(): absolute, links followed as far as the path exists. */
function realResolve(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    // Not there: resolve what exists of it.
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(realResolve(parent), absolute.slice(parent.length + 1));
  }
}

const inside = (path: string, base: string) => path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);

function filesUnder(folder: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path));
    else if (entry.isFile() || (entry.isSymbolicLink() && existsSync(path) && statSync(path).isFile())) found.push(path);
  }
  return found;
}

/** A file a capability is made of that is outside the task's folder, missing or too large. */
export class SourceError extends Error {}

/** [source, relative path] of each listed file or folder, all inside ``folder``. */
export function sources(folder: string, files: string[]): [string, string][] {
  const base = realResolve(folder);
  const found: [string, string][] = [];
  let size = 0;
  for (const name of files) {
    const source = realResolve(join(base, name));
    if (!inside(source, base) || source === base || !existsSync(source)) throw new SourceError(`不在任务目录里或不存在：${name}`);
    for (const item of statSync(source).isFile() ? [source] : filesUnder(source)) {
      size += statSync(item).size;
      if (size > MAX_CAPABILITY_BYTES) throw new SourceError(`文件太大：超过 ${Math.floor(MAX_CAPABILITY_BYTES / 1024 / 1024)} MB`);
    }
    found.push([source, relative(base, source)]);
  }
  return found;
}

function uniqueId(name: string): string {
  const base = slug(name.replace(pyRegex(String.raw`[^\w\s-]`, "g"), " "), "capability");
  let candidate = base;
  for (let number = 2; existsSync(join(root(), candidate)); number += 1) candidate = `${base}-${number}`;
  return candidate;
}

export function save(capability: Capability): void {
  const folder = join(root(), capability.id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "capability.json"), JSON.stringify(capability, null, 2));
}

export function load(capabilityId: string | null | undefined): Capability | null {
  if (!pyRegex(String.raw`^[\w-]+\Z`).test(capabilityId || "")) return null;
  const path = join(root(), capabilityId!, "capability.json");
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  try {
    return CapabilitySchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    log.warning(`unreadable capability ${capabilityId}`);
    return null;
  }
}

/** Every capability on this machine, newest first. */
export function library(): Capability[] {
  if (!existsSync(root()) || !statSync(root()).isDirectory()) return [];
  const found = readdirSync(root(), { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .map((entry) => load(entry.name)).filter((item): item is Capability => item !== null);
  return sortedBy(found, (item) => timeKey(item.created_at), true);
}

export function remove(capabilityId: string): boolean {
  if (!load(capabilityId)) return false;
  rmSync(join(root(), capabilityId), { recursive: true, force: true });
  return true;
}

/** Run its check in a step's sandbox, without network, in its folder. */
export async function check(capability: Capability): Promise<Capability> {
  if (!capability.check) {
    capability.check_ok = null;
    capability.check_output = "没有检查命令。";
    return capability;
  }
  if (!deps.sandboxAvailable()) {
    capability.check_ok = false;
    capability.check_output = "这台机器没有步骤沙箱（bwrap），检查没有运行。";
    return capability;
  }
  const [output, ok] = await deps.runInSandbox(join(root(), capability.id), capability.check, CHECK_SECONDS * 1000);
  capability.check_ok = ok;
  capability.check_output = tail(output, MAX_CHECK_OUTPUT);
  return capability;
}

/** Copy ``card``'s files from ``run``'s folder into a capability of its own and check it. Throws
 *  for files outside the task's folder or too large. */
export async function solidify(run: ExecutionRun, card: CapabilityCard): Promise<Capability> {
  const found = sources(taskFolder(run), card.files);
  const fields = Object.fromEntries(Object.keys(CapabilityCardFields).map((key) => [key, (card as Record<string, unknown>)[key]]));
  let capability = CapabilitySchema.parse({ ...fields, id: uniqueId(card.name), source_run_id: run.id });
  const folder = join(root(), capability.id);
  mkdirSync(folder, { recursive: true });
  for (const [source, path] of found) {
    const target = join(folder, path);
    mkdirSync(dirname(target), { recursive: true });
    if (lstatSync(source).isDirectory()) cpSync(source, target, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    else cpSync(source, target, { preserveTimestamps: true });
  }
  writeFileSync(join(folder, MANUAL), manual(capability));
  capability = await check(capability);
  capability.status = capability.check_ok === false ? "failed" : "active";
  save(capability);
  return capability;
}

/** Its SKILL.md: the code beside it, and how to use it, in the skills' own format. */
export function manual(capability: Capability): string {
  const part = (title: string, lines: string[]) => (lines.length ? [`## ${title}`, ...lines, ""] : []);
  return [
    "---", `name: ${capability.id}`, `description: ${capability.summary || capability.name}`, "---", "",
    `# ${capability.name}`, "", capability.summary, "",
    ...part("用法", capability.usage ? [`Run from this folder: \`${capability.usage}\``] : []),
    ...part("说明", capability.guide ? [capability.guide] : []),
    ...part("代码", capability.files.map((name) => `- \`${name}\``)),
    ...part("检查", capability.check ? [`\`${capability.check}\``] : []),
    ...part("需要", [...capability.secrets.map((name) => `- 环境变量 \`${name}\``), ...capability.domains.map((host) => `- 访问 \`${host}\``)]),
  ].join("\n").trimEnd() + "\n";
}

/** What steps and planners are told: the active tools on this machine, and how to run them. */
export function section(capabilities: Capability[] | null = null): string {
  const tools = (capabilities ?? library()).filter((item) => item.kind === "tool" && item.status === "active");
  if (!tools.length) return "";
  const lines = ["Tools on this machine that earlier tasks built; use one instead of building it again "
    + "(run it from its folder; it is read-only, copy it to change it):"];
  for (const item of tools) {
    let needs = item.secrets.length ? ` Needs environment variables: ${item.secrets.join(", ")}.` : "";
    const venv = join(root(), item.id, ".venv");
    if (existsSync(venv) && statSync(venv).isDirectory()) needs += ` Run its Python code with ${join(venv, "bin/python")}, which has its packages.`;
    lines.push(`- ${item.name} (${join(root(), item.id)}): ${item.summary} Usage: ${item.usage}${needs} Read its ${MANUAL} there first.`);
  }
  return lines.join("\n");
}
