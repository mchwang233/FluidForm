// The API's files routes (app.ts builds the app and adds them).
import { HttpError, parse } from "../api.js";
import * as files from "../attachments.js";
import * as publish from "../publish.js";
import { deleteProviderKey } from "../secrets.js";
import { SECRET_ENV } from "../secret-names.js";
import { which } from "../environment.js";
import type { FastifyInstance } from "fastify";
import { GithubToken, PublishRequest, Query, disposition, event, queryText, text } from "./common.js";
import type { RouteContext } from "./context.js";

export function filesRoutes(app: FastifyInstance, { api, db, providers }: RouteContext): void {
  // ---- A task's files, and publishing them ----

  app.get("/api/github", async () => ({ token: Boolean(process.env[SECRET_ENV.github]), git: which("git") !== null }));
  app.put("/api/github/token", async (request) => ({ stored: await api.deps.setProviderKey("github", parse(GithubToken, request.body).token.trim()) }));
  app.delete("/api/github/token", async () => ({ removed: await deleteProviderKey("github") }));

  app.get<{ Params: { run_id: string } }>("/api/tasks/:run_id/files", async (request) => {
    const run = api.getTask(request.params.run_id);
    return { root: publish.outputRoot(run), in_project: Boolean(run.project_dir), files: publish.outputFiles(run), github_url: run.github_url };
  });

  app.get<{ Params: { run_id: string } }>("/api/tasks/:run_id/files/content", async (request) => {
    const path = queryText(request.query as Query, "path");
    try {
      return { path, text: publish.readOutput(api.getTask(request.params.run_id), path) };
    } catch (error) {
      if (error instanceof publish.PublishError) throw new HttpError(400, error.message);
      throw error;
    }
  });

  app.get<{ Params: { run_id: string } }>("/api/tasks/:run_id/archive", async (request, reply) => {
    const run = api.getTask(request.params.run_id);
    let data: Buffer;
    try {
      data = publish.archive(run);
    } catch (error) {
      if (error instanceof publish.PublishError) throw new HttpError(400, error.message);
      throw error;
    }
    return reply.type("application/zip").header("content-disposition", `attachment; filename="${publish.slug(run)}.zip"`).send(data);
  });

  // Commit the task's output to a new or empty GitHub repository.
  app.post<{ Params: { run_id: string } }>("/api/tasks/:run_id/github", async (request) => {
    const body = parse(PublishRequest, request.body);
    const run = api.getTask(request.params.run_id);
    if (run.project_dir) throw new HttpError(409, "项目任务的改动在你自己的仓库里，请在项目中提交并推送。");
    if (run.status !== "succeeded") throw new HttpError(409, "任务完成后才能上传。");
    const token = process.env[SECRET_ENV.github];
    let url: string;
    try {
      if (body.remote) {
        const remote = publish.checkRemote(body.remote);
        publish.pushSnapshot(run, remote);
        url = remote.replace("git@github.com:", "https://github.com/").replace(/\.git\/?$/, "");
      } else {
        if (!token) throw new publish.PublishError("还没有保存 GitHub 令牌；可以先保存令牌，或填写已建好的空仓库地址。");
        const name = (body.name || publish.slug(run)).trim();
        if (!publish.REPO_NAME.test(name)) throw new publish.PublishError("仓库名只能包含字母、数字、点、横线和下划线");
        const repo = await publish.createRepository(token, name, body.private, body.description || run.plan.summary, providers().fetch);
        publish.pushSnapshot(run, repo.clone_url, token);
        url = repo.html_url;
      }
    } catch (error) {
      if (error instanceof publish.PublishError) throw new HttpError(400, error.message);
      throw error;
    }
    run.github_url = url;
    db.saveRun(run);
    db.addEvent(event(run.id, "run.published", { url }));
    return { url };
  });

}
