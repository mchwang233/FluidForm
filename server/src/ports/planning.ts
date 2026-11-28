// The planning port (docs/design/capability-ports.md): what FluidForm asks of planning, what planning
// may ask of FluidForm, and how FluidForm plans without it (base). Planning's code is the planning
// extension's (packages/planning/src), loaded while it is on; nothing here imports it.
import { randomUUID } from "node:crypto";
import * as extensions from "../extensions.js";
import { type ExecutionRun, type ModelProfile, type SupervisorSession, type TaskNode, type TaskPlan, TaskNodeSchema, TaskPlanSchema } from "../models.js";
import { available } from "../provided.js";
import type { CompleteOptions, ProviderResult } from "../providers.js";

/** What planning may ask of FluidForm: a model, once or in the task's planning conversation. */
export interface PlanningHost {
  complete(modelId: string, prompt: string, options?: CompleteOptions): Promise<ProviderResult>;
  converse(session: SupervisorSession, text: string, options?: { timeout?: number | null; signal?: AbortSignal }): Promise<ProviderResult>;
}

/** A request to plan. ``prompt`` is what the planner reads: the request, after the task it changes
 *  when there is one (``background``). */
export type PlanInput = {
  prompt: string;
  request: string;
  background: string | null;
  projectDir: string | null;
  projectContext: string | null;
  models: ModelProfile[];
  configured: Set<string>;
  session: SupervisorSession;
  brief: string | null;
};

/** A request one model can do in one go (``quick``) or carry through alone (``solo``). */
export type QuickStep = { shape: string; title: string; capability: string; needs_images: boolean; acceptance: string };

export type PlanChanges = { added: string[]; removed: string[]; updated: string[] };

export interface PlanningPort {
  /** The brief of the project at ``root`` to plan from, and what writing it cost; [null, 0] for none.
   *  ``writer`` gives the model to write it with, asked only when one is needed. */
  brief(root: string, dataDir: string, host: PlanningHost, writer: () => Promise<ModelProfile | null>): Promise<[string | null, number]>;
  /** Whether one model can do ``text`` in one go, or with ``solo`` carry it through alone; and what
   *  judging cost. ``model`` gives the model that judges, asked only when one is needed. */
  quick(text: string, host: PlanningHost, model: () => Promise<ModelProfile | null>, solo?: boolean, project?: boolean): Promise<[QuickStep | null, number]>;
  /** The plan for a request. */
  plan(input: PlanInput, host: PlanningHost): Promise<TaskPlan>;
  /** A running task's plan changed as its lead decided (in place): the steps added, removed and updated. */
  changePlan(run: ExecutionRun, change: Record<string, any>, models: ModelProfile[], configured: Set<string>, needsVision?: boolean,
    deciding?: string | null): Promise<PlanChanges>;
  /** The steps an employee hands to other employees. */
  delegate(run: ExecutionRun, parent: TaskNode, payload: Record<string, any>, models: ModelProfile[], configured: Set<string>,
    needsVision?: boolean): Promise<TaskNode[]>;
}

// Said to the one step a task without the lead's plan gets: do what was asked, no more. A small game
// once came with two test suites, a headless demo and a README, and took six minutes, not one.
export const QUICK_SCOPE = "\n\n（这是一件小事：只做要求的。做完先自己运行或检查一次，能用就交付；"
  + "没要求的测试套件、演示脚本、说明文档都不用写。）";
export const SOLO_SCOPE = "\n\n（做到要求的程度为止：能用、自己检查过就交付；没要求的额外测试、演示和文档不用写。）";

/** A task without the planning capability: the whole request as one step, done by one model (the
 *  strongest that clears the bar, a membership CLI or an API model working through tools), in the
 *  project when there is one. */
export function oneStep(request: string, background: string | null, projectDir: string | null): TaskPlan {
  const asked = background ? `${background}\n\n新需求：\n${request}` : request;
  const title = [...(request.split(/\r\n|\r|\n/)[0] || request)].slice(0, 40).join("").trim() || "任务";
  const node = TaskNodeSchema.parse({ id: randomUUID().replaceAll("-", "").slice(0, 8), title, capability: "coding", difficulty: "hard",
    needs_workspace: Boolean(projectDir), instructions: asked + SOLO_SCOPE, acceptance_criteria: "需求里要的都做到了，结果可以直接交给用户。" });
  return TaskPlanSchema.parse({ summary: title, title, nodes: [node], planning_note: "没有启用规划能力：整个需求作为一步，交给一个模型做",
    in_project: Boolean(projectDir) });
}

const unplanned = async (): Promise<never> => {
  throw new Error("没有启用规划能力：不能排计划、改计划或委派。");
};

/** How FluidForm plans without the planning capability: the whole request as one step, no brief, no
 *  quick judgement; a plan is not changed or delegated (the lead offers neither then). */
export const base: PlanningPort = {
  brief: async () => [null, 0],
  quick: async () => [null, 0],
  plan: async (input) => oneStep(input.request, input.background, input.projectDir),
  changePlan: unplanned,
  delegate: unplanned,
};

/** Planning as FluidForm asks it now: the planning extension's code while it is on, else base. */
export async function planning(): Promise<PlanningPort> {
  return available("planning") ? extensions.load<PlanningPort>("planning") : base;
}
