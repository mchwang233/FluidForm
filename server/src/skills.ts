// Skills for the steps: how to use the tools a task needs, so a step does not learn them again
//.
//
// A skill is a folder with a SKILL.md: front matter (name, description, tools, the programs it is
// about; optionally summary, one line for the user in their language) and Markdown. Two libraries:
// - skills/steps/ in the platform's source: what holds on any machine (how VCS is driven);
// - <data_dir>/skills/: what holds on this machine, written by the environment preparation after
//   trying the commands in a step's sandbox. These come first.
// A step is given the skills whose tools its own text names (forStep). Skills found in public
// repositories are kept apart, in <data_dir>/skills-discovered/: never given to a step, only shown
// to the model that writes this machine's skill, as a reference it must check.
import { SERVER } from "./paths.js";
import { uses } from "./features.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { settings } from "./config.js";
import { head, pyRegex, reEscape, splitlines } from "./py.js";

export const SOURCE = join(SERVER, "..", "skills", "steps");
// Where the platform's skills are read from (tests point it elsewhere).
export const places = { source: SOURCE };
// How much of one skill a step's prompt carries, and how many skills.
export const MAX_SKILL_CHARS = 7000;
export const MAX_SKILLS = 3;
const FRONT = pyRegex(String.raw`\A---\s*\n(.*?)\n---\s*\n`, "s");

export type Skill = {
  name: string;
  description: string;
  tools: string[];
  // One line for the user, in their language (the description is for the models); may be empty.
  summary: string;
  body: string;
  path: string | null;
  machine: boolean;
  source_url: string;
  source_revision: string;
  text: string;
};

/** A SKILL.md, or null if it has no front matter with a name. */
export function parse(text: string | null | undefined, path: string | null = null, machine = false): Skill | null {
  const source = text || "";
  const match = FRONT.exec(source);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of splitlines(match[1])) {
    const at = line.indexOf(":");
    const key = at < 0 ? line : line.slice(0, at);
    fields[key.trim()] = at < 0 ? "" : line.slice(at + 1).trim();
  }
  const name = (fields.name ?? "").trim();
  if (!name) return null;
  const tools = (fields.tools ?? "").replace(/^[[\]]+|[[\]]+$/g, "").split(",")
    .map((item) => item.trim().replace(/^['"]+|['"]+$/g, "").toLowerCase());
  return { name, description: fields.description ?? "", tools: tools.filter(Boolean), summary: fields.summary ?? "",
    body: source.slice(match.index + match[0].length).trim(), path, machine, source_url: "", source_revision: "", text: source };
}

export function machineDir(): string {
  return join(settings.data_dir, "skills");
}

function skillFiles(root: string): string[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  return readdirSync(root).sort().map((folder) => join(root, folder, "SKILL.md")).filter((path) => existsSync(path));
}

/** This machine's skills first, then the platform's. */
export function library(source: string | null = null): Skill[] {
  const found: Skill[] = [];
  for (const [root, machine] of [[machineDir(), true], [source ?? places.source, false]] as [string, boolean][]) {
    for (const path of skillFiles(root)) {
      let skill: Skill | null;
      try {
        skill = parse(readFileSync(path).toString("utf8"), path, machine);
      } catch {
        continue;
      }
      if (skill) found.push(skill);
    }
  }
  return found;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Public skills cached from an earlier search, intact and from GitHub, about any of ``tools``
 *  (all without it). */
export function discovered(tools: string[] | null = null): Skill[] {
  const wanted = tools === null ? null : new Set(tools.map((tool) => tool.toLowerCase()));
  const found: Skill[] = [];
  for (const path of skillFiles(join(settings.data_dir, "skills-discovered"))) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
      const metadata = JSON.parse(readFileSync(join(dirname(path), "source.json"), "utf8"));
      const url = metadata.source_url;
      const revision = metadata.source_revision;
      if (typeof url !== "string" || !url.startsWith("https://github.com/") || typeof revision !== "string"
        || !/^[a-f0-9]{40,64}$/.test(revision) || sha256(text) !== metadata.sha256) continue;
      const skill = parse(text, path);
      if (!skill) continue;
      skill.source_url = url;
      skill.source_revision = revision;
      const listed = metadata.tools;
      if (!Array.isArray(listed) || !listed.length || !listed.every((tool) => typeof tool === "string" && pyRegex(String.raw`^[\w.+-]{2,64}\Z`).test(tool))) continue;
      skill.tools = listed;
      found.push(skill);
    } catch {
      continue;
    }
  }
  return found.filter((skill) => wanted === null || skill.tools.some((tool) => wanted.has(tool.toLowerCase())));
}

export function namesTool(text: string, tool: string): boolean {
  return pyRegex(String.raw`(?<![\w./-])` + reEscape(tool) + String.raw`(?![\w-])`, "i").test(text);
}

/** The skills about any of ``tools``. */
export function forTools(tools: string[], skills: Skill[] | null = null): Skill[] {
  const wanted = new Set(tools.map((tool) => tool.toLowerCase()));
  return (skills ?? library()).filter((skill) => skill.tools.some((tool) => wanted.has(tool)));
}

/** The skills whose tools ``text`` (a step's title, instructions, check) names, this machine's
 *  before the platform's, at most MAX_SKILLS. */
export function forStep(text: string, skills: Skill[] | null = null): Skill[] {
  return (skills ?? library()).filter((skill) => skill.tools.some((tool) => namesTool(text, tool))).slice(0, MAX_SKILLS);
}

/** The skills as a part of a step's prompt. */
export function section(skills: Skill[]): string {
  // Without the skills capability steps are given none.
  if (!skills.length || !uses.skills()) return "";
  const parts = skills.map((skill) => {
    const body = skill.body.length <= MAX_SKILL_CHARS ? skill.body : head(skill.body, MAX_SKILL_CHARS) + "\n[...]";
    return `### Skill: ${skill.name} (${skill.machine ? "checked on this machine" : "general"})\n${body}`;
  });
  return "Skills for the tools this step uses. Follow them rather than finding out how the tools work "
    + "again; where this machine's notes and the general skill differ, this machine's are right.\n\n" + parts.join("\n\n");
}

/** Keep a skill written on this machine for ``tool``; returns its path. */
export function saveMachine(tool: string, text: string): string {
  const folder = join(machineDir(), tool.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, ""));
  mkdirSync(folder, { recursive: true });
  const path = join(folder, "SKILL.md");
  writeFileSync(path, text.trimEnd() + "\n");
  return path;
}

/** Cache public instructions separately from notes actually checked on this machine. */
export function saveDiscovered(skill: Skill): string {
  const key = sha256(skill.source_url + skill.source_revision).slice(0, 20);
  const folder = join(settings.data_dir, "skills-discovered", key);
  mkdirSync(folder, { recursive: true });
  // Preserve upstream frontmatter (including licence/attribution), not just our parsed subset.
  const text = skill.text || `---\nname: ${skill.name}\ndescription: ${skill.description}\ntools: [${skill.tools.join(", ")}]\n---\n${skill.body}\n`;
  const path = join(folder, "SKILL.md");
  writeFileSync(path, text);
  writeFileSync(join(folder, "source.json"), JSON.stringify({ source_url: skill.source_url, source_revision: skill.source_revision,
    sha256: sha256(text), tools: skill.tools }, null, 2));
  return path;
}

// Skills a preflight could not write (the learning package's prepareSkills), by name and tools, with
// when and why: the package leaves them alone for a while; the 技能 page can clear the note.
type Failures = Record<string, { at: string; reason: string }>;
const failuresFile = () => join(settings.data_dir, "skills-failed.json");
export const failureKey = (name: string, tools: string[]) => `${name}|${[...tools].sort().join(",")}`;

/** The skills that could not be written, by failureKey, with when and why. */
export function failedSkills(): Failures {
  try {
    const data = JSON.parse(readFileSync(failuresFile(), "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/** Notes that ``name`` could not be written (``reason``), or, with null, that it was. */
export function noteFailure(name: string, tools: string[], reason: string | null): void {
  const data = failedSkills();
  const key = failureKey(name, tools);
  if (reason === null && !(key in data)) return;
  if (reason === null) delete data[key];
  else data[key] = { at: new Date().toISOString(), reason };
  try {
    mkdirSync(settings.data_dir, { recursive: true });
    writeFileSync(failuresFile(), JSON.stringify(data, null, 1));
  } catch {
    // only a note: the next task tries again
  }
}

/** Forgets every skill that could not be written: the next task tries each again. How many. */
export function clearFailures(): number {
  const count = Object.keys(failedSkills()).length;
  rmSync(failuresFile(), { force: true });
  return count;
}

/** This machine's skill in ``folder`` (its id on the 技能 page) is deleted; whether it was there. */
export function removeMachine(folder: string): boolean {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(folder)) return false;
  const path = join(machineDir(), folder);
  if (!existsSync(join(path, "SKILL.md"))) return false;
  rmSync(path, { recursive: true, force: true });
  return true;
}

/** The public references kept from searches, each with its key (the folder it is in). */
export function discoveredList(): (Skill & { key: string })[] {
  return discovered().map((skill) => ({ ...skill, key: basename(dirname(skill.path ?? "")) }));
}

/** A kept public reference is deleted; whether it was there. */
export function removeDiscovered(key: string): boolean {
  if (!/^[0-9a-f]{20}$/.test(key)) return false;
  const path = join(settings.data_dir, "skills-discovered", key);
  if (!existsSync(path)) return false;
  rmSync(path, { recursive: true, force: true });
  return true;
}

// Lessons from earlier tasks (learning), written into this machine's skill for their tools,
// newest first, each between markers so that disabling one takes it out again.
export const LESSONS = "## Lessons from earlier tasks (checked here)";
export const MAX_LESSON_CHARS = 1500;

const marked = (lessonId: string, flags = "s") =>
  pyRegex(`<!-- lesson:${reEscape(lessonId)} -->\\n.*?<!-- /lesson:${reEscape(lessonId)} -->\\n?`, flags);

/** Write a checked lesson (a SKILL.md) into this machine's skills for its ``tools``; a new machine
 *  skill made of it when there is none. The skills it is in now. */
export function addLesson(lessonId: string, title: string, text: string, tools: string[]): string[] {
  const lesson = parse(text);
  let body = (lesson ? lesson.body : text).trim();
  if (body.length > MAX_LESSON_CHARS) body = head(body, MAX_LESSON_CHARS) + "\n[...]";
  const block = `<!-- lesson:${lessonId} -->\n### ${title}\n${body}\n<!-- /lesson:${lessonId} -->\n`;
  const wanted = new Set(tools.map((tool) => tool.toLowerCase()));
  const targets = library().filter((skill) => skill.machine && skill.path && skill.tools.some((tool) => wanted.has(tool)));
  if (!targets.length) {
    const name = lesson ? lesson.name : tools[0] ?? lessonId;
    const description = lesson ? lesson.description : title;
    const top = `---\nname: ${name}\ndescription: ${description}\ntools: [${tools.join(", ")}]\n---\n# ${name}\n`;
    return [saveMachine(name, `${top}\n${LESSONS}\n\n${block}`)];
  }
  const saved: string[] = [];
  for (const skill of targets) {
    let current = skill.text.replace(marked(lessonId, "sg"), "");
    if (current.includes(LESSONS)) {
      current = current.replace(`${LESSONS}\n\n`, () => `${LESSONS}\n\n${block}`);
    } else {
      // Right after the front matter, so a long skill cut to fit a step's prompt keeps them.
      const match = FRONT.exec(current);
      const at = match ? match.index + match[0].length : 0;
      current = `${current.slice(0, at)}${LESSONS}\n\n${block}\n${current.slice(at)}`;
    }
    writeFileSync(skill.path!, current);
    saved.push(skill.path!);
  }
  return saved;
}

/** Take a lesson out of this machine's skills again; the skills it was in. */
export function removeLesson(lessonId: string): string[] {
  const changed: string[] = [];
  for (const skill of library()) {
    if (!(skill.machine && skill.path && marked(lessonId).test(skill.text))) continue;
    let text = skill.text.replace(marked(lessonId, "sg"), "");
    if (!text.includes("<!-- lesson:")) text = text.replace(pyRegex(`\\n?${reEscape(LESSONS)}\\n+`), "\n");
    const left = parse(text);
    if (!left || ["", `# ${skill.name}`].includes(left.body.trim())) {
      // A skill made of lessons alone, with none left: nothing to give a step.
      rmSync(dirname(skill.path), { recursive: true, force: true });
    } else {
      writeFileSync(skill.path, text);
    }
    changed.push(skill.path);
  }
  return changed;
}

