// Checking on a long attempt instead of cutting it off: after a while, another model
// looks at what the attempt has been doing and says whether it is still getting somewhere or is
// stuck. Only a stuck attempt is stopped; it then fails like any other attempt.
import { execFile } from "node:child_process";
import { lstat, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { TaskNode } from "./models.js";
import { fixed, formatG, head, isObject, pyRegex, pyStr, tail } from "./py.js";

/** Looks at the evidence of an attempt so far; returns why to stop it, or null to let it go on. */
export type Watch = (evidence: string) => Promise<string | null>;

/** A CLI stopped because a progress check found it stuck. */
export class Stopped extends Error {
  override name = "Stopped";
}

// How the error of a stopped attempt reads.
export const STOPPED = "进度检查判断这次尝试卡住，已停止：";
// Told to the checker when the model has not answered its latest request yet.
export const waiting = (minutes: number) =>
  `It is now waiting for its model's reply to one request: ${fixed(minutes)} minutes so far, nothing back yet.`;
// A work package past twice its expected turns goes to the task's lead (supervisor.overrun_message),
// and again at every further multiple; how the error reads when the lead stops it.
export const OVERRUN_FACTOR = 2;
export const OVERRUN = "超出预计轮数，负责人已停止这次尝试：";
export const CRITICAL_OVERRUN = "这一步挡着后面的步骤，用时远超预期，负责人已停止这次尝试（可以换更快的模型）：";
export const EXPECTED_TURNS: Record<string, number> = { easy: 10, normal: 15, hard: 25 };

/** Hard declared limits survive retries, rework and model switches. */
export function limitReason(node: TaskNode): string | null {
  const contract = node.artifact_contract;
  if (!contract) return null;
  if (node.contract_turns >= contract.max_turns) return `达到声明轮次上限 ${contract.max_turns}，停止工作包；保留产物与日志供诊断。`;
  if (node.contract_cost_usd >= contract.max_cost_usd) {
    return `达到声明费用上限 $${formatG(contract.max_cost_usd)}，停止工作包；保留产物与日志供诊断。`;
  }
  return null;
}

/** Tool turns a scoped work package should take (planner.package); null for other steps. */
export function expectedTurns(node: TaskNode): number | null {
  if (!(node.files.length || node.reads.length) || node.verifies.length) return null;
  return EXPECTED_TURNS[node.difficulty] ?? EXPECTED_TURNS.normal;
}

const VERDICT = pyRegex(String.raw`^\s*VERDICT:\s*(CONTINUE|STOP)\b:?\s*(.*)$`, "img");
// Tool calls of an API model shown to the checker, latest last.
export const RECENT_CALLS = 40;
// Tool entries of a CLI shown to the checker, latest last, and how much of each output.
export const RECENT_ENTRIES = 6;
export const ENTRY_OUTPUT = 500;
// Files a CLI changed, and processes it runs, shown to the checker.
export const MAX_LISTED = 40;
// How much of a command line is shown; long paths must not hide what it actually runs.
export const COMMAND_CHARS = 200;
const SKIP_DIRS = new Set([".git", ".review", "node_modules", "__pycache__", ".venv", "venv"]);

export function checkPrompt(node: TaskNode, minutes: number, evidence: string): string {
  return `A model has been working on one step of a task for ${fixed(minutes)} minutes. Decide whether `
    + "it is still making real progress, or is stuck and should be stopped.\n\n"
    + `Step: ${node.title}\n${node.instructions}\n\n`
    + (node.acceptance_criteria ? `Acceptance criteria:\n${node.acceptance_criteria}\n\n` : "")
    + `What it has done so far:\n${evidence}\n\n`
    + "Long work that keeps moving (new files, fixes, checks that change) is fine: let it continue. "
    + "A compile, simulation or regression run that keeps writing logs or files, or whose child "
    + "processes are still running, is making progress even when one command has taken a long "
    + "time: let it continue. "
    + "It is stuck when it repeats the same calls or commands, fails the same way again and again "
    + "without changing approach, waits on something that will not come (a server that never "
    + "starts, a prompt nobody answers, a model reply that has not come for more than 8 minutes), "
    + "or has drifted away from the step. When in doubt, continue.\n"
    + "End with exactly one line: `VERDICT: CONTINUE` or `VERDICT: STOP: <why, in Chinese>`.";
}

/** Only an explicit, unambiguous CONTINUE permits another interval of paid work. */
export function parse(text: string | null | undefined): string | null {
  const matches = [...(text || "").matchAll(VERDICT)];
  if (matches.length !== 1) return "进度检查未给出唯一有效结论，停止本次尝试并交由负责人判断。";
  if (matches[0][1].toUpperCase() !== "STOP") return null;
  return matches[0][2].trim() || "进度检查判断这次尝试已经卡住。";
}

type Call = Record<string, any>;

/** An API model's turns and its latest tool calls. */
export function apiEvidence(turns: number, calls: Call[]): string {
  const ok = (call: Call) => ("ok" in call ? call.ok : true);
  const failed = calls.filter((call) => !ok(call)).length;
  const lines = [`${turns} turns, ${calls.length} tool calls so far, ${failed} of them failed. Latest calls:`];
  for (const call of calls.slice(-RECENT_CALLS)) {
    lines.push(`- turn ${call.turn}: ${call.tool} ${call.detail}${ok(call) ? "" : "  (failed)"}`
      + (call.output ? `\n  Evidence: ${tail(call.output, 500)}` : ""));
  }
  return lines.join("\n");
}

export type FileState = Map<string, [number, number]>; // modification time (s), size

/** Modification time and size of the files under ``root``, skipping build and VCS folders (as
 *  os.walk: a link to a folder is not entered, a link to a file is read through). */
export async function fileState(root: string): Promise<FileState> {
  const state: FileState = new Map();
  async function walk(folder: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(path);
        return;
      }
      try {
        const info = await stat(path);
        if (info.isDirectory()) return; // a link to a folder
        state.set(relative(root, path).split(sep).join("/"), [info.mtimeMs / 1000, info.size]);
      } catch {
        // gone, or a broken link
      }
    }));
  }
  try {
    await lstat(root);
  } catch {
    return state;
  }
  await walk(root);
  return state;
}

export function size(value: number): string {
  if (value < 1024) return `${value} B`;
  let amount = value;
  for (const unit of ["KB", "MB", "GB"]) {
    amount /= 1024;
    if (amount < 1024 || unit === "GB") return `${fixed(amount, 1)} ${unit}`;
  }
  return `${fixed(amount, 1)} GB`;
}

export function ago(seconds: number): string {
  if (seconds < 90) return `${fixed(seconds)} seconds`;
  if (seconds < 5400) return `${fixed(seconds / 60)} minutes`;
  return `${fixed(seconds / 3600, 1)} hours`;
}

/** At most ``limit`` characters of a long line: its start and its end, where a regression
 *  command usually names the simulator, its test and its log. */
export function clip(text: string, limit = COMMAND_CHARS): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${head(text, half)}…${tail(text, limit - half - 1)}`;
}

type Row = [number, number, number, string, string]; // ppid, pgid, sid, etime, args

export function processRows(output: string): Map<number, Row> {
  const rows = new Map<number, Row>();
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6 || !parts.slice(0, 4).every((part) => /^\d+$/.test(part))) continue;
    // The command is the rest of the line after the fifth field, as split(None, 5) leaves it.
    const args = line.trim().replace(/^(\S+\s+){5}/, "").trim();
    rows.set(Number(parts[0]), [Number(parts[1]), Number(parts[2]), Number(parts[3]), parts[4], args]);
  }
  return rows;
}

function ps(args: string[]): Promise<{ code: number; output: string } | null> {
  return new Promise((resolve) => {
    execFile("ps", args, { timeout: 10_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") resolve(null);
      else if (error && (error as { killed?: boolean }).killed) resolve(null);
      else resolve({ code: error ? Number((error as { code?: number }).code) || 1 : 0, output: stdout });
    });
  });
}

async function groupProcesses(group: number): Promise<string[]> {
  const found = await ps(["-ww", "-o", "etime=,args=", "-g", String(group)]);
  if (!found) return [];
  return found.output.split(/\r?\n/).filter((line) => line.trim()).map((line) => clip(line.trim()));
}

/** The CLI and every process it started, with how long each has run. A tool may put its
 *  commands in a session or process group of their own, so the whole tree below the CLI counts,
 *  not only the CLI's own group. */
export async function processes(group: number): Promise<string[]> {
  // -ww: without it ps cuts commands at the terminal width, hiding what a long regression's child runs.
  const found = await ps(["-ww", "-eo", "pid=,ppid=,pgid=,sid=,etime=,args="]);
  if (!found) return groupProcesses(group);
  const rows = processRows(found.output);
  if (found.code || !rows.size) return groupProcesses(group);
  const keep = new Set([...rows].filter(([pid, [, pgid, sid]]) => pid === group || pgid === group || sid === group).map(([pid]) => pid));
  for (let growing = true; growing;) {
    growing = false;
    for (const [pid, [ppid]] of rows) {
      if (!keep.has(pid) && keep.has(ppid)) {
        keep.add(pid);
        growing = true;
      }
    }
  }
  return [...keep].sort((a, b) => a - b).map((pid) => `${rows.get(pid)![3]} ${clip(rows.get(pid)![4])}`);
}

export function logLines(log: unknown[] | null | undefined): string[] {
  if (!log || !log.length) return [];
  const lines = ["Its latest tool calls and output:"];
  for (const entry of log.slice(-RECENT_ENTRIES)) {
    if (!isObject(entry)) continue;
    const state = entry.status || (entry.running ? "running" : entry.ok === true ? "succeeded" : entry.ok === false ? "failed" : "unknown");
    const flag = state === "succeeded" ? "" : ` (${pyStr(state)})`;
    lines.push(`- ${pyStr(entry.tool || "tool")}: ${head(pyStr(entry.detail || ""), 200)}${flag}`);
    const output = pyStr(entry.output || "").trim();
    if (output) lines.push("  Output: " + tail(output, ENTRY_OUTPUT).replace(/\n/g, "\n  "));
  }
  return lines;
}

/** Evidence about one CLI attempt; remembers file sizes to show what grew between checks. */
export class CliProgress {
  previous: FileState = new Map();
  outputTotal = 0;

  constructor(readonly root: string, readonly started: number, readonly group: number) {}

  async evidence(lastCheck: number, log: unknown[] | null = null, printed = 0): Promise<string> {
    const now = Date.now() / 1000;
    const state = await fileState(this.root);
    let changed: [number, string, number][];
    if (this.previous.size) {
      // Anything not exactly as at the last check changed since then, even a log written just
      // before that check ended.
      changed = [...state].filter(([name, [mtime, length]]) => {
        const before = this.previous.get(name);
        return !before || before[0] !== mtime || before[1] !== length;
      }).map(([name, [mtime, length]]) => [mtime, name, length]);
    } else {
      changed = [...state].filter(([, [mtime]]) => mtime > lastCheck).map(([name, [mtime, length]]) => [mtime, name, length]);
    }
    // Newest first, as Python sorts the tuples in reverse.
    const recent = changed.sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0) || b[2] - a[2]);
    const overall = [...state].filter(([, [mtime]]) => mtime > this.started);
    const growth = changed.filter(([, name]) => this.previous.has(name))
      .reduce((sum, [, name, length]) => sum + Math.max(0, length - this.previous.get(name)![1]), 0);
    this.outputTotal += Math.max(0, printed);
    const minutes = Math.max(0, (now - lastCheck) / 60);
    const lines = [`Files changed since the start: ${overall.length}; in the last ${fixed(minutes)} minutes: `
      + `${recent.length}` + (growth ? `, ${size(growth)} more than at the last check` : "") + "."];
    for (const [mtime, name, length] of recent.slice(0, MAX_LISTED)) {
      const old = this.previous.get(name);
      const change = old === undefined ? "new" : length > old[1] ? `${size(length - old[1])} larger` : "changed";
      lines.push(`- ${name}: ${size(length)}, ${change}, modified ${ago(now - mtime)} ago`);
    }
    if (printed > 0) lines.push(`It printed ${size(printed)} of output since the last check (${size(this.outputTotal)} in all).`);
    const running = await processes(this.group);
    lines.push("Processes it is running, children included (elapsed time, command):");
    lines.push(...running.slice(0, MAX_LISTED).map((line) => `- ${line}`));
    lines.push(...logLines(log));
    this.previous = state;
    return lines.join("\n");
  }
}
