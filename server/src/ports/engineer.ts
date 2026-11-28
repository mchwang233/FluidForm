// The diagnosis and platform engineer port (docs/design/capability-ports.md). The engineer extension
// (packages/engineer/src) words what the models are asked: to look into a stuck task, to repair what
// blocks a step, to fix FluidForm itself, to plan and make a change to it. Everything done around
// those requests is FluidForm's: which models are asked and in what order, the diagnosis records and
// what they do to the task (diagnosing.ts), the source copy, its checks and applying it (self-repair.ts,
// platform-repair.ts), and the platform engineer's jobs (engineer.ts). Without the capability a task
// that is stuck waits for the user, saying why (features.ts ``stuckWaits``), and nothing here is asked.
import type { EngineerJob, ExecutionRun, TaskNode } from "../models.js";
import * as extensions from "../extensions.js";
import { available } from "../provided.js";

export interface EngineerPort {
  /** Look into a stuck task (``nodeId``: its step, or null for the task) from its events, and say what to do. */
  diagnosisPrompt(run: ExecutionRun, nodeId: string | null, workspace: string, events: string[], platform?: string): string;
  /** Find and repair what blocks ``node`` from outside the task. ``tools``: the shared tools folder;
   *  ``ports``: the host ports a step reaches; ``brief``: what the lead asked to be repaired;
   *  ``earlier``: the same kind of problem in earlier tasks. */
  repairPrompt(run: ExecutionRun, node: TaskNode, workspace: string, tools: string, ports: number[], events: string[],
    sharedRepairs?: Record<string, any>[], platform?: string, brief?: string, earlier?: string[]): string;
  /** Fix a defect of FluidForm itself, found by the diagnosis ``problem``, in a source copy whose repair
   *  guide is ``guide``; ``replies``: the user's last answers in the task. */
  platformRepairPrompt(run: ExecutionRun, problem: string, replies: { question: string | null; answers: unknown[] }[], guide: string): string;
  /** Plan the change ``job`` asks for, for the user to approve. */
  planPrompt(job: EngineerJob, guide: string): string;
  /** Make the change ``job`` asks for (or repair the defect); ``feedback``: what the last round left to do. */
  editPrompt(job: EngineerJob, guide: string, feedback?: string): string;
  /** Told when the source copy already has the engineer's earlier changes to ``files``. */
  continueNote(files: string[]): string;
  /** Told when FluidForm's own check of the change failed with ``output``. */
  checkFailed(output: string): string;
}

/** The engineer extension's code while ``name`` ("diagnosis" or "engineer") is on. Without it FluidForm
 *  does not ask: a stuck task waits for the user instead (features.ts). */
export async function engineer(name: "diagnosis" | "engineer"): Promise<EngineerPort> {
  if (!available(name)) throw new Error("没有启用平台工程师能力。");
  return extensions.load<EngineerPort>("engineer");
}

/** The engineer extension's code for work already begun: switching it off lets that end as it would have. */
export function begun(): Promise<EngineerPort> {
  return extensions.load<EngineerPort>("engineer");
}
