// Model packages (docs/design/model-packages.md): a membership CLI brought in by a package shipped in
// server/packages, switched on and off like any extension. The package knows its CLI: how to call it,
// what its answer looks like, how it says its quota ran out, where it keeps its login and which hosts
// it calls its model at. FluidForm keeps what must not be the package's: the sandbox every call runs
// in, the network a step gets, the timeouts and the accounting. The package's code runs no command.
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { bridgeScript, hideHomes, listenScript, ownNetwork, PROXY_ENV, SANDBOX_PORTS_DIR, sandboxAvailable, sandboxPorts, portBridge, withoutEnvArgs, Workspace } from "./agent.js";
import { settings } from "./config.js";
import * as environment from "./environment.js";
import { DomainProxy, PROXY_PORT } from "./capability-sandbox.js";
import * as extensions from "./extensions.js";
import { log } from "./log.js";
import type { CliText, RunOptions } from "./cli-channels.js";
import type { Attachment } from "./models.js";
import type * as progress from "./progress.js";
import * as provided from "./provided.js";
import { SECRET_ENV } from "./secret-names.js";

/** One call of a package's CLI, as FluidForm sets it up. */
export type ChannelCall = {
  prompt: string;
  /** Its working folder: a step's, which it writes, or the lead's, which it only reads. */
  cwd: string;
  /** The task's lead (a conversation that reads and looks things up) rather than a step. */
  lead: boolean;
  /** The conversation to continue, for the lead; null starts one. */
  sessionId: string | null;
  /** Folders outside ``cwd`` it is to read (attachments). */
  readable: string[];
  /** It repairs the environment, outside every sandbox (it may write anywhere the user may). */
  repair?: boolean;
};

export type ChannelUsage = { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number };

/** What the CLI answered, as the package reads it from the CLI's output. */
export type ChannelReply = {
  text: string;
  usage: ChannelUsage;
  /** The conversation it answered in, for the lead to continue. */
  sessionId: string | null;
  /** Why it failed, when it did, in the CLI's words. */
  error: string | null;
  /** The failure is its quota running out. */
  quota: boolean;
};

/** How FluidForm runs a command a package built: in its own process group, with the timeouts,
 *  progress checks, live activity and trace every CLI gets (CliChannelRegistry.run). */
export type Runner = {
  run(command: string[], cwd: string, stdin: Buffer | null, timeout: number, options?: RunOptions): Promise<string>;
  which(name: string): string | null;
  /** This machine's recorded host ports (a license server), none without socat. */
  hostPorts(): Promise<number[]>;
  /** ``command`` in a network of its own: the internet, the proxies and the host ports (agent.ownNetwork). */
  ownNetwork(command: string[]): Promise<string[]>;
  /** ``executable`` on the host as the user, under no_new_privs, to repair the environment. */
  repairCommand(executable: string, args: string[]): string[];
  /** Whether ``withoutInternet`` can isolate a command here (bwrap and socat). */
  isolates(): boolean;
  /** ``work`` with ``command`` in a network of its own without the internet: this machine's recorded
   *  host ports (a license server) and ``hosts`` through FluidForm's proxy, nothing else (no other
   *  local service, such as FluidForm's API). The environment to add points at the proxy. */
  withoutInternet<T>(command: string[], hosts: string[], work: (command: string[], env: Record<string, string>) => Promise<T>): Promise<T>;
};

/** A step's call of a CLI with a sandbox of its own. */
export type OwnStep = { prompt: string; cwd: string; timeout: number; attachments: Attachment[]; repair: boolean; network: boolean;
  watch: progress.Watch | null; effort: string | null; toolTrace: string | null; signal?: AbortSignal };
/** The lead's call: a conversation, continued with ``sessionId``; ``timeout`` null for the CLI's own pace. */
export type OwnConversation = { prompt: string; cwd: string; sessionId: string | null; timeout: number | null; effort: string | null;
  attachments: Attachment[]; signal?: AbortSignal };

/** A CLI whose own sandbox has been measured and is kept (Codex, Claude Code): the package builds each
 *  command with that sandbox's settings, FluidForm runs it. */
export type OwnSandbox = {
  complete(runner: Runner, call: OwnStep): Promise<CliText>;
  converse?(runner: Runner, call: OwnConversation): Promise<[CliText, string]>;
  /** ``command`` in its sandbox exactly as a step gets it, without the model: its output, and whether it exited 0. */
  sandboxRun?(runner: Runner, command: string, cwd: string, timeout: number, network: boolean): Promise<[string, boolean]>;
};

/** What a model package's code exports as ``channel`` (its src/index). Either it gives ``own`` (its
 *  CLI's own sandbox, kept), or FluidForm runs it in its sandbox (withSandbox) from ``args``,
 *  ``stdin``, ``parse``, ``state`` and ``hosts``. */
export type ModelChannel = {
  /** The model id it serves, "cli:<name>"; its catalog entry is in the package's capability.json. */
  id: string;
  executable: string;
  /** Arguments that exit 0 when the CLI is logged in. */
  auth_command: string[];
  /** The metered API model a failed call may fall back to. */
  fallback_model_id: string;
  /** Whether it keeps a conversation, so it can be a task's lead. */
  sessions: boolean;
  own?: OwnSandbox;
  /** Folders under the home it keeps its login and state in: the only part of the home it sees, writable. */
  state?: string[];
  /** Hosts it calls its model at: all a call without the internet reaches (through FluidForm's proxy). */
  hosts?: string[];
  /** Its arguments for ``call``, after the executable. */
  args?(call: ChannelCall): string[];
  /** What it reads on stdin, or null. */
  stdin?(call: ChannelCall): string | null;
  /** Its answer, from what it printed. */
  parse?(stdout: string): ChannelReply;
};

const registered = new Map<string, ModelChannel>();

/** Called by a model package's code when it is loaded. */
export function register(channel: ModelChannel): void {
  registered.set(channel.id, channel);
}

/** The shipped package that brings ``modelId``, whether it is on or not. */
export const ownerOf = (modelId: string) => extensions.providing(`model:${modelId}`);

/** The channel for ``modelId`` when its package is shipped, loaded and on; otherwise null. */
export function channelFor(modelId: string): ModelChannel | null {
  const channel = registered.get(modelId);
  const owner = ownerOf(modelId);
  return channel && owner && provided.deps.extensionOn(owner, provided.current(), `model:${modelId}`) ? channel : null;
}

/** The executables of every channel loaded, on or off (tests keep real CLIs out of reach with it). */
export const executables = (): string[] => [...registered.values()].map((channel) => channel.executable);

/** The channels in use now. */
export function active(): ModelChannel[] {
  return [...registered.keys()].map(channelFor).filter((channel): channel is ModelChannel => channel !== null);
}

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};
const isDir = (path: string) => existsSync(path) && statSync(path).isDirectory();

// What tests replace: whether bwrap is there, the host ports, the network a networked call gets.
export const deps = {
  sandboxAvailable: () => sandboxAvailable(),
  hostPorts: () => sandboxPorts(),
  ownNetwork: (command: string[]) => ownNetwork(command),
};

/** What running ``executable`` needs, read-only, wherever it is (the home, say, which is hidden): the
 *  program itself, or the whole package it belongs to (a Node CLI installed with npm runs from
 *  node_modules/<package>/), found as the nearest folder above it with a package.json. */
export function programFiles(executable: string): string[] {
  const program = real(executable);
  const home = real(homedir());
  for (let folder = dirname(program); folder !== "/" && folder !== home && folder !== dirname(folder); folder = dirname(folder)) {
    if (existsSync(join(folder, "package.json"))) return [folder];
  }
  return [program];
}

/** bwrap's file system for a call: the whole disk read-only; the home hidden but for the CLI's own
 *  state (and the executable); FluidForm's data hidden but for the call's folder,
 *  writable for a step and read-only for the lead; the tools the environment repairs installed and
 *  the folders it is to read; a /tmp of its own. */
export function fileSystem(channel: ModelChannel, executable: string, call: ChannelCall): string[] {
  const home = real(homedir());
  const state = (channel.state ?? []).map((folder) => join(home, folder)).filter(isDir).flatMap((folder) => ["--bind", folder, folder]);
  const keepProgram = programFiles(executable).flatMap((path) => ["--ro-bind", path, path]);
  const cwd = real(call.cwd);
  const [outer, inner, masked] = new Workspace(cwd).platformData();
  const tools = environment.toolsDir();
  const shared = isDir(tools) ? ["--ro-bind", tools, tools] : [];
  const readable = [...new Set(call.readable.map(real))].filter((folder) => isDir(folder) && folder !== cwd).sort()
    .flatMap((folder) => ["--ro-bind", folder, folder]);
  return ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", ...hideHomes(), ...state, ...keepProgram,
    ...outer, call.lead ? "--ro-bind" : "--bind", cwd, cwd, ...inner, ...masked, ...shared, ...readable,
    "--die-with-parent", "--chdir", cwd];
}

function sandboxEnv(channel: ModelChannel, cwd: string, network: boolean, extra: Record<string, string> = {}): Record<string, string> {
  const keys = new Set(Object.values(SECRET_ENV));
  const home = real(homedir());
  let env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: (channel.state ?? []).some((folder) => isDir(join(home, folder))) ? home : cwd,
    LANG: process.env.LANG ?? "C.UTF-8",
    TMPDIR: "/tmp",
  };
  for (const name of settings.sandbox_env) if (process.env[name] !== undefined && !keys.has(name)) env[name] = process.env[name]!;
  if (network) for (const name of PROXY_ENV) if (process.env[name] !== undefined) env[name] = process.env[name]!;
  env = environment.commandEnv(env);
  return { ...env, ...extra };
}

const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
/** How a call without the internet reaches its model: through FluidForm's proxy, which lets only its hosts through. */
export const PROXIED_ENV: Record<string, string> = { HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY, ALL_PROXY: PROXY, https_proxy: PROXY,
  http_proxy: PROXY, all_proxy: PROXY, NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1" };

/** Run ``work`` with the command that runs ``argv`` (the CLI and its arguments) in FluidForm's sandbox
 *  for ``channel``, and the environment to add. The sandbox is the boundary: whatever the CLI or its
 *  commands do (it may run them outside a sandbox of its own) stays inside it. With ``network`` (a step
 *  the task lets reach the internet): the internet, the user's proxies and this machine's recorded host
 *  ports, as a Codex step gets them (ownNetwork), no other local service. Without: no network but the
 *  recorded host ports (a license server) and its own hosts through FluidForm's proxy. The lead never
 *  gets the internet. Throws when bwrap is missing: such a CLI does not run unsandboxed. */
export async function withSandbox<T>(channel: ModelChannel, argv: string[], call: ChannelCall, network: boolean,
  work: (command: string[], env: Record<string, string>) => Promise<T>): Promise<T> {
  if (!deps.sandboxAvailable()) throw new Error(`${channel.id} 需要 bubblewrap（bwrap）沙箱才能运行，这台机器上没有。`);
  const files = fileSystem(channel, argv[0], call);
  // By its real path: a link to it (npm's bin/) may be in the hidden home.
  argv = [real(argv[0]), ...argv.slice(1)];
  if (network && !call.lead) {
    const cleanEnv = sandboxEnv(channel, real(call.cwd), true);
    const envArgs = ["--clearenv", ...Object.entries(cleanEnv).flatMap(([k, v]) => ["--setenv", k, v])];
    const [cmd, runEnv] = withoutEnvArgs(["bwrap", ...files, ...envArgs, "--", ...argv]);
    return work(await deps.ownNetwork(cmd), runEnv);
  }
  const ports = call.lead ? [] : await deps.hostPorts();
  const proxy = await new DomainProxy(channel.hosts ?? [], (line) => log.info(`${channel.id}: ${line}`)).open();
  try {
    return await portBridge(ports, (folder) => {
      // The host ports' sockets and the proxy's, side by side where the listeners inside look.
      const bridge = folder ? ["--bind", folder, SANDBOX_PORTS_DIR, "--bind", `${proxy.folder}/${PROXY_PORT}.sock`, `${SANDBOX_PORTS_DIR}/${PROXY_PORT}.sock`]
        : ["--bind", proxy.folder!, SANDBOX_PORTS_DIR];
      const cleanEnv = sandboxEnv(channel, real(call.cwd), false, PROXIED_ENV);
      const envArgs = ["--clearenv", ...Object.entries(cleanEnv).flatMap(([k, v]) => ["--setenv", k, v])];
      const [command, runEnv] = withoutEnvArgs(["bwrap", ...files, ...bridge, "--unshare-net", ...envArgs, "--", "/bin/bash", "-c",
        listenScript([PROXY_PORT, ...ports]) + 'exec "$@"', "bash", ...argv]);
      return work(command, runEnv);
    });
  } finally {
    await proxy.close();
  }
}

/** The folder of each file a call is to read. */
export const foldersOf = (paths: string[]) => [...new Set(paths.map((path) => dirname(path)))];

/** Whether withoutInternet can isolate a command here. */
export const isolates = (): boolean => deps.sandboxAvailable() && environment.which("socat") !== null;

/** Runner.withoutInternet: the whole file system as it is (the command's own sandbox decides what it
 *  sees), a network namespace with only loopback, and in it a listener for each host port and for the
 *  proxy, passed to Unix sockets served from this process. */
export async function withoutInternet<T>(command: string[], hosts: string[], work: (command: string[], env: Record<string, string>) => Promise<T>): Promise<T> {
  const ports = await deps.hostPorts();
  const proxy = await new DomainProxy(hosts, (line) => log.info(`${command[0]}: ${line}`)).open();
  try {
    return await portBridge(ports, (folder) => {
      const sockets: Record<number, string> = { [PROXY_PORT]: `${proxy.folder}/${PROXY_PORT}.sock` };
      for (const port of ports) sockets[port] = `${folder}/${port}.sock`;
      const wrapped = ["bwrap", "--bind", "/", "/", "--dev-bind", "/dev", "/dev", "--proc", "/proc", "--unshare-net", "--die-with-parent", "--",
        "/bin/bash", "-c", bridgeScript(sockets) + 'exec "$@"', "bash", ...command];
      return work(wrapped, PROXIED_ENV);
    });
  } finally {
    await proxy.close();
  }
}
