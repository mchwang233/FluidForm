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
import * as capabilities from "./capabilities.js";
import { chatGuide as packageGuide } from "./capability-packages.js";
import { SESSION_CLIS, SessionLost } from "./cli-channels.js";
import { settings } from "./config.js";
import { NETWORK_CHOICE, toolSummary } from "./diagnosis.js";
import * as folders from "./folders.js";
import { type Attachment, type EngineerJob, type ExecutionRun, folderId, type ModelProfile, type NodeAttempt, Outcome, partPath, routingReady, scoreFor,
  type SupervisorSession, SupervisorSessionSchema, type TaskNode } from "./models.js";
import type { ChatTools, ProviderResult, SpendOk } from "./providers.js";
import { fixed, formatG, head, pyRegex, pyStr, sortedBy, truthy } from "./py.js";
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
const none = (value: unknown) => (value === null || value === undefined ? "None" : String(value));
const workspaceOf = (run: ExecutionRun) => run.project_dir || join(settings.workspace_root, folderId(run));

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

export const ACTIONS = ["retry", "switch_model", "accept", "unable", "ask_user", "repair_environment", "repair_platform", "request_component",
  "call_engineer", "rework", "replan", "done"];
// The three ways of asking for a repair or a component, which settings.engineer_repairs folds into
// call_engineer: the platform engineer then decides how to repair (docs/design/one-engineer.md).
export const SEPARATE_REPAIRS = ["repair_environment", "repair_platform", "request_component"];

/** The actions the lead is offered; every one in ACTIONS is still read (old decisions). */
export function offeredActions(): string[] {
  const leftOut = settings.engineer_repairs ? SEPARATE_REPAIRS : ["call_engineer"];
  return ACTIONS.filter((action) => !leftOut.includes(action));
}
// What the lead may answer when every step has finished.
export const FINAL_ACTIONS = ["done", "rework", "replan"];
export const ACTION_RULES: Record<string, string> = {
  rework: "- rework: send the steps listed in targets back to be redone, with instructions "
    + "saying exactly what to change. Only for real problems the task needs fixed; not for new "
    + "requirements the task never asked for, and not when the verification itself is wrong.\n",
  retry: "- retry: the same model again. Only if the next attempt will do something materially different.\n",
  switch_model: "- switch_model: another model from the list takes the step (a model that keeps failing it, or one too weak for it).\n",
  accept: "- accept: the result is good enough for the task's goal although its check failed (the check "
    + "was wrong, or asked for more than the task needs); say why.\n",
  unable: "- unable: the step's goal cannot be reached in this environment and no repair can change that "
    + "(hardware, an account, a licence or credentials the task does not have). The rest of the "
    + "task goes on without it.\n",
  ask_user: "- ask_user: only the user can decide or provide something (a choice, credentials, budget, "
    + "permission). The task pauses until they answer.\n",
  repair_environment: "- repair_environment: something outside the task blocks it (missing software, sandbox "
    + "or machine limits, configuration). A repair session with access to this machine "
    + "fixes it, then the step runs again.\n",
  repair_platform: "- repair_platform: FluidForm itself (its scheduler, tools or sandbox) is at fault; say "
    + "what and where. Its platform engineer (平台工程师) makes a source repair, checked and "
    + "applied, then the task continues.\n",
  request_component: "- request_component: the task needs a capability FluidForm does not have (a tool for "
    + "the steps, a model channel, a kind of step or check) and no repair of a defect would "
    + "give it. Say in instructions what to add and why. FluidForm's platform engineer "
    + "(平台工程师) plans it, the user approves, and it is built, checked and applied; the task waits, "
    + "then you decide again.\n",
  call_engineer: "- call_engineer: bring in FluidForm's platform engineer (平台工程师) with the evidence in "
    + "instructions. kind \"repair\" when something outside the step's own work blocks it: the "
    + "machine (missing software, sandbox or machine limits, configuration, licences) or FluidForm "
    + "itself (its scheduler, tools or sandbox); the engineer finds which and repairs it, here or "
    + "in FluidForm's source, then you decide again. kind \"component\" when the task needs a "
    + "capability FluidForm does not have and no repair would give it; the user approves its plan "
    + "first and the task waits.\n",
  replan: "- replan: change the plan in \"plan\": add steps, remove steps that have not finished, or rewrite "
    + "the instructions of steps that have not finished (splitting a step that is too big, adding a "
    + "missing prerequisite, dropping one the task does not need). Finished steps stay as they are.\n",
  done: "- done: the result does what the request asked; the task ends.\n",
};
export const PLAN_FORMAT = '"plan": {"add": [{"key": "new1", "title": "...", "instructions": "...", "acceptance_criteria": "...", '
  + '"capability": "coding | planning | research | chinese | tool_use | structured_output", '
  + '"difficulty": "easy | normal | hard", "dependencies": ["ids of existing steps or keys of added ones"], '
  + '"verifies": ["optional: ids or keys of steps this one verifies"], '
  + '"files": ["files it creates or changes, at most 5"], "reads": ["files it reads for reference"], '
  + '"provides": "what later steps can rely on", "check": "a command that shows it works", '
  + '"part": "optional: id of the plan part it belongs to; by default the part of the step decided on"}], '
  + '"remove": ["ids of steps that have not finished"], '
  + '"update": [{"id": "...", "title": "optional", "instructions": "optional", "acceptance_criteria": "optional", '
  + '"dependencies": ["optional: the full new list"], "files": ["optional: the full new list"], '
  + '"reads": ["optional"], "provides": "optional", "check": "optional"}]}';

// The task's result is what the user reads when it ends: the lead, which has seen every step, writes it,
// rather than the output of whichever step happened to run last.
export const SUMMARY_FORMAT = '"summary": "done only: the task\'s result for the user, in the language of the request: '
  + "what was delivered, with links to the main files, how it was checked, and what is not done or "
  + 'only partly verified. A few short paragraphs or a short list, not the history of the work", ';

/** How to answer; a failed verification may also send steps back (``rework``), and when every step has
 *  finished (``final``) the lead says whether the task is done. */
export function decisionFormat(rework = false, final = false): string {
  const actions = final ? [...FINAL_ACTIONS] : offeredActions().filter((action) => action !== "done" && (rework || action !== "rework"));
  const engineer = actions.includes("call_engineer");
  return "Reply with only a JSON object:\n"
    + `{"action": "${actions.join(" | ")}", `
    + '"reason": "one or two sentences in Chinese, shown to the user", '
    + '"instructions": "for retry / switch_model / rework: exactly what must be done differently; '
    + (engineer ? 'for call_engineer: what blocks the step and the evidence, or what to add and why", '
      + '"kind": "call_engineer only: repair | component", '
      : 'for repair_*: what to repair; for request_component: what to add and why", ')
    + '"model_id": "switch_model only: one of the models listed", '
    + (rework || final ? '"targets": ["rework only: ids of the steps to redo"], ' : "")
    + (final ? SUMMARY_FORMAT : "")
    + (actions.includes("replan") ? PLAN_FORMAT + ", " : "")
    + '"question": "ask_user only, in Chinese", "options": ["ask_user only: up to 4 answers"], '
    + '"user_action": "unable only: what the user could do to make it possible", '
    + '"engineer": {"kind": "repair | component", "request": "optional, with any action: a fault in Super '
    + "Partner itself, or a capability it lacks, that you found and this decision does not deal with; the "
    + "platform engineer (平台工程师) joins the task's conversation and works on it in the background\"}}\n"
    + actions.map((action) => ACTION_RULES[action]).join("");
}

/** The decision format with nothing extra (Python's DECISION_FORMAT, made when the module loads). */
export const DECISION_FORMAT = decisionFormat();
export const MAX_EVIDENCE_CHARS = 1500;

/** Where a step sits in a plan made in parts: " in [id] Part › Sub-part". */
export function partOf(run: ExecutionRun, node: TaskNode): string {
  const path = partPath(run.plan, node.part_id);
  return path.length ? ` in [${path.at(-1)!.id}] ${path.map((part) => part.title).join(" › ")}` : "";
}

const steps = (run: ExecutionRun) => run.plan.nodes.map((node) => `- [${node.id}] ${node.title}${partOf(run, node)}: ${node.status}`);
const modelLines = (choices: ModelProfile[], node: TaskNode) => choices.map((model) =>
  `- ${model.id} (${model.channel}, ${node.capability} ${formatG(scoreFor(model.scores!, node.capability))}, reliability ${formatG(model.scores!.reliability)})`);

export function blockedNote(): string {
  const repair = settings.engineer_repairs ? "call_engineer (kind repair)" : "repair_environment or repair_platform";
  return "This step stopped as BLOCKED: something it needs is missing or a target it must meet was not "
    + "reached (see why above). Decide what unblocks it: rework the steps it builds on (targets) with "
    + "instructions saying exactly what to add or fix, which redoes them and then this step; "
    + `${repair} when the machine or FluidForm is at fault; retry when `
    + "something has changed; accept when what it delivered is enough for the request; ask_user when "
    + "only the user can decide (for example whether a target can be relaxed); unable to stop.";
}

// Who brought the platform engineer to a step (Diagnosis.trigger), as the lead is told.
export const ENGINEER_CALLERS: Record<string, string> = { lead_repair: "you asked", manual: "the user asked", auto: "after a failure",
  preflight: "before the first step" };
export const MAX_ENGINEER_LOOKS = 3;

/** What the platform engineer found and did on this step (or the whole task) so far, so the lead does not
 *  send it to repair what it has already repaired, or decide against what it found. */
export function engineerLooks(run: ExecutionRun, node: TaskNode): string[] {
  const looks = run.diagnoses.filter((item) => item.trigger in ENGINEER_CALLERS && item.status !== "running"
    && (item.node_id === node.id || item.node_id === null)).slice(-MAX_ENGINEER_LOOKS);
  const lines = looks.map((item) => {
    const found = head((item.report || item.error || "").trim().replaceAll("\n", " "), 400);
    return `- ${ENGINEER_CALLERS[item.trigger]}: ${item.verdict || item.status}`
      + (item.user_action ? `; to do for the user: ${head(item.user_action, 200)}` : "") + (found ? `. ${found}` : "");
  });
  return lines.length ? ["What the platform engineer (平台工程师) found and did here so far:", ...lines] : [];
}

// A step that stops over a requirement nobody set for it: in the axi-to-apb task one step wrote "every
// legal parameter combination" into its own requirements list and a later step stopped twice over it.
// Whether the task needs it is the lead's call, made once, not the step's.
export const BEYOND_THE_BAR = "If it stopped over a requirement that is neither in the request nor in these criteria (one a "
  + "step wrote down itself, for example in a requirements list), decide whether the request needs "
  + "it rather than following it: if not, retry with instructions to list it as an open point; if "
  + "it does, say why in your reason and keep it from then on.";

export type Verdict = { reason: string; fix?: string | null };

/** Tell the lead an attempt of ``node`` failed, with the evidence, and ask what to do; ``upstream``: the
 *  finished steps it builds on, which rework may send back. */
export function failureMessage(run: ExecutionRun, node: TaskNode, attempt: NodeAttempt, verdict: Verdict, choices: ModelProfile[],
  left: [number, number], upstream: Set<string> | null = null): string {
  const earlier = node.attempts.slice(0, -1).slice(-6).map((item) => `- ${none(item.model_id)}: ${item.outcome}: ${head(item.reason || "", 200)}`);
  const lines = [
    `EVENT: an attempt failed. Step [${node.id}] ${node.title} (${node.capability}, ${node.difficulty}).`,
    `Attempt ${node.attempts.length} by ${none(attempt.model_id)}: ${attempt.outcome}.`,
    `Why it was not accepted: ${verdict.reason}`,
    ...(verdict.fix && verdict.fix !== verdict.reason ? [`What the check says to change: ${verdict.fix}`] : []),
    ...(node.acceptance_criteria ? [`Its acceptance criteria, as you set them: ${node.acceptance_criteria}`] : []),
    ...(attempt.outcome === Outcome.BLOCKED || attempt.outcome === Outcome.UNABLE ? [BEYOND_THE_BAR] : []),
    ...(node.result ? [`Its answer (start):\n${head(node.result, MAX_EVIDENCE_CHARS)}`] : []),
    ...(attempt.tool_calls.length ? [toolSummary(attempt, true)] : []),
    `Files this step has changed: ${node.changed_files.slice(0, 30).join(", ") || "(none)"}`,
    ...(earlier.length ? ["Earlier attempts of this step:", ...earlier] : []),
    ...engineerLooks(run, node),
    "Where the steps stand:", ...steps(run),
    "Models that can take this step:", ...modelLines(choices, node),
    ...(upstream?.size ? [`Steps it builds on, which rework may send back: ${[...upstream].sort().join(", ")}`] : []),
    `Decisions left: ${left[0]} for this step, ${left[1]} for the task; after that the task pauses for the user.`,
    run.allow_network ? "This task allows the internet." : "This task does not allow the internet. If the step itself must reach it while it runs, "
      + `ask_user with "${NETWORK_CHOICE}" among the options; choosing it allows the internet at once.`,
    "",
    `Decide what to do with this step. You may look at the files in the working directory (${workspaceOf(run)}) first.`,
    decisionFormat(Boolean(upstream?.size)),
  ];
  return lines.join("\n");
}

/** Added to a failure at a contract step's declared limit: what deciding to go on grants. */
export function limitNote(node: TaskNode, granted: { max_turns: number; max_cost_usd: number }): string {
  const contract = node.artifact_contract!;
  const outputs = contract.outputs.map((item) => item.path).join(", ");
  return `This step stopped at its declared limit (${none(contract.max_turns)} tool calls, $${formatG(contract.max_cost_usd ?? 0)}); it has used `
    + `${Math.max(node.contract_turns, node.contract_tool_calls)} calls and $${fixed(node.contract_cost_usd, 4)}. Its declared outputs: ${outputs}. Deciding retry, `
    + `switch_model or replan grants it more: up to ${granted.max_turns} tool calls and $${formatG(granted.max_cost_usd)} in all, keeping what it has written. `
    + "Say in instructions what it must finish first. To make the work smaller, replan into smaller steps; to stop, decide unable.";
}

/** Tell the lead a verification failed, with what it found and what it checked, and ask whether to send work back. */
export function verificationMessage(run: ExecutionRun, verifier: TaskNode, verdict: Verdict, choices: ModelProfile[], left: [number, number]): string {
  const verified = run.plan.nodes.filter((node) => verifier.verifies.includes(node.id));
  const lines = [
    `EVENT: a verification failed. Step [${verifier.id}] ${verifier.title} checks ` + verified.map((node) => `[${node.id}] ${node.title}`).join(", ") + ".",
    `What it found: ${verdict.reason}`,
    ...(verdict.fix && verdict.fix !== verdict.reason ? [`What it says to change: ${verdict.fix}`] : []),
    `Its report (start):\n${head(verifier.result || "", MAX_EVIDENCE_CHARS)}`,
    `Work sent back so far in this task: ${run.rework_rounds} times.`,
    "The steps it checks:",
  ];
  for (const node of verified) {
    lines.push(`- [${node.id}] ${node.title}, by ${none(node.model_id)}, ${node.attempts.length} attempts; review: ${head(node.review || "", 300)}`);
    lines.push(`  result: ${head(node.summary || node.result || "", 800)}`);
  }
  lines.push("Where the steps stand:", ...steps(run), "Models that can run the verification:", ...modelLines(choices, verifier),
    `Decisions left: ${left[0]} for this step, ${left[1]} for the task; after that the task pauses for the user.`, "",
    "Judge the findings first: are they real problems the task needs fixed, new requirements it never asked for, or mistakes of the verification itself? Then decide.",
    decisionFormat(true));
  return lines.join("\n");
}

/** Every step has finished: the lead checks the result as a whole against the request. */
export function finalMessage(run: ExecutionRun, left: number): string {
  const lines = ["EVENT: every step has finished. Before the task ends, check the result as a whole against "
    + "the request: does it really do what was asked, and do the pieces fit together?", `Request:\n${run.prompt}`,
  `Working directory: ${workspaceOf(run)}`, "The steps and their results:"];
  for (const node of run.plan.nodes) {
    lines.push(`- [${node.id}] ${node.title} (by ${none(node.model_id)}): ${head(node.review || "", 200)}`);
    lines.push(`  result: ${head(node.summary || node.result || "", 800)}`);
  }
  lines.push(`Decisions left for the task: ${left}.`, "", "You may look at the files first. If something the request asked for is missing or wrong, "
    + "rework the steps that should fix it, or replan to add what is missing.", decisionFormat(false, true));
  return lines.join("\n");
}

/** A work package taking far more turns than planned: going on, or stopped (and then split). */
export function overrunMessage(node: TaskNode, turns: number, expected: number, evidence: string): string {
  return [`EVENT: work package [${node.id}] ${node.title} was planned for about ${expected} tool turns and has taken ${turns}.`,
    `Its files: ${node.files.join(", ") || "-"}; reads: ${node.reads.join(", ") || "-"}`, `What it has been doing:\n${evidence}`,
    "Is it still doing its own package and close to done, or is the package too big, under-specified, "
    + "or going wrong? Stopped, the attempt fails and you then decide what to do (for a package too "
    + "big: replan to split it). End with exactly one line: `VERDICT: CONTINUE` or `VERDICT: STOP: <why, in Chinese>`."].join("\n");
}

/** A step the rest of the task waits for, running far past its expected time on its model. */
export function criticalOverrunMessage(node: TaskNode, modelId: string, minutes: number, expected: number, waiting: string[], evidence: string): string {
  return [`EVENT: step [${node.id}] ${node.title} has run ${fixed(minutes, 0)} minutes on ${modelId}; about ${fixed(expected, 0)} were expected. `
    + `It is not stuck, but ${waiting.length} steps wait for it: ` + waiting.slice(0, 8).join("; ") + ".", `What it has been doing:\n${evidence}`,
  "Should it go on, or stop so that you can give it to a faster model (switch_model) or split it? "
    + "Its files stay in the working directory for the next attempt. Stop it only if it is slow or "
    + "off track, not when it is about to finish. End with exactly one line: `VERDICT: CONTINUE` or `VERDICT: STOP: <why, in Chinese>`."].join("\n");
}

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

export const MAX_REPAIR_REPORT = 3000;

/** The repair the lead asked for has ended: hand it its outcome before the step runs again. */
export function repairMessage(run: ExecutionRun, node: TaskNode, diagnosis: { status: string; verdict: string | null; error: string | null; report: string | null },
  choices: ModelProfile[], left: [number, number]): string {
  const outcome = diagnosis.status === "done" ? `It ended with status ${diagnosis.verdict || "none"}.` : `It did not finish: ${diagnosis.error || "no reason given"}.`;
  return [`EVENT: the repair you asked for step [${node.id}] ${node.title} has ended. ${outcome}`, `Its report:\n${head(diagnosis.report || "(none)", MAX_REPAIR_REPORT)}`,
    "Where the steps stand:", ...steps(run), "Models that can take this step:", ...modelLines(choices, node),
    `Decisions left: ${left[0]} for this step, ${left[1]} for the task; after that the task pauses for the user.`, "",
    "Decide what to do with the step now. Run it again only if the report shows the obstacle was "
    + "removed and checked (for example a login or command that now works); if the repair did not "
    + "do that, do not send the step back to meet the same obstacle: repair again differently, ask the user, or mark it unable.",
    DECISION_FORMAT].join("\n");
}

export const ENGINEER_OUTCOMES: Record<string, string> = { applied: "It was built, checked and applied: FluidForm now has it.",
  failed: "It could not be built or applied.", rejected: "The user gave it up: it will not be added.", cancelled: "It was cancelled." };

/** The component the lead asked the platform engineer for is done with: its outcome. */
export function engineerMessage(run: ExecutionRun, node: TaskNode, job: EngineerJob, choices: ModelProfile[], left: [number, number]): string {
  const talk = job.messages.slice(-6).filter((item) => item.role === "user" || item.role === "engineer").map((item) => `- ${item.role}: ${head(item.text, 400)}`);
  return [`EVENT: the component you asked for, for step [${node.id}] ${node.title}, is done with. ` + (ENGINEER_OUTCOMES[job.status] ?? `It ended as ${job.status}.`),
    `What you asked for: ${head(job.request, 800)}`, ...(job.plan ? [`The plan:\n${head(job.plan, MAX_REPAIR_REPORT)}`] : []),
    ...(job.report ? [`Its report:\n${head(job.report, MAX_REPAIR_REPORT)}`] : []), ...(job.error ? [`Why it failed: ${head(job.error, 800)}`] : []),
    ...(job.files.length ? [`Changed files: ${job.files.slice(0, 30).join(", ")}`] : []), ...(talk.length ? ["What the user and the engineer said:", ...talk] : []),
    "Where the steps stand:", ...steps(run), "Models that can take this step:", ...modelLines(choices, node),
    `Decisions left: ${left[0]} for this step, ${left[1]} for the task; after that the task pauses for the user.`, "",
    "Decide what to do with the step now. Without the component, do not send the step back to the same wall.", DECISION_FORMAT].join("\n");
}

/** Hand the user's answer to the lead's question back to it. */
export function answerMessage(node: TaskNode, question: string, answer: string, rework = false): string {
  return [`EVENT: the user answered your question about step [${node.id}] ${node.title}.`, `Your question: ${question}`, `Their answer: ${answer}`, "",
    "Decide what to do with this step now.", decisionFormat(rework)].join("\n");
}

export type Decision = { action: string; reason?: string; instructions?: string; model_id?: string; question?: string; user_action?: string;
  options: string[]; summary?: string; kind?: "repair" | "component"; engineer?: EngineerCall; targets?: string[]; plan?: Json };

/** The decision in the lead's reply, or null if there is no valid one. ``targets`` are the steps rework
 *  may send back; without them, rework is not a valid answer. ``final``: every step has finished, and
 *  only done, rework and replan are. */
export function parseDecision(text: string | null | undefined, modelIds: Set<string>, targets: Set<string> | null = null, final = false): Decision | null {
  const reply = text || "";
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let payload: any;
  try {
    payload = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  const allowed = final ? FINAL_ACTIONS : ACTIONS.filter((action) => action !== "done");
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !allowed.includes(payload.action)) return null;
  const clean: Json = {};
  for (const key of ["action", "reason", "instructions", "model_id", "question", "user_action"]) if (truthy(payload[key])) clean[key] = pyStr(payload[key]).trim();
  const options = payload.options;
  clean.options = Array.isArray(options) ? options.filter((item) => pyStr(item).trim()).map((item) => head(pyStr(item).trim(), 300)).slice(0, 4) : [];
  if (clean.action === "switch_model" && !modelIds.has(clean.model_id)) return null;
  if (clean.action === "ask_user" && !clean.question) return null;
  if ((clean.action === "request_component" || clean.action === "call_engineer") && !(clean.instructions || clean.reason)) return null;
  if (clean.action === "done" && pyStr(payload.summary || "").trim()) clean.summary = head(pyStr(payload.summary).trim(), 6000);
  if (clean.action === "call_engineer") clean.kind = payload.kind === "component" ? "component" : "repair";
  const call = readEngineer(payload.engineer);
  if (call) clean.engineer = call;
  if (clean.action === "rework") {
    const chosen = truthy(payload.targets) ? payload.targets : [...(targets ?? [])].sort();
    if (!targets?.size || !Array.isArray(chosen) || !chosen.every((item) => targets.has(pyStr(item)))) return null;
    clean.targets = chosen.map((item: unknown) => pyStr(item));
  }
  if (clean.action === "replan") {
    const plan = payload.plan;
    if (!plan || typeof plan !== "object" || Array.isArray(plan) || !["add", "remove", "update"].some((key) => truthy(plan[key]))) return null;
    clean.plan = plan;
  }
  return clean as Decision;
}
