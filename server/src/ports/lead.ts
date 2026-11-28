// The lead and review ports (docs/design/capability-ports.md). The lead extension (packages/lead/src)
// gives the lead's words and reads its replies, and reviews a step's result; asking the lead in the
// task's conversation, and doing what it decided to the task, are FluidForm's (leading.ts). Without
// the capability (base) FluidForm decides by its fixed rules, and a step's own check is its review.
import * as extensions from "../extensions.js";
import type { ArtifactEvidence, Diagnosis, EngineerJob, ExecutionRun, ModelProfile, TaskNode } from "../models.js";
import { available } from "../provided.js";
import type * as quality from "../quality.js";
import type { ReviewHost } from "../review.js";
import type * as supervisor from "../supervisor.js";

/** A failed attempt of ``node`` (``outcome``; a failed verification is "verify_failed"), for its lead.
 *  ``choices``: the models it may switch the step to; ``left``: the decisions left for the step and for
 *  the task; ``targets``: the steps rework may send back. */
export type Failure = {
  run: ExecutionRun; node: TaskNode; verdict: quality.Verdict; outcome: string; choices: ModelProfile[]; left: [number, number];
  targets: Set<string> | null;
};

/** A repair the lead asked for has ended, as ``diagnosis`` says. */
export type Repaired = { run: ExecutionRun; node: TaskNode; diagnosis: Diagnosis; choices: ModelProfile[]; left: [number, number] };

export interface LeadPort {
  /** Whether there is a lead to ask: without one FluidForm decides by its fixed rules. */
  readonly leads: boolean;
  /** What the lead is told of a failed attempt, to decide what happens to the step. */
  failureMessage(failure: Failure): string;
  /** What the lead is told when a repair it asked for has ended. */
  repairMessage(repaired: Repaired): string;
  /** What the lead is told when the user answered its question; ``rework``: it may send steps back. */
  answerMessage(node: TaskNode, question: string, answer: string, rework: boolean): string;
  /** What the lead is told when every step has finished; ``left``: the decisions left for the task. */
  finalMessage(run: ExecutionRun, left: number): string;
  /** What the lead is told of the platform engineer's work it asked for. */
  engineerMessage(run: ExecutionRun, node: TaskNode, job: EngineerJob, choices: ModelProfile[], left: [number, number]): string | Promise<string>;
  /** The decision in the lead's reply; null when it gives no valid one. ``final``: every step has finished. */
  readDecision(reply: string, modelIds: Set<string>, targets: Set<string> | null, final: boolean): supervisor.Decision | null;
  /** How to answer, said again to a lead whose reply held no valid decision. */
  decisionFormat(rework: boolean, final: boolean): string;
  /** Whether a step that has worked ``minutes`` without the outputs it promised should stop: the reason, or null. */
  criticalCheck(host: ReviewHost, runId: string, node: TaskNode, modelId: string, minutes: number, evidence: string, asked: number[]): Promise<string | null>;
  /** Whether a step far past its expected turns should stop: the reason, or null. */
  overrun(host: ReviewHost, run: ExecutionRun, node: TaskNode, modelId: string, expected: number, evidence: string, turns: number): Promise<string | null>;
}

export interface ReviewPort {
  /** Another model's verdict on a step's result. */
  reviewResult(host: ReviewHost, run: ExecutionRun, node: TaskNode, text: string, changed: string[], workspace: string | null,
    evidence?: ArtifactEvidence | null): Promise<quality.Verdict>;
}

const noLead = (): never => {
  throw new Error("没有启用负责人能力。");
};

/** Without the lead capability: no lead to ask (FluidForm's fixed rules decide), and no overrun checks. */
export const base: LeadPort = {
  leads: false,
  failureMessage: noLead,
  repairMessage: noLead,
  answerMessage: noLead,
  finalMessage: noLead,
  engineerMessage: noLead,
  readDecision: () => null,
  decisionFormat: noLead,
  criticalCheck: async () => null,
  overrun: async () => null,
};

/** Without the review capability no other model reviews a step (its own check is its review, review.ts). */
export const noReview: ReviewPort = {
  reviewResult: async () => noLead(),
};

/** The lead as FluidForm asks it now: the lead extension's code while it is on, else base. */
export async function lead(): Promise<LeadPort> {
  return available("lead") ? extensions.load<LeadPort>("lead") : base;
}

/** The review of a step's result as FluidForm asks it now: the lead extension's code while review is on. */
export async function review(): Promise<ReviewPort> {
  return available("review") ? extensions.load<ReviewPort>("lead") : noReview;
}
