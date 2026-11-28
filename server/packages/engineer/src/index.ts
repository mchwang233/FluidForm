// The platform engineer package's entry: what FluidForm asks of it (server/src/ports/engineer.ts). It
// words what the models are asked; FluidForm asks them and does the rest.
export { platformRepairPrompt } from "./fixing.js";
export { checkFailed, continueNote, editPrompt, planPrompt } from "./jobs.js";
export { prompt as diagnosisPrompt, repairPrompt } from "./prompts.js";

// What FluidForm calls this package through (server/src/ports/engineer.ts): compiling fails when the two part.
import type { EngineerPort, Implements } from "../../../src/extension-api.js";
export type Contract = Implements<EngineerPort, typeof import("./index.js")>;
