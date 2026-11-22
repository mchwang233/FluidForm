// The planning package's entry: what FluidForm asks of it (server/src/planning.ts).
// planner.ts imports it when it plans (the two import each other): read with the package, as a
// running FluidForm must not go back to the disk for it (extensions.preload).
import "./task-planning.js";
import { taskPlanning } from "./planner.js";

/** Everything the package reads late, read when it is loaded. */
export async function ready(): Promise<void> {
  await taskPlanning();
}

export { autonomousPlan } from "./planner.js";
export { planningBrief } from "./brief.js";
export { quick } from "./quick.js";
export { changePlan } from "./replan.js";
export { delegate } from "./team-planning.js";
