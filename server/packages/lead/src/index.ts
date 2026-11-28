// The lead package's entry: what FluidForm asks of it (server/src/lead.ts).
export { reviewResult } from "./acceptance.js";
export { criticalCheck, overrun } from "./overrun.js";
export { afterRepair, applyDecision, decide, decision, finalDecision, leadAnswer, proposeCapabilities } from "./leading.js";
export { engineerMessage } from "./prompts.js";

// What FluidForm calls this package through (server/src/lead.ts): compiling fails when the two part.
import type { Implements, LeadPackage } from "../../../src/extension-api.js";
export type Contract = Implements<LeadPackage, typeof import("./index.js")>;
