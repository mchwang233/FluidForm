// FluidForm's HTTP API, served by Fastify: the local-only guard, and
// the routes the console uses. What they work with is the Api (api.ts).
import { uses } from "./features.js";
import { createReadStream, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  Api, brief, chatPlan, CreateTask, decidedChoices, etagged, FINISHED, HttpError, log, parse, round6, StartRequest,
} from "./api.js";
import * as files from "./attachments.js";
import { taskName } from "./automations.js";
import * as capabilities from "./capabilities.js";
import * as chat from "./chat.js";
import * as interfaces from "./interfaces.js";
import * as services from "./services.js";
import * as packages from "./capability-packages.js";
import { missing as sandboxMissing } from "./capability-sandbox.js";
import { PROFILES, settings } from "./config.js";
import { NETWORK_CHOICE } from "./diagnosis.js";
import { EngineerError, STOP } from "./engineer.js";
import { LearningProblem } from "./learning.js";
import {
  type Capability, DiagnosisMessageSchema, EventSchema, type ExecutionRun, LearningSettingsSchema, routingReady, type TaskNode,
} from "./models.js";
import { discoverProjects, inspectProject, NativePickerError, nativePickDirectory, nativePickerStatus, ProjectDirError } from "./projects.js";
import { ProviderError } from "./budget.js";
import * as publish from "./publish.js";
import { fixed, pyQuote as quote } from "./py.js";
import { pythonIso } from "./lax.js";
import { stepKey } from "./review.js";
import { preferences } from "./learning.js";
import { taskFolder } from "./folders.js";
import { briefWriter } from "./routing.js";
import * as retrospect from "./retrospect.js";
import { eligibleForNode, NoEligibleModelError, routeNode } from "./routing.js";
import { AA_SOURCE } from "./scoring.js";
import * as secretStore from "./secrets.js";
import { configuredProviders, deleteProviderKey, keyringUnavailable } from "./secrets.js";
import { PROVIDER_ENV, SECRET_ENV } from "./secret-names.js";
import * as skills from "./skills.js";
import * as supervisor from "./supervisor.js";
import * as team from "./team.js";
import { which } from "./environment.js";

type Json = Record<string, any>;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The host name of a Host header, without its port ("[::1]:8000" is "::1"). */
export function hostName(host: string): string {
  if (host.startsWith("[")) return host.slice(1).split("]", 1)[0];
  return (host.match(/:/g) ?? []).length === 1 ? host.slice(0, host.lastIndexOf(":")) : host;
}

// ---- Request bodies ----

const text = (max: number) => z.string().max(max);
const ids = z.array(z.string()).default(() => []);
const NetworkAccess = z.object({ allow: z.boolean() });
const LeadQuestion = z.object({ message: text(20_000).default(""), attachments: ids });
const ConfirmTask = z.object({ budget_usd: z.number().gt(0).lte(10_000).nullish().default(null) });
const DiagnosisReply = z.object({ text: text(6000).default(""), choice: text(300).nullish().default(null), attachments: ids });
const ProviderKey = z.object({ api_key: z.string().min(8) });
const UpdateModel = z.object({ enabled: z.boolean() });
const UpdateModelById = UpdateModel.extend({ model_id: z.string() });
const ProfileChoice = z.object({ profile: z.enum(["", "fast", "balanced", "careful"]) });
const Forget = z.object({ key: z.string().min(1).max(300), fact: z.string().min(1).max(310) });
const EngineerRequest = z.object({
  request: z.string().min(1).max(20_000),
  kind: z.string().regex(/^(repair|component)$/).default("component"),
  budget_usd: z.number().gte(0).lte(100).nullish().default(null),
  // Go on with this conversation (engineer.threadOf); a new one when empty.
  thread_id: text(200).nullish().default(null),
  attachments: ids,
});
const EngineerReply = z.object({ text: text(20_000).default(""), choice: text(300).nullish().default(null), attachments: ids });
// One per choice of the plan, in order: "assumed", "alternative", or the user's own answer.
const ChoiceAnswers = z.object({ picks: z.array(z.string()).min(1).max(5) });
const FollowUp = z.object({
  prompt: z.string().min(3),
  attachments: ids,
  budget_usd: z.number().gt(0).lte(10_000).nullish().default(null),
  // Default to the earlier task's settings.
  allow_network: z.boolean().nullish().default(null),
  use_cli: z.boolean().nullish().default(null),
});
const CreateChat = z.object({
  message: z.string().min(1).max(20_000),
  attachments: ids,
  budget_usd: z.number().gt(0).lte(10_000).default(1),
  use_cli: z.boolean().default(true),
  project_dir: text(4096).nullish().default(null),
  // A model that can hold a conversation (supervisor.candidates); the best one when empty.
  model_id: text(200).nullish().default(null),
});
const PromoteChat = z.object({
  // What the task is to do; the chat's first message when empty. The conversation goes with it.
  prompt: text(20_000).default(""),
  budget_usd: z.number().gt(0).lte(10_000).default(2),
  use_cli: z.boolean().nullish().default(null),
  allow_network: z.boolean().default(false),
  // More files for the task, besides the chat's own.
  attachments: ids,
});
const GithubToken = z.object({ token: z.string().min(10).max(500) });
const CapabilitySwitch = z.object({
  enabled: z.boolean(),
  // An uploaded package is code from elsewhere: the user confirms what it may reach and gets.
  confirmed: z.boolean().default(false),
});
const CapabilitySecrets = z.object({ values: z.record(z.string(), z.string()) });
const CapabilityBudget = z.object({ daily_budget_usd: z.number().gte(0).lte(1000) });
const CapabilityModel = z.object({ model_id: text(200).nullish().default(null) });
const PublishRequest = z.object({
  // Either create ``name`` with the saved token, or push to an existing empty ``remote``.
  name: z.string().nullish().default(null),
  private: z.boolean().default(true),
  description: z.string().default(""),
  remote: z.string().nullish().default(null),
});

// ---- Query parameters, as FastAPI reads them ----

type Query = Record<string, string | undefined>;

function queryInt(query: Query, name: string, fallback: number): number {
  const value = query[name];
  if (value === undefined) return fallback;
  if (!/^\s*[+-]?\d+\s*$/.test(value)) {
    throw new HttpError(422, [{ type: "int_parsing", loc: ["query", name], msg: "Input should be a valid integer, unable to parse string as an integer" }]);
  }
  return Number.parseInt(value, 10);
}

function queryBool(query: Query, name: string, fallback: boolean): boolean {
  const value = query[name];
  if (value === undefined) return fallback;
  const word = value.trim().toLowerCase();
  if (["1", "true", "t", "yes", "y", "on"].includes(word)) return true;
  if (["0", "false", "f", "no", "n", "off"].includes(word)) return false;
  throw new HttpError(422, [{ type: "bool_parsing", loc: ["query", name], msg: "Input should be a valid boolean, unable to interpret input" }]);
}

function queryText(query: Query, name: string): string {
  const value = query[name];
  if (value === undefined) throw new HttpError(422, [{ type: "missing", loc: ["query", name], msg: "Field required" }]);
  return value;
}

const intParam = (params: Json, name: string): number => queryInt(params, name, 0);

// The 模型 page's totals: calls and spend per model over this many days.
export const USAGE_DAYS = 30;
export const USAGE_RUNS = 3;
export const SHOWN_CHANGED_FILES = 50;
export const SHOWN_COMMAND_CHARS = 300;
export const CHANGEABLE = FINISHED;

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI", anthropic: "Anthropic Claude", google: "Google Gemini", deepseek: "DeepSeek", qwen: "通义千问", doubao: "豆包",
  glm: "智谱 GLM", minimax: "MiniMax", kimi: "Kimi（月之暗面）",
};

/** Give a failed or stopped node fresh attempts; the next one sees why the last one failed, and the
 *  latest diagnosis's advice. */
export function reopenNode(run: ExecutionRun, node: TaskNode): void {
  if (node.status === "unable") {
    node.feedback = `上次这一步无法完成：${node.unable_reason}\n请先确认这个限制现在是否已经解除；仍然做不到时如实说明。`;
    node.unable_reason = null;
  } else if (node.status === "failed" && node.attempts.length) {
    node.feedback = node.feedback || node.attempts.at(-1)!.reason;
    const advice = [...run.diagnoses].reverse().find((item) => item.status === "done" && item.advice && (item.node_id === node.id || item.node_id === null))?.advice;
    if (advice && !(node.feedback ?? "").includes(advice)) node.feedback = `${node.feedback}\n诊断建议：${advice}`;
  }
  Object.assign(node, { status: "pending", failed_attempts: 0, environment_fixes: 0 });
}

/** Content-Disposition as Starlette's FileResponse writes it. */
function disposition(kind: string, name: string): string {
  const quoted = quote(name);
  return quoted !== name ? `${kind}; filename*=utf-8''${quoted}` : `${kind}; filename="${name}"`;
}

const event = (runId: string, kind: string, data: Json = {}) => EventSchema.parse({ run_id: runId, kind, data });

export function buildApp(api: Api): FastifyInstance {
  const app = Fastify({ logger: false });
  const { db } = api;
  const executor = () => api.executor;
  const providers = () => api.providers;
  const runner = () => api.automations.runner;

  // ---- Bodies: JSON (an empty one is no body); a raw upload is read as bytes by its own route ----
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    if (!body) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new HttpError(422, [{ type: "json_invalid", loc: ["body", 0], msg: "JSON decode error" }]), undefined);
    }
  });
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));

  app.setErrorHandler((error: any, request, reply) => {
    if (error instanceof HttpError) return reply.code(error.status).headers(error.headers).send({ detail: error.detail });
    if (error?.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      const path = request.url.split("?")[0];
      const detail = path === "/api/attachments" ? `单个附件不能超过 ${Math.floor(files.MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB。`
        : path === "/api/capabilities/upload" ? `能力包不能超过 ${Math.floor(capabilities.MAX_CAPABILITY_BYTES / 1024 / 1024)} MB。` : "Request body too large";
      return reply.code(413).send({ detail });
    }
    if (typeof error?.statusCode === "number" && error.statusCode < 500) return reply.code(error.statusCode).send({ detail: error.message });
    log.error(`${request.method} ${request.url} failed: ${error?.stack ?? error}`);
    return reply.code(500).send({ detail: "Internal Server Error" });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ detail: "Not Found" }));

  // Refuse rebinding hosts and cross-site writes; the API can drive agents on local files.
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!settings.allowed_hosts.includes(hostName(request.headers.host ?? "").toLowerCase())) {
      return reply.code(403).send({ detail: "Host not allowed" });
    }
    const origin = request.headers.origin;
    if (origin && settings.allowed_origins.includes(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-credentials", "true");
      reply.header("vary", "Origin");
    }
    if (request.method === "OPTIONS" && origin) {
      if (!settings.allowed_origins.includes(origin)) return reply.code(400).send("Disallowed CORS origin");
      reply.header("access-control-allow-methods", "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT");
      reply.header("access-control-allow-headers", request.headers["access-control-request-headers"] ?? "*");
      reply.header("access-control-max-age", "600");
      return reply.code(200).send("OK");
    }
    const mutation = !SAFE_METHODS.has(request.method);
    // A page FluidForm serves itself (an interface package) writes from FluidForm's own address,
    // whose host was checked above.
    const own = origin === `http://${request.headers.host}` || origin === `https://${request.headers.host}`;
    if (mutation && origin && !own && !settings.allowed_origins.includes(origin)) {
      return reply.code(403).send({ detail: "Origin not allowed" });
    }
    if (mutation && executor().platformPending && !/\/(cancel|pause)$/.test(request.url.split("?")[0])) {
      reply.header("retry-after", "2");
      return reply.code(503).send({ detail: "FluidForm 正在应用已验证的修复，请稍后重试；现有任务会自动继续。" });
    }
    if (mutation) {
      // A platform repair waits until no change is being made (self-repair.waitToApply).
      const current = executor();
      current.activeRequests += 1;
      reply.raw.once("close", () => {
        current.activeRequests -= 1;
      });
    }
    return undefined;
  });

  /** A JSON body the console polls for, not sent again while it is the same (api._unchanged_or). */
  const unchangedOr = (request: FastifyRequest, reply: FastifyReply, body: string) => {
    const tag = etagged(body);
    reply.header("etag", tag).header("cache-control", "no-cache");
    if (request.headers["if-none-match"] === tag) return reply.code(304).send();
    return reply.type("application/json").send(body);
  };

  const engineerAction = async <T>(action: () => T | Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      if (error instanceof EngineerError) throw new HttpError(409, error.message);
      throw error;
    }
  };

  // ---- Health, profile, memory, recovery ----

  // Interface packages (a web console): each active one's page at /<its id>/, and FluidForm's own
  // address leads to the web console when there is one.
  app.get("/", async (_request, reply) => {
    const home = interfaces.home();
    if (home) return reply.redirect(`/${home.id}/`);
    return reply.type("text/plain; charset=utf-8").send(interfaces.NO_INTERFACE);
  });
  app.get<{ Params: { capability_id: string } }>("/:capability_id", async (request, reply) => {
    if (!interfaces.active(request.params.capability_id)) return reply.code(404).send({ detail: "Not Found" });
    return reply.redirect(`/${request.params.capability_id}/`);
  });
  app.get<{ Params: { capability_id: string; "*": string } }>("/:capability_id/*", async (request, reply) => {
    const found = interfaces.file(request.params.capability_id, request.params["*"]);
    if (!found) return reply.code(404).send({ detail: "Not Found" });
    return reply.headers({ "content-type": found.type, "x-content-type-options": "nosniff", "cache-control": found.index ? "no-cache" : "max-age=3600" })
      .send(createReadStream(found.path));
  });

  app.get("/health", async () => ({
    status: "ok", pid: process.pid, configured_providers: [...configuredProviders(), "mock"], keyring_unavailable: keyringUnavailable(),
    available_cli_channels: [...providers().cli.availableModelIds()].sort(), exhausted_models: providers().quota.public(),
  }));

  // Models out of quota and when they come back; routing skips them until then.
  app.get("/api/models/quota", async () => providers().quota.public());

  // The profile in use, and for each one the settings it would not change (given alone).
  const profileView = () => ({
    profile: settings.profile,
    given_alone: Object.fromEntries(Object.keys(PROFILES).map((name) => [name, settings.givenAlone(name)])),
  });
  app.get("/api/settings/profile", async () => profileView());
  // Pick how FluidForm works (config.PROFILES), now and after a restart.
  app.put("/api/settings/profile", async (request) => {
    const body = parse(ProfileChoice, request.body);
    settings.useProfile(body.profile);
    mkdirSync(dirname(settings.profilePath), { recursive: true });
    writeFileSync(settings.profilePath, JSON.stringify({ profile: body.profile }));
    return profileView();
  });

  /** Where facts were said, for the owner: their own chats, or an automation's conversation. */
  const memoryPlace = (key: string) => {
    if (key === chat.WEB) return "网页对话";
    const at = key.indexOf(":");
    const [capabilityId, conversation] = at < 0 ? [key, ""] : [key.slice(0, at), key.slice(at + 1)];
    const capability = capabilities.load(capabilityId);
    return `${capability ? capability.name : capabilityId} · 会话 ${[...conversation].slice(-6).join("")}`;
  };
  // What chats remember, by where it was said: the chat package keeps it.
  const listMemory = async () => {
    const kept: Record<string, string[]> = chat.enabled() ? ((await chat.ask("chat.memory")).places ?? {}) : {};
    return {
      enabled: settings.user_memory, available: chat.enabled(),
      places: Object.entries(kept).map(([key, facts], index) => ({ key, facts, index }))
        .sort((a, b) => Number(a.key !== chat.WEB) - Number(b.key !== chat.WEB) || a.index - b.index)
        .map(({ key, facts }) => ({ key, label: memoryPlace(key), facts })),
    };
  };
  app.get("/api/memory", async () => listMemory());
  app.post("/api/memory/forget", async (request) => {
    const body = parse(Forget, request.body);
    chatRequired();
    if (!(await chat.ask("chat.forget", { place: body.key, fact: body.fact })).removed) throw new HttpError(404, "没有这条记忆");
    return listMemory();
  });

  // Auditable shared recoveries reused by all projects, including after a restart.
  app.get("/api/recovery", async () => ({
    models: providers().quota.public(), rules: providers().quota.rules, shared_repairs: db.sharedRepairs(),
    platform_repair: { enabled: settings.platform_self_repair, source_available: executor().platform.root !== null,
      pending: executor().platformPending?.id ?? null },
  }));

  // The user knows the quota is back (or topped up the account): use the model again.
  app.delete<{ Params: { model_id: string } }>("/api/models/quota/:model_id", async (request) => {
    providers().quota.clear(request.params.model_id);
    return providers().quota.public();
  });

  // ---- The platform engineer (engineer.ts) ----

  // Its jobs, newest first, and what it is working on; with ``run_id``, only the jobs of that task.
  // Each job's diff is left out (``has_diff``) and read when it is opened.
  app.get("/api/engineer", async (request, reply) => {
    const query = request.query as Query;
    const overview = executor().engineerOverview(30, query.run_id ?? null);
    for (const job of overview.jobs) Object.assign(job, { has_diff: Boolean(job.diff), diff: null });
    return unchangedOr(request, reply, JSON.stringify(overview));
  });

  app.get<{ Params: { job_id: string } }>("/api/engineer/jobs/:job_id/diff", async (request) => {
    const job = db.getEngineerJob(request.params.job_id);
    if (!job) throw new HttpError(404, "没有这项平台改动");
    return { diff: job.diff };
  });

  // The user brings the platform engineer into the task's conversation with its lead.
  app.post<{ Params: { run_id: string } }>("/api/tasks/:run_id/engineer", async (request, reply) => {
    const body = parse(EngineerRequest, request.body);
    api.getTask(request.params.run_id);
    const [job, problem] = executor().engineerJoin(request.params.run_id, { request: body.request, kind: body.kind }, "user", null, null,
      api.attached(body.attachments));
    if (!job) throw new HttpError(409, problem);
    return reply.code(201).send(job);
  });

  // Ask the platform engineer for a repair (applied once checked) or a component (planned first;
  // applied once the user approves the checked change).
  app.post("/api/engineer/jobs", async (request, reply) => {
    const body = parse(EngineerRequest, request.body);
    const attachments = api.attached(body.attachments);
    const job = await engineerAction(() => executor().engineerRequest(body.request, body.kind, "user",
      { budgetUsd: body.budget_usd, threadId: body.thread_id, attachments }));
    return reply.code(201).send(job);
  });

  // What the platform engineer's job is doing right now: its model's commands, file changes and
  // messages, and the platform's checks; empty when idle.
  app.get<{ Params: { job_id: string } }>("/api/engineer/jobs/:job_id/activity", async (request) => {
    const limit = queryInt(request.query as Query, "limit", 200);
    const jobId = request.params.job_id;
    if (!db.getEngineerJob(jobId)) throw new HttpError(404, "找不到这项平台工程师工作。");
    const calls = [...(executor().engineerLogs.get(jobId) ?? [])];
    return { running: executor().engineerLogs.has(jobId), total: calls.length, calls: calls.slice(-Math.max(1, Math.min(limit, 400))) };
  });

  const engineerReject = (jobId: string) => engineerAction(() => executor().engineerReject(jobId));
  app.post<{ Params: { job_id: string } }>("/api/engineer/jobs/:job_id/reply", async (request) => {
    const body = parse(EngineerReply, request.body);
    // Out of budget, and the user says stop: the job ends as given up.
    if (body.choice === STOP) return engineerReject(request.params.job_id);
    const attachments = api.attached(body.attachments);
    return engineerAction(() => executor().engineerReply(request.params.job_id, body.text, body.choice, attachments));
  });
  // Approve the plan (the engineer then makes the change) or the checked change (applied).
  app.post<{ Params: { job_id: string } }>("/api/engineer/jobs/:job_id/approve", async (request) =>
    engineerAction(() => executor().engineerApprove(request.params.job_id)));
  app.post<{ Params: { job_id: string } }>("/api/engineer/jobs/:job_id/reject", async (request) => engineerReject(request.params.job_id));

  // ---- Models and providers ----

  app.get("/api/channels/cli", async (request) => {
    const statuses = queryBool(request.query as Query, "refresh", false) ? providers().cli.refresh() : providers().cli.statuses;
    return Object.values(statuses).map((status) => ({ ...status }));
  });

  // Per model, over the last ``days``: how many calls it took, what they cost, and the tasks and chats
  // it worked on most, from the recorded model calls (calls.ts). A call that only handed work to
  // another model is counted once, as that model's.
  app.get("/api/models/usage", async (request) => {
    const days = Math.max(1, Math.min(queryInt(request.query as Query, "days", USAGE_DAYS), 366));
    const since = pythonIsoNow(-days);
    const totals: Record<string, Json> = {};
    for (const call of db.modelCallsSince(since)) {
      if (call.delegated || !call.model_id) continue;
      const entry = (totals[String(call.model_id)] ??= { calls: 0, cost_usd: 0, runs: {} as Record<string, number> });
      entry.calls += 1;
      entry.cost_usd += Number(call.cost_usd || 0);
      if (call.run_id) entry.runs[String(call.run_id)] = (entry.runs[String(call.run_id)] ?? 0) + 1;
    }
    const names = new Map<string, [string, string] | null>();
    for (const entry of Object.values(totals)) {
      const busiest = Object.entries(entry.runs as Record<string, number>).map(([runId, calls], index) => ({ runId, calls, index }))
        .sort((a, b) => b.calls - a.calls || a.index - b.index).slice(0, USAGE_RUNS);
      const usedIn: Json[] = [];
      for (const { runId, calls } of busiest) {
        if (!names.has(runId)) {
          const run = db.getRun(runId);
          names.set(runId, run ? [run.plan.title || run.plan.summary, run.kind] : null);
        }
        const name = names.get(runId);
        if (name) usedIn.push({ id: runId, title: name[0], kind: name[1], calls });
      }
      Object.assign(entry, { cost_usd: round6(entry.cost_usd), run_count: Object.keys(entry.runs).length, runs: usedIn });
    }
    return { days, since, models: totals };
  });

  // Only models with Artificial Analysis results (CLIs inherit them) are shown and routed.
  app.get("/api/models", async () => {
    const configured = providers().configuredModels(Object.keys(api.models));
    const matches = api.benchmarks.matchModels(Object.values(api.models));
    const statuses = providers().cli.statuses;
    return Object.values(api.models).filter((model) => model.scores_source === AA_SOURCE).map((model) => ({
      ...model, configured: configured.has(model.id), routing_ready: routingReady(model), benchmarks: matches.get(model.id) ?? [],
      auth_type: model.channel === "cli" ? statuses[model.id]?.auth_type ?? null : "api_key",
    }));
  });

  app.get("/api/models/sync", async () => api.catalogSync.status());
  app.post("/api/models/sync", async (_request, reply) => {
    api.catalogSync.trigger();
    return reply.code(202).send(api.catalogSync.status());
  });

  const updateModel = (modelId: string, enabled: boolean) => {
    const model = api.models[modelId];
    if (!model) throw new HttpError(404, "Model not found");
    if (enabled && !routingReady(model)) throw new HttpError(422, "模型尚缺少调度所需的评分、规格或价格，或已被来源标记为不可用。");
    model.enabled = enabled;
    db.saveModels([model]);
    return { id: model.id, enabled: model.enabled };
  };
  app.patch<{ Params: { model_id: string } }>("/api/models/:model_id", async (request) =>
    updateModel(request.params.model_id, parse(UpdateModel, request.body).enabled));
  app.patch("/api/models", async (request) => {
    const body = parse(UpdateModelById, request.body);
    return updateModel(body.model_id, body.enabled);
  });

  app.put<{ Params: { provider: string } }>("/api/providers/:provider/key", async (request) => {
    const body = parse(ProviderKey, request.body);
    let stored: string;
    try {
      stored = await api.deps.setProviderKey(request.params.provider, body.api_key);
    } catch (error) {
      if (isValueError(error)) throw new HttpError(400, (error as Error).message);
      throw error;
    }
    providers().quota.clearProvider(request.params.provider);
    return { stored };
  });

  app.get("/api/providers", async () => {
    const configured = new Set(configuredProviders());
    const locked = keyringUnavailable();
    // A key may be saved in the keyring, which is locked: it loads once unlocked.
    return Object.keys(PROVIDER_ENV).map((provider) => ({ id: provider, name: PROVIDER_LABELS[provider], configured: configured.has(provider),
      keyring_locked: !configured.has(provider) && locked }));
  });

  app.delete<{ Params: { provider: string } }>("/api/providers/:provider/key", async (request) => {
    try {
      return { removed: await deleteProviderKey(request.params.provider) };
    } catch (error) {
      if (isValueError(error)) throw new HttpError(400, (error as Error).message);
      throw error;
    }
  });

  app.post<{ Params: { provider: string } }>("/api/providers/:provider/test", async (request) => {
    try {
      return { ok: true, message: await providers().testProvider(request.params.provider) };
    } catch (error) {
      if (error instanceof ProviderError) throw new HttpError(400, error.message);
      throw error;
    }
  });

  // ---- Project folders ----

  app.get("/api/projects/discover", async (request) => api.discover(queryBool(request.query as Query, "refresh", false), () => discoverProjects()));

  app.get("/api/projects/inspect", async (request) => {
    try {
      return inspectProject(queryText(request.query as Query, "path"));
    } catch (error) {
      if (error instanceof ProjectDirError) throw new HttpError(400, error.message);
      throw error;
    }
  });

  app.get("/api/projects/native-picker", async () => nativePickerStatus());

  // Open the desktop folder dialog on the machine running this API.
  app.post("/api/projects/native-picker", async (request) => {
    try {
      return { path: await nativePickDirectory((request.query as Query).start ?? null) };
    } catch (error) {
      if (error instanceof NativePickerError) throw new HttpError(503, error.message);
      if (error instanceof ProjectDirError) throw new HttpError(400, error.message);
      if ((error as Error)?.name === "TimeoutError") throw new HttpError(408, "The folder dialog timed out");
      throw error;
    }
  });

  // ---- Raw uploads: an attachment, a capability package ----

  app.register(async (raw) => {
    raw.removeAllContentTypeParsers();
    raw.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
    const bytes = (request: FastifyRequest) => (Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0));

    // Raw file body; the name comes in the query so no multipart parser is needed.
    raw.post("/api/attachments", { bodyLimit: files.MAX_ATTACHMENT_BYTES }, async (request, reply) => {
      const name = (request.query as Query).name ?? "attachment";
      try {
        return reply.code(201).send(files.save(name, bytes(request)));
      } catch (error) {
        if (error instanceof files.AttachmentError) throw new HttpError(400, error.message);
        throw error;
      }
    });

    // Install a capability package (raw zip body), switched off until the user enables it. A new
    // version of an installed one replaces it, keeping its secrets and state.
    raw.post("/api/capabilities/upload", { bodyLimit: capabilities.MAX_CAPABILITY_BYTES }, async (request, reply) => {
      packagesAllowed();
      const data = bytes(request);
      try {
        const manifest = packages.read(data);
        await runner().stop(manifest.id);
        await api.services.stop(manifest.id);
        return reply.code(201).send(await packages.install(data));
      } catch (error) {
        if (error instanceof packages.PackageError) throw new HttpError(422, error.message);
        throw error;
      }
    });
  });

  app.get<{ Params: { attachment_id: string } }>("/api/attachments/:attachment_id/content", async (_request, reply) => {
    const item = files.get(_request.params.attachment_id);
    if (!item) throw new HttpError(404, "附件不存在");
    // Only detected raster images are shown inline; everything else downloads as plain bytes.
    const inline = item.kind === "image";
    return reply.headers({
      "content-type": inline ? item.media_type : "application/octet-stream", "content-disposition": disposition(inline ? "inline" : "attachment", item.name),
      "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'",
    }).send(createReadStream(files.path(item)));
  });

  // Discard an upload removed from the composer before the task was created.
  app.delete<{ Params: { attachment_id: string } }>("/api/attachments/:attachment_id", async (request, reply) => {
    const attachmentId = request.params.attachment_id;
    if (db.listRuns().some((run) => run.attachments.some((item) => item.id === attachmentId))) throw new HttpError(409, "附件属于已创建的任务，随任务一起删除。");
    if (db.engineerJobs(1000).some((job) => job.attachments.some((item) => item.id === attachmentId))) throw new HttpError(409, "附件已发给平台工程师。");
    if (!files.remove(attachmentId)) throw new HttpError(404, "附件不存在");
    return reply.code(204).send();
  });

  // ---- Tasks ----

  app.post("/api/tasks", async (request, reply) => reply.code(201).send(await api.newTask(parse(CreateTask, request.body))));

  // The user answered the plan's open choices (TaskPlan.choices) before confirming: when an answer
  // differs from what the lead assumed, the task is planned again with the answers, in place. Its id,
  // folder, budget and settings stay.
  app.post<{ Params: { run_id: string } }>("/api/tasks/:run_id/choices", async (request) => {
    const body = parse(ChoiceAnswers, request.body);
    const runId = request.params.run_id;
    const run = api.getTask(runId);
    if (run.status !== "awaiting_confirmation") throw new HttpError(409, "只有待确认的任务可以按选择重新规划。");
    if (body.picks.length !== run.plan.choices.length) throw new HttpError(422, "每条取舍都要有一个选择。");
    const decided = decidedChoices(run.plan.choices, body.picks);
    if (!decided) return run;
    if (api.replanning.has(runId)) throw new HttpError(409, "正在按你的选择重新规划，请稍候。");
    api.replanning.add(runId);
    let made;
    try {
      const parent = run.parent_run_id ? db.getRun(run.parent_run_id) : null;
      const again = CreateTask.parse({ prompt: run.prompt, attachments: run.attachments.map((item) => item.id), budget_usd: run.budget_usd,
        use_cli: run.use_cli, only_models: run.only_models, cli_only: run.cli_only, project_dir: run.project_dir, allow_network: run.allow_network });
      made = await api.makePlan(again, parent, decided);
    } finally {
      api.replanning.delete(runId);
    }
    const latest = api.getTask(runId);
    if (latest.status !== "awaiting_confirmation") throw new HttpError(409, "任务在重新规划期间已改变状态，新计划未采用。");
    latest.plan = made.plan;
    latest.improvement_uses = made.lessons;
    latest.supervisor = made.session.model_id ? made.session : latest.supervisor;
    latest.actual_cost_usd = round6(latest.actual_cost_usd + made.plan.planning_cost_usd);
    db.saveRun(latest);
    db.addEvent(event(runId, "plan.replanned", { decided, estimate: made.plan.estimate ?? null }));
    return latest;
  });

  // 需求变更: a new task that builds on this one's results instead of starting over. It works in the
  // same project, or the same scratch folder, and is planned knowing what exists.
  app.post<{ Params: { run_id: string } }>("/api/tasks/:run_id/followup", async (request, reply) => {
    const body = parse(FollowUp, request.body);
    const parent = api.getTask(request.params.run_id);
    if (!CHANGEABLE.has(parent.status)) throw new HttpError(409, "任务还在进行中，结束后才能提出需求变更。");
    return reply.code(201).send(await api.newTask(CreateTask.parse({
      prompt: body.prompt, attachments: body.attachments, budget_usd: body.budget_usd || parent.budget_usd,
      use_cli: body.use_cli ?? parent.use_cli, only_models: parent.only_models, cli_only: parent.cli_only, project_dir: parent.project_dir,
      allow_network: body.allow_network ?? parent.allow_network,
    }), parent));
  });

  // Every task; ``brief`` leaves out what only an opened task shows.
  app.get("/api/tasks", async (request, reply) => {
    const runs = await api.calibrated(db.listRuns());
    return unchangedOr(request, reply, JSON.stringify(queryBool(request.query as Query, "brief", false) ? runs.map(brief) : runs));
  });

  // Problems that came up in at least ``min_runs`` finished tasks, most frequent first.
  app.get("/api/retrospectives/recurring", async (request) =>
    retrospect.recurring(db, Math.max(1, queryInt(request.query as Query, "min_runs", 2))));
  // Problems across tasks grouped by what they are about (retrospect.topics).
  app.get("/api/retrospectives/topics", async (request) =>
    retrospect.topics(db, Math.max(1, queryInt(request.query as Query, "min_runs", 1))));

  // A finished task's look back: each step's estimate against its cost and turns, and its problems.
  app.get<{ Params: { run_id: string } }>("/api/tasks/:run_id/retrospective", async (request) => {
    const body = db.retrospective(request.params.run_id) ?? (uses.learning() ? retrospect.record(db, request.params.run_id) : null);
    if (!body) throw new HttpError(404, "Task not found or not finished");
    return body;
  });

  app.get<{ Params: { run_id: string } }>("/api/tasks/:run_id/calls", async (request) => {
    if (!db.getRun(request.params.run_id)) throw new HttpError(404, "Task not found");
    const records = db.modelCalls(request.params.run_id).filter((item) => !item.delegated);
    const total = (key: string) => records.reduce((sum, item) => sum + Number(item[key] || 0), 0);
    return { calls: records, limit: 1000, summary: { calls: records.length, requests: total("requests"),
      unknown_usage: records.filter((item) => !item.usage_known).length, observed_cost_usd: total("cost_usd"), input_tokens: total("input_tokens"),
      output_tokens: total("output_tokens"), cached_input_tokens: total("cached_input_tokens"), retries: total("retries") } };
  });

  // ---- Learning from tasks (learning.ts) ----

  app.get("/api/improvements/settings", async () => preferences(db));
  app.put("/api/improvements/settings", async (request) => {
    const body = parse(LearningSettingsSchema, request.body);
    db.saveLearningSettings(body);
    return body;
  });

  const improvementView = (item: Json) => {
    const job = item.engineer_job_id ? db.getEngineerJob(item.engineer_job_id) : null;
    return { ...item, effects: db.improvementEffects(item.id), engineer_job: job };
  };
  app.get("/api/improvements", async () => {
    executor().syncImprovements();
    return db.improvements().map(improvementView);
  });

  app.get<{ Params: { run_id: string } }>("/api/tasks/:run_id/learning", async (request) => {
    const runId = request.params.run_id;
    const run = api.getTask(runId);
    executor().syncImprovements();
    return {
      review: db.learningReview(runId), automatic_eligible: retrospect.AUTOMATIC.has(run.status),
      automatic_skip_reason: run.status === "cancelled" ? "任务已手动取消，不自动复盘。" : null,
      retrospective: db.retrospective(runId) ?? (uses.learning() && retrospect.AUTOMATIC.has(run.status) ? retrospect.record(db, runId) : null),
      improvements: db.improvements(runId).map(improvementView),
      applied: run.improvement_uses.map((use: Json) => ({ id: use.id, title: use.title, node_ids: use.node_ids ?? [], planning: use.planning ?? false,
        source_run_id: use.run_id })),
    };
  });

  app.post<{ Params: { run_id: string } }>("/api/tasks/:run_id/learning", async (request, reply) => {
    api.getTask(request.params.run_id);
    try {
      return reply.code(202).send(executor().startLearning(request.params.run_id, true));
    } catch (error) {
      if (error instanceof LearningProblem) throw new HttpError(409, error.message);
      throw error;
    }
  });

  app.post<{ Params: { item_id: string } }>("/api/improvements/:item_id/disable", async (request) => {
    const item = db.improvement(request.params.item_id);
    if (!item) throw new HttpError(404, "找不到改进项。");
    if (item.kind === "platform") throw new HttpError(409, "已应用的平台改动需要通过平台工程师回退；未应用的工作可在工程师中放弃。");
    if (item.status !== "active") throw new HttpError(409, "只能停用已生效的 Skill 或执行规则。");
    item.status = "disabled";
    if (item.kind === "skill") skills.removeLesson(item.id);
    db.saveImprovement(item);
    return item;
  });

  // A task as its page shows it. Left out, as the page does not show them or reads them when shown:
  // changed files past the first ones, each tool call's output and the end of a long command, and the
  // lead's own conversation with its model.
  app.get<{ Params: { run_id: string } }>("/api/tasks/:run_id", async (request, reply) => {
    const [run] = await api.calibrated([api.getTask(request.params.run_id)]);
    for (const node of run.plan.nodes) {
      // The page lists the first files and the count; a simulation can leave megabytes of names.
      if (node.changed_files.length > SHOWN_CHANGED_FILES) {
        node.changed_files_total = node.changed_files.length;
        node.changed_files = node.changed_files.slice(0, SHOWN_CHANGED_FILES);
      }
      for (const attempt of node.attempts) {
        for (const call of attempt.tool_calls) {
          if (call.output) [call.output_size, call.output] = [[...call.output].length, ""];
          call.detail = [...call.detail].slice(0, SHOWN_COMMAND_CHARS).join("");
        }
      }
    }
    if (run.supervisor) run.supervisor.history = [];
    return unchangedOr(request, reply, JSON.stringify(run));
  });

  // What one tool call of a step's attempt returned, read when the page shows it.
  app.get<{ Params: { run_id: string; node_id: string; attempt: string; call: string } }>(
    "/api/tasks/:run_id/nodes/:node_id/attempts/:attempt/calls/:call/output", async (request) => {
      const node = api.getTask(request.params.run_id).plan.nodes.find((item) => item.id === request.params.node_id);
      const attempt = intParam(request.params, "attempt");
      const call = intParam(request.params, "call");
      const found = node ? pyIndex(pyIndex(node.attempts, attempt)?.tool_calls ?? [], call) : undefined;
      if (!found) throw new HttpError(404, "没有这次工具调用");
      return { output: found.output };
    });

  app.delete<{ Params: { run_id: string } }>("/api/tasks/:run_id", async (request, reply) => {
    const runId = request.params.run_id;
    const current = executor();
    if ([current.tasks, current.diagnosing, current.learningTasks, current.capabilityTasks].some((tasks) => {
      const task = tasks.get(runId);
      return task && !task.done;
    })) throw new HttpError(409, "任务仍在执行或结束处理中，请稍后再删除。");
    const existing = db.getRun(runId);
    if (db.engineerJobs(1000).some((job) => job.run_id === runId && job.improvement_id && !["applied", "failed", "rejected", "cancelled"].includes(job.status))) {
      throw new HttpError(409, "该任务的改进仍由平台工程师处理，请完成或放弃后再删除。");
    }
    let deleted: boolean;
    try {
      // A chat is a draft that never runs; a draft task is not deleted (only finished ones are).
      deleted = db.deleteRun(runId, existing?.kind === "chat");
    } catch (error) {
      throw new HttpError(409, (error as Error).message);
    }
    if (!deleted) throw new HttpError(404, "Task not found");
    rmSync(join(settings.data_dir, "traces", runId), { recursive: true, force: true });
    current.tasks.delete(runId);
    current.learningTasks.delete(runId);
    current.locks.delete(runId);
    current.reservations.delete(runId);
    current.budgetEvents.delete(runId);
    for (const item of existing?.attachments ?? []) files.remove(item.id);
    return reply.code(204).send();
  });

  /** The models a task may use now: without the mock when it was routed to real ones, without the
   *  CLIs when it does not use them. */
  const configuredForRun = (run: ExecutionRun) => {
    let configured = providers().configuredModels(Object.keys(api.models));
    if (run.plan.nodes.some((node) => node.model_id && !node.model_id.startsWith("mock:"))) configured = new Set([...configured].filter((id) => !id.startsWith("mock:")));
    if (!run.use_cli) configured = new Set([...configured].filter((id) => !id.startsWith("cli:")));
    return configured;
  };
  const required = (run: ExecutionRun) => run.actual_cost_usd + run.plan.nodes.filter((node) => node.status !== "succeeded")
    .reduce((sum, node) => sum + node.estimated_cost_usd, 0);
  const checkBudget = (run: ExecutionRun, budgetUsd: number) => {
    const needed = required(run);
    if (needed > budgetUsd) throw new HttpError(409, `Budget $${fixed(budgetUsd, 2)} is below the $${fixed(needed, 4)} needed to finish this task`);
  };
  const notWaiting = (run: ExecutionRun) => {
    if (run.waiting_diagnosis_id || run.maintenance_id) throw new HttpError(409, "请先回复平台工程师的问题，或等待平台修复自动生效。");
    if (run.engineer_job_id) throw new HttpError(409, "任务在等平台工程师添加组件：请在负责人对话里的平台工程师卡片上批准或放弃这项工作。");
    const diagnosis = executor().diagnosing.get(run.id);
    if (diagnosis && !diagnosis.done) throw new HttpError(409, "平台工程师还在查或修，完成后会自动继续；也可以取消任务。");
  };
  // A request that needs chats, when there is no chat package.
  const chatRequired = () => {
    if (!chat.enabled()) throw new HttpError(409, chat.NOT_ENABLED);
  };
  const routing = async (work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      if (error instanceof NoEligibleModelError) throw new HttpError(422, error.message);
      throw error;
    }
  };

  app.post<{ Params: { run_id: string } }>("/api/tasks/:run_id/confirm", async (request) => {
    const body = parse(ConfirmTask, request.body);
    const run = api.getTask(request.params.run_id);
    notWaiting(run);
    if (run.status !== "awaiting_confirmation" && run.status !== "paused") throw new HttpError(409, `Cannot confirm task in ${pyStatus(run.status)} status`);
    const budgetUsd = body.budget_usd ?? run.budget_usd;
    const configured = configuredForRun(run);
    const catalog = Object.values(api.models);
    const needsVision = run.attachments.some((item) => item.kind === "image");
    await routing(async () => {
      for (const node of run.plan.nodes) {
        if (node.status === "succeeded" || node.status === "running") continue;
        if (run.plan.employees.length) {
          await team.route(node, run.plan, catalog, configured, needsVision);
          continue;
        }
        if (!eligibleForNode(node, catalog, configured, needsVision).some((model) => model.id === node.model_id)) await routeNode(node, catalog, configured, needsVision);
      }
    });
    checkBudget(run, budgetUsd);
    run.budget_usd = budgetUsd;
    if (run.plan.estimate) run.plan.estimate.hard_limit_usd = budgetUsd;
    // A task paused after a diagnosis continues with its failed steps run again.
    const reopened = run.plan.nodes.filter((node) => node.status === "failed").map((node) => node.id);
    for (const node of run.plan.nodes) if (reopened.includes(node.id)) reopenNode(run, node);
    if (reopened.length) run.rework_rounds = 0;
    // Whatever paused the task, the user has now seen it and continued: the message is done.
    run.error = null;
    // The user said go on: the lead gets a fresh allowance of decisions.
    run.decisions_since = new Date().toISOString();
    // A task paused by the user may still be finishing its running steps; that loop goes on.
    const task = executor().tasks.get(run.id);
    run.status = task && !task.done ? "running" : "queued";
    db.saveRun(run);
    db.addEvent(event(run.id, "run.confirmed", { budget_usd: run.budget_usd, reopened }));
    executor().start(run.id);
    return run;
  });

  // Stop starting new steps; steps already running finish and keep their results.
  app.post<{ Params: { run_id: string } }>("/api/tasks/:run_id/pause", async (request) => {
    const runId = request.params.run_id;
    const first = api.getTask(runId);
    if (first.status !== "queued" && first.status !== "running" && !first.maintenance_id) throw new HttpError(409, `Cannot pause task in ${pyStatus(first.status)} status`);
    const run = await executor().locked(runId, () => {
      const latest = api.getTask(runId);
      Object.assign(latest, { status: "paused", waiting_diagnosis_id: null, maintenance_id: null, error: null });
      db.saveRun(latest);
      return latest;
    });
    const running = run.plan.nodes.filter((node) => node.status === "running").map((node) => node.id);
    db.addEvent(event(run.id, "approval.required", { reason: "user_paused", running }));
    return run;
  });

  // Ask a strong model (a membership CLI when possible) why the task is stuck.
  const diagnosisRequired = () => {
    if (uses.stuckWaits()) throw new HttpError(409, "没有启用平台工程师能力：不能诊断。");
  };
  app.post<{ Params: { run_id: string } }>("/api/tasks/:run_id/diagnose", async (request) => {
    diagnosisRequired();
    const runId = request.params.run_id;
    const [run, diagnosisId] = await executor().locked(runId, () => {
      if (executor().platformPending) throw new HttpError(409, "平台修复正在自动生效，请稍候再请平台工程师。");
      const latest = api.getTask(runId);
      const failed = latest.plan.nodes.find((node) => node.status === "failed" || node.status === "unable")?.id
        ?? latest.plan.nodes.find((node) => node.status === "pending" && node.attempts.length)?.id ?? null;
      const started = executor().beginDiagnosis(latest, "manual", failed);
      if (started === null && (!latest.diagnoses.length || latest.diagnoses.at(-1)!.status !== "failed")) throw new HttpError(409, "平台工程师正在查，请稍候。");
      db.saveRun(latest);
      return [latest, started] as const;
    });
    if (diagnosisId) executor().startDiagnosis(run.id, diagnosisId);
    return run;
  });

  // Allow or forbid the internet for this task's commands, from its next model call on.
  app.put<{ Params: { run_id: string } }>("/api/tasks/:run_id/network", async (request) => {
    const body = parse(NetworkAccess, request.body);
    const runId = request.params.run_id;
    return executor().locked(runId, () => {
      const run = api.getTask(runId);
      if (run.allow_network !== body.allow) {
        run.allow_network = body.allow;
        db.saveRun(run);
        executor().emit(runId, "run.network_changed", { allow: body.allow });
      }
      return run;
    });
  });

  // Write to the task's lead, in the conversation it keeps for this task (supervisor.ts). The message
  // is saved at once; the lead's answer follows in ``lead_messages``.
  app.post<{ Params: { run_id: string } }>("/api/tasks/:run_id/lead", async (request, reply) => {
    const body = parse(LeadQuestion, request.body);
    const runId = request.params.run_id;
    // A chat goes on only with the chat capability; a task's lead only with the lead capability.
    if (api.getTask(runId).kind === "chat") chatRequired();
    else if (!uses.lead()) throw new HttpError(409, "没有启用负责人能力：任务里不能对话。");
    const attached = api.attached(body.attachments);
    const message = body.message.trim() || (attached.length ? "（见附件）" : "");
    if (!message) throw new HttpError(422, "请写下要说的话，或附上文件。");
    let started: boolean;
    try {
      started = executor().startLeadChat(runId, message, attached);
    } catch (error) {
      if (error instanceof files.AttachmentError) throw new HttpError(422, error.message);
      throw error;
    }
    if (!started) throw new HttpError(409, "负责人还在回答上一条消息，请稍候。");
    return reply.code(202).send(api.getTask(runId));
  });

  // ---- Chats ----

  app.get("/api/chats/models", async (request) => (chat.enabled() ? await api.chatChoices(queryBool(request.query as Query, "use_cli", true)) : [])
    .map((model) => ({ id: model.id, display_name: model.display_name, channel: model.channel })));

  // Only a conversation: no plan, no steps. The model may read the project folder, if one is given
  // (a CLI's read-only lead conversation there); it edits nothing. The first message is answered in
  // the background, as in a task's conversation with its lead.
  app.post("/api/chats", async (request, reply) => {
    const body = parse(CreateChat, request.body);
    chatRequired();
    return reply.code(201).send(await api.startChat(body.message, body.budget_usd, body.use_cli, body.project_dir, body.model_id, body.attachments));
  });

  // Start what the user typed as a chat or a task, decided by triage.classify (told the names of any
  // attachments, which go with either). Deciding is billed to whichever it becomes.
  app.post("/api/start", async (request, reply) => {
    const body = parse(StartRequest, request.body);
    const attached = api.attached(body.attachments, 400);
    // Without the chat capability everything typed is a task.
    const [kind, spent] = chat.enabled() ? await api.deps.classify(body.prompt + files.describe(attached, false), providers(),
      await briefWriter(Object.values(api.models), api.configured())) : ["task", 0];
    if (kind === "chat") {
      return reply.code(201).send(await api.startChat(body.prompt, body.budget_usd, body.use_cli, body.project_dir, body.model_id, body.attachments,
        { autoRouted: true, spent }));
    }
    const run = await api.newTask(body);
    const latest = api.getTask(run.id);
    latest.auto_routed = true;
    latest.actual_cost_usd = round6(latest.actual_cost_usd + spent);
    db.saveRun(latest);
    return reply.code(201).send(latest);
  });

  // A task waiting for confirmation was only a question: keep it as a chat instead, answered by the
  // best chat model from its request. Its plan is dropped; planning stays paid.
  app.post<{ Params: { run_id: string } }>("/api/tasks/:run_id/as-chat", async (request) => {
    const runId = request.params.run_id;
    const run = api.getTask(runId);
    if (run.kind !== "task" || run.status !== "awaiting_confirmation" || run.parent_run_id) throw new HttpError(409, "只有待确认的新任务可以改成对话。");
    if (api.replanning.has(runId)) throw new HttpError(409, "正在重新规划，请稍候。");
    chatRequired();
    const pick = (await api.chatChoices(run.use_cli, run.attachments.some((item) => item.kind === "image")))[0];
    if (!pick) throw new HttpError(422, "没有可用来对话的模型：请先配置会员 CLI 或 API 模型。");
    Object.assign(run, { kind: "chat", status: "draft", plan: chatPlan(run.prompt, run.project_dir), supervisor: supervisor.newSession(pick, null, run.project_dir) });
    db.saveRun(run);
    db.addEvent(event(runId, "task.to_chat", { model_id: pick.id }));
    executor().startLeadChat(runId, run.prompt);
    return api.getTask(runId);
  });

  // Turn a chat into a task, in place: it is planned with the conversation as its background and
  // waits for confirmation like any new task. Its id and messages stay.
  app.post<{ Params: { run_id: string } }>("/api/tasks/:run_id/promote", async (request) => {
    const body = parse(PromoteChat, request.body);
    const runId = request.params.run_id;
    const run = api.getTask(runId);
    if (run.kind !== "chat" || run.status !== "draft") throw new HttpError(409, "只有对话可以转成任务。");
    const answering = executor().leadTasks.get(runId);
    if ((answering && !answering.done) || api.replanning.has(runId)) throw new HttpError(409, "对方还在回复，请等它说完再转成任务。");
    const prompt = body.prompt.trim() || run.prompt;
    if ([...prompt].length < 3) throw new HttpError(422, "请写清要完成的工作。");
    const useCli = body.use_cli ?? run.use_cli;
    chatRequired();
    const context = "这个任务来自用户和模型的一段对话，对话内容如下（供参考，以“新需求”为准）：\n" + await chat.transcript(run);
    // The chat's attachments go with it: the planner and the steps see them as a task's own.
    const given = CreateTask.parse({ prompt, budget_usd: body.budget_usd, use_cli: useCli, project_dir: run.project_dir, allow_network: body.allow_network,
      attachments: [...new Set([...run.attachments.map((item) => item.id), ...body.attachments])] });
    api.replanning.add(runId);
    let made;
    try {
      made = await api.makePlan(given, null, "", context);
    } finally {
      api.replanning.delete(runId);
    }
    const latest = api.getTask(runId);
    if (latest.kind !== "chat" || latest.status !== "draft") throw new HttpError(409, "对话在规划期间已改变，新计划未采用。");
    Object.assign(latest, { kind: "task", status: "awaiting_confirmation", prompt, plan: made.plan, budget_usd: body.budget_usd, use_cli: useCli,
      allow_network: body.allow_network, background: made.background, improvement_uses: made.lessons });
    // The planner leads the task from here; the chat's messages stay in its conversation.
    latest.supervisor = made.session.model_id ? made.session : latest.supervisor;
    latest.actual_cost_usd = round6(latest.actual_cost_usd + made.plan.planning_cost_usd);
    if (!latest.project_dir) latest.folder_name = taskFolder(made.plan.folder || made.plan.summary || prompt);
    db.saveRun(latest);
    db.addEvent(event(runId, "chat.promoted", { estimate: made.plan.estimate ?? null, planner_model_id: made.plan.planner_model_id }));
    return latest;
  });

  // A choice and/or free text is persisted before starting the next diagnosis.
  app.post<{ Params: { run_id: string; diagnosis_id: string } }>("/api/tasks/:run_id/diagnoses/:diagnosis_id/reply", async (request) => {
    const body = parse(DiagnosisReply, request.body);
    const { run_id: runId, diagnosis_id: diagnosisId } = request.params;
    const [run, following] = await executor().locked(runId, () => {
      const latest = api.getTask(runId);
      const previous = latest.diagnoses.find((item) => item.id === diagnosisId);
      if (!previous) throw new HttpError(404, "没有这条记录。");
      const busy = executor().diagnosing.get(runId);
      if ((busy && !busy.done) || executor().platformPending) throw new HttpError(409, "平台工程师这次还没做完，请完成后再补充。");
      const said = body.text.trim();
      const choice = body.choice ? body.choice.trim() : null;
      const attached = api.attached(body.attachments);
      if (choice && !previous.choices.includes(choice)) throw new HttpError(422, "所选方案不在这次给出的方案里，请重新选择。");
      if (!said && !choice && !attached.length) throw new HttpError(422, "请选择一个方案或填写你的想法。");
      try {
        // The files join the task's: the lead is given them with its next call, the steps see them.
        files.attach(latest, attached);
      } catch (error) {
        if (error instanceof files.AttachmentError) throw new HttpError(422, error.message);
        throw error;
      }
      previous.messages.push(DiagnosisMessageSchema.parse({ text: said || (attached.length ? "（见附件）" : ""), choice, attachments: attached }));
      if (choice === NETWORK_CHOICE && !latest.allow_network) {
        // A diagnosis or the lead asked whether the task may use the internet; the answer applies at once.
        latest.allow_network = true;
        executor().emit(runId, "run.network_changed", { allow: true });
      }
      if (previous.trigger === "lead") {
        // The task's lead asked: the answer goes back to it, in its conversation.
        if (latest.waiting_diagnosis_id === diagnosisId) latest.waiting_diagnosis_id = null;
        db.saveRun(latest);
        executor().emit(runId, "run.diagnosis_reply", { diagnosis_id: diagnosisId, choice, text: said });
        executor().startLeadAnswer(runId, diagnosisId);
        return [latest, null] as const;
      }
      const focus = previous.node_id ?? latest.plan.nodes.find((node) => node.status === "failed")?.id ?? null;
      diagnosisRequired();
      const next = executor().beginDiagnosis(latest, "manual", focus);
      latest.diagnoses.at(-1)!.reply_to = diagnosisId;
      if (!next && latest.waiting_diagnosis_id === diagnosisId) latest.waiting_diagnosis_id = null;
      db.saveRun(latest);
      executor().emit(runId, "run.diagnosis_reply", { diagnosis_id: diagnosisId, next_diagnosis_id: next, choice, text: said });
      return [latest, next] as const;
    });
    if (following) executor().startDiagnosis(runId, following);
    return run;
  });

  // Continue a failed, cancelled or incomplete task from where it stopped: finished nodes keep their
  // results; the others run again with fresh attempts and rework rounds.
  app.post<{ Params: { run_id: string } }>("/api/tasks/:run_id/resume", async (request) => {
    const body = parse(ConfirmTask, request.body);
    const runId = request.params.run_id;
    const run = api.getTask(runId);
    notWaiting(run);
    if (!["failed", "cancelled", "incomplete"].includes(run.status)) throw new HttpError(409, `Cannot resume task in ${pyStatus(run.status)} status`);
    const task = executor().tasks.get(runId);
    if (task && !task.done) throw new HttpError(409, "任务仍在结束处理中，请稍后再继续。");
    const configured = configuredForRun(run);
    const needsVision = run.attachments.some((item) => item.kind === "image");
    const catalog = Object.values(api.models);
    const reopened: string[] = [];
    await routing(async () => {
      for (const node of run.plan.nodes) {
        if (node.status === "succeeded") continue;
        if (["failed", "cancelled", "running", "unable", "blocked"].includes(node.status)) {
          reopened.push(node.id);
          reopenNode(run, node);
        }
        // Its model was disabled or lost its key since; pick again under current rules.
        if (!eligibleForNode(node, catalog, configured, needsVision).some((model) => model.id === node.model_id)) await routeNode(node, catalog, configured, needsVision);
      }
    });
    const budgetUsd = body.budget_usd ?? run.budget_usd;
    checkBudget(run, budgetUsd);
    Object.assign(run, { budget_usd: budgetUsd, rework_rounds: 0, error: null, decisions_since: new Date().toISOString(), status: "queued" });
    if (run.plan.estimate) run.plan.estimate.hard_limit_usd = budgetUsd;
    db.saveRun(run);
    db.addEvent(event(run.id, "run.resumed", { budget_usd: budgetUsd, reopened }));
    executor().start(run.id);
    return run;
  });

  app.post<{ Params: { run_id: string } }>("/api/tasks/:run_id/cancel", async (request) => {
    const runId = request.params.run_id;
    const run = api.getTask(runId);
    const diagnosis = executor().diagnosing.get(runId);
    if (FINISHED.has(run.status) && !(diagnosis && !diagnosis.done)) throw new HttpError(409, "Task has already finished");
    // A component the lead asked for stays with the platform engineer; the user decides on it there.
    Object.assign(run, { status: "cancelled", waiting_diagnosis_id: null, maintenance_id: null, engineer_job_id: null });
    db.saveRun(run);
    db.addEvent(event(run.id, "run.cancelled"));
    executor().cancel(run.id);
    return run;
  });

  // What the steps know how to use (skills.ts): this machine's skills, then the platform's.
  app.get("/api/skills", async () => skills.library().map((item) => ({ name: item.name, description: item.description, summary: item.summary,
    tools: item.tools, machine: item.machine })));

  // ---- Capabilities: what finished tasks left the platform able to do (capabilities.ts) ----

  app.get("/api/capabilities", async () => capabilities.library());

  const capability = (capabilityId: string): Capability => {
    const found = capabilities.load(capabilityId);
    if (!found) throw new HttpError(404, "没有这个能力。");
    return found;
  };
  const packagesAllowed = () => {
    if (!settings.capability_packages) throw new HttpError(409, "本机还没开启能力包：在 .env 里设 FLUIDFORM_CAPABILITY_PACKAGES=true 后重启。");
  };

  // Use it again, or stop telling later work about it (an automation: start or stop it). A failed one
  // stays failed until fixed.
  app.patch<{ Params: { capability_id: string } }>("/api/capabilities/:capability_id", async (request) => {
    const body = parse(CapabilitySwitch, request.body);
    const item = capability(request.params.capability_id);
    if (item.status === "failed" && body.enabled) throw new HttpError(409, "这个能力的检查没有通过，修好之前不能启用。");
    const runs = item.kind === "automation" && item.source === "upload";
    if (body.enabled && item.source === "upload") {
      // An interface runs nothing here: a web page FluidForm serves.
      if (item.kind !== "interface" && item.kind !== "extension") packagesAllowed();
      if (!body.confirmed) throw new HttpError(409, "启用上传的能力要先确认它能访问的域名和拿到的密钥。");
      const lacking = Object.entries(await packages.secretsSet(item)).filter(([, stored]) => !stored).map(([name]) => name);
      if (lacking.length) throw new HttpError(409, `先填好：${lacking.join("、")}`);
    }
    // What it needs must be there, and what it provides must not come from another package; what
    // others need from it keeps it on.
    const problem = body.enabled ? services.enableProblem(item) : item.status === "active" ? services.disableProblem(item) : null;
    if (problem) throw new HttpError(409, problem);
    item.status = body.enabled ? "active" : "disabled";
    capabilities.save(item);
    if (runs && body.enabled && item.entry) runner().start(item);
    else if (runs) await runner().stop(item.id);
    if (item.kind === "service" && item.source === "upload") {
      if (body.enabled && item.entry) api.services.start(item);
      else await api.services.stop(item.id);
    }
    return item;
  });

  // Who provides each capability FluidForm itself uses: a package's id, or nobody.
  app.get("/api/capabilities/provided", async () => services.providers());

  // Remove it; a package is uninstalled with its data, state and secrets.
  app.delete<{ Params: { capability_id: string } }>("/api/capabilities/:capability_id", async (request, reply) => {
    const item = capability(request.params.capability_id);
    const problem = item.status === "active" ? services.disableProblem(item) : null;
    if (problem) throw new HttpError(409, problem);
    if (item.kind === "extension") throw new HttpError(409, "随 FluidForm 提供的扩展不能卸载，只能停用。");
    if (item.source === "upload") {
      await runner().stop(item.id);
      runner().forget(item.id);
      await api.services.stop(item.id);
      await packages.uninstall(item);
    } else if (!capabilities.remove(item.id)) throw new HttpError(404, "没有这个能力。");
    return reply.code(204).send();
  });

  // Each package's secrets stored, and each automation's state, log and budget.
  app.get("/api/capabilities/runtime", async () => {
    const found: Record<string, Json> = {};
    for (const item of capabilities.library()) {
      if (item.source !== "upload") continue;
      const entry: Json = { secrets: await packages.secretsSet(item) };
      if (item.kind === "automation") Object.assign(entry, runner().get(item.id).public());
      if (item.kind === "service") Object.assign(entry, api.services.get(item.id).public());
      found[item.id] = entry;
    }
    return { available: settings.capability_packages, missing: sandboxMissing(), capabilities: found, provided: services.providers() };
  });

  // Keep its secrets in the keyring (never in a file); a running automation restarts with them.
  app.put<{ Params: { capability_id: string } }>("/api/capabilities/:capability_id/secrets", async (request) => {
    const body = parse(CapabilitySecrets, request.body);
    const item = capability(request.params.capability_id);
    const unknown = Object.keys(body.values).filter((name) => !item.secrets.includes(name)).sort();
    if (unknown.length) throw new HttpError(422, `它没有声明这些密钥：${unknown.join("、")}`);
    for (const [name, value] of Object.entries(body.values)) {
      if (value.trim()) await secretStore.setSecret(packages.secretName(item.id, name), value.trim());
    }
    await runner().restart(item);
    if (item.kind === "service" && item.status === "active" && api.services.running(item.id)) {
      await api.services.stop(item.id);
      api.services.start(item);
    }
    return { secrets: await packages.secretsSet(item) };
  });

  app.delete<{ Params: { capability_id: string } }>("/api/capabilities/:capability_id/secrets", async (request, reply) => {
    const item = capability(request.params.capability_id);
    // Without its secrets it stops: not while others need what it provides.
    const problem = item.status === "active" ? services.disableProblem(item) : null;
    if (problem) throw new HttpError(409, problem);
    await runner().stop(item.id);
    await api.services.stop(item.id);
    if (item.status === "active" && (item.kind === "automation" || item.kind === "service")) {
      item.status = "disabled";
      capabilities.save(item);
    }
    for (const name of item.secrets) await secretStore.deleteSecret(packages.secretName(item.id, name));
    return reply.code(204).send();
  });

  // What an automation may spend a day deciding and answering.
  app.put<{ Params: { capability_id: string } }>("/api/capabilities/:capability_id/budget", async (request) => {
    const body = parse(CapabilityBudget, request.body);
    const item = runner().get(capability(request.params.capability_id).id);
    item.state.daily_budget_usd = body.daily_budget_usd;
    item.save();
    return item.public();
  });

  // Save an automation's chat model. Each chat adopts it before its next reply, after any active
  // reply finishes; classification and task planning retain their own model policies.
  app.put<{ Params: { capability_id: string } }>("/api/capabilities/:capability_id/model", async (request) => {
    const body = parse(CapabilityModel, request.body);
    const found = capability(request.params.capability_id);
    if (found.source !== "upload" || found.kind !== "automation") throw new HttpError(422, "只有上传的自动化能力可以设置聊天模型。");
    const modelId = body.model_id || null;
    if (modelId && !api.chatModels().some((model) => model.id === modelId)) throw new HttpError(422, "这个模型暂不可用或不能用来对话，请重新选择。");
    const item = runner().get(found.id);
    const previous = item.state.model_id;
    item.state.model_id = modelId;
    try {
      item.save();
    } catch (error) {
      item.state.model_id = previous;
      throw error;
    }
    return item.public();
  });

  const proposal = (run: ExecutionRun, index: number) => {
    if (index < 0 || index >= run.capability_proposals.length) throw new HttpError(404, "没有这条提议。");
    const found = run.capability_proposals[index];
    if (found.status !== "proposed") throw new HttpError(409, "这条提议已经处理过。");
    return found;
  };

  // The user keeps what the task built: copied out of the task's folder and checked in a step's
  // sandbox; later steps and planners are told about it (docs/design/capabilities.md).
  app.post<{ Params: { run_id: string; index: string } }>("/api/tasks/:run_id/capabilities/:index/solidify", async (request) => {
    const runId = request.params.run_id;
    const index = intParam(request.params, "index");
    const run = api.getTask(runId);
    const card = proposal(run, index);
    let made: Capability;
    try {
      made = await capabilities.solidify(run, card);
    } catch (error) {
      if (error instanceof capabilities.SourceError) throw new HttpError(422, error.message);
      throw error;
    }
    const latest = api.getTask(runId);
    Object.assign(latest.capability_proposals[index], { status: "solidified", capability_id: made.id });
    db.saveRun(latest);
    db.addEvent(event(runId, "capability.solidified", { capability_id: made.id, status: made.status }));
    return latest;
  });

  app.post<{ Params: { run_id: string; index: string } }>("/api/tasks/:run_id/capabilities/:index/dismiss", async (request) => {
    const run = api.getTask(request.params.run_id);
    proposal(run, intParam(request.params, "index")).status = "dismissed";
    db.saveRun(run);
    return run;
  });

  // ---- A task's files, and publishing them ----

  app.get("/api/github", async () => ({ token: Boolean(process.env[SECRET_ENV.github]), git: which("git") !== null }));
  app.put("/api/github/token", async (request) => ({ stored: await api.deps.setProviderKey("github", parse(GithubToken, request.body).token.trim()) }));
  app.delete("/api/github/token", async () => ({ removed: await deleteProviderKey("github") }));

  app.get<{ Params: { run_id: string } }>("/api/tasks/:run_id/files", async (request) => {
    const run = api.getTask(request.params.run_id);
    return { root: publish.outputRoot(run), in_project: Boolean(run.project_dir), files: publish.outputFiles(run), github_url: run.github_url };
  });

  app.get<{ Params: { run_id: string } }>("/api/tasks/:run_id/files/content", async (request) => {
    const path = queryText(request.query as Query, "path");
    try {
      return { path, text: publish.readOutput(api.getTask(request.params.run_id), path) };
    } catch (error) {
      if (error instanceof publish.PublishError) throw new HttpError(400, error.message);
      throw error;
    }
  });

  app.get<{ Params: { run_id: string } }>("/api/tasks/:run_id/archive", async (request, reply) => {
    const run = api.getTask(request.params.run_id);
    let data: Buffer;
    try {
      data = publish.archive(run);
    } catch (error) {
      if (error instanceof publish.PublishError) throw new HttpError(400, error.message);
      throw error;
    }
    return reply.type("application/zip").header("content-disposition", `attachment; filename="${publish.slug(run)}.zip"`).send(data);
  });

  // Commit the task's output to a new or empty GitHub repository.
  app.post<{ Params: { run_id: string } }>("/api/tasks/:run_id/github", async (request) => {
    const body = parse(PublishRequest, request.body);
    const run = api.getTask(request.params.run_id);
    if (run.project_dir) throw new HttpError(409, "项目任务的改动在你自己的仓库里，请在项目中提交并推送。");
    if (run.status !== "succeeded") throw new HttpError(409, "任务完成后才能上传。");
    const token = process.env[SECRET_ENV.github];
    let url: string;
    try {
      if (body.remote) {
        const remote = publish.checkRemote(body.remote);
        publish.pushSnapshot(run, remote);
        url = remote.replace("git@github.com:", "https://github.com/").replace(/\.git\/?$/, "");
      } else {
        if (!token) throw new publish.PublishError("还没有保存 GitHub 令牌；可以先保存令牌，或填写已建好的空仓库地址。");
        const name = (body.name || publish.slug(run)).trim();
        if (!publish.REPO_NAME.test(name)) throw new publish.PublishError("仓库名只能包含字母、数字、点、横线和下划线");
        const repo = await publish.createRepository(token, name, body.private, body.description || run.plan.summary, providers().fetch);
        publish.pushSnapshot(run, repo.clone_url, token);
        url = repo.html_url;
      }
    } catch (error) {
      if (error instanceof publish.PublishError) throw new HttpError(400, error.message);
      throw error;
    }
    run.github_url = url;
    db.saveRun(run);
    db.addEvent(event(run.id, "run.published", { url }));
    return { url };
  });

  // ---- What a task is doing ----

  // All events of a task so far, oldest first, for the plan view's progress panel.
  app.get<{ Params: { run_id: string } }>("/api/tasks/:run_id/timeline", async (request) => {
    if (!db.getRun(request.params.run_id)) throw new HttpError(404, "Task not found");
    return db.events(request.params.run_id, queryInt(request.query as Query, "after", 0));
  });

  // What a chat is doing while it answers with tools (supervisor.ChatActivity): empty otherwise.
  app.get<{ Params: { run_id: string } }>("/api/tasks/:run_id/lead/activity", async (request) => {
    api.getTask(request.params.run_id);
    const calls = [...(supervisor.CHAT_ACTIVITY.get(request.params.run_id) ?? [])];
    return { running: supervisor.CHAT_ACTIVITY.has(request.params.run_id), total: calls.length, calls: calls.slice(-200) };
  });

  // What a running step has done so far in this attempt (activity.ts): an API model's tool calls, or
  // a CLI's commands, file changes and messages; empty when it is not running.
  app.get<{ Params: { run_id: string; node_id: string } }>("/api/tasks/:run_id/nodes/:node_id/activity", async (request) => {
    const { run_id: runId, node_id: nodeId } = request.params;
    const limit = queryInt(request.query as Query, "limit", 200);
    const run = db.getRun(runId);
    if (!run || !run.plan.nodes.some((node) => node.id === nodeId)) throw new HttpError(404, "Step not found");
    const key = stepKey(runId, nodeId);
    const calls = [...(executor().toolLogs.get(key) ?? [])];
    return { running: executor().toolLogs.has(key), total: calls.length, calls: calls.slice(-Math.max(1, Math.min(limit, 400))) };
  });

  app.get<{ Params: { run_id: string } }>("/api/tasks/:run_id/events", async (request, reply) => {
    const runId = request.params.run_id;
    const after = queryInt(request.query as Query, "after", 0);
    if (!db.getRun(runId)) throw new HttpError(404, "Task not found");
    const closed = new AbortController();
    request.raw.once("close", () => closed.abort());
    return reply.type("text/event-stream; charset=utf-8").send(Readable.from(api.events(runId, after, closed.signal)));
  });

  return app;
}

// ---- Small helpers ----

/** Now, shifted by ``days``, as Python's isoformat writes it (the database's times compare as text). */
function pythonIsoNow(days: number): string {
  return pythonIso(new Date(Date.now() + days * 86_400_000));
}

/** ``items[index]`` as Python indexes: negative from the end; undefined when out of range. */
function pyIndex<T>(items: T[], index: number): T | undefined {
  const at = index < 0 ? items.length + index : index;
  return at >= 0 && at < items.length ? items[at] : undefined;
}

/** How Python 3.9 writes a RunStatus in an f-string: its value. */
function pyStatus(status: string): string {
  return status;
}

/** secrets.setProviderKey's refusal of an unknown provider (Python's ValueError). */
function isValueError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Unsupported provider");
}
