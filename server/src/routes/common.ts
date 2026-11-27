// What the API's routes share: request bodies, query readers and small helpers (app.ts).
import { z } from "zod";
import { FINISHED, HttpError, parse } from "../api.js";
import * as files from "../attachments.js";
import * as chat from "../chat.js";
import { settings } from "../config.js";
import * as contracts from "../contracts.js";
import { ExecutorBase } from "../executor-base.js";
import { EventSchema, type ExecutionRun, type TaskNode } from "../models.js";
import { pyQuote as quote } from "../py.js";
import { pythonIso } from "../lax.js";
import * as supervisor from "../supervisor.js";

export type Json = Record<string, any>;

export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The host name of a Host header, without its port ("[::1]:8000" is "::1"). */
export function hostName(host: string): string {
  if (host.startsWith("[")) return host.slice(1).split("]", 1)[0];
  return (host.match(/:/g) ?? []).length === 1 ? host.slice(0, host.lastIndexOf(":")) : host;
}

// ---- Request bodies ----

export const text = (max: number) => z.string().max(max);
export const ids = z.array(z.string()).default(() => []);
export const LeaderboardSwitch = z.object({ auto: z.boolean() });
export const NetworkAccess = z.object({ allow: z.boolean() });
export const LeadQuestion = z.object({ message: text(20_000).default(""), attachments: ids });
export const ConfirmTask = z.object({ budget_usd: z.number().gt(0).lte(10_000).nullish().default(null) });
export const DiagnosisReply = z.object({ text: text(6000).default(""), choice: text(300).nullish().default(null), attachments: ids });
export const ProviderKey = z.object({ api_key: z.string().min(8) });
export const UpdateModel = z.object({ enabled: z.boolean() });
export const UpdateModelById = UpdateModel.extend({ model_id: z.string() });
export const ProfileChoice = z.object({ profile: z.enum(["", "fast", "balanced", "careful"]) });
export const Forget = z.object({ key: z.string().min(1).max(300), fact: z.string().min(1).max(310) });
export const EngineerRequest = z.object({
  request: z.string().min(1).max(20_000),
  kind: z.string().regex(/^(repair|component)$/).default("component"),
  budget_usd: z.number().gte(0).lte(100).nullish().default(null),
  // Go on with this conversation (engineer.threadOf); a new one when empty.
  thread_id: text(200).nullish().default(null),
  attachments: ids,
});
export const EngineerReply = z.object({ text: text(20_000).default(""), choice: text(300).nullish().default(null), attachments: ids });
// One per choice of the plan, in order: "assumed", "alternative", or the user's own answer.
export const ChoiceAnswers = z.object({ picks: z.array(z.string()).min(1).max(5) });
export const FollowUp = z.object({
  prompt: z.string().min(3),
  attachments: ids,
  budget_usd: z.number().gt(0).lte(10_000).nullish().default(null),
  // Default to the earlier task's settings.
  allow_network: z.boolean().nullish().default(null),
  use_cli: z.boolean().nullish().default(null),
});
export const CreateChat = z.object({
  message: z.string().min(1).max(20_000),
  attachments: ids,
  budget_usd: z.number().gt(0).lte(10_000).default(1),
  use_cli: z.boolean().default(true),
  project_dir: text(4096).nullish().default(null),
  // A model that can hold a conversation (supervisor.candidates); the best one when empty.
  model_id: text(200).nullish().default(null),
});
export const PromoteChat = z.object({
  // What the task is to do; the chat's first message when empty. The conversation goes with it.
  prompt: text(20_000).default(""),
  budget_usd: z.number().gt(0).lte(10_000).default(2),
  use_cli: z.boolean().nullish().default(null),
  allow_network: z.boolean().default(false),
  // More files for the task, besides the chat's own.
  attachments: ids,
});
export const GithubToken = z.object({ token: z.string().min(10).max(500) });
export const CapabilitySwitch = z.object({
  enabled: z.boolean(),
  // An uploaded package is code from elsewhere: the user confirms what it may reach and gets.
  confirmed: z.boolean().default(false),
});
export const CapabilitySecrets = z.object({ values: z.record(z.string(), z.string()) });
export const CapabilityModel = z.object({ model_id: text(200).nullish().default(null) });
export const PublishRequest = z.object({
  // Either create ``name`` with the saved token, or push to an existing empty ``remote``.
  name: z.string().nullish().default(null),
  private: z.boolean().default(true),
  description: z.string().default(""),
  remote: z.string().nullish().default(null),
});

// ---- Query parameters, as FastAPI reads them ----

export type Query = Record<string, string | undefined>;

export function queryInt(query: Query, name: string, fallback: number): number {
  const value = query[name];
  if (value === undefined) return fallback;
  if (!/^\s*[+-]?\d+\s*$/.test(value)) {
    throw new HttpError(422, [{ type: "int_parsing", loc: ["query", name], msg: "Input should be a valid integer, unable to parse string as an integer" }]);
  }
  return Number.parseInt(value, 10);
}

export function queryBool(query: Query, name: string, fallback: boolean): boolean {
  const value = query[name];
  if (value === undefined) return fallback;
  const word = value.trim().toLowerCase();
  if (["1", "true", "t", "yes", "y", "on"].includes(word)) return true;
  if (["0", "false", "f", "no", "n", "off"].includes(word)) return false;
  throw new HttpError(422, [{ type: "bool_parsing", loc: ["query", name], msg: "Input should be a valid boolean, unable to interpret input" }]);
}

export function queryText(query: Query, name: string): string {
  const value = query[name];
  if (value === undefined) throw new HttpError(422, [{ type: "missing", loc: ["query", name], msg: "Field required" }]);
  return value;
}

export const intParam = (params: Json, name: string): number => queryInt(params, name, 0);

// The 模型 page's totals: calls and spend per model over this many days.
export const USAGE_DAYS = 30;
export const USAGE_RUNS = 3;
export const SHOWN_CHANGED_FILES = 50;
export const SHOWN_COMMAND_CHARS = 300;
export const CHANGEABLE = FINISHED;

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
  // A contract step stopped at its limit would be refused again before any model is picked: the
  // user continuing it grants what a lead's rerun grants (contracts.extend).
  if (node.artifact_contract && ExecutorBase.contractLimitReason(node)) contracts.extend(node);
}

/** Content-Disposition as Starlette's FileResponse writes it. */
export function disposition(kind: string, name: string): string {
  const quoted = quote(name);
  return quoted !== name ? `${kind}; filename*=utf-8''${quoted}` : `${kind}; filename="${name}"`;
}

export const event = (runId: string, kind: string, data: Json = {}) => EventSchema.parse({ run_id: runId, kind, data });

export const chatRequired = () => {
  if (!chat.enabled()) throw new HttpError(409, chat.NOT_ENABLED);
};
export const packagesAllowed = () => {
  if (!settings.capability_packages) throw new HttpError(409, "本机还没开启能力包：在 .env 里设 FLUIDFORM_CAPABILITY_PACKAGES=true 后重启。");
};

// ---- Small helpers ----

/** Now, shifted by ``days``, as Python's isoformat writes it (the database's times compare as text). */
export function pythonIsoNow(days: number): string {
  return pythonIso(new Date(Date.now() + days * 86_400_000));
}

/** ``items[index]`` as Python indexes: negative from the end; undefined when out of range. */
export function pyIndex<T>(items: T[], index: number): T | undefined {
  const at = index < 0 ? items.length + index : index;
  return at >= 0 && at < items.length ? items[at] : undefined;
}

/** How Python 3.9 writes a RunStatus in an f-string: its value. */
export function pyStatus(status: string): string {
  return status;
}

/** secrets.setProviderKey's refusal of an unknown provider (Python's ValueError). */
export function isValueError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Unsupported provider");
}
