// The API's capabilities routes (app.ts builds the app and adds them).
import * as extensions from "../extensions.js";
import { uses } from "../features.js";
import { HttpError, log, parse } from "../api.js";
import * as capabilities from "../capabilities.js";
import * as chat from "../chat.js";
import * as services from "../services.js";
import * as packages from "../capability-packages.js";
import { missing as sandboxMissing } from "../capability-sandbox.js";
import { settings } from "../config.js";
import { type Capability, type ExecutionRun } from "../models.js";
import { fixed } from "../py.js";
import * as research from "../research.js";
import * as secretStore from "../secrets.js";
import * as skills from "../skills.js";
import type { FastifyInstance } from "fastify";
import { CapabilityModel, CapabilitySecrets, CapabilitySwitch, Json, event, intParam, packagesAllowed } from "./common.js";
import type { RouteContext } from "./context.js";

export function capabilitiesRoutes(app: FastifyInstance, { api, db, executor, runner }: RouteContext): void {
  // What the steps know how to use (skills.ts): this machine's skills, then the platform's.
  app.get("/api/skills", async () => skills.library().map((item) => ({ name: item.name, description: item.description, summary: item.summary,
    tools: item.tools, machine: item.machine })));

  // ---- Capabilities: what finished tasks left the platform able to do (capabilities.ts) ----

  app.get("/api/capabilities", async () => capabilities.library());

  const capability = (capabilityId: string): Capability => {
    const found = capabilities.load(capabilityId);
    if (!found) throw new HttpError(404, "没有这个能力。");
    return found;
  };

  // Use it again, or stop telling later work about it (an automation: start or stop it). A failed one
  // stays failed until fixed.
  app.patch<{ Params: { capability_id: string } }>("/api/capabilities/:capability_id", async (request) => {
    const body = parse(CapabilitySwitch, request.body);
    const item = capability(request.params.capability_id);
    if (item.status === "failed" && body.enabled) throw new HttpError(409, "这个能力的检查没有通过，修好之前不能启用。");
    const runs = item.kind === "automation" && item.source === "upload";
    if (body.enabled && item.source === "upload") {
      // An interface runs nothing here: a web page FluidForm serves.
      if (item.kind !== "interface" && item.kind !== "extension") packagesAllowed();
      if (!body.confirmed) throw new HttpError(409, "启用上传的能力要先确认它能访问的域名和拿到的密钥。");
      const lacking = Object.entries(await packages.secretsSet(item)).filter(([, stored]) => !stored).map(([name]) => name);
      if (lacking.length) throw new HttpError(409, `先填好：${lacking.join("、")}`);
    }
    // What it needs must be there, and what it provides must not come from another package; what
    // others need from it keeps it on.
    const problem = body.enabled ? services.enableProblem(item) : item.status === "active" ? services.disableProblem(item) : null;
    if (problem) throw new HttpError(409, problem);
    const extension = item.kind === extensions.KIND && extensions.byId(item.id) !== null;
    if (extension && body.enabled) await extensions.load(item.id);
    item.status = body.enabled ? "active" : "disabled";
    capabilities.save(item);
    if (extension && body.enabled) {
      // What waited while it was off goes on.
      if (item.id === "engineer") executor().engineerKick();
      else if (item.id === "learning") executor().restoreLearning();
    }
    // Model research starts looking things up when it is switched on, and stops when it is off.
    if (extension && item.provides.includes("research")) {
      if (body.enabled) await research.begin(db, api.models, api.researchReader);
      else await research.end();
    }
    if (runs && body.enabled && item.entry) runner().start(item);
    else if (runs) await runner().stop(item.id);
    if (item.kind === "service" && item.source === "upload") {
      if (body.enabled && item.entry) api.services.start(item);
      else await api.services.stop(item.id);
    }
    return item;
  });

  // Who provides each capability FluidForm itself uses: a package's id, or nobody.
  app.get("/api/capabilities/provided", async () => services.providers());

  // Remove it; a package is uninstalled with its data, state and secrets.
  app.delete<{ Params: { capability_id: string } }>("/api/capabilities/:capability_id", async (request, reply) => {
    const item = capability(request.params.capability_id);
    const problem = item.status === "active" ? services.disableProblem(item) : null;
    if (problem) throw new HttpError(409, problem);
    if (item.kind === "extension") throw new HttpError(409, "随 FluidForm 提供的扩展不能卸载，只能停用。");
    if (item.source === "upload") {
      await runner().stop(item.id);
      runner().forget(item.id);
      await api.services.stop(item.id);
      await packages.uninstall(item);
    } else if (!capabilities.remove(item.id)) throw new HttpError(404, "没有这个能力。");
    return reply.code(204).send();
  });

  // Each package's secrets stored, and each automation's state, log and budget.
  app.get("/api/capabilities/runtime", async () => {
    const found: Record<string, Json> = {};
    for (const item of capabilities.library()) {
      if (item.source !== "upload") continue;
      const entry: Json = { secrets: await packages.secretsSet(item) };
      if (item.kind === "automation") Object.assign(entry, runner().get(item.id).public());
      if (item.kind === "service") Object.assign(entry, api.services.get(item.id).public());
      found[item.id] = entry;
    }
    return { available: settings.capability_packages, missing: sandboxMissing(), capabilities: found, provided: services.providers() };
  });

  // Keep its secrets in the keyring (never in a file); a running automation restarts with them.
  app.put<{ Params: { capability_id: string } }>("/api/capabilities/:capability_id/secrets", async (request) => {
    const body = parse(CapabilitySecrets, request.body);
    const item = capability(request.params.capability_id);
    const unknown = Object.keys(body.values).filter((name) => !item.secrets.includes(name)).sort();
    if (unknown.length) throw new HttpError(422, `它没有声明这些密钥：${unknown.join("、")}`);
    for (const [name, value] of Object.entries(body.values)) {
      if (value.trim()) await secretStore.setSecret(packages.secretName(item.id, name), value.trim());
    }
    await runner().restart(item);
    if (item.kind === "service" && item.status === "active" && api.services.running(item.id)) {
      await api.services.stop(item.id);
      api.services.start(item);
    }
    return { secrets: await packages.secretsSet(item) };
  });

  app.delete<{ Params: { capability_id: string } }>("/api/capabilities/:capability_id/secrets", async (request, reply) => {
    const item = capability(request.params.capability_id);
    // Without its secrets it stops: not while others need what it provides.
    const problem = item.status === "active" ? services.disableProblem(item) : null;
    if (problem) throw new HttpError(409, problem);
    await runner().stop(item.id);
    await api.services.stop(item.id);
    if (item.status === "active" && (item.kind === "automation" || item.kind === "service")) {
      item.status = "disabled";
      capabilities.save(item);
    }
    for (const name of item.secrets) await secretStore.deleteSecret(packages.secretName(item.id, name));
    return reply.code(204).send();
  });

  // Save an automation's chat model. Each chat adopts it before its next reply, after any active
  // reply finishes; classification and task planning retain their own model policies.
  app.put<{ Params: { capability_id: string } }>("/api/capabilities/:capability_id/model", async (request) => {
    const body = parse(CapabilityModel, request.body);
    const found = capability(request.params.capability_id);
    if (found.source !== "upload" || found.kind !== "automation") throw new HttpError(422, "只有上传的自动化能力可以设置聊天模型。");
    const modelId = body.model_id || null;
    if (modelId && !api.chatModels().some((model) => model.id === modelId)) throw new HttpError(422, "这个模型暂不可用或不能用来对话，请重新选择。");
    const item = runner().get(found.id);
    const previous = item.state.model_id;
    item.state.model_id = modelId;
    try {
      item.save();
    } catch (error) {
      item.state.model_id = previous;
      throw error;
    }
    return item.public();
  });

  const proposal = (run: ExecutionRun, index: number) => {
    if (index < 0 || index >= run.capability_proposals.length) throw new HttpError(404, "没有这条提议。");
    const found = run.capability_proposals[index];
    if (found.status !== "proposed") throw new HttpError(409, "这条提议已经处理过。");
    return found;
  };

  // The user keeps what the task built: copied out of the task's folder and checked in a step's
  // sandbox; later steps and planners are told about it (docs/design/capabilities.md).
  app.post<{ Params: { run_id: string; index: string } }>("/api/tasks/:run_id/capabilities/:index/solidify", async (request) => {
    const runId = request.params.run_id;
    const index = intParam(request.params, "index");
    const run = api.getTask(runId);
    const card = proposal(run, index);
    let made: Capability;
    try {
      made = await capabilities.solidify(run, card);
    } catch (error) {
      if (error instanceof capabilities.SourceError) throw new HttpError(422, error.message);
      throw error;
    }
    const latest = api.getTask(runId);
    Object.assign(latest.capability_proposals[index], { status: "solidified", capability_id: made.id });
    db.saveRun(latest);
    db.addEvent(event(runId, "capability.solidified", { capability_id: made.id, status: made.status }));
    return latest;
  });

  app.post<{ Params: { run_id: string; index: string } }>("/api/tasks/:run_id/capabilities/:index/dismiss", async (request) => {
    const run = api.getTask(request.params.run_id);
    proposal(run, intParam(request.params, "index")).status = "dismissed";
    db.saveRun(run);
    return run;
  });

}
