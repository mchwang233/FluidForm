// Runs enabled automation packages in the background (capability-runner.ts;
// docs/design/capability-packages.md).
//
// Each automation is its package's ``entry`` command, run in the capabilities' sandbox
// (capability-sandbox.ts), speaking JSON lines:
//
// - it writes ``{"op": "status", "text": ...}`` (how it is doing, shown to the user), and
//   ``{"op": "message", "id": ..., "conversation": ..., "text": ..., "origin": {...}}`` when someone
//   asks it something, with ``"attachments": [path, ...]`` for files sent along: paths in its data
//   folder, which FluidForm takes (copies into its attachments, then removes); with ``"addressed": false``
//   when it was not called on (a group message without @ it), and ``"sender"`` naming who said it, and
//   ``"people"`` the names of the group's people (so an answer can @ them: the package turns "@name"
//   into its app's mention);
// - it reads ``{"re": id, "reply": ..., "files": [...]}``, the answer and the files to send with it
//   (paths in its data folder, which it may remove once sent), and ``{"event": "task_ended", "origin":
//   {...}, "text": ...}`` when a task it asked for ends. While a chat's answer is being written (an API
//   model streams it), ``{"progress": id, "text": ...}`` carries all of it so far, at most every
//   PROGRESS_SECONDS; one that does not know it ignores it.
//
// What a message becomes (a chat's answer, or a task waiting for the owner's confirmation) is decided by
// ``handle`` (the API). This module keeps each automation running (a crash is restarted, a few times),
// its log, its daily budget and its state, which it keeps out of the automation's reach.
import type { ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { Readable } from "node:stream";
import * as files from "./attachments.js";
import * as capabilities from "./capabilities.js";
import * as packages from "./capability-packages.js";
import * as sandbox from "./capability-sandbox.js";
import { settings } from "./config.js";
import { log } from "./log.js";
import type { Attachment, Capability } from "./models.js";
import { formatG, pyDumps, pyRound } from "./py.js";
import { Mutex, sleep, Task } from "./tasks.js";

// Restarted after a crash at most this many times in a row; running this long resets the count.
export const limits = { RESTART_PAUSE: 10.0, STABLE_SECONDS: 120.0, PICTURE_WAIT_SECONDS: 8.0, MAX_RESTARTS: 5, PROGRESS_SECONDS: 0.5 };
export const LOG_LINES = 200;
export const MAX_TEXT = 20_000;
// How often an answer being written is passed on (``{"progress": ...}``).
// What a message of files alone says.
export const FILES_ONLY = "（见附件）";
// What a message that only calls on it says (an @ and nothing else): answer what came before.
export const CALLED_ONLY = "（只 @ 了你，没有别的话）";
// A question about a picture that comes without one waits limits.PICTURE_WAIT_SECONDS for that person's
// picture: in a chat app the picture and the words about it are often sent apart, the picture a little
// later. A picture sent this recently is the one such a question means: no waiting then.
export const RECENT_PICTURE_SECONDS = 120.0;
export const PICTURE_WORDS = /图片|照片|截图|这张|这幅|这个图|这图|图里|图中|图上|看图|picture|photo|image|screenshot/i;
// How long a line from an automation may be.
export const LINE_LIMIT = 1 << 20;
// What is kept of a group's talk the automation was not called on, per conversation (keepHeard).
export const MAX_HEARD_LINES = 30;
export const MAX_HEARD_CHARS = 4000;
// And of the pictures and files sent there (a picture in a group cannot @ it): the latest ones.
export const MAX_HEARD_FILES = 10;
// The names of a group's people told to its chat: enough for a team, not a whole company.
export const MAX_PEOPLE = 200;
export const MAX_PERSON_CHARS = 40;

const pad = (value: number) => String(value).padStart(2, "0");

/** The automation's day, on this machine's clock: its budget starts again at midnight. */
export function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function statePath(capabilityId: string): string {
  return join(settings.data_dir, "capability-host", `${capabilityId}.json`);
}

/** Something someone asked an automation. */
export type Asked = {
  conversation: string;
  text: string;
  origin: Record<string, unknown>;
  attachments: Attachment[];
  // Hears a chat's answer as it is written: all of it so far (streaming.listener).
  on_text: ((text: string) => void) | null;
  // False: said where the automation was not called on (a group message without @ it), so it answers
  // only if the message is meant for it; ``sender`` names who said it there.
  addressed: boolean;
  sender: string;
  // In a group: its people's names, the ones an answer may @ (the package marks them).
  people: string[];
};

export function asked(fields: Partial<Asked> & Pick<Asked, "conversation" | "text">): Asked {
  return { origin: {}, attachments: [], on_text: null, addressed: true, sender: "", people: [], ...fields };
}

/** The ``"people"`` a message names, cleaned: strings, one line each, within bounds. */
export function groupPeople(names: unknown): string[] {
  if (!Array.isArray(names)) return [];
  const kept = names.filter((name): name is string => typeof name === "string").map((name) => [...name.split(/\s+/).filter(Boolean).join(" ")].slice(0, MAX_PERSON_CHARS).join(""));
  return [...new Set(kept.filter(Boolean))].slice(0, MAX_PEOPLE);
}

/** The latest lines that fit MAX_HEARD_LINES and MAX_HEARD_CHARS, each cut to fit too. */
export function keepHeard(lines: string[]): string[] {
  const kept: string[] = [];
  let size = 0;
  for (const given of lines.slice(-MAX_HEARD_LINES).reverse()) {
    const line = [...given].slice(0, 500).join("");
    const length = [...line].length;
    if (size + length > MAX_HEARD_CHARS) break;
    kept.push(line);
    size += length;
  }
  return kept.reverse();
}

const within = (path: string, folder: string) => path.startsWith(folder + "/");
const realOr = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** The files an automation sent with a message, from its data folder: each becomes one of FluidForm's
 *  attachments and is removed there. Anything outside that folder, a link, or too large is refused,
 *  with a line in its log. */
export function takeFiles(item: Automation, capabilityId: string, names: unknown): Attachment[] {
  if (!Array.isArray(names) || !names.length) return [];
  const folder = realOr(packages.dataFolder(capabilityId));
  const taken: Attachment[] = [];
  for (const raw of names.slice(0, files.MAX_ATTACHMENTS + 1)) {
    const name = String(raw);
    const source = join(folder, name);
    try {
      if (taken.length === files.MAX_ATTACHMENTS) throw new files.AttachmentError(`一条消息最多 ${files.MAX_ATTACHMENTS} 个附件`);
      const link = existsSync(source) || isLink(source) ? lstatSync(source).isSymbolicLink() : false;
      if (isAbsolute(name) || name.split("/").includes("..") || link || !within(realOr(source), folder) || !existsSync(source) || !statSync(source).isFile()) {
        throw new files.AttachmentError("不是它数据目录里的文件");
      }
      if (statSync(source).size > files.MAX_ATTACHMENT_BYTES) throw new files.AttachmentError(`超过 ${Math.floor(files.MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`);
      taken.push(files.save(basename(source), readFileSync(source)));
    } catch (error) {
      item.note(`附件 ${[...name].slice(0, 80).join("")} 没收下：${(error as Error).message}`);
    } finally {
      // Removed only from its own folder, never through a link out of it.
      try {
        const parent = realOr(dirname(source));
        if ((parent === folder || within(parent, folder)) && (isLink(source) || (existsSync(source) && statSync(source).isFile()))) unlinkSync(source);
      } catch {
        // already gone
      }
    }
  }
  return taken;
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** What tests replace: taking the files a message names. */
export const deps = { takeFiles };

/** Why an automation cannot run until the user changes something. */
export class Fatal extends Error {}

type State = { daily_budget_usd: number; spent: Record<string, number>; notified: string; chats: Record<string, any>; handled: number;
  model_id: string | null; chat_preferences: Record<string, any>; [key: string]: any };

/** One automation: its process, state, log and budget. */
export class Automation {
  state: State;
  status = "off";
  text = "";
  error = "";
  readonly log: string[] = [];
  task: Task<void> | null = null;
  process: ChildProcess | null = null;
  readonly lock = new Mutex();

  constructor(readonly id: string) {
    this.state = { daily_budget_usd: settings.capability_daily_budget_usd, spent: {}, notified: "", chats: {}, handled: 0, model_id: null, chat_preferences: {} };
    try {
      Object.assign(this.state, JSON.parse(readFileSync(statePath(id), "utf8")));
    } catch {
      // no state yet
    }
  }

  note(line: string): void {
    const now = new Date();
    this.log.push(`${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${[...line.trimEnd()].slice(0, 2000).join("")}`);
    if (this.log.length > LOG_LINES) this.log.splice(0, this.log.length - LOG_LINES);
  }

  save(): void {
    mkdirSync(dirname(statePath(this.id)), { recursive: true });
    writeFileSync(statePath(this.id), JSON.stringify(this.state, null, 1));
  }

  spentToday(): number {
    return Number(this.state.spent[today()] ?? 0);
  }

  spend(amount: number): void {
    if (amount > 0) this.state.spent = { [today()]: pyRound(this.spentToday() + amount, 6) }; // only today's is kept
  }

  remaining(): number {
    return Math.max(0, Number(this.state.daily_budget_usd) - this.spentToday());
  }

  public(): Record<string, unknown> {
    return { status: this.status, text: this.text, error: this.error, log: this.log.slice(-80), daily_budget_usd: Number(this.state.daily_budget_usd),
      spent_today_usd: this.spentToday(), model_id: this.state.model_id, handled: Math.trunc(Number(this.state.handled ?? 0)),
      conversations: Object.keys(this.state.chats).length };
  }
}

/** What handle answers: the reply (null: none), its cost, and the files to send with it. */
export type Handled = [string | null, number] | [string | null, number, string[]];
export type Handle = (capability: Capability, asked: Asked, item: Automation) => Promise<Handled>;

/** Calls ``onLine`` for each line of ``stream``; a line longer than LINE_LIMIT is dropped with a note. */
function readLines(stream: Readable, onLine: (line: string) => void, tooLong: () => void): Promise<void> {
  return new Promise((done) => {
    let pending: Buffer[] = [];
    let size = 0;
    let skipping = false;
    stream.on("data", (data: Buffer) => {
      let at = 0;
      for (;;) {
        const end = data.indexOf(10, at);
        if (end < 0) break;
        const piece = data.subarray(at, end);
        if (!skipping && size + piece.length <= LINE_LIMIT) onLine(Buffer.concat([...pending, piece]).toString("utf8"));
        else tooLong();
        pending = [];
        size = 0;
        skipping = false;
        at = end + 1;
      }
      const rest = data.subarray(at);
      if (rest.length && !skipping) {
        if (size + rest.length > LINE_LIMIT) {
          skipping = true;
          pending = [];
          size = 0;
        } else {
          pending.push(Buffer.from(rest));
          size += rest.length;
        }
      }
    });
    const finish = () => {
      if (pending.length && !skipping) onLine(Buffer.concat(pending).toString("utf8"));
      pending = [];
      done();
    };
    stream.on("end", finish);
    stream.on("error", finish);
  });
}

export class Runner {
  readonly automations = new Map<string, Automation>();
  // Questions about a picture waiting for it, by automation, conversation and sender.
  readonly waitingPictures = new Map<string, (attached: Attachment[]) => void>();
  // When each automation, conversation and sender last sent a picture or file.
  readonly lastPicture = new Map<string, number>();

  constructor(public handle: Handle) {}

  get(capabilityId: string): Automation {
    if (!this.automations.has(capabilityId)) this.automations.set(capabilityId, new Automation(capabilityId));
    return this.automations.get(capabilityId)!;
  }

  running(capabilityId: string): boolean {
    const item = this.automations.get(capabilityId);
    return Boolean(item?.task && !item.task.done);
  }

  start(capability: Capability): void {
    const item = this.get(capability.id);
    if (!this.running(capability.id)) {
      item.status = "starting";
      item.error = "";
      item.task = new Task((signal) => this.supervise(item, capability, signal));
    }
  }

  async stop(capabilityId: string): Promise<void> {
    const item = this.automations.get(capabilityId);
    if (item?.task && !item.task.done) {
      item.task.cancel();
      await item.task.settled();
    }
    if (item) {
      item.status = "off";
      item.text = "";
    }
  }

  async restart(capability: Capability): Promise<void> {
    if (this.running(capability.id)) {
      await this.stop(capability.id);
      this.start(capability);
    }
  }

  async stopAll(): Promise<void> {
    for (const capabilityId of [...this.automations.keys()]) await this.stop(capabilityId);
  }

  /** Its state, when it is uninstalled (stop it first). */
  forget(capabilityId: string): void {
    this.automations.delete(capabilityId);
    try {
      unlinkSync(statePath(capabilityId));
    } catch {
      // none kept
    }
  }

  notify(capabilityId: string, event: Record<string, unknown>): void {
    const item = this.automations.get(capabilityId);
    if (item) void this.send(item, event);
  }

  // ---- one automation's process ----
  async supervise(item: Automation, capability: Capability, signal: AbortSignal): Promise<void> {
    let restarts = 0;
    for (;;) {
      const started = performance.now();
      try {
        await this.runOnce(item, capability, signal);
      } catch (error) {
        if (signal.aborted) {
          item.status = "off";
          throw error;
        }
        if (error instanceof Fatal) {
          item.status = "error";
          item.error = error.message;
          item.note(error.message);
          return;
        }
        log.error(`automation ${capability.id} failed: ${(error as Error)?.stack ?? error}`);
        item.note(`出错：${(error as Error)?.message ?? error}`);
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
      } catch (error) {
        item.status = "off";
        throw error;
      }
    }
  }

  async runOnce(item: Automation, capability: Capability, signal: AbortSignal): Promise<void> {
    const reason = sandbox.deps.missing();
    if (reason) throw new Fatal(reason);
    const secrets = await packages.secretsFor(capability);
    const lacking = capability.secrets.filter((name) => !(name in secrets));
    if (lacking.length) throw new Fatal(`还没填：${lacking.join("、")}`);
    const folder = join(capabilities.root(), capability.id);
    item.text = "";
    item.note("启动");
    let code: number | null = null;
    await sandbox.launched(folder, packages.dataFolder(capability.id), capability.entry, async (child) => {
      item.process = child;
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
        await Promise.race([Promise.all([this.read(item, capability, child.stdout!, true), this.read(item, capability, child.stderr!, false), exited]), stopped]);
      } finally {
        item.process = null;
      }
    }, { secrets, domains: capability.domains, log: (line) => item.note(line), stdio: ["pipe", "pipe", "pipe"] });
    if (signal.aborted) throw signal.reason;
    item.note(`进程退出了（返回 ${code}）`);
    item.status = "restarting";
  }

  read(item: Automation, capability: Capability, stream: Readable, talks: boolean): Promise<void> {
    return readLines(stream, (raw) => {
      const text = raw.replace(/\n$/, "");
      let payload: unknown = null;
      if (talks && text.startsWith("{")) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = null;
        }
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        if (text.trim()) item.note(text);
        return;
      }
      const message = payload as Record<string, unknown>;
      const op = message.op;
      if (op === "status") {
        item.text = [...String(message.text || "")].slice(0, 200).join("");
        item.note(`状态：${item.text}`);
      } else if (op === "message") void this.ask(item, capability, message);
      else if (op === "log") item.note(String(message.text || ""));
      else item.note(`看不懂的消息：${[...text].slice(0, 200).join("")}`);
    }, () => item.note("一行输出太长，丢掉了。"));
  }

  async ask(item: Automation, capability: Capability, payload: Record<string, unknown>): Promise<void> {
    const request = payload.id ?? null;
    const text = [...String(payload.text || "").trim()].slice(0, MAX_TEXT).join("");
    let attached = deps.takeFiles(item, capability.id, payload.attachments);
    const addressed = payload.addressed !== false;
    if (!text && !attached.length && !addressed) {
      await this.send(item, { re: request, reply: null });
      return;
    }
    const key = JSON.stringify([capability.id, String(payload.conversation || ""), String(payload.sender || "")]);
    const waiting = this.waitingPictures.get(key);
    const sentBefore = performance.now() / 1000 - (this.lastPicture.get(key) ?? -Infinity) < RECENT_PICTURE_SECONDS;
    if (attached.length) this.lastPicture.set(key, performance.now() / 1000);
    if (attached.length && !text && waiting) {
      // The picture a question just before was about: it goes with that question.
      waiting(attached);
      await this.send(item, { re: request, reply: null });
      return;
    }
    if (text && !attached.length && !sentBefore && PICTURE_WORDS.test(text) && !this.waitingPictures.has(key)) {
      let timer: NodeJS.Timeout | undefined;
      try {
        attached = await new Promise<Attachment[]>((done) => {
          this.waitingPictures.set(key, (given) => done(given));
          // None came: the question is about a picture sent before, if any.
          timer = setTimeout(() => done([]), limits.PICTURE_WAIT_SECONDS * 1000);
        });
      } finally {
        clearTimeout(timer);
        this.waitingPictures.delete(key);
      }
    }
    const question = asked({ conversation: [...String(payload.conversation || "")].slice(0, 200).join(""), text: text || (attached.length ? FILES_ONLY : CALLED_ONLY),
      origin: payload.origin && typeof payload.origin === "object" && !Array.isArray(payload.origin) ? payload.origin as Record<string, unknown> : {},
      attachments: attached, on_text: Runner.progress(item, request), addressed, sender: [...String(payload.sender || "")].slice(0, 40).join(""),
      people: groupPeople(payload.people) });
    const refused = await item.lock.run(async () => {
      if (item.remaining() <= 0 && !question.addressed) {
        await this.send(item, { re: request, reply: null, over_budget: true }); // it was not asked
        return true;
      }
      if (item.remaining() <= 0) {
        let notice: string | null = null;
        if (item.state.notified !== today()) {
          item.state.notified = today();
          item.save();
          notice = `今天的额度（$${formatG(Number(item.state.daily_budget_usd))}）用完了，明天再来；也可以请主人在 FluidForm 里调高。`;
        }
        await this.send(item, { re: request, reply: notice, over_budget: true });
        return true;
      }
      return false;
    });
    if (refused) return;
    let sent: string[] = [];
    let reply: string | null;
    let cost: number;
    try {
      const answer = await this.handle(capability, question, item);
      [reply, cost] = answer;
      sent = answer.length > 2 ? [...(answer[2] as string[])] : [];
    } catch (error) {
      log.error(`a message to ${capability.id} failed: ${(error as Error)?.stack ?? error}`);
      reply = `这条没能处理：${[...String((error as Error)?.message ?? error)].slice(0, 200).join("")}`;
      cost = 0;
    }
    item.spend(cost);
    item.state.handled = Math.trunc(Number(item.state.handled ?? 0)) + 1;
    item.save();
    await this.send(item, { re: request, reply, ...(sent.length ? { files: sent } : {}) });
  }

  /** Passes an answer being written on to the automation, at most every PROGRESS_SECONDS. Written
   *  without waiting (it is called from inside the model's stream); a lost one is made good by the
   *  next, and by the answer itself. */
  static progress(item: Automation, request: unknown): (text: string) => void {
    const last = { at: -Infinity, text: "" };
    return (text: string) => {
      const now = performance.now() / 1000;
      const child = item.process;
      if (now - last.at < limits.PROGRESS_SECONDS || text === last.text) return;
      if (!child?.stdin || child.exitCode !== null || child.stdin.destroyed) return;
      last.at = now;
      last.text = text;
      try {
        child.stdin.write(pyDumps({ progress: request, text: [...text].slice(0, MAX_TEXT).join("") }, false) + "\n");
      } catch {
        // the next one makes good
      }
    };
  }

  async send(item: Automation, payload: Record<string, unknown>): Promise<void> {
    const child = item.process;
    if (!child?.stdin || child.exitCode !== null || child.stdin.destroyed) {
      item.note("它没在运行，一条消息没送到。");
      return;
    }
    await new Promise<void>((done) => {
      child.stdin!.write(pyDumps(payload, false) + "\n", (error) => {
        if (error) item.note(`送不到：${error.message}`);
        done();
      });
    });
  }
}
