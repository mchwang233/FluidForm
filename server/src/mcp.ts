// Tools from MCP servers (settings.mcp_servers), for the API models' Workspace.
//
// A server is either
// - a command speaking the Model Context Protocol over stdio (newline-delimited JSON-RPC): it runs
//   inside the step's own sandbox, as a Bash command would (the same folder, the same network or
//   none, nothing of the user's home), started for each call and stopped after it; or
// - a remote one (``url``, https, the protocol's Streamable HTTP): FluidForm itself asks it, so its
//   tools are offered only to a step or chat allowed the internet anyway (as a web search is).
// What tools it has is asked once and kept (LISTED). Its secrets come from the keyring as
// capability/mcp-<server>/<VARIABLE>: a command gets them as its environment, never on a command
// line; a remote server's ``headers`` name them as ${VARIABLE}. A key FluidForm already keeps (a
// provider's API key such as ZHIPU_API_KEY, the GitHub token) may be named too, without storing it
// again. A command server's ``env`` holds its plain settings. ``tools``: only these of its tools. ``price_usd``: what one call costs, charged to the call's
// budget as a picture or a search is. A server's tool is offered as mcp__<server>__<tool>.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, openSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { Workspace } from "./agent.js";
import { settings } from "./config.js";
import { log } from "./log.js";
import { head, isObject, pyDumps, pyStr, shlexJoin } from "./py.js";
import { getSecret } from "./secrets.js";
import { SECRET_ENV } from "./secret-names.js";

export const PROTOCOL = "2025-06-18";
const SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
export const PREFIX = "mcp__";
export const CALL_SECONDS = 120;
export const LIST_SECONDS = 60;
// A server whose tools could not be listed is not tried again for this long.
export const RETRY_SECONDS = 300;
export const MAX_OUTPUT = 30_000;
export const MAX_TOOLS = 40;

type Spec = Record<string, any>;
type Definition = { name: string; mcp_tool: string; description: string; parameters: Record<string, unknown> };
// [server, its spec] -> [when, its tool definitions or null when listing failed].
export const LISTED = new Map<string, [number, Definition[] | null]>();
const keyOf = (server: string, spec: Spec) => JSON.stringify([server, pyDumps(spec, true, true)]);
const monotonic = () => performance.now() / 1000;

export class MCPError extends Error {
  override name = "MCPError";
}

/** Whether ``spec`` is a remote server (``url``) rather than a command. */
export const remote = (spec: Spec) => typeof spec.url === "string";

/** The configured servers that can run: a valid name, and an argv command or an https url. */
export function servers(): Record<string, Spec> {
  const found: Record<string, Spec> = {};
  for (const [name, spec] of Object.entries(settings.mcp_servers ?? {})) {
    const command = isObject(spec) ? spec.command : null;
    const url = isObject(spec) ? spec.url : null;
    const runs = Array.isArray(command) && command.length > 0 && command.every((item) => typeof item === "string" && item);
    const reaches = typeof url === "string" && /^https:\/\/[^\s/]+/.test(url) && (spec.headers === undefined || isObject(spec.headers));
    if (!SERVER_NAME.test(name) || runs === reaches) {
      log.warning(`MCP server '${name}' is not set up right: it needs a lowercase name and an argv command or an https url`);
      continue;
    }
    found[name] = spec as Spec;
  }
  return found;
}

/** The servers that make pictures (``makes_images``), for steps that must make pictures. */
export function imageServers(): string[] {
  return Object.entries(servers()).filter(([, spec]) => spec.makes_images === true).map(([name]) => name);
}

export function toolName(server: string, tool: string): string {
  return (PREFIX + server.replaceAll("-", "_") + "__" + tool.replace(/[^A-Za-z0-9_-]/g, "_")).slice(0, 64);
}

/** A key FluidForm already keeps (a provider's API key, the GitHub token): a server may be given it
 *  under its own name, so it is not stored twice. */
const KEPT = new Set(Object.values(SECRET_ENV));

export async function secretsFor(server: string, spec: Spec): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const variable of Array.isArray(spec.secrets) ? spec.secrets : []) {
    if (typeof variable === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
      const value = await getSecret(`capability/mcp-${server}/${variable}`) ?? (KEPT.has(variable) ? process.env[variable] : undefined);
      if (value) found[variable] = value;
    }
  }
  return found;
}

/** A command server's plain settings (``env``: region, output folder...), never its secrets. */
export function plainEnv(spec: Spec): Record<string, string> {
  return Object.fromEntries(Object.entries(isObject(spec.env) ? spec.env : {})
    .filter(([name, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof value === "string")) as Record<string, string>;
}

/** A remote server's headers, each ${VARIABLE} its secret (or a provider's API key); null when one
 *  is not stored, so the server is not asked without it. */
export async function headersFor(server: string, spec: Spec): Promise<Record<string, string> | null> {
  const secrets = await deps.secretsFor(server, spec);
  const headers: Record<string, string> = {};
  for (const [name, template] of Object.entries(isObject(spec.headers) ? spec.headers : {})) {
    let missing = false;
    headers[name] = String(template).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, variable: string) => {
      const value = secrets[variable] ?? (KEPT.has(variable) ? process.env[variable] : undefined);
      if (!value) missing = true;
      return value ?? "";
    });
    if (missing) return null;
  }
  return headers;
}

// What tests replace: the secrets a server gets, and how a remote one is asked.
export const deps = { secretsFor: (server: string, spec: Spec) => secretsFor(server, spec), fetch: (input: string, init: RequestInit) => fetch(input, init) };

/** One running server in a workspace's sandbox, spoken to over real pipes (FIFOs): a pipe Node makes
 *  is a socket pair, whose data pasta loses (see Workspace.bash). */
export class Session {
  private process: ChildProcess | null = null;
  private nextId = 0;
  private folder: string | null = null;
  private input: Socket | null = null;
  private output: Socket | null = null;
  private buffered = "";
  private waiting: ((line: string | null) => void) | null = null;
  private lines: (string | null)[] = [];

  constructor(readonly workspace: Workspace, readonly server: string, readonly spec: Spec) {}

  private static fifo(path: string): void {
    const made = spawnSync("mkfifo", ["-m", "600", path]);
    if (made.error || made.status !== 0) throw new MCPError("cannot make a pipe for the server (mkfifo)");
  }

  async open(): Promise<this> {
    const { SANDBOX_PORTS_DIR, withoutEnvArgs } = await import("./agent.js");
    const command = shlexJoin(this.spec.command as string[]);
    this.folder = mkdtempSync(join(tmpdir(), "sp-mcp-"));
    const toServer = join(this.folder, "in");
    const fromServer = join(this.folder, "out");
    Session.fifo(toServer);
    Session.fifo(fromServer);
    // pasta (a sandbox allowed the internet) gives its command /null for a stdin that is a pipe, so
    // there the pipes' folder is mounted in and the server is pointed at them by path.
    const byPath = this.workspace.network;
    const inner = byPath ? `exec ${command} <${SANDBOX_PORTS_DIR}/in >${SANDBOX_PORTS_DIR}/out` : `exec ${command}`;
    const [args, env] = withoutEnvArgs(this.workspace.sandboxArgs(inner, byPath ? this.folder : null));
    Object.assign(env, plainEnv(this.spec), await deps.secretsFor(this.server, this.spec));
    // Opened both ways, so neither open waits for the other end.
    const inFd = openSync(toServer, "r+");
    const outFd = openSync(fromServer, "r+");
    this.process = spawn(args[0], args.slice(1), { env, stdio: byPath ? ["ignore", "ignore", "ignore"] : [inFd, outFd, "ignore"], detached: true });
    this.process.on("error", () => this.push(null));
    this.process.on("exit", () => this.push(null));
    this.input = new Socket({ fd: inFd, readable: false, writable: true });
    this.output = new Socket({ fd: outFd, readable: true, writable: false });
    this.input.on("error", () => undefined);
    this.output.on("error", () => this.push(null));
    this.output.setEncoding("utf8").on("data", (chunk: string) => {
      this.buffered += chunk;
      for (let at = this.buffered.indexOf("\n"); at >= 0; at = this.buffered.indexOf("\n")) {
        this.push(this.buffered.slice(0, at));
        this.buffered = this.buffered.slice(at + 1);
      }
    });
    await this.request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "FluidForm", version: "1" } });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return this;
  }

  private push(line: string | null): void {
    if (this.waiting) {
      const wake = this.waiting;
      this.waiting = null;
      wake(line);
    } else this.lines.push(line);
  }

  private readline(): Promise<string | null> {
    if (this.lines.length) return Promise.resolve(this.lines.shift()!);
    return new Promise((resolve) => (this.waiting = resolve));
  }

  close(): void {
    this.input?.destroy();
    this.output?.destroy();
    if (this.process && this.process.exitCode === null) {
      try {
        process.kill(-this.process.pid!, "SIGKILL");
      } catch {
        // already gone
      }
    }
    if (this.folder) rmSync(this.folder, { recursive: true, force: true });
  }

  send(message: Record<string, unknown>): void {
    if (!this.input || this.input.destroyed) throw new MCPError("the server stopped");
    this.input.write(pyDumps(message, false) + "\n");
  }

  async request(method: string, params: Record<string, unknown>): Promise<Record<string, any>> {
    this.nextId += 1;
    const asked = this.nextId;
    this.send({ jsonrpc: "2.0", id: asked, method, params });
    for (;;) {
      const line = await this.readline();
      if (line === null) throw new MCPError("the server stopped before answering");
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // a server printing something else on stdout
      }
      if (!isObject(message)) continue;
      if ("method" in message && "id" in message) {
        // The server asking us something (ping, sampling...): only ping is answered.
        const reply = message.method === "ping" ? { result: {} } : { error: { code: -32601, message: "not supported by FluidForm" } };
        this.send({ jsonrpc: "2.0", id: message.id, ...reply });
        continue;
      }
      if (message.id !== asked) continue; // a notification
      if ("error" in message) {
        const error = message.error;
        throw new MCPError(head(pyStr(isObject(error) ? error.message : error), 500));
      }
      return (message.result || {}) as Record<string, any>;
    }
  }
}

/** A remote server, asked over the protocol's Streamable HTTP: each message a POST, the answer as
 *  JSON or as server-sent events; its session id, once given, sent with every later message. */
export class RemoteSession {
  private nextId = 0;
  private sessionId: string | null = null;
  private headers: Record<string, string> = {};
  private readonly abort = new AbortController();

  constructor(readonly server: string, readonly spec: Spec) {}

  async open(): Promise<this> {
    const headers = await headersFor(this.server, this.spec);
    if (!headers) throw new MCPError("its key is not stored (see the secrets of its settings)");
    this.headers = headers;
    await this.request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "FluidForm", version: "1" } });
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    return this;
  }

  private async post(message: Record<string, unknown>): Promise<Response> {
    const response = await deps.fetch(this.spec.url as string, { method: "POST", signal: this.abort.signal, body: pyDumps(message, false),
      headers: { ...this.headers, "content-type": "application/json", accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL, ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}) } });
    if (!response.ok) throw new MCPError(`it answered HTTP ${response.status}: ${head(await response.text().catch(() => ""), 300)}`);
    this.sessionId = response.headers.get("mcp-session-id") ?? this.sessionId;
    return response;
  }

  async request(method: string, params: Record<string, unknown>): Promise<Record<string, any>> {
    this.nextId += 1;
    const asked = this.nextId;
    const response = await this.post({ jsonrpc: "2.0", id: asked, method, params });
    const body = await response.text();
    const messages = (response.headers.get("content-type") ?? "").includes("text/event-stream")
      ? body.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim())
      : [body];
    for (const raw of messages) {
      let message: unknown;
      try {
        message = JSON.parse(raw);
      } catch {
        continue;
      }
      for (const item of Array.isArray(message) ? message : [message]) {
        if (!isObject(item) || item.id !== asked) continue;
        if ("error" in item) throw new MCPError(head(pyStr(isObject(item.error) ? item.error.message : item.error), 500));
        return (item.result || {}) as Record<string, any>;
      }
    }
    throw new MCPError("it gave no answer");
  }

  close(): void {
    this.abort.abort();
  }
}

async function withSession<T>(workspace: Workspace, server: string, spec: Spec, seconds: number, work: (session: Session | RemoteSession) => Promise<T>): Promise<T> {
  const session = remote(spec) ? new RemoteSession(server, spec) : new Session(workspace, server, spec);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      session.open().then(work),
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new TimeoutError()), seconds * 1000))),
    ]);
  } finally {
    clearTimeout(timer);
    session.close();
  }
}

class TimeoutError extends Error {
  override name = "TimeoutError";
}

function definition(server: string, tool: unknown): Definition | null {
  const name = isObject(tool) ? tool.name : null;
  if (typeof name !== "string" || !name) return null;
  let schema = (tool as Record<string, unknown>).inputSchema;
  if (!isObject(schema) || schema.type !== "object") schema = { type: "object", properties: {} };
  return { name: toolName(server, name), mcp_tool: name, description: `[${server}] ` + head(pyStr((tool as Record<string, unknown>).description || name), 1000),
    parameters: schema as Record<string, unknown> };
}

/** The servers' tools for a workspace that may act (not a reviewer, not a host repair). */
export async function definitions(workspace: Workspace): Promise<Omit<Definition, "mcp_tool">[]> {
  if (workspace.readOnly || workspace.host) return [];
  const found: Omit<Definition, "mcp_tool">[] = [];
  for (const [server, spec] of Object.entries(servers())) {
    // FluidForm asks a remote server itself: only for work allowed the internet anyway.
    if (remote(spec) && !workspace.network) continue;
    const key = keyOf(server, spec);
    let [when, tools] = LISTED.get(key) ?? [0, null];
    if (!when || (tools === null && monotonic() - when > RETRY_SECONDS)) {
      try {
        const listed = await withSession(workspace, server, spec, LIST_SECONDS, (session) => session.request("tools/list", {}));
        // ``tools``: only the ones named are offered (a server with tools that cost money unasked).
        const wanted = Array.isArray(spec.tools) ? new Set(spec.tools.filter((item: unknown) => typeof item === "string")) : null;
        tools = (Array.isArray(listed.tools) ? listed.tools : []).map((tool: unknown) => definition(server, tool))
          .filter((item: Definition | null): item is Definition => item !== null && (!wanted || wanted.has(item.mcp_tool))).slice(0, MAX_TOOLS);
      } catch (error) {
        log.warning(`listing MCP server ${server}'s tools failed: ${(error as Error).message ?? error}`);
        tools = null;
      }
      when = monotonic();
      LISTED.set(key, [when, tools]);
    }
    found.push(...(tools ?? []).map(({ mcp_tool: _, ...rest }) => rest));
  }
  return found;
}

/** The server, its spec and its own tool name for an offered tool name. */
export function owner(name: string): [string, Spec, string] | null {
  for (const [server, spec] of Object.entries(servers())) {
    const [, tools] = LISTED.get(keyOf(server, spec)) ?? [0, null];
    const tool = (tools ?? []).find((item) => item.name === name);
    if (tool) return [server, spec, tool.mcp_tool];
  }
  return null;
}

export function text(result: Record<string, any>): string {
  const parts: string[] = [];
  for (const item of Array.isArray(result.content) ? result.content : []) {
    if (!isObject(item)) continue;
    if (item.type === "text") parts.push(pyStr(item.text || ""));
    else if (item.type === "resource" && isObject(item.resource)) parts.push(pyStr(item.resource.text || `(resource ${pyStr(item.resource.uri ?? "")})`));
    else parts.push(`(${pyStr(item.type ?? "content")} not shown)`);
  }
  if (!parts.length && result.structuredContent !== undefined && result.structuredContent !== null) parts.push(pyDumps(result.structuredContent, false));
  const joined = parts.join("\n").trim() || "(the tool returned nothing)";
  return joined.length <= MAX_OUTPUT ? joined : head(joined, MAX_OUTPUT) + "\n...(cut)";
}

/** Run one MCP tool in the workspace's sandbox: its output, and whether it went through. */
export async function call(workspace: Workspace, name: string, args: Record<string, unknown>): Promise<[string, boolean]> {
  const found = owner(name);
  if (!found) return [`Error: unknown tool ${name}`, false];
  const [server, spec, tool] = found;
  if (remote(spec) && !workspace.network) return [`Error: ${server} needs the internet, which this task does not allow`, false];
  const price = typeof spec.price_usd === "number" && spec.price_usd > 0 ? spec.price_usd : 0;
  if (price && workspace.budget?.canSpend && !workspace.budget.canSpend(price)) return [`Error: the budget left cannot pay for ${server} (about $${price})`, false];
  const seconds = typeof spec.timeout === "number" ? spec.timeout : CALL_SECONDS;
  try {
    const result = await withSession(workspace, server, spec, Math.max(1, Math.min(seconds, 600)),
      (session) => session.request("tools/call", { name: tool, arguments: args }));
    if (price && workspace.budget?.recordUsd) await workspace.budget.recordUsd(price);
    return [text(result), !result.isError];
  } catch (error) {
    if (error instanceof TimeoutError) return [`Error: ${server} did not answer within ${seconds}s`, false];
    return [`Error: ${server}: ${(error as Error).message ?? error}`, false];
  }
}
