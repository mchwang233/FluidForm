// The lead and review capabilities, as FluidForm asks them: their code is the lead extension's
// (packages/lead/src), loaded the first time it is needed while it is on. Nothing here imports it.
import * as extensions from "./extensions.js";
import type { ArtifactEvidence, ExecutionRun, TaskNode } from "./models.js";
import type { Leading } from "./leading.js";
import { available } from "./provided.js";
import type * as quality from "./quality.js";
import type { ReviewHost } from "./review.js";
import type * as supervisor from "./supervisor.js";

type Choice = supervisor.Decision | "budget" | null;

export interface LeadPackage {
  decide(this: Leading, runId: string, nodeId: string, verdict: quality.Verdict, outcome: string): Promise<void>;
  decision(this: Leading, runId: string, nodeId: string | null, prompt: string, modelIds: Set<string>, targets: Set<string> | null, final: boolean): Promise<Choice>;
  finalDecision(this: Leading, runId: string): Promise<boolean>;
  applyDecision(this: Leading, runId: string, nodeId: string, decision: supervisor.Decision, verdict: quality.Verdict, outcome: string, event: string): Promise<void>;
  afterRepair(this: Leading, runId: string, nodeId: string, diagnosisId: string, verdict: quality.Verdict, outcome: string): Promise<boolean>;
  proposeCapabilities(this: Leading, runId: string): Promise<void>;
  leadAnswer(this: Leading, runId: string, questionId: string): Promise<void>;
  reviewResult(host: ReviewHost, run: ExecutionRun, node: TaskNode, text: string, changed: string[], workspace: string | null,
    evidence?: ArtifactEvidence | null): Promise<quality.Verdict>;
  criticalCheck(host: ReviewHost, runId: string, node: TaskNode, modelId: string, minutes: number, evidence: string, asked: number[]): Promise<string | null>;
  overrun(host: ReviewHost, run: ExecutionRun, node: TaskNode, modelId: string, expected: number, evidence: string, turns: number): Promise<string | null>;
}

async function pack(name: "lead" | "review"): Promise<LeadPackage> {
  if (!available(name)) throw new Error("没有启用负责人能力。");
  return extensions.load<LeadPackage>("lead");
}

export const reviewResult: LeadPackage["reviewResult"] = async (...args) => (await pack("review")).reviewResult(...args);
// Switched off while an attempt runs: it goes on.
export const criticalCheck: LeadPackage["criticalCheck"] = async (...args) => (available("lead") ? (await pack("lead")).criticalCheck(...args) : null);
export const overrun: LeadPackage["overrun"] = async (...args) => (available("lead") ? (await pack("lead")).overrun(...args) : null);
export const decide: LeadPackage["decide"] = async function (...args) {
  return (await pack("lead")).decide.call(this, ...args);
};
export const decision: LeadPackage["decision"] = async function (...args) {
  return (await pack("lead")).decision.call(this, ...args);
};
export const finalDecision: LeadPackage["finalDecision"] = async function (...args) {
  return (await pack("lead")).finalDecision.call(this, ...args);
};
export const applyDecision: LeadPackage["applyDecision"] = async function (...args) {
  return (await pack("lead")).applyDecision.call(this, ...args);
};
export const afterRepair: LeadPackage["afterRepair"] = async function (...args) {
  return (await pack("lead")).afterRepair.call(this, ...args);
};
export const proposeCapabilities: LeadPackage["proposeCapabilities"] = async function (...args) {
  return (await pack("lead")).proposeCapabilities.call(this, ...args);
};
export const leadAnswer: LeadPackage["leadAnswer"] = async function (...args) {
  return (await pack("lead")).leadAnswer.call(this, ...args);
};
