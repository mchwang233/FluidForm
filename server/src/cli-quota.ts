// What a membership CLI costs: its subscription, shared out by the quota each call uses.
//
// A subscription buys a quota (Codex: a weekly window, sometimes also a 5-hour one). Codex writes the
// quota's state, and the usage of its saved sessions, into its session files
// ($CODEX_HOME/sessions/**.jsonl, `token_count` events). The platform's steps run Codex without saving
// a session, so the platform keeps its own ledger of every Codex call (`record`), which outlives
// deleted tasks; sessions in the leads' folders are the platform's too and are left out.
//
// - calibration: from a baseline reading on, all tokens spent (the ledger plus the user's own
//   sessions) over the share of the window used since give the tokens a whole window holds; the
//   window's part of the monthly fee over that is the price per token. It is set as the CLI's catalog
//   price, so charging, task budgets, routing and the lead's team choice all use it like any API
//   price. Until enough of the window is used after the baseline, the CLI has no price. Quota used
//   where its tokens cannot be seen (another machine, the web) would make it look dearer than it is;
//   it is never priced above the provider's dearest API model (apiCeiling).
// - pressure: from `cli_quota_soft_percent` of a window used, the CLI loses its first place in routing
//   and the lead is told; from `cli_quota_stop_percent` it is marked out of quota until the window
//   resets (quota.QuotaTracker), so new work goes to other models.
//
// Only CLIs listed in `settings.cli_plans` are priced; without it nothing changes. Tokens are weighted
// as their prices are: uncached input and output 1, input read from cache CACHED_WEIGHT. The session
// files are not a published interface: anything unreadable leaves the CLI as it was. They are written
// only while Codex works, so once it is stopped they say nothing new, and Codex can reset a window
// before the time it gave. When the last reading is older than STALE_MINUTES, the reader asks Codex's
// app server for the quota now (`account/rateLimits/read`: no model call, no quota used), at most every
// ASK_MINUTES.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import * as calls from "./calls.js";
import { builtinModels } from "./catalog.js";
import { CLI_SPECS, deps } from "./cli-channels.js";
import { settings } from "./config.js";
import { leadRoot } from "./folders.js";
import { fromPythonIso, pythonIso } from "./lax.js";
import { log } from "./log.js";
import type { ModelProfile } from "./models.js";
import { routingReady } from "./models.js";
import { formatG, isObject, maxBy, pyDumps, pyRound, sortedBy } from "./py.js";
import type { QuotaTracker } from "./quota.js";

export const CACHED_WEIGHT = 0.1;
export const WEEKS_PER_MONTH = 52 / 12;
// Below this share of a window used, the tokens per window are too uncertain to calibrate; the last
// good calibration is kept instead.
export const MIN_CALIBRATION_PERCENT = 2.0;
export const REFRESH_SECONDS = 60;
export const STALE_MINUTES = 10;
export const ASK_MINUTES = 10;
export const ASK_TIMEOUT_SECONDS = 60;

export type Window = { used_percent: number; minutes: number; resets_at: Date };
type Limits = Record<string, any>;
type Event = [Date, Record<string, number> | null, Limits | null];

/** A CLI's quota now, and the weighted tokens spent in its longest window. */
export class Usage {
  constructor(public windows: Window[] = [], public tokens = 0, public plan = "") {}

  get longest(): Window | null {
    return maxBy<Window | null>(this.windows, (item) => item!.minutes, null);
  }

  get fullest(): Window | null {
    return maxBy<Window | null>(this.windows, (item) => item!.used_percent, null);
  }
}

export function weighted(usage: Record<string, any>): number {
  const total = usage.input_tokens || 0;
  const cached = Math.min(Math.max(usage.cached_input_tokens || 0, 0), total);
  return total - cached + cached * CACHED_WEIGHT + (usage.output_tokens || 0);
}

const time = (value: unknown): Date | null => fromPythonIso(String(value).replace("Z", "+00:00"));
const isNumber = (value: unknown): value is number => typeof value === "number";

export function windows(limits: Limits): Window[] {
  const found: Window[] = [];
  for (const key of ["primary", "secondary"]) {
    const item = limits[key];
    if (!isObject(item) || !isNumber(item.used_percent)) continue;
    const minutes = Number(item.window_minutes);
    const resets = Number(item.resets_at);
    if (item.window_minutes === null || item.resets_at === null || !Number.isFinite(minutes) || !Number.isFinite(resets)) continue;
    const at = new Date(Math.trunc(resets) * 1000);
    if (Number.isNaN(at.getTime())) continue;
    found.push({ used_percent: item.used_percent, minutes: Math.trunc(minutes), resets_at: at });
  }
  return found;
}

const within = (path: string, folder: string) => path === folder || path.startsWith(folder + sep);

/** (time, cumulative usage or null for the platform's own sessions, rate limits) of each token_count
 *  event in a session file. */
export function events(path: string, platform: string): Event[] {
  let text: string;
  try {
    text = readFileSync(path).toString("utf8");
  } catch {
    return [];
  }
  const found: Event[] = [];
  let own = false;
  text.split("\n").forEach((line, number) => {
    if (number === 0 && line.includes('"session_meta"')) {
      try {
        const cwd = (JSON.parse(line).payload || {}).cwd || "";
        own = Boolean(cwd) && within(resolve(String(cwd)), platform);
      } catch {
        // unreadable: not the platform's
      }
    }
    if (!line.includes('"token_count"')) return;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!isObject(event)) return;
    const payload = (event.payload || {}) as Record<string, any>;
    if (payload.type !== "token_count") return;
    const at = time(event.timestamp);
    const info = payload.info || {};
    if (at) found.push([at, own ? null : info.total_token_usage || null, payload.rate_limits || null]);
  });
  return found;
}

function window(item: unknown): Record<string, unknown> | null {
  if (!isObject(item)) return null;
  return { used_percent: item.usedPercent ?? null, window_minutes: item.windowDurationMins ?? null, resets_at: item.resetsAt ?? null };
}

/** Codex's quota now, from its app server, in the session files' form; null if it cannot say. */
export async function askCodex(home: string | null = null, timeout = ASK_TIMEOUT_SECONDS): Promise<Limits | null> {
  const executable = deps.which(CLI_SPECS["cli:codex"].executable);
  if (!executable) return null;
  const env = { ...process.env, ...(home ? { CODEX_HOME: home } : {}) };
  const messages = [{ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "super-partner", version: "1" } } },
    { jsonrpc: "2.0", method: "initialized" }, { jsonrpc: "2.0", id: 2, method: "account/rateLimits/read" }];
  const child = spawn(executable, ["app-server"], { stdio: ["pipe", "pipe", "ignore"], env });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeout * 1000);
  const closed = new Promise((done) => child.on("close", done));
  child.on("error", () => undefined);
  child.stdin!.on("error", () => undefined);
  try {
    child.stdin!.write(messages.map((item) => JSON.stringify(item) + "\n").join(""));
    for await (const line of createInterface({ input: child.stdout! })) {
      let answer: any;
      try {
        answer = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isObject(answer) || answer.id !== 2) continue;
      const result = (answer.result || {}) as Record<string, any>;
      const limits = result.rateLimits || {};
      const found: Limits = { plan_type: limits.planType ?? null, primary: window(limits.primary), secondary: window(limits.secondary) };
      if (result.ordinaryUsageAllowed === false && found.primary) found.primary.used_percent = 100.0; // Codex says no more ordinary use
      return found;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    await closed;
  }
}

function jsonlFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (folder: string) => {
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".jsonl")) found.push(path);
    }
  };
  walk(root);
  return found;
}

export type Ask = (home: string | null) => Promise<Limits | null>;

/** Codex's quota from its session files; each file is parsed again only when it changes. ``ask``
 *  gives the quota now when the files are stale (askCodex). */
export class CodexReader {
  private parsed = new Map<string, [string, Event[]]>();
  private asked: [Date, number, Limits | null] | null = null; // when, monotonic time, limits

  constructor(public home: string | null = null, public ask: Ask | null = null) {}

  /** The quota from ``ask``, at most every ASK_MINUTES: [time, limits] or null. */
  private async askNow(now: Date): Promise<[Date, Limits] | null> {
    if (this.asked === null || performance.now() - this.asked[1] >= ASK_MINUTES * 60_000) {
      let limits: Limits | null;
      try {
        limits = await this.ask!(this.home);
      } catch (error) {
        // a broken app server leaves the files' reading
        log.error(`asking Codex for its quota failed: ${(error as Error).stack ?? error}`);
        limits = null;
      }
      this.asked = [now, performance.now(), limits];
    }
    return this.asked[2] ? [this.asked[0], this.asked[2]] : null;
  }

  sessions(): string {
    return join(this.home || process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
  }

  private summary(path: string, mtimeNs: bigint, size: bigint): Event[] {
    const key = `${mtimeNs}:${size}`;
    const cached = this.parsed.get(path);
    if (cached && cached[0] === key) return cached[1];
    let platform = resolve(leadRoot());
    try {
      platform = realpathSync(platform);
    } catch {
      // not made yet
    }
    const found = events(path, platform);
    this.parsed.set(path, [key, found]);
    return found;
  }

  /** The quota now, and the weighted tokens of the user's own sessions since ``since``. */
  async read(since: Date, now: Date | null = null): Promise<Usage | null> {
    const at = now ?? new Date();
    const root = this.sessions();
    try {
      if (!statSync(root).isDirectory()) return null;
    } catch {
      return null;
    }
    let latest: Limits | null = null;
    let latestAt: Date | null = null;
    const files: Event[][] = [];
    const present = new Set<string>();
    // A window lasts at most a week; a resumed session appends to its old file, so look at the files
    // changed within the longest window rather than at their folder dates.
    const horizon = at.getTime() / 1000 - 8 * 24 * 3600;
    for (const path of jsonlFiles(root)) {
      let stat;
      try {
        stat = statSync(path, { bigint: true });
      } catch {
        continue;
      }
      present.add(path);
      if (Number(stat.mtimeNs) / 1e9 < horizon) continue;
      const found = this.summary(path, stat.mtimeNs, stat.size);
      files.push(found);
      for (const [when, , limits] of found) {
        if (limits && (latestAt === null || when > latestAt)) [latest, latestAt] = [limits, when];
      }
    }
    for (const path of [...this.parsed.keys()]) if (!present.has(path)) this.parsed.delete(path);
    const stale = latestAt === null || (at.getTime() - latestAt.getTime()) / 1000 > STALE_MINUTES * 60;
    if (this.ask && stale) {
      const asked = await this.askNow(at);
      if (asked && (latestAt === null || asked[0] > latestAt)) [latestAt, latest] = asked;
    }
    if (!latest) return null;
    const usage = new Usage(windows(latest), 0, String(latest.plan_type || ""));
    if (!usage.longest) return null;
    const start = since.getTime();
    for (const found of files) {
      let before: Record<string, number> | null = null;
      let last: Record<string, number> | null = null;
      for (const [when, total] of found) {
        if (!total) continue;
        if (when.getTime() < start) before = total;
        else last = total;
      }
      if (last) usage.tokens += Math.max(0, weighted(last) - (before ? weighted(before) : 0));
    }
    return usage;
  }
}

export const READERS: Record<string, CodexReader> = { "cli:codex": new CodexReader(null, askCodex) };
export const STOP_LINE = "达到停用线";
const warned = new Set<string>();

const store = () => join(settings.data_dir, "cli_quota.json");
const ledger = () => join(settings.data_dir, "cli_usage.jsonl");
export const LEDGER_DAYS = 8;

/** Note a platform call's usage of a priced CLI (calls.usage). */
export function record(modelId: string, inputTokens: number, outputTokens: number, cached = 0): void {
  if (!(modelId in READERS) || !(inputTokens || outputTokens)) return;
  const line = pyDumps({ model_id: modelId, at: pythonIso(new Date()),
    tokens: weighted({ input_tokens: inputTokens, output_tokens: outputTokens, cached_input_tokens: cached }) });
  try {
    mkdirSync(settings.data_dir, { recursive: true });
    appendFileSync(ledger(), line + "\n");
  } catch {
    log.warning("could not record membership usage");
  }
}
calls.hooks.membershipUsage = record;

/** The weighted tokens the platform's calls of ``modelId`` used since ``since``; drops entries older
 *  than any window. */
export function recorded(modelId: string, since: Date): number {
  let total = 0;
  const keep: string[] = [];
  const horizon = Date.now() / 1000 - LEDGER_DAYS * 24 * 3600;
  let lines: string[];
  try {
    lines = readFileSync(ledger(), "utf8").split("\n");
  } catch {
    return 0;
  }
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    let item: any;
    let at: Date | null;
    try {
      item = JSON.parse(line);
      if (!isObject(item) || !("at" in item)) continue;
      at = time(item.at);
    } catch {
      continue;
    }
    if (!at || at.getTime() / 1000 < horizon) continue;
    keep.push(line);
    if (item.model_id === modelId && at >= since) total += Number(item.tokens || 0);
  }
  if (keep.length < lines.length) {
    try {
      writeFileSync(ledger(), keep.map((item) => item + "\n").join(""));
    } catch {
      // kept as it was
    }
  }
  return total;
}

type State = Record<string, { base?: { at: string; percent: number; resets: number }; per_window?: number }>;

function load(): State {
  try {
    const state = JSON.parse(readFileSync(store(), "utf8"));
    return isObject(state) ? (state as State) : {};
  } catch {
    return {};
  }
}

function keepState(state: State): void {
  try {
    mkdirSync(settings.data_dir, { recursive: true });
    writeFileSync(store(), pyDumps(state));
  } catch {
    // the next reading measures again
  }
}

/** [price per million weighted tokens, tokens a full longest window holds]. ``usage.tokens`` were
 *  spent while ``usedSince`` percent of the window was used. */
export function pricePerMillion(monthlyUsd: number, usage: Usage, usedSince: number, saved: number | null = null): [number | null, number | null] {
  const longest = usage.longest;
  let perWindow = saved;
  if (longest && usedSince >= MIN_CALIBRATION_PERCENT && usage.tokens > 0) perWindow = usage.tokens / (usedSince / 100);
  if (!perWindow || !longest) return [null, perWindow];
  const windowUsd = (monthlyUsd / WEEKS_PER_MONTH) * (longest.minutes / (7 * 24 * 60));
  return [(windowUsd / perWindow) * 1_000_000, perWindow];
}

/** The plan's price per million [input, output] until its quota calibrates one, if set. */
export function startingPrice(plan: Record<string, unknown>): [number, number] | null {
  const input = Number(plan.input_per_million);
  const output = Number(plan.output_per_million);
  if (plan.input_per_million == null || plan.output_per_million == null || Number.isNaN(input) || Number.isNaN(output)) return null;
  return Math.min(input, output) >= 0 ? [input, output] : null;
}

/** The most a membership's tokens can cost: the provider's dearest API model [input, output, cached
 *  per million]. A subscription is never dearer than paying the API; a calibration above this means
 *  quota went where its tokens cannot be seen here (another machine, the web). */
export function apiCeiling(models: Record<string, ModelProfile>, provider: string): [number, number, number] | null {
  // Models still offered: a retired premium tier's price says nothing about the subscription.
  const priced = Object.values(models).filter((model) => model.provider === provider && model.channel !== "cli" && routingReady(model)
    && model.input_per_million && model.output_per_million);
  if (!priced.length) return null;
  return [Math.max(...priced.map((model) => model.input_per_million!)), Math.max(...priced.map((model) => model.output_per_million!)),
    Math.max(...priced.map((model) => model.cached_input_per_million || model.input_per_million! * CACHED_WEIGHT))];
}

function setPrice(model: ModelProfile, input: number | null, output: number | null, cached: number | null): void {
  Object.assign(model, { input_per_million: input, output_per_million: output, cached_input_per_million: cached });
}

const two = (value: number) => String(value).padStart(2, "0");
const local = (when: Date) => `${two(when.getMonth() + 1)}-${two(when.getDate())} ${two(when.getHours())}:${two(when.getMinutes())}`;

export function note(usage: Usage, price: number | null, monthlyUsd: number, start: [number, number] | null = null, capped = false): string {
  const parts: string[] = [];
  for (const item of sortedBy(usage.windows, (entry) => entry.minutes, true)) {
    const label = item.minutes >= 7 * 24 * 60 ? "周" : `${Math.floor(item.minutes / 60)} 小时`;
    parts.push(`${label}额度已用 ${formatG(item.used_percent)}%，${local(item.resets_at)} 重置`);
  }
  let priced: string;
  if (settings.cli_free) priced = "";
  else if (price && capped) {
    priced = `按月费 $${formatG(monthlyUsd)} 折算是 $${formatG(price, 3)}/百万 tokens，比 API 还贵：额度里有本机看不到的用量`
      + "（其他设备或网页），按同厂商 API 的最高价计";
  } else if (price) priced = `按月费 $${formatG(monthlyUsd)} 折算 $${formatG(price, 3)}/百万 tokens`;
  else if (start) priced = `月费 $${formatG(monthlyUsd)}，暂未折算，先按设定价 输入 $${formatG(start[0])}/输出 $${formatG(start[1])} 每百万 tokens`;
  else priced = `月费 $${formatG(monthlyUsd)}，额度用量太少，暂未折算价格`;
  return [...parts, priced].filter(Boolean).join("；");
}

/** Price each CLI with a plan by its quota, and steer work away from it as the quota runs out. A CLI
 *  without a plan, or whose usage cannot be read, keeps the catalog's terms. With ``cli_free`` its
 *  quota is still read and guarded, but it costs nothing. */
export async function apply(models: Record<string, ModelProfile>, tracker: QuotaTracker | null = null, now: Date | null = null): Promise<void> {
  const builtin = new Map(builtinModels().map((model) => [model.id, model]));
  const state = load();
  let changed = false;
  for (const [modelId, reader] of Object.entries(READERS)) {
    const model = models[modelId];
    if (!model) continue;
    const plan = (settings.cli_plans[modelId] || {}) as Record<string, number>;
    const monthly = Number(plan.monthly_usd || 0);
    const mine = monthly > 0 ? (state[modelId] ??= {}) : {};
    let base = mine.base ?? ({} as Partial<NonNullable<typeof mine.base>>);
    let since = time(base.at) ?? now ?? new Date();
    let usage = monthly > 0 ? await reader.read(since, now) : null;
    const original = builtin.get(modelId);
    const set = monthly > 0 ? startingPrice(plan) : null;
    if (usage) warned.delete(modelId);
    if (!usage) {
      if (monthly > 0 && !warned.has(modelId)) {
        warned.add(modelId);
        log.warning(`${modelId}: membership usage could not be read; it keeps its catalog price`);
      }
      if (set) setPrice(model, set[0], set[1], set[0] * CACHED_WEIGHT);
      else if (original) setPrice(model, original.input_per_million, original.output_per_million, original.cached_input_per_million);
      if (original) model.execution_priority = original.execution_priority;
      model.usage_note = null;
      if (settings.cli_free) setPrice(model, 0, 0, 0);
      continue;
    }
    const longest = usage.longest!;
    const resets = Math.trunc(longest.resets_at.getTime() / 1000);
    if (base.resets !== resets) {
      // The first reading, or a new window: measure from here. A window that reset since the last
      // reading began empty at its start.
      const fresh = Object.keys(base).length > 0 && (base.resets ?? 0) < resets;
      const start = longest.resets_at.getTime() - longest.minutes * 60_000;
      mine.base = base = { at: pythonIso(fresh ? new Date(start) : now ?? new Date()), percent: fresh ? 0 : longest.used_percent, resets };
      changed = true;
      since = time(base.at)!;
      usage = (await reader.read(since, now)) ?? usage;
    }
    usage.tokens += recorded(modelId, since);
    const [price, perWindow] = pricePerMillion(monthly, usage, longest.used_percent - base.percent!, mine.per_window ?? null);
    if (perWindow && perWindow !== mine.per_window) {
      mine.per_window = perWindow;
      changed = true;
    }
    const ceiling = apiCeiling(models, model.provider);
    const capped = price !== null && ceiling !== null && price > ceiling[0];
    if (price !== null) {
      if (ceiling) setPrice(model, pyRound(Math.min(price, ceiling[0]), 6), pyRound(Math.min(price, ceiling[1]), 6), pyRound(Math.min(price * CACHED_WEIGHT, ceiling[2]), 6));
      else setPrice(model, pyRound(price, 6), pyRound(price, 6), pyRound(price * CACHED_WEIGHT, 6));
    } else if (set) setPrice(model, set[0], set[1], set[0] * CACHED_WEIGHT);
    if (settings.cli_free) setPrice(model, 0, 0, 0);
    const fullest = usage.fullest;
    const tight = fullest !== null && fullest.used_percent >= settings.cli_quota_soft_percent;
    // A CLI goes first in routing only while its quota is comfortable.
    model.execution_priority = tight ? 100 : original ? original.execution_priority : 0;
    model.usage_note = note(usage, price, monthly, set, capped) + (tight ? "；额度紧张，优先给其他模型" : "");
    if (tracker && fullest) {
      if (fullest.used_percent >= settings.cli_quota_stop_percent) {
        if (!tracker.exhausted(modelId)) {
          tracker.mark(modelId, `会员额度已用 ${formatG(fullest.used_percent)}%，${STOP_LINE} ${formatG(settings.cli_quota_stop_percent)}%`, "quota", fullest.resets_at);
        }
      } else if (tracker.exhausted(modelId) && (tracker.publicReason(modelId) || "").includes(STOP_LINE)) tracker.clear(modelId);
    }
  }
  if (changed) keepState(state);
}

/** Apply every ``interval`` seconds until ``signal`` stops it. */
export async function keepApplying(models: Record<string, ModelProfile>, tracker: QuotaTracker | null = null, interval = REFRESH_SECONDS,
  signal?: AbortSignal): Promise<void> {
  while (!signal?.aborted) {
    try {
      await apply(models, tracker);
    } catch (error) {
      // never let a bad session file stop the service
      log.error(`membership usage refresh failed: ${(error as Error).stack ?? error}`);
    }
    await new Promise((done) => {
      const timer = setTimeout(done, interval * 1000);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        done(null);
      }, { once: true });
    });
  }
}
