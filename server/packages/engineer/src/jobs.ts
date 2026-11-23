// How the platform engineer plans and makes a change to FluidForm. Jobs, their budget, and approving,
// applying and committing are FluidForm's (server/src/engineer.ts).
import { rmSync } from "node:fs";
import { join } from "node:path";
import { settings } from "../../../src/config.js";
import { EngineerMessageSchema, type EngineerJob } from "../../../src/models.js";
import { COMPONENT_GUIDES, failureOutput, RepairError, REPAIR_GUIDES, repairGuide } from "../../../src/platform-repair.js";
import { head } from "../../../src/py.js";
import { sleep } from "../../../src/tasks.js";
import { plainLines, readReply, type Engineering } from "../../../src/engineer.js";

type Json = Record<string, any>;
const message = (fields: Json) => EngineerMessageSchema.parse(fields);

export const ROLE = "You are FluidForm's platform engineer: you change FluidForm itself (its backend, web "
  + "UI, tools, skills and model channels), never the user's projects. ";

// A short name and a line or two for the user, before the engineer's own report.
export const plainRule = (what: string) => "Begin your reply with two lines for the user, in plain Chinese, without code, file names, line "
  + "numbers or test counts:\nHEADLINE: <what this is, at most 12 characters, such as 步骤结果误判 or 飞书发消息>\n"
  + `PLAIN: <${what}>\nThen write the rest as asked.\n`;


export function planPrompt(job: EngineerJob, guide: string): string {
  const asker = job.origin === "lead" ? "The lead of a running task asks for it" : "The user asks for it";
  return "[[fluidform:platform-engineer:plan]]\n" + ROLE
    + "The working directory is an isolated copy of FluidForm's source. Read it to plan the "
    + "change below; do not edit anything yet. Read docs/ARCHITECTURE.md first, then only the code "
    + `you need.\n${asker}:\n${job.request}\n\nConversation so far:\n${conversation(job)}\n`
    + (job.context ? `\nEarlier in this conversation, before this request:\n${job.context}\n` : "")
    + (job.plan ? `\nYour previous plan, which the user wants changed:\n${job.plan}\n` : "")
    + "\n" + plainRule("in two or three short sentences: what you will make or fix, how it will be used, roughly how big the change is")
    + "Write the plan in Chinese, short, for the user to approve:\n"
    + "- 目标: what will work afterwards.\n"
    + "- 现成方案: the official or mature open-source solution it uses (an SDK, a library, an integration), "
    + "or what you looked at and why none fits; build it yourself only then. A new dependency is named with its source and licence.\n"
    + "- 改动: each file and what changes in it.\n"
    + "- 测试: the tests you will add and what they prove.\n"
    + "- 风险: what could break, and what is left out.\n"
    + "End with `STATUS: PLAN`. If a choice belongs to the user before you can plan, ask instead:\n"
    + 'QUESTION: <one question>\nOPTIONS: ["<option 1>", "<option 2>"]\nSTATUS: NEEDS_INPUT\n\n'
    + guide;
}

export function editPrompt(job: EngineerJob, guide: string, feedback = ""): string {
  const what = job.kind === "component" ? `Add this component as the approved plan says.\nRequest:\n${job.request}\n\nApproved plan:\n${job.plan}\n`
    : `Repair this defect in FluidForm:\n${job.request}\n`;
  const after = job.kind === "component" ? ", shows the user the change, and applies it once they approve" : ", and applies a passing change";
  return "[[fluidform:platform-engineer:edit]]\n" + ROLE
    + "The working directory is an isolated copy of FluidForm's source; make the change there "
    + "with your file tools. Preserve unrelated existing changes. Add tests that prove the change (for "
    + "a repair, a regression test that fails without it); never weaken or delete existing tests. Do "
    + "not touch task data, credentials, Git history, the live source, or running services. The "
    + `controller then runs the backend tests, frontend tests and build independently${after}.\n\n`
    + what + `\nConversation so far:\n${conversation(job)}\n`
    + (job.context ? `\nEarlier in this conversation, before this request:\n${job.context}\n` : "") + feedback
    + "\n" + plainRule("one or two sentences: what was wrong or wanted, and what works now")
    + "When done, report in Chinese (改了什么, 测试, 验证) and end with `STATUS: FIXED`. If a real "
    + "choice belongs to the user, ask with QUESTION, OPTIONS (a JSON array) and `STATUS: NEEDS_INPUT`.\n\n"
    + guide;
}


const conversation = (job: EngineerJob) => job.messages.slice(-20).map((item) => `${item.role}: ${head(item.text, 2000)}`).join("\n") || "(none)";

export async function engineerPlan(this: Engineering, job: EngineerJob): Promise<void> {
  job.status = "planning";
  this.engineerSave(job);
  const copy = await this.platform.prepare(job.run_id, null);
  let text: string;
  try {
    const source = join(copy.folder, "source");
    text = await this.engineerCall(job, planPrompt(job, repairGuide(source, COMPONENT_GUIDES)), source);
  } finally {
    rmSync(copy.folder, { recursive: true, force: true });
  }
  let [report, status, question, choices] = readReply(text);
  if (status === "needs_input" && question) {
    this.engineerAsk(job, report, question, choices);
    return;
  }
  // Every component change, a retrospective's too, waits for the user's approval of its plan and
  // again before it is applied.
  let headline: string;
  let plain: string;
  [headline, plain, report] = plainLines(report);
  job.headline = headline || job.headline;
  job.plan_plain = plain;
  job.plan = report;
  job.status = "plan_ready";
  job.messages.push(message({ role: "engineer", text: "方案写好了，请看过后批准，或回复要改的地方。" }));
  this.engineerSave(job);
}

export async function engineerEdit(this: Engineering, job: EngineerJob): Promise<void> {
  job.status = "editing";
  this.engineerSave(job);
  let copy = this.platform.load(job.repair_id);
  const fresh = !copy || !["editing", "validating", "validated"].includes(copy.status) || this.platform.stale(copy);
  if (fresh) {
    // A first edit, or the live source has changed since: a fresh copy, so applying it cannot
    // overwrite what changed.
    copy = await this.platform.prepare(job.run_id, null);
    copy.engineer_job_id = job.id;
    this.platform.save(copy);
    job.repair_id = copy.id;
    this.engineerSave(job);
  }
  const source = join(copy!.folder, "source");
  const guide = repairGuide(source, job.kind === "component" ? COMPONENT_GUIDES : REPAIR_GUIDES);
  const done = fresh ? [] : this.platform.edited(copy!);
  // The same copy as before (a restart cut the work off, or the user asked for changes to it): it goes
  // on from what is there instead of starting over.
  let feedback = done.length ? `\nThe copy already has your earlier changes to: ${done.slice(0, 40).join(", ")}. Build on them: `
    + "check what is done and finish what the conversation asks for now; do not start over.\n" : "";
  let report = "";
  let checks: { name: string }[] = [];
  for (let attempt = 0; attempt < settings.platform_repair_attempts; attempt += 1) {
    const text = await this.engineerCall(job, editPrompt(job, guide, feedback), source);
    let status: string | null;
    let question: string | null;
    let choices: string[];
    [report, status, question, choices] = readReply(text);
    if (status === "needs_input" && question) {
      this.engineerAsk(job, report, question, choices);
      return;
    }
    job.status = "validating";
    this.engineerSave(job);
    try {
      checks = await this.platform.check(copy!, (title, ok) => this.engineerCheckSeen(job, title, ok));
      break;
    } catch (error) {
      if (!(error instanceof RepairError) || attempt + 1 === settings.platform_repair_attempts) throw error;
      feedback = `\nThe independent check failed. Fix it and recheck:\n${failureOutput(error.message, 6000)}\n`;
      job.status = "editing";
      this.engineerSave(job);
    }
  }
  job.files = copy!.files;
  job.checks = checks.map((item) => item.name);
  let headline: string;
  let plain: string;
  [headline, plain, report] = plainLines(report);
  job.headline = headline || job.headline;
  job.plain = plain;
  job.diff = this.platform.diff(copy!);
  job.report = report;
  job.error = null;
  job.messages.push(message({ role: "engineer", text: plain || report || "改好了，检查全部通过。" }));
  if (job.kind === "component") {
    job.status = "ready";
    this.engineerSave(job);
    return;
  }
  // A repair applies on its own once checked, after any change already waiting to apply.
  while (this.platformPending) await sleep(1);
  this.engineerApply(job);
}
