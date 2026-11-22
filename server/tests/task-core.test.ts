// FluidForm's base (docs/design/task-capabilities.md): without any of the task capabilities a task is
// still done, as one step on one model, retried by fixed rules; what needs them says so.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as agent from "../src/agent.js";
import * as bundled from "../src/bundled.js";
import * as packages from "../src/capability-packages.js";
import { Executor } from "../src/executor.js";
import { uses } from "../src/features.js";
import { type CompleteOptions, ProviderResult } from "../src/providers.js";
import * as prompts from "../packages/lead/src/prompts.js";
import { TASK_CAPABILITIES, without } from "./helpers/capabilities.js";
import { conftest } from "./helpers/conftest.js";
import { decision, leadDatabase, MODELS, run as runTask, Team } from "./helpers/lead-run.js";
import { taskApi } from "./helpers/task-api.js";
import { zipOf } from "./helpers/zip-writer.js";

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
    assert.ok(!prompts.offeredActions().some((action) => ["replan", "call_engineer", "repair_platform"].includes(action)));
  } finally {
    restore();
  }
});

test("each capability is offered only with what it needs", () => {
  const restore = without("planning");
  try {
    // Every question follows the switches as they are when it is asked.
    const node = leadDatabase(folder()).getRun("r")!;
    const asked = prompts.repairMessage(node, node.plan.nodes[0], { status: "done", verdict: "fixed", error: null, report: "修好了" }, [], [1, 1]);
    assert.doesNotMatch(asked, /"replan"|\breplan \|/);
    assert.ok(!prompts.offeredActions().includes("replan"));
  } finally {
    restore();
  }
  assert.ok(prompts.offeredActions().includes("replan"));
});

test("without a lead or an engineer a failed step is tried again on its model, then on a stronger one, then fails", async () => {
  const restore = without(...TASK_CAPABILITIES);
  try {
    const team = new Team([], 99);
    const [, run] = await runTask(leadDatabase(folder()), team);
    assert.deepEqual(team.work.map((work) => work[0]), ["x:api", "x:api", "cli:claude"]);
    assert.equal(run.status, "failed");
    assert.ok(run.error!.includes("tests failed"));
    assert.deepEqual([team.lead.length, team.diagnoses.length], [0, 0]);
  } finally {
    restore();
  }
});

test("without learning a finished task is not looked back on", async () => {
  const restore = without(...TASK_CAPABILITIES);
  try {
    const db = leadDatabase(folder());
    await runTask(db, new Team([], 0));
    assert.equal(db.getRun("r")!.status, "succeeded");
    assert.equal(db.retrospective("r"), null);
  } finally {
    restore();
  }
});

test("without an engineer what cannot be done here waits for the user, saying why", async () => {
  const restore = without(...TASK_CAPABILITIES);
  try {
    const db = leadDatabase(folder());
    class Offline extends Team {
      override async complete(modelId: string, prompt: string, options: CompleteOptions = {}): Promise<ProviderResult> {
        this.work.push([modelId, prompt]);
        return new ProviderResult("脚本写好了。\nUNABLE: 沙箱不能联网，没有实际部署。", 0, 0, modelId);
      }
    }
    const team = new Offline([]);
    await new Executor(db, team, MODELS).execute("r");
    const run = db.getRun("r")!;
    assert.equal(run.status, "paused");
    assert.ok(run.error!.includes("沙箱不能联网"));
    assert.equal(team.work.length, 1);
  } finally {
    restore();
  }
});

test("a lead decides without a platform engineer, and no diagnosis runs when it does not answer", async () => {
  const restore = without("diagnosis", "engineer");
  try {
    const decided = new Team([decision("retry", { instructions: "先看日志" })]);
    const [, first] = await runTask(leadDatabase(folder()), decided);
    assert.equal(first.status, "succeeded");
    assert.ok(decided.lead.length >= 1 && decided.work[1][1].includes("先看日志"));
    const silent = new Team([]);
    const [, second] = await runTask(leadDatabase(folder()), silent);
    assert.equal(second.status, "succeeded");
    assert.deepEqual([silent.diagnoses.length, second.diagnoses.length], [0, 0]);
  } finally {
    restore();
  }
});

test("the user switches the shipped extensions off and on; they cannot be removed or uploaded", async () => {
  const { client } = taskApi(folder());
  // On before anything is installed, and installed on without a sandbox.
  assert.ok(uses.planning() && uses.engineer());
  await bundled.offer();
  const found = (await client.get("/api/capabilities")).json().filter((item: any) => item.kind === "extension");
  assert.deepEqual(found.map((item: any) => [item.id, item.status]).sort(), [["engineer", "active"], ["lead", "active"], ["learning", "active"], ["planning", "active"]]);
  const set = (id: string, enabled: boolean) => client.patch(`/api/capabilities/${id}`, { json: { enabled, confirmed: true }, headers: ORIGIN });
  assert.equal((await set("planning", false)).status_code, 200);
  assert.ok(!uses.planning() && !uses.team() && uses.engineer());
  const provided = (await client.get("/api/capabilities/provided")).json();
  assert.deepEqual([provided.planning, provided.team, provided.lead], [null, null, "lead"]);
  // Starting again leaves it off.
  await bundled.offer();
  assert.ok(!uses.planning());
  assert.equal((await set("engineer", false)).status_code, 200);
  const made = await client.post("/api/tasks", { json: { prompt: "换算 37 摄氏度", budget_usd: 1 }, headers: ORIGIN });
  assert.equal(made.json().plan.nodes.length, 1, made.text);
  const asked = await client.post(`/api/tasks/${made.json().id}/diagnose`, { json: {}, headers: ORIGIN });
  assert.ok(asked.status_code === 409 && asked.text.includes("没有启用平台工程师"), asked.text);
  assert.equal((await set("planning", true)).status_code, 200);
  assert.ok(uses.planning() && !uses.engineer());
  assert.equal((await client.delete("/api/capabilities/engineer", { headers: ORIGIN })).status_code, 409);
  const upload = (manifest: object) => () => packages.read(zipOf([{ name: "capability.json", data: JSON.stringify(manifest) }]));
  assert.throws(upload({ id: "evil", kind: "extension", provides: ["planning"] }), /不能上传/);
  assert.throws(upload({ id: "other", kind: "service", entry: "node s.mjs", provides: ["planning"] }), /不能替换/);
  assert.throws(upload({ id: "lead", kind: "tool" }), /随 FluidForm 提供的扩展/);
});

test("without the review capability a step's own check is the acceptance: it runs, and failing it fails the step", async () => {
  const restore = without(...TASK_CAPABILITIES);
  const before = agent.Workspace.prototype.run;
  const ran: string[] = [];
  agent.Workspace.prototype.run = async function (_name: string, args: any) {
    ran.push(args.command);
    return ["1 failing", false];
  } as typeof before;
  try {
    const db = leadDatabase(folder());
    const current = db.getRun("r")!;
    current.plan.nodes[0].check = "npm test";
    db.saveRun(current);
    const [, run] = await runTask(db, new Team([], 0));
    assert.equal(run.status, "failed");
    assert.deepEqual(ran, ["npm test", "npm test", "npm test"]);
    assert.ok(run.error!.includes("声明的验收命令失败"));
  } finally {
    agent.Workspace.prototype.run = before;
    restore();
  }
});
