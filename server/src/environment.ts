// Fixes to the machine that tasks run on, shared by every sandbox.
//
// An automatic diagnosis may repair the environment a task needs: it installs software into the
// tools folder and records environment variables and host ports in its sandbox.json. Every task
// command then sees them: API models' sandboxed commands get the folder mounted read-only, and every
// command, CLI ones included, gets bin on PATH, python on PYTHONPATH and the recorded variables.
//
//     <data_dir>/tools/
//       bin/            executables (or symlinks to them)
//       python/         packages from pip install --target
//       sandbox.json    {"env": {"NAME": "value"}, "host_ports": [26585]}
//
// A FlexLM license server listed by its lmgrd port brings its vendor daemons along: they listen on
// ports chosen at each start, so licenseDaemonPorts finds them in /proc, from lmgrd's own process
// tree only, every time a command runs. An lmgrd run by another user (root) hides its sockets; then
// lmutil lmstat is traced on the host, and the local ports it connects to after asking lmgrd, still
// listening and owned by lmgrd's user, are its vendor daemons (cached for a minute, or until one
// stops listening).
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { settings } from "./config.js";
import { log } from "./log.js";
import { isObject, pyRegex, shlexQuote } from "./py.js";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Set by the sandbox itself, or would let a recorded value change what every command loads.
export const RESERVED_ENV = new Set(["PATH", "HOME", "PYTHONPATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "LANG"]);
export const places = { proc: "/proc" };
const LICENSE_MANAGER = "lmgrd";
const TCP_LISTEN = "0A";
export const timing = {
  PROBE_TTL: 60, // seconds a traced lmstat's answer is reused while its ports still listen
  PROBE_TIMEOUT: 20,
};
const CONNECT = pyRegex(String.raw`sin6?_port=htons\((\d+)\).*?(?:inet_addr\("([^"]+)"\)|inet_pton\(AF_INET6, "([^"]+)")`);
export const PIN_ADVICE = "Pin each vendor daemon's port in the license file (VENDOR snpslmd PORT=27021), restart lmgrd "
  + "(lmutil lmdown -c <file>; lmgrd -c <file>) and add that port to host_ports.";
const warned = new Set<string>();
export const probes = new Map<number, [number, Set<number>]>();
const monotonic = () => performance.now() / 1000;

export function toolsDir(): string {
  return resolve(settings.data_dir, "tools");
}

export function prepare(): string {
  const root = toolsDir();
  for (const folder of [join(root, "bin"), join(root, "python")]) mkdirSync(folder, { recursive: true });
  return root;
}

function readOverrides(): Record<string, unknown> {
  const path = join(toolsDir(), "sandbox.json");
  if (!existsSync(path) || !statSync(path).isFile()) return {};
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return isObject(data) ? data : {};
  } catch {
    log.warning(`Ignoring unreadable ${path}`);
    return {};
  }
}

// What tests replace: this machine's recorded sandbox.json.
export const deps = { overrides: readOverrides };
const overrides = () => deps.overrides();

export function recordedEnv(): Record<string, string> {
  const env = overrides().env;
  if (!isObject(env)) return {};
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => typeof value === "string" && ENV_NAME.test(name)
    && !RESERVED_ENV.has(name))) as Record<string, string>;
}

/** Listed ports, plus the vendor daemons of a license server listed by its lmgrd port. */
export async function hostPorts(): Promise<number[]> {
  const recorded = overrides().host_ports;
  const ports = Array.isArray(recorded) ? recorded.filter((port) => Number.isInteger(port) && port > 0 && port < 65536) : [];
  const listed = new Set<number>([...settings.sandbox_host_ports, ...ports]);
  return [...new Set([...listed, ...await licenseDaemonPorts(listed)])].sort((a, b) => a - b);
}

/** Socket inode -> [port, owner uid] of every listening TCP socket (IPv4 and IPv6). */
function listeners(proc: string): Map<string, [number, string]> {
  const found = new Map<string, [number, string]>();
  for (const name of ["tcp", "tcp6"]) {
    let lines: string[];
    try {
      lines = readFileSync(join(proc, "net", name), "utf8").split("\n").slice(1);
    } catch {
      continue;
    }
    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      if (fields.length > 9 && fields[3] === TCP_LISTEN) {
        found.set(fields[9], [parseInt(fields[1].slice(fields[1].lastIndexOf(":") + 1), 16), fields[7]]);
      }
    }
  }
  return found;
}

/** pid -> [command name, parent pid]. */
function processes(proc: string): Map<string, [string, string]> {
  const found = new Map<string, [string, string]>();
  let entries: string[];
  try {
    entries = readdirSync(proc);
  } catch {
    return found;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(join(proc, name, "stat"), "utf8");
      const at = stat.lastIndexOf(")");
      const head = stat.slice(0, at);
      const rest = stat.slice(at + 1).trim().split(/\s+/);
      if (rest.length < 2) continue;
      found.set(name, [head.slice(head.indexOf("(") + 1), rest[1]]);
    } catch {
      continue;
    }
  }
  return found;
}

/** Socket inodes the process holds open; throws if its fds cannot be read. */
function sockets(proc: string, pid: string): Set<string> {
  const folder = join(proc, pid, "fd");
  let fds: string[];
  try {
    fds = readdirSync(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set(); // the process has exited
    throw error;
  }
  const found = new Set<string>();
  for (const fd of fds) {
    let target: string;
    try {
      target = readlinkSync(join(folder, fd));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // closed meanwhile
      throw error;
    }
    if (target.startsWith("socket:[")) found.add(target.slice(8, -1));
  }
  return found;
}

function uid(proc: string, pid: string): string | null {
  try {
    for (const line of readFileSync(join(proc, pid, "status"), "utf8").split("\n")) {
      if (line.startsWith("Uid:")) return line.trim().split(/\s+/)[1] ?? null;
    }
  } catch {
    // gone or unreadable
  }
  return null;
}

function cmdline(proc: string, pid: string): string[] {
  try {
    return readFileSync(join(proc, pid, "cmdline"), "utf8").split("\0");
  } catch {
    return [];
  }
}

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  log.warning(message);
}

/** Ports the vendor daemons (snpslmd, ...) of an lmgrd listening on one of ``ports`` listen on.
 *  Only lmgrd's own children count, so no other local service is ever added. When lmgrd runs as
 *  another user its fds are unreadable, and a traced lmutil lmstat finds them instead; failing that,
 *  the warning says how to pin a vendor daemon's port. */
export async function licenseDaemonPorts(ports: Iterable<number>, proc: string | null = null): Promise<Set<number>> {
  const root = proc ?? places.proc;
  const wanted = new Set(ports);
  if (!wanted.size) return new Set();
  const listening = listeners(root);
  if (!listening.size) return new Set();
  const running = processes(root);
  const found = new Set<number>();
  const claimed = new Set<number>();
  const hidden = new Map<string, string>(); // pid -> uid of an lmgrd whose sockets cannot be read
  for (const [pid, [name]] of running) {
    if (name !== LICENSE_MANAGER) continue;
    let own: Set<number>;
    try {
      own = new Set([...sockets(root, pid)].filter((inode) => listening.has(inode)).map((inode) => listening.get(inode)![0]));
    } catch {
      const owner = uid(root, pid);
      if (owner !== null) hidden.set(pid, owner);
      continue;
    }
    if (![...own].some((port) => wanted.has(port))) continue;
    for (const port of own) claimed.add(port);
    for (const [child, [, parent]] of running) {
      if (parent !== pid) continue;
      try {
        for (const inode of sockets(root, child)) if (listening.has(inode)) found.add(listening.get(inode)![0]);
      } catch {
        warnOnce(`child:${child}`, `Cannot read the sockets of vendor daemon ${child}, so its port is not bridged into the sandbox. ` + PIN_ADVICE);
      }
    }
  }
  if (hidden.size) {
    const rest = new Set([...wanted].filter((port) => !claimed.has(port)));
    for (const port of await hiddenDaemonPorts(root, rest, hidden, new Set([...listening.values()].map(([port, owner]) => `${port}:${owner}`)))) {
      found.add(port);
    }
  }
  return found;
}

let probing: Promise<unknown> = Promise.resolve();

/** Vendor daemon ports of lmgrds whose sockets cannot be read: each listed port listening as one of
 *  their users is asked with a traced lmutil lmstat (one probe at a time). */
async function hiddenDaemonPorts(proc: string, wanted: Set<number>, hidden: Map<string, string>, listening: Set<string>): Promise<Set<number>> {
  const users = new Set(hidden.values());
  const pairs = [...listening].map((key) => key.split(":")).map(([port, owner]) => [Number(port), owner] as [number, string]);
  const candidates = [...new Set(pairs.filter(([port, owner]) => wanted.has(port) && users.has(owner)).map(([port]) => port))].sort((a, b) => a - b);
  if (!candidates.length) return new Set();
  const run = probing.then(async () => {
    const found = new Set<number>();
    for (const port of candidates) {
      const owner = pairs.find(([listened, user]) => listened === port && users.has(user))![1];
      const cached = probes.get(port);
      if (cached && monotonic() - cached[0] < timing.PROBE_TTL && [...cached[1]].every((item) => listening.has(`${item}:${owner}`))) {
        for (const item of cached[1]) found.add(item);
        continue;
      }
      const daemons = new Set([...await probe(port, lmutil(proc, hidden))].filter((item) => item !== port && listening.has(`${item}:${owner}`)));
      probes.set(port, [monotonic(), daemons]);
      if (!daemons.size) {
        warnOnce(`probe:${port}`, `Cannot read the sockets of the license server on port ${port} (lmgrd runs as another user), `
          + "and tracing lmutil lmstat (needs strace and lmutil) found no vendor daemon, so their "
          + "ports are not bridged into the sandbox. " + PIN_ADVICE);
      }
      for (const item of daemons) found.add(item);
    }
    return found;
  });
  probing = run.catch(() => undefined);
  return run;
}

/** shutil.which: the first executable named ``name`` on ``path``. */
export function which(name: string, path = process.env.PATH ?? ""): string | null {
  if (name.includes("/")) {
    try {
      accessSync(name, constants.X_OK);
      return statSync(name).isFile() ? name : null;
    } catch {
      return null;
    }
  }
  for (const folder of path.split(delimiter)) {
    if (!folder) continue;
    const candidate = join(folder, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/** lmutil on the commands' PATH, else next to lmgrd or its license file. */
function lmutil(proc: string, hidden: Map<string, string>): string | null {
  const folders = [commandEnv({ ...process.env } as Record<string, string>).PATH];
  for (const pid of hidden.keys()) {
    const args = cmdline(proc, pid);
    const files = args.length && args[0].startsWith("/") ? [args[0]] : [];
    for (let index = 0; index + 1 < args.length; index += 1) if (args[index] === "-c" && args[index + 1].startsWith("/")) files.push(args[index + 1]);
    for (const path of files) {
      const folder = dirname(path);
      folders.push(folder, dirname(folder));
    }
  }
  return which("lmutil", folders.join(delimiter));
}

/** Local ports lmutil lmstat -c <port>@localhost connects to, traced with strace: lmgrd answers it
 *  with its vendor daemons' ports. Runs on the host, never in a sandbox. */
function probe(port: number, lmutilPath: string | null): Promise<Set<number>> {
  const strace = which("strace");
  if (!strace || !lmutilPath) return Promise.resolve(new Set());
  return new Promise((done) => {
    let trace = "";
    let child;
    try {
      child = spawn(strace, ["-f", "-e", "trace=connect", lmutilPath, "lmstat", "-c", `${port}@localhost`],
        { stdio: ["ignore", "ignore", "pipe"], detached: true });
    } catch {
      done(new Set());
      return;
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // already gone
      }
    }, timing.PROBE_TIMEOUT * 1000);
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (trace += chunk));
    child.on("error", () => {
      clearTimeout(timer);
      done(new Set());
    });
    child.on("close", () => {
      clearTimeout(timer);
      const found = new Set<number>();
      for (const line of trace.split("\n")) {
        const match = CONNECT.exec(line);
        if (match && loopback(match[2] ?? match[3])) found.add(Number(match[1]));
      }
      done(found);
    });
  });
}

function loopback(address: string): boolean {
  return address.startsWith("127.") || address.startsWith("::ffff:127.") || address === "::1";
}

/** ``base`` with the tools folder on PATH and PYTHONPATH and the recorded variables. */
export function commandEnv(base: Record<string, string>): Record<string, string> {
  const root = toolsDir();
  const env = { ...base, ...recordedEnv() };
  env.PATH = `${join(root, "bin")}:${base.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`;
  env.PYTHONPATH = [join(root, "python"), base.PYTHONPATH].filter(Boolean).join(":");
  return env;
}

/** The scripts each step command sources first: the setting, then this machine's record. */
export function profiles(): string[] {
  const recorded = overrides().profiles;
  const listed = [...settings.sandbox_profiles, ...(Array.isArray(recorded) ? recorded : [])];
  return [...new Set(listed.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map(String))];
}

/** Source the configured profiles in the command's sandbox, with its sanitized environment; a
 *  missing one is skipped. A non-interactive bash does not read a profile itself. Keep
 *  initialization in the child shell: it must not run on the host or redirect the caller's
 *  stdout/stderr. */
export function shellSetup(): string {
  return profiles().map(shlexQuote).map((profile) => `if [ -r ${profile} ]; then . ${profile} || exit $?; fi\n`).join("");
}
