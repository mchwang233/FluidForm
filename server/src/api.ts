// What FluidForm's HTTP API works with: the database, the model
// catalog, the providers, the executor and the automations, and what the routes (app.ts) share:
// planning a task, starting a chat, and the answers the console reads.
import { uses } from "./features.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import * as files from "./attachments.js";
import { BenchmarkCatalog } from "./benchmarks.js";
import * as capabilities from "./capabilities.js";
import { CapabilityAutomations } from "./automations.js";
import { CatalogSync, seedCatalog } from "./catalog-sync.js";
import * as cliQuota from "./cli-quota.js";
import { settings } from "./config.js";
import { ContractError } from "./contracts.js";
import { Database } from "./db.js";
import { Executor } from "./executor.js";
import * as folders from "./folders.js";
import * as learning from "./learning.js";
import { log } from "./log.js";
import { imageServers } from "./mcp.js";
import { pyDumps, pyRound } from "./py.js";
import {
  type Attachment, type ExecutionRun, ExecutionRunSchema, EventSchema, FINISHED, folderId, type ModelProfile,
  type SupervisorSession, SupervisorSessionSchema, type TaskPlan, TaskNodeSchema, TaskPlanSchema,
} from "./models.js";
import { autonomousPlan, planningBrief, quick } from "./planning.js";
import { ProjectDirError, projectContext, resolveProjectDir } from "./projects.js";
import { ProviderRegistry } from "./providers.js";
import * as publish from "./publish.js";
import * as retrospect from "./retrospect.js";
import { briefWriter, fitAndRoute, NoEligibleModelError } from "./routing.js";
import * as pricing from "./pricing.js";
import { rescore } from "./scoring.js";
import { keepLoadingKeys, setProviderKey } from "./secrets.js";
import { cutOffSafely } from "./self-repair.js";
import * as supervisor from "./supervisor.js";
import * as bundled from "./bundled.js";
import { chosenFor, configuredFor } from "./model-choice.js";
import * as chat from "./chat.js";
import { ServiceHost } from "./services.js";
import { sleep, Task } from "./tasks.js";
import * as team from "./team.js";
import * as triage from "./triage.js";

export const INTERNET_NOTE = "(This task allows the internet: its steps' commands may download packages and call external services.)";

type Json = Record<string, any>;

/** An answer other than 2xx, as FastAPI's HTTPException gives it: ``{"detail": ...}``. */
export class HttpError extends Error {
  constructor(readonly status: number, readonly detail: unknown, readonly headers: Record<string, string> = {}) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
}

/** ``value`` as ``schema`` reads it, or 422 with FastAPI's list of what does not fit. */
export function parse<S extends z.ZodType>(schema: S, value: unknown, where = "body"): z.output<S> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new HttpError(422, result.error.issues.map((issue) => ({ type: issue.code, loc: [where, ...issue.path], msg: issue.message })));
  }
  return result.data;
}

const id = (max: number) => z.string().max(max);
const budget = (fallback: number) => z.number().gt(0).lte(10_000).default(fallback);

export const CreateTask = z.object({
  prompt: z.string().min(3),
  attachments: z.array(z.string()).default(() => []),
  budget_usd: budget(2),
  use_cli: z.boolean().default(true),
  // Only these models (empty: any), or only membership CLIs: the task keeps the choice.
  only_models: z.array(z.string().max(200)).max(20).default(() => []),
  cli_only: z.boolean().default(false),
  project_dir: id(4096).nullish().default(null),
  // Let the task's commands reach the internet (never this machine's local services).
  allow_network: z.boolean().default(false),
});
export type CreateTask = z.output<typeof CreateTask>;
export const StartRequest = CreateTask.extend({
  // The model to chat with, if it turns out to be a chat.
  model_id: id(200).nullish().default(null),
});

/** The routed and estimated plan of a request, and what it was made with. */
export type Made = { plan: TaskPlan; session: SupervisorSession; attached: Attachment[]; projectDir: string | null; background: string | null; lessons: Json[] };

// Said to the one step a task without the lead's plan gets: do what was asked, no more. A small game
// once came with two test suites, a headless demo and a README, and took six minutes, not one.
export const QUICK_SCOPE = "\n\n（这是一件小事：只做要求的。做完先自己运行或检查一次，能用就交付；"
  + "没要求的测试套件、演示脚本、说明文档都不用写。）";
export const SOLO_SCOPE = "\n\n（做到要求的程度为止：能用、自己检查过就交付；没要求的额外测试、演示和文档不用写。）";

export const MAX_BACKGROUND_FILES = 150;
export const MAX_BACKGROUND_RESULT = 3000;
export const MAX_EARLIER_BACKGROUND = 1500;
// Characters of a chat's title, from its first message.
export const CHAT_TITLE_CHARS = 60;
// Walking the home directory takes up to a few seconds, so reuse a recent scan.
export const DISCOVERY_TTL = 60;

/** A task cut off by a restart goes on by itself when resume_after_restart is on and it touches
 *  nobody's project and waits for nobody; otherwise it waits for the user. */
export function resumesByItself(run: ExecutionRun): boolean {
  return cutOffSafely(run) && !run.waiting_diagnosis_id && !run.maintenance_id && !run.engineer_job_id;
}

/** The user's answers to a plan's open choices, said to the lead; "" when every answer is what the
 *  lead had assumed (nothing to plan again). */
export function decidedChoices(choices: { question: string; assumed: string; alternative?: string | null }[], picks: string[]): string {
  const lines: string[] = [];
  let changed = false;
  choices.forEach((choice, index) => {
    if (index >= picks.length) return;
    const pick = picks[index].trim();
    let answer: string;
    if (pick === "alternative" && choice.alternative) [answer, changed] = [choice.alternative, true];
    else if (pick && pick !== "assumed" && pick !== "alternative") [answer, changed] = [[...pick].slice(0, 1000).join(""), true];
    else answer = choice.assumed;
    lines.push(`- ${choice.question} → ${answer}`);
  });
  if (!changed) return "";
  return "The user has decided these scope questions; plan exactly by these answers and do not list "
    + "them as choices again:\n" + lines.join("\n");
}

/** What a requirement change is told about the task it continues. */
export function changeBackground(parent: ExecutionRun): string {
  const listing = publish.outputFiles(parent);
  const names = listing.slice(0, MAX_BACKGROUND_FILES).map((item) => item.path);
  const more = listing.length > names.length ? `\n…以及另外 ${listing.length - names.length} 个文件` : "";
  const earlier = parent.background ? `\n更早的背景：\n${[...parent.background].slice(0, MAX_EARLIER_BACKGROUND).join("")}` : "";
  const result = [...(parent.final_result || "（没有最终结果）")].slice(0, MAX_BACKGROUND_RESULT).join("");
  return "这是对一个已有任务的需求变更：在它已有的结果上修改或新增，不要从头重做，也不要删掉与新需求无关的已有功能。\n"
    + `原任务需求：${parent.prompt}\n`
    + `原任务计划：${parent.plan.summary}；步骤：${parent.plan.nodes.map((node) => node.title).join("、")}\n`
    + `原任务状态：${parent.status}\n`
    + `原任务结果（节选）：\n${result}\n`
    + "工作目录里已有的文件：\n" + (names.join("\n") || "（无）") + more + earlier;
}

/** A chat's plan: no steps, titled by its first line. */
export function chatPlan(message: string, projectDir: string | null): TaskPlan {
  const title = message ? [...message.split(/\r\n|\r|\n/)[0]].slice(0, CHAT_TITLE_CHARS).join("") : "对话";
  return TaskPlanSchema.parse({ summary: title, nodes: [], request: message, in_project: Boolean(projectDir) });
}

/** A task as the task list shows it: without the steps' tool output, answers and changed files, the
 *  team, the lead's decisions and what was said with it, which only the opened task needs. */
export function brief(run: ExecutionRun): ExecutionRun {
  const copy = structuredClone(run);
  for (const node of copy.plan.nodes) {
    node.changed_files = [];
    node.result = null;
    for (const attempt of node.attempts) Object.assign(attempt, { tool_calls: [], result: null, trace: null });
  }
  copy.plan.employees = [];
  copy.plan.team_brief = "";
  copy.decisions = [];
  // The list counts a chat's questions by who said them.
  for (const message of copy.lead_messages) message.text = "";
  if (copy.supervisor) copy.supervisor.history = [];
  return copy;
}

/** JSON the console polls for, tagged so it is not sent again while it is the same: the console asks
 *  every few seconds, and a 304 costs the browser no parsing and no redraw. */
export function etagged(body: string): string {
  return `"${createHash("sha1").update(body).digest("hex").slice(0, 20)}"`;
}

export { chosenFor, configuredFor } from "./model-choice.js";

/** A task without the planning capability: the whole request as one step, done by one model (the
 *  strongest that clears the bar, a membership CLI or an API model working through tools), in the
 *  project when there is one. */
export function oneStep(request: string, background: string | null, projectDir: string | null): TaskPlan {
  const asked = background ? `${background}\n\n新需求：\n${request}` : request;
  const title = [...(request.split(/\r\n|\r|\n/)[0] || request)].slice(0, 40).join("").trim() || "任务";
  const node = TaskNodeSchema.parse({ id: randomUUID().replaceAll("-", "").slice(0, 8), title, capability: "coding", difficulty: "hard",
    needs_workspace: Boolean(projectDir), instructions: asked + SOLO_SCOPE, acceptance_criteria: "需求里要的都做到了，结果可以直接交给用户。" });
  return TaskPlanSchema.parse({ summary: title, title, nodes: [node], planning_note: "没有启用规划能力：整个需求作为一步，交给一个模型做",
    in_project: Boolean(projectDir) });
}

export class Api {
  readonly db: Database;
  models: Record<string, ModelProfile>;
  providers: ProviderRegistry;
  executor: Executor;
  readonly benchmarks: BenchmarkCatalog;
  readonly catalogSync: CatalogSync;
  readonly automations: CapabilityAutomations;
  /** The service packages: capabilities FluidForm itself uses (services.ts). */
  readonly services = new ServiceHost();
  /** What tests replace. */
  readonly deps = { autonomousPlan, setProviderKey, classify: triage.classify, quick, addressed: triage.addressed };
  // Tasks being planned again with the user's choices (one replanning at a time per task).
  readonly replanning = new Set<string>();
  discovery: { at: number; result: unknown } = { at: 0, result: null };
  private readonly background: Task<void>[] = [];

  constructor() {
    this.db = new Database(settings.dbPath);
    this.models = seedCatalog(this.db);
    this.providers = new ProviderRegistry(this.db, this.models);
    this.executor = new Executor(this.db, this.providers, this.models);
    this.benchmarks = new BenchmarkCatalog(this.db);
    rescore(this.models, this.benchmarks, this.db);
    this.catalogSync = new CatalogSync(this.db, this.models, { autoSync: settings.catalog_auto_sync,
      intervalHours: settings.catalog_sync_interval_hours, benchmarks: this.benchmarks });
    this.automations = new CapabilityAutomations(this);
    // Every price, estimate, budget check and charge is asked of the pricing package.
    // (Unless it is already answered: tests answer with the package's code in-process.)
    pricing.deps.ask ??= (method, params) => this.services.request("pricing", method, params);
    // And everything about how to chat, of the chat package.
    chat.deps.ask ??= (method, params) => this.services.request("chat", method, params);
  }

  /** api.ts's lifespan, its start: tasks a restart cut off, the platform's work, the automations. */
  start(): void {
    const { db, executor } = this;
    db.interruptModelCalls();
    this.catalogSync.start();
    const resuming: string[] = [];
    for (const run of db.listRuns()) {
      if (run.status === "queued" || run.status === "running") {
        if (resumesByItself(run)) {
          // Finished steps keep their results; the one cut off runs again (Executor.execute).
          run.status = "queued";
          db.saveRun(run);
          db.addEvent(EventSchema.parse({ run_id: run.id, kind: "run.restart_resumed", data: {} }));
          resuming.push(run.id);
        } else {
          // An interrupted run may have left a project half-edited; resume only once confirmed.
          run.status = "paused";
          db.saveRun(run);
          db.addEvent(EventSchema.parse({ run_id: run.id, kind: "approval.required", data: { reason: "interrupted" } }));
        }
      }
      if (run.lead_thinking) {
        // The restart cut the lead off mid-decision.
        run.lead_thinking = null;
        db.saveRun(run);
      }
      const interrupted = run.diagnoses.filter((item) => item.status === "running");
      for (const item of interrupted) Object.assign(item, { status: "failed", error: "服务重启打断了平台工程师的排查。" });
      if (interrupted.length) db.saveRun(run);
    }
    // Services first: the tasks resumed below ask pricing, which waits for its service to start.
    if (settings.capability_packages) this.services.startAll();
    // Packages shipped with FluidForm, the first time (or a newer version): installed and run.
    this.background.push(new Task(async () => {
      for (const item of await bundled.offer()) {
        await this.services.stop(item.id);
        if (item.kind === "service" && item.status === "active") this.services.start(item);
      }
    }));
    executor.restorePlatform();
    executor.restoreEngineer();
    executor.restoreLearning();
    for (const runId of resuming) executor.start(runId);
    // Automation packages, when switched on: tasks asked for through them hear how they ended.
    executor.endListeners.push((runId, kind) => this.automations.taskEnded(runId, kind));
    this.automations.startAll();
    // Keys saved in a keyring that was locked at startup: load them once it is unlocked.
    this.background.push(new Task((signal) => keepLoadingKeys((loaded) => loaded.forEach((item) => this.providers.quota.clearProvider(item)), undefined, undefined, undefined, signal)));
    // Membership CLIs priced by their subscription: refresh their price and quota pressure.
    this.background.push(new Task((signal) => cliQuota.keepApplying(this.models, this.providers.quota, undefined, signal)));
  }

  /** api.ts's lifespan, its end. */
  async close(): Promise<void> {
    for (const task of this.background) task.cancel();
    await Promise.all(this.background.map((task) => task.settled()));
    await this.automations.runner.stopAll();
    await this.services.stopAll();
    await this.executor.shutdown();
    await this.catalogSync.close();
  }

  getTask(runId: string): ExecutionRun {
    const run = this.db.getRun(runId);
    if (!run) throw new HttpError(404, "Task not found");
    return run;
  }

  /** The files sent with a message, or ``status`` when one is gone or there are too many. */
  attached(ids: string[], status = 422): Attachment[] {
    try {
      return files.resolve(ids);
    } catch (error) {
      if (error instanceof files.AttachmentError) throw new HttpError(status, error.message);
      throw error;
    }
  }

  projectDir(given: string | null | undefined): string | null {
    if (!given?.trim()) return null;
    try {
      return resolveProjectDir(given.trim());
    } catch (error) {
      if (error instanceof ProjectDirError) throw new HttpError(400, error.message);
      throw error;
    }
  }

  configured(useCli = true): Set<string> {
    return configuredFor(this.providers.configuredModels(Object.keys(this.models)), useCli);
  }

  /** Runs as read by the console, each estimate also given as past tasks suggest it will go. Only for
   *  display: these copies are never saved, and budget checks keep the planned estimate. */
  async calibrated(runs: ExecutionRun[]): Promise<ExecutionRun[]> {
    const estimated = runs.filter((run) => run.plan.estimate);
    if (!estimated.length || !pricing.enabled()) return runs;
    let found: (number | null)[];
    try {
      found = await pricing.calibrated(this.db.retrospectives(), estimated);
    } catch {
      return runs; // only for display: the task list shows without it
    }
    estimated.forEach((run, index) => {
      run.plan.estimate!.calibrated_usd = found[index];
    });
    return runs;
  }

  /** Plan, route and save a task awaiting confirmation. With ``parent`` it is a requirement change
   *  that continues that task in its folder; ``context`` is what it grew out of (a conversation). */
  async newTask(body: CreateTask, parent: ExecutionRun | null = null, context = ""): Promise<ExecutionRun> {
    const { plan, session, attached, projectDir, background, lessons } = await this.makePlan(body, parent, "", context);
    // Pictures are made by an image MCP server, which reaches its service from the step's sandbox:
    // a task that must make pictures is allowed the internet.
    const pictures = plan.nodes.some((node) => node.needs_images) && imageServers().length > 0;
    const run = ExecutionRunSchema.parse({
      id: randomUUID(), prompt: body.prompt, status: "awaiting_confirmation", plan, budget_usd: body.budget_usd, use_cli: body.use_cli || body.cli_only,
      only_models: body.only_models, cli_only: body.cli_only, allow_network: body.allow_network || pictures, project_dir: projectDir, attachments: attached, actual_cost_usd: plan.planning_cost_usd,
      background, parent_run_id: parent?.id ?? null, workspace_id: parent ? folderId(parent) : null,
      supervisor: session.model_id ? session : null, improvement_uses: lessons,
    });
    // A readable folder, not the task's id: 20261021-1441-async-fifo-uvm.
    if (!parent && !projectDir) run.folder_name = folders.taskFolder(plan.folder || plan.summary || body.prompt);
    this.db.saveRun(run);
    this.db.addEvent(EventSchema.parse({ run_id: run.id, kind: "plan.created", data: {
      estimate: run.plan.estimate, use_cli: body.use_cli, allow_network: run.allow_network, project_dir: run.project_dir,
      parent_run_id: run.parent_run_id, planning_method: plan.planning_method, planner_model_id: plan.planner_model_id, planning_note: plan.planning_note,
    } }));
    return run;
  }

  /** The routed and estimated plan of ``body``, and what it was made with. ``decided``: the user's
   *  answers to an earlier plan's open choices. ``context``: the background when there is no parent,
   *  such as the conversation a task grew out of. */
  async makePlan(body: CreateTask, parent: ExecutionRun | null = null, decided = "", context = ""): Promise<Made> {
    const configured = chosenFor(this.configured(true), body);
    // A choice nothing is left of is a mistake to say, not a task to plan with any model.
    if ((body.cli_only || body.only_models.length) && !configured.size) {
      throw new HttpError(422, body.only_models.length ? `这些模型现在用不了（没启用或没配置）：${body.only_models.join("、")}` : "没有可用的会员 CLI。");
    }
    const projectDir = this.projectDir(body.project_dir);
    const attached = this.attached(body.attachments, 400);
    const needsVision = attached.some((item) => item.kind === "image");
    const background = parent ? changeBackground(parent) : context || null;
    let request = body.prompt + files.describe(attached, false);
    if (decided) request += "\n\n" + decided;
    // The lead plans within what the steps' sandbox allows (planner.WORK_RULES).
    if (body.allow_network) request += "\n\n" + INTERNET_NOTE;
    this.executor.syncImprovements();
    const lessons = uses.learning() ? learning.selected(this.db, request) : [];
    const note = learning.instruction(lessons);
    if (note) request += "\n\n" + note;
    // The planner knows the tools earlier tasks built, so it plans to use them (capabilities.ts).
    const built = capabilities.section();
    if (built) request += "\n\n" + built;
    // The lead plans from the project brief, so it can cut the work into scoped packages.
    const root = projectDir ?? (parent ? join(settings.workspace_root, folderId(parent)) : null);
    let brief: string | null = null;
    let briefCost = 0;
    // The brief is the planning capability's: without it the one step reads the project itself.
    if (root && uses.planning() && isFullFolder(root)) {
      const writer = settings.project_brief ? await briefWriter(Object.values(this.models), configured) : null;
      [brief, briefCost] = await planningBrief(root, settings.data_dir, this.providers, writer);
    }
    const session = SupervisorSessionSchema.parse({});
    const asked = background ? `${background}\n\n新需求：\n${request}` : request;
    // Without the planning capability the whole request is one step (FluidForm's base).
    let plan = !uses.planning() ? oneStep(request, background, projectDir)
      : parent || decided ? null : await this.quickPlan(body, request, background, configured, projectDir);
    try {
      // Asked again: planning may have been switched off while the request was judged.
      if (!plan && !uses.planning()) plan = oneStep(request, background, projectDir);
      plan ??= await this.deps.autonomousPlan(asked, Object.values(this.models), configured, this.providers,
        projectDir ? projectContext(projectDir) : null, session, brief);
    } catch (error) {
      if (error instanceof ContractError) throw new HttpError(422, { status: "blocked", reason: error.message });
      throw error;
    }
    plan.planning_cost_usd = round6(plan.planning_cost_usd + briefCost);
    const catalog = Object.values(this.models);
    if (parent) plan.in_project = true;
    try {
      for (const node of plan.nodes) {
        // Every step changes files the earlier task left, so it needs a model that can act.
        if (parent) node.needs_workspace = true;
        if (plan.employees.length) await team.route(node, plan, catalog, configured, needsVision);
        else {
          const routed = await fitAndRoute(node, catalog, configured, needsVision);
          if (routed) plan.planning_note = plan.planning_note ? `${plan.planning_note}; ${routed}` : routed;
        }
      }
    } catch (error) {
      if (error instanceof NoEligibleModelError) throw new HttpError(422, error.message);
      throw error;
    }
    plan.estimate = await pricing.estimate(plan.nodes, body.budget_usd, plan.planning_cost_usd);
    return { plan, session, attached, projectDir, background, lessons };
  }

  /** With settings.quick_tasks, a task one model can do in one go (triage.quick) as a one-step plan,
   *  without the lead's planning; with settings.solo_tasks also one a strong model carries through
   *  alone, in a project too. null: plan it as usual. */
  async quickPlan(body: CreateTask, request: string, background: string | null, configured: Set<string>, projectDir: string | null = null): Promise<TaskPlan | null> {
    if (!settings.quick_tasks && !settings.solo_tasks) return null;
    const [step, judged] = await this.deps.quick(body.prompt, this.providers, await briefWriter(Object.values(this.models), configured),
      settings.solo_tasks, Boolean(projectDir));
    if (!step || (step.shape === "quick" && !settings.quick_tasks)) return null;
    const solo = step.shape === "solo";
    const asked = background ? `${background}\n\n新需求：\n${request}` : request;
    const node = TaskNodeSchema.parse({ id: randomUUID().replaceAll("-", "").slice(0, 8), title: step.title, capability: step.capability,
      difficulty: solo ? "hard" : "easy", needs_workspace: Boolean(projectDir), instructions: asked + (solo ? SOLO_SCOPE : QUICK_SCOPE),
      needs_images: step.needs_images, acceptance_criteria: step.acceptance });
    const note = solo ? "一个模型连续做完：没有拆成多步，交给一个强模型带着工具一路做到底" : "一步就能做完：没有排详细计划，直接交给一个模型做";
    return TaskPlanSchema.parse({ summary: step.title, title: step.title, nodes: [node], planning_cost_usd: round6(judged),
      planning_note: note, in_project: Boolean(projectDir) });
  }

  /** Models a chat can be held with, best first: those that can lead a task's conversation; with
   *  images attached, those that can see them (a CLI, or an API model not known blind). */
  chatModels(useCli = true, needsVision = false): ModelProfile[] {
    return supervisor.candidates(Object.values(this.models), this.configured(useCli))
      .filter((model) => !needsVision || model.channel === "cli" || model.supports_vision !== false);
  }

  /** The models a chat may talk with, best first, as the chat package orders them. */
  chatChoices(useCli = true, needsVision = false): Promise<ModelProfile[]> {
    return chat.order(this.chatModels(useCli, needsVision));
  }

  /** Save a new chat and send its first message, with its attachments. */
  async startChat(message: string, budgetUsd: number, useCli: boolean, projectDir: string | null | undefined, modelId: string | null | undefined,
    attachmentIds: string[] = [], { autoRouted = false, spent = 0, shown = null, origin = null, title = null }:
    { autoRouted?: boolean; spent?: number; shown?: string | null; origin?: Json | null; title?: string | null } = {}): Promise<ExecutionRun> {
    const attached = this.attached(attachmentIds, 400);
    const needsVision = attached.some((item) => item.kind === "image");
    const available = await this.chatChoices(useCli, needsVision);
    const pick = modelId ? available.find((model) => model.id === modelId) : available[0];
    if (!pick) {
      throw new HttpError(422, modelId ? (needsVision ? "这个模型看不了图片，请换一个模型。" : "这个模型不能用来对话。")
        : "没有可用来对话的模型：请先配置会员 CLI 或 API 模型。");
    }
    const folder = this.projectDir(projectDir);
    const text = message.trim();
    const run = ExecutionRunSchema.parse({
      id: randomUUID(), prompt: text, kind: "chat", status: "draft", plan: chatPlan(text, folder), budget_usd: budgetUsd, use_cli: useCli,
      project_dir: folder, attachments: attached, auto_routed: autoRouted, actual_cost_usd: round6(spent),
      supervisor: supervisor.newSession(pick, null, folder),
    });
    // Where it comes from (an automation's conversation) is known before its first answer is written.
    if (origin) run.origin = origin;
    if (title) run.plan.title = title;
    this.db.saveRun(run);
    this.db.addEvent(EventSchema.parse({ run_id: run.id, kind: "chat.created", data: { model_id: pick.id, project_dir: folder, auto_routed: autoRouted } }));
    this.executor.startLeadChat(run.id, text, [], shown);
    return this.getTask(run.id);
  }

  /** A task's events as server-sent events, from after ``after``: each as it is added, a keepalive
   *  each second nothing is, until the task has finished (or is gone) and nothing new came. */
  async *events(runId: string, after = 0, signal?: AbortSignal): AsyncGenerator<string> {
    let cursor = after;
    let idle = 0;
    while (idle < 300 && !signal?.aborted) {
      const events = this.db.events(runId, cursor);
      if (events.length) {
        idle = 0;
        for (const item of events) {
          cursor = item.id || cursor;
          yield `id: ${cursor}\nevent: ${item.kind}\ndata: ${pyDumps(item.data)}\n\n`;
        }
      } else {
        idle += 1;
        yield ": keepalive\n\n";
      }
      const run = this.db.getRun(runId);
      if (!run || (FINISHED.has(run.status) && !events.length)) break;
      try {
        await sleep(1, signal);
      } catch {
        break;
      }
    }
  }

  /** The cached scan of project folders, or a fresh one. */
  discover(refresh: boolean, scan: () => unknown): unknown {
    const now = performance.now() / 1000;
    if (refresh || this.discovery.result === null || now - this.discovery.at > DISCOVERY_TTL) this.discovery = { at: now, result: scan() };
    return this.discovery.result;
  }
}

function isFullFolder(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory() && readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

export const round6 = (value: number) => pyRound(value, 6);

export { FINISHED, log };
