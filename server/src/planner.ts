// Planning a request: the task's lead plans it as tasks in a conversation it keeps
// (task-planning.ts, supervisor.ts); with no lead model, the best planner plans it in one call; with no
// planner at all, a fixed fallback plan.
import { uses } from "./features.js";
import { randomUUID } from "node:crypto";
import * as pricing from "./pricing.js";
import { settings } from "./config.js";
import * as contracts from "./contracts.js";
import { log } from "./log.js";
import { difficultyFor, toPercentScale } from "./model-hooks.js";
import { DIFFICULTY_THRESHOLDS, type ModelProfile, type PlanChoice, PlanChoiceSchema, routingReady, type SupervisorSession,
  SupervisorSessionSchema, type TaskNode, TaskNodeSchema, type TaskPlan, TaskPlanSchema } from "./models.js";
import type { ProviderResult } from "./providers.js";
import { head, minBy, pyFloat2, pyInt, pyRegex, pyRound, pySplit, pyStr, truthy } from "./py.js";
import { ModelUnavailable } from "./quota.js";
import * as supervisor from "./supervisor.js";
import * as team from "./team.js";
import { form } from "./team-planning.js";

type Json = Record<string, any>;
const shortId = () => randomUUID().slice(0, 8);

/** Python's ValueError in planning: a plan that is not what was asked for, and why. */
export class PlanProblem extends Error {
  override name = "ValueError";
}

/** dict.get on a value from a model's JSON: AttributeError (not retried) when it is not an object. */
export function get(raw: unknown, key: string, fallback: unknown = undefined): any {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw Object.assign(new Error(`'${Array.isArray(raw) ? "list" : raw === null ? "NoneType" : typeof raw}' object has no attribute 'get'`),
      { name: "AttributeError" });
  }
  return key in (raw as Json) ? (raw as Json)[key] : fallback;
}

function node(title: string, instructions: string, capability: string, dependencies: string[] = [], needsWorkspace = false, difficulty = "normal",
  acceptance = "", verifies: string[] = []): TaskNode {
  return TaskNodeSchema.parse({ id: shortId(), title, instructions, capability, dependencies, needs_workspace: needsWorkspace, difficulty,
    quality_threshold: DIFFICULTY_THRESHOLDS[difficulty], acceptance_criteria: acceptance, verifies });
}

/** Deterministic fallback planner. */
export function heuristicPlan(prompt: string, inProject = false): TaskPlan {
  const lower = prompt.toLowerCase();
  const isCode = ["code", "bug", "repo", "implement", "代码", "修复", "实现"].some((word) => lower.includes(word));
  const isResearch = ["research", "source", "compare", "调研", "资料", "对比"].some((word) => lower.includes(word));
  const nodes: TaskNode[] = [];
  if (isResearch) {
    nodes.push(node("Research", `Collect reliable evidence for: ${prompt}`, "research", [], false, "normal",
      "Cites concrete sources or evidence for each finding; covers the question asked."));
  }
  if (isCode) {
    const inspect = node("Inspect workspace", `Inspect the current project and identify changes for: ${prompt}`, "planning", [], inProject, "normal",
      "Names the files and changes needed, grounded in the actual project.");
    const implement = node("Implement", `Implement the requested change: ${prompt}`, "coding", [inspect.id], inProject, "hard",
      "The requested change is implemented in the files, not just described.");
    const verify = node("Verify", "Review the implementation and report validation results.", "coding", [implement.id], inProject, "normal", "", [implement.id]);
    nodes.push(inspect, implement, verify);
  }
  if (!nodes.length) nodes.push(node("Analyze", prompt, "planning"));
  const dependencies = nodes.map((item) => item.id);
  nodes.push(node("Synthesize result", "Combine all completed work into a concise final answer.", "structured_output", dependencies, false, "easy"));
  return TaskPlanSchema.parse({ summary: head(pySplit(prompt).join(" "), 180), nodes });
}

// How tasks are rated and scoped; the flat planner and the lead (task-planning.ts) both give these rules.
// Said to the lead in every plan: independent deliverables run side by side, and open scope decisions
// that change the work a lot are listed for the user to see before confirming.
export const INDEPENDENT_RULE = "Several independent deliverables (modules, components, services) each get their own line of "
  + "tasks (build, then verify) running alongside the others, joined only where results must come "
  + "together (an integration test, a combined report). Never put several independent deliverables "
  + "into one task per stage, such as one task building all of them and another verifying all of them.\n";
export const CHOICES_RULE = "In \"choices\" list each scope decision the request leaves open that changes the work a lot, "
  + "such as a full protocol versus its lite subset, or what to do if a hard target (100% coverage, "
  + "a performance figure) proves unreachable: the question, what you assumed and the main "
  + "alternative, in the user's language. The user sees them before confirming the plan. Assume the "
  + "reading that best fits the request; list only decisions that change the work a lot, at most "
  + "five; [] when there are none.\n";
export const CHOICES_SHAPE = '"choices":[{"question":"...","assumed":"...","alternative":"..."}]';

/** The open scope decisions of a planner's JSON (CHOICES_RULE); malformed ones are dropped. */
export function planChoices(payload: Json): PlanChoice[] {
  const found: PlanChoice[] = [];
  const items = get(payload, "choices");
  for (const item of truthy(items) ? items : []) {
    if (item && typeof item === "object" && !Array.isArray(item) && ["question", "assumed"].every((key) => pyStr(item[key] || "").trim())) {
      found.push(PlanChoiceSchema.parse(Object.fromEntries(["question", "assumed", "alternative"].map((key) => [key, head(pyStr(item[key] || "").trim(), 400)]))));
    }
  }
  return found.slice(0, 5);
}

export const WORK_RULES = `Rate each task's difficulty for the model that will do it:
- easy: routine, well-specified work (formatting, summarising given results, small edits).
- normal: ordinary analysis, research or implementation with clear requirements.
- hard: open-ended design, subtle debugging, complex multi-file changes, deep reasoning.
Easy and normal tasks go to the cheapest capable model; hard tasks go to the strongest one.
Every task's result is checked against its acceptance_criteria by another model and retried
if it fails, so make the criteria concrete and checkable. A verification task lists in
"verifies" the keys of the tasks it checks (they must also be in its dependencies); if it
finds problems, those tasks are redone with its findings.
What executors can do: membership CLIs (Codex, Claude Code) and API models with tools edit files
and run shell commands in a sandbox. It can write only the task's working directory and /tmp; the
rest of the system is read-only; there is no root or sudo, so system packages cannot be installed;
the tools installed on this machine for every step are on PATH. It reaches the internet only if
the request says the task allows it, and then it can download packages into the working directory
and call external services. So steps can build, run tests, simulations and scripts with what is
installed. Keep acceptance criteria within these limits, and name the tools the task needs so they
are checked before it starts.
Work that produces files (code, tests, documents) is planned as small work packages, not areas of
work, in a new task as much as in an existing project. Each task that writes files lists in "files"
the 1-5 files it creates or changes and in "reads" up to 8 more files it must read
for reference: in a project, by their paths in the brief given below; in a new task, by the file
names you choose for it. Its model is given only these files, not the rest, so they must be enough
for the job.
"provides" says what later tasks can rely on: function names and signatures, endpoints and their
fields, CSS classes, commands. "check" is one command that shows the package works (a test or a
script). A package should take a capable model about 10-15 tool turns; split anything larger,
for example one package per component, endpoint or screen. Tasks whose "files" do not overlap
run at the same time, so packages that touch different files also finish sooner. A verification
task lists the files it checks in "reads". Tasks that write no files (research, review, a final
summary) leave "files" empty.
Set needs_workspace to true only for tasks that must read or modify files in the target project.
Set needs_images to true only for tasks that must make pictures (a photo, an illustration, an avatar, a
poster), which an image model draws; not for charts or diagrams drawn with code.
Token estimates must include expected dependency results and the files given.
` + contracts.RULES;

export const PLANNER_PROMPT = `You are the planning engine for an autonomous multi-model executor.
Decompose the user request into a small, executable DAG of tasks (nodes). Return JSON only, with this shape:
{
  "summary": "short objective",
  "nodes": [
    {
      "key": "n1",
      "title": "short title",
      "instructions": "self-contained execution instructions and acceptance criteria",
      "capability": "coding|planning|research|chinese|tool_use|structured_output",
      "dependencies": [],
      "estimated_input_tokens": 1500,
      "estimated_output_tokens": 800,
      "difficulty": "easy|normal|hard",
      "acceptance_criteria": "checkable conditions a reviewer uses to accept the result",
      "verifies": [],
      "needs_workspace": false,
      "needs_images": false,
      "files": ["files this node creates or changes"],
      "reads": ["files it must read for reference"],
      "provides": "what later nodes can rely on",
      "check": "one command that shows it works"
    }
  ]
}
` + WORK_RULES + `Use 2-30 nodes. Dependencies reference earlier node keys only. Parallelize independent work.
Include verification and final synthesis nodes when appropriate. Never include markdown fences.

User request:
`;
export const MAX_NODES = 30;
// A work package's scope (see the prompt above).
export const MAX_SCOPE_FILES = 5;
export const MAX_READ_FILES = 8;

export async function selectPlannerModel(models: ModelProfile[], configured: Set<string>): Promise<ModelProfile | null> {
  const found = models.filter((model) => model.enabled && routingReady(model) && configured.has(model.id));
  const rates = await pricing.rates(found);
  return minBy<ModelProfile | null>(found, (model) => [-model!.scores!.planning, -model!.scores!.reliability, model!.execution_priority,
    rates[model!.id] ?? 0], null);
}

const FENCES = pyRegex(String.raw`^` + "```" + String.raw`(?:json)?\s*|\s*` + "```" + "$", "ig");

/** The JSON object in a planner's reply; PlanProblem (or a JSON SyntaxError) when there is none. */
export function extractJson(given: string): any {
  let text = given.trim();
  if (text.startsWith("```")) text = text.replace(FENCES, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new PlanProblem("planner did not return a JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

/** Keys a verification node checks; only its own dependencies can be sent back. */
function verified(raw: Json, dependencies: unknown[]): string[] {
  const verifies = get(raw, "verifies");
  return Array.isArray(verifies) ? [...new Set(verifies)].filter((item) => dependencies.includes(item)) : [];
}

/** Difficulty and threshold for a planner node; a bare threshold (older prompt) still works. */
export function difficulty(raw: Json): { difficulty: string; quality_threshold: number } {
  const level = pyStr(get(raw, "difficulty", "")).trim().toLowerCase();
  if (level in DIFFICULTY_THRESHOLDS) return { difficulty: level, quality_threshold: DIFFICULTY_THRESHOLDS[level] };
  const threshold = Math.max(50, Math.min(toPercentScale(pyFloat2(get(raw, "quality_threshold", 80))), 99));
  return { difficulty: difficultyFor(threshold), quality_threshold: threshold };
}

export function validatePlan(payload: Json, minimumNodes = 2): TaskPlan {
  const rawNodes = get(payload, "nodes");
  if (!Array.isArray(rawNodes) || !(minimumNodes <= rawNodes.length && rawNodes.length <= MAX_NODES)) {
    throw new PlanProblem(`planner must return ${minimumNodes}-${MAX_NODES} nodes`);
  }
  const keyToId = new Map<string, string>();
  const nodes: TaskNode[] = [];
  rawNodes.forEach((raw, index) => {
    const key = pyStr(get(raw, "key", `n${index + 1}`));
    if (keyToId.has(key)) throw new PlanProblem(`duplicate planner node key: ${key}`);
    const dependencies = get(raw, "dependencies", []);
    if (!Array.isArray(dependencies) || dependencies.some((dep) => typeof dep !== "string" || !keyToId.has(dep))) {
      throw new PlanProblem(`node ${key} has a forward or unknown dependency`);
    }
    const made = taskNode(raw, key, dependencies.map((dep: string) => keyToId.get(dep)!), verified(raw, dependencies).map((item) => keyToId.get(item)!));
    keyToId.set(key, made.id);
    nodes.push(made);
  });
  if (nodes.some((item) => !item.instructions)) throw new PlanProblem("every planner node needs instructions");
  const plan = TaskPlanSchema.parse({ summary: head(pyStr(get(payload, "summary", "Autonomous task plan")), 240), nodes });
  contracts.validate(plan);
  return plan;
}

export const CAPABILITIES = new Set(["coding", "planning", "research", "chinese", "tool_use", "structured_output"]);
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));

/** A step from a planner's (or lead's) JSON task, with its dependencies already resolved. */
export function taskNode(raw: Json, key: string, dependencies: string[], verifies: string[]): TaskNode {
  const capability = get(raw, "capability", "planning");
  if (!CAPABILITIES.has(capability)) throw new PlanProblem(`node ${key} has unsupported capability: ${pyStr(capability)}`);
  return TaskNodeSchema.parse({
    id: shortId(), title: head(pyStr(get(raw, "title", key)), 120), instructions: pyStr(get(raw, "instructions", "")).trim(), capability,
    employee_id: get(raw, "employee_id", null), dependencies,
    estimated_input_tokens: clamp(pyInt(get(raw, "estimated_input_tokens", 1500)), 100, 1_000_000),
    estimated_output_tokens: clamp(pyInt(get(raw, "estimated_output_tokens", 800)), 50, 128_000),
    ...difficulty(raw), acceptance_criteria: head(pyStr(get(raw, "acceptance_criteria", "")).trim(), 1000), verifies,
    needs_workspace: get(raw, "needs_workspace") === true, needs_images: get(raw, "needs_images") === true, ...packageOf(raw), ...contracts.declarations(raw),
  });
}

function paths(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [];
  const cleaned = items.filter((item) => pyStr(item).trim()).map((item) => {
    const text = pyStr(item).trim();
    return text.startsWith("./") ? text.slice(2) : text;
  });
  return [...new Set(cleaned)].slice(0, 20);
}

/** Folders as "a/b/"; unsafe ones are dropped, which leaves the step the whole folder (scopes.ts). */
function folders(value: unknown): string[] {
  return paths(value).map((path) => path.replace(/\/+$/, "")).filter((name) => contracts.safeName(name)).map((name) => `${name}/`);
}

/** A node's work-package fields from a planner's (or lead's) JSON (Python's planner.package). */
export function packageOf(raw: Json): { files: string[]; reads: string[]; folders: string[]; provides: string; check: string } {
  return { files: paths(get(raw, "files")), reads: paths(get(raw, "reads")), folders: folders(get(raw, "folders")),
    provides: head(pyStr(get(raw, "provides") || "").trim(), 2000), check: head(pyStr(get(raw, "check") || "").trim(), 500) };
}

/** Whether a step produces files, and so must be a scoped work package: it works on the project, writes
 *  code, or names files it writes. */
export function writesFiles(item: TaskNode): boolean {
  return !item.verifies.length && (item.needs_workspace || item.capability === "coding" || item.files.length > 0);
}

/** Why some work packages of a plan are not small and scoped, to send back to the planner: a step that
 *  writes files must name them, few enough, and files rather than folders. */
export function scopeProblems(plan: TaskPlan): string[] {
  const problems: string[] = [];
  for (const item of plan.nodes) {
    if (!writesFiles(item)) continue;
    const broad = [...item.files, ...item.reads].filter((path) => path.endsWith("/") || path.includes("*") || path === "." || path === "");
    if (!item.files.length) problems.push(`${item.title}: lists no files; name the files it creates or changes`);
    else if (item.files.length > MAX_SCOPE_FILES) problems.push(`${item.title}: changes ${item.files.length} files; split it so each node changes at most ${MAX_SCOPE_FILES}`);
    if (item.reads.length > MAX_READ_FILES) problems.push(`${item.title}: reads ${item.reads.length} files; at most ${MAX_READ_FILES}, or split it`);
    if (broad.length) problems.push(`${item.title}: names folders or patterns (${broad.join(", ")}); name files`);
  }
  return problems;
}

// How hard it is to plan a request, the effort the lead plans it with, and how much longer than
// planning_call_timeout a call at that effort may take.
export const PLANNING_EFFORT: Record<string, string> = { easy: "low", normal: "medium", hard: "high", exceptional: "max" };
export const DIFFICULTY_LABELS: Record<string, string> = { easy: "容易", normal: "一般", hard: "困难", exceptional: "特别难" };
export const PLANNING_TIME: Record<string, number> = { low: 1, medium: 1, high: 2, max: 3 };
// Judging the difficulty means reading the whole request: low is too shallow to tell a hard task from
// an easy one, more is not needed for one word.
export const DIFFICULTY_EFFORT = "medium";
export const DIFFICULTY_PROMPT = `Before this request is planned, rate how hard it is to PLAN (not to carry out):
- easy: one clear deliverable, a few files, common tools, nothing to work out;
- normal: several connected parts with clear interfaces;
- hard: many interdependent parts, special tools (EDA, hardware, licences), strict verification
  or hand-offs between parts that must be designed;
- exceptional: an unclear approach, research or a large system, where a weak plan would waste most
  of the budget.
Reply with JSON only: {"difficulty": "easy|normal|hard|exceptional", "reason": "<one sentence>"}

Request:
`;

// Without step acceptance (settings.acceptance), verification steps would only cost time.
export const NO_ACCEPTANCE_NOTE = "\n\nPlatform note: results are not reviewed step by step; only the lead checks the whole result at "
  + "the end. Do not add separate verification, review or acceptance-checking tasks (leave verifies empty): "
  + "each task runs its own checks of its own deliverables as part of its work and reports what they "
  + "showed; checks that need a separate setup (a testbench, a regression, synthesis) belong to the "
  + "task that owns that work.";

export type Say = (text: string) => Promise<string>;

/** How hard ``request`` is to plan and why, judged quickly; hard when no answer is usable, so a failed
 *  judgement never makes the plan worse. */
export async function planningDifficulty(say: Say, request: string): Promise<[string, string]> {
  try {
    const data = extractJson(await say(DIFFICULTY_PROMPT + head(request, 20000)));
    const level = pyStr(get(data, "difficulty") || "").trim().toLowerCase();
    if (level in PLANNING_EFFORT) return [level, head(pyStr(get(data, "reason") || "").trim(), 300)];
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw error;
    log.warning(`planning difficulty not judged: ${(error as Error)?.message ?? error}`);
  }
  return ["hard", "难度判断没有得到有效回答，按困难处理"];
}

export type Planning = {
  converse(session: SupervisorSession, text: string, options?: { timeout?: number | null; signal?: AbortSignal }): Promise<ProviderResult>;
  complete(modelId: string, prompt: string, options?: Json): Promise<ProviderResult>;
};

const cost = (result: ProviderResult, model: ModelProfile) => pricing.charge(model, result.input_tokens, result.output_tokens, result.cached_input_tokens ?? 0);

class PlanningTimeout extends Error {
  override name = "TimeoutError";
}

/** The best lead plans the request as tasks in its own conversation (task-planning.ts), which
 *  ``session`` then holds. null if no lead can plan. */
async function planAsLead(request: string, models: ModelProfile[], configured: Set<string>, providers: Planning, session: SupervisorSession,
  inProject: boolean, teamRequest = "", artifactWork = false): Promise<TaskPlan | null> {
  const { planTasks } = await import("./task-planning.js");
  let spent = 0;
  let roster: TaskPlan | null = null;
  let planningEffort: string = settings.planning_reasoning_effort;
  let judged: [string, string] | null = null; // [difficulty, reason] once a lead has judged it
  for (const model of supervisor.candidates(models, configured).slice(0, supervisor.MAX_LEADS)) {
    const fresh = supervisor.newSession(model);
    const sayIn = (conversation: SupervisorSession, effort: string, stage: string): Say => async (text) => {
      const previous = conversation.reasoning_effort;
      conversation.reasoning_effort = effort || previous;
      const seconds = settings.planning_call_timeout * (PLANNING_TIME[conversation.reasoning_effort || settings.lead_reasoning_effort] ?? 1);
      try {
        log.info(`planning stage ${stage} on ${model.id} (effort=${conversation.reasoning_effort || settings.lead_reasoning_effort})`);
        let result: ProviderResult;
        if (seconds) {
          // The outer deadline also bounds API retries and queueing and providers that do not enforce
          // the CLI timeout. Cancellation finishes before fallback.
          const stop = new AbortController();
          let timer: NodeJS.Timeout | undefined;
          try {
            result = await Promise.race([providers.converse(conversation, text, { timeout: seconds, signal: stop.signal }),
              new Promise<never>((_, fail) => {
                timer = setTimeout(() => {
                  stop.abort(new PlanningTimeout(`${stage} exceeded ${seconds}s`));
                  fail(new PlanningTimeout(`${stage} exceeded ${seconds}s`));
                }, seconds * 1000);
              })]);
          } finally {
            clearTimeout(timer);
          }
        } else result = await providers.converse(conversation, text);
        spent += await cost(result, model);
        return result.text;
      } finally {
        conversation.reasoning_effort = previous;
      }
    };
    if (planningEffort === "auto" && judged === null) {
      // In a conversation of its own, so the plan's conversation starts with the plan.
      judged = await planningDifficulty(sayIn(supervisor.newSession(model), DIFFICULTY_EFFORT, "difficulty"), teamRequest || request);
      planningEffort = PLANNING_EFFORT[judged[0]];
      log.info(`planning difficulty ${judged[0]}: effort ${planningEffort} (${judged[1]})`);
    }
    let plan: TaskPlan;
    let concurrency: string;
    try {
      // A valid team is a completed decision. An outline timeout or model switch must not discard it,
      // spend another staffing call or change employee identities.
      if (uses.team() && roster === null) {
        // Staffing is part of planning: with "auto", at the effort the difficulty calls for.
        const teamEffort = settings.team_reasoning_effort === "auto" ? planningEffort : settings.team_reasoning_effort;
        roster = await form(sayIn(fresh, teamEffort, "team"), teamRequest || request, models, configured);
      }
      const opening = supervisor.ROLE + request + (roster ? team.assignmentPrompt(roster) : "");
      plan = await planTasks(sayIn(fresh, planningEffort, "tasks"), opening, roster, artifactWork, inProject);
      concurrency = plan.planning_note ?? "";
    } catch (error) {
      if ((error as Error)?.name === "AbortError") throw error;
      // The next lead tries; with none left, the usual single-call planner does.
      log.warning(`lead ${model.id} could not plan: ${(error as Error)?.message ?? error}`);
      continue;
    }
    Object.assign(session, fresh);
    plan.in_project = inProject;
    plan.planning_method = "model";
    plan.planner_model_id = model.id;
    plan.planning_cost_usd = pyRound(spent, 6);
    plan.planning_note = `负责人 ${model.display_name} 已明确 ${plan.nodes.length} 个任务的事项、依赖和验收条件；按依赖直接执行`
      + (plan.employees.length ? `；分配给 ${plan.employees.length} 名员工` : "") + (concurrency ? `；${concurrency}` : "");
    if (judged) plan.planning_note += `；规划难度${DIFFICULTY_LABELS[judged[0]]}，用 ${planningEffort} 强度规划` + (judged[1] ? `（${judged[1]}）` : "");
    return plan;
  }
  if (uses.team() && supervisor.candidates(models, configured).length) {
    throw new contracts.ContractError("负责人未能建立有效团队和分工；请调整可用模型后重新规划。");
  }
  return null;
}

/** Plan ``prompt``: the task's lead plans it as tasks (task-planning.ts), in a conversation that it keeps
 *  for the rest of the task (supervisor.ts); ``session``, if given, is filled in. With no lead model at
 *  all, the best planner plans in a single call. ``brief`` is the project brief (briefing.ts): with it
 *  the plan is cut into small work packages, each naming the files it needs. */
export async function autonomousPlan(prompt: string, models: ModelProfile[], given: Set<string>, providers: Planning,
  projectContext: string | null = null, session: SupervisorSession | null = null, brief: string | null = null): Promise<TaskPlan> {
  let configured = given;
  const inProject = projectContext !== null || brief !== null;
  let body = prompt + [projectContext, brief].filter(Boolean).map((part) => `\n\n${part}`).join("");
  if (!uses.review()) body += NO_ACCEPTANCE_NOTE;
  const request = PLANNER_PROMPT + body;
  const artifactWork = [...contracts.stages(TaskNodeSchema.parse({ id: "request", title: prompt, instructions: "", capability: "planning" }))]
    .some((stage) => stage === "coverage_vdb" || stage === "urg_report");
  const readPlan = (text: string) => {
    const candidate = validatePlan(extractJson(text));
    if (artifactWork && !candidate.nodes.some((item) => item.artifact_contract)) throw new contracts.ContractError("Requested artifact work has no declared artifact contracts");
    return candidate;
  };
  const { PROMPT } = await import("./task-planning.js");
  let plan = await planAsLead(PROMPT + body, models, configured, providers, session ?? SupervisorSessionSchema.parse({}), inProject, body, artifactWork);
  if (plan) {
    plan.request = body;
    return plan;
  }
  let planner = await selectPlannerModel(models, configured);
  if (planner === null || planner.provider === "mock") {
    if (artifactWork) throw new contracts.ContractError("Artifact planning blocked: no capable planner to declare evidence and limits");
    plan = heuristicPlan(prompt, inProject);
    plan.planning_note = "No capable configured planner; used deterministic fallback";
    return plan;
  }
  let planningCost = 0;
  const switched: string[] = [];
  try {
    let result: ProviderResult;
    for (;;) {
      try {
        result = await providers.complete(planner.id, request, { cli_timeout: 120 });
        break;
      } catch (error) {
        if (!(error instanceof ModelUnavailable)) throw error;
        // Out of quota: the next best planner takes over, up to a few.
        configured = new Set([...configured].filter((id) => id !== planner!.id));
        const backup = await selectPlannerModel(models, configured);
        if (backup === null || backup.provider === "mock" || switched.length >= 2) throw error;
        switched.push(planner.id);
        planner = backup;
      }
    }
    const chargedId = result.used_model_id || planner.id;
    const charged = models.find((item) => item.id === chargedId)!;
    planningCost = await cost(result, charged);
    try {
      plan = readPlan(result.text);
    } catch (error) {
      if (!(error instanceof contracts.ContractError)) throw error;
      try {
        const correction = await providers.complete(planner.id, request + "\nInvalid artifact plan: " + error.message + "\nReturn the whole corrected plan.", { cli_timeout: 120 });
        planningCost += await cost(correction, charged);
        plan = readPlan(correction.text);
      } catch (invalid) {
        throw new contracts.ContractError(`Artifact planning blocked: ${(invalid as Error)?.message ?? invalid}`);
      }
    }
    // Without a project every node runs in its own scratch workspace, so any model will do.
    if (!inProject) for (const item of plan.nodes) item.needs_workspace = false;
    plan.planning_method = "model";
    plan.planner_model_id = planner.id;
    plan.planning_cost_usd = pyRound(planningCost, 6);
    if (chargedId !== planner.id) plan.planning_note = `Planner CLI fell back to ${chargedId}`;
    if (switched.length) plan.planning_note = `${switched.join("、")} 暂不可用，改由 ${planner.id} 规划`;
    return plan;
  } catch (error) {
    // A generic fallback loses the required evidence and limits. Fail closed instead.
    if (error instanceof contracts.ContractError || (error as Error)?.name === "AbortError") throw error;
    if (artifactWork) throw new contracts.ContractError(`Artifact planning blocked: ${(error as Error)?.message ?? error}`);
    plan = heuristicPlan(prompt, inProject);
    plan.planner_model_id = planner!.id;
    plan.planning_cost_usd = pyRound(planningCost, 6);
    plan.planning_note = `Planner fallback: ${head(String((error as Error)?.message ?? error), 300)}`;
    return plan;
  }
}
