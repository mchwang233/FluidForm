// Changing a running task's plan at its lead's decision: adding steps, removing or rewriting
// steps that have not finished. Finished steps never change. Throws PlanError with what is wrong, so the
// lead can be asked again.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { settings } from "../../../src/config.js";
import * as contracts from "../../../src/contracts.js";
import { newId } from "../../../src/lax.js";
import { MAX_TASKS } from "./lead-planning.js";
import { type ExecutionRun, folderId, type ModelProfile, type TaskNode, TaskNodeSchema } from "../../../src/models.js";
import { difficulty, packageOf } from "./planner.js";
import { head, pyDumps, pyStr, truthy } from "../../../src/py.js";
import { NoEligibleModelError, routeNode } from "../../../src/routing.js";
import * as pricing from "../../../src/pricing.js";
import * as team from "../../../src/team.js";

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
      if ("acceptance_criteria" in raw && raw.acceptance_criteria !== item.acceptance_criteria) throw new PlanError("artifact acceptance criteria must be preserved");
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
  try {
    contracts.validate({ ...run.plan, nodes: remaining }, { partial: true });
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
  await pricing.reestimate(run);
  return { added: added.map((item) => item.title), removed: removed.map((item) => item.title), updated: updated.map((item) => item.title) };
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
