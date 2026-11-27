// Noticing that a model has run out of quota, and keeping it out of routing until it resets
//. Membership CLIs stop at a usage limit ("Claude AI usage limit reached", "You've hit
// your usage limit ... try again in 2 hours"); API models answer 429 (rate limit, quota) or 402 /
// an insufficient balance. Such a model is marked exhausted until the reset time the message gives,
// or for a default cooldown, and configured models leave it out, so every routing decision picks a
// backup instead.
import * as apiProviders from "./api-providers.js";
import { createHash } from "node:crypto";
import type { Database } from "./db.js";
import { fromPythonIso, pythonIso } from "./lax.js";
import { head, pyRegex } from "./py.js";

// "hit your … limit": whatever the membership calls the window (usage, session, 5-hour, weekly Opus).
const QUOTA = pyRegex(String.raw`(?:usage|session|weekly|daily|monthly) limit|limit reached|hit your (?:[\w-]+ ){0,3}limit`
  + String.raw`|rate.?limit|quota|insufficient[_ ](balance|quota|credit)`
  + String.raw`|credit balance is too low|out of credits|too many requests|billing|returned (429|402)\b|余额不足|额度`, "i");
// A plain 429 usually clears quickly; running out of money or a membership limit does not.
const RATE_LIMIT = pyRegex(String.raw`rate.?limit|too many requests|returned 429\b`, "i");
const MINUTE = 60_000;
export const RATE_LIMIT_COOLDOWN = 5 * MINUTE;
const UNAVAILABLE = pyRegex(String.raw`returned (?:408|500|502|503|504|529)\b|service[_ ]unavailable|overloaded_error`
  + String.raw`|\b(?:${apiProviders.declared.map((item) => item.id).join("|")}) request failed:`, "i");
export const DEFAULT_COOLDOWN = 60 * MINUTE;
export const MAX_COOLDOWN = 7 * 24 * 60 * MINUTE;

const EPOCH = pyRegex(String.raw`\|\s*(\d{10})\b`); // "Claude AI usage limit reached|1760500800"
const IN = pyRegex(String.raw`(?:try again|resets?|available again)\s+in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,and]*)+)`, "i");
const PART = String.raw`(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b`;
const AT = pyRegex(String.raw`(?:try again at|resets?(?: at)?)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^()\s]+)\))?`, "i");

/** A model cannot take work until its quota or upstream service recovers. */
export class ModelUnavailable extends Error {
  readonly kind: string = "unavailable";

  constructor(readonly modelId: string, readonly until: Date, message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A model ran out of quota; another model should take the work. */
export class QuotaExhausted extends ModelUnavailable {
  override readonly kind = "quota";
}

export function isQuotaError(text: string | null | undefined): boolean {
  return QUOTA.test(text || "");
}

export function failureKind(text: string | null | undefined): "quota" | "unavailable" | null {
  if (isQuotaError(text)) return "quota";
  return UNAVAILABLE.test(text || "") ? "unavailable" : null;
}

/** Exact, model-scoped error signatures; ignore only whitespace and volatile request IDs. Do not
 *  promote arbitrary model-generated regexes or commands into shared policy. */
export function signature(message: string): string {
  const normalized = message.toLowerCase().replace(pyRegex(String.raw`request_id["'\s:=]+[\w-]+`, "g"), "request_id=<id>")
    .split(/\s+/).filter(Boolean).join(" ");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/** The wall-clock parts of ``when`` in ``zone`` (the machine's own without one). */
function wallClock(when: Date, zone?: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  if (!zone) {
    return { year: when.getFullYear(), month: when.getMonth() + 1, day: when.getDate(), hour: when.getHours(), minute: when.getMinutes(), second: when.getSeconds() };
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(when).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24,
    minute: Number(parts.minute), second: Number(parts.second) };
}

/** The instant a wall-clock time in ``zone`` (the machine's own without one) stands for. */
function fromWallClock(year: number, month: number, day: number, hour: number, minute: number, zone?: string): Date {
  if (!zone) return new Date(year, month - 1, day, hour, minute, 0, 0);
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const seen = wallClock(new Date(guess), zone);
  const offset = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute) - guess;
  return new Date(guess - offset);
}

const validZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/** When the quota comes back, from the message if it says, else after a cooldown. */
export function resetTime(given: string | null | undefined, now: Date = new Date()): Date {
  const text = given || "";
  let until: Date;
  const epoch = EPOCH.exec(text);
  const inside = epoch ? null : IN.exec(text);
  const at = epoch || inside ? null : AT.exec(text);
  if (epoch) until = new Date(Number(epoch[1]) * 1000);
  else if (inside) {
    const units: Record<string, number> = { d: 24 * 60 * MINUTE, h: 60 * MINUTE, m: MINUTE, s: 1000 };
    let delta = 0;
    for (const [, amount, unit] of inside[1].matchAll(pyRegex(PART, "ig"))) delta += Number(amount) * units[unit[0].toLowerCase()];
    until = new Date(now.getTime() + delta);
  } else if (at) {
    // Prefer an explicit zone, e.g. "resets 2pm (Asia/Shanghai)"; otherwise the machine's clock.
    let hour = Number(at[1]);
    const minute = Number(at[2] ?? 0);
    const half = (at[3] ?? "").toLowerCase();
    if (half) hour = (hour % 12) + (half === "pm" ? 12 : 0);
    if (hour > 23 || minute > 59) return new Date(now.getTime() + DEFAULT_COOLDOWN);
    const zone = at[4] && validZone(at[4]) ? at[4] : undefined;
    const local = wallClock(now, zone);
    until = fromWallClock(local.year, local.month, local.day, hour, minute, zone);
    if (until.getTime() <= now.getTime()) {
      const next = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
      until = fromWallClock(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), hour, minute, zone);
    }
  } else {
    return new Date(now.getTime() + (RATE_LIMIT.test(text) ? RATE_LIMIT_COOLDOWN : DEFAULT_COOLDOWN));
  }
  return new Date(Math.min(Math.max(until.getTime(), now.getTime() + MINUTE), now.getTime() + MAX_COOLDOWN));
}

type Rule = { model_id: string; signature: string; kind: string; run_id: string; diagnosis_id: string };
const two = (value: number) => String(value).padStart(2, "0");

/** Shared model cooldowns and learned failure classifications, optionally persistent. */
export class QuotaTracker {
  private until = new Map<string, Date>();
  private reason = new Map<string, string>();
  private kinds = new Map<string, string>();
  rules: Rule[];

  constructor(readonly db: Pick<Database, "loadRecoveryState" | "saveRecoveryState"> | null = null) {
    const state = db ? db.loadRecoveryState() : {};
    this.rules = Array.isArray(state.rules) ? (state.rules as Rule[]) : [];
    for (const item of Array.isArray(state.models) ? (state.models as Record<string, unknown>[]) : []) {
      const until = fromPythonIso(item?.until);
      if (!until || until.getTime() <= Date.now() || typeof item.model_id !== "string") continue;
      this.until.set(item.model_id, until);
      this.reason.set(item.model_id, typeof item.reason === "string" ? item.reason : "");
      this.kinds.set(item.model_id, typeof item.kind === "string" ? item.kind : "quota");
    }
  }

  classify(modelId: string, message: string): string | null {
    const known = failureKind(message);
    if (known) return known;
    const sign = signature(message);
    return [...this.rules].reverse().find((item) => item.model_id === modelId && item.signature === sign)?.kind ?? null;
  }

  learn(modelId: string, message: string, kind: string, runId: string, diagnosisId: string): void {
    if (!["quota", "unavailable"].includes(kind) || !message.trim()) return;
    const sign = signature(message);
    this.rules = this.rules.filter((item) => !(item.model_id === modelId && item.signature === sign));
    this.rules.push({ model_id: modelId, signature: sign, kind, run_id: runId, diagnosis_id: diagnosisId });
    this.rules = this.rules.slice(-200);
    this.save();
  }

  private save(): void {
    this.db?.saveRecoveryState({ models: [...this.until].map(([modelId, until]) => ({ model_id: modelId, until: pythonIso(until),
      reason: this.reason.get(modelId), kind: this.kinds.get(modelId) })), rules: this.rules });
  }

  mark(modelId: string, message: string, kind = "quota", until: Date | null = null): ModelUnavailable {
    const when = until ?? (kind === "quota" ? resetTime(message) : new Date(Date.now() + RATE_LIMIT_COOLDOWN));
    this.until.set(modelId, when);
    this.reason.set(modelId, head(message, 300));
    this.kinds.set(modelId, kind);
    this.save();
    return this.error(modelId);
  }

  error(modelId: string): ModelUnavailable {
    const until = this.until.get(modelId)!;
    const quota = this.kinds.get(modelId) === "quota";
    const label = quota ? "额度用完" : "服务暂时不可用";
    const shown = `${two(until.getMonth() + 1)}-${two(until.getDate())} ${two(until.getHours())}:${two(until.getMinutes())}`;
    const message = `${modelId} ${label}（${head(this.reason.get(modelId) ?? "", 200)}），${shown} 后重新尝试`;
    return quota ? new QuotaExhausted(modelId, until, message) : new ModelUnavailable(modelId, until, message);
  }

  exhausted(modelId: string | null | undefined): boolean {
    const until = this.until.get(modelId || "");
    if (until && until.getTime() <= Date.now()) {
      this.clear(modelId!);
      return false;
    }
    return until !== undefined;
  }

  publicReason(modelId: string): string | null {
    return this.reason.get(modelId) ?? null;
  }

  clear(modelId: string): void {
    this.until.delete(modelId);
    this.reason.delete(modelId);
    this.kinds.delete(modelId);
    this.save();
  }

  /** A new API key or a refilled account: try that provider's models again. */
  clearProvider(provider: string): void {
    for (const modelId of [...this.until.keys()].filter((item) => item.split(":")[0] === provider)) this.clear(modelId);
  }

  public(): { model_id: string; until: string; reason: string; kind: string }[] {
    return [...this.until].filter(([modelId]) => this.exhausted(modelId))
      .map(([modelId, until]) => ({ model_id: modelId, until: pythonIso(until), reason: this.reason.get(modelId) ?? "", kind: this.kinds.get(modelId) ?? "quota" }));
  }
}
