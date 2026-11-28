// The lead package's entry: what FluidForm asks of it (server/src/ports/lead.ts). It words what the
// lead is told and reads what it decides, and reviews steps; FluidForm asks it and does the rest.
export { reviewResult } from "./acceptance.js";
export { criticalCheck, overrun } from "./overrun.js";
export { failureMessage, leads, repairMessage } from "./port.js";
export { answerMessage, decisionFormat, engineerMessage, finalMessage, parseDecision as readDecision } from "./prompts.js";

// What FluidForm calls this package through (server/src/ports/lead.ts): compiling fails when the two part.
import type { Implements, LeadPort, ReviewPort } from "../../../src/extension-api.js";
export type Contract = Implements<LeadPort & ReviewPort, typeof import("./index.js")>;
