// A step that cannot be done here ends the task honestly: tests/test_unable.py, ported.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { settings } from "../src/config.js";
import { Database } from "../src/db.js";
import { Executor } from "../src/executor.js";
import { ExecutionRunSchema, ModelProfileSchema } from "../src/models.js";
import { type CompleteOptions, ProviderResult } from "../src/providers.js";
import * as quality from "../src/quality.js";
import { conftest } from "./helpers/conftest.js";

const { folder } = conftest();
const model = (id: string, planning: number, channel = "api") => ModelProfileSchema.parse({ id, provider: id.split(":")[0], display_name: id, channel,
  context_window: 1_000_000, input_per_million: 1, output_per_million: 1, execution_priority: channel === "cli" ? 0 : 100, scores: { coding: 90, planning, reliability: 90 } });
const MODELS = Object.fromEntries([model("x:api", 99), model("cli:claude", 90, "cli")].map((m) => [m.id, m]));
const DEPLOY = "部署脚本 deploy.sh 已就绪，配置也写好了。\nUNABLE: 沙箱不能联网，没有实际部署到服务器；允许联网并提供服务器凭据后可以部署。";

/** Deploying needs the internet; everything else works. ``review`` answers reviews. */
class Workers {
  calls: string[] = [];
  prompts: string[] = [];
  constructor(public deploy = DEPLOY, readonly review: ((prompt: string) => unknown) | null = null, readonly diagnosis: string | null = null) {}

  configuredModels(ids: Iterable<string>) {
    return new Set(ids);
  }

  async complete(modelId: string, prompt: string, options: CompleteOptions = {}): Promise<ProviderResult> {
    if (options.repair) {
      this.calls.push("diagnose");
      return new ProviderResult(this.diagnosis ?? "", 0, 0, modelId);
    }
    if (prompt.startsWith(quality.REVIEW_MARKER)) return new ProviderResult(JSON.stringify(this.review!(prompt)), 0, 0, modelId);
    this.prompts.push(prompt);
    const title = prompt.split("\n", 1)[0].replace(/^Task: /, "");
    this.calls.push(title);
    return new ProviderResult(title === "部署上线" ? this.deploy : `${title}完成`, 0, 0, modelId);
  }
}

function configure(review = false, diagnose = false, name = "test.db"): Database {
  Object.assign(settings, { workspace_root: join(folder(), "workspaces"), review_nodes: review, auto_diagnose: diagnose });
  const db = new Database(join(folder(), name));
  const node = (id: string, title: string, deps: string[] = []) => ({ id, title, instructions: title, capability: "coding", model_id: "x:api", dependencies: deps });
  db.saveRun(ExecutionRunSchema.parse({ id: "r", prompt: "做一个网站并部署", status: "queued", budget_usd: 5, use_cli: true, plan: { summary: "网站", nodes: [
    node("build", "构建网站"), node("deploy", "部署上线", ["build"]), node("check", "检查线上页面", ["deploy"]), node("docs", "写使用说明")] } }));
  return db;
}
const byId = (db: Database) => Object.fromEntries(db.getRun("r")!.plan.nodes.map((item) => [item.id, item]));

test("a step that cannot be done ends the task incomplete, with its reason", async () => {
  const db = configure();
  const workers = new Workers();
  await new Executor(db, workers, MODELS).execute("r");
  const run = db.getRun("r")!;
  const nodes = byId(db);
  assert.equal(run.status, "incomplete");
  assert.deepEqual(Object.fromEntries(Object.entries(nodes).map(([k, v]) => [k, v.status])), { build: "succeeded", deploy: "unable", check: "blocked", docs: "succeeded" });
  // One honest attempt: retrying cannot bring the network back.
  assert.ok(workers.calls.filter((c) => c === "部署上线").length === 1 && !workers.calls.includes("检查线上页面"));
  assert.ok(nodes.deploy.unable_reason!.includes("沙箱不能联网") && nodes.deploy.attempts.at(-1)!.outcome === "unable");
  assert.ok(run.final_result!.startsWith("## 未能完成") && run.final_result!.includes("沙箱不能联网"));
  assert.ok(run.final_result!.includes("「检查线上页面」") && run.final_result!.includes("写使用说明完成"));
  assert.ok(run.error!.includes("部署上线"));
  // Every worker is told not to fake what it cannot do.
  assert.ok(workers.prompts.every((prompt) => prompt.includes("UNABLE:")));
});

test("a reviewer does not pass work that only prepared the outcome", async () => {
  const db = configure(true);
  const review = (prompt: string) => (prompt.includes("部署脚本") ? { passed: true, reason: "脚本写得不错", unable: "没有联网，网站实际没有部署" } : { passed: true, reason: "ok" });
  await new Executor(db, new Workers("部署脚本 deploy.sh 已就绪，联网后运行即可。", review), MODELS).execute("r");
  const run = db.getRun("r")!;
  const deploy = byId(db).deploy;
  assert.ok(run.status === "incomplete" && deploy.status === "unable");
  assert.ok(deploy.review_passed === false && deploy.unable_reason!.includes("实际没有部署"));
  assert.ok(quality.reviewPrompt(deploy, "x", [], "", false).includes("only prepared"));
});

test("the diagnosis tries to lift the limit, and its verdict is kept", async () => {
  const db = configure(false, true);
  const blocked = "服务器凭据不在这台机器上，无法代为部署。\nUSER_ACTION: CREDENTIALS: 提供部署服务器的 SSH 密钥\nSTATUS: BLOCKED";
  const workers = new Workers(DEPLOY, null, blocked);
  await new Executor(db, workers, MODELS).execute("r");
  const run = db.getRun("r")!;
  const deploy = byId(db).deploy;
  // Not paused waiting for the user: the task ends, saying what is missing.
  assert.ok(run.status === "incomplete" && run.waiting_diagnosis_id === null);
  assert.ok(deploy.unable_reason!.includes("需要你处理：CREDENTIALS: 提供部署服务器的 SSH 密钥"));
  assert.ok(deploy.unable_reason!.includes("服务器凭据不在这台机器上"));
  assert.ok(workers.calls.filter((c) => c === "diagnose").length === 1 && workers.calls.filter((c) => c === "部署上线").length === 1);
});

test("a wrong claim of inability is retried", async () => {
  const db = configure(false, true);
  const workers = new Workers(DEPLOY, null, "部署只是写入本地目录，不需要网络。\nNEXT_STEP: 直接复制到 public/\nSTATUS: RETRY");
  const replies = [DEPLOY, "已复制到 public/"];
  const original = workers.complete.bind(workers);
  workers.complete = async (modelId: string, prompt: string, options: CompleteOptions = {}) => {
    if (prompt.startsWith("Task: 部署上线")) workers.deploy = replies.shift()!;
    return original(modelId, prompt, options);
  };
  await new Executor(db, workers, MODELS).execute("r");
  const run = db.getRun("r")!;
  assert.equal(run.status, "succeeded");
  assert.deepEqual(byId(db).deploy.attempts.map((a) => a.outcome), ["unable", "passed"]);
  assert.ok(workers.prompts.filter((p) => p.startsWith("Task: 部署上线")).at(-1)!.includes("直接复制到 public/"));
});

test("a worker's claim of inability decides the outcome, with acceptance on or off", async () => {
  let index = 0;
  for (const acceptance of [true, false]) {
    for (const [claim, unable] of [["none", false], ["N/A", false], ["no blockers", false], ["无阻塞项", false],
      ["No credentials are available; deployment requires a key.", true], ["没有凭据，无法发布。", true]] as const) {
      index += 1;
      const db = configure(true, false, `test-${index}.db`);
      settings.acceptance = acceptance;
      const reviewed: string[] = [];
      const result = `本步骤的执行报告。\nUNABLE: ${claim}`;
      const workers = new Workers(result, (prompt) => {
        reviewed.push(prompt);
        return { passed: true, reason: "ok" };
      });
      await new Executor(db, workers, MODELS).execute("r");
      const run = db.getRun("r")!;
      const nodes = byId(db);
      const deploy = nodes.deploy;
      const label = `${acceptance} ${claim}`;
      assert.equal(run.status, unable ? "incomplete" : "succeeded", label);
      assert.equal(deploy.status, unable ? "unable" : "succeeded", label);
      assert.equal(nodes.check.status, unable ? "blocked" : "succeeded", label);
      assert.equal(workers.calls.includes("检查线上页面"), !unable);
      assert.equal(workers.calls.filter((c) => c === "部署上线").length, 1);
      assert.deepEqual(deploy.attempts.map((attempt) => attempt.outcome), [unable ? "unable" : "passed"]);
      assert.equal(deploy.attempts[0].result, result);
      assert.equal(reviewed.some((prompt) => prompt.includes(result)), acceptance && !unable, label);
      if (unable) assert.ok(deploy.unable_reason!.includes(claim));
      else assert.equal(deploy.unable_reason, null);
    }
  }
});
