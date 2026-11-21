// What a review is shown and how artifacts stay honest: tests/test_review_evidence.py, ported.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import * as agent from "../src/agent.js";
import { settings } from "../src/config.js";
import * as contracts from "../src/contracts.js";
import { Database } from "../src/db.js";
import { Executor } from "../src/executor.js";
import { ExecutionRunSchema, ModelProfileSchema, TaskNodeSchema } from "../src/models.js";
import { type CompleteOptions, ProviderResult } from "../src/providers.js";
import * as quality from "../src/quality.js";
import { contractNode, coverageNodes, mockAcceptance, restoreAcceptance, setupExecutor } from "./helpers/artifacts.js";
import { conftest } from "./helpers/conftest.js";

const { folder } = conftest();
const reviewer = () => ModelProfileSchema.parse({ id: "openai:reviewer", provider: "openai", display_name: "Reviewer", context_window: 1_000_000,
  input_per_million: 1, output_per_million: 1, scores: { coding: 99, reliability: 99 } });
const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const noOutput = async () => undefined;

test("new changes do not hide earlier files, and the review uses the project", async () => {
  settings.review_nodes = true;
  const project = join(folder(), "project");
  write(join(project, "DELIVERY.md"), "delivery\n".repeat(quality.MAX_DIFF_CHARS));
  write(join(project, "db.py"), "existing_users_migrated = True\n");
  write(join(project, "test_db.py"), "def test_tokens(): pass\n");
  write(join(project, ".tmp-verify", "tests.log"), "Ran 155 tests\nOK\n");
  const task = TaskNodeSchema.parse({ id: "work", title: "Work", instructions: "Implement email verification; check test_db.py", capability: "coding",
    model_id: "openai:worker", changed_files: ["db.py"] });
  const run = ExecutionRunSchema.parse({ id: "review-run", prompt: "implement", status: "running", budget_usd: 10, use_cli: false, project_dir: project,
    plan: { summary: "implement", nodes: [task] } });
  const captured: [string, unknown, CompleteOptions][] = [];
  const providers = { configuredModels: (ids: Iterable<string>) => new Set(ids), async complete(modelId: string, prompt: string, options: CompleteOptions = {}) {
    captured.push([prompt, options.workspace, options]);
    return new ProviderResult('{"passed":true,"reason":"checked"}', 10, 10, modelId);
  } };
  const db = new Database(join(folder(), "test.db"));
  db.saveRun(run);
  const executor = new Executor(db, providers, { [reviewer().id]: reviewer() });
  const verdict = await executor.checkResult(run, task, "See .tmp-verify/tests.log", ["DELIVERY.md"], project);
  assert.ok(verdict.passed);
  const [prompt, workspace, options] = captured[0];
  assert.ok(prompt.includes("Files changed: DELIVERY.md"));
  assert.ok(prompt.includes("existing_users_migrated = True") && prompt.includes("def test_tokens()"));
  assert.ok(prompt.includes("Ran 155 tests\nOK"));
  assert.equal(options.review_workspace, project);
  assert.ok((options.review_files as string[]).includes(".tmp-verify/tests.log"));
  assert.notEqual(workspace, project);
  await executor.finish(run.id, task.id, new ProviderResult("done", 0, 0), verdict, [], ["DELIVERY.md"], 0, null);
  assert.deepEqual(new Set(db.getRun(run.id)!.plan.nodes[0].changed_files), new Set(["db.py", "DELIVERY.md"]));
});

test("the review gets the build log and keeps a simulation's failure", async () => {
  for (const passed of [true, false]) {
    settings.review_nodes = true;
    const project = join(folder(), `project-${passed}`);
    const log = join(project, "build", "tb", "compile.log");
    write(log, passed ? "SIMULATION_PASS\nRC=0\n" : "SIMULATION_FAIL: assertion failed\nRC=1\n");
    const task = TaskNodeSchema.parse({ id: "work", title: "Work", instructions: "Run simulation", capability: "coding", model_id: "openai:worker" });
    const other = TaskNodeSchema.parse({ id: "other", title: "Other", instructions: "Preserve revised coverage plan", capability: "coding", model_id: "openai:worker",
      status: "succeeded", result: "revised coverage model" });
    const run = ExecutionRunSchema.parse({ id: "build-review", prompt: "simulate", status: "running", budget_usd: 10, use_cli: false, project_dir: project,
      plan: { summary: "simulate", nodes: [task, other] } });
    const providers = { configuredModels: (ids: Iterable<string>) => new Set(ids), async complete(modelId: string, prompt: string, options: CompleteOptions = {}) {
      assert.ok(prompt.includes(readFileSync(log, "utf8")));
      assert.equal(options.review_workspace, project);
      assert.deepEqual(options.review_files, ["build/tb/compile.log"]);
      const ws = new agent.Workspace(project, { readOnly: true, readableFiles: options.review_files as string[] });
      const output = await ws.call("Read", { file_path: "build/tb/compile.log" });
      ws.close();
      assert.ok(output.includes("RC="));
      return new ProviderResult(JSON.stringify({ passed: output.includes("RC=0"), reason: output }), 10, 10, modelId);
    } };
    const db = new Database(join(folder(), `test-${passed}.db`));
    db.saveRun(run);
    const executor = new Executor(db, providers, { [reviewer().id]: reviewer() });
    // A worker's PASS claim must not replace the log's actual failure in the evidence.
    const result = new ProviderResult("Simulation passed; see build/tb/compile.log", 0, 0);
    const verdict = await executor.checkResult(run, task, result.text, [], project);
    assert.equal(verdict.passed, passed);
    await executor.finish(run.id, task.id, result, verdict, [], [], 0, null);
    const saved = db.getRun(run.id)!;
    assert.equal(saved.plan.nodes[0].attempts.at(-1)!.outcome, passed ? "passed" : "rejected");
    assert.deepEqual(saved.plan.nodes[1], other);
    assert.equal(saved.rework_rounds, 0);
  }
});

test("an artifact's missing, empty or unchanged report cannot pass on a claim", async () => {
  for (const content of [null, "", "old report"]) {
    const node = contractNode("write", null as never, [], "report.txt", { contract: { max_turns: 1 } });
    const [executor, db, providers] = setupExecutor(join(folder(), String(content)), [node], noOutput);
    const root = contracts.workspace(db.getRun("artifacts")!, node);
    mkdirSync(root, { recursive: true });
    if (content !== null) writeFileSync(join(root, "report.txt"), content);
    const checks: [string, boolean, boolean][] = [];
    mockAcceptance(checks);
    await executor.execute("artifacts");
    restoreAcceptance();
    const run = db.getRun("artifacts")!;
    assert.ok(run.status === "incomplete" && providers.calls.length === 1, String(content));
    assert.ok(!run.plan.nodes[0].review_passed);
    assert.deepEqual(checks, []);
  }
});

test("an artifact's failed acceptance keeps the command's log and blocks the audit", async () => {
  mockAcceptance(null, false);
  try {
    const [executor, db, providers] = setupExecutor(folder());
    const given = db.getRun("artifacts")!;
    given.plan.nodes[0].artifact_contract!.max_turns = 1;
    db.saveRun(given);
    await executor.execute("artifacts");
    const run = db.getRun("artifacts")!;
    assert.deepEqual(providers.calls, ["vdb"]);
    assert.ok(run.plan.nodes.every((node) => node.status === "blocked"));
    assert.equal(run.plan.nodes[0].artifact_evidence!.checks[0].ok, false);
    assert.ok(run.plan.nodes[0].attempts[0].tool_calls.at(-1)!.output!.includes("artifact check failed"));
    assert.ok(run.plan.nodes[0].attempts[0].trace);
  } finally {
    restoreAcceptance();
  }
});

test("an accepted report goes stale when the VDB upstream changes", async () => {
  const nodes = coverageNodes();
  const [executor, db, providers] = setupExecutor(folder(), nodes.slice(0, 2));
  mockAcceptance();
  try {
    await executor.execute("artifacts");
    let run = db.getRun("artifacts")!;
    assert.equal(run.status, "succeeded");
    writeFileSync(join(contracts.workspace(run, nodes[0]), "coverage.vdb", "coverage.db"), "changed simulation");
    run.plan.nodes.push(nodes[2]);
    run.status = "queued";
    providers.nodes.set(nodes[2].id, nodes[2]);
    db.saveRun(run);
    await executor.execute("artifacts");
    run = db.getRun("artifacts")!;
    assert.equal(run.plan.nodes[2].status, "blocked");
    assert.deepEqual(providers.calls, ["vdb", "report"]);
    assert.ok(run.plan.nodes[2].review!.includes("过期"));
  } finally {
    restoreAcceptance();
  }
});

test("an unfinished audit does not send back an accepted report", async () => {
  const nodes = coverageNodes();
  nodes[2].artifact_contract!.max_turns = 2;
  const [executor, db, providers] = setupExecutor(folder(), nodes.slice(0, 2));
  mockAcceptance();
  try {
    await executor.execute("artifacts");
    let run = db.getRun("artifacts")!;
    assert.equal(run.status, "succeeded");
    run.plan.nodes.push(nodes[2]);
    run.status = "queued";
    db.saveRun(run);
    providers.nodes.set(nodes[2].id, nodes[2]);
    providers.work = noOutput;
    await executor.execute("artifacts");
    run = db.getRun("artifacts")!;
    assert.deepEqual(providers.calls, ["vdb", "report", "audit", "audit"]);
    assert.equal(run.rework_rounds, 0);
    assert.ok(run.plan.nodes.slice(0, 2).every((n) => n.status === "succeeded" && n.attempts.length === 1));
    assert.equal(run.plan.nodes[2].attempts.at(-1)!.outcome, "stopped");
  } finally {
    restoreAcceptance();
  }
});
