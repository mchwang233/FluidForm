// Diagnosing a stuck task: what went wrong, why, and what the next attempt should change
//.
//
// An automatic diagnosis goes further: after every failed attempt of a step, the strong model
// looks for what blocks it outside the task itself (missing software, sandbox or machine limits,
// configuration, licenses) and repairs that. Its verdict decides what happens next: FIXED (run the
// step again), RETRY (retry with its advice), QUOTA_EXHAUSTED (switch the execution model) or
// BLOCKED (the user must act; the task pauses with the report).
import { type NodeAttempt } from "./models.js";
import { head, pyRegex } from "./py.js";

export const MAX_RESULT_CHARS = 2_000;
// Tool calls of a node's latest attempt shown to a diagnosis.
export const MAX_LISTED_CALLS = 80;
const ADVICE = pyRegex(String.raw`^\s*NEXT_STEP:\s*(.+?)\s*(?=^\s*STATUS:|\Z)`, "ims");
// The option a diagnosis offers to let the task use the internet; choosing it turns that on.
export const NETWORK_CHOICE = "允许本任务联网";
export const STATUS = pyRegex(String.raw`^\s*STATUS:\s*(PLATFORM_REPAIR|PLATFORM_PENDING|NEEDS_INPUT|FIXED|RETRY|QUOTA_EXHAUSTED|MODEL_UNAVAILABLE|BLOCKED|UNABLE)\b`, "im");
const QUESTION_SOURCE = String.raw`^[ \t]*QUESTION:[ \t]*(\S[^\n]*)$`;
const OPTIONS_SOURCE = String.raw`^[ \t]*OPTIONS:[ \t]*(\[[^\n]*\])[ \t]*$`;
const QUESTION = pyRegex(QUESTION_SOURCE, "im");
export const OPTIONS = pyRegex(OPTIONS_SOURCE, "im");
// Every QUESTION and OPTIONS line, for taking them out of a report (Python's QUESTION.sub).
export const QUESTION_LINES = pyRegex(QUESTION_SOURCE, "img");
export const OPTIONS_LINES = pyRegex(OPTIONS_SOURCE, "img");
export const INTERACTION_INSTRUCTIONS =
  "\n# Talk with the user\n"
  + "Consider the user's diagnosis replies below as their preferences and corrections. "
  + "When a real choice, missing requirement, or preference prevents the next repair, ask one "
  + "specific question in Chinese with `QUESTION: <question>` and optionally "
  + '`OPTIONS: ["first concrete option", "second concrete option"]`, then end with '
  + "`STATUS: NEEDS_INPUT`. The UI supports both a choice and a free-text answer, and the "
  + "answer will automatically continue diagnosis. Do not infer a choice before the user "
  + "answers. Do not ask permission for routine repairs already authorized by the task. "
  + "For completed diagnoses you may also include a follow-up QUESTION and OPTIONS without "
  + "blocking execution. Use at most 5 mutually distinct options; do not add an Other option.";
export const USER_ACTION = String.raw`^[ \t]*USER_ACTION:[ \t]*(ROOT|CREDENTIALS|BUDGET|DECISION)[ \t]*:[ \t]*(\S[^\n]*)$`;
export const REPORT_FORMAT =
  "Chinese Markdown with these sections: ## 问题定位 (which step fails and how), ## 根本原因 "
  + "(the real cause, e.g. impossible acceptance criteria, missing tools or permissions, a wrong "
  + "plan, a weak model, unclear instructions, environment limits), ## 处理结果与下一步 (what "
  + "was checked, what was actually fixed, and what the system will do next; ask the user only "
  + "for genuinely missing requirements, preferences, credentials, permissions or budget). Then one "
  + "line starting with `NEXT_STEP:` followed by precise instructions, in Chinese, for the next "
  + "attempt of the failing step, so that it succeeds.";

/** How an API model spent its turns: calls per tool, and for the latest attempt the calls
 *  themselves, so a diagnosis can see where the turns went. */
export function toolSummary(attempt: NodeAttempt, last: boolean): string {
  const counts = new Map<string, [number, number, number]>();
  for (const call of attempt.tool_calls) {
    if (!counts.has(call.tool)) counts.set(call.tool, [0, 0, 0]);
    const tally = counts.get(call.tool)!;
    tally[0] += 1;
    tally[1] += call.ok === false ? 1 : 0;
    tally[2] += call.ok === null ? 1 : 0;
  }
  const spread = [...counts].map(([tool, [count, bad, unknown]]) => `${tool}×${count}` + (bad ? ` (${bad} failed)` : "")
    + (unknown ? ` (${unknown} unknown/incomplete)` : "")).join(", ");
  const first = `  tool calls: ${attempt.turns} turns${attempt.turn_limit ? " (ran out of turns)" : ""}: ${spread}`;
  if (!last) return first;
  const calls = attempt.tool_calls.slice(-MAX_LISTED_CALLS).map((call) => `    t${call.turn} ${call.tool} ${call.detail}  [${call.status}]`);
  const trace = attempt.trace ? [`    every call with its whole output, one JSON line each: ${attempt.trace}`] : [];
  return [first, ...calls, ...trace].join("\n");
}

// What the lead's call_engineer asks of the repair session (settings.engineer_repairs).
export const ENGINEER_CALLED =
  "find whether this machine or FluidForm itself is at fault, and repair it: this machine's "
  + "environment here, with the tools below; FluidForm's own code (its scheduler, tools or sandbox "
  + "behaving wrongly on any machine, not only here) by ending with STATUS: PLATFORM_REPAIR at once, "
  + "without working around it here. The lead's evidence";
// Who does the looking and repairing, to the user and to the model (docs/design/one-engineer.md).
export const ENGINEER = "You are FluidForm's platform engineer (平台工程师).";

/** The report, NEXT_STEP advice, and scheduler status if given. */
export function parse(given: string | null | undefined): [string, string | null, string | null] {
  const text = given || "";
  const verdict = STATUS.exec(text);
  const status = verdict ? verdict[1].toLowerCase() : null;
  let body = verdict ? text.slice(0, verdict.index) : text;
  body = body.replace(pyRegex(USER_ACTION, "img"), "");
  body = body.replace(pyRegex(OPTIONS_SOURCE, "img"), "");
  body = body.replace(pyRegex(QUESTION_SOURCE, "img"), "");
  const match = ADVICE.exec(body);
  if (!match) return [body.trim(), null, status];
  return [body.slice(0, match.index).trim(), match[1].trim(), status];
}

export function userAction(text: string | null | undefined): string | null {
  const match = pyRegex(USER_ACTION, "im").exec(text || "");
  return match ? `${match[1].toUpperCase()}: ${match[2].trim()}` : null;
}

export function interaction(text: string | null | undefined): [string | null, string[]] {
  const question = QUESTION.exec(text || "");
  const options = OPTIONS.exec(text || "");
  let choices: string[] = [];
  if (question && options) {
    try {
      const raw = JSON.parse(options[1]);
      if (Array.isArray(raw)) {
        choices = [...new Set(raw.filter((item) => typeof item === "string" && item.trim()).map((item: string) => head(item.trim(), 300)))].slice(0, 5);
      }
    } catch {
      // not a JSON list: no choices
    }
  }
  return [question ? head(question[1].trim(), 1000) : null, choices];
}
