// What the platform engineer is asked when it fixes FluidForm itself for a task (server/src/ports/engineer.ts).
// The copy, its checks, applying it and the rounds are FluidForm's (server/src/self-repair.ts, platform-repair.ts).
import { type EngineerPort, pyDumps } from "../../../src/extension-api.js";

export const platformRepairPrompt: EngineerPort["platformRepairPrompt"] = (run, problem, replies, guide) =>
  "[[fluidform:platform-repair]]\n"
    + "Fix an evidenced defect in FluidForm itself in this isolated source copy. "
    + "The user authorizes this repair. Preserve unrelated existing changes. Modify "
    + "application code and add a regression test reproducing the defect; do not weaken "
    + "or delete existing tests. Do not change task data, credentials, Git history, live "
    + "source, or restart any services. The controller independently runs backend tests, "
    + "frontend tests and a build, then applies and activates a passing patch for all projects. "
    + "Use file tools to implement the fix, not merely report advice. If a real user choice "
    + "is required, use QUESTION, OPTIONS (JSON array), and STATUS: NEEDS_INPUT; otherwise "
    + "describe your fix in Chinese and end with STATUS: FIXED.\n"
    + "Follow the repair skill below. Start from the diagnosis's LOCATION lines; read only "
    + "the code around them.\n\n"
    + `${guide}\n\n`
    + `Original task: ${run.prompt}\nDiagnosis: ${problem}\n`
    + `User replies: ${pyDumps(replies, false)}\n`;
