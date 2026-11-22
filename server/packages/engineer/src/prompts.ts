// What the platform engineer is told when it looks into a stuck step or repairs it.
import { timeKey } from "../../../src/lax.js";
import { type ExecutionRun, Outcome, type TaskNode } from "../../../src/models.js";
import { fixed, head, pyStr, sortedBy } from "../../../src/py.js";
import { recentFailures, SWITCH_AFTER } from "../../../src/recovery.js";
import * as skills from "../../../src/skills.js";
import { MAX_RESULT_CHARS, NETWORK_CHOICE, STATUS, OPTIONS, INTERACTION_INSTRUCTIONS, USER_ACTION, REPORT_FORMAT, toolSummary, ENGINEER } from "../../../src/diagnosis.js";

/** The request, the plan, and every attempt of every step. */
export function history(run: ExecutionRun, events: string[]): string[] {
  const lines = [
    `User request:\n${run.prompt}`,
    `\nTask status: ${run.status}; spent $${fixed(run.actual_cost_usd, 4)} of $${fixed(run.budget_usd, 2)}; rework rounds ${run.rework_rounds}.`,
  ];
  if (run.error) lines.push(`Task error: ${run.error}`);
  lines.push("\nPlan steps:");
  run.plan.nodes.forEach((node, position) => {
    lines.push(`\n## ${String(position + 1).padStart(2, "0")} ${node.title} [${node.status}] model=${node.model_id ?? "None"} `
      + `difficulty=${node.difficulty} capability=${node.capability}`);
    lines.push(`Instructions: ${node.instructions}`);
    if (node.acceptance_criteria) lines.push(`Acceptance criteria: ${node.acceptance_criteria}`);
    if (node.dependencies.length) lines.push(`Depends on: ${node.dependencies.join(", ")}`);
    node.attempts.forEach((attempt, index) => {
      const number = index + 1;
      lines.push(`- attempt ${number}: ${attempt.outcome} by ${attempt.model_id ?? "None"}`
        + (attempt.reviewer_model_id ? ` (reviewed by ${attempt.reviewer_model_id})` : "") + `: ${attempt.reason || ""}`);
      if (attempt.tool_calls.length) lines.push(toolSummary(attempt, number === node.attempts.length));
      if (attempt.result !== null) {
        lines.push(`attempt ${number} result (source=${attempt.result_source || "unknown"}):\n` + head(attempt.result, MAX_RESULT_CHARS));
      } else {
        lines.push(`attempt ${number} result: unknown (not recorded; do not substitute an older answer)`);
      }
      if (attempt.trace) lines.push(`attempt ${number} evidence trace: ${attempt.trace}`);
    });
    if (node.feedback) lines.push(`Pending feedback: ${node.feedback}`);
    if (node.changed_files.length) lines.push(`Changed files: ${node.changed_files.slice(0, 40).join(", ")}`);
    if (node.result && !node.attempts.some((attempt) => attempt.result === node.result)) {
      const clipped = head(node.result, MAX_RESULT_CHARS);
      lines.push(`Historical node output (attempt/source unknown; not evidence of the latest attempt):\n${clipped}`
        + (node.result.length > clipped.length ? "\n[...]" : ""));
    }
  });
  if (events.length) lines.push("\nRecent events:\n" + events.slice(-40).join("\n"));
  const replied = sortedBy(run.diagnoses.filter((diagnosis) => diagnosis.messages.length),
    (diagnosis) => timeKey(diagnosis.messages[diagnosis.messages.length - 1].created_at));
  for (const diagnosis of replied.slice(-5)) {
    lines.push(`\nPrevious diagnosis (${diagnosis.id}):\n${head(diagnosis.report || "", 2000)}`);
    if (diagnosis.question) lines.push(`Question to the user: ${diagnosis.question}`);
    for (const message of diagnosis.messages.slice(-5)) {
      lines.push(`User's reply: choice=${message.choice || "(free text)"}\n${message.text}`);
    }
  }
  lines.push(INTERACTION_INSTRUCTIONS);
  return lines;
}

export function platformInstructions(context: string): string {
  return "\n# FluidForm itself\n"
    + "Distinguish a task mistake, a shared environment problem, and a defect in FluidForm "
    + "itself (scheduler, model fallback, budgets, tools, persistence, API, or web UI). "
    + "The user authorizes fixing FluidForm defects, including common causes affecting "
    + "other projects. Do not hand an actionable platform bug back to the user. "
    + "Read the application source and correlate it with the failing operation and evidence. "
    + "If the application needs a code fix, describe the specific defect and a regression check, "
    + "give one `LOCATION: path:line function — what is wrong` line per place to change (the "
    + "repair phase starts from them), then end with `STATUS: PLATFORM_REPAIR`. This starts a separate "
    + "source-editing and validation phase automatically. Do not edit the live application "
    + "or restart services in this investigation phase. An upstream quota/outage alone is "
    + "not a platform bug: use the existing model-switch statuses.\n" + context;
}

/** Analysis only: why the task is stuck, for the 诊断 button. */
export function prompt(run: ExecutionRun, nodeId: string | null, workspace: string, events: string[], platform = ""): string {
  const lines = [
    `${ENGINEER} You were asked to find out why a multi-model task is not completing. Investigate, `
      + "but do not modify any files: only read them and run read-only checks.",
    `Working directory of the task: ${workspace}`,
    "",
    ...history(run, events),
    platformInstructions(platform),
  ];
  const focus = run.plan.nodes.find((node) => node.id === nodeId);
  if (focus) lines.push(`\nFocus on step '${focus.title}', which ran out of attempts.`);
  lines.push(`\nWrite the diagnosis in ${REPORT_FORMAT}`);
  lines.push("If the user's replies resolve a pending question and work can continue, end with STATUS: RETRY.");
  return lines.join("\n");
}

export type SharedRepair = Record<string, any>;

/** Find and repair what blocks a step from outside the task, or say what should happen. ``brief``
 *  is what the task's lead asked to be repaired; ``earlier`` the same kind of problem in earlier
 *  tasks (retrospect.similar). */
export function repairPrompt(run: ExecutionRun, node: TaskNode, workspace: string, tools: string, ports: number[], events: string[],
  sharedRepairs: SharedRepair[] = [], platform = "", brief = "", earlier: string[] = []): string {
  const portNote = ports.length ? `local ports ${ports.join(", ")} only` : "nothing";
  const last = node.attempts.length ? node.attempts[node.attempts.length - 1] : null;
  return [
    `${ENGINEER} Attempt ${node.attempts.length} of step '${node.title}' in a multi-model task just failed`
      + (last ? ` (${last.outcome}: ${head(last.reason || "", 300)})` : "") + ". Find out why, "
      + "and repair whatever blocks it outside the task itself: missing software, sandbox or "
      + "machine limits, configuration, licenses, unreachable services. Do not do the step's work "
      + "and do not change the task's files; the scheduler selects the model for the next attempt.",
    ...(brief ? [`The task's lead, who follows the whole task, sent you to repair this: ${brief}`] : []),
    ...repeated(node),
    ...(last && last.outcome === Outcome.UNABLE ? ["The attempt reported that part of the step cannot be done in this environment (outcome "
      + "`unable`). Lift that limit if you can (FIXED), or ask the user when only they can decide "
      + "(NEEDS_INPUT). If the claim is wrong and the step can be done as is, say RETRY and how. "
      + "Otherwise answer BLOCKED with the USER_ACTION that would make it possible: the step is "
      + "then reported as not doable here, with your report, instead of pausing the task."] : []),
    `Working directory of the task: ${workspace}`,
    "",
    "# What you may do",
    "You are responsible for completing recoverable repairs, not merely suggesting them. "
      + "Use your tools to make and verify the fix before reporting FIXED. Install missing tools "
      + "in the shared user-writable tools folder when possible instead of asking for root. "
      + "For an upstream model outage or exhausted usage, return the model-switch status below; "
      + "the scheduler can solve that without the user. Do not claim a repair from a proposal alone.",
    "Your commands run on the host as the user, with network access, but without root: sudo "
      + "and other setuid programs are blocked. Anything that needs root (system packages, "
      + "system services, files under /etc) is for the user: put the exact commands in the report.",
    "",
    "# Where the step's commands run",
    "API models' commands run in a bubblewrap sandbox: the system is read-only, the home folder "
      + "is hidden (only the working directory is mounted), /tmp is private, the environment is "
      + "cleared, " + (run.allow_network
        ? `and this task allows the internet, but not this machine's local services (reachable: ${portNote}). `
          + "Membership CLIs' sandboxes also allow the internet for this task."
        : `and the network is cut off (reachable: ${portNote}). Membership CLIs run in their own `
          + "sandboxes, also without network.")
      + " So software installed under the home folder or only added to a shell profile is invisible to them.",
    ...(run.allow_network ? [] : [
      "This task does not allow the internet. Install what a step needs yourself (you have "
        + "network access). Only if the step itself must reach the internet while it runs (call an "
        + "external API, download data it processes), ask with a QUESTION line and "
        + `OPTIONS that include exactly "${NETWORK_CHOICE}", then \`STATUS: NEEDS_INPUT\`; choosing it `
        + "allows the internet for this task's commands from the next attempt on.",
    ]),
    `Make repairs visible to every step through the shared tools folder ${tools}:`,
    `- executables, or symlinks to them, go in ${tools}/bin, which is first on PATH;`,
    `- Python packages: \`pip install --target ${tools}/python ...\` (${tools}/python is on PYTHONPATH);`,
    `- npm packages: \`npm install --prefix ${tools}/node ...\`, then symlink their binaries into ${tools}/bin;`,
    `- environment variables, and local TCP ports (such as a license server) that sandboxed `
      + `commands must reach, go in ${tools}/sandbox.json: `
      + '`{"env": {"NAME": "value"}, "host_ports": [26585]}`; keep what is already there. '
      + "Only the ports listed are reachable: a service that picks new ports at each start must "
      + "have them fixed in its own configuration first (the skills below say how for the tools "
      + "they cover), or ask the user to.",
    "The folder is mounted read-only into the sandbox at the same path, so symlinks to elsewhere "
      + "under the home folder do not work there; copy or install into the folder instead.",
    "Then check the repair the way the step will use it, e.g. run the tool by its name with PATH "
      + `set to ${tools}/bin:/usr/bin:/bin.`,
    "Fix common environment causes in this shared folder, preserving existing configuration, "
      + "so all projects benefit. Verify from the failing step's sandbox as well as the host. "
      + "Include the changed shared paths, check commands and actual results in the report. "
      + "Project-specific changes must not become global settings. Recent shared repair "
      + "records follow; only fixed/activated records succeeded. Verify applicability before reuse:",
    ...sharedRepairs.map((item) => `- ${item.id} scope=${item.scope ?? "environment"} status=${item.status ?? "fixed"}: `
      + `files=${pyStr(item.files ?? [])}\n${head(item.report ?? "", 2000)}\n${item.error || ""}`),
    // How the tools the failure is about work on any machine (a license server's ports, say).
    skills.section(skills.forStep([node.title, node.instructions, last?.reason ?? "", ...events].join("\n"))),
    ...(earlier.length ? ["", "# The same kind of problem in earlier tasks",
      "It has happened before. Find the cause that keeps bringing it back, not only this "
        + "occurrence; if an earlier repair did not hold, say why and repair it for good:",
      ...earlier] : []),
    "",
    ...history(run, events),
    platformInstructions(platform),
    "\n# How to answer\n"
      + "Answer in Chinese Markdown and end with exactly one status line:\n"
      + "- `STATUS: FIXED` if you repaired the environment so the step can now succeed: describe "
      + "under `## 修复内容` what was wrong and exactly what you changed and checked.\n"
      + "- `STATUS: RETRY` if nothing outside the task blocks it (the model made a mistake, ran out "
      + "of turns, or misread the instructions) and another attempt can succeed: say briefly why it "
      + "failed, then a `NEXT_STEP:` line telling the next attempt precisely what to do differently.\n"
      + "- `STATUS: QUOTA_EXHAUSTED` if the failed step's execution model has exhausted its "
      + "subscription/session/weekly usage or API credits, or is rate-limited. Quote its exact "
      + "error and reset time (including timezone) in the report. The scheduler will mark that "
      + "execution model unavailable and hand the original step to another eligible model, "
      + "preserving completed work and feedback. This status concerns the step's latest failure, "
      + "not an older failure or a diagnostic model. Do not return BLOCKED or merely recommend "
      + "waiting, buying credits, or manually changing models for this case. Do not change account "
      + "settings or change scheduler code merely to bypass the upstream limit. A separate, "
      + "evidenced scheduler defect uses STATUS: PLATFORM_REPAIR instead.\n"
      + "- `STATUS: MODEL_UNAVAILABLE` if the failed step's model service is unavailable "
      + "(HTTP 5xx, overload, timeout, or a broken provider connection). Quote the exact error. "
      + "The scheduler will temporarily exclude it for all projects and switch to a backup; "
      + "do not tell the user to wait or select another already configured model manually.\n"
      + "- `STATUS: UNABLE` if the step's goal cannot be reached in this environment and you cannot "
      + "change that (software that cannot be installed without root, hardware, a licence, an account "
      + "or credentials the task does not have): say what is missing and what would make it possible, "
      + "with a `USER_ACTION:` line as for BLOCKED. The step is reported as not doable here and the "
      + "rest of the task goes on, instead of retrying it.\n"
      + "- `STATUS: BLOCKED` if the user must act first (it needs root, a license or account, a "
      + "decision only the user can make, or the plan or acceptance criteria are impossible): write "
      + `a report in ${REPORT_FORMAT} Then include a \`USER_ACTION: <ROOT|CREDENTIALS|BUDGET|DECISION>: `
      + "<exact missing permission, credential, budget increase, or decision>` line before STATUS. "
      + "State the evidence and which authorized alternatives you tried. Root is only a blocker "
      + "when a user-local shared installation or configuration cannot solve it. Without a "
      + "specific required user action, the scheduler treats BLOCKED as a retry.",
  ].join("\n");
}

/** A warning when the step keeps failing, so that a diagnosis does not answer RETRY again for a
 *  limit that another attempt will meet as well. */
function repeated(node: TaskNode): string[] {
  const failures = recentFailures(node);
  if (failures.length < SWITCH_AFTER) return [];
  const reasons = failures.slice(-4).map((item) => `- ${item.model_id ?? "None"}: ${head(item.reason || "", 200)}`).join("\n");
  return [`This step has now failed ${failures.length} times in a row:\n${reasons}\n`
    + "If the same cause keeps coming back, another RETRY with advice will not help. Find what "
    + "keeps failing. If it is outside the task (a missing tool, simulator, licence, network, "
    + "credentials), fix it (FIXED), ask the user (NEEDS_INPUT), or answer UNABLE. Answer RETRY "
    + "only if the next attempt will do something materially different, and say what."];
}
