// The learning package's entry: what FluidForm asks of it (server/src/ports/learning.ts).
export { learn } from "./learning.js";
export { nameProblems } from "./naming.js";
export { environmentChecks, remember } from "./port.js";
export { cacheKey, describe, failures, passedBefore, repairPrompt, skillPrompt } from "./preflight.js";
export { available, modelChecks, prepareSkills } from "./preflighting.js";

// What FluidForm calls this package through (server/src/ports/learning.ts): compiling fails when the two part.
import type { Implements, LearningPort } from "../../../src/extension-api.js";
export type Contract = Implements<LearningPort, typeof import("./index.js")>;
