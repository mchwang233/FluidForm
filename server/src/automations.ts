// What someone asks an automation package (capability_runner.ts) becomes: a
// question is answered by the conversation's own chat; work is planned as a task that waits for the
// owner's confirmation, and the conversation hears how it ended.
import { randomUUID } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { type Api, CHAT_TITLE_CHARS, CreateTask, HttpError, round6 } from "./api.js";
import * as files from "./attachments.js";
import * as capabilities from "./capabilities.js";
import * as packages from "./capability-packages.js";
import { type Asked, type Automation, CALLED_ONLY, type Handled, keepHeard, MAX_HEARD_FILES, Runner } from "./capability-runner.js";
import { settings } from "./config.js";
import { log } from "./log.js";
import { type Capability, type ExecutionRun, folderId, LeadMessageSchema, type ModelProfile } from "./models.js";
import { fixed } from "./py.js";
import * as remembering from "./remembering.js";
import { briefWriter } from "./routing.js";
import * as streaming from "./streaming.js";
import * as supervisor from "./supervisor.js";

type Json = Record<string, any>;

// How a task asked for through an automation ended, as the automation is told.
export const TASK_ENDED: Record<string, string> = { "run.succeeded": "做完了", "run.incomplete": "只做完了一部分", "run.failed": "没能做完",
  "run.cancelled": "已取消" };
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
  chatModel(automation: Automation, run: ExecutionRun | null = null, needsVision = false): ModelProfile {
    // API models first: people in a chat app wait for each answer (supervisor.chatOrder).
    const available = this.api.chatModels(true, needsVision).map((model, index) => [model, index] as const)
      .sort(([a, i], [b, j]) => Number(a.channel === "cli") - Number(b.channel === "cli") || i - j).map(([model]) => model);
    let wanted = automation.state.model_id;
    if (!wanted && run && !automation.state.chat_preferences[run.id] && run.supervisor) wanted = run.supervisor.model_id;
    const pick = available.find((model) => model.id === wanted) ?? available[0];
    if (!pick) throw new HttpError(422, "没有可用来对话的模型：请先配置会员 CLI 或 API 模型。");
    return pick;
  }

  /** What a message to an automation becomes, decided as 新建's 自动 decides: every message goes to
   *  the conversation's chat, whose model asks for a task itself once it knows what the work is.
   *  Returns the reply, what it cost and the files sent with it. */
  async message(capability: Capability, asked: Asked, automation: Automation): Promise<Handled> {
    const { api } = this;
    const { db, executor } = api;
    const cheapest = briefWriter(Object.values(api.models), api.configured());
    // What was said where it was not called on (a group chat): kept, and told with the next message
    // it answers, so it knows what the group was talking about.
    const state = automation.state;
    const heard: Record<string, string[]> = (state.heard ??= {});
    const heardFiles: Record<string, string[]> = (state.heard_files ??= {});
    const earlier = asked.conversation ? [...(heard[asked.conversation] ?? [])] : [];
    const filesBefore = asked.conversation ? files.resolveExisting(heardFiles[asked.conversation] ?? []) : [];
    const line = `${asked.sender || "成员"}：${asked.text}` + attachedNote(asked.attachments);
    let judged = 0;
    // Its last answer there, and to whom: a reply to it is meant for it (a group's "西侧", "你继续啊").
    const answered: Json | undefined = asked.conversation ? (state.answered ??= {})[asked.conversation] : undefined;
    const recent = answered && Date.now() / 1000 - (answered.at ?? 0) < FOLLOW_UP_SECONDS ? answered : null;
    if (!asked.addressed && recent?.asked_back && recent.sender === asked.sender) {
      // It asked them something a moment ago; this is the answer.
      asked.addressed = true;
      automation.note(`群里没 @ 它的消息：在回答它刚才的问题，回答（${cut(line, 60)}）`);
    }
    if (!asked.addressed) {
      let context = earlier.join("\n");
      if (recent) context = `${capability.name}（你）刚才回答 ${recent.sender || "成员"}：${recent.said ?? ""}\n${context}`;
      let meant: boolean;
      [meant, judged] = await api.deps.addressed(line, context, capability.name, api.providers, cheapest);
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
    if (asked.text === CALLED_ONLY && !(earlier.length || filesBefore.length || asked.attachments.length || state.notes?.[asked.conversation]?.length)) {
      // Only @-mentioned, with nothing new to answer: say so briefly, not go over the past again.
      return ["在呢，要我做什么？", judged];
    }
    let said = asked.text;
    // What the conversation keeps of it: what was said, plainly; the model is told it with more.
    const shown = earlier.length ? [...earlier, line].join("\n") : asked.text;
    if (earlier.length) {
      said = "群里此前的消息（不是问你的，供参考）：\n" + earlier.join("\n") + `\n\n现在问你的：\n${asked.sender ? line : asked.text}`;
      delete heard[asked.conversation];
    }
    if (asked.people.length) {
      // Who is in the group, by the names an "@" reaches (the package makes "@name" a real @).
      said = `群里的人：${asked.people.join("、")}\n（要 @ 谁就写 @ 加这里的名字，原样照写；发出去就是真正的 @，`
        + "对方会收到提醒。直接 @，不用解释怎么 @ 的；你以前说过只能发纯文字的话不对了。）\n\n" + said;
    }
    // What happened since in FluidForm (a task it had planned ended), told before the message.
    const notesByConversation: Record<string, string[]> = (state.notes ??= {});
    const notes = asked.conversation ? notesByConversation[asked.conversation] ?? [] : [];
    if (asked.conversation) delete notesByConversation[asked.conversation];
    if (notes.length) said = "FluidForm 告诉你，这之后发生了：\n" + notes.map((note) => `- ${note}`).join("\n") + "\n\n" + said;
    if (filesBefore.length) {
      // The pictures and files sent there before, the group's, come with this message.
      const before = new Set(filesBefore.map((item) => item.id));
      asked.attachments = [...filesBefore, ...asked.attachments.filter((item) => !before.has(item.id))].slice(-files.MAX_ATTACHMENTS);
      delete heardFiles[asked.conversation];
    }
    const spent = judged;
    const origin = { ...asked.origin, capability: capability.id };
    const attached = asked.attachments.map((item) => item.id);
    const needsVision = asked.attachments.some((item) => item.kind === "image");
    if (asked.on_text) {
      // The person sees the answer as it is written, never its lines for FluidForm.
      const show = asked.on_text;
      asked.on_text = (text) => show(supervisor.forPerson(text));
    }
    let run: ExecutionRun | null;
    let requested: string | null;
    let pick: ModelProfile;
    let before = 0;
    let extra = 0;
    for (;;) {
      const known = asked.conversation ? state.chats[asked.conversation] : null;
      run = known ? db.getRun(known) : null;
      if (!run || run.kind !== "chat") {
        [requested, pick] = [state.model_id, this.chatModel(automation, null, needsVision)];
        // The answer's lead runs in a task started here, which takes this context along.
        // A new chat of this conversation is told what was kept about its people.
        const remembered = settings.user_memory && asked.conversation ? remembering.facts(remembering.automationKey(capability.id, asked.conversation)) : [];
        const chosen = pick;
        run = streaming.listener.run(asked.on_text, () => api.startChat(remembering.told(remembered) + said, Math.max(automation.remaining(), 0.01), true, null,
          chosen.id, attached, { autoRouted: true, spent, shown }));
        const latest = api.getTask(run.id);
        const prefix = `${capability.name} · `;
        latest.plan.title = prefix + cut(firstLine(asked.text), Math.max(CHAT_TITLE_CHARS - [...prefix].length, 10));
        latest.origin = origin;
        db.saveRun(latest);
        if (asked.conversation) state.chats[asked.conversation] = run.id;
        break;
      }
      const chat = run;
      const active = executor.leadTasks.get(chat.id);
      if (active && !active.done) {
        await active.settled();
        continue;
      }
      const started = await executor.locked(chat.id, () => {
        // Someone may have started a reply while we were waiting for the run lock.
        const answering = executor.leadTasks.get(chat.id);
        if (answering && !answering.done) return false;
        const latest = api.getTask(chat.id);
        if (latest.kind !== "chat") return false;
        [requested, pick] = [state.model_id, this.chatModel(automation, latest, needsVision)];
        const previous = latest.supervisor?.model_id ?? null;
        if (previous !== pick.id) {
          latest.supervisor = supervisor.newSession(pick, latest.supervisor, supervisor.chatFolder(latest));
          latest.lead_seen_attachments = [];
        }
        // Where it is (private or a group), for a chat started before automations said so.
        if (asked.origin.chat_type && !(latest.origin ?? {}).chat_type) latest.origin = { ...(latest.origin ?? {}), chat_type: asked.origin.chat_type };
        // The chat may spend what is left of the automation's day.
        latest.budget_usd = round6(latest.actual_cost_usd + Math.max(automation.remaining(), 0.01));
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
      if (started) break;
    }
    // Remember the preference actually used for this turn, not a later change saved mid-reply.
    state.chat_preferences[run.id] = requested!;
    automation.save();
    const replyId = api.getTask(run.id).lead_messages.at(-1)!.id;
    await executor.leadTasks.get(run.id)?.settled();
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
      text = this.remember(capability, automation, asked, latest, answer.id, text || "");
      let names: string[];
      [text, names] = supervisor.splitSends(text || "");
      if (names.length) {
        sent = this.sendFiles(capability, automation, latest, names);
        const listed = sent.map((path) => basename(path).split("-").slice(1).join("-") || basename(path)).join("、");
        if (sent.length) text = `${text}\n\n（发了：${listed}）`.trim();
        this.recordAnswer(latest.id, answer.id, text);
      }
      text = await this.task(capability, asked, automation, latest, answer.id, text, origin);
      if (asked.conversation && text) {
        const person = supervisor.forPerson(text);
        (state.answered ??= {})[asked.conversation] = { sender: asked.sender, at: Date.now() / 1000, said: [...person].slice(-300).join(""),
          asked_back: /[？?]$/.test(person.trimEnd()) };
        automation.save();
      }
    }
    return [text, cost, sent];
  }

  /** An answer without its REMEMBER and FORGET lines, which update what is kept about this
   *  conversation's people (remembering.ts; settings.user_memory). Without the setting the lines are
   *  only taken out. */
  remember(capability: Capability, automation: Automation, asked: Asked, chat: ExecutionRun, answerId: string, text: string): string {
    const [shown, remembered] = remembering.split(text);
    if (shown === text) return text;
    if (asked.conversation) {
      remembering.take(remembering.automationKey(capability.id, asked.conversation), text);
      if (settings.user_memory) for (const fact of remembered) automation.note(`记下：${cut(fact, 60)}`);
    }
    this.recordAnswer(chat.id, answerId, shown);
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
  recordAnswer(chatId: string, answerId: string, text: string): void {
    const record = this.api.getTask(chatId);
    for (const item of record.lead_messages) if (item.id === answerId) item.text = text;
    this.api.db.saveRun(record);
  }

  /** When the chat's answer asks for a task (its TASK line), plan it, with the conversation as its
   *  background and the chat's files as its own; the answer, without that line, says so. The chat
   *  keeps the answer as the person saw it. */
  async task(capability: Capability, asked: Asked, automation: Automation, chat: ExecutionRun, answerId: string, text: string | null,
    origin: Json): Promise<string | null> {
    let [shown, request] = supervisor.splitTask(text || "");
    if (request === null) return text;
    if ([...request].length < 3) shown = shown || "这件事我没能写清楚，请再说具体一点。";
    else {
      const context = "这个任务来自一段对话，对话内容如下（供参考，以需求为准）：\n" + supervisor.chatTranscript(chat);
      try {
        const task = await this.api.newTask(CreateTask.parse({ prompt: request, attachments: chat.attachments.map((item) => item.id) }), null, context);
        const latest = this.api.getTask(task.id);
        latest.origin = { ...origin, conversation: asked.conversation, chat_run: chat.id };
        latest.auto_routed = true;
        this.api.db.saveRun(latest);
        const estimate = latest.plan.estimate;
        const guess = estimate ? `，预计 $${fixed(estimate.low_usd, 2)}–$${fixed(estimate.high_usd, 2)}` : "";
        shown = `${shown}\n\n我在 FluidForm 里排好了计划「${taskName(latest)}」${guess}，等主人确认后开工，做完在这里告诉你。`.trim();
        automation.note(`排了任务「${taskName(latest)}」`);
      } catch (error) {
        // The answer still goes out, saying planning failed.
        log.error(`planning a task for ${capability.id} failed: ${(error as Error)?.stack ?? error}`);
        const reason = error instanceof HttpError ? error.message : (error as Error)?.message ?? String(error);
        shown = `${shown}\n\n（排计划没成功：${cut(reason, 200)}）`.trim();
      }
    }
    this.recordAnswer(chat.id, answerId, shown);
    return shown;
  }

  /** A task an automation asked for has ended: the automation hears how, with its origin. */
  taskEnded(runId: string, kind: string): void {
    const { db } = this.api;
    const run = db.getRun(runId);
    if (!run || run.kind === "chat" || !run.origin?.capability) return;
    let text = `「${taskName(run)}」${TASK_ENDED[kind] ?? "结束了"}。`;
    const body = (run.final_result || run.error || "").trim();
    if (body) text += "\n\n" + body;
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
      chat.lead_messages.push(LeadMessageSchema.parse({ role: "lead", text }));
      db.saveRun(chat);
    }
    this.runner.notify(run.origin.capability, { event: "task_ended", origin: run.origin, outcome: kind, title: taskName(run), text });
  }
}

function missingReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return "不是这段聊天文件夹里的文件";
  return (error as Error)?.message ?? String(error);
}
