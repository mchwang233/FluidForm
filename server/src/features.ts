// Whether each part of how a task is done is in use (docs/design/task-capabilities.md): its setting
// on, and its capability there (from its package, or still from FluidForm itself, provided.ts).
// Without them FluidForm still does a task: as one step, retried by fixed rules, its own check the
// only acceptance, paused with the reason when it is stuck.
import { settings } from "./config.js";
import { available } from "./provided.js";

export const uses = {
  /** The request split into steps (else one step: the whole request). */
  planning: () => available("planning"),
  /** Employees the lead assigns the steps to. */
  team: () => settings.employee_teams && available("team") && available("planning"),
  /** A step of a task with employees may hand work to another employee. */
  delegation: () => available("team") && available("planning"),
  /** The lead decides after a failure and at the end, and answers in the task. */
  lead: () => settings.lead_decisions && available("lead"),
  /** Another model checks each step's result. */
  review: () => settings.acceptance && available("review"),
  /** Without the lead capability a failed step is retried by fixed rules (not merely its setting off). */
  fixedRetries: () => !available("lead"),
  /** Without the platform engineer's diagnosis a stuck task waits for the user, saying why. */
  stuckWaits: () => !available("diagnosis"),
  /** Without the review capability (not merely its setting off) a step's own check is its acceptance. */
  ownCheckOnly: () => !available("review"),
  /** A stuck step is diagnosed. */
  diagnosis: () => settings.auto_diagnose && available("diagnosis"),
  /** Failed attempts are held for the lead's decision: it needs no platform engineer for that. */
  decisions: () => settings.auto_diagnose,
  /** The platform engineer repairs and adds to FluidForm. */
  engineer: () => available("engineer"),
  /** Finished tasks are looked back on and lessons kept. */
  learning: () => available("learning"),
  /** What a task needs is checked before it starts. */
  preflight: () => settings.preflight && available("preflight"),
  /** Steps are given the skills for the tools they name. */
  skills: () => available("skills"),
  /** The providers' catalogs, prices and leaderboards are looked up, and the models scored from them. */
  research: () => available("research"),
};
