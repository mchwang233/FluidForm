// The task's lead: the strong model that plans a task keeps one conversation with it
// until the task ends, and is asked what to do as things happen (docs/design/supervisor.md).
//
// Here: choosing the lead, starting and continuing its conversation, and handing the task over to a
// new conversation when the old one is lost or its model runs out of quota; the messages the lead is
// sent about events, and reading its decisions.
import * as chat from "./chat.js";
import * as pricing from "./pricing.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProviderError } from "./budget.js";
import { SESSION_CLIS, SessionLost } from "./cli-channels.js";
import { settings } from "./config.js";
import * as folders from "./folders.js";
import { type Attachment, type EngineerJob, type ExecutionRun, folderId, type ModelProfile, partPath, routingReady, type SupervisorSession, SupervisorSessionSchema, type TaskNode } from "./models.js";
import type { ChatTools, ProviderResult, SpendOk } from "./providers.js";
import { head, pyRegex, pyStr, sortedBy } from "./py.js";
import { ModelUnavailable } from "./quota.js";
import * as skills from "./skills.js";
import * as streaming from "./streaming.js";
import { assignmentPrompt } from "./team.js";

type Json = Record<string, any>;

export const ROLE = "You are the lead of a multi-model task in FluidForm. You plan it, and you stay with it "
  + "until it ends: as its steps run on other models, you will be told what happened and asked "
  + "what to do next. Keep the whole task in mind: its goal, the plan and why each step exists, "
  + "and what has happened so far. You may read files and run read-only commands to look things "
  + "up; do not edit anything, the steps' models do the work. Answer in the format each message "
  + "asks for.\n\n";
// An API lead's conversation is sent whole every time; past this, older exchanges are dropped.
export const MAX_HISTORY_CHARS = 300_000;
// Leads tried in turn for one message when a conversation is lost or a model is unavailable.
export const MAX_LEADS = 3;
// Step results quoted in a hand-over.
export const MAX_RESULT_CHARS = 600;
const length = (text: string) => [...text].length;
export const none = (value: unknown) => (value === null || value === undefined ? "None" : String(value));
export const workspaceOf = (run: ExecutionRun) => run.project_dir || join(settings.workspace_root, folderId(run));

/** Possible leads, best first: membership CLIs that keep conversations (no extra cost, and they can
 *  look at the files), then API models; the best planners first. */
export function candidates(models: ModelProfile[], configured: Set<string>, exclude: Iterable<string> = []): ModelProfile[] {
  const excluded = new Set(exclude);
  const eligible = models.filter((model) => model.enabled && routingReady(model) && configured.has(model.id) && !excluded.has(model.id)
    && !settings.helper_only_models.includes(model.id) && model.provider !== "mock" && (model.channel !== "cli" || SESSION_CLIS.has(model.id)));
  // The catalog's price only breaks a tie of scores (a chat's are ordered by the chat package).
  return sortedBy(eligible, (model) => [model.channel !== "cli", -model.scores!.planning, -model.scores!.reliability,
    pricing.enabled() ? (model.input_per_million || 0) + (model.output_per_million || 0) : 0]);
}

/** A fresh conversation for ``model``, in a folder of its own (a CLI conversation is tied to it), or in
 *  ``folder``: a chat's project, which it may read. */
export function newSession(model: ModelProfile, previous: SupervisorSession | null = null, folder: string | null = null): SupervisorSession {
  const session = SupervisorSessionSchema.parse({ model_id: model.id, cwd: folder || folders.leadFolder(model.id) });
  if (previous?.model_id) session.previous = [...previous.previous, previous.model_id];
  return session;
}

/** Keep an API lead's conversation within MAX_HISTORY_CHARS: the first exchange (its role and the plan)
 *  stays, the oldest after it go. */
export function trim(session: SupervisorSession): void {
  const history = session.history as Json[];
  const size = () => history.reduce((sum, item) => sum + length(item.content || ""), 0);
  let dropped = 0;
  while (size() > MAX_HISTORY_CHARS && history.length > 4) {
    history.splice(2, 2);
    dropped += 1;
  }
  if (dropped && !history[2].content.startsWith("[Earlier events")) {
    history[2].content = `[Earlier events of this task were left out to save space; ask for details if you need them.]\n\n${history[2].content}`;
  }
}

// A chat's quick job as it goes, by chat, while it answers (ChatActivity); GET .../lead/activity.
export const CHAT_ACTIVITY = new Map<string, ChatActivity>();
// What each tool is doing, said to the person waiting.
export const TOOL_DOING: Record<string, string> = { Bash: "运行命令", Read: "读文件", Write: "写文件", Edit: "改文件", MultiEdit: "改文件",
  Glob: "找文件", Grep: "搜索", LS: "看目录", StartTask: "安排任务",
  SendFile: "准备发送文件", CallEngineer: "请平台工程师", Remember: "记下来", Forget: "忘掉" };

/** A chat's tool calls as they happen: each starts as running and is replaced by its result
 *  (providers' loop), for the chat's page; whoever waits for the answer as it is written (an automation,
 *  streaming.listener) is told what it is doing. */
export class ChatActivity extends Array<Json> {
  static override get [Symbol.species]() {
    return Array;
  }

  readonly hear = streaming.listener.get();

  starting(name: string, detail: string): void {
    super.push({ turn: 0, tool: name, detail, ok: null, running: true, status: "running" });
    if (this.hear) {
      try {
        this.hear(`（正在${TOOL_DOING[name] ?? name}：${head(detail, 80)}）`);
      } catch {
        // only a courtesy to the listener
      }
    }
  }

  override push(...entries: Json[]): number {
    for (const entry of entries) {
      let replaced = false;
      for (let index = this.length - 1; index >= 0; index -= 1) {
        if (this[index].running && this[index].tool === entry.tool && this[index].detail === entry.detail) {
          this[index] = entry;
          replaced = true;
          break;
        }
      }
      if (!replaced) super.push(entry);
    }
    return this.length;
  }
}

/** What a chat may use for quick jobs (settings.chat_tools): its own scratch folder, the internet if
 *  allowed, its limits per message, and the lines it may write as tools (the chat package says
 *  which). null: only talk (the setting is off, or it is about a project, which a chat only reads). */
export async function chatTools(run: ExecutionRun): Promise<ChatTools | null> {
  if (run.kind !== "chat" || !settings.chat_tools || run.project_dir) return null;
  const folder = join(settings.workspace_root, folderId(run));
  mkdirSync(folder, { recursive: true });
  const tools: ChatTools = { folder, network: settings.chat_tools_network, turns: settings.chat_tool_turns, seconds: settings.chat_tool_seconds, actions: [] };
  tools.actions = (await chat.ask("chat.actions", { ctx: chat.context(run, null, tools) })).names ?? [];
  return tools;
}

/** The skills for the tools a message names, for a chat with tools, as a step gets them. */
export function toolSkills(message: string): string {
  const found = skills.section(skills.forStep(message));
  return found ? `\n\n${found}` : "";
}

/** The first message of a chat's conversation, from the chat package: its role, who ``model`` is,
 *  how to talk where it is, what it remembers, and the folder it may read. Later ones go as they are. */
export async function chatOpening(run: ExecutionRun, text: string, model: ModelProfile | null = null): Promise<string> {
  if (run.supervisor && run.supervisor.calls) return text;
  const tools = model !== null && model.channel !== "cli" ? await chatTools(run) : null;
  return chat.text("chat.opening", { ctx: chat.context(run, model, tools), text });
}

/** What a chat's new conversation with ``model`` is told before the message (a lost conversation, or
 *  another model): its role, and the conversation so far. */
async function chatBriefing(run: ExecutionRun, model: ModelProfile | null): Promise<string> {
  const tools = model !== null && model.channel !== "cli" ? await chatTools(run) : null;
  const ctx = chat.context(run, model, tools);
  return await chat.text("chat.role", { ctx }) + await chat.text("chat.handover", { ctx, current: model ? model.id : null });
}

/** What a new lead needs to take over a running task: the request, the plan and where every step
 *  stands, and the latest problems. */
export function handover(run: ExecutionRun): string {
  const lines = ["You are taking over as the lead of a task that is already under way.", `Request:\n${run.prompt}`,
    ...(run.background ? [`Background:\n${run.background}`] : []), `Plan: ${run.plan.summary}`, `Working directory: ${workspaceOf(run)}`, "Steps:"];
  if (run.plan.employees.length) lines.push(assignmentPrompt(run.plan));
  for (const node of run.plan.nodes) {
    const deps = node.dependencies.length ? ` (after ${node.dependencies.join(", ")})` : "";
    lines.push(`- [${node.id}] ${node.title}${partOf(run, node)}${deps}: ${node.status}, ${node.attempts.length} attempts, model ${none(node.model_id)}`
      + (node.employee_id ? `, employee ${node.employee_id}, delegated by ${none(node.delegation_parent_id)}` : ""));
    const last = node.attempts.at(-1);
    if (node.status === "succeeded" && (node.summary || node.result)) lines.push(`  result: ${head((node.summary || node.result)!, MAX_RESULT_CHARS)}`);
    else if (last && last.outcome !== "passed") lines.push(`  last attempt: ${last.outcome}: ${head(last.reason || "", MAX_RESULT_CHARS)}`);
    if (node.unable_reason) lines.push(`  cannot be done here: ${head(node.unable_reason, MAX_RESULT_CHARS)}`);
  }
  if (run.error) lines.push(`Current problem: ${run.error}`);
  return lines.join("\n") + "\n\n";
}

/** Where a chat's conversation runs: its project, read-only; tasks' leads get folders of their own. */
export function chatFolder(run: ExecutionRun): string | null {
  return run.kind === "chat" ? run.project_dir : null;
}

/** What a new lead (a chat's new conversation) is told before the message. */
const briefing = (run: ExecutionRun, model: ModelProfile | null) => (run.kind === "chat" ? chatBriefing(run, model) : Promise.resolve(ROLE + handover(run)));

/** Bills a call to the task: runs ``call`` with the budget it may spend. */
export type Charged = (modelId: string, call: (budget: SpendOk) => Promise<ProviderResult>) => Promise<ProviderResult>;
export type Conversing = { converse(session: SupervisorSession, text: string, options: { spend_ok?: SpendOk | null; attachments?: Attachment[];
  tools?: ChatTools | null }): Promise<ProviderResult> };

/** Send ``prompt`` to ``session``'s lead through ``charged``, which bills the call to the task: the
 *  reply and the session, now continued. ``tools``: a chat's quick jobs (chatTools). */
export async function converse(providers: Conversing, session: SupervisorSession, prompt: string, charged: Charged, attachments: Attachment[] = [],
  tools: ChatTools | null = null): Promise<[string, SupervisorSession]> {
  const result = await charged(session.model_id!, (budget) => providers.converse(session, prompt, { spend_ok: budget,
    ...(attachments.length ? { attachments } : {}), ...(tools ? { tools } : {}) }));
  if (session.history.length) trim(session);
  return [result.text, session];
}

/** Ask the task's lead; a lost conversation or an unavailable model hands the task over to the next best
 *  lead, which is briefed first. */
export async function ask(providers: Conversing, models: ModelProfile[], configured: Set<string>, run: ExecutionRun, prompt: string,
  charged: Charged, attachments: Attachment[] = []): Promise<[string, SupervisorSession]> {
  let session: SupervisorSession | null = run.supervisor?.model_id ? run.supervisor : null;
  let message = prompt;
  const tried = new Set<string>();
  const byId = new Map(models.map((model) => [model.id, model]));
  let lastError: unknown = null;
  for (let round = 0; round < MAX_LEADS; round += 1) {
    if (session === null) {
      const found = candidates(models, configured, tried);
      // A chat's model is chosen by the chat package.
      const pick = run.kind === "chat" ? (await chat.order(found, Boolean((run.origin || {}).capability)))[0] : found[0];
      if (!pick) break;
      session = newSession(pick, run.supervisor, chatFolder(run));
      message = await briefing(run, pick) + prompt;
    }
    try {
      const model = byId.get(session.model_id!) ?? null;
      const tools = model !== null && model.channel !== "cli" ? await chatTools(run) : null;
      if (tools) {
        const activity = new ChatActivity();
        CHAT_ACTIVITY.set(run.id, activity);
        tools.log = activity;
      }
      try {
        return await converse(providers, session, message + (tools ? toolSkills(message) : ""), charged, attachments, tools);
      } finally {
        if (tools) CHAT_ACTIVITY.delete(run.id);
      }
    } catch (error) {
      if (error instanceof SessionLost) {
        // The model is fine; only its conversation is gone. Brief a new one.
        lastError = error;
        const model = byId.get(session.model_id!) ?? null;
        session = model ? newSession(model, session, chatFolder(run)) : null;
        message = await briefing(run, model) + prompt;
      } else if (error instanceof ModelUnavailable || error instanceof ProviderError || (error as Error)?.name === "TimeoutError") {
        lastError = error;
        tried.add(session.model_id!);
        session = null;
      } else throw error;
    }
  }
  throw new ProviderError(`没有可用的负责人模型：${lastError ? (lastError as Error).message || (lastError as Error).name : "没有可用的模型"}`);
}

// --- deciding what to do after a failed attempt -----------------------------------------------------

/** Where a step sits in a plan made in parts: " in [id] Part › Sub-part". */
export function partOf(run: ExecutionRun, node: TaskNode): string {
  const path = partPath(run.plan, node.part_id);
  return path.length ? ` in [${path.at(-1)!.id}] ${path.map((part) => part.title).join(" › ")}` : "";
}

// Who brought the platform engineer to a step (Diagnosis.trigger), as the lead is told.
export const ENGINEER_CALLERS: Record<string, string> = { lead_repair: "you asked", manual: "the user asked", auto: "after a failure",
  preflight: "before the first step" };
/** The user writing to the lead directly, not answering one of its questions. */
export function chatMessage(text: string): string {
  return "MESSAGE from the user (they can see the task, its steps and your decisions):\n"
    + `${text}\n\n`
    + "Answer in Chinese, in a few sentences, as yourself: the lead who has followed this task. "
    + "No decision JSON is needed here. If they ask for a change (to a step, the plan, or how you "
    + "decide), say what you will do; you will act on it at your next decisions.\n"
    + "The platform engineer (平台工程师) changes FluidForm itself: its sandbox, tools, scheduler or "
    + "model channels. If the user asks for it, or you find that FluidForm itself is at fault or lacks "
    + "a capability the task needs, bring it into this conversation now, not at a later decision: end your "
    + "answer with one line\n"
    + 'ENGINEER: {"kind": "repair or component", "request": "what to repair or add, why, and the evidence"}\n'
    + "A repair is applied once it passes its checks; a component waits for the user's approval. Its plan, "
    + "questions and progress appear in this conversation.";
}

const ENGINEER_LINE = pyRegex(String.raw`^\s*ENGINEER:\s*(\{.*\})\s*$`, "m");
export type EngineerCall = { kind: "repair" | "component"; request: string };

/** A call for the platform engineer ({kind, request}), or null if it is not one. */
export function readEngineer(value: unknown): EngineerCall | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Json;
  if (!pyStr(item.request || "").trim()) return null;
  const kind = pyStr(item.kind || "repair").trim();
  return { kind: kind === "repair" || kind === "component" ? kind : "repair", request: head(pyStr(item.request).trim(), 6000) };
}

/** A chat answer without its ENGINEER line, and the call that line makes. */
export function splitEngineer(text: string): [string, EngineerCall | null] {
  const found = ENGINEER_LINE.exec(text || "");
  if (!found) return [text, null];
  let call: EngineerCall | null = null;
  try {
    call = readEngineer(JSON.parse(found[1]));
  } catch {
    call = null;
  }
  return [(text.slice(0, found.index) + text.slice(found.index + found[0].length)).trim(), call];
}

export const ENGINEER_STATES: Record<string, string> = { queued: "queued", planning: "writing its plan", plan_ready: "plan written, waiting for the user's approval",
  needs_input: "waiting for the user's answer", editing: "making the change in a copy", validating: "checking the change",
  ready: "change checked, waiting for the user to apply it", applying: "being applied (FluidForm restarts)", applied: "applied", failed: "failed",
  rejected: "given up by the user", cancelled: "cancelled" };

/** What changed in the platform engineer's work for this task since the lead last heard. */
export function engineerUpdates(jobs: EngineerJob[]): string {
  const lines = ["UPDATE from the platform engineer (平台工程师) on its work for this task:"];
  for (const job of jobs) {
    lines.push(`- [${job.id}] ${job.kind} "${job.title}": ${ENGINEER_STATES[job.status] ?? job.status}`);
    if ((job.status === "applied" || job.status === "failed") && (job.report || job.error)) lines.push(`  ${head((job.error || job.report)!, 600)}`);
  }
  return lines.join("\n") + "\n\n";
}

export type Decision = { action: string; reason?: string; instructions?: string; model_id?: string; question?: string; user_action?: string;
  options: string[]; summary?: string; kind?: "repair" | "component"; engineer?: EngineerCall; targets?: string[]; plan?: Json };
