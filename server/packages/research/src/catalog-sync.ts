// Refresh model metadata without inventing quality scores or making inference calls.
import type { BenchmarkCatalog } from "./benchmarks.js";
import type { Database } from "../../../src/db.js";
import { type Fetcher, get, HttpStatusError, RequestTimeout, TransportError, within } from "../../../src/fetching.js";
import { fromPythonIso, pythonIso } from "../../../src/lax.js";
import { type ModelProfile, ModelProfileSchema, utcnow } from "../../../src/models.js";
import { pyRegex } from "../../../src/py.js";
import { rescore } from "./scoring.js";
import * as apiProviders from "../../../src/api-providers.js";
import { PROVIDER_ENV } from "../../../src/secret-names.js";
import { Mutex, sleep, Task } from "../../../src/tasks.js";

export const PUBLIC_CATALOG_URL = "https://models.dev/api.json";
// Match the regions used by providers.ts; never take credential destinations from remote data.
// Every known provider's (api-providers.ts, on or off); a sync reads only those in use.
export const PUBLIC_PROVIDERS: Record<string, string> = Object.fromEntries(apiProviders.declared.filter((item) => item.catalog)
  .map((item) => [item.id, item.catalog!]));
export const OFFICIAL_URLS: Record<string, string> = Object.fromEntries(apiProviders.declared.filter((item) => item.official)
  .map((item) => [item.id, item.models_url]));
// Seconds: one request; the public catalog; one provider's official catalog.
export const limits = { REQUEST: 20, PUBLIC: 35, OFFICIAL: 45, SCHEDULE_POLL: 30 };

type Json = Record<string, any>;


export function number(value: unknown, { positive = false } = {}): number | null {
  return typeof value === "number" && Number.isFinite(value) && (positive ? value > 0 : value >= 0) ? value : null;
}

export function isoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const found = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.slice(0, 10));
  if (!found) return null;
  const [year, month, day] = found.slice(1).map(Number);
  const when = new Date(Date.UTC(year, month - 1, day));
  return year >= 1 && when.getUTCMonth() === month - 1 && when.getUTCDate() === day ? found[0] : null;
}

const MODEL_ID = pyRegex(String.raw`^[\w][\w./:@-]{0,199}\Z`);

export function modelId(provider: string, value: unknown): string {
  if (typeof value !== "string" || !MODEL_ID.test(value)) throw new Error("Invalid model ID");
  return `${provider}:${value}`;
}

const bool = (value: unknown) => (typeof value === "boolean" ? value : null);
const dict = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function publicModels(payload: Json, provider: string): Record<string, Json> {
  const group = payload[PUBLIC_PROVIDERS[provider]];
  const entries = dict(group) ? group.models : null;
  if (!dict(entries) || !Object.keys(entries).length) throw new Error("Missing provider catalog");
  const result: Record<string, Json> = {};
  for (const [key, entry] of Object.entries(entries)) {
    if (!dict(entry)) throw new TypeError("Invalid model metadata");
    const modalities = entry.modalities ?? {};
    // This application executes text tasks; specialized image/audio/embedding models are omitted.
    if (!dict(modalities) || !(Array.isArray(modalities.output) ? modalities.output : []).includes("text")) continue;
    const identifier = modelId(provider, entry.id ?? key);
    const cost = entry.cost || {};
    const limit = entry.limit || {};
    if (!dict(cost) || !dict(limit)) throw new TypeError("Invalid model limits or prices");
    const context = number(limit.context, { positive: true });
    const output = number(limit.output, { positive: true });
    result[identifier] = {
      display_name: String(entry.name || key).slice(0, 200), description: String(entry.description || "").slice(0, 2000) || null,
      context_window: context ? Math.trunc(context) : null, max_output_tokens: output ? Math.trunc(output) : null,
      input_per_million: number(cost.input), output_per_million: number(cost.output), cached_input_per_million: number(cost.cache_read),
      supports_tools: bool(entry.tool_call), supports_vision: Array.isArray(modalities.input) ? modalities.input.includes("image") : null,
      supports_reasoning: bool(entry.reasoning), supports_structured_output: bool(entry.structured_output), release_date: isoDate(entry.release_date),
      catalog_status: ["deprecated", "retired"].includes(entry.status) ? entry.status : "listed", catalog_source: "models.dev", pricing_source: "models.dev",
      pricing_verified: false, source_url: `https://models.dev/?search=${PUBLIC_PROVIDERS[provider]}`,
    };
  }
  if (!Object.keys(result).length) throw new Error("Empty text model catalog");
  return result;
}

/** Never expose URLs with query credentials, response bodies, or exception messages. */
export function errorMessage(error: unknown): string {
  if (error instanceof HttpStatusError) return `请求失败（HTTP ${error.status}），保留上次目录`;
  if (error instanceof RequestTimeout) return "请求超时，保留上次目录";
  if (error instanceof TransportError) return "网络连接失败，保留上次目录";
  return "目录格式不兼容，保留上次目录";
}

const PRICE_FIELDS = ["input_per_million", "output_per_million", "cached_input_per_million", "pricing_source", "pricing_verified"];

export class CatalogSync {
  fetch: Fetcher = (...args) => fetch(...args);
  readonly autoSync: boolean;
  readonly intervalHours: number;
  readonly benchmarks: BenchmarkCatalog | null;
  state: Json;
  readonly lock = new Mutex();
  task: Task<Json> | null = null;
  scheduler: Task<void> | null = null;

  constructor(readonly db: Database, readonly models: Record<string, ModelProfile>,
    { autoSync = true, intervalHours = 24, benchmarks = null }: { autoSync?: boolean; intervalHours?: number; benchmarks?: BenchmarkCatalog | null } = {}) {
    this.autoSync = autoSync;
    this.intervalHours = intervalHours;
    this.benchmarks = benchmarks;
    this.state = db.loadCatalogState() as Json;
  }

  status(): Json {
    // The providers in use now, each with the name the page shows.
    const providers = Object.fromEntries(Object.entries((this.state.providers ?? {}) as Json).filter(([id]) => apiProviders.inUse(id))
      .map(([id, state]) => [id, { ...state, name: apiProviders.byId(id)?.label ?? id }]));
    return { ...this.state, providers, running: this.lock.locked || Boolean(this.task && !this.task.done), auto_sync: this.autoSync, interval_hours: this.intervalHours,
      next_sync_at: this.autoSync ? this.state.next_sync_at ?? null : null, benchmarks: this.benchmarks ? this.benchmarks.status(Object.values(this.models)) : null };
  }

  /** Look everything up now; ``force``: the leaderboard too, though it is not due (立即更新). */
  trigger(force = false): void {
    if (!this.task || this.task.done) this.task = new Task((signal) => this.refresh(signal, force));
  }

  start(): void {
    if (this.autoSync) this.scheduler = new Task((signal) => this.schedule(signal));
  }

  async close(): Promise<void> {
    for (const task of [this.scheduler, this.task]) {
      if (task && !task.done) {
        task.cancel();
        await task.settled();
      }
    }
  }

  private async schedule(signal: AbortSignal): Promise<void> {
    for (;;) {
      const due = fromPythonIso(this.state.next_sync_at);
      const aa = this.benchmarks?.cache.artificial_analysis;
      if (!due || Date.now() >= due.getTime() || (this.benchmarks && !Object.keys(this.benchmarks.cache).length) || (this.benchmarks && aa?.status === "no_key")) {
        this.trigger();
        await this.task!.settled();
      }
      await sleep(limits.SCHEDULE_POLL, signal);
    }
  }

  private async getJson(url: string, options: { headers?: Record<string, string>; params?: Record<string, string | number> } = {}, signal?: AbortSignal): Promise<Json> {
    const payload = (await within(limits.REQUEST, (inner) => get(this.fetch, url, { ...options, signal: inner }), signal)).json();
    if (!dict(payload)) throw new TypeError("Invalid catalog");
    return payload;
  }

  async officialModels(provider: string, key: string, signal?: AbortSignal): Promise<Record<string, Json>> {
    let headers: Record<string, string> = { Authorization: `Bearer ${key}` };
    const params: Record<string, string | number> = {};
    const wire = apiProviders.byId(provider)?.wire;
    if (wire === "anthropic") {
      headers = { "x-api-key": key, "anthropic-version": "2023-06-01" };
      params.limit = 1000;
    } else if (wire === "gemini") {
      headers = { "x-goog-api-key": key };
      params.pageSize = 1000;
    }
    const result: Record<string, Json> = {};
    const cursors = new Set<string>();
    for (let page = 0; page < 100; page += 1) {
      const payload = await this.getJson(OFFICIAL_URLS[provider], { headers, params }, signal);
      const entries = payload[wire === "gemini" ? "models" : "data"];
      if (!Array.isArray(entries)) throw new TypeError("Missing models");
      for (const entry of entries) {
        if (!dict(entry)) throw new TypeError("Invalid model");
        let rawId: unknown;
        if (wire === "gemini") {
          if (!(Array.isArray(entry.supportedGenerationMethods) ? entry.supportedGenerationMethods : []).includes("generateContent")) continue;
          rawId = String(entry.name ?? "").replace(/^models\//, "");
        } else rawId = entry.id;
        const identifier = modelId(provider, rawId);
        const data: Json = { available_via_api: true };
        const name = entry.display_name || entry.displayName || entry.name;
        if (name) data.display_name = String(name).slice(0, 200);
        const context = number(entry.inputTokenLimit || entry.max_input_tokens || entry.context_window, { positive: true });
        if (context) data.context_window = Math.trunc(context);
        const output = number(entry.outputTokenLimit, { positive: true });
        if (output) data.max_output_tokens = Math.trunc(output);
        // Creation timestamps are not release dates. Do not present them as such.
        if (["deprecated", "retired"].includes(entry.lifecycle)) data.catalog_status = entry.lifecycle;
        const shutdown = isoDate(entry.shutdown_date);
        if (shutdown && shutdown <= utcnow().slice(0, 10)) data.catalog_status = "retired";
        result[identifier] = data;
      }
      const cursor = wire === "gemini" ? payload.nextPageToken : payload.has_more ? payload.last_id : null;
      if (!cursor) {
        if (payload.has_more) throw new Error("Missing pagination cursor");
        if (!Object.keys(result).length) throw new Error("Empty model catalog");
        return result;
      }
      if (cursors.has(cursor)) throw new Error("Repeated pagination cursor");
      cursors.add(cursor);
      params[wire === "gemini" ? "pageToken" : "after_id"] = cursor;
    }
    throw new Error("Catalog pagination limit exceeded");
  }

  merge(provider: string, entries: Record<string, Json>, official: boolean): number {
    const now = utcnow();
    const changed: ModelProfile[] = [];
    let added = 0;
    for (const [identifier, metadata] of Object.entries(entries)) {
      const existing = this.models[identifier];
      const data: Json = existing ? { ...existing } : { id: identifier, provider, display_name: identifier.split(":").slice(1).join(":"), enabled: false,
        catalog_source: official ? "official" : "models.dev", source_url: official ? OFFICIAL_URLS[provider] ?? null : PUBLIC_CATALOG_URL, pricing_source: "unknown" };
      if (!existing) added += 1;
      // An incomplete remote field must not erase previously known metadata.
      const values: Json = Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== null && value !== undefined));
      // A stale public snapshot or a missing entry cannot revive an explicitly retired model.
      if (existing?.catalog_status === "retired") values.catalog_status = "retired";
      if (!official && (metadata.input_per_million == null || metadata.output_per_million == null)) {
        // Preserve an existing complete price pair and its provenance together.
        if (existing) for (const key of PRICE_FIELDS) delete values[key];
        else if (metadata.input_per_million == null && metadata.output_per_million == null) values.pricing_source = "unknown";
      }
      if (existing?.pricing_verified) for (const key of PRICE_FIELDS) delete values[key];
      Object.assign(data, values);
      data[official ? "api_checked_at" : "catalog_checked_at"] = now;
      if (official && (!existing || existing.catalog_source === "official")) data.catalog_checked_at = now;
      changed.push(ModelProfileSchema.parse(data));
    }
    for (const model of Object.values(this.models)) {
      if (model.provider !== provider || model.channel !== "api" || identifierIn(entries, model.id)) continue;
      if (official) changed.push({ ...model, available_via_api: false, api_checked_at: now });
      else if (model.catalog_source === "models.dev") {
        changed.push({ ...model, catalog_status: ["deprecated", "retired"].includes(model.catalog_status) ? model.catalog_status : "unlisted", catalog_checked_at: now });
      }
    }
    // Nothing awaited between reading preferences, saving, and replacing the live objects.
    this.db.saveModels(changed);
    for (const model of changed) this.models[model.id] = model;
    return added;
  }

  async refresh(signal?: AbortSignal, force = false): Promise<Json> {
    if (this.lock.locked) return this.status();
    await this.lock.run(async () => {
      const started = new Date();
      this.state.last_attempt_at = pythonIso(started);
      const states: Json = (this.state.providers ??= {});
      let publicCatalog: Json = {};
      let publicError: string | null = null;
      try {
        publicCatalog = await within(limits.PUBLIC, (inner) => this.getJson(PUBLIC_CATALOG_URL, {}, inner), signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        publicError = errorMessage(error);
      }
      const syncProvider = async (provider: string) => {
        const previous = states[provider] ?? {};
        const state: Json = { ...previous, checked_at: pythonIso(new Date()), added: 0 };
        try {
          if (publicError) throw new Error("Public catalog unavailable");
          const entries = publicModels(publicCatalog, provider);
          state.added += this.merge(provider, entries, false);
          Object.assign(state, { public_status: "ok", public_error: null, count: Object.keys(entries).length, last_success_at: pythonIso(new Date()) });
        } catch (error) {
          Object.assign(state, { public_status: "error", public_error: publicError || errorMessage(error) });
        }
        const key = process.env[PROVIDER_ENV[provider]];
        if (!(provider in OFFICIAL_URLS)) Object.assign(state, { official_status: "not_supported", official_error: null });
        else if (!key) Object.assign(state, { official_status: "no_key", official_error: null });
        else {
          try {
            const entries = await within(limits.OFFICIAL, (inner) => this.officialModels(provider, key, inner), signal);
            state.added += this.merge(provider, entries, true);
            Object.assign(state, { official_status: "ok", official_error: null, official_count: Object.keys(entries).length, official_success_at: pythonIso(new Date()) });
          } catch (error) {
            if (signal?.aborted) throw error;
            Object.assign(state, { official_status: "error", official_error: errorMessage(error) });
          }
        }
        states[provider] = state;
      };
      const jobs: Promise<void>[] = Object.keys(PUBLIC_PROVIDERS).filter((provider) => apiProviders.inUse(provider)).map(syncProvider);
      if (this.benchmarks) jobs.push(this.benchmarks.refresh(this.fetch, signal, { force }));
      await Promise.all(jobs);
      if (signal?.aborted) throw signal.reason;
      // New AA results or newly listed models can change routing scores.
      if (this.benchmarks) rescore(this.models, this.benchmarks, this.db);
      const finished = new Date();
      const all = Object.values(states) as Json[];
      let allOk = all.every((state) => state.public_status === "ok");
      if (this.benchmarks) allOk &&= Object.values(this.benchmarks.cache).every((entry) => entry.status !== "error");
      if (all.some((state) => state.public_status === "ok" || state.official_status === "ok")) this.state.last_success_at = pythonIso(finished);
      // Failed sources retry after an hour; successful refreshes use the configured interval.
      const interval = allOk && all.every((state) => state.official_status !== "error") ? this.intervalHours : Math.min(1, this.intervalHours);
      Object.assign(this.state, { last_finished_at: pythonIso(finished), next_sync_at: pythonIso(new Date(finished.getTime() + interval * 3_600_000)),
        added: all.reduce((sum, state) => sum + state.added, 0) });
      this.db.saveCatalogState(this.state);
    });
    return this.status();
  }
}

const identifierIn = (entries: Record<string, Json>, id: string) => Object.prototype.hasOwnProperty.call(entries, id);
