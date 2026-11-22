// Repairing FluidForm itself: an edited and checked copy (platform-repair.ts) applied
// by a restart, while tasks wait.
import { PLATFORM_SCOPE } from "./models.js";
import { performance } from "node:perf_hooks";
import { settings } from "./config.js";
import { Diagnosing } from "./diagnosing.js";
import { nowIso } from "./lax.js";
import type { Diagnosis, EngineerJob, ExecutionRun, TaskNode } from "./models.js";
import { type RepairJob } from "./platform-repair.js";
import * as quality from "./quality.js";
import { isCancelled, sleep, Task } from "./tasks.js";
import * as engineer from "./engineering.js";

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
  fixPlatform(run: ExecutionRun, diagnosis: Diagnosis, node: TaskNode | null, problem: string): Promise<[string, number]> {
    return engineer.fixPlatform.call(this, run, diagnosis, node, problem);
  }

  /** A checked repair is applied by a restart, which only FluidForm itself does. */
  scheduleRepair(job: RepairJob): void {
    this.platform.schedule(job);
    this.platformPending = job;
    this.maintenanceTask = new Task(() => this.activatePlatform(job));
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
    this.db.saveSharedRepair({ id: job.id, scope: PLATFORM_SCOPE, status: job.status, run_id: job.run_id ?? null, model_id: job.model_id ?? null, files: job.files,
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
