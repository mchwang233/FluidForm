// Model calls: membership CLIs through cli-channels; API models over HTTP, with the
// platform's own tool loop when they act on a workspace (agent.ts), streaming, retries and backoff,
// prompt caching, reasoning effort, and compaction of a long conversation.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import * as agentTools from "./agent.js";
import * as files from "./attachments.js";
import { BudgetExceeded, ProviderError, StepLimitExceeded } from "./budget.js";
import * as callRecords from "./calls.js";
import { boundBytes, inputBound, ProviderGate, retryAfter, type Limits } from "./call-control.js";
import * as chatActions from "./chat-actions.js";
import { CliChannelRegistry, CliError, specFor, type CliText, InputTooLarge, inputTooLarge, SessionLost } from "./cli-channels.js";
import { settings } from "./config.js";
import { ArtifactBlocked } from "./contracts.js";
import * as memory from "./conversation.js";
import type { Conversation } from "./conversation.js";
import type { Database } from "./db.js";
import * as mcp from "./mcp.js";
import type { Attachment, ModelProfile, SupervisorSession } from "./models.js";
import * as progress from "./progress.js";
import { formatG, head, pyDumps, pyRegex, pyRound } from "./py.js";
import { REVIEW_MARKER } from "./quality.js";
import { ModelUnavailable, QuotaTracker } from "./quota.js";
import * as apiProviders from "./api-providers.js";
import { PROVIDER_ENV } from "./secret-names.js";
import * as streaming from "./streaming.js";

export const TOOL_LIMIT_REQUIREMENTS = { counting_unit: "tool_call", hard_limit: true } as const;
type Json = Record<string, any>;

export class ProviderResult {
  constructor(
    public text: string,
    public input_tokens: number,
    public output_tokens: number,
    public used_model_id: string | null = null,
    fields: Partial<ProviderResult> = {},
  ) {
    Object.assign(this, fields);
  }

  accounted_cost_usd = 0;
  // Input tokens the provider read from its prompt cache (billed at the cache price).
  cached_input_tokens = 0;
  // Turns of tool calls an acting API model took, and whether it hit its limit, so this text is the
  // progress summary it was asked for at the end rather than a finished answer.
  turns = 0;
  turn_limit = false;
  usage_known = true;
  cache_write_tokens = 0;
  warnings: string[] = [];
}

/** What a call may spend, as the executor gives it: RequestBudget and what the executor adds. */
export type SpendOk = {
  allows(modelId?: string, inputTokens?: number, outputTokens?: number): boolean | Promise<boolean>;
  context?: Record<string, unknown>;
  turnRemaining?: (() => number) | null;
  stepRemaining?: (() => number) | null;
  toolRemaining?: (() => number) | null;
  beginTurn?: () => Promise<void>;
  beginTool?: (() => Promise<void>) | null;
  record?: (modelId: string, input: number, output: number, cached: number) => Promise<void>;
  reserve?: (modelId: string, body: unknown, maximum: number) => Promise<number>;
  canSpend?(cost: number): boolean;
  recordUsd?(cost: number): Promise<void>;
};

/** Input tokens read from the prompt cache, as an OpenAI-compatible provider reports them: DeepSeek's
 *  prompt_cache_hit_tokens, or prompt_tokens_details.cached_tokens (OpenAI, GLM, MiniMax, Kimi). */
export function cachedTokens(usage: Json): number {
  if (usage.prompt_cache_hit_tokens !== undefined && usage.prompt_cache_hit_tokens !== null) return Math.trunc(Number(usage.prompt_cache_hit_tokens || 0));
  const details = usage.prompt_tokens_details || {};
  return details && typeof details === "object" && !Array.isArray(details) ? Math.trunc(Number(details.cached_tokens || 0)) : 0;
}

// Thinking some models (MiniMax) write into the content rather than a field of its own.
const THINKING = pyRegex(String.raw`<think>.*?</think>\s*`, "sg");

/** A reply's content without written-out thinking: kept in the history, not in the answer. */
export function answer(content: unknown): unknown {
  if (typeof content !== "string" || !content.includes("<think>")) return content;
  return content.replace(THINKING, "").trim();
}

export const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
// The floor a cap the model rejects is retried down to.
export const PLAIN_OUTPUT_TOKENS = 4096;
const OUTPUT_LIMIT_REJECTED = pyRegex(String.raw`max_(?:completion_)?tokens|max_?output|output tokens`, "i");
// Turns for a tool loop that has no limit set and nobody checking on it (a diagnosis, say).
export const UNWATCHED_TURNS = 40;
// Turns before the limit at which the model is told to wrap up.
export const WRAP_UP_TURNS = 5;
// The start of each tool's output kept in the attempt's log, to see what the model saw.
export const LOGGED_OUTPUT = 500;
export const limits = { MAX_LOGGED_CALLS: 300 };
// How much of each tool output the full trace keeps (agent.Workspace.trace).
export const TRACE_OUTPUT = 200_000;
export const turnLimitMark = (limit: number) => `在 ${limit} 轮工具调用后仍未完成`;

/** A conversation as one prompt; earlier turns first, so the prefix stays the same (and cached). */
export function transcript(history: { role: string; content: string }[], prompt: string): string {
  if (!history.length) return prompt;
  const turns = history.map((item) => `[${item.role.toUpperCase()}]\n${item.content}`).join("\n\n");
  return `The conversation so far:\n\n${turns}\n\n[USER]\n${prompt}`;
}

const isDict = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const length = (text: string) => [...text].length;

const turnsOf = (turn: number, limit: number | null) => (limit === null ? turn : Math.min(turn, limit));

/** Appended to the last tool result as the turns run out. */
export function turnNote(left: number): string {
  if (left === WRAP_UP_TURNS) {
    return `[System notice] Only ${left} turns of tool calls are left. Do not start new work: finish `
      + "the change in hand, run one final check, then answer without calling a tool.";
  }
  if (left === 0) {
    return "[System notice] No turns of tool calls are left. Do not call any tool. Answer now with a "
      + "progress summary (not UNABLE: unfinished work is not a limit of the environment): what is done "
      + "(files, checks and their results), what is not done yet, "
      + "and exactly what the next attempt should do.";
  }
  return "";
}

/** A reply as the provider sent it (or, for a stream, as it would have sent it whole). */
export class Reply {
  constructor(readonly status: number, readonly text: string, readonly headers: Headers = new Headers()) {}

  get isError(): boolean {
    return this.status >= 400;
  }

  get isSuccess(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  json(): any {
    return JSON.parse(this.text);
  }
}

/** A streamed reply that started, then sent nothing for the whole deadline. */
class StreamSilent extends Error {
  override name = "StreamSilent";
}
class Deadline extends Error {
  override name = "TimeoutError";
}

/** Python's RuntimeError: the failures a model call reports, as opposed to programming errors. */
const isRuntimeError = (error: unknown) => error instanceof ProviderError || error instanceof CliError || error instanceof ArtifactBlocked
  || error instanceof progress.Stopped || error instanceof ModelUnavailable;
const isAbort = (error: unknown) => (error as Error)?.name === "AbortError";

function sleep(seconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done, fail) => {
    if (signal?.aborted) return fail(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      done();
    }, seconds * 1000);
    const stop = () => {
      clearTimeout(timer);
      fail(signal!.reason);
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/** ``work`` within ``seconds``; Deadline after, or ``signal``'s reason as soon as it is aborted. */
async function within<T>(seconds: number, work: Promise<T>, fail: () => Error = () => new Deadline(), signal?: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let stop: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(fail()), seconds * 1000);
      if (signal) {
        stop = () => reject(signal.reason);
        if (signal.aborted) stop();
        else signal.addEventListener("abort", stop, { once: true });
      }
    })]);
  } finally {
    clearTimeout(timer);
    if (stop) signal!.removeEventListener("abort", stop);
  }
}

type Call = [string, string, Json];
type Stepped = [unknown, Call[], number, number, boolean]; // text, tool calls, input, output, truncated
type Step = (state: Json, signal: AbortSignal) => Promise<Stepped>;
export type Fetch = typeof fetch;

/** A conversation so far, as the model is sent it: its system prompt (instead of an agent's
 *  instructions) and the turns before the prompt. */
export type Dialogue = { system: string; messages: { role: "user" | "assistant"; content: string; images?: Attachment[] }[]; effort?: string | null };

export type CompleteOptions = {
  dialogue?: Dialogue | null;
  /** A CLI step's conversation to go on in: the one a restart cut off (NodeAttempt.cli_session). */
  cli_session?: string | null;
  workspace?: string | null; cli_timeout?: number; allow_api_fallback?: boolean; attachments?: Attachment[]; act?: boolean;
  spend_ok?: SpendOk | null; repair?: boolean; max_turns?: number | null; tool_log?: Json[] | null; network?: boolean;
  review_workspace?: string | null; review_files?: string[]; watch?: progress.Watch | null; conversation?: Conversation | null;
  effort?: string | null; overrun?: [number, progress.Watch] | null; tool_trace?: string | null; signal?: AbortSignal;
};

// ``made``: what the tasks the chat asked for made, in its folder (tasks/<task>/<file>), to send again when asked.
export type ChatTools = { folder: string; turns: number; network: boolean; log?: Json[] | null; actions?: string[]; seconds: number; made?: string[] };

const openaiImage = (item: Attachment) => ({ type: "image_url", image_url: { url: `data:${item.media_type};base64,${files.imageData(item)}` } });
const anthropicImage = (item: Attachment) => ({ type: "image", source: { type: "base64", media_type: item.media_type, data: files.imageData(item) } });
const geminiImage = (item: Attachment) => ({ inline_data: { mime_type: item.media_type, data: files.imageData(item) } });

export class ProviderRegistry {
  readonly cli = new CliChannelRegistry();
  readonly quota: QuotaTracker;
  // The live catalog (updated in place by catalog sync), for each model's output ceiling.
  readonly models: Record<string, ModelProfile>;
  maxAttempts = 4;
  // Models that rejected a reasoning effort: they are sent none (see send).
  readonly noEffort = new Set<string>();
  retryBaseDelay = 1.0;
  retryMaxDelay = 30.0;
  readonly gates = new Map<string, ProviderGate>();
  fetch: Fetch = (input, init) => fetch(input, init);

  constructor(readonly db: Database | null = null, models: Record<string, ModelProfile> | null = null) {
    this.quota = new QuotaTracker(db);
    this.models = models ?? {};
  }

  /** Models that can take work now: set up, and not out of quota. */
  configuredModels(modelIds: Iterable<string>): Set<string> {
    const configured = new Set(["mock:local", ...this.cli.availableModelIds()]);
    for (const modelId of modelIds) {
      // Its provider in use (its package on) and its key set.
      const env = apiProviders.ofModel(modelId)?.key_env;
      if (env && process.env[env]) configured.add(modelId);
    }
    return new Set([...configured].filter((modelId) => !this.quota.exhausted(modelId)));
  }

  /** Only the platform-owned API tool loop can count and intercept every invocation. */
  toolLimitCapabilities(modelId: string): { counting_unit: string | null; hard_limit: boolean } {
    if (modelId.startsWith("cli:")) return CliChannelRegistry.toolLimitCapabilities(modelId);
    const model = this.models[modelId];
    if (!apiProviders.byId(modelId.split(":", 1)[0]) || !settings.api_agent || (model && (model.channel === "cli" || model.supports_tools === false))) {
      return { counting_unit: null, hard_limit: false };
    }
    return { ...TOOL_LIMIT_REQUIREMENTS };
  }

  /** A limit or exhausted upstream retry throws ModelUnavailable and excludes this model until its
   *  cooldown ends, so callers can switch to another. */
  complete(modelId: string, prompt: string, options: CompleteOptions = {}): Promise<ProviderResult> {
    return callRecords.observed(this, "complete", modelId, options, async () => {
      if (this.quota.exhausted(modelId)) throw this.quota.error(modelId);
      try {
        return await this.completeOnce(modelId, prompt, options);
      } catch (error) {
        if (error instanceof ModelUnavailable || error instanceof InputTooLarge || !isRuntimeError(error)) throw error;
        const kind = this.quota.classify(modelId, (error as Error).message);
        if (kind) {
          const unavailable = this.quota.mark(modelId, (error as Error).message, kind);
          (unavailable as any).usage = (error as any).usage ?? null;
          (unavailable as any).cause = error;
          throw unavailable;
        }
        throw error;
      }
    });
  }

  /** One message in a conversation that lasts (the task's lead, supervisor): a membership CLI
   *  continues its own conversation; an API model is sent the whole history again, which its prompt
   *  cache makes cheap. ``session`` is updated in place. */
  converse(session: SupervisorSession, text: string, { timeout = null, spend_ok = null, attachments = [], tools = null, dialogue = null, signal }:
    { dialogue?: Dialogue | null; timeout?: number | null; spend_ok?: SpendOk | null; attachments?: Attachment[]; tools?: ChatTools | null; signal?: AbortSignal } = {}): Promise<ProviderResult> {
    const modelId = session.model_id as string;
    const effort = session.reasoning_effort || dialogue?.effort || settings.lead_reasoning_effort;
    return callRecords.observed(this, "converse", modelId, { spend_ok }, async () => {
      const record = callRecords.row();
      if (record) record.requested_effort = effort;
      if (this.quota.exhausted(modelId)) throw this.quota.error(modelId);
      // Files the user attached to this message (a chat's first one): a CLI is told where they are and
      // may read them; an API model gets text files inline and images as images, as in a step.
      let prompt = text;
      if (attachments.length) prompt += files.describe(attachments, modelId.startsWith("cli:")) + files.inlineText(attachments);
      let result: ProviderResult;
      if (modelId.startsWith("cli:")) {
        mkdirSync(session.cwd as string, { recursive: true });
        try {
          const [reply, sid] = await this.cli.converse(modelId, prompt, session.cwd as string, { sessionId: session.session_id, timeout,
            effort: session.reasoning_effort || null, attachments, signal });
          session.session_id = sid;
          result = cliResult(reply, modelId);
        } catch (error) {
          if (error instanceof SessionLost || error instanceof InputTooLarge || !isRuntimeError(error)) throw error;
          const message = (error as Error).message;
          if (inputTooLarge(message)) throw new InputTooLarge(message);
          const kind = this.quota.classify(modelId, message);
          if (kind) throw this.quota.mark(modelId, message, kind);
          throw new ProviderError(message);
        }
      } else {
        const images = attachments.filter((item) => item.kind === "image");
        const extra: CompleteOptions = images.length ? { attachments: images } : {};
        // A chat doing a quick job itself (supervisor.chatTools): the steps' tools in its folder,
        // bounded in tool calls and in time.
        if (tools) Object.assign(extra, { act: true, workspace: tools.folder, max_turns: tools.turns, network: tools.network, tool_log: tools.log ?? null });
        // What it asks FluidForm to do as tool calls becomes the lines it would have written.
        const noted: string[] = [];
        const stop = new AbortController();
        const both = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
        result = await chatActions.pending.run(tools ? [noted, new Set(tools.actions ?? [])] : null, async () => {
          // A chat is sent as it stands (dialogue, built each turn); a task's lead keeps what it was sent.
          const call = this.complete(modelId, dialogue ? text : transcript(session.history as { role: string; content: string }[], prompt),
            { spend_ok, effort, ...extra, ...(dialogue ? { dialogue, attachments } : {}), signal: both });
          if (!tools) return call;
          try {
            return await within(tools.seconds, call);
          } catch (error) {
            if (!(error instanceof Deadline)) throw error;
            stop.abort(new Deadline());
            call.catch(() => undefined);
            return new ProviderResult(`（这件事 ${formatG(tools.seconds)} 秒内没做完，我先停下了。要继续的话，可以把它排成任务。）`, 0, 0, modelId);
          }
        });
        result.text = chatActions.withActions(result.text, noted);
        // What an older version kept of a chat as sent stays as it is, to be read; it is not sent.
        if (!dialogue) session.history = [...session.history, { role: "user", content: prompt }, { role: "assistant", content: result.text }];
      }
      session.calls += 1;
      return result;
    });
  }

  /** One model call. With ``act``, an API model works on ``workspace`` through tools (agent.ts) until
   *  it is done; ``spend_ok`` can stop it. ``repair`` lets the model's commands leave the sandbox to fix
   *  the environment; ``network`` lets sandboxed commands reach the internet for a task that allows it.
   *  ``review_workspace`` gives API reviewers only safe file reads, independently of act/repair.
   *  ``watch`` checks a long call from time to time instead of a turn limit or a timeout.
   *  ``conversation`` keeps an acting model's conversation so a later attempt can continue it.
   *  ``effort`` replaces the configured reasoning effort, for simple work such as summaries.
   *  ``overrun`` is [expected turns, check]: an acting model past progress.OVERRUN_FACTOR times those
   *  turns is checked, and stopped if the check says so. */
  async completeOnce(modelId: string, given: string, options: CompleteOptions): Promise<ProviderResult> {
    const { workspace = null, cli_timeout = 900, allow_api_fallback = true, act = false, spend_ok = null, repair = false, max_turns = null,
      tool_log = null, network = false, review_workspace = null, review_files = [], watch = null, conversation = null, effort = null,
      overrun = null, tool_trace = null, dialogue = null, cli_session = null, signal } = options;
    const attachments = [...(options.attachments ?? [])];
    const provider = modelId.slice(0, modelId.indexOf(":"));
    const model = modelId.slice(modelId.indexOf(":") + 1);
    let prompt = given;
    if (spend_ok?.turnRemaining && (!act || !Object.entries(TOOL_LIMIT_REQUIREMENTS).every(([key, value]) =>
      (this.toolLimitCapabilities(modelId) as Json)[key] === value) || typeof spend_ok.beginTool !== "function")) {
      throw new ArtifactBlocked("此通道不能可靠执行声明的工具调用上限。");
    }
    if (provider === "cli") {
      if (conversation?.handoff) prompt += conversation.handoff;
      try {
        const text = await this.cli.complete(modelId, prompt + files.describe(attachments, true), workspace || settings.workspace_root,
          { timeout: cli_timeout, attachments, repair, network, watch, effort, toolTrace: tool_trace, session: cli_session, signal });
        return cliResult(text, modelId);
      } catch (error) {
        // Stuck, not unavailable: the attempt fails rather than falling back to an API model.
        if (error instanceof progress.Stopped) throw new ProviderError(error.message);
        if (error instanceof InputTooLarge || !isRuntimeError(error)) throw error;
        const message = (error as Error).message;
        if (inputTooLarge(message)) throw new InputTooLarge(message);
        const kind = this.quota.classify(modelId, message);
        // Availability failures go through the scheduler's ordinary model/budget constraints,
        // including CLI-to-CLI handoff and project tool requirements.
        if (kind) throw this.quota.mark(modelId, message, kind);
        if (!allow_api_fallback) throw new ProviderError(message);
        const fallback = specFor(modelId)!.fallback_model_id;
        if (!this.configuredModels([fallback]).has(fallback)) throw new ProviderError(`${message}; no API fallback is configured`);
        const result = await this.complete(fallback, prompt, { workspace, cli_timeout, attachments, act, spend_ok, network, review_workspace,
          review_files, watch, signal });
        result.used_model_id = fallback;
        return result;
      }
    }
    const images = attachments.filter((item) => item.kind === "image");
    prompt = prompt + files.describe(attachments, false) + files.inlineText(attachments);
    if (provider === "mock") {
      // The demo model accepts work it is asked to review, so offline demos complete.
      const text = prompt.includes(REVIEW_MARKER) ? '{"passed": true, "reason": "Demo review: accepted."}'
        : prompt.includes("You are verifying:") ? "Demo verification.\nVERDICT: PASS" : `Completed by ${modelId}: ${head(prompt, 800)}`;
      return new ProviderResult(text, Math.max(1, Math.floor(length(prompt) / 4)), Math.max(1, Math.floor(length(text) / 4)), modelId);
    }
    let agent: agentTools.Workspace | null = null;
    if (review_workspace !== null) {
      // More turns when it can rerun a check than when it only reads.
      agent = new agentTools.Workspace(review_workspace, { readOnly: true, readableFiles: review_files,
        maxTurns: max_turns || (agentTools.sandboxAvailable() ? 12 : 8), log: tool_log });
    } else if (act) {
      agent = new agentTools.Workspace(workspace || settings.workspace_root, { host: repair, maxTurns: max_turns, log: tool_log, network, trace: tool_trace });
    }
    if (agent) {
      agent.watch = watch;
      agent.overrun = overrun;
    }
    try {
      const wire = apiProviders.ofModel(modelId)?.wire;
      if (!wire) throw new ProviderError(`${provider} 没有启用：在能力里打开它的模型包。`);
      if (wire === "anthropic") return await this.anthropic(model, prompt, images, agent, spend_ok, effort, conversation, signal, dialogue);
      if (wire === "gemini") return await this.gemini(model, prompt, images, agent, spend_ok, effort, conversation, signal, dialogue);
      return await this.openaiCompatible(provider, model, prompt, images, agent, spend_ok, agent ? conversation : null, effort, signal, dialogue);
    } finally {
      agent?.close(); // this attempt's /tmp
    }
  }

  async testProvider(provider: string): Promise<string> {
    const declared = apiProviders.byId(provider);
    if (!declared) throw new ProviderError(`Unsupported provider: ${provider}`);
    const key = process.env[declared.key_env];
    if (!key) throw new ProviderError(`No API key is configured for ${provider}`);
    const timeout = AbortSignal.timeout(settings.api_request_timeout * 1000);
    let response: Response;
    if (declared.wire === "gemini") {
      response = await this.fetch(`${declared.models_url}?${new URLSearchParams({ key })}`, { signal: timeout });
    } else if (declared.wire === "anthropic") {
      response = await this.fetch(declared.models_url, { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }, signal: timeout });
    } else {
      response = await this.fetch(declared.models_url, { headers: { Authorization: `Bearer ${key}` }, signal: timeout });
    }
    const text = await response.text();
    if (response.status >= 400) throw new ProviderError(`Connection test failed (${response.status}): ${head(text, 200)}`);
    return "Connection verified";
  }

  /** POST with exponential backoff on rate limits, server errors, and network failures. With
   *  ``stream`` the reply comes as server-sent events, put back together by ``stream`` into the reply
   *  the provider sends without streaming. The request is then stopped only when nothing at all
   *  arrives for ``api_reply_deadline``: a model may think for long, as long as it keeps sending. */
  async post(provider: string, url: string, body: Json, { headers = {}, params = null, stream = null, signal }:
    { headers?: Record<string, string>; params?: Record<string, string> | null; stream?: streaming.Assemble | null; signal?: AbortSignal } = {}): Promise<Reply> {
    const deadline = settings.api_reply_deadline;
    let gate = this.gates.get(provider);
    if (!gate) this.gates.set(provider, (gate = new ProviderGate()));
    const limits = (settings.provider_limits[provider] ?? {}) as Limits;
    const target = params ? `${url}?${new URLSearchParams(params)}` : url;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      let delay = this.retryBaseDelay * 2 ** (attempt - 1);
      const ceiling = body.max_tokens ?? body.max_completion_tokens ?? (body.generationConfig || {}).maxOutputTokens ?? 0;
      const requested = inputBound(body) + ceiling;
      const record = callRecords.row();
      let response: Reply;
      try {
        response = await gate.hold(limits, requested, async (queued, reservation) => {
          if (record) {
            record.requests += 1;
            record.retries += Number(attempt > 1);
            record.queue_seconds += queued;
            callRecords.save();
          }
          const started = performance.now();
          const reply = stream ? await this.stream(target, body, headers, stream, deadline, signal)
            : await this.plain(target, body, headers, deadline, signal);
          if (record) {
            record.exchanges.push({ status: reply.status, duration_seconds: pyRound((performance.now() - started) / 1000, 3), queue_seconds: pyRound(queued, 3) });
          }
          if (reply.isSuccess) {
            const measured = responseUsage(provider, reply.json());
            if (measured[4]) reservation[1] = measured[0] + measured[1];
            await callRecords.usage(record ? this.models[record.model_id] : null, ...measured);
          }
          return reply;
        }, signal);
      } catch (error) {
        if (error instanceof Deadline || error instanceof StreamSilent) {
          // Sending it again would most likely hang again: fail now so another model takes over
          // (quota.UNAVAILABLE matches "request failed"). A stream that stopped is StreamSilent.
          const silence = error instanceof StreamSilent ? "回复中途停了，没有收到任何数据" : "没有回复";
          throw new ProviderError(`${provider} request failed: ${formatG(deadline / 60)} 分钟${silence}，已停止这次请求`);
        }
        if (error instanceof streaming.StreamError) throw new ProviderError(`${provider} returned an error in its stream: ${error.message}`);
        if (isAbort(error) || isRuntimeError(error) || !(error instanceof TypeError)) throw error;
        // fetch's network failure (httpx's TransportError).
        if (record) record.usage_known = false;
        callRecords.warning("请求传输失败；重试前的请求可能已被计费，其用量尚未确认。");
        if (attempt === this.maxAttempts) {
          const cause = (error as Error & { cause?: Error }).cause;
          throw new ProviderError(`${provider} request failed: ${cause?.message ?? error.message}`);
        }
        await sleep(delay, signal);
        continue;
      }
      if (!RETRYABLE_STATUS.has(response.status) || attempt === this.maxAttempts) return response;
      delay = retryAfter(response.headers.get("retry-after"), Math.min(delay, this.retryMaxDelay));
      if (response.status === 429) gate.coolDown(delay);
      await sleep(delay, signal);
    }
    throw new Error("unreachable");
  }

  private async plain(url: string, body: Json, headers: Record<string, string>, deadline: number, signal?: AbortSignal): Promise<Reply> {
    const stop = new AbortController();
    const both = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
    try {
      return await within(deadline, (async () => {
        const response = await this.fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: both });
        return new Reply(response.status, await response.text(), response.headers);
      })(), undefined, signal);
    } catch (error) {
      stop.abort();
      throw error;
    }
  }

  /** One streamed POST, waiting at most ``deadline`` for each piece. An error, or a reply that is not
   *  a stream (a provider that ignores ``stream``), is returned as it came. */
  private async stream(url: string, body: Json, headers: Record<string, string>, assemble: streaming.Assemble, deadline: number,
    signal?: AbortSignal): Promise<Reply> {
    const stop = new AbortController();
    const both = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
    try {
      const response = await within(deadline, this.fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body), signal: both }), undefined, signal);
      if (response.status >= 400 || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
        return new Reply(response.status, await within(deadline, response.text(), undefined, signal), response.headers);
      }
      const lines: string[] = [];
      // Someone waiting to show the reply as it is written (an automation's chat) hears it.
      const hear = streaming.listener.get();
      let heard = "";
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      const take = (line: string) => {
        lines.push(line);
        if (hear && line.startsWith("data:")) {
          const piece = streaming.events([line]).map((event) => streaming.textPiece(event)).join("");
          if (piece) {
            heard += piece;
            try {
              hear(heard); // only a courtesy to the listener
            } catch {
              // ignored
            }
          }
        }
      };
      for (;;) {
        const { done, value } = await within(deadline, reader.read(), () => new StreamSilent(), signal);
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const parts = pending.split(/\r\n|\n|\r/);
        pending = parts.pop()!;
        // A "\r" at the very end may be half of "\r\n": keep it for the next piece.
        for (const line of parts) take(line);
      }
      pending += decoder.decode();
      if (pending) for (const line of pending.split(/\r\n|\n|\r/)) take(line);
      return new Reply(200, JSON.stringify(assemble(streaming.events(lines))), new Headers({ "content-type": "application/json" }));
    } finally {
      stop.abort();
    }
  }

  /** Call the model, run the tools it asks for, and call again until it stops asking. ``step(state)``
   *  makes one request and returns [text, tool calls, input, output, truncated]; tool calls are [id,
   *  name, arguments] and their results go back via ``state``. ``truncated`` means the output hit its
   *  token cap. Without a workspace this is a single plain call. With ``conversation`` (OpenAI format
   *  only), the state is kept there, and a conversation of this model with a ``followup`` is continued. */
  private async loop(provider: string, model: string, given: string, images: Attachment[], agent: agentTools.Workspace | null,
    spendOk: SpendOk | null, step: Step, conversation: Conversation | null, signal?: AbortSignal, dialogue: Dialogue | null = null): Promise<ProviderResult> {
    const modelId = `${provider}:${model}`;
    let prompt = given;
    let tools: Json[] = agent ? [...agentTools.toolsFor(agentTools.sandboxAvailable(), agent.readOnly)] : [];
    if (agent) {
      if (!agent.readOnly && !agent.host) {
        tools = [...tools, ...(await chatActions.offered()), ...(await mcp.definitions(agent))];
        // An MCP tool with a price (a picture, a search) is paid by the call, from the same budget.
        agent.budget = spendOk;
      }
    }
    if (conversation?.recall && agent) tools = [...tools, memory.RECALL_TOOL];
    if (conversation?.handoff) prompt += conversation.handoff;
    // How to work with the tools is a system prompt, as Claude Code gives it; the task is the user's.
    const system = dialogue ? dialogue.system : agent ? await agent.instructions() : null;
    const fresh: Json = { prompt, system, before: dialogue?.messages ?? [], images, tools, history: null, results: null, provider };
    let state = fresh;
    let resumed = Boolean(conversation && conversation.modelId === modelId && conversation.followup && conversation.state?.history);
    if (resumed) {
      state = conversation!.state as Json;
      Object.assign(state, { tools, system, images, provider });
      memory.reopen(state, conversation!.followup!);
    }
    if (conversation) {
      conversation.modelId = modelId;
      conversation.state = state;
      conversation.followup = null;
      conversation.save();
    }
    let totalIn = 0;
    let totalOut = 0;
    let totalCached = 0;
    let turn = 0;
    let text: unknown = "";
    // Without a limit (the default) a long attempt is checked instead (progress.ts).
    const watch = agent?.watch ?? null;
    let limit: number | null = agent ? agent.maxTurns || settings.api_agent_max_turns || (watch ? null : UNWATCHED_TURNS) : 1;
    const hardLimit = spendOk?.turnRemaining ?? null;
    const toolRemaining = spendOk?.toolRemaining ?? null;
    if (toolRemaining && toolRemaining() <= 0) throw new StepLimitExceeded("达到声明工具调用上限，停止工作包。");
    if (hardLimit) {
      const remaining = hardLimit();
      if (remaining <= 0) throw new StepLimitExceeded("达到声明轮次上限，停止工作包。");
      limit = limit !== null ? Math.min(limit, remaining) : remaining;
    }
    const interval = settings.progress_check_minutes * 60_000;
    let nextCheck = performance.now() + interval;
    const seen: Json[] = [];
    const allows = async () => !spendOk || await spendOk.allows(modelId, totalIn, totalOut);

    /** ``step(state)``, with the check still made while one request takes long: a provider that never
     *  answers is otherwise only noticed after its read timeout and retries, many minutes later. */
    const stepped = async (current: Json): Promise<Stepped> => {
      const stop = new AbortController();
      const both = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
      const pending = step(current, both);
      const started = performance.now();
      try {
        while (watch) {
          let timer: NodeJS.Timeout | undefined;
          const ticked = await Promise.race([pending.then(() => false, () => false),
            new Promise<boolean>((done) => (timer = setTimeout(() => done(true), Math.max(0, nextCheck - performance.now()))))]);
          clearTimeout(timer);
          if (!ticked) break;
          const waited = progress.waiting((performance.now() - started) / 60_000);
          const reason = await watch(`${progress.apiEvidence(turn, seen as any)}\n${waited}`);
          if (reason) throw new ProviderError(`${modelId} ${progress.STOPPED}${reason}`);
          nextCheck = performance.now() + interval;
        }
        return await pending;
      } catch (error) {
        stop.abort();
        pending.catch(() => undefined);
        throw error;
      }
    };
    const usageSoFar = () => new ProviderResult("", totalIn, totalOut, modelId, { turns: turnsOf(turn, limit), cached_input_tokens: totalCached });
    try {
      // One turn past the limit: the model's chance to answer with a progress summary.
      for (turn = 1; limit === null || turn < (agent ? limit + 2 : 2); turn += 1) {
        const final = Boolean(agent) && limit !== null && turn > limit;
        if (final && hardLimit) {
          // No paid extra summary request at a declared hard limit.
          return new ProviderResult((text as string) || "声明轮次已用尽，保留工具日志供诊断。", totalIn, totalOut, modelId,
            { turns: limit!, turn_limit: true, cached_input_tokens: totalCached });
        }
        if (!(await allows())) throw new BudgetExceeded("已达到任务可用的预算，模型调用被中止。");
        memory.flush(state);
        conversation?.save();
        const compacted = agent ? await this.compactContext(modelId, state, step, spendOk, conversation, signal) : null;
        if (compacted) {
          totalIn += compacted[0];
          totalOut += compacted[1];
          totalCached += compacted[2];
        }
        const begin = spendOk?.beginTurn?.bind(spendOk);
        if (begin) await begin();
        let calls: Call[];
        let usedIn: number;
        let usedOut: number;
        let truncated: boolean;
        try {
          [text, calls, usedIn, usedOut, truncated] = await stepped(state);
        } catch (error) {
          if (!(resumed && turn === 1 && error instanceof ProviderError && error.message.includes(" returned 400"))) throw error;
          // The provider would not take the continued conversation: start afresh. Preserve an explicit
          // handoff and archive when native continuation is rejected.
          fresh.prompt += memory.handoff(conversation!);
          state = conversation!.state = fresh;
          resumed = false;
          if (begin) await begin();
          [text, calls, usedIn, usedOut, truncated] = await stepped(state);
        }
        state.calls = calls;
        state.last_input_tokens = usedIn;
        state.last_history_size = boundBytes(state.history ?? null);
        const usedCached = state.cached || 0;
        delete state.cached;
        totalIn += usedIn;
        totalOut += usedOut;
        totalCached += usedCached;
        if (spendOk?.record) await spendOk.record(modelId, usedIn, usedOut, usedCached);
        if (!(await allows())) throw new BudgetExceeded("已达到任务可用的预算，模型调用被中止。");
        if (truncated && !calls.length && (agent || !text)) {
          // A cut-off turn is not an answer; returning it would look like a model that finished
          // without doing anything.
          throw new ProviderError(`${modelId} 的输出达到单轮上限 ${state.limit ?? "None"} 个 token 被截断`
            + "（output truncated by length），没有给出完整回答或工具调用。");
        }
        if (!calls.length || !agent) {
          state.final = text;
          conversation?.save();
          return new ProviderResult((text as string) || "", totalIn, totalOut, modelId,
            { turns: turnsOf(turn, limit), turn_limit: final, cached_input_tokens: totalCached });
        }
        if (final) throw new ProviderError(`${modelId} ${turnLimitMark(limit!)}，最后也没有交出进度总结。`);
        const results: [string, string, string][] = [];
        state.results = results;
        conversation?.save(); // durable intent before any tool side effects
        const work = agent;
        // A turn's calls together: its reads and searches run at the same time.
        const execute = async ([callId, name, args]: Call) => {
          signal?.throwIfAborted(); // stopped: nothing more is done
          if (spendOk?.beginTool) {
            try {
              await spendOk.beginTool(); // reserve durably, before any tool side effects
            } catch (error) {
              if (error instanceof StepLimitExceeded) {
                results.push([callId, name, `BLOCKED: 工具未执行：${error.message}`]);
                conversation?.save();
              }
              throw error;
            }
          }
          // Someone shows the work as it happens (a chat's quick job, supervisor.ChatActivity).
          const shown = work.log as any;
          if (typeof shown?.starting === "function") shown.starting(name, agentTools.describeCall(name, args));
          const [output, ok] = name === "RecallHistory" && conversation ? memory.recall(conversation, args) : await work.run(name, args, signal);
          results.push([callId, name, output]);
          conversation?.save(); // each completion survives a later interrupted sibling
          seen.push({ turn, tool: name, detail: agentTools.describeCall(name, args), ok, output: head(output, LOGGED_OUTPUT) });
          if (work.log !== null && work.log.length < limits.MAX_LOGGED_CALLS) work.log.push(seen.at(-1)!);
          if (work.trace) trace(work.trace, { ...seen.at(-1), output: head(output, TRACE_OUTPUT) });
        };
        if (calls.every(([, name]) => agentTools.READ_ONLY_TOOLS.has(name) || name === "RecallHistory")) {
          // Settle admitted siblings before propagating a rejection; no tools may outlive the attempt
          // or lose their completion checkpoint and accounting.
          const settled = await Promise.allSettled(calls.map(execute));
          for (const item of settled) if (item.status === "rejected") throw item.reason;
        } else {
          for (const call of calls) await execute(call);
        }
        // Provider order is stable even if read-only tools finished out of order.
        const byId = new Map(results.map((item) => [item[0], item]));
        const ordered = calls.map(([callId]) => byId.get(callId)!);
        const note = limit !== null ? turnNote(limit - turn) : "";
        if (note) {
          const [callId, name, output] = ordered.at(-1)!;
          ordered[ordered.length - 1] = [callId, name, `${output}\n\n${note}`];
        }
        state.results = ordered;
        conversation?.save();
        if (hardLimit && (hardLimit() <= 0 || (toolRemaining && toolRemaining() <= 0) || (spendOk?.stepRemaining && spendOk.stepRemaining() <= 0))) {
          return new ProviderResult((text as string) || "声明限额已用尽，保留工具日志供诊断。", totalIn, totalOut, modelId,
            { turns: turn, turn_limit: true, cached_input_tokens: totalCached });
        }
        const [expected, check] = agent.overrun ?? [0, null];
        // Far past what a package was planned for: the lead says whether to go on.
        if (check && turn % (expected * progress.OVERRUN_FACTOR) === 0) {
          const reason = await check(progress.apiEvidence(turn, seen as any));
          if (reason) throw new ProviderError(`${modelId} ${progress.OVERRUN}${reason}`);
        }
        if (watch && performance.now() >= nextCheck) {
          // Not cut off at a time limit: another model says whether it is stuck.
          const reason = await watch(progress.apiEvidence(turn, seen as any));
          if (reason) throw new ProviderError(`${modelId} ${progress.STOPPED}${reason}`);
          nextCheck = performance.now() + interval;
        }
      }
      throw new Error("unreachable");
    } catch (error) {
      conversation?.save();
      if (error && typeof error === "object") (error as any).usage = usageSoFar();
      throw error;
    }
  }

  /** Summarize before context exhaustion; replace only after schema validation and archive. The
   *  summary uses the same model, budget reservation, effort and hard turn counter. */
  async compactContext(modelId: string, state: Json, step: Step, spendOk: SpendOk | null, conversation: Conversation | null,
    signal?: AbortSignal): Promise<[number, number, number] | null> {
    const history: Json[] = state.history || [];
    if (!history.length) return null;
    const size = boundBytes(history);
    const estimate = Math.max(Math.floor(size / 3), (state.last_input_tokens ?? 0) + Math.floor(Math.max(0, size - (state.last_history_size ?? 0)) / 3));
    const context = this.models[modelId]?.context_window || 64000;
    if (estimate < context * 0.65) return null;
    if (!conversation || !conversation.archive) throw new ProviderError("上下文接近上限且无法归档，保留记录并停止，禁止静默截断。");
    const remaining = spendOk?.turnRemaining;
    if (remaining && remaining() < 2) throw new StepLimitExceeded("剩余轮次不足以压缩上下文并继续，已保存会话。");
    const archiveId = conversation.remember();
    if (!archiveId) throw new ProviderError("无法保存上下文原文，停止压缩。");
    const summaryState: Json = { prompt: memory.SUMMARY_PROMPT + pyDumps(history, false), system: "Return a concise, factual JSON memory. Do not use tools.",
      images: [], tools: [], history: null, results: null };
    if (spendOk?.beginTurn) await spendOk.beginTurn();
    const [text, calls, usedIn, usedOut, truncated] = await step(summaryState, signal ?? new AbortController().signal);
    const cached = summaryState.cached || 0;
    delete summaryState.cached;
    if (spendOk?.record) await spendOk.record(modelId, usedIn, usedOut, cached);
    let summary: Record<string, string[]>;
    try {
      if (calls.length || truncated) throw new Error("unfinished summary");
      summary = memory.parseSummary((text as string) || "");
    } catch {
      throw new ProviderError("上下文摘要未通过结构验证；原会话已保留，停止本次尝试。");
    }
    // Keep ALL user instructions verbatim (tool results are not user instructions), plus structured
    // observations. If immutable instructions alone do not fit, stop explicitly.
    const original: Json[] = [];
    const memoryMessage = state.memory_message ? pyDumps(state.memory_message) : null;
    for (const message of history) {
      if (message.role === "system") original.push(message);
      else if (message.role === "user") {
        const blocks = message.content ?? message.parts ?? "";
        const isMemory = memoryMessage !== null && pyDumps(message) === memoryMessage;
        if (!isMemory && (typeof blocks === "string" || (Array.isArray(blocks)
          && !blocks.some((block: Json) => block.type === "tool_result" || "functionResponse" in block)))) original.push(message);
      }
    }
    const notice = memory.userMessage(state.provider, "Task memory (observations, verify before accepting):\n" + pyDumps(summary, false)
      + `\nFull history: RecallHistory archive_id=${archiveId}.`);
    // No private marker is sent to providers; archive references distinguish generated memory.
    const reduced = [...original, notice];
    if (Math.floor(boundBytes(reduced) / 3) > context * 0.5) throw new ProviderError("必须保留的任务约束超过上下文容量，已归档；需要拆分步骤。");
    Object.assign(state, { history: reduced, summary, memory_message: notice, last_input_tokens: 0, last_history_size: 0 });
    conversation.save();
    return [usedIn, usedOut, cached];
  }

  /** How hard the model should think, in the request fields its API takes: ``effort``
   *  (settings.reasoning_by_difficulty for steps), or for DeepSeek without one its configured effort.
   *  Nothing for a model known not to reason, or that rejected these fields before. */
  reasoning(provider: string, model: string, given: string | null = null): Json {
    const modelId = `${provider}:${model}`;
    const known = this.models[modelId];
    const effort = given || (provider === "deepseek" ? settings.deepseek_reasoning_effort : null) || null;
    const record = callRecords.row();
    if (record) record.requested_effort = effort;
    if (!effort || known?.supports_reasoning === false || this.noEffort.has(modelId)) {
      if (effort) {
        callRecords.warning(`${modelId} 未应用请求的推理强度 ${effort}；使用供应商默认值。`);
        if (settings.reasoning_fallback === "strict") throw new ProviderError("无法保证请求的推理强度；strict 模式禁止降级。");
      }
      if (record) record.effective_effort = "provider_default";
      return {};
    }
    const fields = reasoningFields(provider, effort);
    if (record) {
      record.effective_effort = fields.reasoning_effort || (fields.output_config || {}).effort
        || ((fields.generationConfig || {}).thinkingConfig || {}).thinkingLevel;
    }
    return fields;
  }

  outputCeiling(modelId: string): number {
    return this.models[modelId]?.max_output_tokens || settings.api_agent_max_output_tokens;
  }

  /** POST ``body`` with an output cap set by ``put(body, limit)``. The cap is the model's own output
   *  ceiling from the catalog, or api_agent_max_output_tokens when that is unknown; a model that rejects
   *  it is retried with half, down to the plain cap, and later turns keep the cap that worked. The
   *  budget reservation can only lower it. */
  private async send(provider: string, modelId: string, url: string, body: Json, put: (body: Json, limit: number) => void, state: Json,
    spendOk: SpendOk | null, request: { headers?: Record<string, string>; params?: Record<string, string>; stream: streaming.Assemble; signal?: AbortSignal }): Promise<Reply> {
    let maximum: number = state.maximum || this.outputCeiling(modelId);
    const tpm = ((settings.provider_limits[provider] ?? {}) as Limits).tpm ?? 0;
    if (tpm) {
      maximum = Math.min(maximum, tpm - inputBound(body) - 128);
      if (maximum < 1) throw new ProviderError("请求上下文已超过供应商 TPM 配额，不能排队后重试。");
    }
    for (;;) {
      state.limit = spendOk?.reserve ? await spendOk.reserve(modelId, body, maximum) : maximum;
      put(body, state.limit);
      const response = await this.post(provider, url, body, request);
      if (response.status === 400 && state.limit > PLAIN_OUTPUT_TOKENS && OUTPUT_LIMIT_REJECTED.test(response.text)) {
        maximum = state.maximum = Math.max(PLAIN_OUTPUT_TOKENS, Math.floor(state.limit / 2));
        const record = callRecords.row();
        if (record) record.retries += 1;
        continue;
      }
      if (response.status === 400 && EFFORT_REJECTED.test(response.text) && dropReasoning(body)) {
        if (settings.reasoning_fallback === "strict") throw new ProviderError(`${modelId} 拒绝请求的推理参数；strict 模式禁止自动降级。`);
        callRecords.warning(`${modelId} 拒绝推理参数，已明确降级为供应商默认值。`);
        const record = callRecords.row();
        if (record) {
          record.effective_effort = "provider_default";
          record.retries += 1;
        }
        const retried = await this.post(provider, url, body, request);
        if (!retried.isError) this.noEffort.add(modelId);
        return retried;
      }
      return response;
    }
  }

  private openaiCompatible(provider: string, model: string, prompt: string, images: Attachment[], agent: agentTools.Workspace | null,
    spendOk: SpendOk | null, conversation: Conversation | null, effort: string | null, signal?: AbortSignal, dialogue: Dialogue | null = null): Promise<ProviderResult> {
    const declared = apiProviders.byId(provider);
    const url = declared?.wire === "openai" ? declared.chat_url : undefined;
    if (!url) throw new ProviderError(`Unsupported provider: ${provider}`);
    const env = declared!.key_env;
    const step: Step = async (state, stepSignal) => {
      if (state.history === null || state.history === undefined) {
        state.history = state.system ? [{ role: "system", content: state.system }] : [];
        for (const item of state.before ?? []) {
          state.history.push({ role: item.role, content: item.images?.length ? [{ type: "text", text: item.content }, ...item.images.map(openaiImage)] : item.content });
        }
        state.history.push({ role: "user", content: state.images.length ? [{ type: "text", text: state.prompt },
          ...state.images.map((item: Attachment) => ({ type: "image_url", image_url: { url: `data:${item.media_type};base64,${files.imageData(item)}` } }))]
          : state.prompt });
      }
      for (const [callId, , output] of state.results || []) state.history.push({ role: "tool", tool_call_id: callId, content: output });
      delete state.results;
      const followup = state.followup;
      delete state.followup;
      if (followup) state.history.push({ role: "user", content: followup });
      const body: Json = { model, messages: state.history, ...this.reasoning(provider, model, effort) };
      if (state.tools.length) body.tools = state.tools.map((tool: Json) => ({ type: "function", function: tool }));
      const field = declared!.max_tokens_field ?? "max_tokens";
      Object.assign(body, { stream: true, stream_options: { include_usage: true } });
      const response = await this.send(provider, `${provider}:${model}`, url, body, (target, limit) => {
        target[field] = limit;
      }, state, spendOk, { headers: { Authorization: `Bearer ${process.env[env]}` }, stream: streaming.openai, signal: stepSignal });
      if (response.isError) throw new ProviderError(`${provider} returned ${response.status}: ${head(response.text, 300)}`);
      const data = response.json();
      const usage = data.usage || {};
      state.cached = cachedTokens(usage);
      const choice = data.choices[0];
      const message = choice.message;
      const calls = message.tool_calls || [];
      if (calls.length) {
        const reply: Json = { role: "assistant", content: message.content ?? null, tool_calls: calls };
        // DeepSeek's (and Kimi's) thinking mode needs it back within a tool loop.
        if (message.reasoning_content) reply.reasoning_content = message.reasoning_content;
        state.history.push(reply);
      }
      return [answer(message.content ?? null), calls.map((call: Json): Call => [call.id, call.function.name, toolArguments(call.function.arguments)]),
        usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0, choice.finish_reason === "length"];
    };
    return this.loop(provider, model, prompt, images, agent, spendOk, step, conversation, signal, dialogue);
  }

  private anthropic(model: string, prompt: string, images: Attachment[], agent: agentTools.Workspace | null, spendOk: SpendOk | null,
    effort: string | null, conversation: Conversation | null, signal?: AbortSignal, dialogue: Dialogue | null = null): Promise<ProviderResult> {
    const step: Step = async (state, stepSignal) => {
      if (state.history === null || state.history === undefined) {
        state.history = [...(state.before ?? []).map((item: Json) => ({ role: item.role, content: item.images?.length ? [...item.images.map(anthropicImage), { type: "text", text: item.content }] : item.content })),
          { role: "user", content: state.images.length ? [
          ...state.images.map((item: Attachment) => ({ type: "image", source: { type: "base64", media_type: item.media_type, data: files.imageData(item) } })),
          { type: "text", text: state.prompt }] : state.prompt }];
      }
      if (state.results?.length) {
        state.history.push({ role: "user", content: state.results.map(([callId, , output]: [string, string, string]) =>
          ({ type: "tool_result", tool_use_id: callId, content: output })) });
      }
      const body: Json = { model, messages: cachePoint(state.history), ...this.reasoning("anthropic", model, effort) };
      // The tools come before the system prompt in Anthropic's cache, so this caches both.
      if (state.system) body.system = [{ type: "text", text: state.system, cache_control: CACHE_POINT }];
      if (state.tools.length) body.tools = state.tools.map((tool: Json) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
      body.stream = true;
      const response = await this.send("anthropic", `anthropic:${model}`, "https://api.anthropic.com/v1/messages", body, (target, limit) => {
        target.max_tokens = limit;
      }, state, spendOk, { headers: { "x-api-key": process.env[PROVIDER_ENV.anthropic]!, "anthropic-version": "2023-06-01" }, stream: streaming.anthropic,
        signal: stepSignal });
      if (response.isError) throw new ProviderError(`anthropic returned ${response.status}: ${head(response.text, 300)}`);
      const data = response.json();
      const blocks: Json[] = data.content;
      const calls = blocks.filter((block) => block.type === "tool_use");
      if (calls.length) state.history.push({ role: "assistant", content: blocks });
      const text = blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
      const usage = data.usage;
      // Anthropic counts cached and cache-writing input apart from input_tokens.
      state.cached = usage.cache_read_input_tokens || 0;
      return [text, calls.map((block): Call => [block.id, block.name, block.input || {}]),
        usage.input_tokens + state.cached + (usage.cache_creation_input_tokens || 0), usage.output_tokens, data.stop_reason === "max_tokens"];
    };
    return this.loop("anthropic", model, prompt, images, agent, spendOk, step, conversation, signal, dialogue);
  }

  private gemini(model: string, prompt: string, images: Attachment[], agent: agentTools.Workspace | null, spendOk: SpendOk | null,
    effort: string | null, conversation: Conversation | null, signal?: AbortSignal, dialogue: Dialogue | null = null): Promise<ProviderResult> {
    const step: Step = async (state, stepSignal) => {
      if (state.history === null || state.history === undefined) {
        state.history = [...(state.before ?? []).map((item: Json) => ({ role: item.role === "assistant" ? "model" : "user", parts: [...(item.images ?? []).map(geminiImage), { text: item.content }] })),
          { role: "user", parts: [...state.images.map((item: Attachment) => ({ inline_data: { mime_type: item.media_type, data: files.imageData(item) } })),
          { text: state.prompt }] }];
      }
      if (state.results?.length) {
        state.history.push({ role: "user", parts: state.results.map(([, name, output]: [string, string, string]) =>
          ({ functionResponse: { name, response: { result: output } } })) });
      }
      const body: Json = { contents: state.history, ...this.reasoning("google", model, effort) };
      if (state.system) body.systemInstruction = { parts: [{ text: state.system }] };
      if (state.tools.length) body.tools = [{ functionDeclarations: state.tools }];
      const response = await this.send("google", `google:${model}`, `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent`,
        body, (target, limit) => {
          target.generationConfig ??= {};
          target.generationConfig.maxOutputTokens = limit;
        }, state, spendOk, { params: { key: process.env[PROVIDER_ENV.google]!, alt: "sse" }, stream: streaming.gemini, signal: stepSignal });
      if (response.isError) throw new ProviderError(`google returned ${response.status}: ${head(response.text, 300)}`);
      const data = response.json();
      const usage = data.usageMetadata || {};
      state.cached = usage.cachedContentTokenCount || 0;
      const candidate = data.candidates[0];
      const parts: Json[] = (candidate.content || {}).parts || [];
      const calls = parts.filter((part) => "functionCall" in part).map((part) => part.functionCall);
      if (calls.length) state.history.push({ role: "model", parts });
      const text = parts.map((part) => part.text ?? "").join("");
      return [text, calls.map((call, i): Call => [`${call.name}:${i}`, call.name, call.args || {}]),
        usage.promptTokenCount ?? 0, (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0), candidate.finishReason === "MAX_TOKENS"];
    };
    return this.loop("google", model, prompt, images, agent, spendOk, step, conversation, signal, dialogue);
  }
}

/** [input, output, cached, cache write, whether the usage was reported]. */
export function responseUsage(provider: string, data: Json): [number, number, number, number, boolean] {
  const wire = apiProviders.byId(provider)?.wire ?? provider;
  const usage = (wire === "gemini" ? data.usageMetadata : data.usage) || {};
  if (wire === "anthropic") {
    const cached = usage.cache_read_input_tokens ?? 0;
    const written = usage.cache_creation_input_tokens ?? 0;
    return [(usage.input_tokens ?? 0) + cached + written, usage.output_tokens ?? 0, cached, written, "input_tokens" in usage && "output_tokens" in usage];
  }
  if (wire === "gemini") {
    return [usage.promptTokenCount ?? 0, (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0), usage.cachedContentTokenCount ?? 0, 0,
      "promptTokenCount" in usage && "candidatesTokenCount" in usage];
  }
  return [usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0, cachedTokens(usage), 0, "prompt_tokens" in usage && "completion_tokens" in usage];
}

export function cliResult(reply: CliText, modelId: string): ProviderResult {
  const usage = reply.usage ?? {};
  return new ProviderResult(reply.text, usage.input_tokens ?? 0, usage.output_tokens ?? 0, modelId, {
    cached_input_tokens: usage.cached_input_tokens ?? 0, cache_write_tokens: usage.cache_write_tokens ?? 0, usage_known: Object.keys(usage).length > 0 });
}

// A 400 about the reasoning effort fields, as providers word it ("Unsupported parameter:
// 'reasoning_effort'", "reasoning_effort 参数值非法", "Unknown name \"thinkingConfig\"").
const EFFORT_REJECTED = pyRegex("reasoning|effort|thinking|output_config|思考|推理", "i");
// Reasoning effort, from least to most, as settings give it (reasoning_by_difficulty).
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Request fields asking ``provider``'s model for ``effort``: Anthropic's output_config, Gemini's
 *  thinking level, and reasoning_effort for the OpenAI-compatible wire, scaled to the efforts the
 *  provider takes (its package's ``efforts``: GLM only low, high and max; OpenAI tops out at xhigh),
 *  or as given (DeepSeek, ``raw_effort``). */
export function reasoningFields(provider: string, effort: string): Json {
  const level = EFFORTS.includes(effort) ? effort : effort === "ultra" ? "max" : "medium";
  const rank = (name: string) => EFFORTS.indexOf(name);
  const declared = apiProviders.byId(provider);
  if (declared?.wire === "anthropic") return { output_config: { effort: ({ none: "low", minimal: "low" } as Json)[level] ?? level } };
  if (declared?.wire === "gemini") return { generationConfig: { thinkingConfig: { thinkingLevel: rank(level) <= rank("low") ? "low" : "high" } } };
  if (declared?.raw_effort) return { reasoning_effort: effort };
  // The next effort it takes from the one asked for, or its most.
  const takes = (declared?.efforts ?? EFFORTS).filter((name) => EFFORTS.includes(name)).sort((a, b) => rank(a) - rank(b));
  return { reasoning_effort: takes.find((name) => rank(name) >= rank(level)) ?? takes[takes.length - 1] ?? level };
}

/** Take the reasoning effort out of a request body; whether it had one. */
export function dropReasoning(body: Json): boolean {
  let found = body.reasoning_effort !== undefined && body.reasoning_effort !== null;
  delete body.reasoning_effort;
  found = (body.output_config !== undefined && body.output_config !== null) || found;
  delete body.output_config;
  const config = body.generationConfig || {};
  const thinking = config.thinkingConfig !== undefined && config.thinkingConfig !== null;
  delete config.thinkingConfig;
  return thinking || found;
}

// Anthropic caches a request only up to a block marked like this (at most four per request).
export const CACHE_POINT = { type: "ephemeral" };

/** The conversation to send with its newest message marked for the prompt cache: the next turn then
 *  reads everything up to it from the cache. The history itself stays unmarked, so older turns do not
 *  keep their marks. */
export function cachePoint(history: Json[]): Json[] {
  if (!history.length) return history;
  const last = { ...history.at(-1)! };
  const content = last.content;
  const blocks: Json[] = typeof content === "string" ? [{ type: "text", text: content }] : content.map((block: Json) => ({ ...block }));
  if (blocks.length) blocks[blocks.length - 1].cache_control = CACHE_POINT;
  last.content = blocks;
  return [...history.slice(0, -1), last];
}

/** Add one tool call to an attempt's full trace; a trace that cannot be written is skipped. */
export function trace(path: string, call: Json): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, pyDumps(call, false) + "\n");
  } catch {
    // skipped
  }
}

/** Tool arguments arrive as a JSON string; malformed ones become an error the tool reports. */
export function toolArguments(raw: unknown): Json {
  if (isDict(raw)) return raw;
  let value: unknown;
  try {
    value = JSON.parse((raw as string) || "{}");
  } catch {
    return { __invalid__: raw };
  }
  return isDict(value) ? value : { __invalid__: raw };
}
