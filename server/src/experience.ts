// The learning, preflight and skill-preparing capabilities, as FluidForm asks them: their code is the
// learning extension's (packages/learning/src), loaded the first time it is needed while it is on.
// Nothing here imports it.
import * as extensions from "./extensions.js";
import type { LearningHost } from "./learning.js";
import type { ExecutionRun, ModelProfile, PreflightCheck } from "./models.js";
import type { Preflighting } from "./preflighting.js";
import { available as provided } from "./provided.js";
import type { Completion, Review } from "./retrospect.js";
import type { Skill } from "./skills.js";

export interface LearningPackage {
  learn(host: LearningHost, runId: string, signal: AbortSignal): Promise<void>;
  nameProblems(db: any, complete: (modelId: string, prompt: string) => Promise<Completion>, models: ModelProfile[], configured: Set<string>,
    runId: string): Promise<Review | null>;
  preflight(this: Preflighting, runId: string): Promise<boolean>;
  allChecks(this: Preflighting, run: ExecutionRun, workspace: string): Promise<PreflightCheck[]>;
  prepareSkills(this: Preflighting, runId: string, workspace: string, checks: PreflightCheck[]): Promise<string[]>;
  publicReference(this: Preflighting, runId: string, name: string, tools: string[]): Promise<Skill | null>;
  available(this: Preflighting, run: ExecutionRun, workspace: string, tools: string[]): Promise<string[]>;
  writeSkill(this: Preflighting, run: ExecutionRun, workspace: string, name: string, tools: string[], general: Skill | null, checks: PreflightCheck[],
    signal?: AbortSignal): ReturnType<Preflighting["writeSkill"]>;
  modelChecks(this: Preflighting, run: ExecutionRun): Promise<PreflightCheck[]>;
  preflightRepair(this: Preflighting, runId: string, failed: PreflightCheck[], workspace: string): Promise<boolean>;
}

/** The code for work already begun: switching learning off lets that end as it would have. */
const begun = () => extensions.load<LearningPackage>("learning");

async function pack(name: "learning" | "preflight"): Promise<LearningPackage> {
  if (!provided(name)) throw new Error("没有启用经验能力。");
  return extensions.load<LearningPackage>("learning");
}

export const learn: LearningPackage["learn"] = async function (...args) {
  return (await pack("learning")).learn(...args);
};
export const nameProblems: LearningPackage["nameProblems"] = async function (...args) {
  return (await pack("learning")).nameProblems(...args);
};
export const preflight: LearningPackage["preflight"] = async function (...args) {
  return (await pack("preflight")).preflight.call(this, ...args);
};
export const allChecks: LearningPackage["allChecks"] = async function (...args) {
  return (await begun()).allChecks.call(this, ...args);
};
export const prepareSkills: LearningPackage["prepareSkills"] = async function (...args) {
  return (await begun()).prepareSkills.call(this, ...args);
};
export const publicReference: LearningPackage["publicReference"] = async function (...args) {
  return (await begun()).publicReference.call(this, ...args);
};
export const available: LearningPackage["available"] = async function (...args) {
  return (await begun()).available.call(this, ...args);
};
export const writeSkill: LearningPackage["writeSkill"] = async function (...args) {
  return (await begun()).writeSkill.call(this, ...args);
};
export const modelChecks: LearningPackage["modelChecks"] = async function (...args) {
  return (await begun()).modelChecks.call(this, ...args);
};
export const preflightRepair: LearningPackage["preflightRepair"] = async function (...args) {
  return (await begun()).preflightRepair.call(this, ...args);
};
