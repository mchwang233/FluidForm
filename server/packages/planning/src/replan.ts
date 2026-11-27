// Changing a running task's plan at its lead's decision: adding steps, removing or rewriting
// steps that have not finished. Finished steps never change. Throws PlanError with what is wrong, so the
// lead can be asked again.
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type ArtifactWaiver, ArtifactWaiverSchema, contracts, type ExecutionRun, folderId, head, type ModelProfile, newId, NoEligibleModelError,
  pricing, pyDumps, pyStr, routeNode, settings, type TaskNode, TaskNodeSchema, team, truthy
} from "../../../src/extension-api.js";
import { MAX_TASKS } from "./lead-planning.js";
import { difficulty, packageOf } from "./planner.js";

/** A plan change that cannot be made, and why. */
export class PlanError extends Error {
  override name = "PlanError";
}

export const CAPABILITIES = new Set(["coding", "planning", "research", "chinese", "tool_use", "structured_output"]);
// Steps that may not be removed or rewritten: their work is done or under way.
const SETTLED = new Set(["succeeded", "running"]);
type Json = Record<string, any>;

/** Apply ``change`` ({add, remove, update}) to ``run``'s plan in place. ``deciding`` is the step the
 *  decision is about, which may be changed although it is held as running. Returns the titles added,
 *  removed and updated. */
export async function changePlan(run: ExecutionRun, change: Json, models: ModelProfile[], configured: Set<string>, needsVision = false,
  deciding: string | null = null): Promise<{ added: string[]; removed: string[]; updated: string[] }> {
  // Validate on copies: a rejected edit must not partially mutate the active plan.
  const nodes = new Map(run.plan.nodes.map((item) => [item.id, structuredClone(item)]));
  const changeable = (nodeId: string, what: string): TaskNode => {
    const item = nodes.get(nodeId);
    if (!item) throw new PlanError(`${what}: no step with id ${nodeId}`);
    if (SETTLED.has(item.status) && item.id !== deciding) throw new PlanError(`${what}: step ${nodeId} (${item.title}) is ${item.status}; finished or running steps stay`);
    return item;
  };
  const waivers = waive(run, change, [...nodes.values()]);
  // What the user took out of the delivery leaves the contracts of steps not yet finished; finished
  // steps keep theirs, and contracts.accepted leaves the waived artifacts out of their checks.
  const paths = new Set([...run.plan.artifact_waivers, ...waivers].map((item) => item.path));
  const narrowedIds = new Set<string>();
  for (const item of nodes.values()) {
    if (item.status === "succeeded" || !contracts.touches(item, paths)) continue;
    item.artifact_contract = contracts.narrowed(item.artifact_contract!, paths);
    for (const path of paths) {
      delete item.artifact_inputs[path];
      delete item.artifact_baseline[path];
    }
    narrowedIds.add(item.id);
  }
  const removed = ((change.remove || []) as unknown[]).map((item) => changeable(pyStr(item), "remove"));
  if (removed.some((item) => item.artifact_contract)) throw new PlanError("artifact contract steps cannot be removed to bypass delivery or stop limits");
  if (removed.some((item) => item.delegation_parent_id || [...nodes.values()].some((child) => child.delegation_parent_id === item.id))) {
    throw new PlanError("delegated work must retain its parent and audit history; update it instead of removing it");
  }
  const gone = new Set(removed.map((item) => item.id));
  const add = change.add || [];
  if (!Array.isArray(add)) throw new PlanError("add must be a list of steps");
  const keys = new Map<string, string>();
  for (const raw of add) {
    const key = pyStr(raw.key || "").trim();
    if (!key || keys.has(key) || nodes.has(key)) throw new PlanError(`every added step needs its own key (got ${pyStr([key]).slice(1, -1)})`);
    keys.set(key, newId(8));
  }
  const resolve = (items: unknown, what: string): string[] => {
    if (!Array.isArray(items)) throw new PlanError(`${what} must be a list`);
    return items.map(pyStr).map((item) => {
      const target = keys.get(item) || (nodes.has(item) && !gone.has(item) ? item : null);
      if (target === null) throw new PlanError(`${what}: unknown or removed step ${item}`);
      return target;
    });
  };
  const workspace = run.plan.nodes.some((item) => item.needs_workspace);
  const parts = new Set(run.plan.parts.map((part) => part.id));
  // An added step joins the part it names, or the part of the step the decision is about.
  const defaultPart = deciding && nodes.has(deciding) ? nodes.get(deciding)!.part_id : null;
  const added: TaskNode[] = [];
  for (const raw of add) {
    const capability = raw.capability ?? "coding";
    if (!CAPABILITIES.has(capability)) throw new PlanError(`step ${pyStr(raw.key)}: unsupported capability ${pyStr(capability)}`);
    const instructions = pyStr(raw.instructions || "").trim();
    if (!instructions) throw new PlanError(`step ${pyStr(raw.key)} needs instructions`);
    added.push(TaskNodeSchema.parse({
      id: keys.get(pyStr(raw.key).trim()), title: head(pyStr(raw.title || raw.key), 120), instructions, capability, employee_id: raw.employee_id ?? null,
      acceptance_criteria: head(pyStr(raw.acceptance_criteria || "").trim(), 1000),
      dependencies: resolve(raw.dependencies || [], `step ${pyStr(raw.key)} dependencies`), verifies: resolve(raw.verifies || [], `step ${pyStr(raw.key)} verifies`),
      needs_workspace: workspace, ...difficulty(raw), ...packageOf(raw), ...contracts.declarations(raw),
      part_id: parts.has(pyStr(raw.part ?? null)) ? pyStr(raw.part) : defaultPart,
    }));
  }
  const updated: TaskNode[] = [];
  for (const raw of change.update || []) {
    const item = changeable(pyStr(raw.id ?? null), "update");
    if (gone.has(item.id)) throw new PlanError(`update: step ${item.id} is also removed`);
    if (item.artifact_contract) {
      if ("artifact_contract" in raw && pyDumps(raw.artifact_contract, false, true) !== pyDumps(item.artifact_contract, false, true)) {
        throw new PlanError("artifact contracts and stop limits cannot be weakened by replanning");
      }
      // The user narrowing the delivery is the one thing that may restate what this step must meet.
      if ("acceptance_criteria" in raw && raw.acceptance_criteria !== item.acceptance_criteria && !narrowedIds.has(item.id)) {
        throw new PlanError("artifact acceptance criteria must be preserved");
      }
    } else if ("artifact_contract" in raw) {
      item.artifact_contract = (contracts.declarations(raw) as Json).artifact_contract;
    }
    if ("employee_id" in raw) {
      item.employee_id = raw.employee_id;
      item.model_id = null;
    }
    for (const field of ["title", "instructions", "acceptance_criteria"] as const) {
      if (truthy(raw[field])) item[field] = head(pyStr(raw[field]).trim(), field === "title" ? 120 : 20_000);
    }
    for (const [field, value] of Object.entries(packageOf(raw))) if (field in raw) (item as Json)[field] = value;
    if ("dependencies" in raw) item.dependencies = resolve(raw.dependencies, `step ${item.id} dependencies`);
    updated.push(item);
  }
  const remaining = [...[...nodes.values()].filter((item) => !gone.has(item.id)), ...added];
  if (remaining.length > MAX_TASKS) throw new PlanError(`a plan may have at most ${MAX_TASKS} steps`);
  for (const item of remaining) {
    item.dependencies = item.dependencies.filter((id) => !gone.has(id));
    item.verifies = item.verifies.filter((id) => !gone.has(id));
  }
  checkAcyclic(remaining);
  const artifactWaivers = [...run.plan.artifact_waivers, ...waivers];
  try {
    contracts.validate({ ...run.plan, nodes: remaining, artifact_waivers: artifactWaivers }, { partial: true });
  } catch (error) {
    if (error instanceof contracts.ContractError) throw new PlanError(error.message);
    throw error;
  }
  const folder = run.project_dir || join(settings.workspace_root, folderId(run));
  const problems = contracts.unwrittenScripts({ ...run.plan, nodes: remaining }, (name) => existsSync(join(folder, name)));
  if (problems.length) throw new PlanError(problems.join("; "));
  for (const item of [...added, ...(run.plan.employees.length ? updated : [])]) {
    try {
      if (run.plan.employees.length) {
        if (!item.employee_id) item.employee_id = run.plan.parts.find((p) => p.id === item.part_id)?.employee_id ?? null;
        await team.route(item, run.plan, models, configured, needsVision);
      } else await routeNode(item, models, configured, needsVision);
    } catch (error) {
      if (error instanceof NoEligibleModelError) throw new PlanError(`no model can take step ${item.title}: ${error.message}`);
      throw error;
    }
  }
  run.plan.nodes = remaining;
  run.plan.artifact_waivers = artifactWaivers;
  await pricing.reestimate(run);
  return { added: added.map((item) => item.title), removed: removed.map((item) => item.title), updated: updated.map((item) => item.title) };
}

/** The artifacts ``change.waive`` takes out of the delivery ({path, reason} or a path), each bound
 *  to the question the user answered (``change.diagnosis_id``, else the latest answered one). Only
 *  the user can narrow a delivery: without an answer the contracts stay as they are. */
export function waive(run: ExecutionRun, change: Json, nodes: TaskNode[]): ArtifactWaiver[] {
  const asked = change.waive ?? [];
  if (!Array.isArray(asked)) throw new PlanError("waive must be a list of artifacts");
  if (!asked.length) return [];
  const answered = run.diagnoses.filter((item) => item.question && item.messages.some((message) => message.text.trim() || message.choice));
  const wanted = change.diagnosis_id ? pyStr(change.diagnosis_id) : null;
  const answer = wanted ? answered.find((item) => item.id === wanted) : answered.at(-1);
  if (!answer) {
    throw new PlanError("waive: only the user can take an artifact out of the delivery; ask_user first, then replan with their answer");
  }
  const declared = new Set(nodes.flatMap((item) => item.artifact_contract ? [...item.artifact_contract.inputs, ...item.artifact_contract.outputs].map((artifact) => artifact.path) : []));
  const already = new Set(run.plan.artifact_waivers.map((item) => item.path));
  const found: ArtifactWaiver[] = [];
  for (const raw of asked) {
    const path = pyStr(typeof raw === "string" ? raw : raw?.path ?? "").trim();
    if (!declared.has(path)) throw new PlanError(`waive: ${path || "(empty)"} is not an artifact declared in the plan`);
    if (already.has(path)) continue;
    already.add(path);
    const reason = head(pyStr(typeof raw === "string" ? "" : raw.reason ?? "").trim(), 1000);
    found.push(ArtifactWaiverSchema.parse({ path, reason, diagnosis_id: answer.id }));
  }
  return found;
}

export function checkAcyclic(nodes: TaskNode[]): void {
  const ids = new Set(nodes.map((item) => item.id));
  const waiting = new Map(nodes.map((item) => [item.id, new Set(item.dependencies.filter((dep) => ids.has(dep)))]));
  for (const item of nodes) if (item.dependencies.some((dep) => !ids.has(dep))) throw new PlanError(`step ${item.id} depends on a step that is not in the plan`);
  while (waiting.size) {
    const ready = [...waiting].filter(([, deps]) => !deps.size).map(([id]) => id);
    if (!ready.length) throw new PlanError("the changed plan has a dependency cycle");
    for (const id of ready) waiting.delete(id);
    for (const deps of waiting.values()) for (const id of ready) deps.delete(id);
  }
}
