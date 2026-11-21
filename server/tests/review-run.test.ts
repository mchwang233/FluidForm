// Reviews and verifications in a running task: the executor tests of tests/test_quality.py, ported.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { settings } from "../src/config.js";
import { Database } from "../src/db.js";
import { Executor } from "../src/executor.js";
import { type ExecutionRun, ExecutionRunSchema, ModelProfileSchema, type TaskNode, TaskNodeSchema } from "../src/models.js";
import { ProviderResult } from "../src/providers.js";
import * as quality from "../src/quality.js";
import { conftest } from "./helpers/conftest.js";

const { folder } = conftest();
beforeEach(() => {
  Object.assign(settings, { workspace_root: join(folder(), "workspaces"), review_nodes: true });
});

const model = (id: string, coding: number, reliability = 80, price = 1) => ModelProfileSchema.parse({ id, provider: "x", display_name: id, context_window: 1_000_000,
  input_per_million: price, output_per_million: price, scores: { coding, reliability } });
const MODELS = Object.fromEntries([model("x:cheap", 82, 80, 0.1), model("x:strong", 97, 80, 5), model("x:judge", 85, 99)].map((m) => [m.id, m]));
const node = (id: string, deps: string[] = [], fields: Record<string, unknown> = {}): TaskNode =>
  TaskNodeSchema.parse({ id, title: `Task ${id}`, instructions: `do ${id}`, capability: "coding", dependencies: deps, model_id: "x:cheap", ...fields });
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const sequence = <T>(items: T[]) => () => {
  if (!items.length) throw new Error("no reply left");
  return items.shift()!;
};

/** ``work(modelId, prompt)`` answers tasks, ``review(prompt)`` answers reviews. */
class Script {
  calls: [string, string][] = [];
  constructor(readonly work: (modelId: string, prompt: string) => string, readonly review: (prompt: string) => unknown = () => ({ passed: true, reason: "ok" })) {}

  configuredModels(ids: Iterable<string>) {
    return new Set(ids);
  }

  async complete(modelId: string, prompt: string): Promise<ProviderResult> {
    this.calls.push([modelId, prompt]);
    let text: string;
    if (prompt.includes(quality.REVIEW_MARKER)) {
      const reply = this.review(prompt);
      text = typeof reply === "string" ? reply : JSON.stringify(reply);
    } else text = this.work(modelId, prompt);
    return new ProviderResult(text, 100, 100, modelId);
  }
}

async function runPlan(nodes: TaskNode[], providers: Script): Promise<ExecutionRun> {
  const db = new Database(join(folder(), "test.db"));
  db.saveRun(ExecutionRunSchema.parse({ id: "run", prompt: "demo", status: "queued", budget_usd: 100, use_cli: false, plan: { summary: "demo", nodes } }));
  await new Executor(db, providers, MODELS).execute("run");
  return db.getRun("run")!;
}
const workPrompts = (providers: Script) => providers.calls.filter(([, prompt]) => !prompt.includes(quality.REVIEW_MARKER)).map(([, prompt]) => prompt);

test("rejected work is retried on the strongest model with the reviewer's findings", async () => {
  const providers = new Script((modelId) => `${modelId} did it`, sequence<unknown>([{ passed: false, reason: "Only described the fix.", fix: "Edit login.py" }, { passed: true, reason: "Fixed." }]));
  const run = await runPlan([node("a", [], { acceptance_criteria: "login.py is changed" })], providers);
  const a = run.plan.nodes[0];
  assert.ok(run.status === "succeeded" && a.status === "succeeded");
  assert.deepEqual(a.attempts.map((t) => [t.model_id, t.outcome]), [["x:cheap", "rejected"], ["x:strong", "passed"]]);
  assert.ok(a.attempts.every((t) => t.reviewer_model_id === "x:judge"));
  const work = workPrompts(providers);
  assert.ok(work[0].includes("login.py is changed"));
  assert.ok(work[1].includes("Only described the fix.") && work[1].includes("Edit login.py"));
  assert.ok(a.result === "x:strong did it" && a.review === "Fixed." && a.feedback === null);
  // Review calls are charged too.
  near(run.actual_cost_usd, a.attempts.reduce((sum, t) => sum + t.cost_usd, 0));
  assert.ok(run.actual_cost_usd > 0);
});

test("a step fails after its attempts run out", async () => {
  settings.max_node_attempts = 2;
  // Without a diagnosis (off in tests) the run fails; with one it pauses (diagnosing.test.ts).
  const run = await runPlan([node("a"), node("b", ["a"])], new Script(() => {
    throw new Error("model unavailable");
  }));
  const [a, b] = run.plan.nodes;
  assert.equal(run.status, "failed");
  assert.ok(a.status === "failed");
  assert.deepEqual(a.attempts.map((t) => t.outcome), ["error", "error"]);
  assert.ok(a.result === "model unavailable" && b.status === "pending");
});

test("a failed verification sends the work back with its findings", async () => {
  const verdicts = sequence(["Looks wrong.\nVERDICT: FAIL: the tests still fail", "All good.\nVERDICT: PASS"]);
  let impl = 0;
  const providers = new Script((_modelId, prompt) => {
    if (prompt.includes("You are verifying")) return verdicts();
    impl += 1;
    return `implementation v${impl}`;
  });
  const run = await runPlan([node("impl"), node("check", ["impl"], { verifies: ["impl"] }), node("report", ["check"])], providers);
  const [implNode, check, report] = run.plan.nodes;
  assert.ok(run.status === "succeeded" && run.rework_rounds === 1);
  assert.equal(implNode.result, "implementation v2");
  assert.deepEqual(check.attempts.map((t) => t.outcome), ["verify_failed", "passed"]);
  const second = providers.calls.map(([, p]) => p).filter((p) => p.startsWith("Task: do impl"))[1];
  assert.ok(second.includes("the tests still fail") && second.includes("implementation v1"));
  // The verifier's own verdict decides; nobody else reviews it.
  assert.ok(!providers.calls.some(([, p]) => p.includes(quality.REVIEW_MARKER) && p.includes("do check")));
  assert.equal(report.status, "succeeded");
});

test("a rejected rework keeps the verification's findings, and the reviewer sees them", async () => {
  const verdicts = sequence(["VERDICT: FAIL: invalid token must return 403", "VERDICT: PASS"]);
  const providers = new Script((_modelId, prompt) => (prompt.includes("You are verifying") ? verdicts() : "impl"), sequence<unknown>([
    { passed: true, reason: "ok" }, { passed: false, reason: "reminder_sent is set without SMTP", fix: "keep it unsent" }, { passed: true, reason: "ok" }]));
  const impl = node("impl", [], { instructions: "invalid token returns 404" });
  const run = await runPlan([impl, node("check", ["impl"], { verifies: ["impl"] })], providers);
  assert.ok(run.status === "succeeded" && run.rework_rounds === 1);
  const implPrompts = providers.calls.map(([, p]) => p).filter((p) => p.startsWith("Task: invalid token"));
  assert.equal(implPrompts.length, 3);
  // The retry after the reviewer's rejection still carries the verification's rework.
  assert.ok(implPrompts[2].includes("must return 403") && implPrompts[2].includes("keep it unsent"));
  const seen = providers.calls.map(([, p]) => p).filter((p) => p.includes(quality.REVIEW_MARKER) && p.includes("invalid token returns 404"));
  assert.ok(seen[1].includes("must return 403") && seen[1].includes("supersede"));
  assert.ok(seen[2].includes("must return 403"));
});

test("rework stops after the set rounds", async () => {
  settings.max_rework_rounds = 1;
  const providers = new Script((_modelId, prompt) => (prompt.includes("You are verifying") ? "VERDICT: FAIL: still broken" : "impl"));
  const run = await runPlan([node("impl"), node("check", ["impl"], { verifies: ["impl"] })], providers);
  const check = run.plan.nodes[1];
  assert.ok(run.status === "failed" && run.rework_rounds === 1);
  assert.ok(check.status === "failed" && check.review!.includes("still broken"));
});

test("long results are handed on as the reviewer's summary", async () => {
  settings.handoff_max_chars = 500;
  const long = "x".repeat(2000);
  const providers = new Script((_modelId, prompt) => (prompt.includes("do a") ? long : "done"),
    (prompt) => (prompt.includes('"summary"') ? { passed: true, reason: "ok", summary: "SHORT SUMMARY" } : { passed: true, reason: "ok" }));
  const run = await runPlan([node("a"), node("b", ["a"])], providers);
  const [a, b] = run.plan.nodes;
  assert.equal(a.summary, "SHORT SUMMARY");
  const bPrompt = providers.calls.map(([, p]) => p).find((p) => p.startsWith("Task: do b"))!;
  assert.ok(bPrompt.includes("SHORT SUMMARY") && !bPrompt.includes(long));
  assert.deepEqual(b.inputs.map((i) => [i.node_id, i.form]), [["a", "summary"]]);
});

test("unreadable reviews never accept unverified work", async () => {
  const run = await runPlan([node("a"), node("check", ["a"], { verifies: ["a"] })], new Script(() => "no verdict here", () => "I think it is fine"));
  const [a, check] = run.plan.nodes;
  assert.equal(run.status, "failed");
  assert.ok(a.review_passed === null && a.status === "failed");
  assert.ok(a.review!.includes("无法解析") && check.status === "pending");
});

test("a missing verdict retries the verification without accepting or reworking upstream", async () => {
  const run = await runPlan([node("a"), node("check", ["a"], { verifies: ["a"] })], new Script(() => "Tests failed; no verdict here"));
  const [a, check] = run.plan.nodes;
  assert.ok(run.status === "failed" && a.status === "succeeded");
  assert.ok(check.review_passed === null && check.review!.includes("VERDICT"));
  assert.equal(run.rework_rounds, 0);
});

test("a malformed reviewer moves to a backup", async () => {
  const providers = new Script(() => "done", sequence<unknown>(["not JSON", { passed: true, reason: "backup verified the work" }]));
  const run = await runPlan([node("a")], providers);
  const reviews = providers.calls.filter(([, p]) => p.includes(quality.REVIEW_MARKER)).map(([id]) => id);
  assert.ok(run.status === "succeeded" && reviews.length === 2 && reviews[0] !== reviews[1]);
  assert.equal(run.plan.nodes[0].attempts.length, 1);
});

test("the review of a scratch task sees the workspace's files", async () => {
  // A task without a project folder works in its scratch folder; the reviewer must still see it.
  const providers = new Script(() => {
    const files = join(settings.workspace_root, "run", "easylife", "static");
    mkdirSync(files, { recursive: true });
    writeFileSync(join(files, "app.js"), "renderTodos(todos);\n");
    return "done";
  });
  const run = await runPlan([node("a")], providers);
  const review = providers.calls.map(([, p]) => p).find((p) => p.includes(quality.REVIEW_MARKER))!;
  assert.equal(run.status, "succeeded");
  assert.ok(review.includes("easylife/static/app.js") && review.includes("renderTodos(todos);"));
});

test("the review of an attempt that changed nothing sees the files it names", async () => {
  const workspace = join(settings.workspace_root, "run");
  mkdirSync(join(workspace, "easylife", "static"), { recursive: true });
  writeFileSync(join(workspace, "easylife", "static", "index.html"), "<div id=todo-list></div>\n");
  mkdirSync(join(workspace, "tests"));
  writeFileSync(join(workspace, "tests", "test_api.py"), "def test_login(): pass\n");
  writeFileSync(join(workspace, ".env"), "SECRET=1\n");
  const providers = new Script(() => "Checked easylife/static/index.html and .env; all present.");
  await runPlan([node("a")], providers);
  const review = providers.calls.map(([, p]) => p).find((p) => p.includes(quality.REVIEW_MARKER))!;
  assert.ok(review.includes("Files changed: (none)"));
  assert.ok(review.includes("<div id=todo-list></div>"));
  assert.ok(review.includes("files in the workspace") && review.includes("tests/test_api.py"));
  assert.ok(!review.includes("SECRET=1"));
});
