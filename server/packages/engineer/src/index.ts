// The platform engineer package's entry: what FluidForm asks of it (server/src/engineering.ts).
export { diagnoseWith, repair, runDiagnosis } from "./diagnosing.js";
export { fixPlatform } from "./fixing.js";
export { engineerEdit, engineerPlan } from "./jobs.js";

// What FluidForm calls this package through (server/src/engineering.ts): compiling fails when the two part.
import type { Implements, EngineerPackage } from "../../../src/extension-api.js";
export type Contract = Implements<EngineerPackage, typeof import("./index.js")>;
