// The API's system routes (app.ts builds the app and adds them).
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { HttpError, parse } from "../api.js";
import * as capabilities from "../capabilities.js";
import * as chat from "../chat.js";
import * as interfaces from "../interfaces.js";
import * as packages from "../capability-packages.js";
import { PROFILES, settings } from "../config.js";
import { configuredProviders, keyringUnavailable } from "../secrets.js";
import type { FastifyInstance } from "fastify";
import { Forget, ProfileChoice, chatRequired, text } from "./common.js";
import type { RouteContext } from "./context.js";

export function systemRoutes(app: FastifyInstance, { api, db, executor, providers }: RouteContext): void {
  // ---- Health, profile, memory, recovery ----

  // Interface packages (a web console): each active one's page at /<its id>/, and FluidForm's own
  // address leads to the web console when there is one.
  app.get("/", async (_request, reply) => {
    const home = interfaces.home();
    if (home) return reply.redirect(`/${home.id}/`);
    return reply.type("text/plain; charset=utf-8").send(interfaces.NO_INTERFACE);
  });
  app.get<{ Params: { capability_id: string } }>("/:capability_id", async (request, reply) => {
    if (!interfaces.active(request.params.capability_id)) return reply.code(404).send({ detail: "Not Found" });
    return reply.redirect(`/${request.params.capability_id}/`);
  });
  app.get<{ Params: { capability_id: string; "*": string } }>("/:capability_id/*", async (request, reply) => {
    const id = request.params.capability_id;
    const found = interfaces.file(id, request.params["*"]);
    if (!found) return reply.code(404).send({ detail: "Not Found" });
    const headers: Record<string, string> = {
      "content-type": found.type,
      "x-content-type-options": "nosniff",
      "cache-control": found.index ? "no-cache" : "max-age=3600",
    };
    if (id !== "web") {
      headers["content-security-policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; form-action 'none'; frame-ancestors 'none'";
    }
    return reply.headers(headers).send(createReadStream(found.path));
  });

  app.get("/health", async () => ({
    status: "ok", pid: process.pid, configured_providers: [...configuredProviders(), "mock"], keyring_unavailable: keyringUnavailable(),
    available_cli_channels: [...providers().cli.availableModelIds()].sort(), exhausted_models: providers().quota.public(),
  }));

  // Models out of quota and when they come back; routing skips them until then.
  app.get("/api/models/quota", async () => providers().quota.public());

  // The profile in use, and for each one the settings it would not change (given alone).
  const profileView = () => ({
    profile: settings.profile,
    given_alone: Object.fromEntries(Object.keys(PROFILES).map((name) => [name, settings.givenAlone(name)])),
  });
  app.get("/api/settings/profile", async () => profileView());
  // Pick how FluidForm works (config.PROFILES), now and after a restart.
  app.put("/api/settings/profile", async (request) => {
    const body = parse(ProfileChoice, request.body);
    settings.useProfile(body.profile);
    mkdirSync(dirname(settings.profilePath), { recursive: true });
    writeFileSync(settings.profilePath, JSON.stringify({ profile: body.profile }));
    return profileView();
  });

  /** Where facts were said, for the owner: their own chats, or an automation's conversation. */
  const memoryPlace = (key: string) => {
    if (key === chat.WEB) return "网页对话";
    const at = key.indexOf(":");
    const [capabilityId, conversation] = at < 0 ? [key, ""] : [key.slice(0, at), key.slice(at + 1)];
    const capability = capabilities.load(capabilityId);
    return `${capability ? capability.name : capabilityId} · 会话 ${[...conversation].slice(-6).join("")}`;
  };
  // What chats remember, by where it was said: the chat package keeps it.
  const listMemory = async () => {
    const kept: Record<string, string[]> = chat.enabled() ? ((await chat.ask("chat.memory")).places ?? {}) : {};
    return {
      enabled: settings.user_memory, available: chat.enabled(),
      places: Object.entries(kept).map(([key, facts], index) => ({ key, facts, index }))
        .sort((a, b) => Number(a.key !== chat.WEB) - Number(b.key !== chat.WEB) || a.index - b.index)
        .map(({ key, facts }) => ({ key, label: memoryPlace(key), facts })),
    };
  };
  app.get("/api/memory", async () => listMemory());
  app.post("/api/memory/forget", async (request) => {
    const body = parse(Forget, request.body);
    chatRequired();
    if (!(await chat.ask("chat.forget", { place: body.key, fact: body.fact })).removed) throw new HttpError(404, "没有这条记忆");
    return listMemory();
  });

  // Auditable shared recoveries reused by all projects, including after a restart.
  app.get("/api/recovery", async () => ({
    models: providers().quota.public(), rules: providers().quota.rules, shared_repairs: db.sharedRepairs(),
    platform_repair: { enabled: settings.platform_self_repair, source_available: executor().platform.root !== null,
      pending: executor().platformPending?.id ?? null },
  }));

  // The user knows the quota is back (or topped up the account): use the model again.
  app.delete<{ Params: { model_id: string } }>("/api/models/quota/:model_id", async (request) => {
    providers().quota.clear(request.params.model_id);
    return providers().quota.public();
  });

}
