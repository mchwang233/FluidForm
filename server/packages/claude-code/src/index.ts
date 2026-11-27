// Claude Code as a model (docs/design/model-packages.md): its own sandbox, measured and kept
// (docs/design/cli-step-network.md). Moved here unchanged from server/src/cli-channels.ts: the package
// builds each command with Claude Code's sandbox settings; FluidForm runs it (Runner).
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type Attachment, calls, CliError, type CliText, cliUsage, isObject, type ModelChannel, type OwnConversation, type OwnStep,
  path as attachmentPath, proxyListenScript, pyDumps, pyStr, register, type Runner, settings
} from "../../../src/extension-api.js";

export const EXECUTABLE = "claude";

// Claude Code runs shell commands inside its own bubblewrap sandbox: writes only in the working
// directory (and /tmp), no network, and no way to ask for an unsandboxed command. Sandboxed commands
// need no approval, which a background run could never give; file edits are accepted.
export const CLAUDE_SANDBOX_SETTINGS = pyDumps({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false } });
// A task that allows the network: sandboxed commands may reach any domain except this machine,
// whose services (this application's API among them) stay closed.
export const CLAUDE_NETWORK_SETTINGS = pyDumps({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
  network: { allowedDomains: ["*"], deniedDomains: ["localhost", "127.0.0.1", "::1"] } } });
// Repairing the environment: Claude Code without its sandbox and without asking for approval. The
// whole CLI runs under bubblewrap instead, which only blocks gaining root (Runner.repairCommand).
export const CLAUDE_REPAIR_SETTINGS = pyDumps({ sandbox: { enabled: false } });

export const INVOKE_ARGS = ["-p", "--output-format", "json", "--permission-mode", "acceptEdits", "--settings", CLAUDE_SANDBOX_SETTINGS,
  "--no-session-persistence"];
export const REPAIR_ARGS = ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions", "--settings", CLAUDE_REPAIR_SETTINGS,
  "--no-session-persistence"];
// The task's lead keeps one conversation per task. It reads files and runs sandboxed commands to look
// things up, but does not edit: the steps' models do the work.
export const SESSION_ARGS = ["-p", "--output-format", "json", "--permission-mode", "default", "--settings", CLAUDE_SANDBOX_SETTINGS,
  "--disallowedTools", "Edit,Write,NotebookEdit"];

/** Open the sandbox to the internet. */
export function withNetwork(args: string[]): string[] {
  return args.map((arg) => (arg === CLAUDE_SANDBOX_SETTINGS ? CLAUDE_NETWORK_SETTINGS : arg));
}

/** ``args`` with Claude Code's sandbox settings opened to this machine's recorded host ports (a
 *  license server, say): its proxy reaches a local port only as the ``host:port`` listed in
 *  allowedDomains (a bare host would open them all), and the bridge that listens on them inside each
 *  command needs to bind (allowLocalBinding; agent.proxyListenScript). Every other local service
 *  stays closed: with the internet, 127.0.0.1 leaves the deny list, which would win over the listed
 *  ports, and "*" never covers a local address. */
export function withHostPorts(args: string[], ports: number[]): string[] {
  if (!ports.length) return args;
  return args.map((arg) => {
    if (arg !== CLAUDE_SANDBOX_SETTINGS && arg !== CLAUDE_NETWORK_SETTINGS) return arg;
    const given = JSON.parse(arg);
    const network = given.sandbox.network ?? {};
    network.allowedDomains = [...(network.allowedDomains ?? []), ...ports.map((port) => `127.0.0.1:${port}`)];
    if (network.deniedDomains) network.deniedDomains = network.deniedDomains.filter((host: string) => host !== "127.0.0.1");
    network.allowLocalBinding = true;
    return pyDumps({ ...given, sandbox: { ...given.sandbox, network } });
  });
}

/** ``work`` with an env file for Claude Code (CLAUDE_ENV_FILE) that bridges ``ports`` into each of its
 *  sandboxed commands, removed afterwards; ``work`` gets the variables to add (none without ports). */
export async function withClaudeBridge<T>(ports: number[], work: (env: Record<string, string>) => Promise<T>): Promise<T> {
  if (!ports.length) return work({});
  const folder = mkdtempSync(join(tmpdir(), "sp-claude-"));
  const file = join(folder, "env.sh");
  try {
    writeFileSync(file, proxyListenScript(ports, process.env.CLAUDE_ENV_FILE ?? ""), { mode: 0o644 });
    return await work({ CLAUDE_ENV_FILE: file });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** Let it open attached files, which live outside its working directory. */
export function withAttachments(args: string[], attachments: Attachment[]): string[] {
  if (!attachments.length) return args;
  return [...args, "--add-dir", ...[...new Set(attachments.map((item) => dirname(attachmentPath(item))))].sort()];
}

/** Its answer: the JSON result, or the text as it is. */
export function answer(stdout: string): CliText {
  const text = stdout.trim();
  try {
    const payload = JSON.parse(text);
    if (isObject(payload)) return { text: pyStr(payload.result || payload.response || payload.text || text), usage: cliUsage(payload) };
  } catch {
    // not JSON: the text as it is
  }
  return { text, usage: {} };
}

/** A step (or a repair, which leaves the sandbox). A step reaches this machine's recorded host ports,
 *  and only those (withHostPorts, withClaudeBridge). */
async function complete(runner: Runner, call: OwnStep): Promise<CliText> {
  const executable = runner.which(EXECUTABLE);
  if (!executable) throw new CliError(`${EXECUTABLE} is no longer installed`);
  let args = [...(call.repair ? REPAIR_ARGS : INVOKE_ARGS)];
  if (call.network && !call.repair) args = withNetwork(args);
  const ports = call.repair ? [] : await runner.hostPorts();
  args = withHostPorts(args, ports);
  args = withAttachments(args, call.attachments);
  const command = call.repair ? runner.repairCommand(executable, args) : [executable, ...args];
  const stdout = await withClaudeBridge(ports, (bridge) => runner.run(command, call.cwd, Buffer.from(call.prompt, "utf8"), call.timeout,
    { watch: call.watch, extraEnv: ports.length ? bridge : null, toolTrace: call.toolTrace, signal: call.signal }));
  return answer(stdout);
}

/** The lead's conversation: --session-id for a new one, --resume to continue; at most
 *  lead_call_max_minutes without a timeout. */
async function converse(runner: Runner, call: OwnConversation): Promise<[CliText, string]> {
  const executable = runner.which(EXECUTABLE);
  if (!executable) throw new CliError("cli:claude cannot keep a conversation here");
  const sid = call.sessionId || randomUUID();
  const args = [...SESSION_ARGS, call.sessionId ? "--resume" : "--session-id", sid];
  if (call.attachments.length) args.push("--add-dir", ...[...new Set(call.attachments.map((item) => dirname(attachmentPath(item))))].sort());
  if (call.effort) {
    args.push("--effort", call.effort);
    const record = calls.row();
    if (record) record.effective_effort = call.effort;
  }
  calls.save();
  const output = await runner.run([executable, ...args], call.cwd, Buffer.from(call.prompt, "utf8"), call.timeout ?? settings.lead_call_max_minutes * 60,
    { signal: call.signal });
  const payload = JSON.parse(output);
  return [{ text: pyStr(payload.result || ""), usage: cliUsage(payload) }, pyStr(payload.session_id || sid)];
}

export const channel: ModelChannel = {
  id: "cli:claude",
  executable: EXECUTABLE,
  auth_command: ["auth", "status"],
  fallback_model_id: "anthropic:claude-sonnet-5",
  sessions: true,
  own: { complete, converse },
};

register(channel);
