// Membership CLIs as models. Every CLI comes from a model package (model-channels.ts): Codex and
// Claude Code keep their own measured sandboxes (the package builds the command, FluidForm runs it),
// the others run in FluidForm's sandbox. This module runs them: in their own process group, with
// timeouts, progress checks, live activity and a trace, in a conversation for the task's lead, or on
// the host for a repair.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import * as activity from "./activity.js";
import { ownNetwork, sandboxPorts } from "./agent.js";
import { path as attachmentPath } from "./attachments.js";
import { settings } from "./config.js";
import { ArtifactBlocked } from "./contracts.js";
import * as environment from "./environment.js";
import type { Attachment } from "./models.js";
import * as modelChannels from "./model-channels.js";
import * as progress from "./progress.js";
import { formatG, isObject, pyDumps, pyRegex, pyStr, splitlines, tail } from "./py.js";

/** Required context cannot fit: block for replanning, not model/availability fallback. */
export class InputTooLarge extends ArtifactBlocked {
  override name = "InputTooLarge";
}

/** A CLI failed (Python's RuntimeError from a CLI run). */
export class CliError extends Error {
  override name = "CliError";
}

export const inputTooLarge = (error: unknown) => String((error as Error)?.message ?? error).toLowerCase().includes("input_too_large");
export type CliSpec = { id: string; executable: string; auth_command: string[]; invoke_args: string[]; fallback_model_id: string };
export type CliStatus = { id: string; installed: boolean; authenticated: boolean; auth_type: string | null; version: string | null; error: string | null };
export type Usage = { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number; cache_write_tokens?: number };
/** What a CLI answered, with the usage it reported (Python's UsageText). */
export type CliText = { text: string; usage: Usage };

/** Why a CLI exited with an error. Claude Code in JSON mode reports errors such as a usage limit in
 *  the ``result`` of its stdout and leaves stderr empty. */
export function failureDetail(stdout: Buffer, stderr: Buffer): string {
  // What the CLI said went wrong comes first: Codex prints warnings on stderr and the reason (a usage
  // limit, say) as an event on stdout.
  const reported = reportedError(stdout.toString("utf8"));
  if (reported) return tail(reported, 500);
  let detail = stderr.toString("utf8").trim();
  if (!detail) {
    let text = stdout.toString("utf8").trim();
    try {
      const payload = JSON.parse(text);
      if (isObject(payload)) text = pyStr(payload.result || payload.error || text);
    } catch {
      // not JSON
    }
    detail = text || "no output";
  }
  return tail(detail, 500);
}

/** The error in a CLI's JSON lines (Codex: the last ``turn.failed`` or ``error`` event), or "". */
function reportedError(stdout: string): string {
  for (const line of splitlines(stdout).reverse()) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(event) || (event.type !== "turn.failed" && event.type !== "error")) continue;
    const message = isObject(event.error) ? event.error.message : event.message;
    if (message) return pyStr(message).trim();
  }
  return "";
}

/** Run a CLI on the host as the user, network included, but under no_new_privs (which bubblewrap
 *  always sets), so sudo and other setuid programs cannot raise privileges. */
export function repairCommand(executable: string, args: string[]): string[] {
  if (!environment.which("bwrap")) throw new CliError("repairing the environment needs bubblewrap (bwrap), which blocks sudo");
  // The real /dev: a repair checks the steps' sandbox, which needs /dev/net/tun for the internet.
  return ["bwrap", "--bind", "/", "/", "--dev-bind", "/dev", "/dev", "--proc", "/proc", "--die-with-parent", "--", executable, ...args];
}


/** Whether ``modelId`` keeps a conversation (so it can lead a task): its model package says so. */
export function keepsConversations(modelId: string): boolean {
  return Boolean(modelChannels.channelFor(modelId)?.sessions);
}

/** The CLI ``modelId`` is, from the model package that is on and brings it; null otherwise. */
export function specFor(modelId: string): CliSpec | null {
  const channel = modelChannels.channelFor(modelId);
  return channel ? { id: channel.id, executable: channel.executable, auth_command: channel.auth_command, invoke_args: [],
    fallback_model_id: channel.fallback_model_id } : null;
}
// How a CLI says the conversation to continue is gone.
const SESSION_MISSING = pyRegex(String.raw`no (conversation|session|rollout)|not found|does not exist`, "i");

/** A conversation to continue no longer exists (the CLI cleaned it up, say). */
export class SessionLost extends Error {
  override name = "SessionLost";
}

export function cliUsage(payload: Record<string, any>, codex = false): Usage {
  const data = payload.usage || {};
  if (!isObject(data) || !("input_tokens" in data) || !("output_tokens" in data)) return {};
  const cached = ((codex ? data.cached_input_tokens : data.cache_read_input_tokens) ?? 0) as number;
  const written = (data.cache_creation_input_tokens ?? 0) as number;
  return { input_tokens: (data.input_tokens as number) + (codex ? 0 : cached + written), output_tokens: data.output_tokens as number,
    cached_input_tokens: cached, cache_write_tokens: written };
}

/** Append evidence as it arrives, including output from calls that never return an answer. */
export function trace(path: string | null | undefined, kind: string, values: Record<string, unknown> = {}): void {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, pyDumps({ type: kind, ...values }, false) + "\n");
}

/** Where Codex keeps its login and sessions (its quota is read from them, cli-quota.ts). */
export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

/** Kill the CLI and any tools it spawned; they share the session started for it. */
function killGroup(child: ChildProcess): void {
  try {
    process.kill(-child.pid!, "SIGKILL");
  } catch {
    // already gone
  }
}

// What tests replace.
export const deps = {
  which: (name: string) => environment.which(name),
  repairCommand: (executable: string, args: string[]) => repairCommand(executable, args),
  ownNetwork: (command: string[]) => ownNetwork(command),
  // The host ports a step's sandbox reaches (none without socat, which bridges them).
  hostPorts: () => sandboxPorts(),
  isolates: () => modelChannels.isolates(),
  withoutInternet: <T>(command: string[], hosts: string[], work: (command: string[], env: Record<string, string>) => Promise<T>) =>
    modelChannels.withoutInternet(command, hosts, work),
};

class Timeout extends Error {
  override name = "TimeoutError";
}

export type RunOptions = { watch?: progress.Watch | null; idle?: number | null; extraEnv?: Record<string, string> | null;
  toolTrace?: string | null; signal?: AbortSignal;
  /** Given, a non-zero exit returns the output too, and this gets the exit code and stderr. */
  exit?: { code: number | null; stderr: string } };

export class CliChannelRegistry {
  private cached: Record<string, CliStatus> | null = null;

  static toolLimitCapabilities(_modelId: string): { counting_unit: null; hard_limit: false } {
    // CLI-reported turns are not individual tool calls; we cannot intercept their tools.
    return { counting_unit: null, hard_limit: false };
  }

  // The model packages' channels the statuses were read with: one switched on or off reads them again.
  private channelsKey = "";

  refresh(): Record<string, CliStatus> {
    const channels = modelChannels.active();
    this.channelsKey = channels.map((channel) => channel.id).sort().join(",");
    const specs = channels.map((channel) => specFor(channel.id)!);
    this.cached = Object.fromEntries(specs.map((spec) => [spec.id, this.probe(spec)]));
    return this.cached;
  }

  get statuses(): Record<string, CliStatus> {
    const key = modelChannels.active().map((channel) => channel.id).sort().join(",");
    return this.cached && key === this.channelsKey ? this.cached : this.refresh();
  }

  availableModelIds(): Set<string> {
    return new Set(Object.entries(this.statuses).filter(([, status]) => status.authenticated).map(([modelId]) => modelId));
  }

  /** Whether the CLI is installed and logged in; asked once, at the first use (a few seconds each). */
  private probe(spec: CliSpec): CliStatus {
    const executable = deps.which(spec.executable);
    if (!executable) return { id: spec.id, installed: false, authenticated: false, auth_type: null, version: null, error: null };
    // Generous limits: on a busy machine a Node CLI can take several seconds just to start.
    const version = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 15_000 });
    if (version.error) return { id: spec.id, installed: true, authenticated: false, auth_type: null, version: null, error: version.error.message.slice(0, 200) };
    const lines = splitlines((version.stdout || version.stderr || "").trim());
    const shown = (lines[lines.length - 1] ?? "").slice(0, 120);
    const auth = spawnSync(executable, spec.auth_command, { encoding: "utf8", timeout: 15_000 });
    if (auth.error) return { id: spec.id, installed: true, authenticated: false, auth_type: null, version: shown, error: auth.error.message.slice(0, 200) };
    const output = ((auth.stdout ?? "") + (auth.stderr ?? "")).toLowerCase();
    const authenticated = auth.status === 0 && !["not logged in", "unauthenticated", "login required"].some((marker) => output.includes(marker));
    const type = authenticated ? (["chatgpt", "claude.ai", "subscription"].some((word) => output.includes(word)) ? "membership" : "authenticated") : null;
    return { id: spec.id, installed: true, authenticated, auth_type: type, version: shown, error: authenticated ? null : "CLI is installed but not authenticated" };
  }

  /** Run a CLI command in its own process group and return its output; a failure throws CliError,
   *  and the whole group is killed when the call ends early. With ``idle`` it runs while it keeps
   *  printing (up to ``timeout``), and is stopped after ``idle`` seconds without output. With
   *  ``watch`` it is checked every progress_check_minutes instead of being killed at ``timeout``. */
  async run(spec: CliSpec, command: string[], cwd: string, stdin: Buffer | null, timeout: number, options: RunOptions = {}): Promise<string> {
    const { watch = null, idle = null, extraEnv = null, toolTrace = null, signal } = options;
    // Tools that environment repairs installed are on PATH for every CLI.
    const env = { ...environment.commandEnv({ ...process.env } as Record<string, string>), ...(extraEnv ?? {}) };
    const started = Date.now() / 1000;
    const child = spawn(command[0], command.slice(1), { cwd, env, stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"], detached: true });
    const log = activity.current.get();
    let last = performance.now();
    let printed = 0;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let pending = Buffer.alloc(0);
    const drain = (sink: Buffer[], channel: string, lines: boolean) => (chunk: Buffer) => {
      // Base64 preserves arbitrary bytes and split UTF-8 characters exactly.
      trace(toolTrace, `cli.${channel}`, { data: chunk.toString("base64"), encoding: "base64" });
      sink.push(chunk);
      last = performance.now();
      printed += chunk.length;
      if (lines) {
        const joined = Buffer.concat([pending, chunk]);
        let at = joined.indexOf(10);
        let from = 0;
        while (at >= 0) {
          activity.recording(log!, () => activity.noteLine(joined.subarray(from, at)));
          from = at + 1;
          at = joined.indexOf(10, from);
        }
        pending = joined.subarray(from);
      }
    };
    child.stdout!.on("data", drain(out, "stdout", log !== null));
    child.stderr!.on("data", drain(err, "stderr", false));
    const exited = new Promise<number | null>((done, fail) => {
      child.on("error", fail);
      child.on("close", (code) => {
        if (log !== null && pending.length) activity.recording(log, () => activity.noteLine(pending));
        done(code);
      });
    });
    if (stdin && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(stdin);
    }
    const tracker = watch ? new progress.CliProgress(cwd, started, child.pid!) : null;
    let code: number | null = null;
    try {
      code = await new Promise<number | null>((done, fail) => {
        const timers: NodeJS.Timeout[] = [];
        // Once the call is over no check is armed again: one still in flight when the CLI exits would
        // otherwise schedule the next, and keep checking a finished call.
        let over = false;
        const arm = (work: () => void, ms: number) => {
          if (!over) timers.push(setTimeout(work, ms));
        };
        const stop = (error: Error) => {
          over = true;
          for (const timer of timers) clearTimeout(timer);
          fail(error);
        };
        const aborted = () => stop(signal!.reason instanceof Error ? signal!.reason : Object.assign(new Error("cancelled"), { name: "AbortError" }));
        if (signal?.aborted) return aborted();
        signal?.addEventListener("abort", aborted, { once: true });
        exited.then((value) => {
          over = true;
          for (const timer of timers) clearTimeout(timer);
          signal?.removeEventListener("abort", aborted);
          done(value);
        }, stop);
        if (watch && tracker) {
          let checked = started;
          let seen = 0;
          const check = async () => {
            try {
              const evidence = await tracker.evidence(checked, log, printed - seen);
              seen = printed;
              checked = Date.now() / 1000;
              const reason = await watch(evidence);
              if (reason) return stop(new progress.Stopped(`${spec.executable} ${progress.STOPPED}${reason}`));
              arm(check, settings.progress_check_minutes * 60_000);
            } catch (error) {
              stop(error as Error);
            }
          };
          arm(check, settings.progress_check_minutes * 60_000);
        } else if (idle) {
          const begun = performance.now();
          const look = () => {
            const now = performance.now();
            if ((now - last) / 1000 > idle) return stop(new Timeout(`no output for ${formatG(idle)}s`));
            if ((now - begun) / 1000 > timeout) return stop(new Timeout(`${formatG(timeout)}s`));
            arm(look, Math.min(30, idle) * 1000);
          };
          arm(look, Math.min(30, idle) * 1000);
        } else {
          arm(() => stop(new Timeout(`${timeout}s`)), timeout * 1000);
        }
      });
    } catch (error) {
      killGroup(child);
      // Drain the pipes after killing the group, retaining its final bytes before release.
      let grace: NodeJS.Timeout | undefined;
      await Promise.race([exited.catch(() => undefined), new Promise((done) => (grace = setTimeout(done, 5000)))]);
      clearTimeout(grace);
      trace(toolTrace, "cli.interrupted", { reason: (error as Error).message || (error as Error).name });
      trace(toolTrace, "cli.exit", { exit_code: child.exitCode ?? (child.signalCode ? -9 : null) });
      if (error instanceof Timeout) throw new CliError(`${spec.executable} timed out after ${error.message}`);
      throw error;
    }
    trace(toolTrace, "cli.exit", { exit_code: code });
    if (options.exit) Object.assign(options.exit, { code, stderr: Buffer.concat(err).toString("utf8") });
    if (code && !options.exit) throw new CliError(`${spec.executable} failed: ${failureDetail(Buffer.concat(out), Buffer.concat(err))}`);
    return Buffer.concat(out).toString("utf8");
  }

  /** What a package with its own sandbox runs its commands through: this registry's ``run`` for
   *  ``spec``, and the lookups tests replace. */
  runner(spec: CliSpec): modelChannels.Runner {
    return {
      run: (command, cwd, stdin, timeout, options = {}) => this.run(spec, command, cwd, stdin, timeout, options),
      which: (name) => deps.which(name),
      hostPorts: () => deps.hostPorts(),
      ownNetwork: (command) => deps.ownNetwork(command),
      repairCommand: (executable, args) => deps.repairCommand(executable, args),
      isolates: () => deps.isolates(),
      withoutInternet: (command, hosts, work) => deps.withoutInternet(command, hosts, work),
    };
  }

  /** Run ``command`` in ``modelId``'s own sandbox exactly as its steps get it, without the model: its
   *  output, and whether it exited 0. Only a CLI whose package can (Codex: codex sandbox); CliError otherwise. */
  async sandboxRun(modelId: string, command: string, cwd: string, timeout: number, network = false): Promise<[string, boolean]> {
    const channel = modelChannels.channelFor(modelId);
    if (!channel?.own?.sandboxRun) throw new CliError(`${modelId} cannot run a command in its sandbox without the model`);
    return channel.own.sandboxRun(this.runner(specFor(modelId)!), command, cwd, timeout, network);
  }

  /** Say ``prompt`` in the conversation ``sessionId`` (a new one without it), in ``cwd``; the reply
   *  and the conversation's id. Only CLIs whose package keeps conversations. With ``timeout`` it is a
   *  hard limit; without, each CLI's own pace (Codex while it keeps printing; at most lead_call_max_minutes). */
  async converse(modelId: string, prompt: string, cwd: string, { sessionId = null, timeout = null, effort = null, attachments = [], signal }:
    { sessionId?: string | null; timeout?: number | null; effort?: string | null; attachments?: Attachment[]; signal?: AbortSignal } = {}): Promise<[CliText, string]> {
    const channel = modelChannels.channelFor(modelId);
    if (!channel?.sessions) throw new CliError(`${modelId} cannot keep a conversation here`);
    try {
      if (channel.own) {
        if (!channel.own.converse) throw new CliError(`${modelId} cannot keep a conversation here`);
        return await channel.own.converse(this.runner(specFor(modelId)!), { prompt, cwd, sessionId, timeout, effort, attachments, signal });
      }
      const readable = modelChannels.foldersOf(attachments.map((item) => attachmentPath(item)));
      const reply = await this.channelRun(channel, { prompt, cwd, lead: true, sessionId, readable }, false,
        timeout ?? settings.lead_call_max_minutes * 60, { signal });
      if (!reply.sessionId) throw new CliError(`${channel.executable} did not report its conversation id`);
      return [{ text: reply.text, usage: reply.usage }, reply.sessionId];
    } catch (error) {
      if (sessionId && error instanceof CliError && SESSION_MISSING.test(error.message)) throw new SessionLost(error.message);
      throw error;
    }
  }

  /** Run a CLI in ``cwd``. With ``repair`` it leaves its sandbox to fix the environment; with
   *  ``network`` its sandbox lets commands reach the internet. With ``watch`` it is not killed at
   *  ``timeout`` but checked every progress_check_minutes, and stopped only if stuck. */
  async complete(modelId: string, prompt: string, cwd: string, { timeout = 900, attachments = [], repair = false, network = false, watch = null,
    effort = null, toolTrace = null, signal }: { timeout?: number; attachments?: Attachment[]; repair?: boolean; network?: boolean;
    watch?: progress.Watch | null; effort?: string | null; toolTrace?: string | null; signal?: AbortSignal } = {}): Promise<CliText> {
    const channel = modelChannels.channelFor(modelId);
    if (!channel) throw new CliError(`${modelId} is not a CLI in use`);
    let text: CliText;
    try {
      if (channel.own) {
        text = await channel.own.complete(this.runner(specFor(modelId)!),
          { prompt, cwd, timeout, attachments, repair, network, watch, effort, toolTrace, signal });
      } else {
        const readable = modelChannels.foldersOf(attachments.map((item) => attachmentPath(item)));
        const reply = await this.channelRun(channel, { prompt, cwd, lead: false, sessionId: null, readable }, network, timeout,
          { watch, toolTrace, signal }, repair);
        text = { text: reply.text, usage: reply.usage };
      }
    } catch (error) {
      trace(toolTrace, "cli.error", { reason: (error as Error).message || (error as Error).name });
      throw error;
    }
    trace(toolTrace, "cli.result", { text: text.text, model_id: modelId });
    return text;
  }

  /** One call of a model package's CLI, always in FluidForm's sandbox for it (model-channels.ts),
   *  except a ``repair``, which leaves it to fix the environment as every CLI's repair does. Its
   *  answer, or CliError with what it said; a quota it ran out of reads as one ("limit reached"). */
  async channelRun(channel: modelChannels.ModelChannel, call: modelChannels.ChannelCall, network: boolean, timeout: number,
    options: RunOptions = {}, repair = false): Promise<modelChannels.ChannelReply> {
    const spec = specFor(channel.id)!;
    const executable = deps.which(channel.executable);
    if (!executable) throw new CliError(`${channel.executable} is no longer installed`);
    // A repair is told so: it may then write outside its folder.
    if (repair) call = { ...call, repair: true };
    const argv = [executable, ...channel.args!(call)];
    const input = channel.stdin!(call);
    const stdin = input === null ? null : Buffer.from(input, "utf8");
    const exit = { code: null as number | null, stderr: "" };
    const stdout = repair
      ? await this.run(spec, deps.repairCommand(argv[0], argv.slice(1)), call.cwd, stdin, timeout, { ...options, exit })
      : await modelChannels.withSandbox(channel, argv, call, network, (command, env) =>
        this.run(spec, command, call.cwd, stdin, timeout, { ...options, extraEnv: { ...(options.extraEnv ?? {}), ...env }, exit }));
    const reply = channel.parse!(stdout);
    if (reply.quota) throw new CliError(`${channel.executable} usage limit reached: ${reply.error}`);
    if (reply.error || exit.code) {
      // What it said in its answer, and, when it exited with an error, what it printed besides.
      const detail = exit.code ? failureDetail(Buffer.from(stdout, "utf8"), Buffer.from(exit.stderr, "utf8")) : "";
      throw new CliError(`${channel.executable} failed: ${[reply.error, detail].filter(Boolean).join("; ")}`);
    }
    return reply;
  }
}
