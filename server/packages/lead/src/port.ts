// What FluidForm asks of the lead (server/src/ports/lead.ts) that is more than one prompt: the lead's
// words for a failed attempt and for an ended repair. FluidForm asks the lead and does what it decides.
import { contracts, type LeadPort } from "../../../src/extension-api.js";
import * as prompts from "./prompts.js";

export const leads = true;

export const failureMessage: LeadPort["failureMessage"] = ({ run, node, verdict, outcome, choices, left, targets }) => {
  let prompt = outcome === "verify_failed" ? prompts.verificationMessage(run, node, verdict, choices, left)
    : prompts.failureMessage(run, node, node.attempts.at(-1)!, verdict, choices, left, targets);
  if (outcome === "stopped" && node.artifact_contract !== null) prompt += "\n" + prompts.limitNote(node, contracts.extension(node));
  if (outcome === "blocked") prompt += "\n" + prompts.blockedNote();
  return prompt;
};

export const repairMessage: LeadPort["repairMessage"] = ({ run, node, diagnosis, choices, left }) =>
  prompts.repairMessage(run, node, diagnosis, choices, left);
