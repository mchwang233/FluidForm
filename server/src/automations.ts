// What someone asks an automation package (capability_runner.ts) becomes: a
// question is answered by the conversation's own chat; work is planned as a task that waits for the
// owner's confirmation, and the conversation hears how it ended.
import * as chats from "./chat.js";
import { randomUUID } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { type Api, CHAT_TITLE_CHARS, CreateTask, HttpError, round6 } from "./api.js";
import * as files from "./attachments.js";
import * as capabilities from "./capabilities.js";
import * as packages from "./capability-packages.js";
import { type Asked, type Automation, CALLED_ONLY, type Handled, keepHeard, MAX_HEARD_FILES, permanentIn, Runner } from "./capability-runner.js";
import { settings } from "./config.js";
import { log } from "./log.js";
import { type Capability, EventSchema, type ExecutionRun, folderId, LeadMessageSchema, type ModelProfile } from "./models.js";
import { briefWriter } from "./routing.js";
import { pyStr } from "./py.js";
import * as streaming from "./streaming.js";
import * as supervisor from "./supervisor.js";
import * as taskFiles from "./task-files.js";
import { Mutex, type Task } from "./tasks.js";

type Json = Record<string, any>;

// How a task asked for through an automation ended, as the automation is told.
export const TASK_ENDED: Record<string, string> = { "run.succeeded": "做完了", "run.incomplete": "只做完了一部分", "run.failed": "没能做完",
  "run.cancelled": "已取消" };
// What starts, or calls off, the task waiting in a conversation, said alone by who asked for it.
export const START_TASK = /^(开始|开工|确认|\/start)$/i;
export const CANCEL_TASK = /^(取消|不做了|\/cancel)$/i;
// The files of a task: those sent in this many of the chat's last messages from people.
export const TASK_FILE_TURNS = 3;
// What of a task's own folder its end sends to the chat app: at most this many files its result names.
export const MAX_TASK_FILES = 5;
// How long after its answer a reply from the same person is taken as a reply to it.
export const FOLLOW_UP_SECONDS = 300;
// Files an automation chat's answer may send (SEND lines): how many, each at most the attachment size.
export const MAX_SENT_FILES = 5;

export const taskName = (run: ExecutionRun) => run.plan.title || [...run.plan.summary].slice(0, 40).join("");

/** What came with a message, as the chat is told: how many pictures, and files by their names
 *  (pictures are named by message ids nobody should see). */
export function attachedNote(attached: { kind: string; name: string }[]): string {
  const pictures = attached.filter((item) => item.kind === "image").length;
  const parts = [...(pictures ? [`${pictures} 张图片`] : []), ...attached.filter((item) => item.kind !== "image").map((item) => item.name)];
  return parts.length ? `（附 ${parts.join("、")}）` : "";
}

const firstLine = (text: string) => text.split(/\r\n|\r|\n/)[0];
const cut = (text: string, count: number) => [...text].slice(0, count).join("");

export class CapabilityAutomations {
  readonly runner: Runner;
  /** One message of a conversation at a time finds or begins its chat, so only one is begun. */
  private readonly opening = new Map<string, Mutex>();

  constructor(readonly api: Api) {
    this.runner = new Runner((capability, asked, automation) => this.message(capability, asked, automation));
  }

  /** The enabled automation packages, when this machine allows them. */
  startAll(): void {
    if (!settings.capability_packages) return;
    for (const item of capabilities.library()) {
      if (item.kind === "automation" && item.source === "upload" && item.entry && item.status === "active") this.runner.start(item);
    }
  }

  /** The saved choice, with the ordinary fallback if it has become unavailable (or cannot see the
   *  images sent). An unchanged automatic preference keeps its conversation; restoring automatic
   *  chooses afresh. */
  async chatModel(automation: Automation, run: ExecutionRun | null = null, needsVision = false): Promise<ModelProfile> {
    // The chat package orders them, API models first: people in a chat app wait for each answer.
    const available = await chats.order(this.api.chatModels(true, needsVision), true);
    const kept = !automation.state.model_id && run && !automation.state.chat_preferences[run.id] && run.supervisor ? run.supervisor.model_id : null;
    const id = (await chats.ask("chat.automation_model", { ordered: available.map((model) => model.id), wanted: automation.state.model_id ?? null, kept })).id;
    const pick = available.find((model) => model.id === id);
    if (!pick) throw new HttpError(422, "没有可用来对话的模型：请先配置会员 CLI 或 API 模型。");
    return pick;
  }

  /** What a message to an automation becomes, decided as 新建's 自动 decides: every message goes to
   *  the conversation's chat, whose model asks for a task itself once it knows what the work is.
   *  Returns the reply, what it cost and the files sent with it. */
  async message(capability: Capability, asked: Asked, automation: Automation): Promise<Handled> {
    const { api } = this;
    const { db, executor } = api;
    const { signal } = asked;
    // Without the chat capability nothing answers; the owner sees why in the automation's log.
    if (!chats.enabled()) {
      automation.note(chats.NOT_ENABLED);
      return [null, 0];
    }
    const cheapest = await briefWriter(Object.values(api.models), api.configured(), { countOnly: true });
    // What was said where it was not called on (a group chat): kept, and told with the next message
    // it answers, so it knows what the group was talking about.
    const state = automation.state;
    const heard: Record<string, string[]> = (state.heard ??= {});
    const heardFiles: Record<string, string[]> = (state.heard_files ??= {});
    const earlier = asked.conversation ? [...(heard[asked.conversation] ?? [])] : [];
    const filesBefore = asked.conversation ? files.resolveExisting(heardFiles[asked.conversation] ?? []) : [];
    // Its last answer there, and to whom: the chat package decides whether this is meant for it.
    const answered: Json | undefined = asked.conversation ? (state.answered ??= {})[asked.conversation] : undefined;
    const message = { text: asked.text, sender: asked.sender, addressed: asked.addressed, people: asked.people,
      attachments: asked.attachments.map((item) => ({ kind: item.kind, name: item.name })) };
    const hearing = await chats.ask("chat.hear", { name: capability.name, asked: message, earlier, answered: answered ?? null, now: Date.now() / 1000 });
    const line = String(hearing.line);
    if (hearing.note) automation.note(hearing.note);
    let judged = 0;
    if (!hearing.addressed) {
      let reply: string;
      [reply, judged] = await api.deps.addressed(hearing.judge, api.providers, cheapest);
      const meant = Boolean((await chats.ask("chat.judged", { reply })).meant);
      if (!meant) {
        if (asked.conversation) {
          heard[asked.conversation] = keepHeard([...earlier, line]);
          const kept = [...filesBefore, ...asked.attachments].map((item) => item.id);
          heardFiles[asked.conversation] = kept.slice(-MAX_HEARD_FILES);
        }
        automation.note(`群里没 @ 它的消息：不是问它的，记作上下文（${cut(line, 60)}）`);
        return [null, judged];
      }
      automation.note(`群里没 @ 它的消息：判断是在问它，回答（${cut(line, 60)}）`);
    }
    // What happened since in FluidForm (a task it had planned ended), told before the message.
    const notesByConversation: Record<string, string[]> = (state.notes ??= {});
    const notes = asked.conversation ? notesByConversation[asked.conversation] ?? [] : [];
    const framed = await chats.ask("chat.frame", { asked: message, line, earlier, notes, files_before: filesBefore.length });
    // Only @-mentioned, with nothing new to answer: said briefly, not the past gone over again.
    const opening = `${capability.id}\0${asked.conversation}`;
    if (!this.opening.has(opening)) this.opening.set(opening, new Mutex());
    if (framed.reply) return [String(framed.reply), judged];
    const said = String(framed.said);
    const shown = String(framed.shown);
    // "/new" and the like are answered by themselves, before anything kept is used up by them.
    const alone = await chats.ask("chat.session", { ...chats.clock(), text: asked.text });
    if (alone.reply) {
      await this.opening.get(opening)!.run(() => {
        for (const kept of [state.chats, heard, heardFiles, state.answered ?? {}]) delete kept[asked.conversation];
        automation.save();
      });
      automation.note("开了新对话");
      return [String(alone.reply), judged];
    }
    signal?.throwIfAborted();
    // "开始" or "取消" said by who asked for the task waiting here: done at once, without the model.
    if (asked.conversation && (START_TASK.test(asked.text.trim()) || CANCEL_TASK.test(asked.text.trim()))) {
      const done = await this.decideTask(capability, asked);
      if (done !== null) return [done, judged];
    }
    // What a task asked who asked for it: their next message here is the answer.
    const toTask = await this.answerTask(capability, asked);
    if (toTask !== null) return [toTask, judged];
    if (earlier.length) delete heard[asked.conversation];
    if (asked.conversation) delete notesByConversation[asked.conversation];
    if (filesBefore.length) {
      // The pictures and files sent there before, the group's, come with this message.
      const before = new Set(filesBefore.map((item) => item.id));
      asked.attachments = [...filesBefore, ...asked.attachments.filter((item) => !before.has(item.id))].slice(-files.MAX_ATTACHMENTS);
      delete heardFiles[asked.conversation];
    }
    const spent = judged;
    // Stopped before it was answered: what it took is the conversation's again.
    const putBack = () => {
      if (!asked.conversation) return;
      if (earlier.length) heard[asked.conversation] = keepHeard([...earlier, ...(heard[asked.conversation] ?? [])]);
      if (filesBefore.length) {
        heardFiles[asked.conversation] = [...new Set([...filesBefore.map((item) => item.id), ...(heardFiles[asked.conversation] ?? [])])].slice(-MAX_HEARD_FILES);
      }
      if (notes.length) notesByConversation[asked.conversation] = [...notes, ...(notesByConversation[asked.conversation] ?? [])].slice(-5);
    };
    const origin = { ...asked.origin, capability: capability.id };
    // Where a chat is remembered by: kept on the chat (not on the tasks it asks for, which have their own).
    const chatOrigin = { ...origin, ...(asked.conversation ? { conversation: asked.conversation } : {}) };
    const attached = asked.attachments.map((item) => item.id);
    const needsVision = asked.attachments.some((item) => item.kind === "image");
    // The person sees the answer as it is written, never its lines for FluidForm (the chat package
    // says where they begin).
    const lines = await chats.actionLines();
    if (asked.on_text) {
      const show = asked.on_text;
      asked.on_text = (text) => show(chats.forPerson(text, lines));
    }
    let run!: ExecutionRun;
    let requested!: string | null;
    let pick!: ModelProfile;
    let before = 0;
    let extra = 0;
    let answering: Task<void> | undefined;
    let replyId = "";
    await this.opening.get(opening)!.run(async () => {
      if (signal?.aborted) return;
      // A conversation left for hours, or since yesterday, begins a new chat; the old one stays to be read.
      // With the conversation's permanent memory on (/memory on), it goes on: only /new begins one.
      const held = asked.conversation && !permanentIn(state, asked.conversation) ? state.chats[asked.conversation] : null;
      const last = held ? db.getRun(held)?.lead_messages.filter((item) => item.role === "user").at(-1)?.created_at : null;
      if (last) {
        const found = await chats.ask("chat.session", { ...chats.clock(), last_at: Date.parse(last) / 1000, text: asked.text });
        if (found.fresh) {
          delete state.chats[asked.conversation];
          automation.note("隔了一阵，开了新对话（旧的还在记录里）");
        }
      }
      for (;;) {
        if (signal?.aborted) return;
        const known = asked.conversation ? state.chats[asked.conversation] : null;
        const existing = known ? db.getRun(known) : null;
        if (!existing || existing.kind !== "chat") {
          [requested, pick] = [state.model_id, await this.chatModel(automation, null, needsVision)];
          // The answer's lead runs in a task started here, which takes this context along.
          const chosen = pick;
          const prefix = `${capability.name} · `;
          const title = prefix + cut(firstLine(asked.text), Math.max(CHAT_TITLE_CHARS - [...prefix].length, 10));
          run = await streaming.listener.run(asked.on_text, () => api.startChat(said, settings.default_budget_usd, true, null,
            chosen.id, attached, { autoRouted: true, spent, shown, origin: chatOrigin, title }));
          if (asked.conversation) state.chats[asked.conversation] = run.id;
          [answering, replyId] = [executor.leadTasks.get(run.id), api.getTask(run.id).lead_messages.at(-1)!.id];
          break;
        }
        run = existing;
        const chat = existing;
        const active = executor.leadTasks.get(chat.id);
        if (active && !active.done) {
          await settledOrStopped(active, signal);
          continue;
        }
        const started = await executor.locked(chat.id, async () => {
          // Someone may have started a reply while we were waiting for the run lock.
          const answering = executor.leadTasks.get(chat.id);
          if (answering && !answering.done) return false;
          const latest = api.getTask(chat.id);
          if (latest.kind !== "chat") return false;
          [requested, pick] = [state.model_id, await this.chatModel(automation, latest, needsVision || await chats.showsPictures(latest))];
          const previous = latest.supervisor?.model_id ?? null;
          if (previous !== pick.id) {
            latest.supervisor = supervisor.newSession(pick, latest.supervisor, supervisor.chatFolder(latest));
            // A membership CLI is handed them all again; an API model is sent the chat as it stands.
          if (pick.channel === "cli") latest.lead_seen_attachments = [];
          else latest.lead_seen_attachments ??= latest.attachments.map((item) => item.id);
          }
          if (asked.conversation && !latest.origin?.conversation) latest.origin = { ...(latest.origin ?? {}), conversation: asked.conversation };
          // Where it is (private or a group), for a chat started before automations said so.
          if (asked.origin.chat_type && !(latest.origin ?? {}).chat_type) latest.origin = { ...(latest.origin ?? {}), chat_type: asked.origin.chat_type };
          db.saveRun(latest);
          if (previous !== pick.id) executor.emit(chat.id, "run.lead_changed", { model_id: pick.id, previous_model_id: previous });
          [before, extra] = [latest.actual_cost_usd, spent];
          streaming.listener.run(asked.on_text, () => {
            try {
              executor.startLeadChat(chat.id, said, asked.attachments, shown);
            } catch (error) {
              if (!(error instanceof files.AttachmentError)) throw error;
              automation.note(`附件没带上：${error.message}`);
              executor.startLeadChat(chat.id, said, [], shown);
            }
          });
          return true;
        });
        if (started) {
          [answering, replyId] = [executor.leadTasks.get(chat.id), api.getTask(chat.id).lead_messages.at(-1)!.id];
          break;
        }
      }
    });
    if (!answering) {
      putBack();
      throw signal?.reason ?? new Error("这条没能开始回答");
    }
    // Remember the preference actually used for this turn, not a later change saved mid-reply.
    state.chat_preferences[run.id] = requested!;
    automation.save();
    const stop = () => answering!.cancel();
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    await answering.settled();
    signal?.removeEventListener("abort", stop);
    if (signal?.aborted) {
      const superseded = (signal.reason as Error)?.message === "superseded";
      if (superseded) putBack();
      await this.withdraw(run.id, replyId, superseded);
      automation.save();
      return [null, round6(api.getTask(run.id).actual_cost_usd - before + extra)];
    }
    asked.answered?.();
    const latest = api.getTask(run.id);
    const answer = latest.lead_messages.find((item) => item.id === replyId) ?? null;
    let text: string | null = answer ? answer.text : null;
    const actual = latest.supervisor?.model_id ?? null;
    if (answer?.status === "done" && actual && actual !== (requested! || pick!.id)) {
      // For the owner, in the automation's log: the people chatting need not hear of it.
      const name = api.models[actual]?.display_name ?? actual;
      automation.note(`（${requested! ? "所选" : "原"}模型暂不可用，本次由「${name}」回复。）`);
    }
    const cost = round6(latest.actual_cost_usd - before + extra);
    let sent: string[] = [];
    if (answer?.status === "done") {
      text = await this.remember(capability, automation, asked, latest, answer.id, text || "");
      const split = await chats.ask("chat.split_sends", { text: text || "" });
      text = split.text ?? null;
      const names = (split.names ?? []) as string[];
      if (names.length) {
        sent = this.sendFiles(capability, automation, latest, names);
        const listed = sent.map((path) => basename(path).split("-").slice(1).join("-") || basename(path)).join("、");
        if (sent.length) text = `${text ?? ""}\n\n（发了：${listed}）`.trim();
        await this.recordAnswer(latest.id, answer.id, text ?? "");
      }
      text = await this.task(capability, asked, automation, latest, answer.id, text, origin);
      if (asked.conversation && text) {
        const person = chats.forPerson(text, lines);
        (state.answered ??= {})[asked.conversation] = { sender: asked.sender, at: Date.now() / 1000, said: [...person].slice(-300).join(""),
          asked_back: /[？?]$/.test(person.trimEnd()) };
        automation.save();
      }
    }
    return [text, cost, sent];
  }

  /** "开始" or "取消" for the task waiting in this conversation: what to answer, or null when none
   *  waits (it is then said to the chat as anything else). Only who asked for it decides; in a private
   *  chat that is the one person there. */
  private async decideTask(capability: Capability, asked: Asked): Promise<string | null> {
    const waiting = this.api.db.listRuns().filter((run) => run.kind !== "chat" && run.status === "awaiting_confirmation"
      && run.origin?.capability === capability.id && run.origin?.conversation === asked.conversation)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const group = (asked.origin.chat_type ?? waiting[0]?.origin?.chat_type) === "group";
    const mine = waiting.filter((run) => (run.origin?.requester ? run.origin.requester === asked.sender_id : !group));
    if (!waiting.length) return null;
    const task = mine[0];
    if (!task) {
      const who = waiting[0].origin?.requester_name;
      return `「${taskName(waiting[0])}」是${who ? ` ${who} ` : "别人"}让排的，要由${who ? "他" : "那个人"}来开始或取消。`;
    }
    let said: string;
    if (START_TASK.test(asked.text.trim())) {
      if (!this.api.confirmTask) throw new Error("FluidForm 现在不能开始任务");
      await this.api.confirmTask(task.id);
      said = `「${taskName(task)}」开工了，做完在这里告诉你。`;
    } else {
      await this.api.executor.locked(task.id, () => {
        const latest = this.api.getTask(task.id);
        latest.status = "cancelled";
        this.api.db.saveRun(latest);
      });
      this.api.db.addEvent(EventSchema.parse({ run_id: task.id, kind: "run.cancelled", data: {} }));
      said = `好，「${taskName(task)}」不做了。`;
    }
    this.automationNote(capability, `${asked.sender || "对方"}${START_TASK.test(asked.text.trim()) ? "开始了" : "取消了"}任务「${taskName(task)}」`);
    // The chat knows of it, as of anything said there.
    const chat = task.origin?.chat_run ? this.api.db.getRun(task.origin.chat_run) : null;
    if (chat?.kind === "chat") {
      await this.api.executor.locked(chat.id, () => {
        const latest = this.api.getTask(chat.id);
        latest.lead_messages.push(LeadMessageSchema.parse({ role: "user", text: asked.text.trim() }), LeadMessageSchema.parse({ role: "lead", text: said }));
        this.api.db.saveRun(latest);
      });
    }
    return said;
  }

  /** Who asked for a task waiting on a question in this conversation answers it with their next message
   *  to the automation (in a group, one that @ it): a choice by its number or its words, or what they
   *  write. Null when no task of theirs waits there (it is then said to the chat as anything else). */
  private async answerTask(capability: Capability, asked: Asked): Promise<string | null> {
    if (!asked.conversation || !asked.addressed) return null;
    const waiting = this.api.db.listRuns().filter((run) => run.kind !== "chat" && run.waiting_diagnosis_id
      && run.origin?.capability === capability.id && run.origin?.conversation === asked.conversation)
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    const group = (asked.origin.chat_type ?? waiting[0]?.origin?.chat_type) === "group";
    const task = waiting.find((run) => (run.origin?.requester ? run.origin.requester === asked.sender_id : !group));
    const question = task?.diagnoses.find((item) => item.id === task.waiting_diagnosis_id);
    if (!task || !question) return null;
    const said = asked.text.trim();
    const picked = /^(?:选|第)?\s*([1-9])\s*(?:个|项)?$/.exec(said);
    const choice = (picked ? question.choices[Number(picked[1]) - 1] : null) ?? question.choices.find((item) => item.trim() === said) ?? null;
    if (!this.api.answerQuestion) throw new Error("FluidForm 现在不能回答任务的问题");
    try {
      await this.api.answerQuestion(task.id, question.id, { text: choice ? "" : said, choice, attachments: asked.attachments.map((item) => item.id) });
    } catch (error) {
      if (error instanceof HttpError) return `没能交给「${taskName(task)}」的负责人：${error.message}`;
      throw error;
    }
    const reply = `收到，已交给「${taskName(task)}」的负责人${choice ? `（选了：${choice}）` : ""}，它接着做，做完在这里告诉你。`;
    this.automationNote(capability, `${asked.sender || "对方"}回答了任务「${taskName(task)}」的问题`);
    const chat = task.origin?.chat_run ? this.api.db.getRun(task.origin.chat_run) : null;
    if (chat?.kind === "chat") {
      await this.api.executor.locked(chat.id, () => {
        const latest = this.api.getTask(chat.id);
        latest.lead_messages.push(LeadMessageSchema.parse({ role: "user", text: said }), LeadMessageSchema.parse({ role: "lead", text: reply }));
        this.api.db.saveRun(latest);
      });
    }
    return reply;
  }

  /** A task asked for through an automation asks its user something: told where it was asked for,
   *  under the message that asked for it, with its choices numbered (answerTask takes the answer). */
  taskAsked(runId: string, data: Record<string, unknown>): void {
    const { db } = this.api;
    const run = db.getRun(runId);
    const question = withoutPaths(String(data.question ?? "").trim());
    if (!run || run.kind === "chat" || !run.origin?.capability || !question) return;
    const choices = (Array.isArray(data.choices) ? data.choices : []).map((item) => String(item).trim()).filter(Boolean);
    const group = run.origin.chat_type === "group";
    const who = group && run.origin.requester_name ? `${run.origin.requester_name}，` : "";
    let text = `${who}「${taskName(run)}」的负责人想问你：\n\n${question}`;
    if (choices.length) text += "\n\n" + choices.map((item, index) => `${index + 1}. ${item}`).join("\n");
    text += `\n\n（${group ? "@我 " : ""}直接回复${choices.length ? "编号或你的想法" : "你的想法"}，我交给负责人；网页上也能答。）`;
    const conversation = run.origin.conversation;
    if (conversation) {
      const automation = this.runner.get(run.origin.capability);
      const notes = (automation.state.notes ??= {});
      notes[conversation] = [...(notes[conversation] ?? []), cut(text, 2000)].slice(-5);
      automation.save();
    }
    const chat = run.origin.chat_run ? db.getRun(run.origin.chat_run) : null;
    if (chat?.kind === "chat") {
      chat.lead_messages.push(LeadMessageSchema.parse({ role: "lead", text }));
      db.saveRun(chat);
    }
    this.runner.notify(run.origin.capability, { event: "task_question", origin: run.origin, title: taskName(run), text });
  }

  private automationNote(capability: Capability, line: string): void {
    this.runner.get(capability.id).note(line);
  }

  /** What ``run`` made, copied for its automation to send, with the whole result as a file of its own
   *  when what is said in the chat is only its opening. */
  deliverables(run: ExecutionRun, full: string | null = null): string[] {
    const outbox = join(packages.dataFolder(pyStr(run.origin?.capability)), "outbox");
    const sent: string[] = [];
    mkdirSync(outbox, { recursive: true });
    const add = (write: (target: string) => void, name: string) => {
      const target = join(outbox, `${randomUUID().replaceAll("-", "").slice(0, 8)}-${files.safeName(name)}`);
      write(target);
      sent.push(relative(join(outbox, ".."), target));
    };
    for (const path of taskFiles.named(run)) {
      try {
        add((target) => copyFileSync(path, target), basename(path));
      } catch {
        // gone meanwhile: named only
      }
    }
    if (full) add((target) => writeFileSync(target, full), "结果说明.md");
    return sent;
  }

  /** A stopped turn in its chat's records: one the next message took along leaves them (that message
   *  says it all); one the person stopped says so, and is no question still to answer. */
  private async withdraw(chatId: string, replyId: string, superseded: boolean): Promise<void> {
    await this.api.executor.locked(chatId, () => {
      const chat = this.api.db.getRun(chatId);
      const at = chat?.lead_messages.findIndex((item) => item.id === replyId) ?? -1;
      if (!chat || at < 0) return;
      if (superseded) chat.lead_messages.splice(Math.max(at - 1, 0), at > 0 ? 2 : 1);
      else Object.assign(chat.lead_messages[at], { text: "（已按要求停下，这条没有答完。）", status: "done" });
      this.api.db.saveRun(chat);
    });
  }

  /** An answer without its REMEMBER and FORGET lines, which update what is kept about this
   *  conversation's people (kept by the chat package; settings.user_memory). Without the setting the lines are
   *  only taken out. */
  async remember(capability: Capability, automation: Automation, asked: Asked, chat: ExecutionRun, answerId: string, text: string): Promise<string> {
    // The chat package keeps them by conversation; without one, the lines are only taken out.
    const place = asked.conversation ? chats.automationKey(capability.id, asked.conversation) : "";
    const [shown, remembered] = await chats.remember(place, text, settings.user_memory && Boolean(asked.conversation));
    if (shown === text) return text;
    if (asked.conversation && settings.user_memory) for (const fact of remembered) automation.note(`记下：${cut(fact, 60)}`);
    await this.recordAnswer(chat.id, answerId, shown);
    return shown;
  }

  /** The files a chat's answer sends (its SEND lines), from the chat's own folder only: copied into the
   *  automation's data folder (outbox/), where it reads them; their paths there. */
  sendFiles(capability: Capability, automation: Automation, chat: ExecutionRun, names: string[]): string[] {
    const workspace = join(settings.workspace_root, folderId(chat));
    const outbox = join(packages.dataFolder(capability.id), "outbox");
    const sent: string[] = [];
    for (const name of names.slice(0, MAX_SENT_FILES)) {
      const source = isAbsolute(name) ? name : join(workspace, name);
      try {
        const folder = realpathSync(workspace);
        if (lstatSync(source).isSymbolicLink() || !realpathSync(source).startsWith(folder + sep) || !statSync(source).isFile()) {
          throw new files.AttachmentError("不是这段聊天文件夹里的文件");
        }
        if (statSync(source).size > files.MAX_ATTACHMENT_BYTES) throw new files.AttachmentError(`超过 ${Math.floor(files.MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`);
        mkdirSync(outbox, { recursive: true });
        const target = join(outbox, `${randomUUID().replaceAll("-", "").slice(0, 8)}-${files.safeName(basename(source))}`);
        copyFileSync(source, target);
        sent.push(relative(join(outbox, ".."), target));
      } catch (error) {
        const reason = error instanceof files.AttachmentError ? error.message : missingReason(error);
        automation.note(`没发出 ${cut(name, 80)}：${reason}`);
      }
    }
    return sent;
  }

  /** A chat keeps an answer as the person got it (without the lines meant for FluidForm). */
  async recordAnswer(chatId: string, answerId: string, text: string | null): Promise<void> {
    await this.api.executor.locked(chatId, () => {
      const record = this.api.getTask(chatId);
      for (const item of record.lead_messages) if (item.id === answerId) item.text = text ?? "";
      this.api.db.saveRun(record);
    });
  }

  /** When the chat's answer asks for a task (its TASK line), plan it, with the conversation as its
   *  background and the chat's files as its own; the answer, without that line, says so. The chat
   *  keeps the answer as the person saw it. */
  async task(capability: Capability, asked: Asked, automation: Automation, chat: ExecutionRun, answerId: string, text: string | null,
    origin: Json): Promise<string | null> {
    const split = await chats.ask("chat.split_task", { text: text || "" });
    let shown: string | null = split.text ?? null;
    const request: string | null = split.request ?? null;
    if (request === null) return text;
    if ([...request].length < 3) shown = shown || "这件事我没能写清楚，请再说具体一点。";
    else {
      const context = "这个任务来自一段对话，对话内容如下（供参考，以需求为准）：\n" + await chats.transcript(chat);
      try {
        const task = await this.api.newTask(CreateTask.parse({ prompt: request, attachments: recentFiles(chat) }), null, context);
        const latest = this.api.getTask(task.id);
        latest.origin = { ...origin, conversation: asked.conversation, chat_run: chat.id,
          ...(asked.sender_id ? { requester: asked.sender_id } : {}), ...(asked.sender ? { requester_name: asked.sender } : {}) };
        latest.auto_routed = true;
        this.api.db.saveRun(latest);
        const group = (origin.chat_type ?? "") === "group";
        shown = `${shown}\n\n（计划「${taskName(latest)}」排好了：${group ? "@我 " : ""}回复「开始」就开工，回复「取消」就不做了；做完在这里告诉你。）`.trim();
        automation.note(`排了任务「${taskName(latest)}」`);
      } catch (error) {
        // The answer still goes out, saying planning failed.
        log.error(`planning a task for ${capability.id} failed: ${(error as Error)?.stack ?? error}`);
        const reason = error instanceof HttpError ? error.message : (error as Error)?.message ?? String(error);
        shown = `${shown}\n\n（排计划没成功：${cut(reason, 200)}）`.trim();
      }
    }
    await this.recordAnswer(chat.id, answerId, shown);
    return shown;
  }

  /** A task an automation asked for has ended: the automation hears how, with its origin. */
  taskEnded(runId: string, kind: string): void {
    const { db } = this.api;
    const run = db.getRun(runId);
    if (!run || run.kind === "chat" || !run.origin?.capability) return;
    let text = `「${taskName(run)}」${TASK_ENDED[kind] ?? "结束了"}。`;
    const whole = withoutPaths((run.final_result || run.error || "").trim());
    // People in a chat app read its opening; the whole result goes along as a file.
    const shown = taskFiles.opening(whole);
    const automationFiles = this.deliverables(run, shown !== whole ? `# ${taskName(run)}\n\n${whole}\n` : null);
    const body = shown;
    if (body) text += "\n\n" + body;
    if (automationFiles.length) text += `\n\n（发了：${automationFiles.map((path) => basename(path).split("-").slice(1).join("-")).join("、")}）`;
    // Its conversation hears it too: the chat shows it, and its model is told with the next message.
    const conversation = run.origin.conversation;
    if (conversation) {
      const automation = this.runner.get(run.origin.capability);
      const notes = (automation.state.notes ??= {});
      notes[conversation] = [...(notes[conversation] ?? []), cut(text, 2000)].slice(-5);
      automation.save();
    }
    const chat = run.origin.chat_run ? db.getRun(run.origin.chat_run) : null;
    if (chat?.kind === "chat") {
      // The chat keeps all of it, and its model can send the files again (they are in its folder).
      chat.lead_messages.push(LeadMessageSchema.parse({ role: "lead", text: whole && whole !== shown ? text.replace(shown, whole) : text }));
      db.saveRun(chat);
    }
    this.runner.notify(run.origin.capability, { event: "task_ended", origin: run.origin, outcome: kind, title: taskName(run), text,
      ...(automationFiles.length ? { files: automationFiles } : {}) });
  }
}

// An absolute path written out in a result.
const WRITTEN = /(?<![\w\]/(])(\/(?:[\w.@+-]+\/)+[\w.@+-]+)/g;

/** A result as people in a chat app read it: no path of this machine, a file by its name. */
export function withoutPaths(text: string): string {
  return text.replace(/\[([^\]]*)\]\((\/[^)\s]+)\)/g, (_all, label: string, path: string) => (label.includes(basename(path)) ? label : `${label}（${basename(path)}）`))
    .replace(WRITTEN, (path: string) => basename(path));
}

/** A chat's files of its last messages from people: what a task it asks for is about. */
function recentFiles(chat: ExecutionRun): string[] {
  const asked = chat.lead_messages.filter((item) => item.role === "user");
  const recent = new Set(asked.slice(-TASK_FILE_TURNS).map((item) => item.id));
  const placed = new Set(chat.lead_messages.flatMap((item) => item.attachments.map((file) => file.id)));
  const first = asked[0]?.id;
  const ids = chat.lead_messages.filter((item) => recent.has(item.id)).flatMap((item) => item.attachments.map((file) => file.id));
  // A chat's first files are kept on the chat, not on its first message.
  if (first && recent.has(first)) ids.push(...chat.attachments.filter((file) => !placed.has(file.id)).map((file) => file.id));
  return [...new Set(ids)];
}

/** Waits for ``task``, or until ``signal`` is aborted. */
async function settledOrStopped(task: Task<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return task.settled();
  if (signal.aborted) return;
  let stop!: () => void;
  const stopped = new Promise<void>((done) => (stop = done));
  signal.addEventListener("abort", stop, { once: true });
  await Promise.race([task.settled(), stopped]);
  signal.removeEventListener("abort", stop);
}

function missingReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return "不是这段聊天文件夹里的文件";
  return (error as Error)?.message ?? String(error);
}
