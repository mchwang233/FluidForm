// Codex CLI as a model (docs/design/model-packages.md): its own sandbox, measured and kept
// (docs/design/cli-step-network.md). Moved here unchanged from server/src/cli-channels.ts: the package
// builds each command with Codex's permission profile and settings; FluidForm runs it (Runner).
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, unlinkSync,
  writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { path as attachmentPath } from "../../../src/attachments.js";
import * as calls from "../../../src/calls.js";
import { CliError, type CliText, codexHome, cliUsage, InputTooLarge, inputTooLarge } from "../../../src/cli-channels.js";
import { settings } from "../../../src/config.js";
import * as environment from "../../../src/environment.js";
import { type ModelChannel, type OwnConversation, type OwnStep, register, type Runner } from "../../../src/model-channels.js";
import type { Attachment } from "../../../src/models.js";
import { formatG, isObject, pyDumps, pyRegex, pyStr, splitlines } from "../../../src/py.js";
import { compactContext } from "../../../src/team.js";

export const EXECUTABLE = "codex";

// Bound the full UTF-8 input conservatively, leaving room for CLI/protocol wrapping.
export const CODEX_INPUT_LIMIT = 1048576;
export const CODEX_INPUT_RESERVE = 65536;
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

export const INVOKE_ARGS = ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "workspace-write", "--color", "never", "-"];
// Repairing the environment: no sandbox, no approvals; the whole CLI runs under bubblewrap instead,
// which only blocks gaining root (Runner.repairCommand).
export const REPAIR_ARGS = ["exec", "--ephemeral", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--color", "never", "-"];
// The task's lead: its sandbox is the lead's permission profile (codexStepPermissions with lead), added per call.
export const SESSION_ARGS = ["exec", "--json", "--skip-git-repo-check", "--color", "never"];

// Codex's own features the platform's leads and steps do not use (Codex feature flags).
export const CODEX_EXTRAS = ["plugins", "apps", "browser_use", "in_app_browser", "computer_use"];
// Reasoning efforts as Codex names them; the platform's scale maps onto it.
export const CODEX_EFFORTS: Record<string, string> = { none: "minimal", minimal: "minimal", low: "low", medium: "medium", high: "high",
  xhigh: "xhigh", max: "max", ultra: "max" };
// A server's own table in Codex's config: [mcp_servers.name] or [mcp_servers."name"].
const CODEX_SERVER = pyRegex(String.raw`^\s*\[\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*\]\s*$`, "mg");

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
  const found = environment.which(EXECUTABLE);
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

/** Codex reads the whole disk in its sandbox; images also go in as real image inputs. "--image="
 *  keeps the value from swallowing the trailing "-" (prompt on stdin). */
export function withAttachments(args: string[], attachments: Attachment[]): string[] {
  if (!attachments.length) return args;
  const images = attachments.filter((item) => item.kind === "image").map((item) => `--image=${attachmentPath(item)}`);
  return [args[0], ...images, ...args.slice(1)];
}

// What tests replace.
export const deps = {
  codexSettings: (effort: string | null = null, serviceTier = "") => codexSettings(effort, serviceTier),
  codexStepPermissions: (workdir: string, network: boolean, options: { lead?: boolean; tmpdir?: string | null; readable?: string[] } = {}) =>
    codexStepPermissions(workdir, network, options),
  codexServers: () => codexServers(),
};

/** Run with the fully assembled input checked, retrying only an explicitly rejected, smaller input. */
export async function runInput(runner: Runner, command: string[], cwd: string, prompt: string, timeout: number,
  options: Parameters<Runner["run"]>[4] = {}): Promise<string> {
  let text = codexInput(prompt);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const output = await runner.run(command, cwd, Buffer.from(text, "utf8"), timeout, options);
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

/** A step (or a repair, which leaves the sandbox). */
async function complete(runner: Runner, call: OwnStep): Promise<CliText> {
  const executable = runner.which(EXECUTABLE);
  if (!executable) throw new CliError(`${EXECUTABLE} is no longer installed`);
  const step = !call.repair;
  return withPrivateTmp(step, async (tmp) => {
    let args = [...(call.repair ? REPAIR_ARGS : INVOKE_ARGS)];
    if (step) {
      // Codex's own sandbox with the step's permission profile instead of workspace-write.
      const at = args.indexOf("--sandbox");
      args = [...args.slice(0, at), ...args.slice(at + 2)];
      args = [args[0], ...deps.codexStepPermissions(call.cwd, call.network, { tmpdir: tmp }), ...args.slice(1)];
    }
    args = withAttachments(args, call.attachments);
    args = [args[0], ...deps.codexSettings(call.effort), ...args.slice(1)];
    if (!args.includes("--json")) args.splice(1, 0, "--json");
    // A step allowed the internet gets the network Codex runs in: its own (ownNetwork), so the
    // internet and this machine's recorded host ports, not every local service.
    const command = call.repair ? runner.repairCommand(executable, args)
      : call.network ? await runner.ownNetwork([executable, ...args]) : [executable, ...args];
    const options = { watch: call.watch, extraEnv: tmp ? { TMPDIR: tmp } : null, toolTrace: call.toolTrace, signal: call.signal };
    const run = () => runInput(runner, command, call.cwd, call.prompt, call.timeout, options);
    return codexOutput(step ? await withCodexRules(call.cwd, run) : await run());
  });
}

/** The lead's conversation: read-only (the lead's profile), continued with ``exec resume``. Without a
 *  timeout it runs while it keeps printing, stopped after lead_idle_minutes without output, at most
 *  lead_call_max_minutes. */
async function converse(runner: Runner, call: OwnConversation): Promise<[CliText, string]> {
  const executable = runner.which(EXECUTABLE);
  if (!executable) throw new CliError("cli:codex cannot keep a conversation here");
  const { sessionId, attachments, effort } = call;
  let sid = sessionId;
  let args = sessionId ? ["exec", "resume", sessionId, "--json", "--skip-git-repo-check", "-"] : [...SESSION_ARGS, "-"];
  // `exec resume` parses its own options. Overrides on the outer `exec` are discarded on resume,
  // restoring the user's effort/tier/plugins instead.
  const options = [...deps.codexSettings(effort || settings.lead_reasoning_effort, settings.codex_lead_service_tier),
    ...deps.codexStepPermissions(call.cwd, false, { lead: true, readable: attachments.map((item) => dirname(attachmentPath(item))) })];
  const position = sessionId ? 3 : 1;
  args = [...args.slice(0, position), ...options, ...args.slice(position)];
  // Images go in as real image inputs ("--image=" keeps the trailing "-" for stdin).
  if (!sessionId) args = [args[0], ...attachments.filter((item) => item.kind === "image").map((item) => `--image=${attachmentPath(item)}`), ...args.slice(1)];
  const record = calls.row();
  if (record) {
    const chosen = effort || settings.lead_reasoning_effort;
    record.effective_effort = CODEX_EFFORTS[chosen] ?? chosen;
  }
  calls.save();
  const idle = call.timeout === null ? settings.lead_idle_minutes * 60 : null;
  const output = await runInput(runner, [executable, ...args], call.cwd, call.prompt, call.timeout ?? settings.lead_call_max_minutes * 60,
    { idle, signal: call.signal });
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

/** Kill the command and any tools it spawned; they share the session started for it. */
function killGroup(child: ChildProcess): void {
  try {
    process.kill(-child.pid!, "SIGKILL");
  } catch {
    // already gone
  }
}

/** ``command`` in Codex's sandbox exactly as a step gets it (the step's permission profile; a TMPDIR
 *  of its own; the environment the platform gives every CLI), without the model (codex sandbox). */
async function sandboxRun(runner: Runner, command: string, cwd: string, timeout: number, network: boolean): Promise<[string, boolean]> {
  const executable = runner.which(EXECUTABLE);
  if (!executable) throw new CliError("cli:codex cannot run a command in its sandbox without the model");
  return withPrivateTmp(true, async (tmp) => {
    let argv = [executable, "sandbox", "-P", CODEX_STEP_PROFILE, "-C", cwd, ...deps.codexStepPermissions(cwd, network, { tmpdir: tmp }),
      "--", "/bin/bash", "-c", command];
    // The network a step gets: see complete.
    if (network) argv = await runner.ownNetwork(argv);
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

export const channel: ModelChannel = {
  id: "cli:codex",
  executable: EXECUTABLE,
  auth_command: ["login", "status"],
  fallback_model_id: "openai:gpt-5.6-terra",
  sessions: true,
  own: { complete, converse, sandboxRun },
};

register(channel);
