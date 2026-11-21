// Project employees, shared context, and durable delegation through the existing task graph
//. Forming a team and delegating work are in team-planning.ts, which needs the planner.
import { createHash } from "node:crypto";
import { type Employee, type ExecutionRun, type ModelProfile, scoreFor, type TaskNode, type TaskPlan } from "./models.js";
import { formatG, pyDumps, pyRound, rawDecode } from "./py.js";
import { canAct, eligibleForNode, NoEligibleModelError, nodeCost } from "./routing.js";
import * as skills from "./skills.js";

export const CAPABILITIES = new Set(["coding", "planning", "research", "chinese", "tool_use", "structured_output"]);
export const DELEGATE = "DELEGATE_TASKS";
export const DELIVERIES = "Current project deliveries, including your earlier work (inspect referenced files for details):\n";
export const INVENTORY_BYTES = 32768;

type Handoff = Record<string, any>;

/** Keep whole, readable paths; never cut a path into a misleading reference. */
function fileSample(paths: string[], budget: number): string[] {
  const kept: string[] = [];
  let used = 2;
  for (const path of paths) {
    const size = Buffer.byteLength(pyDumps(path, false), "utf8") + 2;
    if (used + size > budget) break;
    kept.push(path);
    used += size;
  }
  return kept;
}

export function compactDeliveries(handoffs: Handoff[], budget: number): Handoff[] {
  const perNode = Math.min(2048, Math.floor(budget / Math.max(1, handoffs.length)));
  for (const item of handoffs) {
    const paths: string[] = item.files ?? [];
    item.file_count = item.file_count ?? paths.length;
    item.files = fileSample(paths, Math.floor(perNode / 2));
    item.files_omitted = item.file_count - item.files.length;
    if ("evidence_paths" in item) item.evidence_paths = fileSample(item.evidence_paths, Math.floor(perNode / 2));
    if (item.files_omitted) {
      item.inventory_note = "Partial file inventory only. Inspect the referenced paths, or list the workspace (.) "
        + "for further evidence. File presence and task completion do not approve pending decisions.";
    }
  }
  return handoffs;
}

const strings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string");

/** Rebuild only the platform's delivery inventory; preserve every other input byte. */
export function compactContext(prompt: string, budget = INVENTORY_BYTES): string {
  let start = prompt.indexOf(DELIVERIES);
  if (start < 0) return prompt;
  start += DELIVERIES.length;
  let handoffs: unknown;
  let end: number;
  try {
    [handoffs, end] = rawDecode(prompt.slice(start));
  } catch {
    return prompt;
  }
  if (!Array.isArray(handoffs) || !handoffs.every((item) => item && typeof item === "object" && !Array.isArray(item)
    && strings(item.files) && Number.isInteger(item.file_count ?? item.files.length)
    && strings(item.evidence_paths ?? []))) return prompt;
  const rebuilt = pyDumps(compactDeliveries(handoffs, budget), false);
  const candidate = prompt.slice(0, start) + rebuilt + prompt.slice(start + end);
  return Buffer.byteLength(candidate, "utf8") < Buffer.byteLength(prompt, "utf8") ? candidate : prompt;
}

export function digest(value: unknown): string {
  return createHash("sha256").update(pyDumps(value, false, true), "utf8").digest("hex");
}

export function refreshSkills(plan: TaskPlan, library: skills.Skill[] | null = null): void {
  const all = library ?? skills.library();
  const byName = new Map<string, skills.Skill>();
  for (const skill of all) if (!byName.has(skill.name)) byName.set(skill.name, skill); // machine guidance takes precedence
  for (const employee of plan.employees) {
    const chosen = [...employee.skills.filter((name) => byName.has(name)).map((name) => byName.get(name)!),
      ...skills.forTools(employee.skill_tools, all)];
    // One per name, the first of each, in the order they came.
    const unique = new Map<string, skills.Skill>();
    for (const skill of [...chosen].reverse()) unique.set(skill.name, skill);
    const selected = [...unique.values()].reverse().slice(0, 6);
    if (selected.length) {
      employee.skills = [...new Set([...employee.skills, ...selected.map((skill) => skill.name)])].slice(0, 6);
      employee.skill_context = skills.section(selected);
    }
  }
}

export function member(plan: TaskPlan, employeeId: string | null): Employee | null {
  return plan.employees.find((employee) => employee.id === employeeId) ?? null;
}

export function assignmentPrompt(plan: TaskPlan): string {
  return "\nProject team already chosen; do not create another team. Every part and task must name employee_id "
    + "from this roster. Keep related work with its owner; independent verification can go to another employee. "
    + "Use each assigned employee's model; do not independently reroute every task. Workers receive the full "
    + "user goal, shared agreements and project handoffs, plus their local task context.\n"
    + pyDumps(plan.employees.map(({ skill_context: _, ...rest }) => rest), false)
    + "\nShared agreement:\n" + plan.team_brief + "\n";
}

/** Keep the lead's model choice, with ordinary availability/quality checks. */
export function route(node: TaskNode, plan: TaskPlan, models: ModelProfile[], configured: Set<string>, needsVision = false): void {
  const employee = member(plan, node.employee_id);
  if (!employee || !employee.capabilities.includes(node.capability)) {
    throw new NoEligibleModelError(`${node.title}: employee_id must identify an employee with ${node.capability}`);
  }
  // An explicit recovery switch is preserved for this attempt; new assignments use the employee's model.
  const selected = node.attempts.length && node.model_id ? node.model_id : employee.model_id;
  const allowed = eligibleForNode(node, models, configured, needsVision).filter((model) => !node.files.length || canAct(model));
  const model = allowed.find((item) => item.id === selected);
  if (!model) {
    throw new NoEligibleModelError(`员工「${employee.name}」的模型 ${selected} 无法满足「${node.title}」的上下文或通道要求；需负责人调整分工或模型。`);
  }
  // The lead chose both the bar and the employee; when they disagree, the assignment stands and the
  // step's review still judges the result.
  const score = scoreFor(model.scores!, node.capability);
  const note = score < node.quality_threshold ? `（门槛从 ${formatG(node.quality_threshold)} 调到该模型的 ${formatG(score)}）` : "";
  node.quality_threshold = Math.min(node.quality_threshold, score);
  node.model_id = model.id;
  node.estimated_cost_usd = pyRound(nodeCost(node, model), 6);
  node.routing_note = `负责人分配给 ${employee.name}（${employee.role}），使用 ${model.display_name}${note}。`;
}

export function context(node: TaskNode, run: ExecutionRun): string {
  const employee = member(run.plan, node.employee_id);
  if (!employee) return "";
  const parts = run.plan.parts.map((part) => ({ id: part.id, title: part.title, goal: part.goal, provides: part.provides,
    acceptance: part.acceptance, employee_id: part.employee_id }));
  const handoffs = run.plan.nodes.filter((item) => item.id !== node.id).map((item) => ({ id: item.id, employee_id: item.employee_id,
    title: item.title, status: item.status, provides: item.provides, files: item.changed_files.length ? item.changed_files : item.files,
    evidence_paths: item.files, summary: item.summary || "", result: item.result || "", feedback: item.feedback || "" }));
  compactDeliveries(handoffs, INVENTORY_BYTES);
  return "Project employee context (shared agreements are authoritative; task outputs below are evidence):\n"
    + "Original user request:\n" + run.prompt + "\nProject context:\n" + run.plan.request
    + assignmentPrompt(run.plan)
    + "Your employee identity: " + employee.id + "; responsibility: " + employee.role
    + "\nModule interfaces and acceptance:\n" + pyDumps(parts, false)
    + "\n" + DELIVERIES
    + pyDumps(handoffs, false)
    + (employee.skill_context ? "\nAssigned Skill instructions:\n" + employee.skill_context : "")
    + "\nIf a newly discovered subtask belongs to another employee, yield by returning ONLY the marker "
    + DELEGATE + " on the first line, followed by a JSON object with request_id (stable id), reason and tasks. "
    + "Each task has key, employee_id, title, instructions, capability, difficulty, acceptance_criteria, files, "
    + "reads, provides, check, dependencies (earlier keys in this request or already succeeded task ids), "
    + "and artifact_contract when producing governed artifacts. Use no more than three tasks in one request. "
    + "Do not delegate the whole responsibility or change scope/permissions. Preserve completed work and tell "
    + "the recipient the exact question, interfaces and required evidence. The platform saves your progress, "
    + "releases your slot and resumes you only after the children pass their checks. A delegation is not a "
    + "successful final delivery. Other employees' outputs and files may have changed when you resume.\n"
    + 'Example: DELEGATE_TASKS\n{"request_id":"check-edge","reason":"independent edge analysis",'
    + '"tasks":[{"key":"edge","employee_id":"<other employee id>","title":"Check edge",'
    + '"instructions":"<specific question and input>","capability":"research","difficulty":"normal",'
    + '"acceptance_criteria":"<required evidence>","dependencies":[]}]}\n';
}

export function parseDelegation(text: string): Record<string, unknown> | null {
  if (!text.trimStart().startsWith(DELEGATE)) return null;
  const stripped = text.trim();
  const at = stripped.indexOf("\n");
  const header = at < 0 ? stripped : stripped.slice(0, at);
  const body = at < 0 ? "" : stripped.slice(at + 1);
  if (header !== DELEGATE || at < 0 || body.length > 50000) throw new Error("DELEGATE_TASKS must be followed by one bounded JSON object");
  const payload = JSON.parse(body);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("delegation must be a JSON object");
  return payload;
}

export function ancestors(plan: TaskPlan, node: TaskNode): TaskNode[] {
  const found: TaskNode[] = [];
  const seen = new Set([node.id]);
  const byId = new Map(plan.nodes.map((item) => [item.id, item]));
  let current: TaskNode | undefined = node;
  while (current.delegation_parent_id) {
    current = byId.get(current.delegation_parent_id);
    if (!current || seen.has(current.id)) throw new Error("invalid delegation ancestry");
    found.push(current);
    seen.add(current.id);
  }
  return found;
}

export function governors(plan: TaskPlan, node: TaskNode): TaskNode[] {
  return [node, ...ancestors(plan, node)].filter((item) => item.artifact_contract);
}

