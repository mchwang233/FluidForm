// Looking back on finished tasks, so problems that keep coming back are seen as such.
//
// When a task ends, ``record`` sums it up from what was recorded, without asking a model: each step's
// estimate against what it cost and the turns it took, and the problems it ran into, each named by a
// kind and a key (["environment", "vcs"], ["model_unavailable", "glm:glm-5.3"]) so the same problem in
// different tasks has the same name. ``recurring`` counts each problem across tasks and marks the ones
// that came back after a repair; ``similar`` gives a diagnosis the earlier cases of the problem in
// front of it (diagnosis.repairPrompt).
//
// Those names follow the records (a module, a program), so one cause can go by several. After a task
// ends, ``nameProblems`` has the cheapest model name each problem by what it is about, reusing names
// already given; ``topics`` groups problems across tasks by those names.
import type { Database } from "./db.js";
import { log } from "./log.js";
import { DiagnosisStatus, type ExecutionRun, Outcome, type TaskNode, isPlatformScope } from "./models.js";
import { fixed, head, pyDumps, pyIsoformat, pyRegex, pyRound, pySplit, sortedBy, splitlines } from "./py.js";
import { deps as routing } from "./routing.js";

export const FINISHED = new Set(["succeeded", "failed", "cancelled", "incomplete"]);
export const AUTOMATIC = new Set(["succeeded", "failed", "incomplete"]);
export const END_EVENTS = new Set([...AUTOMATIC].map((status) => `run.${status}`));
// A step's cost or turns this many times its estimate is a problem worth counting.
export const OVER = 2.0;
// Below this a step's cost says nothing about the estimate.
export const NOTICEABLE_USD = 0.01;
const REPAIRED = new Set<string>([DiagnosisStatus.FIXED, DiagnosisStatus.PLATFORM_FIXED]);
// Pauses that are the user's own doing or a restart, not a problem.
const ORDINARY_PAUSES = new Set(["interrupted", "user_paused"]);
// Words of a failing command that are not the program it is about: ones that end the part of the
// command they start (cd somewhere, source a script, set options, print something), and ones that
// only come before the program (bash -lc, sudo, time).
const REST = new Set(["cd", "source", ".", "set", "export", "echo", "printf", "cat", "ls", "rm", "mkdir", "test", "[", "true"]);
const BEFORE = new Set(["bash", "sh", "env", "sudo", "time", "nohup", "exec", "then", "if", "for", "do", "while", "{", "("]);
const LOOKUP = new Set(["which", "command", "type"]);
const NAME = pyRegex(String.raw`^[A-Za-z][\w.+-]*$`);

export type Problem = { kind: string; key: string; label: string; node_id: string | null; repaired: boolean; detail: string; topic?: string };
export type Review = Record<string, any> & { run_id: string; started_at: string; problems: Problem[]; steps: Record<string, any>[] };
export type Db = Pick<Database, "getRun" | "sharedRepairs" | "engineerJobs" | "events" | "retrospective" | "saveRetrospective" | "retrospectives" | "listRuns">;

const strip = (word: string, chars: string) => {
  let start = 0;
  let end = word.length;
  while (start < end && chars.includes(word[start])) start += 1;
  while (end > start && chars.includes(word[end - 1])) end -= 1;
  return word.slice(start, end);
};

/** The program a failing shell command was about: ``vcs`` for ``source .edarc && which vcs && vcs -ID``. */
export function program(command: string): string | null {
  for (const part of command.split(/&&|\|\||;|\||\n/)) {
    let words = pySplit(part).filter((word) => !word.includes("=")).map((word) => strip(word, "'\"")).filter(Boolean);
    while (words.length && (BEFORE.has(words[0]) || words[0].startsWith("-"))) words = words.slice(1);
    if (!words.length || REST.has(words[0])) continue;
    if (LOOKUP.has(words[0])) {
      words = words.slice(1).filter((word) => !word.startsWith("-"));
      if (!words.length) continue;
    }
    const name = words[0].split("/").at(-1)!;
    if (NAME.test(name)) return name;
  }
  return null;
}

/** Counter(...).most_common(): by count, the first seen first among equals. */
export function mostCommon(items: Iterable<string>): string[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return sortedBy(counts.keys(), (key) => counts.get(key)!, true);
}

function failingProgram(run: ExecutionRun, nodeId: string | null | undefined): string {
  const node = run.plan.nodes.find((item) => item.id === nodeId);
  const names: string[] = [];
  for (const attempt of node?.attempts ?? []) {
    for (const call of attempt.tool_calls) {
      const name = !call.ok && (call.tool === "Bash" || call.tool === "run_command") ? program(call.detail) : null;
      if (name) names.push(name);
    }
  }
  return mostCommon(names)[0] ?? "general";
}

/** The first line of a report that says something (not a heading or a bare label). */
function headline(report: string | null | undefined): string {
  for (const line of splitlines(report || "")) {
    const text = strip(strip(line, " \t\n\r\v\f"), "#*-> ").trim();
    if ([...text].length > 12) return text;
  }
  return "";
}

export function problem(kind: string, key: string, label: string, nodeId: string | null = null, repaired = false, detail = ""): Problem {
  return { kind, key, label: head(label, 200), node_id: nodeId, repaired, detail: head(detail, 600) };
}

/** What a repair touched, as problem names: ["platform", module] for FluidForm's own source (agent
 *  for agent.ts; cli_channels for cli-channels.ts, as the Python module was named, so older repairs
 *  count with newer ones), ["environment", tool] for the shared tools folder (ssh for bin/ssh). Tests
 *  and documents are not areas. */
export function repairedAreas(files: string[]): [string, string][] {
  const areas = new Map<string, [string, string]>();
  for (const name of files) {
    const path = name.replaceAll("\\", "/");
    const last = path.split("/").at(-1)!;
    const stem = last.includes(".") ? last.slice(0, last.lastIndexOf(".")) : last;
    let area: [string, string] | null = null;
    if ((path.startsWith("server/src/") || /^server\/packages\/[^/]+\/src\//.test(path)) && stem) area = ["platform", stem.replaceAll("-", "_")];
    else if ((path.startsWith("backend/super_partner/") || path.startsWith("frontend/")) && stem !== "__init__" && stem !== "") area = ["platform", stem];
    else if (["bin/", "python/", "node/"].some((prefix) => path.startsWith(prefix)) || path === "sandbox.json") area = ["environment", stem];
    if (area) areas.set(area.join("\0"), area);
  }
  return [...areas.values()];
}

/** The look back on one task: its steps and the problems it ran into. ``events`` are the task's
 *  (db.events), ``repairs`` the repairs made for it: shared repair records and the platform
 *  engineer's applied jobs, with files and a report. */
export function review(run: ExecutionRun, events: { kind: string; data: Record<string, any> | null }[], repairs: Record<string, any>[] = []): Review {
  const steps: Record<string, any>[] = [];
  const problems: Problem[] = [];
  for (const node of run.plan.nodes) {
    const spent = pyRound(node.attempts.reduce((sum, attempt) => sum + attempt.cost_usd, 0), 6);
    const turns = Math.max(0, ...node.attempts.map((attempt) => attempt.turns));
    const expected = routing.loopTurns(node);
    steps.push({ id: node.id, title: node.title, model_id: node.model_id, status: node.status, estimated_usd: node.estimated_cost_usd,
      actual_usd: spent, expected_turns: expected, turns, attempts: node.attempts.length, ...(node.accepted_by_lead ? { accepted_by_lead: true } : {}) });
    // Done only because its lead let it through: a step that did not pass, counted as such across tasks.
    if (node.status === "succeeded" && node.accepted_by_lead) {
      const last = node.attempts.at(-1);
      problems.push(problem("accepted_unpassed", node.model_id || "?", `未通过（${last?.outcome ?? "?"}），负责人放行：${head((node.review || "").replace(/^负责人接受：/, ""), 160)}`, node.id));
    }
    if (node.estimated_cost_usd && spent >= NOTICEABLE_USD && spent > OVER * node.estimated_cost_usd) {
      problems.push(problem("estimate_low", node.model_id || "?", `花费 $${fixed(spent, 3)}，估算 $${fixed(node.estimated_cost_usd, 3)}`, node.id));
    }
    for (const attempt of node.attempts) {
      if (attempt.turns && attempt.turns > OVER * expected) {
        problems.push(problem("turns_over", attempt.model_id || "?", `用了 ${attempt.turns} 轮，预期 ${expected} 轮`, node.id));
      }
      if (attempt.outcome === Outcome.UNAVAILABLE || attempt.outcome === Outcome.QUOTA) {
        problems.push(problem("model_unavailable", attempt.model_id || "?", attempt.reason || "", node.id));
      }
    }
  }
  for (const repair of repairs) {
    const report = repair.report || "";
    for (const [kind, key] of repairedAreas(repair.files || [])) problems.push(problem(kind, key, headline(report), repair.node_id ?? null, true, report));
  }
  const shared = new Set(repairs.map((item) => item.id));
  for (const diagnosis of run.diagnoses) {
    const verdict = diagnosis.verdict;
    if (diagnosis.status !== "done" || verdict === null || verdict === DiagnosisStatus.RETRY || shared.has(diagnosis.id)) continue; // nothing found, or counted above
    if (verdict === DiagnosisStatus.QUOTA_EXHAUSTED || verdict === DiagnosisStatus.MODEL_UNAVAILABLE) continue; // counted as model_unavailable
    if (verdict.startsWith("platform") || isPlatformScope(diagnosis.scope)) continue; // a platform repair leaves a repair record
    problems.push(problem("environment", failingProgram(run, diagnosis.node_id), headline(diagnosis.report) || verdict, diagnosis.node_id,
      REPAIRED.has(verdict), diagnosis.report || ""));
  }
  for (const event of events) {
    const data = event.data || {};
    if (event.kind === "approval.required" && !ORDINARY_PAUSES.has(data.reason)) {
      problems.push(problem("paused", String(data.reason ?? "None"), "任务暂停，等用户处理", data.node_id ?? null));
    } else if ((event.kind === "node.progress_check" || event.kind === "node.overrun_check") && data.stop) {
      problems.push(problem("stuck", String(data.model_id ?? "None"), String(data.reason || ""), data.node_id ?? null));
    }
  }
  const estimated = pyRound(steps.reduce((sum, step) => sum + (step.estimated_usd || 0), 0), 6);
  return { run_id: run.id, status: run.status, prompt: head(run.prompt, 200), started_at: pyIsoformat(run.created_at),
    finished_at: pyIsoformat(run.updated_at), estimated_usd: estimated, actual_usd: run.actual_cost_usd, steps, problems };
}

const identity = (item: Problem) => pyDumps([item.kind, item.key, item.node_id ?? null, item.label]);

/** Sum up a finished task and keep it (db.saveRetrospective). Never throws: looking back must not
 *  break the task's end. */
export function record(db: Db, runId: string): Review | null {
  try {
    const run = db.getRun(runId);
    if (!run || !FINISHED.has(run.status)) return null;
    const repairs: Record<string, any>[] = db.sharedRepairs(1000).filter((item) => item.run_id === runId);
    for (const job of db.engineerJobs(1000)) {
      if (job.run_id === runId && job.status === "applied" && job.origin !== "user") {
        repairs.push({ id: job.id, files: job.files, report: job.report || job.request, node_id: job.node_id });
      }
    }
    const body = review(run, db.events(runId), repairs);
    // Recorded again (a resumed task, a backfill): the problems already named keep their names.
    const earlier = (db.retrospective(runId) || {}) as Record<string, any>;
    const named = new Map<string, string>();
    for (const item of (earlier.problems || []) as Problem[]) if (item.topic) named.set(identity(item), item.topic);
    for (const item of body.problems) {
      const topic = named.get(identity(item));
      if (topic) item.topic = topic;
    }
    for (const key of ["topics_model_id", "topics_cost_usd"]) if (key in earlier) body[key] = earlier[key];
    db.saveRetrospective(runId, body);
    return body;
  } catch (error) {
    log.error(`Could not look back on task ${runId}: ${(error as Error).stack ?? error}`);
    return null;
  }
}

/** Existing reviews and natural completions; never backfills user-cancelled tasks. */
export function allReviews(db: Db): Review[] {
  const kept = new Map<string, Review>();
  for (const item of db.retrospectives() as Review[]) kept.set(item.run_id, item);
  for (const run of db.listRuns()) {
    if (AUTOMATIC.has(run.status) && !kept.has(run.id)) {
      const body = record(db, run.id);
      if (body) kept.set(run.id, body);
    }
  }
  return sortedBy(kept.values(), (item) => item.started_at);
}

export type Group = { kind: string; key: string; runs: string[]; repaired_in: string[]; label: string; detail: string;
  recurred_after_repair: boolean; last_seen: string };

/** Each kind of problem across tasks: in how many it came up, when, whether it was repaired, and
 *  whether it came back in a later task after a repair. Most frequent first. */
export function recurring(db: Db, minRuns = 1): Group[] {
  const groups = new Map<string, Group>();
  for (const body of allReviews(db)) {
    for (const item of body.problems) {
      const id = pyDumps([item.kind, item.key]);
      let group = groups.get(id);
      if (!group) {
        group = { kind: item.kind, key: item.key, runs: [], repaired_in: [], label: "", detail: "", recurred_after_repair: false, last_seen: body.started_at };
        groups.set(id, group);
      }
      if (!group.runs.includes(body.run_id)) {
        group.recurred_after_repair ||= group.repaired_in.length > 0;
        group.runs.push(body.run_id);
      }
      if (item.repaired && !group.repaired_in.includes(body.run_id)) group.repaired_in.push(body.run_id);
      group.label = item.label || group.label;
      group.detail = item.detail || group.detail;
      if (body.started_at > group.last_seen) group.last_seen = body.started_at;
    }
  }
  return sortedBy([...groups.values()].filter((group) => group.runs.length >= minRuns), (group) => [-group.runs.length, group.kind, group.key]);
}

/** The names of the problem a failing step is in: its failing program, the model it ran on. */
export function signatures(run: ExecutionRun, node: TaskNode): Set<string> {
  const failing = failingProgram(run, node.id);
  const names = [["environment", failing], ["platform", failing]];
  if (node.model_id) for (const kind of ["model_unavailable", "turns_over", "stuck"]) names.push([kind, node.model_id]);
  return new Set(names.map((name) => name.join(":")));
}

/** Lines for a diagnosis: the same kind of problem in other tasks, with how it went. */
export function similar(db: Db, run: ExecutionRun, node: TaskNode, limit = 5): string[] {
  const wanted = signatures(run, node);
  const lines: string[] = [];
  const words = (repairedIn: string[], back: boolean) => [repairedIn.length ? `repaired in ${repairedIn.length} of them` : "never repaired",
    back ? "; it came back after a repair, so the earlier repair did not remove the cause" : ""];
  // The same cause under other names first: a topic holding any of this step's names.
  for (const group of topics(db)) {
    const others = group.runs.filter((item) => item !== run.id);
    // A member is "kind:key"; a wanted name matches when its key is more than "general".
    const shared = group.members.filter((member) => wanted.has(member) && member.slice(member.indexOf(":") + 1) !== "general");
    if (!others.length || !shared.length) continue;
    const [repaired, back] = words(group.repaired_in, group.recurred_after_repair);
    lines.push(`- 「${group.topic}」 (recorded as ${group.members.slice(0, 6).join(", ")}) in ${others.length} earlier `
      + `task(s), last ${group.last_seen.slice(0, 10)}, ${repaired}${back}. Latest: ${head(group.label, 300)}`);
    if (lines.length >= limit) return lines;
  }
  for (const group of recurring(db)) {
    const others = group.runs.filter((item) => item !== run.id);
    if (!wanted.has(`${group.kind}:${group.key}`) || !others.length || group.key === "general") continue;
    const [repaired, back] = words(group.repaired_in, group.recurred_after_repair);
    lines.push(`- ${group.kind}:${group.key} in ${others.length} earlier task(s), last ${group.last_seen.slice(0, 10)}, `
      + `${repaired}${back}. Latest report: ${head(group.detail, 400) || group.label}`);
    if (lines.length >= limit) break;
  }
  return lines;
}

export type Topic = { topic: string; runs: string[]; repaired_in: string[]; members: string[]; label: string; recurred_after_repair: boolean; last_seen: string };

/** Problems across tasks grouped by their names: in how many tasks each came up, what the records
 *  called it (``members``), whether it was repaired and came back after. Most frequent first. */
export function topics(db: Db, minRuns = 1): Topic[] {
  const groups = new Map<string, Topic>();
  for (const body of sortedBy(db.retrospectives() as Review[], (item) => item.started_at)) {
    for (const item of body.problems || []) {
      const name = item.topic;
      if (!name) continue;
      let group = groups.get(name);
      if (!group) {
        group = { topic: name, runs: [], repaired_in: [], members: [], label: "", recurred_after_repair: false, last_seen: body.started_at };
        groups.set(name, group);
      }
      if (!group.runs.includes(body.run_id)) {
        group.recurred_after_repair ||= group.repaired_in.length > 0;
        group.runs.push(body.run_id);
      }
      if (item.repaired && !group.repaired_in.includes(body.run_id)) group.repaired_in.push(body.run_id);
      const member = `${item.kind}:${item.key}`;
      if (!group.members.includes(member)) group.members.push(member);
      group.label = item.label || group.label;
      if (body.started_at > group.last_seen) group.last_seen = body.started_at;
    }
  }
  return sortedBy([...groups.values()].filter((group) => group.runs.length >= minRuns), (group) => [-group.runs.length, group.topic]);
}

// Tasks a problem must have come up in before a retrospective asks the platform engineer to change it
//: a one-off seldom merits a change, and most were turned down.
export const PLATFORM_MIN_RUNS = 2;

/** The tasks a problem came up in: by its kind and key, and by the name it was given, which joins the
 *  same cause recorded under other keys. */
export function runsWith(db: Db, kind: string, key: string): Set<string> {
  const member = `${kind}:${key}`;
  const found = new Set<string>();
  for (const group of recurring(db)) if (group.kind === kind && group.key === key) for (const run of group.runs) found.add(run);
  for (const group of topics(db)) if (group.members.includes(member)) for (const run of group.runs) found.add(run);
  return found;
}

export type Completion = { text: string; input_tokens: number; output_tokens: number };
