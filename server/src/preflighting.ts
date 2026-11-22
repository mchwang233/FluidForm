// The check before a task's first step, as the executor runs it (Python's preflight.Preflighting
// mixin): the learning extension does it (packages/learning/src).
import { uses } from "./features.js";
import { Engineering } from "./engineer.js";
import * as environment from "./environment.js";
import { type ExecutionRun, type PreflightCheck } from "./models.js";
import { head } from "./py.js";
import * as skills from "./skills.js";
import * as experience from "./experience.js";

export abstract class Preflighting extends Engineering {
  /** Check, repair once, check again; whether the steps may start. A task the user went on with after a
   *  failed check is not stopped again. */
  async preflight(runId: string): Promise<boolean> {
    if (!uses.preflight()) return true;
    return experience.preflight.call(this, runId);
  }

  /** The platform's sandbox, the membership CLIs' own sandboxes, the models. */
  async allChecks(run: ExecutionRun, workspace: string): Promise<PreflightCheck[]> {
    return experience.allChecks.call(this, run, workspace);
  }

  /** This machine's skill for each tool the task needs: kept from an earlier task, or written now by a
   *  model trying the tool in a step's sandbox. Returns the skills' names; one that cannot be prepared is
   *  left out (the steps then find the tool out themselves). */
  async prepareSkills(runId: string, workspace: string, checks: PreflightCheck[]): Promise<string[]> {
    return experience.prepareSkills.call(this, runId, workspace, checks);
  }

  /** A public skill about ``tools``: cached from an earlier search, or searched for now when the task
   *  allows the internet; null without one. */
  async publicReference(runId: string, name: string, tools: string[]): Promise<skills.Skill | null> {
    return experience.publicReference.call(this, runId, name, tools);
  }

  /** The tools a step's sandbox can run (command -v). */
  async available(run: ExecutionRun, workspace: string, tools: string[]): Promise<string[]> {
    return experience.available.call(this, run, workspace, tools);
  }

  /** Have a model that works through tools try ``tools`` in a scratch folder of the task's workspace (the
   *  steps' sandbox) and write what holds here as a SKILL.md. */
  async writeSkill(run: ExecutionRun, workspace: string, name: string, tools: string[], general: skills.Skill | null, checks: PreflightCheck[],
    signal?: AbortSignal): Promise<string> {
    return experience.writeSkill.call(this, run, workspace, name, tools, general, checks, signal);
  }

  /** A tiny request to each API model the plan's steps are routed to (and the lead's, if it is one); a
   *  model that does not answer is a warning, since another takes its place. */
  async modelChecks(run: ExecutionRun): Promise<PreflightCheck[]> {
    return experience.modelChecks.call(this, run);
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
    return experience.preflightRepair.call(this, runId, failed, workspace);
  }
}
