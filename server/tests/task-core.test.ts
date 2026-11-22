// FluidForm's base (docs/design/task-capabilities.md): without any of the task capabilities a task is
// still done, as one step on one model, retried by fixed rules; what needs them says so.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as supervisor from "../src/supervisor.js";
import { TASK_CAPABILITIES, without } from "./helpers/capabilities.js";
import { conftest } from "./helpers/conftest.js";
import { taskApi } from "./helpers/task-api.js";

const { folder } = conftest();
const ORIGIN = { origin: "http://localhost:5173" };

test("without the task capabilities a task is the whole request as one step, done to its end", async () => {
  const restore = without(...TASK_CAPABILITIES);
  try {
    const { api, client } = taskApi(folder());
    const created = await client.post("/api/tasks", { json: { prompt: "把 37 摄氏度换算成华氏度并说明公式", budget_usd: 1 }, headers: ORIGIN });
    assert.equal(created.status_code, 201, created.text);
    const run = created.json();
    assert.equal(run.plan.nodes.length, 1);
    assert.match(run.plan.planning_note, /没有启用规划能力/);
    assert.ok(run.plan.nodes[0].instructions.startsWith("把 37 摄氏度换算成华氏度"));
    assert.equal(run.plan.nodes[0].model_id, "mock:local");
    assert.equal((await client.post(`/api/tasks/${run.id}/confirm`, { json: { budget_usd: 1 }, headers: ORIGIN })).status_code, 200);
    await api.executor.tasks.get(run.id)?.promise;
    const done = api.db.getRun(run.id)!;
    assert.equal(done.status, "succeeded", done.error ?? "");
    assert.ok(done.final_result);
    // What needs a capability it does not have says so, rather than half working.
    const asked = await client.post(`/api/tasks/${run.id}/lead`, { json: { message: "怎么样了？" }, headers: ORIGIN });
    assert.ok(asked.status_code === 409 && asked.json().detail.includes("负责人能力"), asked.text);
    const engineer = await client.post("/api/engineer/jobs", { json: { request: "加一个 PDF 工具", kind: "component" }, headers: ORIGIN });
    assert.ok(engineer.status_code >= 400 && engineer.text.includes("平台工程师"), engineer.text);
    assert.ok(!supervisor.offeredActions().some((action) => ["replan", "call_engineer", "repair_platform"].includes(action)));
  } finally {
    restore();
  }
});

test("each capability is offered only with what it needs", () => {
  const restore = without("planning");
  try {
    assert.ok(!supervisor.offeredActions().includes("replan"));
  } finally {
    restore();
  }
  assert.ok(supervisor.offeredActions().includes("replan"));
});
