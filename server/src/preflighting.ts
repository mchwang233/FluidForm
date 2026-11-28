// The check before a task's first step, as the executor runs it (Python's preflight.Preflighting
// mixin): check, repair the environment once, check again, prepare skills, and write what it found into
// the task. What is checked, how the results read and which skill each tool gets are the learning
// extension's (ports/learning.ts).
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CliChannelRegistry } from "./cli-channels.js";
import { settings } from "./config.js";
import { parse as parseDiagnosis } from "./diagnosis.js";
import { Engineering } from "./engineer.js";
import * as environment from "./environment.js";
import { uses } from "./features.js";
import { nowIso } from "./lax.js";
import { type ExecutionRun, type PreflightCheck, PreflightSchema, TaskNodeSchema } from "./models.js";
import { begun } from "./ports/learning.js";
import { head } from "./py.js";
import { routeNode } from "./routing.js";
import * as skills from "./skills.js";
import { isCancelled } from "./tasks.js";

export abstract class Preflighting extends Engineering {
  /** Check, repair once, check again; whether the steps may start. A task the user went on with after a
   *  failed check is not stopped again. */
  async preflight(runId: string): Promise<boolean> {
    if (!uses.preflight()) return true;
    const port = await begun();
    let run = this.db.getRun(runId);
    if (!run || run.preflight?.passed) return true;
    if (!run.plan.nodes.some((node) => node.status === "pending") && !run.plan.parts.length) return true;
    const overruled = Boolean(run.preflight?.paused);
    this.emit(runId, "run.preflight_started");
    const workspace = this.ensureFolder(Preflighting.folder(run, null));
    const key = port.cacheKey(run);
    const cached = port.passedBefore(key);
    let checks = cached ?? (await this.allChecks(run, workspace));
    let repaired = Boolean(run.preflight?.repaired);
    let engineerNote = "";
    if (port.failures(checks).length && !repaired && !overruled) {
      repaired = true;
      if (await this.preflightRepair(runId, port.failures(checks), workspace)) {
        run = this.db.getRun(runId)!;
        checks = await this.allChecks(run, workspace);
      }
      // FluidForm's own sandbox still failing after the environment repair is FluidForm's defect: the
      // platform engineer is asked to fix it (once, as the repair is).
      const own = port.failures(checks).filter((check) => check.command === "(内置)");
      if (own.length) engineerNote = this.preflightEngineer(runId, own);
    }
    const failed = port.failures(checks);
    const prepared = failed.length && !overruled ? [] : await this.prepareSkills(runId, workspace, checks);
    run = this.db.getRun(runId)!;
    run.preflight = PreflightSchema.parse({ passed: !failed.length, checks, repaired, paused: Boolean(failed.length) && !overruled, skills: prepared,
      cached: cached !== null });
    if (!failed.length && cached === null) port.remember(key, checks);
    if (failed.length && !overruled) {
      run.status = "paused";
      run.error = "执行前检查没有通过，任务还没开始执行，没有花在步骤上：\n" + port.describe(failed)
        + "\n装好或修好后点“继续”会重新检查；确定不需要这些，也可以直接点“继续”，任务会照常执行。" + (engineerNote ? `\n${engineerNote}` : "");
    }
    this.save(run);
    this.emit(runId, "run.preflight", { passed: !failed.length, overruled: Boolean(failed.length) && overruled, cached: cached !== null,
      failed: failed.map((check) => check.command || check.name), warnings: port.failures(checks, false).map((check) => check.command || check.name) });
    if (failed.length && !overruled) {
      this.emit(runId, "approval.required", { reason: "preflight_failed" });
      return false;
    }
    return true;
  }

  /** The platform's sandbox, the membership CLIs' own sandboxes, the models. */
  async allChecks(run: ExecutionRun, workspace: string): Promise<PreflightCheck[]> {
    const port = await begun();
    const cli = (this.providers.cli as Pick<CliChannelRegistry, "sandboxRun"> | undefined) ?? null;
    return [...(await port.environmentChecks(run, workspace, cli, this.configured(run))),
      ...(await port.modelChecks(run, (modelId, prompt, options) => this.complete(run, null, modelId, prompt, null, options)))];
  }

  /** This machine's skill for each tool the task needs: kept from an earlier task, or written now by a
   *  model trying the tool in a step's sandbox. Returns the skills' names; one that cannot be prepared is
   *  left out (the steps then find the tool out themselves). */
  async prepareSkills(runId: string, workspace: string, checks: PreflightCheck[]): Promise<string[]> {
    const run = this.db.getRun(runId)!;
    return (await begun()).prepareSkills(run, workspace, checks, {
      emit: (kind, data) => this.emit(runId, kind, data),
      // Read again: the user may have enabled networking during the startup checks.
      allowsNetwork: () => Boolean(this.db.getRun(runId)?.allow_network),
      available: (tools) => this.available(run, workspace, tools),
      writeSkill: (name, tools, general, signal) => this.writeSkill(run, workspace, name, tools, general, checks, signal),
    });
  }

  /** The tools a step's sandbox can run (command -v). */
  async available(run: ExecutionRun, workspace: string, tools: string[]): Promise<string[]> {
    return (await begun()).available(run, workspace, tools);
  }

  /** Have a model that works through tools try ``tools`` in a scratch folder of the task's workspace (the
   *  steps' sandbox) and write what holds here as a SKILL.md. */
  async writeSkill(run: ExecutionRun, workspace: string, name: string, tools: string[], general: skills.Skill | null, checks: PreflightCheck[],
    signal?: AbortSignal): Promise<string> {
    const node = TaskNodeSchema.parse({ id: "skill", title: `Skill: ${name}`, instructions: "", capability: "coding", difficulty: "normal", needs_workspace: true });
    await routeNode(node, Object.values(this.modelLookup), this.configured(run));
    const scratch = join(workspace, `.skill-${name}`);
    mkdirSync(scratch, { recursive: true });
    try {
      const result = await this.complete(run, null, node.model_id!, (await begun()).skillPrompt(run, name, tools, general, checks), scratch, {
        act: true, effort: "medium", ...(settings.skill_reuse_first ? { max_turns: settings.skill_generation_max_turns } : {}), signal });
      return result.text;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  /** Ask the platform engineer to fix FluidForm's own failing sandbox checks, with what they printed and
   *  what the diagnosis found; what to tell the user. */
  preflightEngineer(runId: string, failed: PreflightCheck[]): string {
    const run = this.db.getRun(runId)!;
    const found = [...run.diagnoses].reverse().find((item) => item.trigger === "preflight" && item.report)?.report ?? "";
    const request = "执行前检查里，FluidForm 自己的沙箱检查没通过；修过环境后复查仍然失败，像是平台本身的缺陷。\n"
      + failed.map((check) => `- ${check.name}，输出：\n${head(check.output, 1500)}`).join("\n") + (found ? `\n\n修环境时的报告：\n${head(found, 2000)}` : "");
    const [job, why] = this.engineerJoin(runId, { request, kind: "repair" }, "diagnosis");
    return job ? `已请平台工程师修这个检查（工作 ${job.id}）。` : `想请平台工程师来修，但${why}`;
  }

  /** One environment repair for the failed checks, by the diagnosers; whether it ran. */
  async preflightRepair(runId: string, failed: PreflightCheck[], workspace: string): Promise<boolean> {
    // Without the platform engineer what is missing waits for the user, saying why.
    if (uses.stuckWaits()) return false;
    const port = await begun();
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
        [result, , cost] = await this.diagnoseWith(run, diagnosis, null, port.repairPrompt(run, failed, workspace, tools), workspace, true);
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
}
