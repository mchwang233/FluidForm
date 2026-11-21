// How a capability's commands run (docs/design/capability-packages.md).
//
// As the steps' sandbox does, it hides the home folder and Super Partner's data. On top of that:
// - its folder is read-only, and its data folder is the only place it writes, besides its own /tmp;
// - it has no network of its own: the only way out is DomainProxy, a proxy in this process, bridged in
//   on a Unix socket, which lets a connection through only to a host the capability declared;
// - it gets only its own secrets, as environment variables.
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hideHomes, listenScript, SANDBOX_PORTS_DIR, withoutEnvArgs, Workspace } from "./agent.js";
import { settings } from "./config.js";
import * as environment from "./environment.js";
import { formatG } from "./py.js";

// The proxy's port inside the sandbox, which has a network of its own (only loopback).
export const PROXY_PORT = 8118;
export const ALLOWED_PORTS = new Set([80, 443]);
// Package indexes pip may reach when it builds a capability's environment.
export const PACKAGE_INDEXES = ["pypi.org", "files.pythonhosted.org"];
export const HEAD_LIMIT = 16 * 1024;
export const UPSTREAM_TIMEOUT = 20;

type Log = (line: string) => void;

/** Why capabilities' commands cannot run on this machine, or "" when they can. */
export function missing(): string {
  const lacking = ["bwrap", "socat"].filter((name) => !environment.which(name));
  return lacking.length ? `这台机器缺少 ${lacking.join("、")}，能力的环境和自动化运行不了。` : "";
}

/** Whether ``host`` is one of ``domains`` (``*.example.com`` also covers its subdomains). */
export function allowed(given: string, domains: string[]): boolean {
  const host = given.toLowerCase().trim().replace(/\.+$/, "");
  for (const raw of domains) {
    const item = raw.toLowerCase().trim().replace(/\.+$/, "");
    const base = item.startsWith("*.") ? item.slice(2) : item;
    if (base && (host === base || (item.startsWith("*.") && host.endsWith("." + base)))) return true;
  }
  return false;
}

function hostname(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** Where pip finds packages: PyPI, and any index this machine set for the sandbox. */
export function indexHosts(): string[] {
  const hosts = [...PACKAGE_INDEXES];
  for (const name of ["PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL"]) {
    for (const url of (process.env[name] ?? "").split(/\s+/).filter(Boolean)) {
      const host = hostname(url);
      if (host) hosts.push(host);
    }
  }
  return hosts;
}

/** The user's own HTTPS proxy, which connections go through when this machine has one. */
export function userProxy(host: string): [string, number] | null {
  const bypass = (process.env.NO_PROXY || process.env.no_proxy || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (bypass.some((item) => allowed(host, [item, "*." + item.replace(/^\.+/, "")]))) return null;
  const value = process.env.HTTPS_PROXY || process.env.https_proxy || "";
  if (!value) return null;
  try {
    const url = new URL(value.includes("://") ? value : `http://${value}`);
    return url.hostname && url.protocol === "http:" ? [url.hostname.replace(/^\[|\]$/g, ""), Number(url.port) || 80] : null;
  } catch {
    return null;
  }
}

function pipe(from: Socket, to: Socket): void {
  from.on("data", (data) => to.write(data));
  from.on("end", () => to.end());
  from.on("error", () => to.destroy());
  to.on("error", () => from.destroy());
}

/** Reads until the end of the request head; null when the client went away or took too long. */
function readHead(socket: Socket, seconds: number): Promise<[Buffer, Buffer] | null> {
  return new Promise((done) => {
    let buffered = Buffer.alloc(0);
    const finish = (value: [Buffer, Buffer] | null) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onEnd);
      done(value);
    };
    const onData = (data: Buffer) => {
      buffered = Buffer.concat([buffered, data]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end >= 0) finish([buffered.subarray(0, end + 4), buffered.subarray(end + 4)]);
      else if (buffered.length > HEAD_LIMIT * 4) finish(null);
    };
    const onEnd = () => finish(null);
    const timer = setTimeout(() => finish(null), seconds * 1000);
    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("error", onEnd);
  });
}

/** An HTTP CONNECT proxy on a Unix socket that reaches only ``domains``. ``folder`` is then what to
 *  mount at the sandbox's ports folder; ``close()`` when done. */
export class DomainProxy {
  folder: string | null = null;
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(readonly domains: string[], readonly log: Log) {}

  async open(): Promise<this> {
    // Under /tmp, not a possibly long TMPDIR: Unix socket paths are limited to about 107 bytes.
    this.folder = mkdtempSync(join(existsSync("/tmp") && statSync("/tmp").isDirectory() ? "/tmp" : tmpdir(), "sp-cap-"));
    const path = `${this.folder}/${PROXY_PORT}.sock`;
    this.server = createServer((socket) => void this.serve(socket));
    await new Promise<void>((done, fail) => {
      this.server!.once("error", fail);
      this.server!.listen(path, () => done());
    });
    chmodSync(path, 0o600);
    return this;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    if (this.server) await new Promise<void>((done) => this.server!.close(() => done()));
    if (this.folder) rmSync(this.folder, { recursive: true, force: true });
  }

  private track(socket: Socket): Socket {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    return socket;
  }

  private async serve(client: Socket): Promise<void> {
    this.track(client);
    const answer = (status: string) => client.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    const read = await readHead(client, UPSTREAM_TIMEOUT);
    if (!read) {
      client.destroy();
      return;
    }
    const [head, rest] = read;
    const parts = head.subarray(0, HEAD_LIMIT).toString("latin1").split("\r\n", 1)[0].split(/\s+/).filter(Boolean);
    if (parts.length !== 3 || parts[0].toUpperCase() !== "CONNECT") {
      answer("405 Method Not Allowed");
      return;
    }
    const split = parts[1].lastIndexOf(":");
    const host = (split >= 0 ? parts[1].slice(0, split) : "").replace(/^\[|\]$/g, "");
    const portText = split >= 0 ? parts[1].slice(split + 1) : "";
    const port = /^\d+$/.test(portText) ? Number(portText) : 0;
    if (!ALLOWED_PORTS.has(port) || !allowed(host, this.domains)) {
      this.log(`拦下了访问 ${host}:${port}：不在它声明的域名里。`);
      answer("403 Forbidden");
      return;
    }
    let upstream: Socket;
    try {
      upstream = this.track(await DomainProxy.open(host, port));
    } catch (error) {
      this.log(`连不上 ${host}:${port}：${(error as Error).message}`);
      answer("502 Bad Gateway");
      return;
    }
    client.write("HTTP/1.1 200 Connection established\r\n\r\n");
    if (rest.length) upstream.write(rest);
    pipe(client, upstream);
    pipe(upstream, client);
  }

  static open(host: string, port: number): Promise<Socket> {
    const through = userProxy(host);
    return new Promise<Socket>((done, fail) => {
      const socket = connect(through ? { host: through[0], port: through[1] } : { host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        fail(new Error("timed out"));
      }, UPSTREAM_TIMEOUT * 1000);
      socket.once("error", (error) => {
        clearTimeout(timer);
        fail(error);
      });
      socket.once("connect", async () => {
        if (!through) {
          clearTimeout(timer);
          socket.removeAllListeners("error");
          done(socket);
          return;
        }
        socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
        const read = await readHead(socket, UPSTREAM_TIMEOUT);
        clearTimeout(timer);
        const first = read ? read[0].toString("latin1").split("\r\n", 1)[0] : "no reply";
        if (!read || !first.includes(" 200")) {
          socket.destroy();
          fail(new Error(first));
          return;
        }
        socket.removeAllListeners("error");
        done(socket);
      });
    });
  }
}

export function environmentFor(folder: string, data: string, secrets: Record<string, string>, proxied: boolean): Record<string, string> {
  // The Node FluidForm runs on comes first after the package's own environment: service packages
  // written for Node (packages/pricing) run on it.
  let env: Record<string, string> = { PATH: `${folder}/.venv/bin:${dirname(realpathSync(process.execPath))}:/usr/local/bin:/usr/bin:/bin` };
  for (const name of settings.sandbox_env) if (process.env[name] !== undefined) env[name] = process.env[name]!;
  env = environment.commandEnv(env);
  Object.assign(env, { HOME: "/tmp", TMPDIR: "/tmp", LANG: "C.UTF-8", PYTHONUNBUFFERED: "1", SP_CAPABILITY_DIR: folder, SP_DATA_DIR: data });
  if (proxied) {
    const proxy = `http://127.0.0.1:${PROXY_PORT}`;
    Object.assign(env, { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, ALL_PROXY: proxy, all_proxy: proxy, NO_PROXY: "", no_proxy: "" });
  }
  return Object.assign(env, secrets);
}

/** The Python a capability's environment is built from (capability_packages.build), or null. */
export function python(): string | null {
  const found = environment.which("python3");
  try {
    return found ? realpathSync(found) : null;
  } catch {
    return found;
  }
}

/** The bwrap command running ``command`` in ``folder`` (writable only while it is installed). */
export function wrap(folder: string, data: string, command: string, env: Record<string, string>, proxyDir: string | null, writable = false): string[] {
  const [outer, inner, masked] = new Workspace(folder).platformData();
  // The interpreter its environment was built from, even when it lives in the hidden home.
  const interpreter = python();
  const prefix = interpreter ? dirname(dirname(interpreter)) : "/";
  const keepPython = prefix !== "/" ? ["--ro-bind", prefix, prefix] : [];
  // And FluidForm's own Node, even when it lives in the hidden home (nvm, say).
  const node = dirname(dirname(realpathSync(process.execPath)));
  const keepNode = node !== "/" && node !== "/usr" && node !== prefix ? ["--ro-bind", node, node] : [];
  const bridge = proxyDir ? ["--bind", proxyDir, SANDBOX_PORTS_DIR] : [];
  return [
    "bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", ...bridge,
    ...hideHomes(), ...outer, ...keepPython, ...keepNode,
    writable ? "--bind" : "--ro-bind", folder, folder, ...inner, ...masked,
    "--bind", data, data,
    "--unshare-net", "--unshare-pid", "--die-with-parent", "--new-session",
    "--clearenv", ...Object.entries(env).flatMap(([name, value]) => ["--setenv", name, value]),
    "--chdir", folder, "--", "/bin/bash", "-c",
    listenScript(proxyDir ? [PROXY_PORT] : []) + 'eval "$1"', "bash", command,
  ];
}

export type Launch = { secrets?: Record<string, string>; domains?: string[]; log?: Log; writable?: boolean;
  stdio?: ["ignore" | "pipe", "pipe" | number, "pipe" | number] };

/** What tests replace (Python's monkeypatch): whether the sandbox can run here, how a command is wrapped,
 *  and running one to its end. */
export const deps = { missing, wrap, run: (...args: Parameters<typeof run>) => run(...args) };

/** Stop all of ``child`` (its process group): TERM, then KILL after five seconds. */
export async function stopGroup(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  const late = await Promise.race([exited.then(() => false), new Promise<boolean>((done) => (timer = setTimeout(() => done(true), 5000)))]);
  clearTimeout(timer);
  if (late) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // gone already
    }
    await exited;
  }
}

/** Start ``command`` in the sandbox, reaching only ``domains``, and run ``work`` with the process;
 *  the process is stopped (all of it) when ``work`` ends. */
export async function launched<T>(folder: string, data: string, command: string, work: (child: ChildProcess) => Promise<T>,
  { secrets = {}, domains = [], log = () => undefined, writable = false, stdio = ["ignore", "pipe", "pipe"] }: Launch = {}): Promise<T> {
  mkdirSync(data, { recursive: true });
  const proxy = domains.length ? await new DomainProxy(domains, log).open() : null;
  try {
    const env = environmentFor(folder, data, secrets, Boolean(proxy));
    // Its secrets reach it as its environment, never on a command line others can read.
    const [args, given] = withoutEnvArgs(deps.wrap(folder, data, command, env, proxy ? proxy.folder : null, writable));
    const child = spawn(args[0], args.slice(1), { env: given, stdio, detached: true });
    child.on("error", () => undefined);
    try {
      return await work(child);
    } finally {
      await stopGroup(child);
    }
  } finally {
    await proxy?.close();
  }
}

/** Run a command to its end (building an environment, a check): its output, and whether it passed. */
export async function run(folder: string, data: string, command: string, timeout: number,
  { domains = [], writable = false, log = () => undefined }: { domains?: string[]; writable?: boolean; log?: Log } = {}): Promise<[string, boolean]> {
  const chunks: Buffer[] = [];
  let timedOut = false;
  let code: number | null = null;
  await launched(folder, data, command, async (child) => {
    child.stdout?.on("data", (data: Buffer) => chunks.push(data));
    child.stderr?.on("data", (data: Buffer) => chunks.push(data));
    const exited = new Promise<number | null>((done) => {
      child.once("close", (status) => done(status));
      child.once("error", () => done(null));
    });
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([exited, new Promise<"late">((done) => (timer = setTimeout(() => done("late"), timeout * 1000)))]);
    clearTimeout(timer);
    if (result === "late") timedOut = true;
    else code = result;
  }, { domains, writable, log });
  const output = Buffer.concat(chunks).toString("utf8").trim();
  if (timedOut) return [`超过 ${formatG(timeout)} 秒没有结束，已停止。\n${output}`, false];
  return [output, code === 0];
}
