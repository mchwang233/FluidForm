// The API's engineer routes (app.ts builds the app and adds them).
import { HttpError, parse } from "../api.js";
import { STOP } from "../engineer.js";
import type { FastifyInstance } from "fastify";
import { EngineerReply, EngineerRequest, Query, queryInt } from "./common.js";
import type { RouteContext } from "./context.js";

export function engineerRoutes(app: FastifyInstance, { api, db, executor, unchangedOr, engineerAction }: RouteContext): void {
  // ---- The platform engineer (engineer.ts) ----

  // Its jobs, newest first, and what it is working on; with ``run_id``, only the jobs of that task.
  // Each job's diff is left out (``has_diff``) and read when it is opened.
  app.get("/api/engineer", async (request, reply) => {
    const query = request.query as Query;
    const overview = executor().engineerOverview(30, query.run_id ?? null);
    for (const job of overview.jobs) Object.assign(job, { has_diff: Boolean(job.diff), diff: null });
    return unchangedOr(request, reply, JSON.stringify(overview));
  });

  // Deleting finished work's records (engineer.engineerDelete): one job, a whole conversation, or every
  // finished one. Work not finished is refused (409); an applied change stays in git.
  app.delete<{ Params: { job_id: string } }>("/api/engineer/jobs/:job_id", async (request) =>
    ({ deleted: await engineerAction(() => executor().engineerDelete([request.params.job_id])) }));
  app.delete<{ Params: { thread_id: string } }>("/api/engineer/threads/:thread_id", async (request) => {
    const ids = executor().engineerThread(request.params.thread_id);
    if (!ids.length) throw new HttpError(404, "没有这段对话");
    return { deleted: await engineerAction(() => executor().engineerDelete(ids)) };
  });
  app.delete("/api/engineer/jobs", async () => ({ deleted: await engineerAction(() => executor().engineerDelete(null)) }));

  app.get<{ Params: { job_id: string } }>("/api/engineer/jobs/:job_id/diff", async (request) => {
    const job = db.getEngineerJob(request.params.job_id);
    if (!job) throw new HttpError(404, "没有这项平台改动");
    return { diff: job.diff };
  });

  // The user brings the platform engineer into the task's conversation with its lead.
  app.post<{ Params: { run_id: string } }>("/api/tasks/:run_id/engineer", async (request, reply) => {
    const body = parse(EngineerRequest, request.body);
    api.getTask(request.params.run_id);
    const [job, problem] = executor().engineerJoin(request.params.run_id, { request: body.request, kind: body.kind }, "user", null, null,
      api.attached(body.attachments));
    if (!job) throw new HttpError(409, problem);
    return reply.code(201).send(job);
  });

  // Ask the platform engineer for a repair (applied once checked) or a component (planned first;
  // applied once the user approves the checked change).
  app.post("/api/engineer/jobs", async (request, reply) => {
    const body = parse(EngineerRequest, request.body);
    const attachments = api.attached(body.attachments);
    const job = await engineerAction(() => executor().engineerRequest(body.request, body.kind, "user",
      { budgetUsd: body.budget_usd, threadId: body.thread_id, attachments }));
    return reply.code(201).send(job);
  });

  // What the platform engineer's job is doing right now: its model's commands, file changes and
  // messages, and the platform's checks; empty when idle.
  app.get<{ Params: { job_id: string } }>("/api/engineer/jobs/:job_id/activity", async (request) => {
    const limit = queryInt(request.query as Query, "limit", 200);
    const jobId = request.params.job_id;
    if (!db.getEngineerJob(jobId)) throw new HttpError(404, "找不到这项平台工程师工作。");
    const calls = [...(executor().engineerLogs.get(jobId) ?? [])];
    return { running: executor().engineerLogs.has(jobId), total: calls.length, calls: calls.slice(-Math.max(1, Math.min(limit, 400))) };
  });

  const engineerReject = (jobId: string) => engineerAction(() => executor().engineerReject(jobId));
  app.post<{ Params: { job_id: string } }>("/api/engineer/jobs/:job_id/reply", async (request) => {
    const body = parse(EngineerReply, request.body);
    // Out of budget, and the user says stop: the job ends as given up.
    if (body.choice === STOP) return engineerReject(request.params.job_id);
    const attachments = api.attached(body.attachments);
    return engineerAction(() => executor().engineerReply(request.params.job_id, body.text, body.choice, attachments));
  });
  // Approve the plan (the engineer then makes the change) or the checked change (applied).
  app.post<{ Params: { job_id: string } }>("/api/engineer/jobs/:job_id/approve", async (request) =>
    engineerAction(() => executor().engineerApprove(request.params.job_id)));
  app.post<{ Params: { job_id: string } }>("/api/engineer/jobs/:job_id/reject", async (request) => engineerReject(request.params.job_id));

}
