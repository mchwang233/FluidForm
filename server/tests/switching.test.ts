// Switching a task capability while FluidForm works, and starting with one switched off
// (docs/design/task-capabilities.md): nothing fails for it, nothing is lost.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Executor } from "../src/executor.js";
import { EngineerJobSchema, ExecutionRunSchema, LearningReviewSchema, type SupervisorSession } from "../src/models.js";
import { without } from "./helpers/capabilities.js";
import { conftest } from "./helpers/conftest.js";
import { decision, leadDatabase, MODELS, Team } from "./helpers/lead-run.js";
import { taskApi } from "./helpers/task-api.js";

const { folder } = conftest();
const ORIGIN = { origin: "http://localhost:5173" };

test("the lead switched off while it decides: what it decided is done, and the task goes on", async () => {
  let restore = () => {};
  class SwitchedOff extends Team {
    override async converse(session: SupervisorSession, prompt: string) {
      const answer = await super.converse(session, prompt);
      if (this.lead.length === 1) restore = without("lead", "review");
      return answer;
    }
  }
  try {
    const db = leadDatabase(folder());
    await new Executor(db, new SwitchedOff([decision("retry", { instructions: "再试" })]), MODELS).execute("r");
    const run = db.getRun("r")!;
    assert.equal(run.status, "succeeded", run.error ?? "");
  } finally {
    restore();
  }
});

test("learning switched off during the check before the start: the task still runs", async () => {
  let restore = () => {};
  try {
    const db = leadDatabase(folder());
    const { settings } = await import("../src/config.js");
    settings.preflight = true;
    const executor = new Executor(db, new Team([], 0), MODELS);
    executor.allChecks = async () => {
      restore = without("learning", "preflight", "skills");
      return [];
    };
    await executor.execute("r");
    assert.equal(db.getRun("r")!.status, "succeeded", db.getRun("r")!.error ?? "");
  } finally {
    restore();
  }
});

test("planning switched off while a request is judged: it becomes one step", async () => {
  let restore = () => {};
  try {
    const { api, client } = taskApi(folder());
    (api as any).quickPlan = async () => {
      restore = without("planning", "team");
      return null;
    };
    api.deps.autonomousPlan = (await import("../src/planning.js")).autonomousPlan;
    const made = await client.post("/api/tasks", { json: { prompt: "换算 37 摄氏度", budget_usd: 1 }, headers: ORIGIN });
    assert.equal(made.status_code, 201, made.text);
    assert.equal(made.json().plan.nodes.length, 1);
  } finally {
    restore();
  }
});

test("starting with learning off leaves a review asked by hand waiting", async () => {
  const restore = without("learning", "preflight", "skills");
  try {
    const { api } = taskApi(folder());
    api.db.saveRun(ExecutionRunSchema.parse({ id: "done", prompt: "p", status: "succeeded", budget_usd: 1, plan: { summary: "s", nodes: [] } }));
    api.db.saveLearningReview(LearningReviewSchema.parse({ run_id: "done", revision: "r1", budget_usd: 0.5, automatic: false }));
    const { restoreLearning } = await import("../src/learning.js");
    assert.doesNotThrow(() => restoreLearning(api.executor as any));
    assert.equal(api.db.learningReview("done")!.status, "queued");
  } finally {
    restore();
  }
});

test("with the engineer off its work waits, and nothing is approved", async () => {
  const restore = without("engineer", "diagnosis");
  try {
    const { api, client } = taskApi(folder());
    const save = (id: string, status: string) => api.executor.engineerSave(EngineerJobSchema.parse({ id, request: "加一个工具", title: "加一个工具",
      kind: "component", status, phase: "plan", budget_usd: 1, plan: "方案" }));
    save("queued", "queued");
    save("planned", "plan_ready");
    save("ready", "ready");
    api.executor.engineerKick();
    await api.executor.engineerTask?.settled();
    assert.equal(api.executor.engineerJob("queued").status, "queued");
    for (const id of ["planned", "ready"]) {
      const answer = await client.post(`/api/engineer/jobs/${id}/approve`, { json: {}, headers: ORIGIN });
      assert.ok(answer.status_code >= 400 && answer.text.includes("没有启用平台工程师"), answer.text);
    }
    assert.deepEqual([api.executor.engineerJob("planned").status, api.executor.engineerJob("ready").status], ["plan_ready", "ready"]);
  } finally {
    restore();
  }
});

test("work that waited goes on when the engineer is switched on again", async () => {
  const { api, client } = taskApi(folder());
  await (await import("../src/bundled.js")).offer();
  const set = (enabled: boolean) => client.patch("/api/capabilities/engineer", { json: { enabled, confirmed: true }, headers: ORIGIN });
  assert.equal((await set(false)).status_code, 200);
  let kicked = 0;
  api.executor.engineerKick = () => {
    kicked += 1;
  };
  assert.equal((await set(true)).status_code, 200);
  assert.equal(kicked, 1);
});
