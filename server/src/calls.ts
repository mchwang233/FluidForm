// Per-invocation accounting. No prompts, credentials or provider response bodies are
// stored here.
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Priced } from "./budget.js";
import * as pricing from "./pricing.js";
import type { Database } from "./db.js";
import { nowIso } from "./lax.js";
import { ContextVar, pyRound } from "./py.js";

export type CallRecord = Record<string, any> & {
  id: string; model_id: string; started_at: string; warnings: string[]; usage_known: boolean; requests: number;
  input_tokens: number; output_tokens: number; cached_input_tokens: number; cache_write_tokens: number; cost_usd: number;
};

export const current = new ContextVar<[Pick<Database, "saveModelCall"> | null, CallRecord] | null>("model_call", null);

// Whether the call being made is only counted (budget.countOnly).
const counting = new ContextVar<boolean>("count_only", false);

/** Membership CLIs' usage against their quota (cli_quota.record), set when that module loads. */
export const hooks = { membershipUsage: (_modelId: string, _input: number, _output: number, _cached: number): void => undefined };

export function save(): void {
  const held = current.get();
  if (held && held[0] !== null) held[0].saveModelCall(held[1]);
}

export function row(): CallRecord | null {
  const held = current.get();
  return held ? held[1] : null;
}

export function warning(message: string): void {
  const record = row();
  if (record !== null && !record.warnings.includes(message)) record.warnings.push(message);
}

export async function usage(model: Priced | null | undefined, inputTokens: number, outputTokens: number, cached = 0, cacheWrite = 0, known = true): Promise<void> {
  const record = row();
  if (record === null) return;
  // What the pricing package charges for it (asked first: the counts below change together).
  const charged = () => pricing.charge(model ? { ...model, id: record.model_id } : null, inputTokens || 0, outputTokens || 0, cached || 0);
  const cost = counting.get() ? await pricing.countOnly(charged, 0) : await charged();
  record.usage_known = record.usage_known && known;
  for (const [name, count] of [["input_tokens", inputTokens], ["output_tokens", outputTokens], ["cached_input_tokens", cached],
    ["cache_write_tokens", cacheWrite]] as const) record[name] += count || 0;
  record.cost_usd += cost;
  hooks.membershipUsage(record.model_id, inputTokens || 0, outputTokens || 0, cached || 0);
  save();
}

/** What a call returns that is accounted. */
export type Counted = { input_tokens: number; output_tokens: number; cached_input_tokens: number; cache_write_tokens?: number;
  usage_known?: boolean; warnings?: string[] };

export type CallOwner = { db: Pick<Database, "saveModelCall"> | null; models: Map<string, Priced> | Record<string, Priced> };

/** Python's @observed: ``call`` accounted as one model call (its record saved as it goes), what
 *  it reports in ``result`` counted unless its requests were counted one by one. ``purpose`` is
 *  "lead" for a lead's conversation, else "helper", unless the budget's context says. */
export async function observed<R extends Counted>(owner: CallOwner, name: "complete" | "converse", modelId: string,
  options: { effort?: string | null; spend_ok?: { context?: Record<string, unknown> } | null }, call: () => Promise<R>): Promise<R> {
  const context = options.spend_ok?.context ?? {};
  const parent = row();
  if (parent !== null) parent.delegated = true;
  const record: CallRecord = { id: randomUUID().replaceAll("-", ""), parent_id: parent ? parent.id : null, model_id: modelId,
    run_id: context.run_id ?? null, node_id: context.node_id ?? null, purpose: context.purpose ?? (name === "converse" ? "lead" : "helper"),
    started_at: nowIso().replace(/Z$/, "+00:00"), status: "running", requested_effort: options.effort ?? null, effective_effort: "unspecified",
    input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0, usage_known: true, cost_usd: 0, requests: 0,
    retries: 0, queue_seconds: 0, duration_seconds: 0, warnings: [], exchanges: [] };
  return counting.run(Boolean(context.count_only), () => current.run([owner.db, record], async () => {
    const started = performance.now();
    save();
    try {
      const result = await call();
      if (!record.requests && !record.delegated) {
        const model = owner.models instanceof Map ? owner.models.get(modelId) : owner.models[modelId];
        await usage(model, result.input_tokens, result.output_tokens, result.cached_input_tokens, result.cache_write_tokens ?? 0, result.usage_known ?? true);
      }
      result.warnings = [...new Set([...(result.warnings ?? []), ...record.warnings])];
      result.usage_known = record.usage_known && (result.usage_known ?? true);
      if (record.requests) result.cache_write_tokens = record.cache_write_tokens;
      record.status = "succeeded";
      return result;
    } catch (error) {
      record.status = (error as Error)?.name === "AbortError" ? "cancelled" : "failed";
      record.error_type = (error as Error)?.name ?? "Error";
      // A dropped response may have been billed: the observed subtotal is not a total.
      record.usage_known = false;
      throw error;
    } finally {
      record.duration_seconds = pyRound((performance.now() - started) / 1000, 3);
      save();
    }
  }));
}
