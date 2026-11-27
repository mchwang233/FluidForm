// The API's tasks routes (app.ts builds the app and adds them).
import { uses } from "../features.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { brief, CreateTask, decidedChoices, FINISHED, HttpError, parse, round6 } from "../api.js";
import * as files from "../attachments.js";
import * as chat from "../chat.js";
import { settings } from "../config.js";
import { NETWORK_CHOICE } from "../diagnosis.js";
import { DiagnosisMessageSchema, type ExecutionRun } from "../models.js";
import { fixed } from "../py.js";
import { stepKey } from "../review.js";
import * as retrospect from "../retrospect.js";
import { eligibleForNode, NoEligibleModelError, routeNode } from "../routing.js";
import * as supervisor from "../supervisor.js";
import * as team from "../team.js";
import type { FastifyInstance } from "fastify";
import { CHANGEABLE, ChoiceAnswers, ConfirmTask, DiagnosisReply, FollowUp, LeadQuestion, NetworkAccess, Query, SHOWN_CHANGED_FILES, SHOWN_COMMAND_CHARS, chatRequired, event, intParam, pyIndex, pyStatus, queryBool, queryInt, reopenNode, text } from "./common.js";
import type { RouteContext } from "./context.js";

export function tasksRoutes(app: FastifyInstance, { api, db, executor, providers, unchangedOr }: RouteContext): void {
  // ---- Tasks ----

  app.post("/api/tasks", async (request, reply) => reply.code(201).send(await api.newTask(parse(CreateTask, request.body))));

  // The user answered the plan's open choices (TaskPlan.choices) before confirming: when an answer
  // differs from what the lead assumed, the task is planned again with the answers, in place. Its id,
  // folder, budget and settings stay.
  app.post<{ Params: { run_id: string } }>("/api/tasks/:run_id/choices", async (request) => {
    const body = parse(ChoiceAnswers, request.body);
    const runId = request.params.run_id;
    const run = api.getTask(runId);
    if (run.status !== "awaiting_confirmation") throw new HttpError(409, "只有待确认的任务可以按选择重新规划。");
    if (body.picks.length !== run.plan.choices.length) throw new HttpError(422, "每条取舍都要有一个选择。");
    const decided = decidedChoices(run.plan.choices, body.picks);
    if (!decided) return run;
    if (api.replanning.has(runId)) throw new HttpError(409, "正在按你的选择重新规划，请稍候。");
    api.replanning.add(runId);
    let made;
    try {
      const parent = run.parent_run_id ? db.getRun(run.parent_run_id) : null;
      const again = CreateTask.parse({ prompt: run.prompt, attachments: run.attachments.map((item) => item.id), budget_usd: run.budget_usd,
        use_cli: run.use_cli, only_models: run.only_models, cli_only: run.cli_only, project_dir: run.project_dir, allow_network: run.allow_network });
      made = await api.makePlan(again, parent, decided);
    } finally {
      api.replanning.delete(runId);
    }
    const latest = api.getTask(runId);
    if (latest.status !== "awaiting_confirmation") throw new HttpError(409, "任务在重新规划期间已改变状态，新计划未采用。");
    latest.plan = made.plan;
    latest.improvement_uses = made.lessons;
    latest.supervisor = made.session.model_id ? made.session : latest.supervisor;
    latest.actual_cost_usd = round6(latest.actual_cost_usd + made.plan.planning_cost_usd);
    db.saveRun(latest);
    db.addEvent(event(runId, "plan.replanned", { decided, estimate: made.plan.estimate ?? null }));
    return latest;
  });

  // 需求变更: a new task that builds on this one's results instead of starting over. It works in the
  // same project, or the same scratch folder, and is planned knowing what exists.
  app.post<{ Params: { run_id: string } }>("/api/tasks/:run_id/followup", async (request, reply) => {
    const body = parse(FollowUp, request.body);
    const parent = api.getTask(request.params.run_id);
    if (!CHANGEABLE.has(parent.status)) throw new HttpError(409, "任务还在进行中，结束后才能提出需求变更。");
    return reply.code(201).send(await api.newTask(CreateTask.parse({
      prompt: body.prompt, attachments: body.attachments, budget_usd: body.budget_usd || parent.budget_usd,
      use_cli: body.use_cli ?? parent.use_cli, only_models: parent.only_models, cli_only: parent.cli_only, project_dir: parent.project_dir,
      allow_network: body.allow_network ?? parent.allow_network,
    }), parent));
  });

  // Every task; ``brief`` leaves out what only an opened task shows.
  app.get("/api/tasks", async (request, reply) => {
    const runs = await api.calibrated(db.listRuns());
    return unchangedOr(request, reply, JSON.stringify(queryBool(request.query as Query, "brief", false) ? runs.map(brief) : runs));
  });

  // Problems that came up in at least ``min_runs`` finished tasks, most frequent first.
  app.get("/api/retrospectives/recurring", async (request) =>
    retrospect.recurring(db, Math.max(1, queryInt(request.query as Query, "min_runs", 2))));
  // Problems across tasks grouped by what they are about (retrospect.topics).
  app.get("/api/retrospectives/topics", async (request) =>
    retrospect.topics(db, Math.max(1, queryInt(request.query as Query, "min_runs", 1))));

  // Deleting what the 常见故障 page shows: a problem everywhere it was recorded (by its topic, or as
  // "kind:key"), and the looks back of tasks that were deleted.
  app.delete<{ Params: { topic: string } }>("/api/retrospectives/topics/:topic", async (request) => {
    const removed = retrospect.forget(db, { topic: request.params.topic });
    if (!removed) throw new HttpError(404, "没有这类问题");
    return { removed };
  });
  app.delete<{ Params: { member: string } }>("/api/retrospectives/problems/:member", async (request) => {
    const removed = retrospect.forget(db, { member: request.params.member });
    if (!removed) throw new HttpError(404, "没有这类问题");
    return { removed };
  });
  // With them, the shared repair records of those tasks (what earlier repairs found, told to later ones).
  app.delete("/api/retrospectives/orphaned", async () => {
    const runs = new Set(db.listRuns().map((run) => run.id));
    db.deleteSharedRepairs(db.sharedRepairs(100_000).filter((item) => item.run_id && !runs.has(String(item.run_id))).map((item) => String(item.id)));
    return { deleted: db.deleteRetrospectives(retrospect.orphaned(db)) };
  });

  // A finished task's look back: each step's estimate against its cost and turns, and its problems.
  app.get<{ Params: { run_id: string } }>("/api/tasks/:run_id/retrospective", async (request) => {
    const body = db.retrospective(request.params.run_id) ?? (uses.learning() ? retrospect.record(db, request.params.run_id) : null);
    if (!body) throw new HttpError(404, "Task not found or not finished");
    return body;
  });

  app.get<{ Params: { run_id: string } }>("/api/tasks/:run_id/calls", async (request) => {
    if (!db.getRun(request.params.run_id)) throw new HttpError(404, "Task not found");
    const records = db.modelCalls(request.params.run_id).filter((item) => !item.delegated);
    const total = (key: string) => records.reduce((sum, item) => sum + Number(item[key] || 0), 0);
    return { calls: records, limit: 1000, summary: { calls: records.length, requests: total("requests"),
      unknown_usage: records.filter((item) => !item.usage_known).length, observed_cost_usd: total("cost_usd"), input_tokens: total("input_tokens"),
      output_tokens: total("output_tokens"), cached_input_tokens: total("cached_input_tokens"), retries: total("retries") } };
  });

  // A task as its page shows it. Left out, as the page does not show them or reads them when shown:
  // changed files past the first ones, each tool call's output and the end of a long command, and the
  // lead's own conversation with its model.
  app.get<{ Params: { run_id: string } }>("/api/tasks/:run_id", async (request, reply) => {
    const [run] = await api.calibrated([api.getTask(request.params.run_id)]);
    for (const node of run.plan.nodes) {
      // The page lists the first files and the count; a simulation can leave megabytes of names.
      if (node.changed_files.length > SHOWN_CHANGED_FILES) {
        node.changed_files_total = node.changed_files.length;
        node.changed_files = node.changed_files.slice(0, SHOWN_CHANGED_FILES);
      }
      for (const attempt of node.attempts) {
        for (const call of attempt.tool_calls) {
          if (call.output) [call.output_size, call.output] = [[...call.output].length, ""];
          call.detail = [...call.detail].slice(0, SHOWN_COMMAND_CHARS).join("");
        }
      }
    }
    if (run.supervisor) run.supervisor.history = [];
    return unchangedOr(request, reply, JSON.stringify(run));
  });

  // What one tool call of a step's attempt returned, read when the page shows it.
  app.get<{ Params: { run_id: string; node_id: string; attempt: string; call: string } }>(
    "/api/tasks/:run_id/nodes/:node_id/attempts/:attempt/calls/:call/output", async (request) => {
      const node = api.getTask(request.params.run_id).plan.nodes.find((item) => item.id === request.params.node_id);
      const attempt = intParam(request.params, "attempt");
      const call = intParam(request.params, "call");
      const found = node ? pyIndex(pyIndex(node.attempts, attempt)?.tool_calls ?? [], call) : undefined;
      if (!found) throw new HttpError(404, "没有这次工具调用");
      return { output: found.output };
    });

  app.delete<{ Params: { run_id: string } }>("/api/tasks/:run_id", async (request, reply) => {
    const runId = request.params.run_id;
    const current = executor();
    if ([current.tasks, current.diagnosing, current.learningTasks, current.capabilityTasks].some((tasks) => {
      const task = tasks.get(runId);
      return task && !task.done;
    })) throw new HttpError(409, "任务仍在执行或结束处理中，请稍后再删除。");
    const existing = db.getRun(runId);
    if (db.engineerJobs(1000).some((job) => job.run_id === runId && job.improvement_id && !["applied", "failed", "rejected", "cancelled"].includes(job.status))) {
      throw new HttpError(409, "该任务的改进仍由平台工程师处理，请完成或放弃后再删除。");
    }
    let deleted: boolean;
    try {
      // A chat is a draft that never runs; a draft task is not deleted (only finished ones are).
      deleted = db.deleteRun(runId, existing?.kind === "chat");
    } catch (error) {
      throw new HttpError(409, (error as Error).message);
    }
    if (!deleted) throw new HttpError(404, "Task not found");
    rmSync(join(settings.data_dir, "traces", runId), { recursive: true, force: true });
    // Kept unless asked: what later tasks learn from it (常见故障, recurring problems).
    if (queryBool(request.query as Query, "with_retrospective", false)) {
      db.deleteRetrospectives([runId]);
      db.deleteSharedRepairs(db.sharedRepairs(100_000).filter((item) => item.run_id === runId).map((item) => String(item.id)));
    }
    current.tasks.delete(runId);
    current.learningTasks.delete(runId);
    current.locks.delete(runId);
    current.reservations.delete(runId);
    current.budgetEvents.delete(runId);
    for (const item of existing?.attachments ?? []) files.remove(item.id);
    return reply.code(204).send();
  });

  /** The models a task may use now: without the mock when it was routed to real ones, without the
   *  CLIs when it does not use them. */
  const configuredForRun = (run: ExecutionRun) => {
    let configured = providers().configuredModels(Object.keys(api.models));
    if (run.plan.nodes.some((node) => node.model_id && !node.model_id.startsWith("mock:"))) configured = new Set([...configured].filter((id) => !id.startsWith("mock:")));
    if (!run.use_cli) configured = new Set([...configured].filter((id) => !id.startsWith("cli:")));
    return configured;
  };
  const required = (run: ExecutionRun) => run.actual_cost_usd + run.plan.nodes.filter((node) => node.status !== "succeeded")
    .reduce((sum, node) => sum + node.estimated_cost_usd, 0);
  const checkBudget = (run: ExecutionRun, budgetUsd: number) => {
    const needed = required(run);
    if (needed > budgetUsd) throw new HttpError(409, `Budget $${fixed(budgetUsd, 2)} is below the $${fixed(needed, 4)} needed to finish this task`);
  };
  const notWaiting = (run: ExecutionRun) => {
    if (run.waiting_diagnosis_id || run.maintenance_id) throw new HttpError(409, "请先回复平台工程师的问题，或等待平台修复自动生效。");
    if (run.engineer_job_id) throw new HttpError(409, "任务在等平台工程师添加组件：请在负责人对话里的平台工程师卡片上批准或放弃这项工作。");
    const diagnosis = executor().diagnosing.get(run.id);
    if (diagnosis && !diagnosis.done) throw new HttpError(409, "平台工程师还在查或修，完成后会自动继续；也可以取消任务。");
  };
  // A request that needs chats, when there is no chat package.

  const routing = async (work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      if (error instanceof NoEligibleModelError) throw new HttpError(422, error.message);
      throw error;
    }
  };

  // Start a task waiting for confirmation (or go on with a paused one): the page's button, and "开始"
  // said in a chat app by who asked for it (automations.ts).
  const confirmTask = async (runId: string, given: number | null = null) => {
    const run = api.getTask(runId);
    notWaiting(run);
    if (run.status !== "awaiting_confirmation" && run.status !== "paused") throw new HttpError(409, `Cannot confirm task in ${pyStatus(run.status)} status`);
    const budgetUsd = given ?? run.budget_usd;
    const configured = configuredForRun(run);
    const catalog = Object.values(api.models);
    const needsVision = run.attachments.some((item) => item.kind === "image");
    await routing(async () => {
      for (const node of run.plan.nodes) {
        if (node.status === "succeeded" || node.status === "running") continue;
        if (run.plan.employees.length) {
          await team.route(node, run.plan, catalog, configured, needsVision);
          continue;
        }
        if (!eligibleForNode(node, catalog, configured, needsVision).some((model) => model.id === node.model_id)) await routeNode(node, catalog, configured, needsVision);
      }
    });
    checkBudget(run, budgetUsd);
    run.budget_usd = budgetUsd;
    if (run.plan.estimate) run.plan.estimate.hard_limit_usd = budgetUsd;
    // A task paused after a diagnosis continues with its failed steps run again.
    const reopened = run.plan.nodes.filter((node) => node.status === "failed").map((node) => node.id);
    for (const node of run.plan.nodes) if (reopened.includes(node.id)) reopenNode(run, node);
    if (reopened.length) run.rework_rounds = 0;
    // Whatever paused the task, the user has now seen it and continued: the message is done.
    run.error = null;
    // The user said go on: the lead gets a fresh allowance of decisions.
    run.decisions_since = new Date().toISOString();
    // A task paused by the user may still be finishing its running steps; that loop goes on.
    const task = executor().tasks.get(run.id);
    run.status = task && !task.done ? "running" : "queued";
    db.saveRun(run);
    db.addEvent(event(run.id, "run.confirmed", { budget_usd: run.budget_usd, reopened }));
    executor().start(run.id);
    return run;
  };
  api.confirmTask = (runId) => confirmTask(runId);
  app.post<{ Params: { run_id: string } }>("/api/tasks/:run_id/confirm", async (request) => {
    const body = parse(ConfirmTask, request.body);
    return confirmTask(request.params.run_id, body.budget_usd);
  });

  // Stop starting new steps; steps already running finish and keep their results.
  app.post<{ Params: { run_id: string } }>("/api/tasks/:run_id/pause", async (request) => {
    const runId = request.params.run_id;
    const first = api.getTask(runId);
    if (first.status !== "queued" && first.status !== "running" && !first.maintenance_id) throw new HttpError(409, `Cannot pause task in ${pyStatus(first.status)} status`);
    const run = await executor().locked(runId, () => {
      const latest = api.getTask(runId);
      Object.assign(latest, { status: "paused", waiting_diagnosis_id: null, maintenance_id: null, error: null });
      db.saveRun(latest);
      return latest;
    });
    const running = run.plan.nodes.filter((node) => node.status === "running").map((node) => node.id);
    db.addEvent(event(run.id, "approval.required", { reason: "user_paused", running }));
    return run;
  });

  // Ask a strong model (a membership CLI when possible) why the task is stuck.
  const diagnosisRequired = () => {
    if (uses.stuckWaits()) throw new HttpError(409, "没有启用平台工程师能力：不能诊断。");
  };
  app.post<{ Params: { run_id: string } }>("/api/tasks/:run_id/diagnose", async (request) => {
    diagnosisRequired();
    const runId = request.params.run_id;
    const [run, diagnosisId] = await executor().locked(runId, () => {
      if (executor().platformPending) throw new HttpError(409, "平台修复正在自动生效，请稍候再请平台工程师。");
      const latest = api.getTask(runId);
      const failed = latest.plan.nodes.find((node) => node.status === "failed" || node.status === "unable")?.id
        ?? latest.plan.nodes.find((node) => node.status === "pending" && node.attempts.length)?.id ?? null;
      const started = executor().beginDiagnosis(latest, "manual", failed);
      if (started === null && (!latest.diagnoses.length || latest.diagnoses.at(-1)!.status !== "failed")) throw new HttpError(409, "平台工程师正在查，请稍候。");
      db.saveRun(latest);
      return [latest, started] as const;
    });
    if (diagnosisId) executor().startDiagnosis(run.id, diagnosisId);
    return run;
  });

  // Allow or forbid the internet for this task's commands, from its next model call on.
  app.put<{ Params: { run_id: string } }>("/api/tasks/:run_id/network", async (request) => {
    const body = parse(NetworkAccess, request.body);
    const runId = request.params.run_id;
    return executor().locked(runId, () => {
      const run = api.getTask(runId);
      if (run.allow_network !== body.allow) {
        run.allow_network = body.allow;
        db.saveRun(run);
        executor().emit(runId, "run.network_changed", { allow: body.allow });
      }
      return run;
    });
  });

  // Write to the task's lead, in the conversation it keeps for this task (supervisor.ts). The message
  // is saved at once; the lead's answer follows in ``lead_messages``.
  app.post<{ Params: { run_id: string } }>("/api/tasks/:run_id/lead", async (request, reply) => {
    const body = parse(LeadQuestion, request.body);
    const runId = request.params.run_id;
    // A chat goes on only with the chat capability; a task's lead only with the lead capability.
    if (api.getTask(runId).kind === "chat") chatRequired();
    else if (!uses.lead()) throw new HttpError(409, "没有启用负责人能力：任务里不能对话。");
    const attached = api.attached(body.attachments);
    const message = body.message.trim() || (attached.length ? "（见附件）" : "");
    if (!message) throw new HttpError(422, "请写下要说的话，或附上文件。");
    let started: boolean;
    try {
      started = executor().startLeadChat(runId, message, attached);
    } catch (error) {
      if (error instanceof files.AttachmentError) throw new HttpError(422, error.message);
      throw error;
    }
    if (!started) throw new HttpError(409, "负责人还在回答上一条消息，请稍候。");
    return reply.code(202).send(api.getTask(runId));
  });

  // A choice and/or free text is persisted before starting the next diagnosis.
  app.post<{ Params: { run_id: string; diagnosis_id: string } }>("/api/tasks/:run_id/diagnoses/:diagnosis_id/reply", async (request) =>
    replyToQuestion(request.params.run_id, request.params.diagnosis_id, parse(DiagnosisReply, request.body)));
  /** The user's answer to what a task asked (the page, or a chat app it was asked for in). */
  const replyToQuestion = async (runId: string, diagnosisId: string, body: z.infer<typeof DiagnosisReply>) => {
    const [run, following] = await executor().locked(runId, () => {
      const latest = api.getTask(runId);
      const previous = latest.diagnoses.find((item) => item.id === diagnosisId);
      if (!previous) throw new HttpError(404, "没有这条记录。");
      const busy = executor().diagnosing.get(runId);
      if ((busy && !busy.done) || executor().platformPending) throw new HttpError(409, "平台工程师这次还没做完，请完成后再补充。");
      const said = body.text.trim();
      const choice = body.choice ? body.choice.trim() : null;
      const attached = api.attached(body.attachments);
      if (choice && !previous.choices.includes(choice)) throw new HttpError(422, "所选方案不在这次给出的方案里，请重新选择。");
      if (!said && !choice && !attached.length) throw new HttpError(422, "请选择一个方案或填写你的想法。");
      try {
        // The files join the task's: the lead is given them with its next call, the steps see them.
        files.attach(latest, attached);
      } catch (error) {
        if (error instanceof files.AttachmentError) throw new HttpError(422, error.message);
        throw error;
      }
      previous.messages.push(DiagnosisMessageSchema.parse({ text: said || (attached.length ? "（见附件）" : ""), choice, attachments: attached }));
      if (choice === NETWORK_CHOICE && !latest.allow_network) {
        // A diagnosis or the lead asked whether the task may use the internet; the answer applies at once.
        latest.allow_network = true;
        executor().emit(runId, "run.network_changed", { allow: true });
      }
      if (previous.trigger === "lead") {
        // The task's lead asked: the answer goes back to it, in its conversation.
        if (latest.waiting_diagnosis_id === diagnosisId) latest.waiting_diagnosis_id = null;
        db.saveRun(latest);
        executor().emit(runId, "run.diagnosis_reply", { diagnosis_id: diagnosisId, choice, text: said });
        executor().startLeadAnswer(runId, diagnosisId);
        return [latest, null] as const;
      }
      const focus = previous.node_id ?? latest.plan.nodes.find((node) => node.status === "failed")?.id ?? null;
      diagnosisRequired();
      const next = executor().beginDiagnosis(latest, "manual", focus);
      latest.diagnoses.at(-1)!.reply_to = diagnosisId;
      if (!next && latest.waiting_diagnosis_id === diagnosisId) latest.waiting_diagnosis_id = null;
      db.saveRun(latest);
      executor().emit(runId, "run.diagnosis_reply", { diagnosis_id: diagnosisId, next_diagnosis_id: next, choice, text: said });
      return [latest, next] as const;
    });
    if (following) executor().startDiagnosis(runId, following);
    return run;
  };
  api.answerQuestion = (runId, diagnosisId, answer) =>
    replyToQuestion(runId, diagnosisId, { text: answer.text, choice: answer.choice ?? null, attachments: answer.attachments ?? [] });

  // Continue a failed, cancelled or incomplete task from where it stopped: finished nodes keep their
  // results; the others run again with fresh attempts and rework rounds.
  app.post<{ Params: { run_id: string } }>("/api/tasks/:run_id/resume", async (request) => {
    const body = parse(ConfirmTask, request.body);
    const runId = request.params.run_id;
    const run = api.getTask(runId);
    notWaiting(run);
    if (!["failed", "cancelled", "incomplete"].includes(run.status)) throw new HttpError(409, `Cannot resume task in ${pyStatus(run.status)} status`);
    const task = executor().tasks.get(runId);
    if (task && !task.done) throw new HttpError(409, "任务仍在结束处理中，请稍后再继续。");
    const configured = configuredForRun(run);
    const needsVision = run.attachments.some((item) => item.kind === "image");
    const catalog = Object.values(api.models);
    const reopened: string[] = [];
    await routing(async () => {
      for (const node of run.plan.nodes) {
        if (node.status === "succeeded") continue;
        if (["failed", "cancelled", "running", "unable", "blocked"].includes(node.status)) {
          reopened.push(node.id);
          reopenNode(run, node);
        }
        // Its model was disabled or lost its key since; pick again under current rules.
        if (!eligibleForNode(node, catalog, configured, needsVision).some((model) => model.id === node.model_id)) await routeNode(node, catalog, configured, needsVision);
      }
    });
    const budgetUsd = body.budget_usd ?? run.budget_usd;
    checkBudget(run, budgetUsd);
    Object.assign(run, { budget_usd: budgetUsd, rework_rounds: 0, error: null, decisions_since: new Date().toISOString(), status: "queued" });
    if (run.plan.estimate) run.plan.estimate.hard_limit_usd = budgetUsd;
    db.saveRun(run);
    db.addEvent(event(run.id, "run.resumed", { budget_usd: budgetUsd, reopened }));
    executor().start(run.id);
    return run;
  });

  app.post<{ Params: { run_id: string } }>("/api/tasks/:run_id/cancel", async (request) => {
    const runId = request.params.run_id;
    const run = api.getTask(runId);
    const diagnosis = executor().diagnosing.get(runId);
    if (FINISHED.has(run.status) && !(diagnosis && !diagnosis.done)) throw new HttpError(409, "Task has already finished");
    // A component the lead asked for stays with the platform engineer; the user decides on it there.
    Object.assign(run, { status: "cancelled", waiting_diagnosis_id: null, maintenance_id: null, engineer_job_id: null });
    db.saveRun(run);
    db.addEvent(event(run.id, "run.cancelled"));
    executor().cancel(run.id);
    return run;
  });

  // ---- What a task is doing ----

  // All events of a task so far, oldest first, for the plan view's progress panel.
  app.get<{ Params: { run_id: string } }>("/api/tasks/:run_id/timeline", async (request) => {
    if (!db.getRun(request.params.run_id)) throw new HttpError(404, "Task not found");
    return db.events(request.params.run_id, queryInt(request.query as Query, "after", 0));
  });

  // What a chat is doing while it answers with tools (supervisor.ChatActivity): empty otherwise.
  app.get<{ Params: { run_id: string } }>("/api/tasks/:run_id/lead/activity", async (request) => {
    api.getTask(request.params.run_id);
    const calls = [...(supervisor.CHAT_ACTIVITY.get(request.params.run_id) ?? [])];
    return { running: supervisor.CHAT_ACTIVITY.has(request.params.run_id), total: calls.length, calls: calls.slice(-200) };
  });

  // What a running step has done so far in this attempt (activity.ts): an API model's tool calls, or
  // a CLI's commands, file changes and messages; empty when it is not running.
  app.get<{ Params: { run_id: string; node_id: string } }>("/api/tasks/:run_id/nodes/:node_id/activity", async (request) => {
    const { run_id: runId, node_id: nodeId } = request.params;
    const limit = queryInt(request.query as Query, "limit", 200);
    const run = db.getRun(runId);
    if (!run || !run.plan.nodes.some((node) => node.id === nodeId)) throw new HttpError(404, "Step not found");
    const key = stepKey(runId, nodeId);
    const calls = [...(executor().toolLogs.get(key) ?? [])];
    return { running: executor().toolLogs.has(key), total: calls.length, calls: calls.slice(-Math.max(1, Math.min(limit, 400))) };
  });

  app.get<{ Params: { run_id: string } }>("/api/tasks/:run_id/events", async (request, reply) => {
    const runId = request.params.run_id;
    const after = queryInt(request.query as Query, "after", 0);
    if (!db.getRun(runId)) throw new HttpError(404, "Task not found");
    const closed = new AbortController();
    request.raw.once("close", () => closed.abort());
    return reply.type("text/event-stream; charset=utf-8").send(Readable.from(api.events(runId, after, closed.signal)));
  });
}
