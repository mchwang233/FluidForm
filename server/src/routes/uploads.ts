// The API's uploads routes (app.ts builds the app and adds them).
import { createReadStream } from "node:fs";
import { type FastifyRequest } from "fastify";
import { HttpError } from "../api.js";
import * as files from "../attachments.js";
import * as capabilities from "../capabilities.js";
import * as packages from "../capability-packages.js";
import type { FastifyInstance } from "fastify";
import { Query, disposition, packagesAllowed } from "./common.js";
import type { RouteContext } from "./context.js";

export function uploadsRoutes(app: FastifyInstance, { api, db, runner }: RouteContext): void {
  // ---- Raw uploads: an attachment, a capability package ----

  app.register(async (raw) => {
    raw.removeAllContentTypeParsers();
    raw.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
    const bytes = (request: FastifyRequest) => (Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0));

    // Raw file body; the name comes in the query so no multipart parser is needed.
    raw.post("/api/attachments", { bodyLimit: files.MAX_ATTACHMENT_BYTES }, async (request, reply) => {
      const name = (request.query as Query).name ?? "attachment";
      try {
        return reply.code(201).send(files.save(name, bytes(request)));
      } catch (error) {
        if (error instanceof files.AttachmentError) throw new HttpError(400, error.message);
        throw error;
      }
    });

    // Install a capability package (raw zip body), switched off until the user enables it. A new
    // version of an installed one replaces it, keeping its secrets and state.
    raw.post("/api/capabilities/upload", { bodyLimit: capabilities.MAX_CAPABILITY_BYTES }, async (request, reply) => {
      packagesAllowed();
      const data = bytes(request);
      try {
        const manifest = packages.read(data);
        await runner().stop(manifest.id);
        await api.services.stop(manifest.id);
        return reply.code(201).send(await packages.install(data));
      } catch (error) {
        if (error instanceof packages.PackageError) throw new HttpError(422, error.message);
        throw error;
      }
    });
  });

  app.get<{ Params: { attachment_id: string } }>("/api/attachments/:attachment_id/content", async (_request, reply) => {
    const item = files.get(_request.params.attachment_id);
    if (!item) throw new HttpError(404, "附件不存在");
    // Only detected raster images are shown inline; everything else downloads as plain bytes.
    const inline = item.kind === "image";
    return reply.headers({
      "content-type": inline ? item.media_type : "application/octet-stream", "content-disposition": disposition(inline ? "inline" : "attachment", item.name),
      "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'",
    }).send(createReadStream(files.path(item)));
  });

  // Discard an upload removed from the composer before the task was created.
  app.delete<{ Params: { attachment_id: string } }>("/api/attachments/:attachment_id", async (request, reply) => {
    const attachmentId = request.params.attachment_id;
    if (db.listRuns().some((run) => run.attachments.some((item) => item.id === attachmentId))) throw new HttpError(409, "附件属于已创建的任务，随任务一起删除。");
    if (db.engineerJobs(1000).some((job) => job.attachments.some((item) => item.id === attachmentId))) throw new HttpError(409, "附件已发给平台工程师。");
    if (!files.remove(attachmentId)) throw new HttpError(404, "附件不存在");
    return reply.code(204).send();
  });

}
