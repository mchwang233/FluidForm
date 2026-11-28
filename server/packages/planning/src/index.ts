// The planning package's entry: what FluidForm asks of it (server/src/ports/planning.ts).
// planner.ts imports it when it plans (the two import each other): read with the package, as a
// running FluidForm must not go back to the disk for it (extensions.preload).
import "./task-planning.js";
import { taskPlanning } from "./planner.js";

/** Everything the package reads late, read when it is loaded. */
export async function ready(): Promise<void> {
  await taskPlanning();
}

export { brief, plan, quick } from "./port.js";
export { changePlan } from "./replan.js";
export { delegate } from "./team-planning.js";

// What FluidForm calls this package through (server/src/ports/planning.ts): compiling fails when the two part.
import type { Implements, PlanningPort } from "../../../src/extension-api.js";
export type Contract = Implements<PlanningPort, typeof import("./index.js")>;
