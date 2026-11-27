// The API's learning routes (app.ts builds the app and adds them).
import { uses } from "../features.js";
import { HttpError, parse } from "../api.js";
import { settings } from "../config.js";
import { LearningProblem } from "../learning.js";
import { LearningSettingsSchema } from "../models.js";
import { preferences } from "../learning.js";
import * as retrospect from "../retrospect.js";
import * as skills from "../skills.js";
import type { FastifyInstance } from "fastify";
import { Json } from "./common.js";
import type { RouteContext } from "./context.js";

export function learningRoutes(app: FastifyInstance, { api, db, executor }: RouteContext): void {
  // ---- Learning from tasks (learning.ts) ----

  app.get("/api/improvements/settings", async () => preferences(db));
  app.put("/api/improvements/settings", async (request) => {
    const body = parse(LearningSettingsSchema, request.body);
    db.saveLearningSettings(body);
    return body;
  });

  const improvementView = (item: Json) => {
    const job = item.engineer_job_id ? db.getEngineerJob(item.engineer_job_id) : null;
    return { ...item, effects: db.improvementEffects(item.id), engineer_job: job };
  };
  app.get("/api/improvements", async () => {
    executor().syncImprovements();
    return db.improvements().map(improvementView);
  });

  app.get<{ Params: { run_id: string } }>("/api/tasks/:run_id/learning", async (request) => {
    const runId = request.params.run_id;
    const run = api.getTask(runId);
    executor().syncImprovements();
    return {
      review: db.learningReview(runId), automatic_eligible: retrospect.AUTOMATIC.has(run.status),
      automatic_skip_reason: run.status === "cancelled" ? "任务已手动取消，不自动复盘。" : null,
      retrospective: db.retrospective(runId) ?? (uses.learning() && retrospect.AUTOMATIC.has(run.status) ? retrospect.record(db, runId) : null),
      improvements: db.improvements(runId).map(improvementView),
      applied: run.improvement_uses.map((use: Json) => ({ id: use.id, title: use.title, node_ids: use.node_ids ?? [], planning: use.planning ?? false,
        source_run_id: use.run_id })),
    };
  });

  app.post<{ Params: { run_id: string } }>("/api/tasks/:run_id/learning", async (request, reply) => {
    api.getTask(request.params.run_id);
    try {
      return reply.code(202).send(executor().startLearning(request.params.run_id, true));
    } catch (error) {
      if (error instanceof LearningProblem) throw new HttpError(409, error.message);
      throw error;
    }
  });

  app.post<{ Params: { item_id: string } }>("/api/improvements/:item_id/disable", async (request) => {
    const item = db.improvement(request.params.item_id);
    if (!item) throw new HttpError(404, "找不到改进项。");
    if (item.kind === "platform") throw new HttpError(409, "已应用的平台改动需要通过平台工程师回退；未应用的工作可在工程师中放弃。");
    if (item.status !== "active") throw new HttpError(409, "只能停用已生效的 Skill 或执行规则。");
    item.status = "disabled";
    if (item.kind === "skill") skills.removeLesson(item.id);
    db.saveImprovement(item);
    return item;
  });

}
