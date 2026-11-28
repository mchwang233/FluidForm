// What FluidForm asks of the check before a task's first step (server/src/ports/learning.ts) that is
// more than one function of preflight.ts.
import { performance } from "node:perf_hooks";
import type { LearningPort } from "../../../src/extension-api.js";
import { cliChecks, PASSED, sandboxChecks } from "./preflight.js";

export const environmentChecks: LearningPort["environmentChecks"] = async (run, workspace, cli, configured) =>
  [...(await sandboxChecks(run, workspace)), ...(cli ? await cliChecks(cli, run, workspace, configured) : [])];

export const remember: LearningPort["remember"] = (key, checks) => {
  PASSED.set(key, [performance.now(), checks.map((check) => ({ ...check }))]);
};
