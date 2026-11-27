// The network a sandbox gets (agent.ts, model-channels.ts, the CLI packages): pasta for the internet,
// the proxies kept, the recorded host ports bridged in over Unix sockets, and the user's environment and
// home kept out of bwrap's arguments.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { settings } from "./config.js";
import * as environment from "./environment.js";
import { shlexQuote } from "./py.js";

// Where the bridged ports' sockets appear inside the sandbox.
export const SANDBOX_PORTS_DIR = "/tmp/.sp-ports";
// Proxy settings a networked sandbox keeps, so commands reach the internet the way the user does.
export const PROXY_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export function sandboxAvailable(): boolean {
  return environment.which("bwrap") !== null;
}

/** Host ports bridged into the sandbox; none without socat, which listens on them inside. */
export async function sandboxPorts(): Promise<number[]> {
  return environment.which("socat") ? environment.hostPorts() : [];
}

// What tests replace: the bridged ports, and whether pasta is there.
export const deps = { sandboxPorts: () => sandboxPorts(), networkAvailable: () => networkAvailable(), mapsUser: () => mapsUser() };

/** Local ports of the proxies in this process's environment, which a networked sandbox forwards
 *  so a proxy the user depends on keeps working. */
export function proxyPorts(): number[] {
  const ports = new Set<number>();
  for (const name of PROXY_ENV) {
    const value = process.env[name] ?? "";
    if (!value || !name.toLowerCase().includes("proxy") || name.toLowerCase().startsWith("no_")) continue;
    try {
      const url = new URL(value.includes("://") ? value : `http://${value}`);
      const host = url.hostname.replace(/^\[|\]$/g, "");
      if (LOOPBACK.has(host) && url.port) ports.add(Number(url.port));
    } catch {
      continue;
    }
  }
  return [...ports].sort((a, b) => a - b);
}

export function networkAvailable(): boolean {
  return environment.which("pasta") !== null;
}

let mapsUserCached: boolean | null = null;

/** Whether a sandbox inside pasta can map the user back (bwrap --unshare-user --uid): not when this
 *  process is itself in a user namespace mapping only the user (a repair's commands). Asked once. */
export function mapsUser(): boolean {
  if (mapsUserCached !== null) return mapsUserCached;
  const { uid, gid } = userInfo();
  const done = spawnSync("pasta", ["--config-net", "--quiet", "--", "bwrap", "--unshare-user", "--uid", String(uid), "--gid", String(gid),
    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--", "true"], { stdio: "ignore", timeout: 30_000 });
  mapsUserCached = !done.error && done.status === 0;
  return mapsUserCached;
}

/** Run a command in a new network namespace with internet access. pasta forwards no host ports into
 *  it (-T/-U none) and maps no address to the host's loopback (--no-map-gw), so local services such as
 *  this application's API stay out of reach; only ``forward`` gets in. */
export function networkPrefix(forward: number[]): string[] {
  const tcp = forward.join(",") || "none";
  return ["pasta", "--config-net", "--quiet", "--no-map-gw", "-T", tcp, "-U", "none", "-u", "none", "-t", "none", "--"];
}

// pasta puts /dev/null in place of a socket on stdin, stdout or stderr, which is what Node gives a
// child for a pipe; the shell in front gives it real pipes and passes the data and the exit code on.
// What feeds stdin stops when the command ends, even if the caller never closes it.
const REAL_PIPES = 'exec 3< <(exec cat 2>/dev/null); feeder=$!\n'
  + '"$@" <&3 3<&- 2> >(exec cat >&2) | cat\nstatus=${PIPESTATUS[0]}\nkill "$feeder" 2>/dev/null\nexit "$status"';

/** ``command``, a CLI whose own sandbox gives its commands the network it runs in (Codex), in a network
 *  namespace of its own: the internet, the proxies and this machine's recorded host ports (a license
 *  server), but no other local service, such as this application's API. As the user again (bwrap maps
 *  them back from pasta's root), which the CLI's own sandbox needs. Unchanged without pasta or that
 *  mapping: then its commands reach the host's network as before. */
export async function ownNetwork(command: string[]): Promise<string[]> {
  if (!deps.networkAvailable() || !deps.mapsUser()) return command;
  const forward = [...new Set([...proxyPorts(), ...(await environment.hostPorts())])].sort((a, b) => a - b);
  const { uid, gid } = userInfo();
  return ["/bin/bash", "-c", REAL_PIPES, "bash", ...networkPrefix(forward), "bwrap", "--unshare-user", "--uid", String(uid), "--gid", String(gid),
    "--bind", "/", "/", "--dev-bind", "/dev", "/dev", "--proc", "/proc", "--die-with-parent", "--", ...command];
}

/** The command with bwrap's --clearenv and --setenv taken out, and the environment they set, to
 *  start it with instead: every user of the machine can read a command line (/proc/<pid>/cmdline),
 *  only its own user its environment, and a value may be a secret (a capability's, a proxy's
 *  password). bwrap, and pasta before it, pass their environment on. The programs are found on this
 *  process's PATH, not the one given to the command. */
export function withoutEnvArgs(args: string[]): [string[], Record<string, string>] {
  if (!args.includes("--clearenv")) return [args, { ...process.env } as Record<string, string>];
  const kept: string[] = [];
  const env: Record<string, string> = {};
  // bwrap's own options end at the "--" after it: pasta, before it, has one of its own.
  const start = Math.max(0, args.indexOf("bwrap"));
  const end = args.indexOf("--", start) >= 0 ? args.indexOf("--", start) : args.length;
  for (let index = 0; index < args.length;) {
    const arg = args[index];
    if (index < end && arg === "--clearenv") index += 1;
    else if (index < end && arg === "--setenv" && index + 2 < end) {
      env[args[index + 1]] = args[index + 2];
      index += 3;
    } else {
      kept.push(arg);
      index += 1;
    }
  }
  kept[0] = environment.which(kept[0]) ?? kept[0];
  return [kept, env];
}

/** bwrap arguments hiding the user's home (keys, tokens, other projects). HOME can be overridden by
 *  a launcher or validation environment, so the account's real home is hidden too. */
export function hideHomes(): string[] {
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  const homes = [...new Set([real(homedir()), real(userInfo().homedir)])];
  return homes.sort((a, b) => a.split("/").length - b.split("/").length)
    .filter((home) => home !== "/" && existsSync(home) && statSync(home).isDirectory()).flatMap((home) => ["--tmpfs", home]);
}

/** Shell lines that listen on each bridged port inside the sandbox, then wait until ready. */
export function listenScript(ports: number[]): string {
  return bridgeScript(Object.fromEntries(ports.map((port) => [port, `${SANDBOX_PORTS_DIR}/${port}.sock`])));
}

/** Shell lines that listen on each port (on 127.0.0.1) and pass it to its Unix socket, then wait until ready. */
export function bridgeScript(sockets: Record<number, string>): string {
  const ports = Object.keys(sockets).map(Number);
  if (!ports.length) return "";
  const lines = ports.map((port) => `socat TCP-LISTEN:${port},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${shlexQuote(sockets[port])}`
    + " </dev/null >/dev/null 2>&1 &");
  lines.push(untilListening(ports));
  return lines.join("\n") + "\n";
}

/** Wait until each port listens. A listening socket shows in /proc/net/tcp as "<addr>:<hex port> 00000000:0000 0A". */
function untilListening(ports: number[]): string {
  const ready = ports.map((port) => `grep -q ":${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A" /proc/net/tcp`).join(" && ");
  return `for _ in $(seq 250); do { ${ready}; } && break; sleep 0.02; done`;
}

/** Shell lines Claude Code runs before each of its sandboxed commands (CLAUDE_ENV_FILE): on Linux each
 *  such command has a private network, and the sandbox's proxy (``http_proxy`` inside it) reaches a
 *  local port only when its settings list it (cli-channels.withHostPorts). Each host port listens there
 *  and goes out through that proxy (HTTP CONNECT), for clients that use no proxy themselves, such as a
 *  FlexLM license check. ``before``: an env file of the user's own, loaded first. Without a proxy or
 *  socat, nothing. */
export function proxyListenScript(ports: number[], before = ""): string {
  const lines = before ? [`if [ -r ${shlexQuote(before)} ]; then . ${shlexQuote(before)}; fi`] : [];
  if (!ports.length) return lines.join("\n") + (lines.length ? "\n" : "");
  lines.push('__sp_proxy="${http_proxy:-${HTTP_PROXY:-}}"',
    'if [ -n "$__sp_proxy" ] && command -v socat >/dev/null 2>&1; then',
    '  __sp_proxy="${__sp_proxy#*://}"; __sp_proxy="${__sp_proxy%%/*}"; __sp_auth=""',
    '  case "$__sp_proxy" in *@*) __sp_auth=",proxyauth=${__sp_proxy%@*}"; __sp_proxy="${__sp_proxy##*@}";; esac',
    // In a subshell: no job notices in the command's output.
    ...ports.map((port) => `  (socat TCP-LISTEN:${port},bind=127.0.0.1,fork,reuseaddr `
      + `"PROXY:\${__sp_proxy%:*}:127.0.0.1:${port},proxyport=\${__sp_proxy##*:}$__sp_auth" </dev/null >/dev/null 2>&1 &)`),
    `  ${untilListening(ports)}`,
    "fi",
    "unset __sp_proxy __sp_auth");
  return lines.join("\n") + "\n";
}

/** Serve each host port on a Unix socket in a fresh folder for the sandbox to mount, while ``work``
 *  runs. The forwarding runs in this process, so nothing outlives the command. ``work`` gets the
 *  folder, or null when there is nothing to bridge. */
export async function portBridge<T>(ports: number[], work: (folder: string | null) => Promise<T>): Promise<T> {
  if (!ports.length) return work(null);
  // Under /tmp, not a possibly long TMPDIR: Unix socket paths are limited to about 107 bytes.
  const folder = mkdtempSync(join(existsSync("/tmp") ? "/tmp" : tmpdir(), "sp-ports-"));
  const servers: Server[] = [];
  try {
    for (const port of ports) {
      const path = `${folder}/${port}.sock`;
      const server = createServer((client) => {
        const upstream = connect({ host: "127.0.0.1", port });
        upstream.on("error", () => client.destroy());
        client.on("error", () => upstream.destroy());
        client.pipe(upstream).pipe(client);
      });
      await new Promise<void>((done, fail) => server.listen(path, () => done()).once("error", fail));
      chmodSync(path, 0o600);
      servers.push(server);
    }
    return await work(folder);
  } finally {
    for (const server of servers) server.close();
    rmSync(folder, { recursive: true, force: true });
  }
}
