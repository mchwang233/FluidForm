// Repairing Super Partner itself: an edited and checked copy (platform-repair.ts) applied
// by a restart, while tasks wait.
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { settings } from "./config.js";
import { parse as parseDiagnosis } from "./diagnosis.js";
import { Diagnosing } from "./diagnosing.js";
import { nowIso } from "./lax.js";
import type { Diagnosis, EngineerJob, ExecutionRun, TaskNode } from "./models.js";
import { RepairError, type RepairJob, repairGuide } from "./platform-repair.js";
import { pyDumps, pyRound, tail } from "./py.js";
import * as quality from "./quality.js";
import { MAX_ENVIRONMENT_FIXES } from "./recovery.js";
import { isCancelled, sleep, Task } from "./tasks.js";

// How long a checked change waits for steps that can be cut off: such a step runs again after the
// restart (resume_after_restart), so its task need not finish first.
export const limits = { APPLY_WAIT_SECONDS: 300 };
type Json = Record<string, any>;

/** Whether a restart may stop this task's steps: it goes on by itself afterwards and touches no project
 *  a half-done step could leave half-edited. */
export function cutOffSafely(run: ExecutionRun | null): boolean {
  return Boolean(run) && settings.resume_after_restart && !run!.project_dir;
}

export abstract class SelfRepair extends Diagnosing {
  abstract recordPlatformRepair(run: ExecutionRun, diagnosis: Diagnosis, node: TaskNode | null, problem: string, copy: RepairJob): EngineerJob;
  abstract engineerSave(job: EngineerJob): void;
  abstract engineerEnd(job: EngineerJob): void;
  abstract engineerFinished(record: RepairJob): void;
  abstract engineerKick(): void;

  holdForPlatform(run: ExecutionRun, force = false): void {
    if (!this.platformPending || (!force && run.status !== "queued" && run.status !== "running")) return;
    run.maintenance_id = this.platformPending.id;
    run.status = "paused";
    run.error = "FluidForm 的一项改动已通过验证，正在等待在途步骤结束并自动生效，之后继续任务。";
    this.save(run);
    this.emit(run.id, "run.platform_waiting", { repair_id: run.maintenance_id });
  }

  /** Prepare source changes separately; only independent successful checks can apply them. */
  async fixPlatform(run: ExecutionRun, diagnosis: Diagnosis, node: TaskNode | null, problem: string): Promise<[string, number]> {
    let latest = this.db.getRun(run.id)!;
    let record = latest.diagnoses.find((d) => d.id === diagnosis.id)!;
    record.scope = "super_partner";
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
    const base = "[[super-partner:platform-repair]]\n"
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
          feedback = `\nThe independent check failed. Fix it and recheck:\n${tail(error.message, 6000)}`;
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
      this.platform.schedule(job);
      this.platformPending = job;
      this.maintenanceTask = new Task(() => this.activatePlatform(job));
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

  async activatePlatform(job: RepairJob): Promise<void> {
    try {
      await this.waitToApply();
      // Retrospectives improve later work, so cancelling their source is not rejecting the separate,
      // checked engineering job. Deleted sources still block activation.
      const initiating = job.run_id ? this.db.getRun(job.run_id) : null;
      const engineer = this.db.getEngineerJob(job.engineer_job_id || "");
      const retrospective = Boolean(engineer && engineer.origin === "retrospective" && engineer.status === "applying" && engineer.run_id === job.run_id
        && engineer.repair_id === job.id);
      if (job.run_id && (!initiating || (initiating.status === "cancelled" && !retrospective))) {
        Object.assign(job, { status: "cancelled", error: "请平台工程师的任务已取消或删除，未应用平台改动。" });
        this.platform.save(job);
        this.finishPlatform(job);
        return;
      }
      await this.platform.launch(job);
      await this.watchPlatform();
    } catch (error) {
      if (isCancelled(error)) throw error;
      Object.assign(job, { status: "failed", error: (error as Error)?.message ?? String(error) });
      this.platform.save(job);
      this.finishPlatform(job);
    }
  }

  /** What stopped a platform repair that says nothing itself: the task was cancelled, or a restart or
   *  shutdown cut it off. */
  whyStopped(runId: string, error: unknown): string {
    if (isCancelled(error)) {
      const latest = this.db.getRun(runId);
      if (!latest || latest.status === "cancelled") return "任务被取消或删除了，这次平台修复跟着停下，没有改动 FluidForm。";
      return "服务重启或停止打断了这次平台修复，没有改动 FluidForm；任务接着做时会再查一次。";
    }
    return `平台修复没能完成（${(error as Error)?.name ?? "Error"}），没有改动 FluidForm。`;
  }

  /** Wait for what a restart must not cut off: requests being handled, repairs and the lead's answers,
   *  and the steps of tasks in a project (they could leave it half-edited). Steps of other tasks get
   *  limits.APPLY_WAIT_SECONDS to finish; after that the restart stops them, and they run again when their task
   *  goes on. */
  async waitToApply(): Promise<void> {
    const deadline = performance.now() + limits.APPLY_WAIT_SECONDS * 1000;
    for (;;) {
      const running = [...this.tasks].filter(([, task]) => !task.done).map(([runId]) => runId);
      const waiting = running.filter((runId) => !cutOffSafely(this.db.getRun(runId)));
      const busy = [...this.diagnosing.values(), ...this.leadTasks.values()].some((task) => !task.done);
      if (!this.activeRequests && !busy && !waiting.length && (!running.length || performance.now() >= deadline)) return;
      await sleep(0.5);
    }
  }

  /** Called on API startup; ordinary interrupted tasks still require confirmation. */
  restorePlatform(): void {
    const pending = this.platform.pending();
    if (!pending) return;
    this.platformPending = pending;
    if (pending.status === "validated") {
      pending.old_pid = process.pid;
      this.maintenanceTask = new Task(() => this.activatePlatform(pending));
    } else this.maintenanceTask = new Task(() => this.watchPlatform());
  }

  async watchPlatform(): Promise<void> {
    const deadline = performance.now() + 420_000;
    let job: RepairJob | null = null;
    while (performance.now() < deadline) {
      job = this.platform.pending();
      if (!job) return;
      if (["activated", "failed", "rolled_back", "cancelled"].includes(job.status)) {
        this.finishPlatform(job);
        return;
      }
      await sleep(0.5);
    }
    if (!job) return;
    Object.assign(job, { status: "failed", error: "平台修复生效超时；任务状态已保留，未宣称修复成功。" });
    this.platform.save(job);
    this.finishPlatform(job);
  }

  finishPlatform(job: RepairJob): void {
    const success = job.status === "activated";
    const ready: string[] = [];
    const toLead: [string, string][] = [];
    for (const run of this.db.listRuns()) {
      const records = run.diagnoses.filter((d) => d.repair_id === job.id);
      const held = run.maintenance_id === job.id;
      if (!records.length && !held) continue;
      for (const record of records) {
        record.status = success ? "done" : "failed";
        record.verdict = success ? "platform_fixed" : "platform_failed";
        record.error = success ? null : job.error ?? "平台修复未生效。";
        record.report = (record.report || "") + (success ? "\n\n平台修复已生效，服务健康检查通过。" : `\n\n平台修复未生效：${record.error}`);
        const node = run.plan.nodes.find((n) => n.id === record.node_id);
        const last = node?.attempts.at(-1);
        if (success && node && last && last.outcome === "error") {
          let evidence = last.result !== null ? "本次回答已保存，见本次尝试记录。" : "本次回答未记录；缺失的回答和退出状态必须标为未知，不得用旧回答补齐。";
          if (last.trace) evidence += ` 原始证据：${last.trace}。`;
          const note = "平台修复不代表任务验收通过。先核对本次尝试的回答、原始日志及工作目录中的有效证据，保留已有裁决和验收要求，仅补齐未完成部分，不要重复整轮工作。" + evidence;
          node.feedback = [node.feedback, note].filter(Boolean).join("\n");
          record.report += "\n" + note;
        }
      }
      // A repair the lead asked for goes back to it, applied or not, before the step runs again.
      const asked = records.find((record) => record.trigger === "lead_repair" && record.node_id && this.canLead());
      if (held) {
        run.maintenance_id = null;
        if (asked && run.status === "paused" && !run.waiting_diagnosis_id) {
          toLead.push([run.id, asked.id]);
          if (!success) run.error = job.error ?? "平台修复未生效，任务现场已保留。";
        } else if (run.status === "paused") {
          if ((success || (job.status === "cancelled" && run.id !== job.run_id)) && !run.waiting_diagnosis_id) {
            const required = run.actual_cost_usd + run.plan.nodes.filter((n) => n.status !== "succeeded").reduce((sum, n) => sum + n.estimated_cost_usd, 0);
            if (required <= run.budget_usd) {
              run.status = "queued";
              run.error = null;
              ready.push(run.id);
            } else this.pauseForBudget(run);
          } else run.error = job.error ?? "平台修复未生效，任务现场已保留。";
        }
      }
      this.save(run);
      this.emit(run.id, success ? "run.platform_activated" : "run.platform_failed", { repair_id: job.id, files: job.files, error: job.error ?? null });
    }
    this.db.saveSharedRepair({ id: job.id, scope: "super_partner", status: job.status, run_id: job.run_id ?? null, model_id: job.model_id ?? null, files: job.files,
      checks: job.checks ?? [], report: job.report ?? "", error: job.error ?? null, created_at: nowIso().replace(/Z$/, "+00:00") });
    this.platform.clearPending(job);
    this.platformPending = null;
    this.engineerFinished(job);
    for (const runId of ready) this.start(runId);
    for (const [runId, diagnosisId] of toLead) new Task(() => this.platformToLead(runId, diagnosisId));
    this.engineerKick();
  }

  /** The platform repair the lead asked for has been applied, or not: it decides what happens to the step
   *  (leading.afterRepair); without a decision the task goes on as before. */
  async platformToLead(runId: string, diagnosisId: string): Promise<void> {
    const run = this.db.getRun(runId);
    const diagnosis = run?.diagnoses.find((item) => item.id === diagnosisId);
    const node = diagnosis ? run!.plan.nodes.find((item) => item.id === diagnosis.node_id) : undefined;
    if (!node || !diagnosis) return;
    const last = node.attempts.at(-1);
    const verdict = quality.verdict({ passed: false, reason: last?.reason || "步骤未完成" });
    if (!(await this.afterRepair(runId, node.id, diagnosisId, verdict, last ? last.outcome : "error"))) {
      const go = await this.locked(runId, () => {
        const latest = this.db.getRun(runId)!;
        if (latest.status !== "paused" || diagnosis.verdict !== "platform_fixed") return false;
        latest.status = "queued";
        latest.error = null;
        this.save(latest);
        return true;
      });
      if (go) this.start(runId);
      return;
    }
    await this.continueAfterAnswer(runId);
  }
}
