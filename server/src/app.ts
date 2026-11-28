// FluidForm's HTTP API, served by Fastify: the local-only guard, and the routes the console uses
// (routes/*.ts, by area). What they work with is the Api (api.ts).
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { Api, etagged, HttpError, log } from "./api.js";
import * as files from "./attachments.js";
import * as capabilities from "./capabilities.js";
import { settings } from "./config.js";
import { EngineerError } from "./engineer.js";
import { SAFE_METHODS, hostName } from "./routes/common.js";
import { systemRoutes } from "./routes/system.js";
import { engineerRoutes } from "./routes/engineer.js";
import { modelsRoutes } from "./routes/models.js";
import { projectsRoutes } from "./routes/projects.js";
import { uploadsRoutes } from "./routes/uploads.js";
import { tasksRoutes } from "./routes/tasks.js";
import { learningRoutes } from "./routes/learning.js";
import { chatsRoutes } from "./routes/chats.js";
import { capabilitiesRoutes } from "./routes/capabilities.js";
import { filesRoutes } from "./routes/files.js";
import type { RouteContext } from "./routes/context.js";

export { hostName, reopenNode, CHANGEABLE, SHOWN_CHANGED_FILES, SHOWN_COMMAND_CHARS, USAGE_DAYS, USAGE_RUNS } from "./routes/common.js";

export function buildApp(api: Api): FastifyInstance {
  const app = Fastify({ logger: false });
  const { db } = api;
  const executor = () => api.executor;
  const providers = () => api.providers;
  const runner = () => api.automations.runner;

  // ---- Bodies: JSON (an empty one is no body); a raw upload is read as bytes by its own route ----
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    if (!body) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new HttpError(422, [{ type: "json_invalid", loc: ["body", 0], msg: "JSON decode error" }]), undefined);
    }
  });
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));

  app.setErrorHandler((error: any, request, reply) => {
    if (error instanceof HttpError) return reply.code(error.status).headers(error.headers).send({ detail: error.detail });
    if (error?.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      const path = request.url.split("?")[0];
      const detail = path === "/api/attachments" ? `单个附件不能超过 ${Math.floor(files.MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB。`
        : path === "/api/capabilities/upload" ? `能力包不能超过 ${Math.floor(capabilities.MAX_CAPABILITY_BYTES / 1024 / 1024)} MB。` : "Request body too large";
      return reply.code(413).send({ detail });
    }
    if (typeof error?.statusCode === "number" && error.statusCode < 500) return reply.code(error.statusCode).send({ detail: error.message });
    log.error(`${request.method} ${request.url} failed: ${error?.stack ?? error}`);
    return reply.code(500).send({ detail: "Internal Server Error" });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ detail: "Not Found" }));

  // Refuse rebinding hosts and cross-site writes; the API can drive agents on local files.
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!settings.allowed_hosts.includes(hostName(request.headers.host ?? "").toLowerCase())) {
      return reply.code(403).send({ detail: "Host not allowed" });
    }
    const origin = request.headers.origin;
    if (origin && settings.allowed_origins.includes(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-credentials", "true");
      reply.header("vary", "Origin");
    }
    if (request.method === "OPTIONS" && origin) {
      if (!settings.allowed_origins.includes(origin)) return reply.code(400).send("Disallowed CORS origin");
      reply.header("access-control-allow-methods", "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT");
      reply.header("access-control-allow-headers", request.headers["access-control-request-headers"] ?? "*");
      reply.header("access-control-max-age", "600");
      return reply.code(200).send("OK");
    }
    const mutation = !SAFE_METHODS.has(request.method);
    if (mutation && request.headers["sec-fetch-site"] === "cross-site" && (!origin || !settings.allowed_origins.includes(origin))) {
      return reply.code(403).send({ detail: "Origin not allowed" });
    }
    // A page FluidForm serves itself (the shipped web console) writes from FluidForm's own address,
    // whose host was checked above; an uploaded third-party interface at /<id>/ cannot mutate the API.
    const referer = request.headers.referer;
    let uploadedInterface = false;
    if (referer) {
      try {
        const seg = new URL(referer).pathname.split("/").filter(Boolean)[0];
        if (seg && seg !== "web") {
          const iface = capabilities.load(seg);
          if (iface && iface.kind === "interface" && iface.source === "upload") uploadedInterface = true;
        }
      } catch {
        // malformed referer
      }
    }
    const own = !uploadedInterface && (origin === `http://${request.headers.host}` || origin === `https://${request.headers.host}`);
    if (mutation && (uploadedInterface || (origin && !own && !settings.allowed_origins.includes(origin)))) {
      return reply.code(403).send({ detail: "Origin not allowed" });
    }
    if (mutation && executor().platformPending && !/\/(cancel|pause)$/.test(request.url.split("?")[0])) {
      reply.header("retry-after", "2");
      return reply.code(503).send({ detail: "FluidForm 正在应用已验证的修复，请稍后重试；现有任务会自动继续。" });
    }
    if (mutation) {
      // A platform repair waits until no change is being made (self-repair.waitToApply).
      const current = executor();
      current.activeRequests += 1;
      reply.raw.once("close", () => {
        current.activeRequests -= 1;
      });
    }
    return undefined;
  });

  /** A JSON body the console polls for, not sent again while it is the same (api._unchanged_or). */
  const unchangedOr = (request: FastifyRequest, reply: FastifyReply, body: string) => {
    const tag = etagged(body);
    reply.header("etag", tag).header("cache-control", "no-cache");
    if (request.headers["if-none-match"] === tag) return reply.code(304).send();
    return reply.type("application/json").send(body);
  };

  const engineerAction = async <T>(action: () => T | Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      if (error instanceof EngineerError) throw new HttpError(409, error.message);
      throw error;
    }
  };

  const context: RouteContext = { api, db, executor, providers, runner, unchangedOr, engineerAction };
  systemRoutes(app, context);
  engineerRoutes(app, context);
  modelsRoutes(app, context);
  projectsRoutes(app, context);
  uploadsRoutes(app, context);
  tasksRoutes(app, context);
  learningRoutes(app, context);
  chatsRoutes(app, context);
  capabilitiesRoutes(app, context);
  filesRoutes(app, context);

  return app;
}
