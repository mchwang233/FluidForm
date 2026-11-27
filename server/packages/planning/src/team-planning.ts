// Forming a project team and delegating work through the task graph (team.form and team.delegate in
// team.ts). Apart from team.ts, which lower modules use, because these need the planner.
import {
  ancestors, CAPABILITIES, contracts, digest, type Employee, EmployeeSchema, type ExecutionRun, member, minBy, type ModelProfile,
  NoEligibleModelError, pyDumps, refreshSkills, route, routingReady, settings, skills, type TaskNode, type TaskPlan, TaskPlanSchema,
  vendor
} from "../../../src/extension-api.js";
import { ask, MAX_TASKS } from "./lead-planning.js";
import { PlanProblem, type Say, scopeProblems, taskNode } from "./planner.js";
import { checkAcyclic } from "./replan.js";

/** Employees from this many on all with one provider are sent back once (SPREAD_RULE). */
export const SPREAD_CHECK_MIN_EMPLOYEES = 3;


// 2026-11-27: a lead gave all five employees its own CLI, and earlier one CLI's five-hour quota stopped
// every step it carried at once; a check by the model that did the work is no independent check.
const SPREAD_RULE = "Spread the team over models of different providers where they are suitable: one provider's "
  + "quota, rate limit or outage then stops only part of the work. Give an employee who checks or verifies others' "
  + "work a model of a different provider than theirs. If one model must do all of it, say why in single_model_reason. ";

/** A separate lead decision, completed before the tasks are planned. */
export async function form(say: Say, request: string, models: ModelProfile[], configured: Set<string>): Promise<TaskPlan> {
  const library = skills.library();
  const available = models.filter((m) => configured.has(m.id) && m.enabled && routingReady(m) && m.provider !== "mock" && !settings.helper_only_models.includes(m.id));
  const catalog = available.map((m) => ({ id: m.id, scores: m.scores, tools: m.supports_tools || m.channel === "cli", context_window: m.context_window,
    input_per_million: m.input_per_million, output_per_million: m.output_per_million, ...(m.usage_note ? { membership_usage: m.usage_note } : {}),
    concurrency: ((settings.provider_limits[m.provider] ?? {}) as Record<string, number>).concurrency ?? 0 }));
  const prompt = "TEAM_SETUP: You are the project lead. Decide the project team FIRST. Do not split the project "
    + "into parts or tasks yet. Staff it like a real project team (1-" + String(settings.team_max_employees) + " employees): "
    + "one employee for each module or area of responsibility that needs its own expertise and can move forward "
    + "on its own (for a chip, for example: processor core, bus and interconnect, peripheral groups, verification, "
    + "firmware, integration), not the fewest people. Give no two employees the same responsibility and no "
    + "employee without work of its own; a small job in one skill needs only one or two. "
    + "Give each employee a stable id, name, role, model_id, capabilities, skills, skill_tools and reason. "
    + "The name is the employee's job in a few words of the user's language (such as \"RTL 设计\" or "
    + "\"验证\"), never a person's name. "
    + "Employees may use different models; select by actual capability, tool access, context, cost and capacity. "
    + "A membership CLI with membership_usage is paid for by its subscription and limited by its quota: its price "
    + "is its share of the subscription, and when its quota is tight give the work to other suitable models. "
    + "Capabilities are responsibilities, not invented improvements to a model's scores. Use only catalog models "
    + "and capabilities coding/planning/research/chinese/tool_use/structured_output. Keep independent verification "
    + "with a suitable separate employee when needed. An employee may also work on several independent tasks at "
    + "the same time, each in a session of its own. " + SPREAD_RULE + "Choose skills "
    + "by exact names from the library; skill_tools lists additional tool knowledge to prepare through the existing "
    + "skill reuse/discovery workflow. Never invent an installed skill. In team_brief record the shared goal, "
    + "constraints, interface ownership and acceptance responsibilities. Return only JSON: "
    + '{"team_brief":"shared agreement", "single_model_reason":"only if one provider must do all the work: why", "employees":[{"id":"builder","name":"job title","role":"...",'
    + '"model_id":"catalog id","capabilities":["coding"],"skills":[],"skill_tools":[],"reason":"..."}]}\n'
    + "Available models:\n" + pyDumps(catalog, false)
    + "\nAvailable skills:\n" + pyDumps(library.map((s) => ({ name: s.name, description: s.description, tools: s.tools })), false)
    + "\nUser request and project context:\n" + request;
  const vendors = new Set(available.filter((m) => m.supports_tools || m.channel === "cli").map(vendor));
  const byId = new Map(available.map((m) => [m.id, m]));
  let asked = 0;
  const read = (payload: any): TaskPlan => {
    asked += 1;
    const raw = payload?.employees;
    if (!Array.isArray(raw) || !(raw.length >= 1 && raw.length <= settings.team_max_employees)) throw new PlanProblem("choose a bounded, nonempty employee team");
    const employees: Employee[] = raw.map((item) => EmployeeSchema.parse(item));
    if (new Set(employees.map((e) => e.id)).size !== employees.length) throw new PlanProblem("employee ids must be unique");
    const known = new Set(available.map((m) => m.id));
    const names = new Set(library.map((s) => s.name));
    for (const employee of employees) {
      if (!known.has(employee.model_id)) throw new PlanProblem(`${employee.id}: unavailable model ${employee.model_id}`);
      if (!employee.capabilities.every((item) => CAPABILITIES.has(item))) throw new PlanProblem(`${employee.id}: unsupported capabilities`);
      if (employee.skill_tools.some((tool) => !tool || [...tool].length > 64 || /\s/.test(tool))) throw new PlanProblem(`${employee.id}: skill_tools must be tool names, not commands`);
      if (employee.skills.some((name) => !names.has(name))) throw new PlanProblem(`${employee.id}: skill names must exist in the supplied library`);
      employee.skill_context = ""; // models cannot supply privileged skill instructions
    }
    const brief = payload.team_brief;
    if (typeof brief !== "string" || !brief.trim() || [...brief].length > 16000) {
      throw new PlanProblem("team_brief must contain the shared project agreement (at most 16000 characters)");
    }
    // Asked once, in the correction round: a team that must stay with one provider is then kept as is.
    const used = new Set(employees.map((e) => vendor(byId.get(e.model_id)!)));
    const reason = typeof payload.single_model_reason === "string" ? payload.single_model_reason.trim() : "";
    if (asked === 1 && !reason && employees.length >= SPREAD_CHECK_MIN_EMPLOYEES && used.size === 1 && vendors.size > 1) {
      throw new PlanProblem(`all ${employees.length} employees use ${[...used][0]}: spread them over suitable models of `
        + "other providers, with verification on a different provider than the work it checks, or give single_model_reason");
    }
    const plan = TaskPlanSchema.parse({ summary: "", nodes: [], employees, team_brief: brief.trim() });
    refreshSkills(plan, library);
    return plan;
  };
  return ask(say, prompt, read);
}

/** Validate a proposed child graph on a copy; publish all children or nothing. */
export async function delegate(run: ExecutionRun, parent: TaskNode, payload: Record<string, any>, models: ModelProfile[], configured: Set<string>,
  needsVision = false): Promise<TaskNode[]> {
  if (!run.plan.employees.length || !member(run.plan, parent.employee_id)) throw new PlanProblem("delegation requires an assigned project employee");
  const requestId = payload.request_id;
  if (typeof requestId !== "string" || !(requestId.trim().length >= 1 && requestId.trim().length <= 80)) throw new PlanProblem("delegation needs a stable request_id");
  const fingerprint = digest(payload);
  const existing = run.plan.nodes.filter((n) => n.delegation_parent_id === parent.id && n.delegation_request_id === requestId);
  if (existing.length) {
    if (existing.some((n) => n.delegation_payload_hash !== fingerprint)) throw new PlanProblem("request_id was already used for a different delegation");
    return existing;
  }
  if (ancestors(run.plan, parent).length >= settings.team_max_delegation_depth) throw new PlanProblem("delegation depth limit reached; finish locally or ask the lead to replan");
  const previous = new Set(run.plan.nodes.filter((n) => n.delegation_parent_id === parent.id).map((n) => n.delegation_request_id));
  if (previous.size >= settings.team_max_delegations) throw new PlanProblem("delegation limit reached; ask the lead to replan");
  const raw = payload.tasks;
  if (!Array.isArray(raw) || !(raw.length >= 1 && raw.length <= 3) || run.plan.nodes.length + raw.length > MAX_TASKS) {
    throw new PlanProblem("delegate 1-3 bounded tasks within the project task limit");
  }
  const candidate: TaskPlan = structuredClone(run.plan);
  const copiedParent = candidate.nodes.find((n) => n.id === parent.id)!;
  const completed = new Set(candidate.nodes.filter((n) => n.status === "succeeded").map((n) => n.id));
  const keys = new Map<string, string>();
  const added: TaskNode[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new TypeError("each delegated task must be an object");
    const key = item.key;
    if (typeof key !== "string" || !key || keys.has(key) || candidate.nodes.some((n) => n.id === key)) throw new PlanProblem("each delegated task needs a unique key");
    const deps = "dependencies" in item ? item.dependencies : [];
    if (!Array.isArray(deps) || deps.some((d) => typeof d !== "string" || (!keys.has(d) && !completed.has(d)))) {
      throw new PlanProblem("child dependencies may name only earlier children or accepted deliveries");
    }
    const resolved = deps.map((d: string) => keys.get(d) ?? d);
    const verifies = "verifies" in item ? item.verifies : [];
    if (!Array.isArray(verifies) || verifies.some((v) => !deps.includes(v))) throw new PlanProblem("verifies must name child dependencies");
    const child = taskNode(item, key, [...new Set([...parent.dependencies, ...resolved])], verifies.map((d: string) => keys.get(d) ?? d));
    if (!child.instructions || !child.acceptance_criteria) throw new PlanProblem("delegated work needs concrete instructions and acceptance criteria");
    child.employee_id = item.employee_id ?? null;
    if (child.employee_id === parent.employee_id) throw new PlanProblem("delegate to another employee; continue your own work locally");
    child.needs_workspace = parent.needs_workspace;
    child.part_id = parent.part_id;
    child.delegation_parent_id = parent.id;
    child.delegation_request_id = requestId;
    child.delegation_payload_hash = fingerprint;
    for (const path of [...child.files, ...child.reads]) {
      if (path.startsWith("/") || path.split("/").includes("..") || path.includes("\\")) throw new PlanProblem("delegated paths must remain inside the project");
    }
    const problems = scopeProblems(TaskPlanSchema.parse({ summary: "", nodes: [child] }));
    if (problems.length) throw new PlanProblem(problems.join("; "));
    if (!child.employee_id) {
      const options: [number, number, string][] = [];
      for (const employee of candidate.employees) {
        if (employee.id === parent.employee_id) continue;
        const probe: TaskNode = { ...child, employee_id: employee.id };
        try {
          await route(probe, candidate, models, configured, needsVision);
          const load = candidate.nodes.filter((n) => n.employee_id === employee.id && (n.status === "running" || n.status === "pending")).length;
          options.push([load, probe.estimated_cost_usd, employee.id]);
        } catch (error) {
          if (!(error instanceof NoEligibleModelError)) throw error;
        }
      }
      if (!options.length) throw new PlanProblem("no other employee has the required capability and available model");
      child.employee_id = minBy(options, (option) => option)[2];
    }
    try {
      await route(child, candidate, models, configured, needsVision);
    } catch (error) {
      if (error instanceof NoEligibleModelError) throw new PlanProblem(error.message);
      throw error;
    }
    keys.set(key, child.id);
    candidate.nodes.push(child);
    added.push(child);
  }
  copiedParent.dependencies = [...new Set([...parent.dependencies, ...added.map((n) => n.id)])];
  checkAcyclic(candidate.nodes);
  contracts.validate(candidate, { partial: true });
  run.plan = candidate;
  return added;
}
