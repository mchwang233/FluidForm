// The planning capability, as FluidForm asks it: its code is the planning extension's
// (packages/planning/src), loaded the first time it is needed while it is on. Nothing here imports it.
import * as extensions from "./extensions.js";
import type { ExecutionRun, ModelProfile, SupervisorSession, TaskNode, TaskPlan } from "./models.js";
import { available } from "./provided.js";

export type QuickStep = { shape: string; title: string; capability: string; needs_images: boolean; acceptance: string };

export interface PlanningPackage {
  autonomousPlan(prompt: string, models: ModelProfile[], configured: Set<string>, providers: any, projectContext?: string | null,
    session?: SupervisorSession | null, brief?: string | null): Promise<TaskPlan>;
  planningBrief(root: string, dataDir: string, providers: any, writer: any): Promise<[string, number]>;
  quick(text: string, providers: any, model: ModelProfile | null, solo?: boolean, project?: boolean): Promise<[QuickStep | null, number]>;
  changePlan(run: ExecutionRun, change: Record<string, any>, models: ModelProfile[], configured: Set<string>, needsVision?: boolean,
    deciding?: string | null): Promise<{ added: string[]; removed: string[]; updated: string[] }>;
  delegate(run: ExecutionRun, parent: TaskNode, payload: Record<string, any>, models: ModelProfile[], configured: Set<string>,
    needsVision?: boolean): Promise<TaskNode[]>;
}

async function pack(): Promise<PlanningPackage> {
  if (!available("planning")) throw new Error("没有启用规划能力：不能排计划、改计划或委派。");
  return extensions.load<PlanningPackage>("planning");
}

export const autonomousPlan: PlanningPackage["autonomousPlan"] = async (...args) => (await pack()).autonomousPlan(...args);
export const changePlan: PlanningPackage["changePlan"] = async (...args) => (await pack()).changePlan(...args);
export const delegate: PlanningPackage["delegate"] = async (...args) => (await pack()).delegate(...args);
export const planningBrief: PlanningPackage["planningBrief"] = async (...args) => (await pack()).planningBrief(...args);
export const quick: PlanningPackage["quick"] = async (...args) => (await pack()).quick(...args);
