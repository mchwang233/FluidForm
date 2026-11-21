// Plan complete work items once, using the existing task graph and execution gates.
import * as contracts from "./contracts.js";
import { ask, MAX_REQUIRE_CHARS, MAX_REQUIRES, planTitle } from "./lead-planning.js";
import type { TaskNode, TaskPlan } from "./models.js";
import { CHOICES_RULE, CHOICES_SHAPE, get, INDEPENDENT_RULE, MAX_NODES, PlanProblem, planChoices, type Say, validatePlan } from "./planner.js";
import { head, pyStr } from "./py.js";
import * as team from "./team.js";

// Employees, and each employee's sessions, work at the same time; a plan whose tasks wait for one another
// in a single line leaves them idle and makes every retry redo a large item.
export const PARALLEL_RULE = "Plan for concurrency: every employee, and each employee's sessions, can work at the same time. "
  + "Start dependent work as soon as an agreed interface allows; for example a verification environment "
  + "(testbench, agents, checkers, reference model, coverage model) is built from the interface contract "
  + "alongside the implementation, and only running it against the implementation waits for it. Split a "
  + "hard item that would take more than about an hour into items that need not share one working "
  + "session, by module, configuration, metric or target family, joined by a task that combines their "
  + "results. If no two tasks can truly run at the same time, give serial_reason.\n";
export const SERIAL_CHECK_MIN_NODES = 3;

/** How many tasks can run at once, at least: the most tasks at one depth of the graph. */
export function width(nodes: TaskNode[]): number {
  const byId = new Map(nodes.map((item) => [item.id, item]));
  const depth = new Map<string, number>();
  const level = (item: TaskNode, seen: string[] = []): number => {
    if (!depth.has(item.id)) {
      const below = item.dependencies.filter((key) => byId.has(key) && !seen.includes(key)).map((key) => level(byId.get(key)!, [...seen, item.id]));
      depth.set(item.id, 1 + (below.length ? Math.max(...below) : -1));
    }
    return depth.get(item.id)!;
  };
  const counts = new Map<number, number>();
  for (const item of nodes) counts.set(level(item), (counts.get(level(item)) ?? 0) + 1);
  return counts.size ? Math.max(...counts.values()) : 0;
}

export function concurrencyNote(plan: TaskPlan, serialReason = ""): string {
  const atOnce = width(plan.nodes);
  if (atOnce > 1) return `最多 ${atOnce} 个任务可同时进行`;
  return "任务依次进行" + (serialReason ? `（${serialReason}）` : "");
}

export const PROMPT = `DIRECT_TASK_PLAN: Produce the executable task list now. There is NO later refinement stage.
Use a small number of complete work items, each with a clear owner, matters to handle, deliverable,
acceptance criteria and real dependencies. Do not recursively split tasks, create placeholder parts,
or add a planning/refinement task. One task is enough for a simple request. Group related work and
its local checks; do not turn every file, command, function or routine action into a separate task.
Describe what the employee must accomplish, not the full implementation. Leave implementation choices
to that employee. If facts are missing, name them as things to establish during the appropriate task.
Do not solve the project or inspect the environment during this planning response.

List tasks in dependency order. A task waits only for results it actually needs. Independent work may
run together. ` + INDEPENDENT_RULE + PARALLEL_RULE + `Describe concrete handoffs in provides. Use an independent verification task when needed;
its verifies are keys it checks, and every such key must also be listed in its dependencies, including
transitive prerequisites. Assign employee_id from the team when a team is supplied.
Choose difficulty easy/normal/hard for execution, and estimate the complete work item's token use.
For file work, list known files it owns and reads, relative to the workspace. Do not invent unknown
paths or split work solely to meet a file/turn count. If its files are not known yet, give "folders" instead:
the folders that task alone creates and changes files in, ending with "/" (for example "rtl/core/",
"tests/core/"), including its tests, logs and build output. Tasks that can run at the same time must not
share folders or nest one in another. A task that writes files but names neither files nor folders has
the whole workspace to itself, so it runs alone. Set needs_workspace=true when accessing the
target project. Workers can edit files and run sandboxed commands; internet requires task permission,
and root/system installation is unavailable. requires contains only commands checking essential tools.
` + CHOICES_RULE + `
Return JSON only with 1-` + String(MAX_NODES) + ` nodes (usually far fewer), no parts or children:
{"summary":"objective","title":"short name for the user's list: request's language, at most 12 Chinese characters or 5 English words","serial_reason":"only if no two tasks can run at the same time: why","folder":"short-english-name","requires":["essential tool check"],` + CHOICES_SHAPE + `,"nodes":[
{"key":"build","title":"short title","employee_id":"chosen employee","instructions":"matters to handle",
"capability":"coding|planning|research|chinese|tool_use|structured_output","difficulty":"normal",
"dependencies":[],"acceptance_criteria":"checkable result","provides":"handoff to dependent tasks",
"verifies":[],"needs_workspace":false,"files":[],"reads":[],"folders":[],"check":"validation command if known",
"estimated_input_tokens":6000,"estimated_output_tokens":3000}]}
Retain explicit artifact evidence and limits when applicable:
` + contracts.RULES + "\nUser request and context:\n";

export async function planTasks(say: Say, opening: string, roster: TaskPlan | null = null, artifactWork = false, inProject = false): Promise<TaskPlan> {
  let asked = 0;
  const read = (payload: any): TaskPlan => {
    asked += 1;
    if (get(payload, "parts") || get(payload, "children")) throw new PlanProblem("return executable nodes, not parts needing refinement");
    const plan = validatePlan(payload, 1);
    if (artifactWork && !plan.nodes.some((item) => item.artifact_contract)) throw new contracts.ContractError("Requested artifact work needs declared evidence and limits");
    const raws: any[] = payload.nodes;
    const byKey = new Map(raws.map((raw, i) => [pyStr(get(raw, "key", `n${i + 1}`)), plan.nodes[i]]));
    plan.nodes.forEach((item, i) => {
      const raw = raws[i];
      if (!item.acceptance_criteria) throw new PlanProblem(`${item.title}: describe how its result will be accepted`);
      // A folder named as a file or read is in scope as a whole (scopes.ts), so "rtl/" is "rtl".
      item.files = item.files.map((path) => path.replace(/\/+$/, "") || path);
      item.reads = item.reads.map((path) => path.replace(/\/+$/, "") || path);
      const bad = [...item.files, ...item.reads].filter((path) => !contracts.safeName(path));
      if (bad.length) {
        throw new PlanProblem(`${item.title}: these files/reads are not allowed: ${bad.join(", ")}. Use plain `
          + "paths relative to the working directory, without wildcards, '..', absolute paths "
          + "or private files (.env, keys, .git); leave out what you cannot name");
      }
      const verifies = get(raw, "verifies") || [];
      const ancestors = new Set(contracts.ancestors(item, plan.nodes).map((upstream) => upstream.id));
      if (!Array.isArray(verifies) || verifies.some((key) => typeof key !== "string" || !byKey.has(key) || !ancestors.has(byKey.get(key)!.id))) {
        throw new PlanProblem(`${item.title}: verifies must name dependencies`);
      }
      // An auditor may name an indirect prerequisite. Add only redundant graph edges: ordering is
      // unchanged, the reviewer gets that result, and no model retry is needed.
      item.verifies = [...new Set(verifies.map((key: string) => byKey.get(key)!.id))];
      item.dependencies = [...new Set([...item.dependencies, ...item.verifies])];
      if (roster) {
        const employee = team.member(roster, item.employee_id);
        if (!employee || !employee.capabilities.includes(item.capability)) throw new PlanProblem(`${item.title}: choose a capable employee_id from the team`);
      }
    });
    if (roster) {
      plan.employees = roster.employees;
      plan.team_brief = roster.team_brief;
    }
    const requires = get(payload, "requires") || [];
    if (!Array.isArray(requires) || requires.some((cmd) => typeof cmd !== "string" || !cmd.trim() || [...cmd].length > MAX_REQUIRE_CHARS)) {
      throw new PlanProblem("requires must contain bounded, nonempty tool check commands");
    }
    if (requires.length > MAX_REQUIRES) throw new PlanProblem(`requires allows at most ${MAX_REQUIRES} commands`);
    plan.requires = [...new Set(requires.map((cmd: string) => cmd.trim()))];
    plan.folder = head(pyStr(get(payload, "folder") || ""), 80);
    plan.title = planTitle(payload);
    plan.choices = planChoices(payload);
    contracts.validate(plan); // expanded verification still needs all original evidence and limits
    plan.in_project = inProject;
    const problems = contracts.unwrittenScripts(plan);
    if (problems.length) throw new PlanProblem(problems.join("; "));
    const serialReason = head(pyStr(get(payload, "serial_reason") || "").trim(), 300);
    // Asked once, in the correction round: a plan that truly cannot overlap is then kept as is.
    if (asked === 1 && !serialReason && plan.nodes.length >= SERIAL_CHECK_MIN_NODES && width(plan.nodes) === 1
      && plan.nodes.some((item) => item.difficulty === "hard")) {
      throw new PlanProblem("every task waits for the previous one, so no two run at the same time; start "
        + "work from agreed interfaces in parallel and split large hard items by module, "
        + "configuration, metric or target family, or give serial_reason");
    }
    plan.planning_note = concurrencyNote(plan, serialReason);
    return plan;
  };
  return ask(say, opening, read);
}
