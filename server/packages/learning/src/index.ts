// The learning package's entry: what FluidForm asks of it (server/src/experience.ts).
export { learn } from "./learning.js";
export { nameProblems } from "./naming.js";
export { allChecks, available, modelChecks, preflight, preflightRepair, prepareSkills, publicReference, writeSkill } from "./preflighting.js";

// What FluidForm calls this package through (server/src/experience.ts): compiling fails when the two part.
import type { Implements, LearningPackage } from "../../../src/extension-api.js";
export type Contract = Implements<LearningPackage, typeof import("./index.js")>;
