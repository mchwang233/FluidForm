// The API's models routes (app.ts builds the app and adds them).
import * as apiProviders from "../api-providers.js";
import * as modelChannels from "../model-channels.js";
import { HttpError, parse, round6 } from "../api.js";
import * as packages from "../capability-packages.js";
import { routingReady } from "../models.js";
import { ProviderError } from "../budget.js";
import { AA_SOURCE } from "../catalog.js";
import * as research from "../research.js";
import { configuredProviders, deleteProviderKey, keyringUnavailable } from "../secrets.js";
import { which } from "../environment.js";
import type { FastifyInstance } from "fastify";
import { Json, LeaderboardSwitch, ProviderKey, Query, USAGE_DAYS, USAGE_RUNS, UpdateModel, UpdateModelById, isValueError, pythonIsoNow, queryBool, queryInt } from "./common.js";
import type { RouteContext } from "./context.js";

export function modelsRoutes(app: FastifyInstance, { api, db, providers }: RouteContext): void {
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
    const matches = research.current()?.matchModels(Object.values(api.models)) ?? new Map<string, unknown[]>();
    const statuses = providers().cli.statuses;
    // A model package's model shows only while its package is on.
    const offered = (id: string) => (id.startsWith("cli:") || id.startsWith("mock:") ? !modelChannels.ownerOf(id) || modelChannels.channelFor(id) !== null
      : apiProviders.inUse(id.split(":", 1)[0]));
    return Object.values(api.models).filter((model) => model.scores_source === AA_SOURCE && offered(model.id)).map((model) => ({
      ...model, configured: configured.has(model.id), routing_ready: routingReady(model), benchmarks: matches.get(model.id) ?? [],
      provider_name: apiProviders.byId(model.provider)?.label ?? null,
      auth_type: model.channel === "cli" ? statuses[model.id]?.auth_type ?? null : "api_key",
    }));
  });

  // Model research's look-ups; without it, nothing is looked up (the page says so).
  const RESEARCH_OFF = { disabled: true, running: false, auto_sync: false, interval_hours: 0 };
  app.get("/api/models/sync", async () => research.current()?.status() ?? RESEARCH_OFF);
  // Whether model research reads the leaderboard by itself, once a week.
  app.put("/api/models/sync/leaderboard", async (request) => {
    const body = parse(LeaderboardSwitch, request.body);
    const running = research.current();
    if (!running) throw new HttpError(409, "模型调研已停用：在能力里打开它才能设置。");
    running.setAuto(body.auto);
    return running.status();
  });
  app.post("/api/models/sync", async (_request, reply) => {
    const running = research.current();
    if (!running) throw new HttpError(409, "模型调研已停用：在能力里打开它才能更新模型目录、价格和评分。");
    running.trigger();
    return reply.code(202).send(running.status());
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
    // FluidForm's own provider and those whose model packages are on.
    return apiProviders.active().map(({ id, label }) => ({ id, name: label, configured: configured.has(id),
      keyring_locked: !configured.has(id) && locked }));
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

}
