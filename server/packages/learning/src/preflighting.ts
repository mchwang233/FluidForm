// The check before a task's first step and the skills prepared then. Each runs with the executor as
// ``this`` (server/src/preflighting.ts); the checks and prompts themselves are in preflight.ts.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import * as agentTools from "../../../src/agent.js";
import { settings } from "../../../src/config.js";
import { parse as parseDiagnosis } from "../../../src/diagnosis.js";
import * as environment from "../../../src/environment.js";
import { nowIso } from "../../../src/lax.js";
import { type ExecutionRun, type PreflightCheck, PreflightCheckSchema, PreflightSchema, TaskNodeSchema } from "../../../src/models.js";
import { cacheKey, cliChecks, describe, failures, neededTools, OUTPUT_KEPT, PASSED, passedBefore, repairPrompt, sandboxChecks, skillPrompt,
  toolGroups, withTools } from "./preflight.js";
import { head, pySplit, shlexQuote } from "../../../src/py.js";
import { routeNode } from "../../../src/routing.js";
import * as skillDiscovery from "./skill-discovery.js";
import * as skills from "../../../src/skills.js";
import { isCancelled } from "../../../src/tasks.js";
import type { CliChannelRegistry } from "../../../src/cli-channels.js";
import { Preflighting } from "../../../src/preflighting.js";

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

export async function preflight(this: Preflighting, runId: string): Promise<boolean> {
  let run = this.db.getRun(runId);
  if (!run || run.preflight?.passed) return true;
  if (!run.plan.nodes.some((node) => node.status === "pending") && !run.plan.parts.length) return true;
  const overruled = Boolean(run.preflight?.paused);
  this.emit(runId, "run.preflight_started");
  const workspace = this.ensureFolder(Preflighting.folder(run, null));
  const key = cacheKey(run);
  const cached = passedBefore(key);
  let checks = cached ?? (await this.allChecks(run, workspace));
  let repaired = Boolean(run.preflight?.repaired);
  let engineerNote = "";
  if (failures(checks).length && !repaired && !overruled) {
    repaired = true;
    if (await this.preflightRepair(runId, failures(checks), workspace)) {
      run = this.db.getRun(runId)!;
      checks = await this.allChecks(run, workspace);
    }
    // FluidForm's own sandbox still failing after the environment repair is FluidForm's defect: the
    // platform engineer is asked to fix it (once, as the repair is).
    const own = failures(checks).filter((check) => check.command === "(内置)");
    if (own.length) engineerNote = this.preflightEngineer(runId, own);
  }
  const failed = failures(checks);
  const prepared = failed.length && !overruled ? [] : await this.prepareSkills(runId, workspace, checks);
  run = this.db.getRun(runId)!;
  run.preflight = PreflightSchema.parse({ passed: !failed.length, checks, repaired, paused: Boolean(failed.length) && !overruled, skills: prepared,
    cached: cached !== null });
  if (!failed.length && cached === null) PASSED.set(key, [performance.now(), checks.map((check) => ({ ...check }))]);
  if (failed.length && !overruled) {
    run.status = "paused";
    run.error = "执行前检查没有通过，任务还没开始执行，没有花在步骤上：\n" + describe(failed)
      + "\n装好或修好后点“继续”会重新检查；确定不需要这些，也可以直接点“继续”，任务会照常执行。" + (engineerNote ? `\n${engineerNote}` : "");
  }
  this.save(run);
  this.emit(runId, "run.preflight", { passed: !failed.length, overruled: Boolean(failed.length) && overruled, cached: cached !== null,
    failed: failed.map((check) => check.command || check.name), warnings: failures(checks, false).map((check) => check.command || check.name) });
  if (failed.length && !overruled) {
    this.emit(runId, "approval.required", { reason: "preflight_failed" });
    return false;
  }
  return true;
}

export async function allChecks(this: Preflighting, run: ExecutionRun, workspace: string): Promise<PreflightCheck[]> {
  const cli = this.providers.cli as Pick<CliChannelRegistry, "sandboxRun"> | undefined;
  return [...(await sandboxChecks(run, workspace)), ...(cli ? await cliChecks(cli, run, workspace, this.configured(run)) : []), ...(await this.modelChecks(run))];
}

export async function prepareSkills(this: Preflighting, runId: string, workspace: string, checks: PreflightCheck[]): Promise<string[]> {
  if (!settings.preflight_skills) return [];
  const run = this.db.getRun(runId)!;
  const library = skills.library();
  const wanted = await this.available(run, workspace, neededTools(run, library));
  const ready: string[] = [];
  const prepared: string[] = [];
  const failed: string[] = [];
  for (const [name, tools, given] of toolGroups(wanted, library)) {
    let general = given;
    if (settings.skill_reuse_first) {
      const existing = skills.forTools(tools, library).filter((s) => s.body && tools.every((tool) => s.tools.includes(tool)));
      if (existing.length) {
        ready.push(existing[0].name);
        this.emit(runId, "run.skill_selected", { name: existing[0].name, origin: existing[0].machine ? "machine" : "general" });
        continue;
      }
      // A public skill is only a reference for writing this machine's one: never given to a step as it
      // is, and gone with the generation if that fails.
      if (general === null) general = await this.publicReference(runId, name, tools);
    }
    const mine = settings.skill_reuse_first ? [] : skills.forTools(tools, library).filter((skill) => skill.machine);
    if (mine.length) {
      ready.push(...mine.map((skill) => skill.name));
      continue;
    }
    try {
      this.emit(runId, "run.skill_generating", { name, timeout: settings.skill_preparation_timeout,
        max_turns: settings.skill_reuse_first ? settings.skill_generation_max_turns : null });
      const text = await within(settings.skill_preparation_timeout, (signal) => this.writeSkill(run, workspace, name, tools, general, checks, signal));
      const skill = skills.parse(text);
      if (!skill || !skill.body) throw new Error("the reply was not a SKILL.md");
      skills.saveMachine(name, withTools(text, tools));
      prepared.push(name);
    } catch (error) {
      if (isCancelled(error)) throw error;
      failed.push(`${name}: ${head(String((error as Error)?.message ?? ""), 200) || (error as Error)?.name || "Error"}`);
    }
  }
  this.emit(runId, "run.skills_prepared", { prepared, reused: ready, failed });
  return [...new Set([...ready, ...prepared])];
}

export async function publicReference(this: Preflighting, runId: string, name: string, tools: string[]): Promise<skills.Skill | null> {
  const cached = skills.discovered(tools);
  if (cached.length) {
    this.emit(runId, "run.skill_reference", { name, source_url: cached[0].source_url, revision: cached[0].source_revision, cached: true });
    return cached[0];
  }
  // Read again: the user may have enabled networking during the startup checks.
  const latest = this.db.getRun(runId);
  if (!latest?.allow_network) return null;
  this.emit(runId, "run.skill_searching", { name, tools });
  const found = await skillDiscovery.deps.discover(tools);
  if (!found.skill) {
    this.emit(runId, "run.skill_search_finished", { name, found: false, reason: found.reason });
    return null;
  }
  try {
    skills.saveDiscovered(found.skill);
  } catch {
    // still a reference for this task
  }
  this.emit(runId, "run.skill_reference", { name, source_url: found.skill.source_url, revision: found.skill.source_revision, cached: false });
  return found.skill;
}

export async function available(this: Preflighting, run: ExecutionRun, workspace: string, tools: string[]): Promise<string[]> {
  if (!tools.length || !agentTools.sandboxAvailable()) return [];
  const sandbox = new agentTools.Workspace(workspace, { network: run.allow_network });
  let output: string;
  try {
    [output] = await sandbox.run("Bash", { command: tools.map((tool) => `command -v ${shlexQuote(tool)} >/dev/null && echo ${shlexQuote(tool)}`).join("; ") });
  } finally {
    sandbox.close();
  }
  const found = new Set(pySplit(output));
  return tools.filter((tool) => found.has(tool));
}

export async function writeSkill(this: Preflighting, run: ExecutionRun, workspace: string, name: string, tools: string[], general: skills.Skill | null, checks: PreflightCheck[],
  signal?: AbortSignal): Promise<string> {
  const node = TaskNodeSchema.parse({ id: "skill", title: `Skill: ${name}`, instructions: "", capability: "coding", difficulty: "normal", needs_workspace: true });
  await routeNode(node, Object.values(this.modelLookup), this.configured(run));
  const scratch = join(workspace, `.skill-${name}`);
  mkdirSync(scratch, { recursive: true });
  try {
    const result = await this.complete(run, null, node.model_id!, skillPrompt(run, name, tools, general, checks), scratch, { act: true, effort: "medium",
      ...(settings.skill_reuse_first ? { max_turns: settings.skill_generation_max_turns } : {}), signal });
    return result.text;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function modelChecks(this: Preflighting, run: ExecutionRun): Promise<PreflightCheck[]> {
  const wanted = new Set(run.plan.nodes.map((node) => node.model_id).filter((id): id is string => Boolean(id)));
  if (run.supervisor?.model_id) wanted.add(run.supervisor.model_id);
  const checks: PreflightCheck[] = [];
  for (const modelId of [...wanted].sort()) {
    if (modelId.startsWith("cli:") || modelId.startsWith("mock:")) continue;
    try {
      await within(settings.preflight_command_timeout, (signal) => this.complete(run, null, modelId, "Reply with just: OK", null, { effort: "low", signal }));
      checks.push(PreflightCheckSchema.parse({ name: "模型", command: modelId, blocking: false }));
    } catch (error) {
      if (isCancelled(error)) throw error;
      checks.push(PreflightCheckSchema.parse({ name: "模型", command: modelId, ok: false, blocking: false,
        output: head(String((error as Error)?.message ?? ""), OUTPUT_KEPT) || (error as Error)?.name || "Error" }));
    }
  }
  return checks;
}

export async function preflightRepair(this: Preflighting, runId: string, failed: PreflightCheck[], workspace: string): Promise<boolean> {
  let run = this.db.getRun(runId)!;
  const diagnosisId = this.beginDiagnosis(run, "preflight");
  if (diagnosisId === null) return false;
  this.save(run);
  const diagnosis = run.diagnoses.find((item) => item.id === diagnosisId)!;
  if (diagnosis.status === "failed") return false;
  this.emit(runId, "run.diagnosis_started", { diagnosis_id: diagnosisId, trigger: "preflight", model_id: diagnosis.model_id });
  let report: string | null = null;
  let error: string | null = null;
  let cost = 0;
  try {
    await this.repairLock.run(async () => {
      const tools = environment.prepare();
      let result;
      [result, , cost] = await this.diagnoseWith(run, diagnosis, null, repairPrompt(run, failed, workspace, tools), workspace, true);
      report = result.text;
    });
  } catch (problem) {
    if (isCancelled(problem)) throw problem;
    error = head(String((problem as Error)?.message ?? ""), 500) || (problem as Error)?.name || "Error";
  }
  run = this.db.getRun(runId)!;
  const record = run.diagnoses.find((item) => item.id === diagnosisId)!;
  record.status = error ? "failed" : "done";
  record.error = error;
  record.cost_usd = cost;
  record.finished_at = nowIso();
  if (report !== null) [record.report, record.advice, record.verdict] = parseDiagnosis(report) as [string, string | null, typeof record.verdict];
  this.save(run);
  this.emit(runId, "run.diagnosed", { diagnosis_id: diagnosisId, status: record.status, model_id: record.model_id, verdict: record.verdict });
  return error === null;
}
