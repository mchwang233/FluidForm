// What FluidForm asks of planning (server/src/ports/planning.ts), done by this package's functions.
import type { PlanningPort } from "../../../src/extension-api.js";
import { planningBrief } from "./brief.js";
import { autonomousPlan } from "./planner.js";
import { quick as judge } from "./quick.js";

export const plan: PlanningPort["plan"] = (input, host) =>
  autonomousPlan(input.prompt, input.models, input.configured, host, input.projectContext, input.session, input.brief);

export const brief: PlanningPort["brief"] = async (root, dataDir, host, writer) => planningBrief(root, dataDir, host, await writer());

export const quick: PlanningPort["quick"] = async (text, host, model, solo, project) => judge(text, host, await model(), solo, project);
