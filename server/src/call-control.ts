// Provider-wide rolling request/token admission and cancellable concurrency gates.
import { performance } from "node:perf_hooks";
import { ProviderError } from "./budget.js";
import { pyDumps } from "./py.js";

const monotonic = () => performance.now() / 1000;

/** Seconds to wait from a Retry-After header: a number of seconds or an HTTP date; ``fallback``
 *  for anything else. */
export function retryAfter(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value.trim()))) return Math.max(0, Number(value.trim()));
  // An HTTP date names its zone (GMT); a date without one is not one.
  if (typeof value === "string" && /\b(GMT|UTC|UT|[+-]\d{4}|[ECMP][SD]T|Z)\b/.test(value)) {
    const when = Date.parse(value);
    if (Number.isFinite(when)) return Math.max(0, (when - Date.now()) / 1000);
  }
  return fallback;
}

export type Limits = { concurrency?: number; rpm?: number; tpm?: number };

export class ProviderGate {
  active = 0;
  window: [number, number][] = []; // [when, tokens]
  blockedUntil = 0;
  private waiters = new Set<() => void>();

  coolDown(seconds: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, monotonic() + seconds);
  }

  private notifyAll(): void {
    const waiting = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiting) wake();
  }

  /** Waits for a notification, or ``seconds`` (null: no limit). */
  private wait(seconds: number | null, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const done = () => {
        if (timer) clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener("abort", aborted);
        resolve();
      };
      const aborted = () => {
        if (timer) clearTimeout(timer);
        this.waiters.delete(done);
        reject(signal!.reason);
      };
      if (signal?.aborted) return aborted();
      this.waiters.add(done);
      signal?.addEventListener("abort", aborted, { once: true });
      if (seconds !== null) timer = setTimeout(done, seconds * 1000);
    });
  }

  /** Runs ``work`` once the provider's limits admit a request of ``tokens``; ``work`` is told how
   *  long it waited and its reservation in the window ([when, tokens], which it may correct). */
  async hold<T>(limits: Limits, tokens: number, work: (waited: number, reservation: [number, number]) => Promise<T>,
    signal?: AbortSignal): Promise<T> {
    const concurrency = limits.concurrency ?? 0;
    const rpm = limits.rpm ?? 0;
    const tpm = limits.tpm ?? 0;
    if (tpm && tokens > tpm) throw new ProviderError("单次请求的 token 预留超过供应商 TPM 配额；请缩小上下文或修正配额。");
    const started = monotonic();
    let reservation: [number, number];
    for (;;) {
      const now = monotonic();
      while (this.window.length && this.window[0][0] <= now - 60) this.window.shift();
      let wait = this.blockedUntil - now;
      const full = (rpm && this.window.length >= rpm) || (tpm && this.window.reduce((sum, item) => sum + item[1], 0) + tokens > tpm);
      if (full) wait = Math.max(wait, this.window[0][0] + 60 - now);
      if (wait <= 0 && (!concurrency || this.active < concurrency)) {
        this.active += 1;
        reservation = [now, tokens];
        this.window.push(reservation);
        break;
      }
      await this.wait(wait > 0 ? Math.max(0.01, wait) : null, signal);
    }
    try {
      return await work(monotonic() - started, reservation);
    } finally {
      this.active -= 1;
      this.notifyAll();
    }
  }
}

/** Byte length is a conservative token bound without provider-specific tokenizers. */
export function inputBound(body: unknown): number {
  return boundBytes(body) + 256;
}

// What a picture in a request is counted as, in bytes of text: more tokens than providers make of
// one, far fewer than its base64 has characters.
export const IMAGE_BOUND_BYTES = 12_000;

/** A request's size as tokens are bound by it: its bytes, with each picture's data as IMAGE_BOUND_BYTES. */
export function boundBytes(payload: unknown): number {
  let pictures = 0;
  const counted = () => {
    pictures += 1;
    return "";
  };
  const without = (value: any): any => {
    if (Array.isArray(value)) return value.map(without);
    if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return value;
    if (value.type === "image_url" && typeof value.image_url?.url === "string" && value.image_url.url.startsWith("data:")) return { ...value, image_url: { url: counted() } };
    if (value.type === "image" && typeof value.source?.data === "string") return { ...value, source: { ...value.source, data: counted() } };
    if (typeof value.inline_data?.data === "string") return { ...value, inline_data: { ...value.inline_data, data: counted() } };
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, without(item)]));
  };
  return Buffer.byteLength(pyDumps(without(payload), false), "utf8") + pictures * IMAGE_BOUND_BYTES;
}
