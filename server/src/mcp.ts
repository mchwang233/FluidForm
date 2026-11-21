// Tools from MCP servers (settings.mcp_servers), for the API models' Workspace.
//
// Each server is a command speaking the Model Context Protocol over stdio (newline-delimited
// JSON-RPC). It runs inside the step's own sandbox, as a Bash command would: the same folder, the
// same network or none, nothing of the user's home. A server is started for each call and stopped
// after it; what tools it has is asked once and kept (LISTED). Its secrets come from the keyring as
// capability/mcp-<server>/<VARIABLE>, given as its environment, never on a command line.
// A server's tool is offered as mcp__<server>__<tool>.
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

/** The configured servers that can run: a valid name and an argv command. */
export function servers(): Record<string, Spec> {
  const found: Record<string, Spec> = {};
  for (const [name, spec] of Object.entries(settings.mcp_servers ?? {})) {
    const command = isObject(spec) ? spec.command : null;
    if (!SERVER_NAME.test(name) || !Array.isArray(command) || !command.length || !command.every((item) => typeof item === "string" && item)) {
      log.warning(`MCP server '${name}' is not set up right: it needs a lowercase name and an argv command`);
      continue;
    }
    found[name] = spec as Spec;
  }
  return found;
}

export function toolName(server: string, tool: string): string {
  return (PREFIX + server.replaceAll("-", "_") + "__" + tool.replace(/[^A-Za-z0-9_-]/g, "_")).slice(0, 64);
}

export async function secretsFor(server: string, spec: Spec): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const variable of Array.isArray(spec.secrets) ? spec.secrets : []) {
    if (typeof variable === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
      const value = await getSecret(`capability/mcp-${server}/${variable}`);
      if (value) found[variable] = value;
    }
  }
  return found;
}

// What tests replace: the secrets a server gets.
export const deps = { secretsFor: (server: string, spec: Spec) => secretsFor(server, spec) };

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
    const { withoutEnvArgs } = await import("./agent.js");
    const command = shlexJoin(this.spec.command as string[]);
    const [args, env] = withoutEnvArgs(this.workspace.sandboxArgs(`exec ${command}`));
    Object.assign(env, await deps.secretsFor(this.server, this.spec));
    this.folder = mkdtempSync(join(tmpdir(), "sp-mcp-"));
    const toServer = join(this.folder, "in");
    const fromServer = join(this.folder, "out");
    Session.fifo(toServer);
    Session.fifo(fromServer);
    // Opened both ways, so neither open waits for the other end.
    const inFd = openSync(toServer, "r+");
    const outFd = openSync(fromServer, "r+");
    this.process = spawn(args[0], args.slice(1), { env, stdio: [inFd, outFd, "ignore"], detached: true });
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

async function withSession<T>(workspace: Workspace, server: string, spec: Spec, seconds: number, work: (session: Session) => Promise<T>): Promise<T> {
  const session = new Session(workspace, server, spec);
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
    const key = keyOf(server, spec);
    let [when, tools] = LISTED.get(key) ?? [0, null];
    if (!when || (tools === null && monotonic() - when > RETRY_SECONDS)) {
      try {
        const listed = await withSession(workspace, server, spec, LIST_SECONDS, (session) => session.request("tools/list", {}));
        tools = (Array.isArray(listed.tools) ? listed.tools : []).map((tool: unknown) => definition(server, tool))
          .filter((item: Definition | null): item is Definition => item !== null).slice(0, MAX_TOOLS);
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
  const seconds = typeof spec.timeout === "number" ? spec.timeout : CALL_SECONDS;
  try {
    const result = await withSession(workspace, server, spec, Math.max(1, Math.min(seconds, 600)),
      (session) => session.request("tools/call", { name: tool, arguments: args }));
    return [text(result), !result.isError];
  } catch (error) {
    if (error instanceof TimeoutError) return [`Error: ${server} did not answer within ${seconds}s`, false];
    return [`Error: ${server}: ${(error as Error).message ?? error}`, false];
  }
}
