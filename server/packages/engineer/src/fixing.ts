// How the platform engineer fixes FluidForm itself for a task. The copy, its checks and applying it are
// FluidForm's (server/src/platform-repair.ts, self-repair.ts).
import { PLATFORM_SCOPE } from "../../../src/models.js";
import { join } from "node:path";
import { settings } from "../../../src/config.js";
import { parse as parseDiagnosis } from "../../../src/diagnosis.js";
import type { Diagnosis, ExecutionRun, TaskNode } from "../../../src/models.js";
import { failureOutput, RepairError, repairGuide } from "../../../src/platform-repair.js";
import { pyDumps, pyRound } from "../../../src/py.js";
import { MAX_ENVIRONMENT_FIXES } from "../../../src/recovery.js";
import type { SelfRepair } from "../../../src/self-repair.js";

type Json = Record<string, any>;

export async function fixPlatform(this: SelfRepair, run: ExecutionRun, diagnosis: Diagnosis, node: TaskNode | null, problem: string): Promise<[string, number]> {
  let latest = this.db.getRun(run.id)!;
  let record = latest.diagnoses.find((d) => d.id === diagnosis.id)!;
  record.scope = PLATFORM_SCOPE;
  this.save(latest);
  if (this.platformPending) {
    record.repair_id = this.platformPending.id;
    this.save(latest);
    return ["已有公共平台修复通过验证，等待自动生效。\nSTATUS: PLATFORM_PENDING", 0];
  }
  if (node && node.environment_fixes >= MAX_ENVIRONMENT_FIXES) throw new RepairError("同一步骤的公共修复已达到本轮上限，请结合已有验证结果重新定位，避免重复修改平台。");
  const job = await this.platform.prepare(run.id, diagnosis.id, { allowNetwork: latest.allow_network });
  // The platform engineer's page lists it too.
  const recordJob = this.recordPlatformRepair(run, diagnosis, node, problem, job);
  latest = this.db.getRun(run.id)!;
  record = latest.diagnoses.find((d) => d.id === diagnosis.id)!;
  record.repair_id = job.id;
  this.save(latest);
  this.emit(run.id, "run.platform_repair", { diagnosis_id: diagnosis.id, repair_id: job.id, phase: "editing" });
  const replied = latest.diagnoses.filter((d) => d.messages.length).sort((a, b) => (a.messages.at(-1)!.created_at < b.messages.at(-1)!.created_at ? -1 : 1));
  const replies = replied.slice(-5).map((d) => ({ question: d.question, answers: d.messages.slice(-5) }));
  const base = "[[fluidform:platform-repair]]\n"
    + "Fix an evidenced defect in FluidForm itself in this isolated source copy. "
    + "The user authorizes this repair. Preserve unrelated existing changes. Modify "
    + "application code and add a regression test reproducing the defect; do not weaken "
    + "or delete existing tests. Do not change task data, credentials, Git history, live "
    + "source, or restart any services. The controller independently runs backend tests, "
    + "frontend tests and a build, then applies and activates a passing patch for all projects. "
    + "Use file tools to implement the fix, not merely report advice. If a real user choice "
    + "is required, use QUESTION, OPTIONS (JSON array), and STATUS: NEEDS_INPUT; otherwise "
    + "describe your fix in Chinese and end with STATUS: FIXED.\n"
    + "Follow the repair skill below. Start from the diagnosis's LOCATION lines; read only "
    + "the code around them.\n\n"
    + `${repairGuide(join(job.folder, "source"))}\n\n`
    + `Original task: ${run.prompt}\nDiagnosis: ${problem}\n`
    + `User replies: ${pyDumps(replies, false)}\n`;
  let feedback = "";
  let cost = 0;
  try {
    let result!: { text: string };
    let modelId = "";
    let checks: { name: string }[] = [];
    for (let attempt = 0; attempt < settings.platform_repair_attempts; attempt += 1) {
      let extra: number;
      [result, modelId, extra] = await this.diagnoseWith(run, diagnosis, node, base + feedback, join(job.folder, "source"), false, true);
      cost += extra;
      recordJob.model_id = modelId;
      const status = parseDiagnosis(result.text)[2];
      if (status === "needs_input" || status === "blocked") {
        Object.assign(job, { status: "awaiting_input", report: result.text });
        this.platform.save(job);
        recordJob.status = "failed";
        recordJob.report = parseDiagnosis(result.text)[0];
        recordJob.error = "修复需要你回答问题，已交回任务里的平台工程师。";
        recordJob.cost_usd = pyRound(cost, 6);
        this.engineerEnd(recordJob);
        return [result.text, cost];
      }
      recordJob.status = "validating";
      this.engineerSave(recordJob);
      this.emit(run.id, "run.platform_repair", { repair_id: job.id, phase: "validating", attempt: attempt + 1 });
      try {
        // The user can change network permission while the candidate is being edited. Validation
        // follows the current task setting too.
        job.allow_network = Boolean(this.db.getRun(run.id)?.allow_network);
        checks = await this.platform.check(job);
        break;
      } catch (error) {
        if (!(error instanceof RepairError) || attempt + 1 === settings.platform_repair_attempts) throw error;
        feedback = `\nThe independent check failed. Fix it and recheck:\n${failureOutput(error.message, 6000)}`;
      }
    }
    let report = parseDiagnosis(result.text)[0];
    report += "\n\n## 自动验证\n" + checks.map((check) => `- ${check.name}: 通过`).join("\n");
    report += "\n\n## 影响范围\nFluidForm 公共代码；生效后供所有项目使用。\n修改：" + job.files.join("、");
    Object.assign(job, { report, model_id: modelId });
    recordJob.status = "applying";
    recordJob.report = parseDiagnosis(result.text)[0];
    recordJob.files = job.files;
    recordJob.checks = checks.map((check) => check.name);
    recordJob.diff = this.platform.diff(job);
    recordJob.cost_usd = pyRound(cost, 6);
    this.engineerSave(recordJob);
    this.scheduleRepair(job);
    return [report + "\nSTATUS: PLATFORM_PENDING", cost];
  } catch (error) {
    Object.assign(job, { status: "failed", error: (error as Error)?.message || this.whyStopped(run.id, error) });
    this.platform.save(job);
    recordJob.status = "failed";
    recordJob.error = String(job.error).slice(0, 2000);
    recordJob.cost_usd = pyRound(cost + (((error as Json)?.accounted_cost_usd as number) ?? 0), 6);
    this.engineerEnd(recordJob);
    if (error && typeof error === "object") (error as Json).accounted_cost_usd = (((error as Json).accounted_cost_usd as number) ?? 0) + cost;
    throw error;
  }
}
