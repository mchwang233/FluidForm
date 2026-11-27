// The API's chats routes (app.ts builds the app and adds them).
import { chatPlan, CreateTask, HttpError, parse, round6, StartRequest } from "../api.js";
import * as files from "../attachments.js";
import * as chat from "../chat.js";
import { taskFolder } from "../folders.js";
import { briefWriter } from "../routing.js";
import * as supervisor from "../supervisor.js";
import { which } from "../environment.js";
import type { FastifyInstance } from "fastify";
import { CreateChat, PromoteChat, Query, chatRequired, event, queryBool } from "./common.js";
import type { RouteContext } from "./context.js";

export function chatsRoutes(app: FastifyInstance, { api, db, executor, providers }: RouteContext): void {
  // ---- Chats ----

  app.get("/api/chats/models", async (request) => (chat.enabled() ? await api.chatChoices(queryBool(request.query as Query, "use_cli", true)) : [])
    .map((model) => ({ id: model.id, display_name: model.display_name, channel: model.channel })));

  // Only a conversation: no plan, no steps. The model may read the project folder, if one is given
  // (a CLI's read-only lead conversation there); it edits nothing. The first message is answered in
  // the background, as in a task's conversation with its lead.
  app.post("/api/chats", async (request, reply) => {
    const body = parse(CreateChat, request.body);
    chatRequired();
    return reply.code(201).send(await api.startChat(body.message, body.budget_usd, body.use_cli, body.project_dir, body.model_id, body.attachments));
  });

  // Start what the user typed as a chat or a task, decided by triage.classify (told the names of any
  // attachments, which go with either). Deciding is billed to whichever it becomes.
  app.post("/api/start", async (request, reply) => {
    const body = parse(StartRequest, request.body);
    const attached = api.attached(body.attachments, 400);
    // Without the chat capability everything typed is a task.
    const [kind, spent] = chat.enabled() ? await api.deps.classify(body.prompt + files.describe(attached, false), providers(),
      await briefWriter(Object.values(api.models), api.configured())) : ["task", 0];
    if (kind === "chat") {
      return reply.code(201).send(await api.startChat(body.prompt, body.budget_usd, body.use_cli, body.project_dir, body.model_id, body.attachments,
        { autoRouted: true, spent }));
    }
    const run = await api.newTask(body);
    const latest = api.getTask(run.id);
    latest.auto_routed = true;
    latest.actual_cost_usd = round6(latest.actual_cost_usd + spent);
    db.saveRun(latest);
    return reply.code(201).send(latest);
  });

  // A task waiting for confirmation was only a question: keep it as a chat instead, answered by the
  // best chat model from its request. Its plan is dropped; planning stays paid.
  app.post<{ Params: { run_id: string } }>("/api/tasks/:run_id/as-chat", async (request) => {
    const runId = request.params.run_id;
    const run = api.getTask(runId);
    if (run.kind !== "task" || run.status !== "awaiting_confirmation" || run.parent_run_id) throw new HttpError(409, "只有待确认的新任务可以改成对话。");
    if (api.replanning.has(runId)) throw new HttpError(409, "正在重新规划，请稍候。");
    chatRequired();
    const pick = (await api.chatChoices(run.use_cli, run.attachments.some((item) => item.kind === "image")))[0];
    if (!pick) throw new HttpError(422, "没有可用来对话的模型：请先配置会员 CLI 或 API 模型。");
    Object.assign(run, { kind: "chat", status: "draft", plan: chatPlan(run.prompt, run.project_dir), supervisor: supervisor.newSession(pick, null, run.project_dir) });
    db.saveRun(run);
    db.addEvent(event(runId, "task.to_chat", { model_id: pick.id }));
    executor().startLeadChat(runId, run.prompt);
    return api.getTask(runId);
  });

  // Turn a chat into a task, in place: it is planned with the conversation as its background and
  // waits for confirmation like any new task. Its id and messages stay.
  app.post<{ Params: { run_id: string } }>("/api/tasks/:run_id/promote", async (request) => {
    const body = parse(PromoteChat, request.body);
    const runId = request.params.run_id;
    const run = api.getTask(runId);
    if (run.kind !== "chat" || run.status !== "draft") throw new HttpError(409, "只有对话可以转成任务。");
    const answering = executor().leadTasks.get(runId);
    if ((answering && !answering.done) || api.replanning.has(runId)) throw new HttpError(409, "对方还在回复，请等它说完再转成任务。");
    const prompt = body.prompt.trim() || run.prompt;
    if ([...prompt].length < 3) throw new HttpError(422, "请写清要完成的工作。");
    const useCli = body.use_cli ?? run.use_cli;
    chatRequired();
    const context = "这个任务来自用户和模型的一段对话，对话内容如下（供参考，以“新需求”为准）：\n" + await chat.transcript(run);
    // The chat's attachments go with it: the planner and the steps see them as a task's own.
    const given = CreateTask.parse({ prompt, budget_usd: body.budget_usd, use_cli: useCli, project_dir: run.project_dir, allow_network: body.allow_network,
      attachments: [...new Set([...run.attachments.map((item) => item.id), ...body.attachments])] });
    api.replanning.add(runId);
    let made;
    try {
      made = await api.makePlan(given, null, "", context);
    } finally {
      api.replanning.delete(runId);
    }
    const latest = api.getTask(runId);
    if (latest.kind !== "chat" || latest.status !== "draft") throw new HttpError(409, "对话在规划期间已改变，新计划未采用。");
    Object.assign(latest, { kind: "task", status: "awaiting_confirmation", prompt, plan: made.plan, budget_usd: body.budget_usd, use_cli: useCli,
      allow_network: body.allow_network, background: made.background, improvement_uses: made.lessons });
    // The planner leads the task from here; the chat's messages stay in its conversation.
    latest.supervisor = made.session.model_id ? made.session : latest.supervisor;
    latest.actual_cost_usd = round6(latest.actual_cost_usd + made.plan.planning_cost_usd);
    if (!latest.project_dir) latest.folder_name = taskFolder(made.plan.folder || made.plan.summary || prompt);
    db.saveRun(latest);
    db.addEvent(event(runId, "chat.promoted", { estimate: made.plan.estimate ?? null, planner_model_id: made.plan.planner_model_id }));
    return latest;
  });

}
