// How a capability's commands run (docs/design/capability-packages.md).
//
// As the steps' sandbox does, it hides the home folder and FluidForm's data. On top of that:
// - its folder is read-only, and its data folder is the only place it writes, besides its own /tmp;
// - it has no network of its own: the only way out is DomainProxy, a proxy in this process, bridged in
//   on a Unix socket, which lets a connection through only to a host the capability declared;
// - it gets only its own secrets, as environment variables.
import { type ChildProcess, spawn } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { connect, createServer, isIP, type Server, type Socket } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream";
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

/** Why capabilities' commands cannot run on this machine, or "" when they can. ``needsProxy`` may be
 *  false for local-only commands/services with no declared ``domains``. */
export function missing(needsProxy = true): string {
  const needed = needsProxy ? ["bwrap", "socat"] : ["bwrap"];
  const lacking = needed.filter((name) => !environment.which(name));
  return lacking.length ? `这台机器缺少 ${lacking.join("、")}，能力的环境和自动化运行不了。` : "";
}

/** Whether ``ip`` is a loopback, link-local/metadata, private, or non-unicast address that an external
 *  domain must never resolve to (DNS rebinding / SSRF protection). */
export function isPrivateOrReservedIp(ip: string): boolean {
  const clean = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (clean.startsWith("::ffff:")) {
    const tail = clean.slice(7);
    if (isIP(tail) === 4) return isPrivateOrReservedIp(tail);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return isPrivateOrReservedIp(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
    }
  }
  const version = isIP(clean);
  if (version === 4) {
    const [a, b] = clean.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (version === 6) {
    return clean === "::" || clean === "::1" || clean.startsWith("fc") || clean.startsWith("fd")
      || /^fe[89ab]/.test(clean) || clean.startsWith("ff") || clean.startsWith("100::") || clean.startsWith("2001:db8:");
  }
  return true;
}

/** Whether ``host`` is a valid external domain name (not an IP literal, localhost, or local suffix). */
export function isExternalDomain(given: string): boolean {
  const raw = given.toLowerCase().trim().replace(/\.+$/, "");
  const host = raw.startsWith("*.") ? raw.slice(2) : raw;
  if (!host || !host.includes(".") || isIP(host) !== 0) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host);
}

/** Whether ``host`` is one of ``domains`` (``*.example.com`` also covers its subdomains). */
export function allowed(given: string, domains: string[]): boolean {
  const host = given.toLowerCase().trim().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (isIP(host) !== 0) return false;
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
export function userProxy(host: string): [string, number, string | null] | null {
  const bypass = (process.env.NO_PROXY || process.env.no_proxy || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (bypass.some((item) => item === "*" || allowed(host, [item, "*." + item.replace(/^\.+/, "")]))) return null;
  const value = process.env.HTTPS_PROXY || process.env.https_proxy || "";
  if (!value) return null;
  try {
    const url = new URL(value.includes("://") ? value : `http://${value}`);
    const auth = url.username ? Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64") : null;
    return url.hostname && url.protocol === "http:" ? [url.hostname.replace(/^\[|\]$/g, ""), Number(url.port) || 80, auth] : null;
  } catch {
    return null;
  }
}

function pipe(from: Socket, to: Socket): void {
  pipeline(from, to, () => {
    from.destroy();
    to.destroy();
  });
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
    let early: Buffer = Buffer.alloc(0);
    try {
      [upstream, early] = await DomainProxy.openWithExtra(host, port);
      this.track(upstream);
    } catch (error) {
      this.log(`连不上 ${host}:${port}：${(error as Error).message}`);
      answer("502 Bad Gateway");
      return;
    }
    if (client.destroyed) {
      upstream.destroy();
      return;
    }
    client.write("HTTP/1.1 200 Connection established\r\n\r\n");
    if (early.length) client.write(early);
    if (rest.length) upstream.write(rest);
    pipe(client, upstream);
    pipe(upstream, client);
  }

  static async open(host: string, port: number): Promise<Socket> {
    return (await DomainProxy.openWithExtra(host, port))[0];
  }

  private static async openWithExtra(host: string, port: number): Promise<[Socket, Buffer]> {
    const through = userProxy(host);
    let targetHost = host;
    let targetFamily: 4 | 6 | undefined;
    if (!through && host.toLowerCase() !== "localhost") {
      const addresses = await dnsLookup(host, { all: true, verbatim: true });
      if (!addresses.length || addresses.some((entry) => isPrivateOrReservedIp(entry.address))) {
        throw new Error(`refused private or reserved address for ${host}`);
      }
      targetHost = addresses[0].address;
      targetFamily = addresses[0].family === 6 ? 6 : 4;
    }
    return new Promise<[Socket, Buffer]>((done, fail) => {
      const socket = connect(through ? { host: through[0], port: through[1] } : { host: targetHost, port, ...(targetFamily ? { family: targetFamily } : {}) });
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
          done([socket, Buffer.alloc(0)]);
          return;
        }
        const authHeader = through[2] ? `Proxy-Authorization: Basic ${through[2]}\r\n` : "";
        socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${authHeader}\r\n`);
        const read = await readHead(socket, UPSTREAM_TIMEOUT);
        clearTimeout(timer);
        const first = read ? read[0].toString("latin1").split("\r\n", 1)[0] : "no reply";
        if (!read || !first.includes(" 200")) {
          socket.destroy();
          fail(new Error(first));
          return;
        }
        socket.removeAllListeners("error");
        done([socket, read[1]]);
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

/** Read-only runtime directories under ``prefix`` safe to expose after ``hideHomes()``: never ``$HOME``
 *  itself or ``~/.local`` wholesale (which holds ``~/.local/share/keyrings`` and user data). */
export function safeRuntimeBinds(prefix: string): string[] {
  if (!prefix || prefix === "/" || prefix === "/usr") return [];
  const homes = new Set([homedir(), userInfo().homedir].filter(Boolean).map((p) => {
    try { return realpathSync(p); } catch { return p; }
  }));
  for (const home of homes) {
    if (prefix === home || prefix === join(home, ".local")) {
      return ["bin", "lib", "lib64", "include"].map((sub) => join(prefix, sub))
        .filter((dir) => existsSync(dir) && statSync(dir).isDirectory())
        .flatMap((dir) => ["--ro-bind", dir, dir]);
    }
  }
  return existsSync(prefix) && statSync(prefix).isDirectory() ? ["--ro-bind", prefix, prefix] : [];
}

/** The bwrap command running ``command`` in ``folder`` (writable only while it is installed). */
export function wrap(folder: string, data: string, command: string, env: Record<string, string>, proxyDir: string | null, writable = false): string[] {
  const [outer, inner, masked] = new Workspace(folder).platformData();
  // The interpreter its environment was built from, even when it lives in the hidden home.
  const interpreter = python();
  const prefix = interpreter ? dirname(dirname(interpreter)) : "/";
  const keepPython = safeRuntimeBinds(prefix);
  // And FluidForm's own Node, even when it lives in the hidden home (nvm, say).
  const node = dirname(dirname(realpathSync(process.execPath)));
  const keepNode = node !== prefix ? safeRuntimeBinds(node) : [];
  const bridge = proxyDir ? ["--bind", proxyDir, SANDBOX_PORTS_DIR] : [];
  return [
    "bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", ...bridge,
    ...hideHomes(), ...keepPython, ...keepNode, ...outer,
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
    child.stdin?.on("error", () => undefined);
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
