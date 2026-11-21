// A step's model running out of quota while a task runs: tests/test_quota.py, ported.
import assert from "node:assert/strict";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { CliError } from "../src/cli-channels.js";
import { settings } from "../src/config.js";
import { Database } from "../src/db.js";
import { Executor } from "../src/executor.js";
import { ExecutionRunSchema, type ModelProfile, ModelProfileSchema, TaskNodeSchema } from "../src/models.js";
import { ProviderRegistry, ProviderResult } from "../src/providers.js";
import { ModelUnavailable, QuotaTracker } from "../src/quota.js";
import { conftest } from "./helpers/conftest.js";
import { registryWith } from "./helpers/providers.js";

const { folder } = conftest();
beforeEach(() => {
  Object.assign(settings, { workspace_root: join(folder(), "workspaces"), review_nodes: false });
});
const SESSION_LIMIT = "claude failed: You've hit your session limit · resets 2pm (Asia/Shanghai)";
const model = (id: string, coding: number, fields: Partial<ModelProfile> = {}) => ModelProfileSchema.parse({ id, provider: id.split(":")[0], display_name: id, channel: "api",
  context_window: 1_000_000, input_per_million: 1, output_per_million: 1, execution_priority: 100, supports_tools: false, scores: { coding, planning: 80, reliability: 90 }, ...fields });
const lookup = (...models: ModelProfile[]) => Object.fromEntries(models.map((m) => [m.id, m]));
const MODELS = lookup(model("x:cheap", 80), model("y:backup", 85));

/** Models in ``empty`` are out of quota; the others do the work. */
class Providers {
  quota = new QuotaTracker();
  calls: string[] = [];
  constructor(readonly empty: Set<string>) {}

  configuredModels(ids: Iterable<string>) {
    return new Set([...ids].filter((id) => !this.quota.exhausted(id)));
  }

  async complete(modelId: string): Promise<ProviderResult> {
    this.calls.push(modelId);
    if (this.empty.has(modelId)) throw this.quota.mark(modelId, `${modelId} returned 402: Insufficient Balance`);
    return new ProviderResult("done", 10, 10, modelId);
  }
}

async function runOne(providers: unknown, modelId = "x:cheap", models = MODELS) {
  const db = new Database(join(folder(), "test.db"));
  db.saveRun(ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "queued", budget_usd: 1,
    plan: { summary: "s", nodes: [{ id: "n", title: "Build", instructions: "build it", capability: "coding", model_id: modelId }] } }));
  await new Executor(db, providers as never, models).execute("r");
  return [db, db.getRun("r")!] as const;
}

test("a step whose model runs out of quota moves to a backup", async () => {
  const [db, run] = await runOne(new Providers(new Set(["x:cheap"])));
  const node = run.plan.nodes[0];
  assert.ok(run.status === "succeeded" && node.model_id === "y:backup");
  assert.deepEqual(node.attempts.map((a) => [a.model_id, a.outcome]), [["x:cheap", "quota"], ["y:backup", "passed"]]);
  assert.equal(node.failed_attempts, 0);
  const [switched, ...more] = db.events("r").filter((e) => e.kind === "node.model_switched");
  assert.equal(more.length, 0);
  const data = switched.data as Record<string, unknown>;
  assert.deepEqual([data.model_id, data.next_model_id], ["x:cheap", "y:backup"]);
});

test("a step routed to a model already out of quota switches before calling it", async () => {
  const providers = new Providers(new Set());
  providers.quota.mark("x:cheap", "usage limit reached");
  const [, run] = await runOne(providers);
  assert.equal(run.status, "succeeded");
  assert.deepEqual(providers.calls, ["y:backup"]);
});

test("with every model out of quota the task pauses until one is back", async () => {
  const [db, run] = await runOne(new Providers(new Set(["x:cheap", "y:backup"])));
  const node = run.plan.nodes[0];
  assert.ok(run.status === "paused" && node.status === "pending");
  assert.ok(run.error!.includes("没有其它可用模型能接替") && node.failed_attempts === 0);
  const event = db.events("r").at(-1)!;
  assert.deepEqual([event.kind, (event.data as Record<string, unknown>).reason], ["approval.required", "quota_exhausted"]);
});

test("switching drops advice to wait that no longer holds but keeps the verification's feedback", async () => {
  const providers = new Providers(new Set());
  const db = new Database(join(folder(), "test.db"));
  const advice = "Wait for the old model to recover before doing any work";
  db.saveRun(ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "running", budget_usd: 1,
    plan: { summary: "s", nodes: [{ id: "n", title: "Build", instructions: "build", capability: "coding", model_id: "x:cheap", status: "running",
      feedback: `Fix the verified mismatch\n诊断建议：${advice}` }] },
    diagnoses: [{ id: "d", trigger: "auto", node_id: "n", status: "done", verdict: "blocked", report: SESSION_LIMIT, advice }] }));
  const error = providers.quota.mark("x:cheap", "usage limit reached");
  await new Executor(db, providers, MODELS).switchModel("r", "n", error);
  const switched = db.getRun("r")!.plan.nodes[0];
  assert.ok(switched.model_id === "y:backup" && switched.feedback === "Fix the verified mismatch");
});

test("Claude's session limit hands the original work to Codex", async () => {
  settings.auto_diagnose = true;
  const registry = new ProviderRegistry();
  registry.cli.availableModelIds = () => new Set(["cli:claude", "cli:codex"]);
  const calls: [string, string][] = [];
  registry.cli.complete = async (modelId: string, prompt: string) => {
    calls.push([modelId, prompt]);
    if (modelId === "cli:claude") throw new CliError(SESSION_LIMIT);
    return { text: "continued the original work", usage: {} };
  };
  const models = lookup(...([["cli:claude", 96.7], ["cli:codex", 94.6]] as const).map(([id, score]) => model(id, score, { channel: "cli", input_per_million: 0, output_per_million: 0 })));
  const db = new Database(join(folder(), "test.db"));
  db.saveRun(ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "queued", budget_usd: 1, plan: { summary: "s", nodes: [
    TaskNodeSchema.parse({ id: "done", title: "Collect", instructions: "Collect evidence", capability: "research", status: "succeeded", result: "Existing evidence" }),
    TaskNodeSchema.parse({ id: "work", title: "Cross-check", instructions: "Compare the collected evidence", capability: "coding", quality_threshold: 90,
      model_id: "cli:claude", dependencies: ["done"], feedback: "Keep the existing verification feedback" })] } }));
  await new Executor(db, registry, models).execute("r");
  const run = db.getRun("r")!;
  assert.ok(run.status === "succeeded" && run.diagnoses.length === 0);
  assert.deepEqual(calls.map(([id]) => id), ["cli:claude", "cli:codex"]);
  assert.equal(calls[0][1], calls[1][1]);
  assert.ok(calls[1][1].includes("Keep the existing verification feedback"));
  const [finished, handedOff] = run.plan.nodes;
  assert.ok(finished.result === "Existing evidence" && finished.attempts.length === 0);
  assert.deepEqual(handedOff.attempts.map((a) => [a.model_id, a.outcome]), [["cli:claude", "quota"], ["cli:codex", "passed"]]);
  assert.equal(handedOff.failed_attempts, 0);
  assert.ok(registry.quota.exhausted("cli:claude"));
  assert.ok(!registry.configuredModels(Object.keys(models)).has("cli:claude"));
  assert.equal(db.events("r").filter((e) => e.kind === "node.model_switched").length, 1);
});

test("an upstream 503 switches models, and other projects skip the service", async () => {
  process.env.DEEPSEEK_API_KEY = "test-key";
  process.env.MINIMAX_API_KEY = "test-key";
  const calls: string[] = [];
  const registry = registryWith((request) => {
    calls.push(request.url.host);
    if (request.url.host === "api.deepseek.com") return new Response("Service is too busy", { status: 503 });
    return { choices: [{ message: { content: "done" } }] };
  });
  const models = lookup(model("deepseek:deepseek-flash", 80), model("minimax:MiniMax-M3", 85));
  const [db, run] = await runOne(registry, "deepseek:deepseek-flash", models);
  assert.equal(run.status, "succeeded");
  assert.deepEqual(run.plan.nodes[0].attempts.map((a) => [a.model_id, a.outcome]), [["deepseek:deepseek-flash", "unavailable"], ["minimax:MiniMax-M3", "passed"]]);
  assert.equal(calls.length, registry.maxAttempts + 1);
  assert.ok(!registry.configuredModels(Object.keys(models)).has("deepseek:deepseek-flash"));
  await assert.rejects(registry.complete("deepseek:deepseek-flash", "another project's task"), ModelUnavailable);
  assert.equal(calls.length, registry.maxAttempts + 1);
  assert.equal((db.events("r").find((e) => e.kind === "node.model_switched")!.data as Record<string, unknown>).reason, "model_unavailable");
});
