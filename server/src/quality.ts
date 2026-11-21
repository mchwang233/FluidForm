// Checking node results and handing them on: acceptance review, verification
// verdicts, upstream handoff, and the files each CLI node changed.
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import * as capabilities from "./capabilities.js";
import { prompt as contractPrompt } from "./contracts.js";
import { timeKey } from "./lax.js";
import {
  type ArtifactEvidence, type ExecutionRun, type NodeInput, NodeInputSchema, partPath, type TaskNode,
} from "./models.js";
import { head, isObject, pyRegex, pyStr, sortedBy, stem, suffix, tail } from "./py.js";
import * as skills from "./skills.js";
import { context as employeeContext } from "./team.js";

// Marks a review request so the offline demo model can answer it with a verdict.
export const REVIEW_MARKER = "[[super-partner:review]]";
export const MAX_LISTED_FILES = 50;
export const MAX_DIFF_CHARS = 12_000;
export const MAX_SCANNED_FILES = 20_000;
export const MAX_INVENTORY_FILES = 200;
// Relative or absolute paths, or bare file names with an extension, mentioned in a result.
const PATH_MENTION = String.raw`/?[\w.-]+(?:/[\w.-]+)+|[\w-]+\.[A-Za-z0-9]{1,8}\b`;
export const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".super-partner"]);
// Explicitly cited verification logs may live in build or hidden scratch folders. This exception
// never grants access to credentials, agent state or repository metadata.
export const PRIVATE_DIRS = new Set([".ssh", ".aws", ".azure", ".config", ".kube", ".docker", ".gnupg",
  ".codex", ".claude", ".agents", ".review", "credentials", "secrets"]);
export const PRIVATE_NAMES = new Set(["credentials", "secrets", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]);
export const PRIVATE_SUFFIXES = new Set([".key", ".pem", ".p12", ".pfx", ".keystore", ".db", ".sqlite", ".sqlite3"]);
export const LOG_SUFFIXES = new Set([".log", ".txt", ".out"]);
// A worker's own statement that part of its task cannot be done in this environment.
const UNABLE = pyRegex(String.raw`^\s*UNABLE:\s*(.+)$`, "img");
const BLOCKED = pyRegex(String.raw`^\s*(?:STATUS:\s*)?BLOCKED\s*(?::\s*(.*))?$`, "img");
export const UNABLE_RULE =
  "Be honest about what actually happened. If something this step's own task requires cannot "
  + "really be done here (no network access, missing credentials, accounts, permissions, hardware or services), "
  + "do not simulate it, fake its output, or describe it as done: do every part you can, say what "
  + "is ready, and end your answer with one final line `UNABLE: <what could not be done, why, and "
  + "what would make it possible>`. Judge only this step: work that belongs to other steps or to "
  + "the overall goal (such as deploying, when this step only builds) is not yours to do or report. "
  + "Running out of turns or time is not a limit of the environment: report your progress instead.";
const VERDICT = pyRegex(String.raw`^\s*VERDICT:\s*(PASS|FAIL)\b:?\s*(.*)$`, "img");
// Feedback a failed verification sends back, and what later retries append to it.
export const REWORK_PREFIX = "验证（";
export const RETRY_NOTE = "\n本次验收意见：";
export const ADVICE_NOTE = "\n诊断建议：";

export type Verdict = {
  passed: boolean;
  reason: string;
  fix: string;
  summary: string | null;
  // Set when the task's goal cannot be reached in this environment, with why.
  unable: string | null;
  reviewer_model_id: string | null;
  cost_usd: number;
  accounted_cost_usd: number;
  verified: boolean;
  blocked: string | null;
  artifact_evidence: ArtifactEvidence | null;
};

export function verdict(fields: Pick<Verdict, "passed" | "reason"> & Partial<Verdict>): Verdict {
  return { fix: "", summary: null, unable: null, reviewer_model_id: null, cost_usd: 0, accounted_cost_usd: 0, verified: true,
    blocked: null, artifact_evidence: null, ...fields };
}

// --- what a node is told -------------------------------------------------------------------

function handoff(item: TaskNode, limit: number): [string, "full" | "summary" | "truncated"] {
  const result = item.result || "";
  if (result.length <= limit) return [result, "full"];
  if (item.summary) return [item.summary, "summary"];
  return [head(result, limit) + `\n[... ${result.length - limit} more characters omitted]`, "truncated"];
}

// Titles of the task's other steps a node is shown.
export const MAX_OTHER_STEPS = 30;
// Background on the earlier task that each step of a requirement change gets.
export const BACKGROUND_CHARS = 2500;
// What a scoped work package gets of each step before it: what that step provides, and this much
// of its result. The files themselves are attached (briefing.attached_files).
export const SCOPED_HANDOFF_CHARS = 1500;
// The answer is what the user reads as the step's result: it is written in the task's language,
// its three parts headed in that language too.
export const SCOPED_ANSWER =
  "Answer briefly, in at most 15 lines, in the language the task was asked in, in three parts each "
  + "headed in that language (for a task asked in Chinese: 改动 / 提供 / 检查): the files and what changed "
  + "in them; what later steps can rely on (names, signatures, endpoints, fields, classes); the command "
  + "you ran to check it and its result.";

/** What a work package may touch, for a step the planner scoped (planner.package). */
export function scopeSection(node: TaskNode): string {
  const lines: string[] = [];
  if (node.files.length) {
    lines.push("Change only these files (create them if they do not exist): " + node.files.join(", "));
    lines.push("Write them first, then check them; do not spend your calls on work other steps own.");
  }
  if (node.reads.length) lines.push("For reference: " + node.reads.join(", "));
  lines.push("This is a small work package: those of the files above that exist are attached in full below, as "
    + "they are now, with what earlier steps delivered. That is what you need, so do not explore the "
    + "rest; read another file only if something you must use is missing there, and say which in "
    + "your answer.");
  if (node.provides) lines.push(`Later steps rely on you providing: ${node.provides}`);
  if (node.check) lines.push(`Before you finish, run: ${node.check}`);
  return "Your work package.\n" + lines.join("\n");
}

/** Where a step that owns folders may write: other steps work in other folders at the same time. */
export function foldersSection(node: TaskNode): string {
  return "Your folders: " + node.folders.join(", ") + "\nOther steps work in other folders at the same time. "
    + "Create and change files only inside yours, including your tests, logs and build output; read "
    + "anything else you need, but do not change it.";
}

// The request and the lead's criteria are the bar; a step does not raise it for the steps after it.
export const OWN_BAR = "These criteria and the request are the bar. Do not write stricter requirements of your own into the "
  + "work for later steps to meet; if you think the task needs more, say so in your result. A "
  + "requirement an earlier step wrote down that goes beyond them is not a reason to stop: do what "
  + "they ask and list the rest as open points for the lead.";

/** The node's prompt and a record of what it received from each upstream node. */
export function nodePrompt(node: TaskNode, run: ExecutionRun, limit: number): [string, NodeInput[]] {
  const byId = new Map(run.plan.nodes.map((item) => [item.id, item]));
  const sections = [`Task: ${node.instructions}`];
  const inputs: NodeInput[] = [];
  const shared = employeeContext(node, run);
  if (shared) sections.push(shared);
  const path = partPath(run.plan, node.part_id);
  if (path.length) {
    // Only where the task sits; its instructions are complete on their own.
    const last = path[path.length - 1];
    sections.push("Part of: " + path.map((part) => part.title).join(" › ") + (last.goal ? ` (goal: ${last.goal})` : ""));
  }
  if (run.background) {
    // A requirement change: the working directory already holds the earlier task's results.
    sections.push("Context: this task changes an earlier task. Its results are already in the working "
      + "directory; build on them and keep what the change does not touch.\n" + head(run.background, BACKGROUND_CHARS));
  }
  if (node.acceptance_criteria) {
    sections.push(`Acceptance criteria (your result will be checked against these):\n${node.acceptance_criteria}\n` + OWN_BAR);
  }
  const contract = contractPrompt(node);
  if (contract) sections.push(contract);
  const scoped = Boolean(node.files.length || node.reads.length);
  if (scoped) sections.push(scopeSection(node));
  else if (node.folders.length) sections.push(foldersSection(node));
  if (node.feedback) {
    const previous = node.result ? `\n\nYour previous result:\n${head(node.result, limit)}` : "";
    sections.push(`A previous attempt was not accepted. Fix these problems:\n${node.feedback}${previous}`);
  }
  const notes = attemptNotes(node);
  if (notes) sections.push(notes);
  if (node.head_start && node.head_start_generation === node.generation && !node.attempts.length) {
    sections.push(HEAD_START_DONE + head(node.head_start, HEAD_START_CHARS));
  }
  const clarified = clarifications(run);
  if (clarified) sections.push(clarified);
  const upstream: string[] = [];
  for (const dependency of node.dependencies) {
    const item = byId.get(dependency);
    if (!item || !item.result) continue;
    let [text, form] = handoff(item, scoped ? SCOPED_HANDOFF_CHARS : limit);
    if (scoped) {
      text = head(text, SCOPED_HANDOFF_CHARS);
      if (item.provides) text = `It provides: ${item.provides}\n${text}`;
    }
    const files = item.changed_files.slice(0, MAX_LISTED_FILES);
    let listed = files.length ? `\nFiles it changed: ${files.join(", ")}` : "";
    if (item.changed_files.length > files.length) listed += ` (and ${item.changed_files.length - files.length} more)`;
    const label = { full: "result", summary: "summary of its result", truncated: "start of its result" }[form];
    upstream.push(`### ${item.title} (${label})\n${text}${listed}`);
    inputs.push(NodeInputSchema.parse({ node_id: item.id, form, changed_files: item.changed_files.length }));
  }
  sections.push("Results from earlier tasks:\n" + (upstream.length ? upstream.join("\n\n") : "(none)"));
  const others = run.plan.nodes.filter((item) => item.id !== node.id).map((item) => item.title);
  // So a step knows what is someone else's job, and neither does it nor reports it undone.
  if (others.length) sections.push("Other steps of this task, not yours: " + others.slice(0, MAX_OTHER_STEPS).join("; "));
  // API models are told this in their tools' instructions (agent.AGENT_INSTRUCTIONS).
  const note = cliEnvironment(node.model_id, run.allow_network);
  if (note) sections.push(note);
  // How to use the tools it names, as this machine's skills and the general ones say.
  const known = skills.section(skills.forStep([node.title, node.instructions, node.check || "", node.acceptance_criteria || ""].join("\n")));
  if (known) sections.push(known);
  // Tools earlier tasks built and the user solidified.
  const built = capabilities.section();
  if (built) sections.push(built);
  sections.push(UNABLE_RULE);
  if (node.verifies.length) sections.push(verdictRule(node, byId));
  else if (scoped) sections.push(SCOPED_ANSWER);
  return [sections.join("\n\n"), inputs];
}

export const HEAD_START_CHARS = 4000;
export const HEAD_START_DONE =
  "Before the steps you depend on finished, you already started this task (its files are in the working "
  + "directory). Check that work against their actual results below, fix what does not match, and do not "
  + "redo what is finished. What you reported then:\n";

/** The prompt for starting a step early, while steps it depends on are still at work: only what
 *  does not need their results, and no verdict yet. */
export function headStartPrompt(node: TaskNode, run: ExecutionRun, limit: number): string {
  const [prompt] = nodePrompt(node, run, limit);
  const waiting = run.plan.nodes.filter((item) => node.dependencies.includes(item.id) && item.status !== "succeeded");
  const listed = waiting.map((item) => `- ${item.title}` + (item.provides ? `: it will provide ${item.provides}` : "")).join("\n");
  return prompt + "\n\n" + "HEAD START. Steps your task depends on are not finished yet:\n" + listed + "\n"
    + "Do now only the part of your task that does not need their results: read what you need, set up your "
    + "own files, and build what the agreed interface and the descriptions above allow (for example a "
    + "testbench, its checkers and test cases from the interface contract). Do not guess their results, do "
    + "not create or change their files, and do not run anything that needs their output. Give no verdict "
    + "now. Stop when the rest needs their results, then answer without calling a tool: what you did, the "
    + "files you made, and what is left for when they finish. If nothing can be done before then, say so "
    + "and stop at once.";
}

/** Where a membership CLI does a step, as it runs there, so it does not take itself for being on
 *  an open machine. Empty for other models; the same for every CLI. */
export function cliEnvironment(modelId: string | null, network: boolean): string {
  if (!modelId || !modelId.startsWith("cli:")) return "";
  return [
    "Where you are: FluidForm runs you in your own sandbox. You can write only the working "
      + "directory and $TMPDIR (put temporary files there: the shared /tmp may be unavailable); the rest of "
      + "the system is read-only, and your home folder, other tasks' folders and FluidForm's own data "
      + "may not be readable at all: do not look for files there. You are an ordinary user, not root: sudo, "
      + "system packages and system files are out of reach. The tools installed on this machine for every "
      + "step are on PATH.",
    network ? "This task allows the internet: commands may download packages (into the working directory) and "
      + "call external services." : "Commands have no network access.",
    // The same for every CLI: a step can be handed from one to another with its prompt.
    "Deleting files in the working directory is allowed: name them (rm -f a.o b.o, rm -rf build) "
      + "or use find (find . -name '*.o' -delete). Codex refuses rm with wildcards or $(...) as "
      + "dangerous. If your tool still refuses a command, do not retry it the same way: do without it "
      + "if you can, and say so in your answer.",
    "When something the task needs is missing or blocked here, do not work around it with "
      + "stand-ins or fake results: say exactly what is missing.",
  ].join("\n");
}

function verdictRule(node: TaskNode, byId: Map<string, TaskNode>): string {
  const checked = node.verifies.filter((id) => byId.has(id)).map((id) => byId.get(id)!.title).join(", ");
  return `You are verifying: ${checked}. Check the work against its requirements. End your answer `
    + "with one final line, exactly `VERDICT: PASS` if it is acceptable, or "
    + "`VERDICT: FAIL: <the specific problems to fix>`.";
}

function clarifications(run: ExecutionRun): string {
  const replied = sortedBy(run.diagnoses.filter((diagnosis) => diagnosis.messages.length),
    (diagnosis) => timeKey(diagnosis.messages[diagnosis.messages.length - 1].created_at));
  const found = replied.slice(-5).flatMap((diagnosis) => diagnosis.messages.slice(-3).map((message) =>
    `Question: ${diagnosis.question || "Additional instructions"}\n`
    + `User's choice: ${message.choice || "(free text)"}\nUser's reply: ${message.text}`));
  return found.length ? "User clarifications during diagnosis; preserve these when continuing the original task:\n" + found.join("\n\n") : "";
}

export const MAX_NOTED_FILES = 40;
export const MAX_NOTED_COMMANDS = 12;

/** What the step's last attempt did, from its tool calls, so a new attempt that cannot continue
 *  its conversation (another model, say) starts from there instead of from nothing. */
export function attemptNotes(node: TaskNode): string {
  if (!node.attempts.length || !node.attempts[node.attempts.length - 1].tool_calls.length) return "";
  const attempt = node.attempts[node.attempts.length - 1];
  const files = (...tools: string[]) => [...new Set(attempt.tool_calls.filter((call) => tools.includes(call.tool) && call.ok)
    .map((call) => call.detail.split(" (")[0]))];
  // Attempts recorded before the tools followed Claude Code's used the older names.
  const changed = files("Write", "Edit", "MultiEdit", "write_file", "edit_file");
  const read = files("Read", "read_file").filter((path) => !changed.includes(path));
  const commands = attempt.tool_calls.filter((call) => ["Bash", "run_command", "command"].includes(call.tool))
    .map((call) => `${call.ok === true ? "ok" : call.status}: ${call.detail}`).slice(-MAX_NOTED_COMMANDS);
  const lines = [`What the previous attempt did (${attempt.model_id ?? "None"}, ${attempt.turns} turns), which ended: `
    + head(attempt.reason || attempt.outcome, 300)];
  if (changed.length) lines.push("Files it wrote or edited (still in the working directory): " + changed.slice(0, MAX_NOTED_FILES).join(", "));
  if (read.length) lines.push("Files it read: " + read.slice(0, MAX_NOTED_FILES).join(", "));
  if (commands.length) lines.push("Its last commands:\n" + commands.join("\n"));
  lines.push("Continue from its changes rather than starting over, and read only what you need.");
  return lines.join("\n");
}

/** The message that continues a step's conversation with its model in a new attempt. */
export function continuePrompt(node: TaskNode, run: ExecutionRun): string {
  const attempt = node.attempts[node.attempts.length - 1];
  if (run.plan.employees.length) {
    const [prompt] = nodePrompt(node, run, SCOPED_HANDOFF_CHARS);
    return "Continue your saved work. Read the current deliveries and files below; delegated work is now "
      + "available only when its status is succeeded. Inspect changed files before editing.\n" + prompt;
  }
  const sections = [`This step continues in a new attempt. Your previous attempt ended (${attempt.outcome}): ${head(attempt.reason || "", 500)}`];
  const contract = contractPrompt(node);
  if (contract) sections.push(contract);
  if (node.feedback) sections.push(`Fix these problems:\n${node.feedback}`);
  const clarified = clarifications(run);
  if (clarified) sections.push(clarified);
  sections.push("Everything you changed is still in the working directory. Do not redo finished work, and "
    + "do not read files again that you have already read unless they changed. Finish the step, "
    + "then answer without calling a tool with a summary of what you did and verified.");
  if (node.verifies.length) sections.push(verdictRule(node, new Map(run.plan.nodes.map((item) => [item.id, item]))));
  return sections.join("\n\n");
}

/** The rework a failed verification asked for, without notes later retries appended. */
export function reworkFeedback(feedback: string | null | undefined): string {
  if (!feedback || !feedback.startsWith(REWORK_PREFIX)) return "";
  let text = feedback;
  for (const note of [RETRY_NOTE, ADVICE_NOTE]) text = text.split(note)[0];
  return text.trim();
}

/** Feedback for a retry: a rejection must not erase the rework the attempt was doing, or the next
 *  attempt undoes it and the verification sends it back again. */
export function retryFeedback(previous: string | null | undefined, problem: string): string {
  const rework = reworkFeedback(previous);
  return rework ? `${rework}${RETRY_NOTE}${problem}` : problem;
}

// --- checking a result ---------------------------------------------------------------------

export function reviewPrompt(node: TaskNode, result: string, changed: string[], diff: string, summarize: boolean): string {
  const criteria = node.acceptance_criteria || "The result fully and correctly completes the task.";
  const files = changed.slice(0, MAX_LISTED_FILES).join(", ") || "(none)";
  const summaryRule = summarize ? ' Also include "summary": a self-contained summary of the result (at most 1500 characters) '
    + "that later tasks can rely on instead of the full text, keeping concrete names, numbers and decisions." : "";
  const rework = node.feedback ? "Rework requirements this attempt was given (these supersede conflicting parts of the original "
    + "task; where they conflict, judge by the rework requirements):\n" + `${node.feedback}\n\n` : "";
  return `${REVIEW_MARKER}\nYou are reviewing another model's work. Do not modify any files.\n\n`
    + `Task:\n${node.instructions}\n\nAcceptance criteria:\n${criteria}\n\n${rework}`
    + contractPrompt(node) + "\n"
    + `Result:\n${result}\n\nFiles changed: ${files}\n`
    + (diff ? "\nEvidence from the workspace (diff or contents of the relevant files, then a listing of the "
      + "files that exist). Files this attempt did not change may come from earlier attempts; judge "
      + "them by these contents and the listing, not by the list of changed files. Excerpts may "
      + "be clipped: omitted content is not evidence that an implementation or check is missing. "
      + "When Read is available, inspect the relevant files before deciding; Read with a negative "
      + `offset (such as -50) reads the final verification output of a long log:\n${diff}\n` : "")
    + '\nReply with JSON only: {"passed": true or false, "reason": "one or two sentences", '
    + '"fix": "what to change if not passed, else empty", '
    + '"blocked": "empty, or the missing prerequisite evidence that blocks this step", '
    + '"unable": "empty, or what the task required that did not actually happen because of a limit '
    + 'outside the work, why, and what would make it possible"}.'
    + summaryRule
    + " Pass work that meets the criteria even if it could be polished; fail work that is "
    + "wrong, incomplete, or only claims to have done something."
    + " You run in a restricted sandbox that may have no network and may not even open loopback "
    + "sockets. Checks of yours that fail for that reason (PermissionError, socket or network "
    + "operations not permitted) are a limit of your environment, not a defect of the work: never "
    + "fail the work for them; judge by the code, the output reported in the result, and whatever "
    + "you can run offline."
    + " Judge the outcome this task asks for, not the preparation, and only this task: work it "
    + "does not ask for (deploying, when it only asks to build) neither fails it nor is unable."
    + " If it requires an effect outside "
    + "the files (deploying, publishing, uploading, sending, installing on a server, calling an "
    + "external service) and the result shows it did not actually happen, was simulated, or was "
    + "only prepared (\"scripts are ready\", \"would work with network access\"), the task is not "
    + "done: set passed to false, and when the cause is a limit of the environment (no network, "
    + "missing credentials or permissions) rather than a mistake, describe it in \"unable\".";
}

export function parseReview(text: string): Record<string, any> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (isObject(payload) && payload.status === "blocked") {
    payload = { ...payload, passed: false, blocked: pyStr(payload.reason || "missing prerequisite evidence") };
  }
  if (!isObject(payload) || typeof payload.passed !== "boolean") return null;
  return payload;
}

const NOTHING_BLOCKED = new Set(["none", "no", "null", "false", "n/a", "not applicable", "no blockers", "no blocking issues",
  "无", "没有", "不适用", "无阻塞", "无阻塞项", "没有阻塞", "没有阻塞项"]);

/** The last UNABLE line's reason, unless it explicitly says nothing is blocked. */
export function unableClaim(text: string | null | undefined): string | null {
  const matches = [...(text || "").matchAll(UNABLE)];
  if (!matches.length) return null;
  const claim = matches[matches.length - 1][1].trim();
  // Match the whole declaration, never a prefix: "no credentials" and "none of the required
  // services are reachable" still describe real limits.
  if (NOTHING_BLOCKED.has(claim.toLowerCase().replace(/[.。]+$/, "").trim())) return null;
  return head(claim, 1000);
}

export function blockedClaim(text: string | null | undefined): string | null {
  const matches = [...(text || "").matchAll(BLOCKED)];
  if (matches.length) return head((matches[matches.length - 1][1] ?? "").trim(), 1000) || "步骤报告阻塞；详见本次结果和工具日志。";
  let payload: unknown;
  try {
    payload = JSON.parse(text ?? "");
  } catch {
    return null;
  }
  if (isObject(payload) && pyStr(payload.status ?? "").toLowerCase() === "blocked") return head(pyStr(payload.reason || "步骤报告阻塞。"), 1000);
  return null;
}

/** The last VERDICT line of a verification node, or null when it gave none. */
export function verificationVerdict(text: string | null | undefined): [boolean, string] | null {
  const matches = [...(text || "").matchAll(VERDICT)];
  if (!matches.length) return null;
  const last = matches[matches.length - 1];
  return [last[1].toUpperCase() === "PASS", last[2].trim()];
}

// --- files a CLI node changed --------------------------------------------------------------

/** Modification time (ns) and size of the files under ``root``, skipping build and VCS folders,
 *  as one comparable text each. */
export function fileState(root: string): Map<string, string> {
  const state = new Map<string, string>();
  if (!existsSync(root) || !statSync(root).isDirectory()) return state;
  const walk = (folder: string): boolean => {
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return true;
    }
    const folders: string[] = [];
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) folders.push(path);
        continue;
      }
      try {
        const info = statSync(path, { bigint: true });
        if (info.isDirectory()) continue; // a link to a folder: os.walk lists it with the folders
        state.set(relative(root, path).split(sep).join("/"), `${info.mtimeNs}:${info.size}`);
      } catch {
        continue;
      }
      if (state.size >= MAX_SCANNED_FILES) return false;
    }
    for (const sub of folders) if (!walk(sub)) return false;
    return true;
  };
  walk(root);
  return state;
}

/** How a folder's files are snapshotted; tests replace it. */
export const files = { state: fileState };

export function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path)).sort();
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", ["--literal-pathspecs", "-C", root, ...args], { encoding: "utf8", timeout: 20_000, maxBuffer: 64 * 1024 * 1024 });
  return result.error ? "" : result.stdout ?? "";
}

/** Diff of the changed tracked files, clipped, so a reviewer sees what actually changed. */
export function gitDiff(root: string, files: string[]): string {
  if (!files.length || !existsSync(join(root, ".git"))) return "";
  return excerpt(git(root, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "HEAD", "--",
    ...files.slice(0, MAX_LISTED_FILES)]), MAX_DIFF_CHARS);
}

function tracked(root: string, files: string[]): Set<string> {
  if (!files.length || !existsSync(join(root, ".git"))) return new Set();
  return new Set(git(root, ["ls-files", "-z", "--", ...files]).split("\0").filter(Boolean));
}

/** Whether a file or folder of this name may hold credentials or agent state. */
export function isPrivate(name: string): boolean {
  const lower = name.toLowerCase();
  return PRIVATE_DIRS.has(lower) || PRIVATE_NAMES.has(lower)
    || [".env", "id_rsa.", "id_dsa.", "id_ecdsa.", "id_ed25519."].some((start) => lower.startsWith(start))
    || (["credentials", "secrets", "token", "tokens"].includes(stem(lower))
      && [".json", ".yaml", ".yml", ".toml", ".ini", ".txt", ".log"].includes(suffix(lower)))
    || PRIVATE_SUFFIXES.has(suffix(lower));
}

// Folders a reviewer's commands may not need to look into for private files: too big to walk.
const UNWALKED = new Set(["node_modules", ".venv", "venv", "__pycache__"]);
const isLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/** The private folders and files in ``root`` (isPrivate, and a repository's config, which can
 *  hold tokens), at most ``limit``: what a reviewer's commands must not see. */
export function privatePaths(root: string, limit = 2000): [string[], string[]] {
  const folders: string[] = [];
  const files: string[] = [];
  const walk = (here: string): boolean => {
    let entries;
    try {
      entries = readdirSync(here, { withFileTypes: true });
    } catch {
      return true;
    }
    const dirs = entries.filter((entry) => entry.isDirectory() || (entry.isSymbolicLink() && existsSync(join(here, entry.name))
      && statSync(join(here, entry.name)).isDirectory())).map((entry) => entry.name);
    const names = entries.map((entry) => entry.name).filter((name) => !dirs.includes(name));
    const hidden = dirs.filter(isPrivate);
    // A link cannot be mounted over; what it points to inside the workspace is hidden itself.
    folders.push(...hidden.filter((name) => !isLink(join(here, name))).map((name) => join(here, name)));
    files.push(...names.filter((name) => (isPrivate(name) || (here.split(sep).pop() === ".git" && name === "config"))
      && !isLink(join(here, name))).map((name) => join(here, name)));
    if (folders.length + files.length >= limit) return false;
    // os.walk does not enter links to folders.
    for (const name of dirs) {
      if (!UNWALKED.has(name) && !hidden.includes(name) && !isLink(join(here, name)) && !walk(join(here, name))) return false;
    }
    return true;
  };
  walk(root);
  return [folders, files];
}

/** Path.resolve(): absolute, links followed as far as the path exists. */
function realResolve(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(realResolve(parent), absolute.slice(parent.length + 1));
  }
}

/** One access policy for inline evidence and API review tools, including link targets. Only an
 *  explicitly referenced log may bypass the build/hidden-folder exclusion. Both its written path and
 *  resolved target must be safe and inside the workspace. */
export function reviewPath(root: string, name: string, { allowHiddenLog = false }: { allowHiddenLog?: boolean } = {}): string | null {
  try {
    const base = realResolve(root);
    // base / name as pathlib writes it: "." parts dropped, ".." kept (and refused below), an
    // absolute name taking the place of the base.
    let writtenParts: string[];
    if (name.startsWith("/")) {
      if (!(name + "/").startsWith(base + "/")) return null;
      writtenParts = name.slice(base.length).split("/").filter((part) => part && part !== ".");
    } else {
      writtenParts = name.split("/").filter((part) => part && part !== ".");
    }
    const resolved = realResolve(join(base, ...writtenParts));
    if (resolved !== base && !resolved.startsWith(base + sep)) return null;
    const resolvedParts = resolved === base ? [] : relative(base, resolved).split(sep);
    for (const parts of [writtenParts, resolvedParts]) {
      const whole = parts.join("/");
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        const lower = part.toLowerCase();
        const referencedLog = allowHiddenLog && index < parts.length - 1 && LOG_SUFFIXES.has(suffix(whole).toLowerCase());
        if ((SKIP_DIRS.has(lower) && !(lower === "build" && referencedLog)) || isPrivate(part)) return null;
        if (part.startsWith(".") && !(referencedLog && part !== "." && part !== "..")) return null;
      }
    }
    return resolved;
  } catch {
    return null;
  }
}

/** Keep both ends: verification summaries are usually at the end of a file. */
export function excerpt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const note = "\n[... clipped; Read can inspect omitted content ...]\n";
  if (limit <= note.length) return head(note, Math.max(0, limit));
  const first = Math.floor((limit - note.length + 1) / 2);
  const last = limit - note.length - first;
  return head(text, first) + note + (last ? tail(text, last) : "");
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** Bounded head/tail text excerpts, or null for private, binary or unreadable files. */
export function fileText(root: string, name: string, limit: number, { allowHiddenLog = false }: { allowHiddenLog?: boolean } = {}): string | null {
  const path = reviewPath(root, name, { allowHiddenLog });
  if (path === null) return null;
  try {
    if (!existsSync(path)) return "(deleted)";
    if (!statSync(path).isFile()) return null;
    const handle = openSync(path, "r");
    let text: string;
    try {
      // Four bytes cover a UTF-8 character; never load a whole large verification log.
      const size = Math.max(1, limit) * 4;
      const data = Buffer.alloc(size + 1);
      const got = data.subarray(0, readSync(handle, data, 0, size + 1, 0));
      if (got.length > size) {
        const total = statSync(path).size;
        const end = Buffer.alloc(size);
        const tailBytes = end.subarray(0, readSync(handle, end, 0, size, total - size));
        if (got.includes(0) || tailBytes.includes(0)) return null;
        // The byte ranges can cut through a multi-byte character at either end.
        text = got.toString("utf8") + tailBytes.toString("utf8");
      } else {
        if (got.includes(0)) return null;
        text = strictUtf8.decode(got);
      }
    } finally {
      closeSync(handle);
    }
    return excerpt(text, limit);
  } catch {
    return null;
  }
}

const skipped = (parts: string[]) => parts.some((part) => SKIP_DIRS.has(part) || part.startsWith("."));

/** Workspace files named in a result, relative to ``root``: the evidence for an attempt that
 *  checked earlier work without changing anything. */
export function mentionedFiles(root: string, text: string | null | undefined): string[] {
  const found: string[] = [];
  let base: string;
  try {
    base = realResolve(root);
  } catch {
    return found;
  }
  for (const match of (text || "").matchAll(pyRegex(PATH_MENTION, "g"))) {
    let name = match[0].replace(/\.+$/, "");
    if (name.startsWith("/")) {
      if (!name.startsWith(base + "/")) continue;
      name = name.slice(base.length + 1);
    }
    if (name.startsWith("./")) name = name.slice(2);
    if (!name || found.includes(name)) continue;
    const path = reviewPath(root, name, { allowHiddenLog: true });
    try {
      if (path !== null && existsSync(path) && statSync(path).isFile()) found.push(name);
    } catch {
      continue;
    }
    if (found.length >= MAX_LISTED_FILES) break;
  }
  return found;
}

/** Public workspace files with their sizes, including unchanged files. */
export function workspaceListing(root: string): string {
  const entries: string[] = [];
  if (!existsSync(root) || !statSync(root).isDirectory()) return "";
  const relativeOf = (path: string) => relative(root, path).split(sep).join("/");
  const walk = (folder: string): boolean => {
    let listing;
    try {
      listing = readdirSync(folder, { withFileTypes: true });
    } catch {
      return true;
    }
    const isFolder = (entry: (typeof listing)[number]) => entry.isDirectory()
      || (entry.isSymbolicLink() && existsSync(join(folder, entry.name)) && statSync(join(folder, entry.name)).isDirectory());
    const dirs = listing.filter(isFolder).map((entry) => entry.name)
      .filter((name) => !skipped([name]) && reviewPath(root, relativeOf(join(folder, name))) !== null).sort();
    for (const name of listing.filter((entry) => !isFolder(entry)).map((entry) => entry.name).sort()) {
      const path = join(folder, name);
      if (reviewPath(root, relativeOf(path)) === null) continue;
      let size: number;
      try {
        size = statSync(path).size;
      } catch {
        continue;
      }
      entries.push(`${relativeOf(path)} (${size} bytes)`);
      if (entries.length > MAX_INVENTORY_FILES) {
        entries[entries.length - 1] = "[... more files not listed]";
        return false;
      }
    }
    for (const name of dirs) {
      if (!isLink(join(folder, name)) && !walk(join(folder, name))) return false;
    }
    return true;
  };
  walk(root);
  return entries.join("\n");
}

/** Relevant file excerpts sharing a bounded budget, followed by a workspace listing. Changed
 *  files, earlier work and explicit references all contribute evidence. A long delivery document
 *  must not crowd out source, tests or the final verification output. */
export function changeEvidence(root: string, files: string[], { referenced = [] }: { referenced?: string[] } = {}): string {
  const allowed = new Set(referenced);
  const kept = [...new Set(files)].filter((name) => reviewPath(root, name, { allowHiddenLog: allowed.has(name) }) !== null);
  // Prefer implementation/tests over logs and prose when there are too many files to inline.
  const ordered = sortedBy(kept, (name) => ([".md", ".rst", ".txt"].includes(suffix(name).toLowerCase()) ? 2
    : LOG_SUFFIXES.has(suffix(name).toLowerCase()) ? 1 : 0));
  let output = changedContents(root, ordered.slice(0, MAX_LISTED_FILES), allowed);
  const listing = workspaceListing(root);
  if (listing) output = (output ? output + "\n" : "") + `--- files in the workspace ---\n${listing}`;
  return output;
}

function changedContents(root: string, files: string[], referenced: Set<string>): string {
  if (!files.length) return "";
  const inGit = tracked(root, files);
  const sections: string[] = [];
  let remaining = MAX_DIFF_CHARS;
  files.forEach((name, index) => {
    // Reserve a share for every remaining file, redistributing unused space from short ones.
    const budget = Math.floor(remaining / (files.length - index));
    const diff = inGit.has(name) ? gitDiff(root, [name]) : "";
    const header = `--- ${name} (${diff ? "diff" : "contents"}) ---\n`;
    const limit = Math.max(0, budget - header.length - 1);
    const text = diff ? excerpt(diff, limit) : fileText(root, name, limit, { allowHiddenLog: referenced.has(name) });
    if (text !== null) {
      const section = excerpt(header + text, Math.max(0, budget - 1));
      sections.push(section);
      remaining -= section.length + 1;
    }
  });
  return sections.join("\n");
}

/** Nodes that depend, directly or not, on any of ``roots``. */
export function descendants(run: ExecutionRun, roots: Set<string>): Set<string> {
  const found = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const node of run.plan.nodes) {
      if (!found.has(node.id) && node.dependencies.some((id) => roots.has(id) || found.has(id))) {
        found.add(node.id);
        changed = true;
      }
    }
  }
  return found;
}
