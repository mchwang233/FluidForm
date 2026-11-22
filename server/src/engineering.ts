// The diagnosis and platform engineer capabilities, as FluidForm asks them: their code is the engineer
// extension's (packages/engineer/src), loaded the first time it is needed while it is on. Nothing here
// imports it. Copying the source, checking, applying and restarting stay FluidForm's.
import type { Diagnosing } from "./diagnosing.js";
import type { Engineering } from "./engineer.js";
import * as extensions from "./extensions.js";
import type { Diagnosis, EngineerJob, ExecutionRun, TaskNode } from "./models.js";
import { available } from "./provided.js";
import type { ProviderResult } from "./providers.js";
import type * as quality from "./quality.js";
import type { SelfRepair } from "./self-repair.js";

export interface EngineerPackage {
  repair(this: Diagnosing, runId: string, nodeId: string, verdict: quality.Verdict, outcome: string,
    options?: { diagnosisId?: string | null; brief?: string; decisionId?: string | null }): Promise<void>;
  diagnoseWith(this: Diagnosing, run: ExecutionRun, diagnosis: Diagnosis, node: TaskNode | null, prompt: string, workspace: string, repair: boolean,
    platformRepair?: boolean): Promise<[ProviderResult, string, number]>;
  runDiagnosis(this: Diagnosing, runId: string, diagnosisId: string): Promise<void>;
  fixPlatform(this: SelfRepair, run: ExecutionRun, diagnosis: Diagnosis, node: TaskNode | null, problem: string): Promise<[string, number]>;
  engineerPlan(this: Engineering, job: EngineerJob): Promise<void>;
  engineerEdit(this: Engineering, job: EngineerJob): Promise<void>;
}

/** The code for work already begun: switching the engineer off lets that end as it would have. */
const begun = () => extensions.load<EngineerPackage>("engineer");

async function pack(name: "diagnosis" | "engineer"): Promise<EngineerPackage> {
  if (!available(name)) throw new Error("没有启用平台工程师能力。");
  return extensions.load<EngineerPackage>("engineer");
}

export const repair: EngineerPackage["repair"] = async function (...args) {
  return (await pack("diagnosis")).repair.call(this, ...args);
};
export const diagnoseWith: EngineerPackage["diagnoseWith"] = async function (...args) {
  return (await begun()).diagnoseWith.call(this, ...args);
};
export const runDiagnosis: EngineerPackage["runDiagnosis"] = async function (...args) {
  return (await pack("diagnosis")).runDiagnosis.call(this, ...args);
};
export const fixPlatform: EngineerPackage["fixPlatform"] = async function (...args) {
  return (await begun()).fixPlatform.call(this, ...args);
};
export const engineerPlan: EngineerPackage["engineerPlan"] = async function (...args) {
  return (await pack("engineer")).engineerPlan.call(this, ...args);
};
export const engineerEdit: EngineerPackage["engineerEdit"] = async function (...args) {
  return (await pack("engineer")).engineerEdit.call(this, ...args);
};
