// Membership CLIs as models: Codex, Claude Code, Gemini and Qwen, run in their own
// sandboxes for steps, in a conversation for the task's lead, or on the host for a repair.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync,
  statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import * as activity from "./activity.js";
import { ownNetwork } from "./agent.js";
import { path as attachmentPath } from "./attachments.js";
import * as calls from "./calls.js";
import { settings } from "./config.js";
import { ArtifactBlocked } from "./contracts.js";
import * as environment from "./environment.js";
import type { Attachment } from "./models.js";
import * as progress from "./progress.js";
import { formatG, isObject, pyDumps, pyRegex, pyStr, splitlines, tail } from "./py.js";
import { compactContext } from "./team.js";

// Bound the full UTF-8 input conservatively, leaving room for CLI/protocol wrapping.
export const CODEX_INPUT_LIMIT = 1048576;
export const CODEX_INPUT_RESERVE = 65536;

/** Required context cannot fit: block for replanning, not model/availability fallback. */
export class InputTooLarge extends ArtifactBlocked {
  override name = "InputTooLarge";
}

/** A CLI failed (Python's RuntimeError from a CLI run). */
export class CliError extends Error {
  override name = "CliError";
}

export const inputTooLarge = (error: unknown) => String((error as Error)?.message ?? error).toLowerCase().includes("input_too_large");
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

export function codexInput(prompt: string, { retry = false } = {}): string {
  const limit = CODEX_INPUT_LIMIT - CODEX_INPUT_RESERVE;
  const before = prompt;
  let text = prompt;
  if (retry || bytes(text) > limit) text = compactContext(text, retry ? 1024 : 32768);
  calls.warning(`Codex input: chars ${before.length} -> ${text.length}, UTF-8 bytes ${bytes(before)} -> ${bytes(text)}; `
    + `limit ${CODEX_INPUT_LIMIT}, reserve ${CODEX_INPUT_RESERVE}, retry=${retry ? "True" : "False"}`);
  calls.save();
  if (bytes(text) > limit || (retry && text === before)) {
    throw new InputTooLarge("input_too_large: 必须保留的要求、验收标准或未决事项无法安全缩减；请负责人拆分上下文。禁止原样重试或切换模型绕过。");
  }
  return text;
}

export type CliSpec = { id: string; executable: string; auth_command: string[]; invoke_args: string[]; fallback_model_id: string };
export type CliStatus = { id: string; installed: boolean; authenticated: boolean; auth_type: string | null; version: string | null; error: string | null };
export type Usage = { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number; cache_write_tokens?: number };
/** What a CLI answered, with the usage it reported (Python's UsageText). */
export type CliText = { text: string; usage: Usage };

// Claude Code runs shell commands inside its own bubblewrap sandbox: writes only in the working
// directory (and /tmp), no network, and no way to ask for an unsandboxed command. Sandboxed commands
// need no approval, which a background run could never give; file edits are accepted.
export const CLAUDE_SANDBOX_SETTINGS = pyDumps({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false } });
// A task that allows the network: sandboxed commands may reach any domain except this machine,
// whose services (this application's API among them) stay closed.
export const CLAUDE_NETWORK_SETTINGS = pyDumps({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
  network: { allowedDomains: ["*"], deniedDomains: ["localhost", "127.0.0.1", "::1"] } } });
// Repairing the environment: Claude Code without its sandbox and without asking for approval. The
// whole CLI runs under bubblewrap instead, which only blocks gaining root (see repairCommand).
export const CLAUDE_REPAIR_SETTINGS = pyDumps({ sandbox: { enabled: false } });
export const REPAIR_ARGS: Record<string, string[]> = {
  "cli:claude": ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions", "--settings", CLAUDE_REPAIR_SETTINGS, "--no-session-persistence"],
  "cli:codex": ["exec", "--ephemeral", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--color", "never", "-"],
};

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

// The task's lead keeps one conversation per task. It reads files and runs sandboxed commands to look
// things up, but does not edit: the steps' models do the work.
export const SESSION_ARGS: Record<string, string[]> = {
  "cli:claude": ["-p", "--output-format", "json", "--permission-mode", "default", "--settings", CLAUDE_SANDBOX_SETTINGS,
    "--disallowedTools", "Edit,Write,NotebookEdit"],
  // Its sandbox: the lead's permission profile (codexStepPermissions with lead), added per call.
  "cli:codex": ["exec", "--json", "--skip-git-repo-check", "--color", "never"],
};
export const SESSION_CLIS = new Set(Object.keys(SESSION_ARGS));
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

export function codexOutput(output: string): CliText {
  let text = "";
  const usage: Record<string, number> = {};
  for (const line of splitlines(output)) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(event)) continue;
    if (event.type === "item.completed" && isObject(event.item) && event.item.type === "agent_message") text = (event.item.text as string) || text;
    if (event.type === "turn.completed") {
      for (const [key, value] of Object.entries(cliUsage(event, true))) usage[key] = (usage[key] ?? 0) + (value as number);
    }
  }
  return { text: text || output.trim(), usage };
}

export const CLI_SPECS: Record<string, CliSpec> = {
  "cli:codex": { id: "cli:codex", executable: "codex", auth_command: ["login", "status"],
    invoke_args: ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "workspace-write", "--color", "never", "-"],
    fallback_model_id: "openai:gpt-5.6-terra" },
  "cli:claude": { id: "cli:claude", executable: "claude", auth_command: ["auth", "status"],
    invoke_args: ["-p", "--output-format", "json", "--permission-mode", "acceptEdits", "--settings", CLAUDE_SANDBOX_SETTINGS, "--no-session-persistence"],
    fallback_model_id: "anthropic:claude-sonnet-5" },
  "cli:gemini": { id: "cli:gemini", executable: "gemini", auth_command: ["--version"], invoke_args: ["-p", "", "--output-format", "json"],
    fallback_model_id: "google:gemini-pro" },
  "cli:qwen": { id: "cli:qwen", executable: "qwen", auth_command: ["--version"], invoke_args: ["-p", "", "--output-format", "json"],
    fallback_model_id: "qwen:qwen-plus" },
};

/** Kill the CLI and any tools it spawned; they share the session started for it. */
function killGroup(child: ChildProcess): void {
  try {
    process.kill(-child.pid!, "SIGKILL");
  } catch {
    // already gone
  }
}

/** Open the CLI's sandbox to the internet. Gemini and Qwen run unsandboxed already; Codex steps get
 *  it from their permission profile (codexStepPermissions). */
export function withNetwork(modelId: string, args: string[]): string[] {
  return modelId === "cli:claude" ? args.map((arg) => (arg === CLAUDE_SANDBOX_SETTINGS ? CLAUDE_NETWORK_SETTINGS : arg)) : args;
}

// Codex's own features the platform's leads and steps do not use (Codex feature flags).
export const CODEX_EXTRAS = ["plugins", "apps", "browser_use", "in_app_browser", "computer_use"];
// Reasoning efforts as Codex names them; the platform's scale maps onto it.
export const CODEX_EFFORTS: Record<string, string> = { none: "minimal", minimal: "minimal", low: "low", medium: "medium", high: "high",
  xhigh: "xhigh", max: "max", ultra: "max" };
// A server's own table in Codex's config: [mcp_servers.name] or [mcp_servers."name"].
const CODEX_SERVER = pyRegex(String.raw`^\s*\[\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*\]\s*$`, "mg");

export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

/** The MCP servers the user's Codex config starts, by name, read from $CODEX_HOME/config.toml: the
 *  platform turns each off, since what they are differs from machine to machine. */
export function codexServers(): string[] {
  let text: string;
  try {
    text = readFileSync(join(codexHome(), "config.toml")).toString("utf8");
  } catch {
    return [];
  }
  return [...new Set([...text.matchAll(CODEX_SERVER)].map((match) => match[1] ?? match[2]))];
}

// The permission profile a Codex step runs under (Codex's own sandbox, bubblewrap on Linux): its
// workspace writable; this account's home (keys, Codex's login, other projects), the platform's data
// and the other tasks' folders unreadable; the machine's shared /tmp replaced by TMPDIR.
export const CODEX_STEP_PROFILE = "fluidform-step";
export const CODEX_LEAD_PROFILE = "fluidform-lead";
// Folders denied entry by entry: Codex lifts a deny only on a whole entry, not inside one.
export const MAX_DENIED = 400;
// /tmp entries a step's profile denies one by one; past this many it denies all of /tmp.
export const MAX_TMP_ENTRIES = 2000;
// ...or past this many bytes of their names (a whole -c argument is at most 128 KiB).
export const MAX_TMP_BYTES = 64 * 1024;

const real = (path: string): string => {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(real(parent), absolute.slice(parent.length + 1));
  }
};
const under = (path: string, folder: string) => path !== folder && path.startsWith(folder === "/" ? "/" : folder + sep);
const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};
const isLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Deny every entry of ``base`` that is not, or does not lead to, one of ``keep``. */
function denyExcept(base: string, keeping: string[], rules: Map<string, string>): void {
  const keep = keeping.filter((path) => path === base || under(path, base));
  if (!keep.length) {
    rules.set(base, "deny");
    return;
  }
  if (keep.includes(base) || !isDir(base) || rules.size > MAX_DENIED) return;
  let entries: string[];
  try {
    entries = readdirSync(base).sort().map((name) => join(base, name));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (isLink(entry)) continue; // what it points to is denied or kept where it is
    denyExcept(entry, keep, rules);
  }
}

/** The folder Codex is installed in (its sandbox helper runs from there). */
export function codexPackage(): string | null {
  const found = environment.which(CLI_SPECS["cli:codex"].executable);
  if (!found) return null;
  const resolved = real(found);
  return basename(dirname(resolved)) === "bin" ? dirname(dirname(resolved)) : dirname(resolved);
}

/** /tmp stays writable, since some tools write there whatever TMPDIR says (URG creates its temporary
 *  files in /tmp and crashes when it cannot), but what is already in it stays unreadable: it is denied
 *  entry by entry. A step's own temporary folder is elsewhere (withPrivateTmp). */
export function sharedTmp(cwd: string, rules: Map<string, string>, shared = "/tmp", most = MAX_TMP_ENTRIES): void {
  const tmp = real(shared);
  if (under(cwd, tmp)) {
    denyExcept(tmp, [cwd], rules);
    return;
  }
  let entries: string[] | null;
  try {
    entries = readdirSync(tmp).map((name) => join(tmp, name)).filter((entry) => !isLink(entry));
  } catch {
    entries = null;
  }
  // Past this, the profile's one -c argument would be longer than Linux takes (E2BIG, 128 KiB).
  const size = (entries ?? []).reduce((sum, entry) => sum + Buffer.byteLength(entry) + 16, 0);
  if (entries === null || entries.length > most || size > MAX_TMP_BYTES) {
    rules.set(":slash_tmp", "deny");
    return;
  }
  rules.set(tmp, "write");
  for (const entry of entries.sort()) rules.set(entry, "deny");
}

/** -c options defining and selecting the profile for a step working in ``cwd`` with its own
 *  ``tmpdir`` (CODEX_STEP_PROFILE), or with ``lead`` for a lead's read-only conversation there
 *  (CODEX_LEAD_PROFILE: the tasks' folders stay readable, so it can look at their results). */
export function codexStepPermissions(workdir: string, network: boolean, { lead = false, tmpdir = null, readable = [] }:
  { lead?: boolean; tmpdir?: string | null; readable?: string[] } = {}): string[] {
  const cwd = real(workdir);
  // ``readable``: folders a lead's conversation may also read, such as a chat's attachments.
  const extra = lead ? readable.map(real) : [];
  const keep = [cwd, join(real(codexHome()), "tmp"), real(environment.toolsDir()), ...extra, ...(tmpdir && !lead ? [real(tmpdir)] : [])];
  const pkg = codexPackage();
  if (pkg) keep.push(pkg);
  const rules = new Map<string, string>();
  const bases = lead ? [homedir(), settings.data_dir] : [homedir(), settings.data_dir, settings.workspace_root];
  for (const base of [...new Set(bases.map(real))]) if (base !== "/" && isDir(base)) denyExcept(base, keep, rules);
  if (lead) {
    rules.set(cwd, "read");
    for (const item of extra) rules.set(item, "read");
  } else {
    sharedTmp(cwd, rules);
    rules.set(":tmpdir", "write");
    rules.set(cwd, "write");
  }
  const table = "{ " + [...rules].map(([path, mode]) => `${pyDumps(path)} = ${pyDumps(mode)}`).join(", ") + " }";
  const name = lead ? CODEX_LEAD_PROFILE : CODEX_STEP_PROFILE;
  return ["-c", `default_permissions="${name}"`, "-c", `permissions.${name}.extends="${lead ? ":read-only" : ":workspace"}"`,
    "-c", `permissions.${name}.filesystem=${table}`, ...(network ? ["-c", `permissions.${name}.network={ enabled = true }`] : [])];
}

/** ``work`` with a temporary folder of a Codex step's own, its TMPDIR, removed afterwards (null
 *  unless ``wanted``). Under the data folder, which every step's profile hides: steps do not see
 *  each other's. */
export async function withPrivateTmp<T>(wanted: boolean, work: (folder: string | null) => Promise<T>): Promise<T> {
  if (!wanted) return work(null);
  const parent = join(real(settings.data_dir), "tmp");
  mkdirSync(parent, { recursive: true });
  const folder = mkdtempSync(join(parent, "sp-codex-tmp-"));
  try {
    return await work(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** Options that make one Codex run the platform's rather than the user's: how hard it thinks, its
 *  service tier, and none of the user's plugins, apps and MCP servers. */
export function codexSettings(effort: string | null = null, serviceTier = ""): string[] {
  const options: string[] = [];
  if (effort) options.push("-c", `model_reasoning_effort="${CODEX_EFFORTS[effort] ?? effort}"`);
  if (serviceTier) options.push("-c", `service_tier="${serviceTier}"`);
  if (settings.codex_without_extras) {
    for (const name of CODEX_EXTRAS) options.push("--disable", name);
    // Codex splits a -c key on dots and takes quotes literally: only plain names can be addressed.
    for (const name of deps.codexServers()) if (/^[A-Za-z0-9_-]+$/.test(name)) options.push("-c", `mcp_servers.${name}.enabled=false`);
  }
  return options;
}

// Codex refuses rm -f and the like as dangerous even inside its sandbox (its exec policy), which
// stops builds and clean-ups; an allow rule in the folder it works in lifts that, and its sandbox
// still keeps everything outside the folder read-only. rm with wildcards or $(...) stays refused,
// since Codex cannot tell what it removes (2026-10-21); steps are told to use find -delete.
export const CODEX_RULES = ".codex/rules/fluidform.rules";
export const CODEX_ALLOW = 'prefix_rule(pattern=["rm"], decision="allow")\n';
const ruleUsers = new Map<string, number>();

/** ``work`` with the allow rule in ``cwd`` while Codex works there, then gone again (with any folder
 *  it made), so neither a task's results nor a project keep it. Steps at once in one folder share it. */
export async function withCodexRules<T>(cwd: string, work: () => Promise<T>): Promise<T> {
  const rule = join(cwd, CODEX_RULES);
  let made = [dirname(dirname(rule)), dirname(rule)].filter((folder) => !existsSync(folder));
  if (!ruleUsers.get(rule)) {
    try {
      mkdirSync(dirname(rule), { recursive: true });
      writeFileSync(rule, CODEX_ALLOW);
    } catch {
      made = [];
    }
  }
  ruleUsers.set(rule, (ruleUsers.get(rule) ?? 0) + 1);
  try {
    return await work();
  } finally {
    ruleUsers.set(rule, ruleUsers.get(rule)! - 1);
    if (!ruleUsers.get(rule)) {
      ruleUsers.delete(rule);
      try {
        unlinkSync(rule);
        for (const folder of [...made].reverse()) rmdirSync(folder);
      } catch {
        // already gone, or not empty
      }
    }
  }
}

/** Let the CLI open attached files, which live outside its working directory. */
export function withAttachments(modelId: string, args: string[], attachments: Attachment[]): string[] {
  if (!attachments.length) return args;
  if (modelId === "cli:codex") {
    // Codex reads the whole disk in its sandbox; images also go in as real image inputs. "--image="
    // keeps the value from swallowing the trailing "-" (prompt on stdin).
    const images = attachments.filter((item) => item.kind === "image").map((item) => `--image=${attachmentPath(item)}`);
    return [args[0], ...images, ...args.slice(1)];
  }
  if (modelId === "cli:claude") return [...args, "--add-dir", ...[...new Set(attachments.map((item) => dirname(attachmentPath(item))))].sort()];
  return args;
}

// What tests replace.
export const deps = {
  which: (name: string) => environment.which(name),
  codexSettings: (effort: string | null = null, serviceTier = "") => codexSettings(effort, serviceTier),
  codexStepPermissions: (workdir: string, network: boolean, options: { lead?: boolean; tmpdir?: string | null; readable?: string[] } = {}) =>
    codexStepPermissions(workdir, network, options),
  codexServers: () => codexServers(),
  repairCommand: (executable: string, args: string[]) => repairCommand(executable, args),
  ownNetwork: (command: string[]) => ownNetwork(command),
};

class Timeout extends Error {
  override name = "TimeoutError";
}

export type RunOptions = { watch?: progress.Watch | null; idle?: number | null; extraEnv?: Record<string, string> | null;
  toolTrace?: string | null; signal?: AbortSignal };

export class CliChannelRegistry {
  private cached: Record<string, CliStatus> | null = null;

  static toolLimitCapabilities(_modelId: string): { counting_unit: null; hard_limit: false } {
    // CLI-reported turns are not individual tool calls; we cannot intercept their tools.
    return { counting_unit: null, hard_limit: false };
  }

  refresh(): Record<string, CliStatus> {
    this.cached = Object.fromEntries(Object.entries(CLI_SPECS).map(([modelId, spec]) => [modelId, this.probe(spec)]));
    return this.cached;
  }

  get statuses(): Record<string, CliStatus> {
    return this.cached ?? this.refresh();
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

  /** Check the fully assembled input and retry only an explicitly rejected, smaller input. */
  async runInput(spec: CliSpec, command: string[], cwd: string, prompt: string, timeout: number, options: RunOptions = {}): Promise<string> {
    if (spec.id !== "cli:codex") return this.run(spec, command, cwd, Buffer.from(prompt, "utf8"), timeout, options);
    let text = codexInput(prompt);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const output = await this.run(spec, command, cwd, Buffer.from(text, "utf8"), timeout, options);
        // Some CLI versions emit a failed turn with a zero exit status.
        for (const line of splitlines(output)) {
          let event: unknown;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (isObject(event) && (event.type === "turn.failed" || event.type === "error") && inputTooLarge(pyStr(event))) {
            throw new InputTooLarge("input_too_large: Codex rejected the input");
          }
        }
        return output;
      } catch (error) {
        if (!(error instanceof CliError) && !(error instanceof InputTooLarge)) throw error;
        if (!inputTooLarge(error)) throw error;
        if (attempt) throw new InputTooLarge("input_too_large: 缩减后仍被拒绝，停止重试，交回负责人拆分上下文。");
        text = codexInput(text, { retry: true });
      }
    }
    throw new InputTooLarge("input_too_large");
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
    if (code) throw new CliError(`${spec.executable} failed: ${failureDetail(Buffer.concat(out), Buffer.concat(err))}`);
    return Buffer.concat(out).toString("utf8");
  }

  /** Run ``command`` in ``modelId``'s own sandbox exactly as its steps get it (the step's permission
   *  profile; a TMPDIR of its own; the environment the platform gives every CLI), without the model:
   *  its output, and whether it exited 0. Only Codex can (codex sandbox); CliError for any other CLI. */
  async sandboxRun(modelId: string, command: string, cwd: string, timeout: number, network = false): Promise<[string, boolean]> {
    const executable = modelId === "cli:codex" ? deps.which(CLI_SPECS[modelId].executable) : null;
    if (!executable) throw new CliError(`${modelId} cannot run a command in its sandbox without the model`);
    return withPrivateTmp(true, async (tmp) => {
      let argv = [executable, "sandbox", "-P", CODEX_STEP_PROFILE, "-C", cwd, ...deps.codexStepPermissions(cwd, network, { tmpdir: tmp }),
        "--", "/bin/bash", "-c", command];
      // The network a step gets: see completeIn.
      if (network) argv = await deps.ownNetwork(argv);
      const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...environment.commandEnv({ ...process.env } as Record<string, string>), TMPDIR: tmp! },
        stdio: ["ignore", "pipe", "pipe"], detached: true });
      const chunks: Buffer[] = [];
      child.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr!.on("data", (chunk: Buffer) => chunks.push(chunk));
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(child);
      }, timeout * 1000);
      const code = await new Promise<number | null>((done) => child.on("close", done).on("error", () => done(null)));
      clearTimeout(timer);
      if (timedOut) return [`Command timed out after ${formatG(timeout)}s`, false];
      const text = Buffer.concat(chunks).toString("utf8").trim() || "(the command printed no output)";
      return [code ? `Exit code ${code}\n${text}` : text, !code];
    });
  }

  /** Say ``prompt`` in the conversation ``sessionId`` (a new one without it), in ``cwd``; the reply
   *  and the conversation's id. Only SESSION_CLIS keep conversations. Without ``timeout``, Codex
   *  (which prints its work as it goes) runs while it keeps printing, stopped after lead_idle_minutes
   *  without output, at most lead_call_max_minutes; Claude Code gets lead_call_max_minutes. With it,
   *  ``timeout`` is a hard limit. */
  async converse(modelId: string, prompt: string, cwd: string, { sessionId = null, timeout = null, effort = null, attachments = [], signal }:
    { sessionId?: string | null; timeout?: number | null; effort?: string | null; attachments?: Attachment[]; signal?: AbortSignal } = {}): Promise<[CliText, string]> {
    const spec = CLI_SPECS[modelId];
    const executable = spec ? deps.which(spec.executable) : null;
    if (!executable || !(modelId in SESSION_ARGS)) throw new CliError(`${modelId} cannot keep a conversation here`);
    let sid: string | null;
    let args: string[];
    if (modelId === "cli:claude") {
      sid = sessionId || randomUUID();
      args = [...SESSION_ARGS[modelId], sessionId ? "--resume" : "--session-id", sid];
      if (attachments.length) args.push("--add-dir", ...[...new Set(attachments.map((item) => dirname(attachmentPath(item))))].sort());
      if (effort) {
        args.push("--effort", effort);
        const record = calls.row();
        if (record) record.effective_effort = effort;
      }
    } else {
      sid = sessionId;
      args = sessionId ? ["exec", "resume", sessionId, "--json", "--skip-git-repo-check", "-"] : [...SESSION_ARGS[modelId], "-"];
      // `exec resume` parses its own options. Overrides on the outer `exec` are discarded on resume,
      // restoring the user's effort/tier/plugins instead.
      const options = [...deps.codexSettings(effort || settings.lead_reasoning_effort, settings.codex_lead_service_tier),
        ...deps.codexStepPermissions(cwd, false, { lead: true, readable: attachments.map((item) => dirname(attachmentPath(item))) })];
      const position = sessionId ? 3 : 1;
      args = [...args.slice(0, position), ...options, ...args.slice(position)];
      // Images go in as real image inputs ("--image=" keeps the trailing "-" for stdin).
      if (!sessionId) args = [args[0], ...attachments.filter((item) => item.kind === "image").map((item) => `--image=${attachmentPath(item)}`), ...args.slice(1)];
      const record = calls.row();
      if (record) {
        const chosen = effort || settings.lead_reasoning_effort;
        record.effective_effort = CODEX_EFFORTS[chosen] ?? chosen;
      }
    }
    calls.save();
    let output: string;
    try {
      const idle = timeout === null && modelId === "cli:codex" ? settings.lead_idle_minutes * 60 : null;
      output = await this.runInput(spec, [executable, ...args], cwd, prompt, timeout ?? settings.lead_call_max_minutes * 60, { idle, signal });
    } catch (error) {
      if (sessionId && error instanceof CliError && SESSION_MISSING.test(error.message)) throw new SessionLost(error.message);
      throw error;
    }
    if (modelId === "cli:claude") {
      const payload = JSON.parse(output);
      return [{ text: pyStr(payload.result || ""), usage: cliUsage(payload) }, pyStr(payload.session_id || sid)];
    }
    for (const line of splitlines(output)) {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (isObject(event) && event.type === "thread.started") sid = (event.thread_id as string) || sid;
    }
    if (!sid) throw new CliError("codex did not report its conversation id");
    return [codexOutput(output), sid];
  }

  /** Run a CLI in ``cwd``. With ``repair`` it leaves its sandbox to fix the environment; with
   *  ``network`` its sandbox lets commands reach the internet. With ``watch`` it is not killed at
   *  ``timeout`` but checked every progress_check_minutes, and stopped only if stuck. */
  async complete(modelId: string, prompt: string, cwd: string, { timeout = 900, attachments = [], repair = false, network = false, watch = null,
    effort = null, toolTrace = null, signal }: { timeout?: number; attachments?: Attachment[]; repair?: boolean; network?: boolean;
    watch?: progress.Watch | null; effort?: string | null; toolTrace?: string | null; signal?: AbortSignal } = {}): Promise<CliText> {
    const spec = CLI_SPECS[modelId];
    const executable = deps.which(spec.executable);
    if (!executable) throw new CliError(`${spec.executable} is no longer installed`);
    const args = [...(repair ? REPAIR_ARGS[spec.id] ?? spec.invoke_args : spec.invoke_args)];
    const step = spec.id === "cli:codex" && !repair;
    return withPrivateTmp(step, async (tmp) => {
      let text: CliText;
      try {
        text = await this.completeIn(spec, executable, args, step, tmp, prompt, cwd, timeout, attachments, repair, network, watch, effort, toolTrace, signal);
      } catch (error) {
        trace(toolTrace, "cli.error", { reason: (error as Error).message || (error as Error).name });
        throw error;
      }
      trace(toolTrace, "cli.result", { text: text.text, model_id: modelId });
      return text;
    });
  }

  async completeIn(spec: CliSpec, executable: string, given: string[], step: boolean, tmp: string | null, prompt: string, cwd: string,
    timeout: number, attachments: Attachment[], repair: boolean, network: boolean, watch: progress.Watch | null, effort: string | null,
    toolTrace: string | null, signal?: AbortSignal): Promise<CliText> {
    let args = given;
    if (step) {
      // Codex's own sandbox with the step's permission profile instead of workspace-write.
      const at = args.indexOf("--sandbox");
      args = [...args.slice(0, at), ...args.slice(at + 2)];
      args = [args[0], ...deps.codexStepPermissions(cwd, network, { tmpdir: tmp }), ...args.slice(1)];
    } else if (network && !repair) args = withNetwork(spec.id, args);
    args = withAttachments(spec.id, args, attachments);
    if (spec.id === "cli:codex") {
      args = [args[0], ...deps.codexSettings(effort), ...args.slice(1)];
      if (!args.includes("--json")) args.splice(1, 0, "--json");
    }
    let stdin: Buffer | null = Buffer.from(prompt, "utf8");
    if (spec.id === "cli:gemini" || spec.id === "cli:qwen") {
      args[1] = prompt;
      stdin = null;
    }
    // A Codex step allowed the internet gets the network Codex runs in: its own (ownNetwork), so the
    // internet and this machine's recorded host ports, not every local service.
    const command = repair ? deps.repairCommand(executable, args)
      : step && network ? await deps.ownNetwork([executable, ...args]) : [executable, ...args];
    const options: RunOptions = { watch, extraEnv: tmp ? { TMPDIR: tmp } : null, toolTrace, signal };
    const run = () => (spec.id === "cli:codex" ? this.runInput(spec, command, cwd, prompt, timeout, options)
      : this.run(spec, command, cwd, stdin, timeout, options));
    const stdout = step ? await withCodexRules(cwd, run) : await run();
    if (spec.id === "cli:codex") return codexOutput(stdout);
    const text = stdout.trim();
    if (["cli:claude", "cli:gemini", "cli:qwen"].includes(spec.id)) {
      try {
        const payload = JSON.parse(text);
        if (isObject(payload)) return { text: pyStr(payload.result || payload.response || payload.text || text), usage: cliUsage(payload) };
      } catch {
        // not JSON: the text as it is
      }
    }
    return { text, usage: {} };
  }
}
