// Model packages (docs/design/model-packages.md): a membership CLI brought in by a package shipped in
// server/packages, switched on and off like any extension. The package knows its CLI: how to call it,
// what its answer looks like, how it says its quota ran out, where it keeps its login and which hosts
// it calls its model at. FluidForm keeps what must not be the package's: the sandbox every call runs
// in, the network a step gets, the timeouts and the accounting. The package's code runs no command.
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { hideHomes, listenScript, ownNetwork, SANDBOX_PORTS_DIR, sandboxAvailable, sandboxPorts, portBridge, Workspace } from "./agent.js";
import { DomainProxy, PROXY_PORT } from "./capability-sandbox.js";
import * as environment from "./environment.js";
import * as extensions from "./extensions.js";
import { log } from "./log.js";
import * as provided from "./provided.js";

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

/** What a model package's code exports as ``channel`` (its src/index). */
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
  /** Folders under the home it keeps its login and state in: the only part of the home it sees, writable. */
  state: string[];
  /** Hosts it calls its model at: all a call without the internet reaches (through FluidForm's proxy). */
  hosts: string[];
  /** Its arguments for ``call``, after the executable. */
  args(call: ChannelCall): string[];
  /** What it reads on stdin, or null. */
  stdin(call: ChannelCall): string | null;
  /** Its answer, from what it printed. */
  parse(stdout: string): ChannelReply;
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

/** bwrap's file system for a call: the whole disk read-only; the home hidden but for the CLI's own
 *  state (and the executable); FluidForm's data hidden but for the call's folder,
 *  writable for a step and read-only for the lead; the tools the environment repairs installed and
 *  the folders it is to read; a /tmp of its own. */
export function fileSystem(channel: ModelChannel, executable: string, call: ChannelCall): string[] {
  const home = real(homedir());
  const state = channel.state.map((folder) => join(home, folder)).filter(isDir).flatMap((folder) => ["--bind", folder, folder]);
  // The executable itself, wherever it is (the home, say, which is hidden).
  const program = real(executable);
  const keepProgram = ["--ro-bind", program, program];
  const cwd = real(call.cwd);
  const [outer, inner, masked] = new Workspace(cwd).platformData();
  const tools = environment.toolsDir();
  const shared = isDir(tools) ? ["--ro-bind", tools, tools] : [];
  const readable = [...new Set(call.readable.map(real))].filter((folder) => isDir(folder) && folder !== cwd).sort()
    .flatMap((folder) => ["--ro-bind", folder, folder]);
  return ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", ...hideHomes(), ...state,
    ...outer, call.lead ? "--ro-bind" : "--bind", cwd, cwd, ...inner, ...masked, ...shared, ...readable, ...keepProgram,
    "--die-with-parent", "--chdir", cwd];
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
  const env = { TMPDIR: "/tmp" };
  if (network && !call.lead) return work(await deps.ownNetwork(["bwrap", ...files, "--", ...argv]), env);
  const ports = call.lead ? [] : await deps.hostPorts();
  const proxy = await new DomainProxy(channel.hosts, (line) => log.info(`${channel.id}: ${line}`)).open();
  try {
    return await portBridge(ports, (folder) => {
      // The host ports' sockets and the proxy's, side by side where the listeners inside look.
      const bridge = folder ? ["--bind", folder, SANDBOX_PORTS_DIR, "--bind", `${proxy.folder}/${PROXY_PORT}.sock`, `${SANDBOX_PORTS_DIR}/${PROXY_PORT}.sock`]
        : ["--bind", proxy.folder!, SANDBOX_PORTS_DIR];
      const command = ["bwrap", ...files, ...bridge, "--unshare-net", "--", "/bin/bash", "-c",
        listenScript([PROXY_PORT, ...ports]) + 'exec "$@"', "bash", ...argv];
      return work(command, { ...env, ...PROXIED_ENV });
    });
  } finally {
    await proxy.close();
  }
}

/** The folder of each file a call is to read. */
export const foldersOf = (paths: string[]) => [...new Set(paths.map((path) => dirname(path)))];
