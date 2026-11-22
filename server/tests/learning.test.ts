// learning.ts: tests/test_learning.py, ported.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import * as agent from "../src/agent.js";
import { settings } from "../src/config.js";
import { Database } from "../src/db.js";
import { Executor } from "../src/executor.js";
import * as learning from "../src/learning.js";
import * as learningPackage from "../packages/learning/src/learning.js";
import { CapabilityScoreFields, EngineerJobSchema, type ExecutionRun, ExecutionRunSchema, type Improvement, ImprovementSchema, LearningReviewSchema,
  type ModelProfile, ModelProfileSchema, TaskNodeSchema } from "../src/models.js";
import { type CompleteOptions, ProviderResult } from "../src/providers.js";
import * as retrospect from "../src/retrospect.js";
import * as skills from "../src/skills.js";
import { conftest } from "./helpers/conftest.js";

const { folder } = conftest();
const originalCheck = learningPackage.checks.skill;
afterEach(() => {
  learningPackage.checks.skill = originalCheck;
});

const model = (id: string, coding: number, channel = "api", fields: Partial<ModelProfile> = {}) => ModelProfileSchema.parse({ id, provider: id.split(":")[0], display_name: id, channel,
  context_window: 1_000_000, input_per_million: 1, output_per_million: 1, execution_priority: channel === "cli" ? 0 : 100, scores: { coding, planning: 80, reliability: 90 }, ...fields });

function proposal(kind = "rule", extra: Record<string, unknown> = {}) {
  return { kind, title: "Keep the compile check small", rationale: "Step n spent 40 turns on setup",
    content: "Run a small compile check before the full check; keep both acceptance checks.",
    tools: ["fakecompiler"], capability: "coding", source_nodes: ["n"], problem_kind: "turns_over", problem_key: "x:writer", ...extra };
}

type Call = [string, string, unknown, CompleteOptions];

class Models {
  prompts: Call[] = [];
  constructor(public items: unknown[] = [proposal()], public approved = true) {}

  configuredModels(ids: Iterable<string>): Set<string> {
    return new Set(ids);
  }

  async complete(modelId: string, prompt: string, options: CompleteOptions = {}): Promise<ProviderResult> {
    this.prompts.push([modelId, prompt, options.workspace, options]);
    let text = "completed";
    if (prompt.includes("learning:analyze")) text = JSON.stringify({ conclusion: "Repeated setup cost too many turns; reuse a checked command.", improvements: this.items });
    else if (prompt.includes("learning:validate")) text = JSON.stringify({ passed: this.approved, reason: "The evidence supports the bounded advice." });
    return new ProviderResult(text, 10, 10, modelId);
  }
}

function finished(db: Database, runId = "first", cost = 0.2, turns = 40, modelId = "x:writer"): ExecutionRun {
  const node = TaskNodeSchema.parse({ id: "n", title: "compile", instructions: "Use fakecompiler to compile a fixture", capability: "coding", model_id: modelId,
    status: "succeeded", estimated_cost_usd: 0.01, attempts: [{ model_id: modelId, outcome: "passed", turns, cost_usd: cost }] });
  const run = ExecutionRunSchema.parse({ id: runId, prompt: "Use fakecompiler", plan: { summary: "s", nodes: [node] }, status: "succeeded", budget_usd: 1, actual_cost_usd: cost });
  db.saveRun(run);
  retrospect.record(db, run.id);
  return run;
}

let db: Database;
let models: Models;
let executor: Executor;
const setModels = (...items: ModelProfile[]) => {
  (executor as unknown as { modelLookup: Record<string, ModelProfile> }).modelLookup = Object.fromEntries(items.map((m) => [m.id, m]));
};
beforeEach(() => {
  settings.review_nodes = false;
  db = new Database(join(folder(), "test.db"));
  db.saveLearningSettings({ enabled: true, budget_usd: 0.1 });
  models = new Models();
  executor = new Executor(db, models, Object.fromEntries([model("x:writer", 90), model("y:reviewer", 92)].map((m) => [m.id, m])));
});
afterEach(() => db.connection.close());

async function learn(runId = "first") {
  executor.startLearning(runId);
  await executor.learningTasks.get(runId)!.promise;
  return [db.learningReview(runId)!, db.improvements(runId)] as const;
}
const settle = (runId: string) => executor.learningTasks.get(runId)!.promise.catch(() => undefined);

test("learning uses the strongest model for the analysis and a fresh review", async () => {
  for (const channel of ["api", "cli"]) {
    finished(db);
    settings.subtasks_prefer_api = true;
    const all = Object.fromEntries(Object.keys(CapabilityScoreFields).map((key) => [key, 99]));
    const strongest = model("best:review", 99, channel, { scores: all as never, input_per_million: 100, output_per_million: 100 });
    const cheap = model("cheap:summary", 80, "api", { input_per_million: 0, output_per_million: 0 });
    setModels(cheap, model("cli:weak", 70, "cli"), strongest);
    models.prompts = [];
    db.connection.exec("DELETE FROM learning_reviews; DELETE FROM improvements");
    const [review, [item]] = await learn();
    assert.ok(review.status === "done" && review.model_id === strongest.id, channel);
    assert.ok(item.validation.model_id === strongest.id && item.status === "active");
    assert.deepEqual(models.prompts.map((call) => call[0]), [strongest.id, strongest.id]);
    assert.notEqual(models.prompts[0][2], models.prompts[1][2]); // Independent, empty conversations.
    assert.ok(models.prompts.every((call) => call[3].effort === settings.diagnosis_reasoning_effort));
  }
});

test("learning prefers a different, equally strong validator", async () => {
  finished(db);
  const first = model("a:best", 99);
  const peer = ModelProfileSchema.parse({ ...first, id: "b:peer" });
  setModels(model("cheap:summary", 70, "api", { input_per_million: 0, output_per_million: 0 }), peer, first);
  const [review, [item]] = await learn();
  assert.equal(review.model_id, first.id);
  assert.equal(item.validation.model_id, peer.id);
});

test("learning only uses models it may", async () => {
  for (const unavailable of ["disabled", "unconfigured", "context", "cli_disallowed"]) {
    db.connection.exec("DELETE FROM learning_reviews; DELETE FROM improvements");
    models = new Models();
    executor = new Executor(db, models, {});
    const run = finished(db);
    const best = model("cli:best", 99, "cli");
    const allowed = model("allowed:review", 80);
    if (unavailable === "disabled") best.enabled = false;
    else if (unavailable === "unconfigured") models.configuredModels = () => new Set([allowed.id]);
    else if (unavailable === "context") best.context_window = 100;
    else {
      run.use_cli = false;
      db.saveRun(run);
    }
    setModels(best, allowed);
    const [review] = await learn();
    assert.ok(review.status === "done" && review.model_id === allowed.id, unavailable);
    assert.deepEqual(new Set(models.prompts.map((call) => call[0])), new Set([allowed.id]));
  }
});

test("a finished event makes a review and a verified rule", async () => {
  const original = finished(db);
  executor.emit("first", "run.succeeded");
  await executor.learningTasks.get("first")!.promise;
  const review = db.learningReview("first")!;
  const [item] = db.improvements("first");
  assert.ok(review.status === "done" && review.conclusion);
  assert.ok(item.status === "active" && item.validation.model_id === "y:reviewer");
  assert.ok(review.cost_usd > 0 && db.getRun("first")!.actual_cost_usd === original.actual_cost_usd);
  assert.equal(db.getRun("first")!.status, "succeeded");
  assert.ok(models.prompts.every(([, , , options]) => !options.act && !options.network));
  executor.emit("first", "run.succeeded");
  await executor.learningTasks.get("first")!.promise;
  assert.ok(models.prompts.length === 2 && db.improvements().length === 1);
});

test("only matching work gets a snapshot, and is measured", async () => {
  finished(db);
  const [, [item]] = await learn();
  const run = finished(db, "second", 0.05, 10);
  run.improvement_uses = learning.selected(db, run.prompt);
  assert.ok(learning.instruction(run.improvement_uses).includes(item.title));
  run.status = "queued";
  run.plan.nodes[0].status = "pending";
  run.plan.nodes[0].attempts = [];
  db.saveRun(run);
  await executor.execute(run.id);
  await executor.learningTasks.get(run.id)!.promise;
  const result = db.getRun(run.id)!;
  assert.deepEqual((result.improvement_uses[0] as Record<string, unknown>).node_ids, ["n"]);
  assert.ok(models.prompts.some(([, prompt]) => prompt.includes(item.content) && prompt.includes("Task:")));
  const [effect] = db.improvementEffects(item.id) as Record<string, any>[];
  assert.ok(effect.comparable && effect.delta.cost_per_step < 0);
  learning.observe(db, result);
  assert.equal(db.improvementEffects(item.id).length, 1);
  item.content = "changed";
  item.status = "disabled";
  db.saveImprovement(item);
  assert.ok(!learning.instruction(result.improvement_uses as never).includes("changed"));
  assert.deepEqual(learning.selected(db, "fakecompiler"), []);
  const unrelated = TaskNodeSchema.parse({ ...result.plan.nodes[0], instructions: "write a poem", title: "poem", capability: "writing" });
  assert.equal(learning.instruction(result.improvement_uses as never, unrelated), "");
});

test("a different model does not make a false claim of effect", async () => {
  finished(db);
  const [, [item]] = await learn();
  const run = finished(db, "second", 0.2, 40, "y:reviewer");
  run.improvement_uses = learning.selected(db, run.prompt);
  run.improvement_uses[0].node_ids = ["n"];
  learning.observe(db, run);
  const [effect] = db.improvementEffects(item.id) as Record<string, any>[];
  assert.ok(!effect.comparable);
  assert.deepEqual(effect.delta, {});
});

test("a skill needs a real check and an independent review", async () => {
  for (const approved of [false, true]) {
    db.connection.exec("DELETE FROM learning_reviews; DELETE FROM improvements");
    finished(db);
    const content = "---\nname: compile-small\ndescription: compile check\ntools: [fakecompiler]\n---\nCompile a small fixture first.";
    models.items = [proposal("skill", { content, check: "fakecompiler fixture" })];
    models.approved = approved;
    const checked: string[] = [];
    learningPackage.checks.skill = async (item: Improvement) => {
      checked.push(item.check!);
      return { passed: true, output: "fixture passed", command: item.check };
    };
    const [, [item]] = await learn();
    assert.deepEqual(checked, ["fakecompiler fixture"]);
    assert.equal(item.status, approved ? "active" : "failed");
    const artifact = join(settings.data_dir, "learned-skills", item.id, "SKILL.md");
    assert.equal(existsSync(artifact), approved);
    if (approved) {
      assert.equal(readFileSync(artifact, "utf8"), content);
      // Written into this machine's skill for the tool, which the steps are given ...
      const [mine] = skills.library().filter((s) => s.machine);
      assert.ok(mine.tools.includes("fakecompiler") && mine.body.includes("Compile a small fixture first."));
      assert.deepEqual(item.validation.merged_into, [mine.path]);
      // ... and so not repeated as a separate lesson.
      const uses = learning.selected(db, "fakecompiler");
      assert.ok(uses.length && learning.instruction(uses) === "");
    }
  }
});

test("a skill whose check fails is never published", async () => {
  finished(db);
  models.items = [proposal("skill", { content: "---\nname: c\ntools: [fakecompiler]\n---\nCompile a fixture.", check: "false" })];
  learningPackage.checks.skill = async () => ({ passed: false, output: "bad command" });
  const [, [item]] = await learn();
  assert.ok(item.status === "failed");
  assert.deepEqual(learning.selected(db, "fakecompiler"), []);
  assert.equal(models.prompts.length, 1);
});

test("invented evidence and unbounded scope are rejected", () => {
  const run = finished(db);
  for (const change of [{ source_nodes: ["invented"] }, { tools: [], capability: null }, { problem_key: "invented" }, { tools: ["../unsafe"] }]) {
    assert.throws(() => learningPackage.parseAnalysis(JSON.stringify({ conclusion: "c", improvements: [proposal("rule", change)] }), run), JSON.stringify(change));
  }
});

test("invalid model output changes neither the task nor what is published", async () => {
  finished(db);
  models.items = [proposal("rule", { source_nodes: ["invented"] })];
  const [review, items] = await learn();
  assert.ok(review.status === "blocked" && items.length === 0);
  assert.equal(db.getRun("first")!.status, "succeeded");
});

test("running out of budget is recorded without reopening finished work", async () => {
  finished(db);
  models.complete = async (modelId: string, _prompt: string, options: CompleteOptions = {}) => {
    await (options.spend_ok as { reserve(id: string, payload: unknown): Promise<number> }).reserve(modelId, { text: "large".repeat(1_000_000) });
    throw new assert.AssertionError({ message: "the reservation must reject the call" });
  };
  const [review, items] = await learn();
  assert.ok(review.status === "blocked" && !items.length);
  assert.equal(db.getRun("first")!.status, "succeeded");
});

test("a restart resumes the validation without making the items again", async () => {
  const run = finished(db);
  const [conclusion, [item]] = learningPackage.parseAnalysis(JSON.stringify({ conclusion: "c", improvements: [proposal()] }), run);
  item.status = "validating";
  db.saveImprovement(item);
  db.saveLearningReview(LearningReviewSchema.parse({ run_id: run.id, revision: learning.revision(run), status: "validating", conclusion, model_id: "x:writer" }));
  executor.restoreLearning();
  await executor.learningTasks.get(run.id)!.promise;
  assert.ok(db.improvements().length === 1 && db.improvement(item.id)!.status === "active");
  assert.ok(models.prompts.length === 1 && models.prompts[0][1].includes("learning:validate"));
});

test("platform changes go to the engineer and wait for it to take effect", async () => {
  finished(db, "earlier"); // the same problem came up in an earlier task
  finished(db);
  models.items = [proposal("platform", { content: "Improve the task splitting rule and add a regression test." })];
  const requested: Record<string, unknown>[] = [];
  executor.engineerRequest = (request, kind, origin, options = {}) => {
    requested.push({ kind, origin, ...options });
    const job = EngineerJobSchema.parse({ request, kind, origin, run_id: options.runId ?? null, budget_usd: options.budgetUsd ?? 0, improvement_id: options.improvementId ?? null });
    db.saveEngineerJob(job);
    return job;
  };
  const [review, [item]] = await learn();
  assert.ok(item.status === "engineering" && requested[0].origin === "retrospective");
  assert.ok((requested[0].budgetUsd as number) + review.cost_usd <= review.budget_usd);
  assert.deepEqual(learning.selected(db, "fakecompiler"), []);
  const job = db.getEngineerJob(item.engineer_job_id!)!;
  job.status = "applied";
  job.checks = ["backend tests"];
  db.saveEngineerJob(job);
  executor.syncImprovements();
  assert.equal(db.improvement(item.id)!.status, "active");
});

test("a change for a problem seen in one task only waits", async () => {
  // Regression: every retrospective sent its platform idea to the engineer as a component; most were
  // turned down, after waiting hours for the user.
  finished(db);
  models.items = [proposal("platform", { content: "Improve the task splitting rule and add a regression test." })];
  const requested: unknown[] = [];
  executor.engineerRequest = ((...args: unknown[]) => requested.push(args)) as never;
  const [, [item]] = await learn();
  assert.ok(!requested.length && item.status === "deferred" && item.validation.reason.includes("只在这一个任务里出现过"));
  assert.deepEqual(retrospect.runsWith(db, "turns_over", "x:writer"), new Set(["first"]));
});

test("a duplicate lesson is not published again by later reviews", async () => {
  finished(db);
  await learn();
  finished(db, "another");
  executor.startLearning("another");
  await executor.learningTasks.get("another")!.promise;
  assert.equal(db.learningReview("another")!.status, "done");
  assert.equal(db.improvements().length, 1);
});

test("lessons are frozen before the first step", async () => {
  finished(db);
  const [, [item]] = await learn();
  const run = finished(db, "second");
  learning.attach(db, run);
  db.saveImprovement(ImprovementSchema.parse({ ...item, id: "another", title: "new advice" }));
  learning.attach(db, run);
  assert.deepEqual(run.improvement_uses.map((use) => use.id), [item.id]);
});

test("a skill's validation really runs in an empty sandbox", { skip: !agent.sandboxAvailable() && "bubblewrap is not installed" }, async () => {
  const run = finished(db);
  const item = ImprovementSchema.parse({ run_id: run.id, revision: learning.revision(run),
    ...proposal("skill", { check: "printf 'sample' > fixture; test \"$(cat fixture)\" = sample; printf 'checked'" }) });
  assert.equal((await learningPackage.checkSkill(item)).passed, true);
  item.check = "exit 7";
  assert.equal((await learningPackage.checkSkill(item)).passed, false);
});

test("learning turned off costs no model calls", () => {
  finished(db);
  db.saveLearningSettings({ enabled: false });
  executor.emit("first", "run.succeeded");
  assert.ok(db.learningReview("first") === null && models.prompts.length === 0);
  assert.ok(db.retrospective("first"));
});

test("deleting a task keeps its learning records and observations", () => {
  const run = finished(db);
  const item = ImprovementSchema.parse({ run_id: run.id, revision: learning.revision(run), ...proposal() });
  db.saveImprovement(item);
  db.saveLearningReview(LearningReviewSchema.parse({ run_id: run.id, revision: learning.revision(run) }));
  db.saveImprovementEffect(item.id, "later", { run_id: "later" });
  db.deleteRun(run.id);
  assert.ok(db.improvement(item.id) && db.learningReview(run.id));
  assert.equal(db.improvementEffects(item.id).length, 1);
});

test("a natural end still learns by itself", async () => {
  for (const status of ["succeeded", "failed", "incomplete"] as const) {
    db.connection.exec("DELETE FROM learning_reviews; DELETE FROM improvements");
    models.prompts = [];
    const run = finished(db);
    run.status = status;
    db.saveRun(run);
    executor.emit(run.id, `run.${status}`);
    await executor.learningTasks.get(run.id)!.promise;
    assert.equal(db.learningReview(run.id)!.status, "done", status);
    assert.equal(db.learningReview(run.id)!.automatic, true);
    assert.equal(models.prompts.length, 2);
  }
});

test("a restart skips old automatic reviews of cancelled tasks", () => {
  for (const status of ["queued", "analyzing", "validating", "blocked"]) {
    const run = finished(db);
    run.status = "cancelled";
    db.saveRun(run);
    // An old record has no automatic field. It must not become a manual request on restart.
    const review = LearningReviewSchema.parse({ run_id: run.id, revision: learning.revision(run), status, error: "old failure" });
    db.saveLearningReview(review);
    const item = ImprovementSchema.parse({ run_id: run.id, revision: review.revision, status: "validating", ...proposal(), id: `item-${status}` });
    item.status = "validating";
    db.saveImprovement(item);
    executor.restoreLearning();
    assert.ok(!executor.learningTasks.has(run.id) && !models.prompts.length, status);
    assert.equal(db.learningReview(run.id)!.status, "skipped");
    assert.equal(db.learningReview(run.id)!.error, null);
    assert.equal(db.improvement(item.id)!.status, "disabled");
  }
});

test("a review the user asks for of a cancelled task is explicit and survives a restart", async () => {
  const run = finished(db);
  run.status = "cancelled";
  db.saveRun(run);
  assert.equal(executor.startLearning(run.id), null);
  assert.ok(!models.prompts.length && db.learningReview(run.id) === null);
  executor.startLearning(run.id, true);
  await executor.learningTasks.get(run.id)!.promise;
  const review = db.learningReview(run.id)!;
  assert.ok(review.status === "done" && review.automatic === false);
  const [item] = db.improvements(run.id);
  item.status = "validating";
  review.status = "validating";
  db.saveImprovement(item);
  db.saveLearningReview(review);
  models.prompts = [];
  db.saveLearningSettings({ enabled: false });
  executor.restoreLearning();
  await executor.learningTasks.get(run.id)!.promise;
  assert.equal(db.learningReview(run.id)!.status, "done");
  assert.ok(models.prompts.length === 1 && models.prompts[0][1].includes("learning:validate"));
});

test("cancelling stops learning, and a late reply cannot publish", async () => {
  for (const phase of ["analyzing", "validating"]) {
    db.connection.exec("DELETE FROM learning_reviews; DELETE FROM improvements");
    models = new Models();
    executor = new Executor(db, models, Object.fromEntries([model("x:writer", 90), model("y:reviewer", 92)].map((m) => [m.id, m])));
    const run = finished(db);
    if (phase === "validating") {
      const review = LearningReviewSchema.parse({ run_id: run.id, revision: learning.revision(run), conclusion: "existing conclusion" });
      db.saveLearningReview(review);
      db.saveImprovement(ImprovementSchema.parse({ run_id: run.id, revision: review.revision, ...proposal() }));
    }
    let started!: () => void;
    let release!: () => void;
    const begun = new Promise<void>((done) => (started = done));
    const released = new Promise<void>((done) => (release = done));
    let cancelled = false;
    const complete = models.complete.bind(models);
    models.complete = async (modelId: string, prompt: string, options: CompleteOptions = {}) => {
      started();
      await new Promise<void>((done) => {
        released.then(done);
        options.signal?.addEventListener("abort", () => {
          cancelled = true;
          done();
        });
      });
      // A channel may return a last reply during cancellation cleanup.
      return complete(modelId, prompt, options);
    };
    executor.startLearning(run.id);
    await Promise.race([begun, new Promise((_, fail) => setTimeout(() => fail(new Error("never started")), 2000).unref())]);
    run.status = "cancelled";
    db.saveRun(run);
    executor.cancel(run.id);
    await Promise.resolve();
    release();
    await settle(run.id);
    assert.ok(cancelled, phase);
    assert.equal(db.learningReview(run.id)!.status, "skipped");
    assert.ok(db.improvements(run.id).every((item) => item.status === "disabled"));
    assert.equal(models.prompts.length, 1);
  }
});

test("skipping cancelled work keeps finished reviews", async () => {
  const run = finished(db);
  const [review, [item]] = await learn();
  run.status = "cancelled";
  db.saveRun(run);
  executor.restoreLearning();
  assert.equal(db.learningReview(run.id)!.conclusion, review.conclusion);
  assert.equal(db.learningReview(run.id)!.status, "done");
  assert.equal(db.improvement(item.id)!.status, "active");
});
