// Service packages: capabilities FluidForm itself uses, each from a package that can be uploaded and
// removed (docs/design/chat-and-pricing-packages.md). A service runs as a process in the capabilities'
// sandbox (capability-sandbox.ts), as an automation does, and speaks JSON-RPC 2.0 over stdin and
// stdout, one message a line, both ways (as MCP does): FluidForm asks it (``request``), and it asks
// FluidForm (the handlers given with ``handle``), which does what needs a key or this machine, so a
// service never gets one. A notification ``status`` sets the text its card shows; what it writes on
// stderr goes to its log.
//
// ``provides`` names what a service gives ("chat", "pricing"); ``requires``, in any package, what must
// be there before it is enabled. Until a capability's package is written, FluidForm itself provides it
// (``builtIn``).
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import * as capabilities from "./capabilities.js";
import * as packages from "./capability-packages.js";
import { limits, readLines } from "./capability-runner.js";
import * as sandbox from "./capability-sandbox.js";
import { log } from "./log.js";
import type { Capability } from "./models.js";
import { pyDumps } from "./py.js";
import { LABELS, PROVIDABLE } from "./service-names.js";
import { sleep, Task } from "./tasks.js";

type Json = Record<string, any>;

// What FluidForm still does itself, until a package takes it over.
export const builtIn = new Set<string>();
// How long FluidForm waits for a service's answer, unless the request says otherwise.
export const REQUEST_SECONDS = 30;
// How long a request waits for a service still starting (FluidForm itself just started, say).
export const STARTING_SECONDS = 20;
export const LOG_LINES = 200;

export class ServiceError extends Error {
  override name = "ServiceError";
}

let kept: { key: string; library: Capability[] } | null = null;
/** The capabilities on disk, read again only after they change (asked on every model call). */
function current(): Capability[] {
  const key = `${capabilities.root()}\0${capabilities.changes}`;
  if (kept?.key !== key) kept = { key, library: capabilities.library() };
  return kept.library;
}

/** The active service package that provides ``name``, or null. */
export function packageFor(name: string, library: Capability[] = current()): Capability | null {
  return library.find((item) => item.kind === "service" && item.status === "active" && item.provides.includes(name)) ?? null;
}

/** Whether ``name`` is there: from an active package, or still from FluidForm itself. */
export function available(name: string, library: Capability[] = current()): boolean {
  return Boolean(packageFor(name, library)) || builtIn.has(name);
}

const label = (name: string) => LABELS[name] ?? name;

/** Why ``capability`` cannot be enabled now, or null: what it requires is missing, or what it
 *  provides another active package provides already. */
export function enableProblem(capability: Capability, library: Capability[] = current()): string | null {
  const missing = capability.requires.filter((name) => !available(name, library));
  if (missing.length) return `需要先启用${missing.map(label).join("、")}能力。`;
  for (const name of capability.provides) {
    const other = packageFor(name, library);
    if (other && other.id !== capability.id) return `${label(name)}能力已经由「${other.name}」提供：先停用它。`;
  }
  return null;
}

/** Why ``capability`` cannot be switched off or removed now, or null: an active package needs what
 *  only it provides. */
export function disableProblem(capability: Capability, library: Capability[] = current()): string | null {
  const after = library.filter((item) => item.id !== capability.id);
  for (const name of capability.provides) {
    if (available(name, after)) continue;
    const needing = library.filter((item) => item.id !== capability.id && item.status === "active" && item.requires.includes(name));
    if (needing.length) return `「${needing.map((item) => item.name).join("」「")}」需要${label(name)}能力：先停用它们。`;
  }
  return null;
}

/** Each capability FluidForm knows of: who provides it now (a package's id, "builtin", or null). */
export function providers(library: Capability[] = current()): Record<string, string | null> {
  return Object.fromEntries([...PROVIDABLE].map((name) => [name, packageFor(name, library)?.id ?? (builtIn.has(name) ? "builtin" : null)]));
}

type Handler = (params: Json, service: Capability) => unknown;
type Waiting = { done: (value: Json) => void; fail: (error: Error) => void; timer: NodeJS.Timeout };

/** One running service: its process, its log, and what FluidForm waits to hear from it. */
export class Service {
  status = "off";
  text = "";
  error = "";
  readonly log: string[] = [];
  child: ChildProcess | null = null;
  task: Task<void> | null = null;
  private nextId = 0;
  readonly waiting = new Map<number, Waiting>();

  constructor(readonly id: string) {}

  note(line: string): void {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    this.log.push(`${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${[...line.trimEnd()].slice(0, 2000).join("")}`);
    if (this.log.length > LOG_LINES) this.log.splice(0, this.log.length - LOG_LINES);
  }

  send(message: Json): void {
    if (!this.child?.stdin || this.child.stdin.destroyed) throw new ServiceError("服务没有在运行");
    this.child.stdin.write(pyDumps({ jsonrpc: "2.0", ...message }, false) + "\n");
  }

  async request(method: string, params: Json, seconds = REQUEST_SECONDS): Promise<Json> {
    const deadline = performance.now() + STARTING_SECONDS * 1000;
    while ((this.status === "starting" || this.status === "restarting") && performance.now() < deadline) {
      await new Promise((done) => setTimeout(done, 50));
    }
    if (this.status !== "running") throw new ServiceError(`服务没有在运行（${this.status}）`);
    this.nextId += 1;
    const id = this.nextId;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        fail(new ServiceError(`${method} 在 ${seconds} 秒内没有回答`));
      }, seconds * 1000);
      this.waiting.set(id, { done, fail, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.waiting.delete(id);
        fail(error as Error);
      }
    });
  }

  /** Everything still waiting fails: the process has gone. */
  dropWaiting(reason: string): void {
    for (const [id, item] of this.waiting) {
      clearTimeout(item.timer);
      item.fail(new ServiceError(reason));
      this.waiting.delete(id);
    }
  }

  public(): Json {
    return { status: this.status, text: this.text, error: this.error, log: this.log.slice(-80) };
  }
}

/** Runs the enabled service packages, and carries requests both ways. */
export class ServiceHost {
  readonly services = new Map<string, Service>();
  readonly handlers = new Map<string, Handler>();

  get(capabilityId: string): Service {
    if (!this.services.has(capabilityId)) this.services.set(capabilityId, new Service(capabilityId));
    return this.services.get(capabilityId)!;
  }

  /** What a service may ask FluidForm: ``method`` answered by ``handler``. */
  handle(method: string, handler: Handler): void {
    this.handlers.set(method, handler);
  }

  running(capabilityId: string): boolean {
    const item = this.services.get(capabilityId);
    return Boolean(item?.task && !item.task.done);
  }

  start(capability: Capability): void {
    const item = this.get(capability.id);
    if (this.running(capability.id)) return;
    item.status = "starting";
    item.error = "";
    item.task = new Task((signal) => this.supervise(item, capability, signal));
  }

  async stop(capabilityId: string): Promise<void> {
    const item = this.services.get(capabilityId);
    if (!item?.task || item.task.done) return;
    item.task.cancel();
    await item.task.settled();
    item.status = "off";
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.services.keys()].map((id) => this.stop(id)));
  }

  /** The enabled services. */
  startAll(): void {
    for (const item of capabilities.library()) {
      if (item.kind === "service" && item.source === "upload" && item.entry && item.status === "active") this.start(item);
    }
  }

  /** Ask the service providing ``name``: its answer, or a ServiceError when none runs or it fails. */
  async request(name: string, method: string, params: Json = {}, seconds = REQUEST_SECONDS): Promise<Json> {
    const provider = packageFor(name);
    if (!provider) throw new ServiceError(`没有启用${label(name)}能力`);
    return this.get(provider.id).request(method, params, seconds);
  }

  private async supervise(item: Service, capability: Capability, signal: AbortSignal): Promise<void> {
    let restarts = 0;
    for (;;) {
      const started = performance.now();
      try {
        await this.runOnce(item, capability, signal);
      } catch (error) {
        if (signal.aborted) {
          item.status = "off";
          return;
        }
        log.error(`service ${capability.id} failed: ${(error as Error)?.stack ?? error}`);
        item.note(`出错：${(error as Error)?.message ?? error}`);
        if (error instanceof ServiceError) {
          item.status = "error";
          item.error = error.message;
          return;
        }
      }
      if (signal.aborted) {
        item.status = "off";
        return;
      }
      restarts = (performance.now() - started) / 1000 > limits.STABLE_SECONDS ? 0 : restarts + 1;
      if (restarts >= limits.MAX_RESTARTS) {
        item.status = "error";
        item.error = `连续退出了 ${limits.MAX_RESTARTS} 次，已停下，看看日志；改好后停用再启用。`;
        return;
      }
      item.status = "restarting";
      try {
        await sleep(limits.RESTART_PAUSE, signal);
      } catch {
        item.status = "off";
        return;
      }
    }
  }

  private async runOnce(item: Service, capability: Capability, signal: AbortSignal): Promise<void> {
    const reason = sandbox.deps.missing();
    if (reason) throw new ServiceError(reason);
    const secrets = await packages.secretsFor(capability);
    const lacking = capability.secrets.filter((name) => !(name in secrets));
    if (lacking.length) throw new ServiceError(`还没填：${lacking.join("、")}`);
    item.note("启动");
    let code: number | null = null;
    await sandbox.launched(join(capabilities.root(), capability.id), packages.dataFolder(capability.id), capability.entry, async (child) => {
      item.child = child;
      item.status = "running";
      item.error = "";
      const exited = new Promise<void>((done) => child.once("close", (status) => {
        code = status;
        done();
      }));
      const stopped = new Promise<void>((done) => {
        if (signal.aborted) done();
        signal.addEventListener("abort", () => done(), { once: true });
      });
      try {
        await Promise.race([Promise.all([
          readLines(child.stdout!, (line) => this.heard(item, capability, line), () => item.note("一行输出太长，丢掉了。")),
          readLines(child.stderr!, (line) => line.trim() && item.note(line), () => item.note("一行输出太长，丢掉了。")),
          exited]), stopped]);
      } finally {
        item.child = null;
        item.dropWaiting("服务停了");
      }
    }, { secrets, domains: capability.domains, log: (line) => item.note(line), stdio: ["pipe", "pipe", "pipe"] });
    if (signal.aborted) return;
    item.note(`进程退出了（返回 ${code}）`);
  }

  /** One line from a service: an answer to FluidForm, a request or notification for it, or its log. */
  private heard(item: Service, capability: Capability, line: string): void {
    let message: unknown = null;
    try {
      message = JSON.parse(line);
    } catch {
      // not a message: its own output
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      if (line.trim()) item.note(line);
      return;
    }
    const given = message as Json;
    if (!given.method && given.id !== undefined) {
      const waiting = item.waiting.get(given.id);
      if (!waiting) return;
      clearTimeout(waiting.timer);
      item.waiting.delete(given.id);
      if (given.error) waiting.fail(new ServiceError(String(given.error?.message ?? given.error)));
      else waiting.done((given.result ?? {}) as Json);
      return;
    }
    if (typeof given.method !== "string") return;
    if (given.method === "status") {
      item.text = [...String(given.params?.text ?? "")].slice(0, 200).join("");
      item.note(`状态：${item.text}`);
      return;
    }
    void this.answer(item, capability, given);
  }

  private async answer(item: Service, capability: Capability, given: Json): Promise<void> {
    const handler = this.handlers.get(given.method);
    const reply = (body: Json) => {
      if (given.id === undefined) return; // a notification is not answered
      try {
        item.send({ id: given.id, ...body });
      } catch {
        // it has gone
      }
    };
    if (!handler) {
      reply({ error: { code: -32601, message: `FluidForm 没有 ${given.method}` } });
      return;
    }
    try {
      reply({ result: (await handler((given.params ?? {}) as Json, capability)) ?? {} });
    } catch (error) {
      item.note(`${given.method} 出错：${(error as Error)?.message ?? error}`);
      reply({ error: { code: -32000, message: (error as Error)?.message ?? String(error) } });
    }
  }
}
