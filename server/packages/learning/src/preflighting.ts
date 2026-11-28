// The check before a task's first step and the skills prepared then, as FluidForm asks them
// (server/src/ports/learning.ts): which models to try and which tools the steps' sandbox has, and which
// skill each tool gets. FluidForm runs the check and writes what it found into the task
// (server/src/preflighting.ts); the checks and prompts themselves are in preflight.ts.
import {
  agent as agentTools, type ExecutionRun, head, isCancelled, type LearningPort, type PreflightCheck, PreflightCheckSchema, settings,
  shlexQuote, type SkillHost, skills
} from "../../../src/extension-api.js";
import { neededTools, OUTPUT_KEPT, toolGroups, withTools } from "./preflight.js";
import * as skillDiscovery from "./skill-discovery.js";

class Deadline extends Error {
  override name = "TimeoutError";
}

/** ``work`` within ``seconds``; TimeoutError after (asyncio.wait_for), stopping it with ``stop``. */
async function within<T>(seconds: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const stop = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work(stop.signal), new Promise<never>((_, fail) => {
      timer = setTimeout(() => {
        stop.abort(new Deadline(`${seconds}s`));
        fail(new Deadline(`${seconds}s`));
      }, seconds * 1000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

export const prepareSkills: LearningPort["prepareSkills"] = async (run, workspace, checks, host) => {
  if (!settings.preflight_skills) return [];
  const library = skills.library();
  const wanted = await host.available(neededTools(run, library));
  const ready: string[] = [];
  const prepared: string[] = [];
  const failed: string[] = [];
  const tried = skills.failedSkills();
  // Each skill on its own, all at once: one that takes long holds up only itself, not the others after it.
  await Promise.all(toolGroups(wanted, library).map(async ([name, tools, given]) => {
    let general = given;
    if (settings.skill_reuse_first) {
      const existing = skills.forTools(tools, library).filter((s) => s.body && tools.every((tool) => s.tools.includes(tool)));
      if (existing.length) {
        ready.push(existing[0].name);
        host.emit("run.skill_selected", { name: existing[0].name, origin: existing[0].machine ? "machine" : "general" });
        return;
      }
    }
    const mine = settings.skill_reuse_first ? [] : skills.forTools(tools, library).filter((skill) => skill.machine);
    if (mine.length) {
      ready.push(...mine.map((skill) => skill.name));
      return;
    }
    // Written and failed lately: not tried again for every task (2026-11-27, three skills timing out in
    // each of a task's two preflights, 12 minutes before its first step).
    const earlier = tried[skills.failureKey(name, tools)];
    if (earlier && Date.now() - Date.parse(earlier.at) < SKILL_RETRY_HOURS * 3600_000) {
      host.emit("run.skill_skipped", { name, failed_at: earlier.at, reason: earlier.reason });
      failed.push(`${name}: ${SKILL_RETRY_HOURS} 小时内写过没成（${earlier.reason}），这次不再写`);
      return;
    }
    // A public skill is only a reference for writing this machine's one: never given to a step as it
    // is, and gone with the generation if that fails.
    if (settings.skill_reuse_first && general === null) general = await publicReference(name, tools, host);
    try {
      host.emit("run.skill_generating", { name, timeout: settings.skill_preparation_timeout,
        max_turns: settings.skill_reuse_first ? settings.skill_generation_max_turns : null });
      const text = await within(settings.skill_preparation_timeout, (signal) => host.writeSkill(name, tools, general, signal));
      const skill = skills.parse(text);
      if (!skill || !skill.body) throw new Error("the reply was not a SKILL.md");
      skills.saveMachine(name, withTools(text, tools));
      prepared.push(name);
      skills.noteFailure(name, tools, null);
    } catch (error) {
      if (isCancelled(error)) throw error;
      const reason = head(String((error as Error)?.message ?? ""), 200) || (error as Error)?.name || "Error";
      failed.push(`${name}: ${reason}`);
      skills.noteFailure(name, tools, reason);
    }
  }));
  host.emit("run.skills_prepared", { prepared, reused: ready, failed });
  return [...new Set([...ready, ...prepared])];
};

/** Hours a skill that could not be written is left alone before a task tries again. */
export const SKILL_RETRY_HOURS = 24;
/** Where the step sandbox found each tool (available), for telling a public skill about it from one
 *  about another program of the same name (skillDiscovery.contextWords). */
export const located = new Map<string, string>();

/** A public skill about ``tools``: cached from an earlier search, or searched for now when the task
 *  allows the internet; null without one. */
export async function publicReference(name: string, tools: string[], host: SkillHost): Promise<skills.Skill | null> {
  const context = skillDiscovery.contextWords(tools.map((tool) => located.get(tool)).filter((path): path is string => Boolean(path)), tools);
  const cached = skills.discovered(tools).filter((skill) => skillDiscovery.fits(`${skill.name}\n${skill.description}\n${skill.body}`, context));
  if (cached.length) {
    host.emit("run.skill_reference", { name, source_url: cached[0].source_url, revision: cached[0].source_revision, cached: true });
    return cached[0];
  }
  if (!host.allowsNetwork()) return null;
  host.emit("run.skill_searching", { name, tools });
  const found = await skillDiscovery.deps.discover(tools, { context });
  if (!found.skill) {
    host.emit("run.skill_search_finished", { name, found: false, reason: found.reason });
    return null;
  }
  try {
    skills.saveDiscovered(found.skill);
  } catch {
    // still a reference for this task
  }
  host.emit("run.skill_reference", { name, source_url: found.skill.source_url, revision: found.skill.source_revision, cached: false });
  return found.skill;
}

export const available: LearningPort["available"] = async (run: ExecutionRun, workspace: string, tools: string[]) => {
  if (!tools.length || !agentTools.sandboxAvailable()) return [];
  const sandbox = new agentTools.Workspace(workspace, { network: run.allow_network });
  let output: string;
  try {
    [output] = await sandbox.run("Bash", { command: tools.map((tool) => `p=$(command -v ${shlexQuote(tool)}) && printf '%s\\t%s\\n' ${shlexQuote(tool)} "$(readlink -f "$p" 2>/dev/null || echo "$p")"`).join("; ") });
  } finally {
    sandbox.close();
  }
  const found = new Set<string>();
  for (const line of output.split("\n")) {
    const [tool, path] = line.split("\t");
    if (!tool || !tools.includes(tool.trim())) continue;
    found.add(tool.trim());
    if (path?.trim().startsWith("/")) located.set(tool.trim(), path.trim());
  }
  return tools.filter((tool) => found.has(tool));
};

export const modelChecks: LearningPort["modelChecks"] = async (run, complete) => {
  const wanted = new Set(run.plan.nodes.map((node) => node.model_id).filter((id): id is string => Boolean(id)));
  if (run.supervisor?.model_id) wanted.add(run.supervisor.model_id);
  const checks: PreflightCheck[] = [];
  for (const modelId of [...wanted].sort()) {
    if (modelId.startsWith("cli:") || modelId.startsWith("mock:")) continue;
    try {
      await within(settings.preflight_command_timeout, (signal) => complete(modelId, "Reply with just: OK", { effort: "low", signal }));
      checks.push(PreflightCheckSchema.parse({ name: "模型", command: modelId, blocking: false }));
    } catch (error) {
      if (isCancelled(error)) throw error;
      checks.push(PreflightCheckSchema.parse({ name: "模型", command: modelId, ok: false, blocking: false,
        output: head(String((error as Error)?.message ?? ""), OUTPUT_KEPT) || (error as Error)?.name || "Error" }));
    }
  }
  return checks;
};
