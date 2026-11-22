// The lead and review capabilities, as FluidForm asks them: their code is the lead extension's
// (packages/lead/src), loaded the first time it is needed while it is on. Nothing here imports it.
import * as extensions from "./extensions.js";
import type { ArtifactEvidence, ExecutionRun, TaskNode } from "./models.js";
import { available } from "./provided.js";
import type * as quality from "./quality.js";
import type { ReviewHost } from "./review.js";

export interface LeadPackage {
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
