// diagnosing.ts: tests/test_diagnosis.py, ported (those that need no API routes).
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { settings } from "../src/config.js";
import { Database } from "../src/db.js";
import { Executor } from "../src/executor.js";
import { ExecutionRunSchema, ModelProfileSchema } from "../src/models.js";
import { type CompleteOptions, ProviderRegistry, ProviderResult } from "../src/providers.js";
import { QuotaTracker } from "../src/quota.js";
import { conftest } from "./helpers/conftest.js";

const { folder } = conftest();
const model = (id: string, planning: number, channel = "api") => ModelProfileSchema.parse({ id, provider: id.split(":")[0], display_name: id, channel,
  context_window: 1_000_000, input_per_million: 1, output_per_million: 1, execution_priority: channel === "cli" ? 0 : 100, scores: { coding: 90, planning, reliability: 90 } });
const MODELS = Object.fromEntries([model("x:api", 99), model("cli:claude", 90, "cli")].map((m) => [m.id, m]));
const REPORT = "## 问题定位\n第 1 步失败\n## 根本原因\n缺少 node\n## 建议操作\n换模型\nNEXT_STEP: 先确认 node 可用再运行检查";
const FIXED = "## 修复内容\n装好了 node，放在工具目录的 bin 里\nSTATUS: FIXED";
const RETRY = "模型没有先确认 node 是否可用\nNEXT_STEP: 先运行 node --version\nSTATUS: RETRY";

class Providers {
  calls: string[] = [];
  configuredModels(ids: Iterable<string>): Set<string> {
    return new Set(ids);
  }

  async complete(modelId: string, prompt: string, _options: CompleteOptions = {}): Promise<ProviderResult> {
    this.calls.push(modelId);
    if (prompt.includes("You were asked to find out why")) return new ProviderResult(REPORT, 0, 0, modelId);
    throw new Error("node is not installed");
  }
}

/** The step fails until the environment is repaired; each diagnosis answers ``reply``. */
class Repairer extends Providers {
  repaired = false;
  repairs: [string, CompleteOptions][] = [];
  stepPrompts: string[] = [];

  constructor(readonly reply: string, readonly repairWorks = true) {
    super();
  }

  override async complete(modelId: string, prompt: string, options: CompleteOptions = {}): Promise<ProviderResult> {
    this.calls.push(modelId);
    if (prompt.includes("repair whatever blocks it outside the task")) {
      this.repairs.push([prompt, options]);
      this.repaired = this.repairWorks;
      return new ProviderResult(this.reply, 0, 0, modelId);
    }
    this.stepPrompts.push(prompt);
    if (this.repaired) return new ProviderResult("checked", 0, 0, modelId);
    throw new Error("node: command not found");
  }
}

/** The membership CLI is at its usage limit; the API model repairs instead. */
class LimitedCli extends Repairer {
  override async complete(modelId: string, prompt: string, options: CompleteOptions = {}): Promise<ProviderResult> {
    if (modelId === "cli:claude") {
      this.calls.push(modelId);
      throw new Error("claude failed: Claude AI usage limit reached");
    }
    return super.complete(modelId, prompt, options);
  }
}

/** The raw error is new to the detector; the diagnosis recognizes the execution limit. */
class QuotaDiagnosis extends Providers {
  quota = new QuotaTracker();
  workCalls: string[] = [];

  constructor(readonly backup = true, readonly legacy = false, readonly kind = "quota") {
    super();
  }

  override configuredModels(ids: Iterable<string>): Set<string> {
    return new Set([...ids].filter((id) => !this.quota.exhausted(id) && (this.backup || id === "x:api")));
  }

  override async complete(modelId: string, _prompt: string, options: CompleteOptions = {}): Promise<ProviderResult> {
    this.calls.push(modelId);
    if (options.repair) {
      const status = this.legacy ? "BLOCKED" : this.kind === "quota" ? "QUOTA_EXHAUSTED" : "MODEL_UNAVAILABLE";
      return new ProviderResult(`执行模型 x:api 的请求次数已经用完。\nSTATUS: ${status}`, 0, 0, modelId);
    }
    this.workCalls.push(modelId);
    if (modelId === "x:api") throw new Error(this.legacy ? "You've hit your session limit" : "provider denied request: E_WINDOW_EMPTY");
    return new ProviderResult("finished original work", 0, 0, modelId);
  }
}

function oneNodeRun(db: Database, id = "r"): void {
  db.saveRun(ExecutionRunSchema.parse({ id, prompt: "p", status: "queued", budget_usd: 1, use_cli: true,
    plan: { summary: "s", nodes: [{ id: "n", title: "Check", instructions: "run node --check", capability: "coding", model_id: "x:api" }] } }));
}

async function runRepair(providers: Providers, attempts = 2) {
  Object.assign(settings, { auto_diagnose: true, workspace_root: join(folder(), "workspaces"), max_node_attempts: attempts, review_nodes: false });
  const db = new Database(join(folder(), "test.db"));
  oneNodeRun(db);
  await new Executor(db, providers as never, MODELS).execute("r");
  return [db, db.getRun("r")!] as const;
}

test("every failure is diagnosed, and a repaired environment runs the step again", async () => {
  const providers = new Repairer(FIXED);
  const [db, run] = await runRepair(providers);
  const node = run.plan.nodes[0];
  assert.ok(run.status === "succeeded" && node.status === "succeeded");
  // The first failure is diagnosed at once; after the repair the step's own model passes.
  assert.deepEqual(node.attempts.map((a) => [a.model_id, a.outcome]), [["x:api", "error"], ["x:api", "passed"]]);
  const [diagnosis] = run.diagnoses;
  assert.deepEqual([diagnosis.trigger, diagnosis.model_id, diagnosis.status, diagnosis.verdict], ["auto", "cli:claude", "done", "fixed"]);
  assert.ok(diagnosis.report!.startsWith("## 修复内容") && node.environment_fixes === 1);
  const [[prompt, options]] = providers.repairs;
  assert.ok(options.repair === true && prompt.includes(join(folder(), "data", "tools")));
  assert.ok(prompt.includes("Attempt 1 of step 'Check'") && prompt.includes("node: command not found"));
  assert.ok(providers.stepPrompts.at(-1)!.includes("环境已修复"));
  assert.ok(db.events("r").some((e) => e.kind === "node.retry" && (e.data as Record<string, unknown>).reason === "environment_fixed"));
});

test("a blocked step pauses the task at once, with the report", async () => {
  const reply = REPORT + "\nUSER_ACTION: ROOT: 管理员需挂载只读系统中缺失的设备；用户目录安装无法解决\nSTATUS: BLOCKED";
  const [db, run] = await runRepair(new Repairer(reply, false), 3);
  const node = run.plan.nodes[0];
  assert.ok(run.status === "paused" && node.status === "failed" && node.attempts.length === 1);
  assert.ok(run.error!.includes("遇到需要你处理的问题"));
  const [diagnosis] = run.diagnoses;
  assert.ok(diagnosis.verdict === "blocked" && diagnosis.report!.includes("根本原因") && diagnosis.advice === "先确认 node 可用再运行检查");
  assert.ok(diagnosis.user_action!.startsWith("ROOT:"));
  const last = db.events("r").at(-1)!;
  assert.deepEqual([last.kind, (last.data as Record<string, unknown>).reason], ["approval.required", "diagnosis_unresolved"]);
});

test("a blocked suggestion without anything the user must give keeps working", async () => {
  const providers = new Repairer(REPORT + "\nSTATUS: BLOCKED");
  const [, run] = await runRepair(providers);
  assert.equal(run.status, "succeeded");
  assert.equal(run.diagnoses[0].verdict, "retry");
  assert.ok(providers.stepPrompts.at(-1)!.includes("诊断未指出必须由用户提供"));
});

test("a diagnosed quota switches the step's model instead of pausing", async () => {
  for (const [legacy, kind] of [[false, "quota"], [true, "quota"], [false, "unavailable"]] as const) {
    const providers = new QuotaDiagnosis(true, legacy, kind);
    const [db, run] = await runRepair(providers);
    assert.equal(run.status, "succeeded", `${legacy} ${kind}`);
    assert.deepEqual(providers.workCalls, ["x:api", "cli:claude"]);
    assert.ok(providers.quota.exhausted("x:api") && !providers.quota.exhausted("cli:claude"));
    const node = run.plan.nodes[0];
    assert.ok(node.failed_attempts === 0 && node.environment_fixes === 0);
    assert.deepEqual(node.attempts.map((a) => [a.model_id, a.outcome]), [["x:api", kind], ["cli:claude", "passed"]]);
    const [diagnosis] = run.diagnoses;
    assert.equal(diagnosis.verdict, kind === "quota" ? "quota_exhausted" : "model_unavailable");
    assert.equal(providers.quota.classify("x:api", "provider denied request: E_WINDOW_EMPTY"), legacy ? null : kind);
    const [switched] = db.events("r").filter((e) => e.kind === "node.model_switched");
    const data = switched.data as Record<string, unknown>;
    assert.ok(data.diagnosis_id === diagnosis.id && data.model_id === "x:api" && data.next_model_id === "cli:claude");
    assert.ok(!db.events("r").some((e) => e.kind === "approval.required"));
    db.connection.close();
    settings.data_dir = join(folder(), `data-${legacy}-${kind}`);
    rmSync(join(folder(), "test.db"));
  }
});

test("a diagnosed quota without a backup pauses for quota", async () => {
  const providers = new QuotaDiagnosis(false);
  const [db, run] = await runRepair(providers);
  assert.ok(run.status === "paused" && run.plan.nodes[0].status === "pending");
  assert.deepEqual(providers.workCalls, ["x:api"]);
  assert.ok(run.plan.nodes[0].attempts.length === 1 && run.plan.nodes[0].failed_attempts === 0);
  const event = db.events("r").at(-1)!;
  const data = event.data as Record<string, unknown>;
  assert.ok(event.kind === "approval.required" && data.reason === "quota_exhausted" && data.diagnosis_id === run.diagnoses[0].id);
});

test("an unknown limit learned from a diagnosis is used again after a restart", async () => {
  Object.assign(settings, { workspace_root: join(folder(), "workspaces"), auto_diagnose: true, review_nodes: false });
  const db = new Database(join(folder(), "shared.db"));
  const providers = new QuotaDiagnosis();
  providers.quota = new QuotaTracker(db);
  oneNodeRun(db);
  await new Executor(db, providers as never, MODELS).execute("r");
  assert.equal(db.getRun("r")!.status, "succeeded");
  providers.quota.clear("x:api"); // The cooldown ended; a future occurrence has a new task.
  const registry = new ProviderRegistry(db);
  registry.configuredModels = (ids) => new Set([...ids].filter((id) => !registry.quota.exhausted(id)));
  const calls: string[] = [];
  registry.completeOnce = async (modelId: string) => {
    calls.push(modelId);
    if (modelId === "x:api") throw Object.assign(new (await import("../src/budget.js")).ProviderError("provider denied request: E_WINDOW_EMPTY"));
    return new ProviderResult("done", 0, 0, modelId);
  };
  oneNodeRun(db, "another-project");
  await new Executor(db, registry, MODELS).execute("another-project");
  const completed = db.getRun("another-project")!;
  assert.ok(completed.status === "succeeded" && completed.diagnoses.length === 0);
  assert.deepEqual(calls, ["x:api", "cli:claude"]);
});

test("shared environment repairs are recorded and used by other projects", async () => {
  class SharedRepairer extends Repairer {
    override async complete(modelId: string, prompt: string, options: CompleteOptions = {}): Promise<ProviderResult> {
      if (options.repair) writeFileSync(join(settings.data_dir, "tools", "bin", "check-tool"), "#!/bin/sh\necho ready\n");
      return super.complete(modelId, prompt, options);
    }
  }
  const [db, run] = await runRepair(new SharedRepairer(FIXED));
  const [repair] = db.sharedRepairs() as Record<string, any>[];
  assert.deepEqual(repair.files, ["bin/check-tool"]);
  assert.equal(repair.run_id, run.id);
  assert.ok(db.events(run.id).some((e) => e.kind === "run.repair_shared"));
  oneNodeRun(db, "another-project");
  const providers = new Repairer(FIXED);
  await new Executor(db, providers as never, MODELS).execute("another-project");
  assert.equal(db.getRun("another-project")!.status, "succeeded");
  const [prompt] = providers.repairs[0];
  assert.ok(prompt.includes(repair.id) && prompt.includes("bin/check-tool"));
});

test("a retry verdict retries with its advice until the attempts run out", async () => {
  const providers = new Repairer(RETRY, false);
  const [, run] = await runRepair(providers);
  const node = run.plan.nodes[0];
  assert.ok(run.status === "paused" && node.attempts.length === 2 && run.diagnoses.length === 2);
  assert.ok(providers.stepPrompts[1].includes("诊断建议：先运行 node --version"));
  assert.ok(run.error!.includes("重试 2 次仍未通过") && run.diagnoses.at(-1)!.verdict === "retry");
});

test("repairs stop counting free after two", async () => {
  const [, run] = await runRepair(new Repairer(FIXED, false));
  // Two free reruns after repairs, then the failures count: two more attempts.
  assert.ok(run.status === "paused" && run.plan.nodes[0].attempts.length === 4);
  assert.ok(run.plan.nodes[0].environment_fixes === 2 && run.error!.includes("重试 2 次仍未通过"));
});

test("a repair falls back to the next model when the CLI is unavailable", async () => {
  const providers = new LimitedCli(FIXED);
  const [db, run] = await runRepair(providers);
  assert.ok(run.status === "succeeded" && run.diagnoses[0].model_id === "x:api");
  assert.ok(run.diagnoses[0].verdict === "fixed" && providers.repairs[0][1].act === true);
  const [fallback] = db.events("r").filter((e) => e.kind === "run.diagnosis_fallback");
  const data = fallback.data as Record<string, string>;
  assert.deepEqual([data.model_id, data.next_model_id], ["cli:claude", "x:api"]);
  assert.ok(data.error.includes("usage limit"));
});

test("without any model for the step the run pauses before calling it", async () => {
  Object.assign(settings, { auto_diagnose: true, workspace_root: join(folder(), "workspaces"), max_node_attempts: 2 });
  const db = new Database(join(folder(), "test.db"));
  oneNodeRun(db);
  await new Executor(db, new Providers() as never, {}).execute("r");
  const run = db.getRun("r")!;
  assert.ok(run.status === "paused" && !run.plan.nodes[0].attempts.length);
  assert.equal((db.events("r").at(-1)!.data as Record<string, unknown>).reason, "model_unavailable");
});

test("without any model the diagnosis says so", () => {
  const db = new Database(join(folder(), "test.db"));
  const run = ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "failed", budget_usd: 1, plan: { summary: "s", nodes: [] } });
  assert.equal(new Executor(db, new Providers() as never, {}).beginDiagnosis(run, "manual"), null);
  assert.ok(run.diagnoses[0].status === "failed" && run.diagnoses[0].error!.includes("平台工程师没有可用的模型"));
});

test("a repair call uses the long regression budget", async () => {
  const providers = new Repairer(FIXED);
  await runRepair(providers);
  const [, options] = providers.repairs[0];
  assert.equal(options.cli_timeout, 3600);
});
