// Capabilities kept from tasks, quick tasks, the API's guard and startup, and the platform engineer
// through the API (test_capabilities.py, test_quick.py, test_safety.py, test_engineer.py: the tests
// of those that need the API).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as agent from "../src/agent.js";
import { QUICK_SCOPE, SOLO_SCOPE } from "../src/api.js";
import * as capabilities from "../src/capabilities.js";
import { settings } from "../src/config.js";
import { EngineerJobSchema, type ExecutionRun, ExecutionRunSchema, folderId, TaskPlanSchema } from "../src/models.js";
import { ProviderResult } from "../src/providers.js";
import * as quality from "../src/quality.js";
import { type Api, chatting } from "./helpers/chatting.js";
import { conftest } from "./helpers/conftest.js";
import { taskApi } from "./helpers/task-api.js";

const { folder } = conftest();
const ORIGIN = { origin: "http://localhost:5173" };
const noSandbox = { skip: !agent.sandboxAvailable() && "bubblewrap is not installed" };

// ---- test_capabilities.py ----

const CARD = { name: "飞书发消息", kind: "tool", summary: "向飞书群发一条消息。", usage: "python send.py --chat <id> --text <内容>",
  guide: "- 群 ID 在飞书群设置里\n- 一条消息最多 4000 字", files: ["feishu"], check: "python3 feishu/send.py --help",
  secrets: ["FEISHU_APP_ID", "FEISHU_APP_SECRET"], domains: ["open.feishu.cn"] };

function finished(api: Api, check = "python3 feishu/send.py --help"): ExecutionRun {
  const run = ExecutionRunSchema.parse({ id: "built", prompt: "接飞书", status: "succeeded", budget_usd: 1,
    plan: { summary: "接飞书", nodes: [{ id: "a", title: "a", instructions: "i", capability: "coding" }] }, capability_proposals: [{ ...CARD, check }] });
  const where = join(settings.workspace_root, folderId(run), "feishu");
  mkdirSync(where, { recursive: true });
  writeFileSync(join(where, "send.py"), "import sys\nprint('usage: send.py --chat ID --text TEXT')\n");
  writeFileSync(join(settings.workspace_root, folderId(run), "secret.txt"), "not part of it");
  api.db.saveRun(run);
  return run;
}

test("a proposal solidified is copied, checked, listed and told to later steps", noSandbox, async () => {
  const { api, client } = taskApi(folder());
  finished(api);
  const response = await client.post("/api/tasks/built/capabilities/0/solidify", { headers: ORIGIN });
  assert.equal(response.status_code, 200, response.text);
  const proposal = api.db.getRun("built")!.capability_proposals[0];
  assert.ok(proposal.status === "solidified" && proposal.capability_id);
  const [capability] = (await client.get("/api/capabilities")).json();
  assert.deepEqual([capability.name, capability.status, capability.check_ok, capability.source_run_id], ["飞书发消息", "active", true, "built"]);
  assert.ok(capability.check_output.includes("usage: send.py"));
  const where = join(capabilities.root(), capability.id);
  assert.ok(statSync(join(where, "feishu", "send.py")).isFile() && !existsSync(join(where, "secret.txt")));
  // A capability is its code and its manual, in the skills' format, side by side.
  const manual = readFileSync(join(where, "SKILL.md"), "utf8");
  assert.ok(manual.startsWith("---\nname: ") && manual.includes("python send.py --chat") && manual.includes("群 ID 在飞书群设置里"));
  assert.ok(manual.includes("`feishu`") && manual.includes("FEISHU_APP_ID") && manual.includes("open.feishu.cn"));
  // Later steps are told it, with where it is and what it needs.
  const later = ExecutionRunSchema.parse({ id: "later", prompt: "p", status: "running", budget_usd: 1,
    plan: { summary: "s", nodes: [{ id: "n", title: "通知", instructions: "发通知", capability: "coding" }] } });
  const [prompt] = quality.nodePrompt(later.plan.nodes[0], later, 4000);
  assert.ok(prompt.includes("飞书发消息") && prompt.includes(where) && prompt.includes("FEISHU_APP_SECRET") && prompt.includes("SKILL.md"));
  // Switched off, later work is no longer told; removed, it is gone.
  assert.equal((await client.patch(`/api/capabilities/${capability.id}`, { json: { enabled: false }, headers: ORIGIN })).json().status, "disabled");
  assert.ok(!quality.nodePrompt(later.plan.nodes[0], later, 4000)[0].includes("飞书发消息"));
  assert.equal((await client.delete(`/api/capabilities/${capability.id}`, { headers: ORIGIN })).status_code, 204);
  assert.deepEqual((await client.get("/api/capabilities")).json(), []);
  assert.ok(!existsSync(where));
  // A proposal is handled once.
  assert.equal((await client.post("/api/tasks/built/capabilities/0/solidify", { headers: ORIGIN })).status_code, 409);
});

test("a capability whose check fails is kept failed and cannot be enabled", noSandbox, async () => {
  const { api, client } = taskApi(folder());
  finished(api, "python3 feishu/send.py && exit 3");
  await client.post("/api/tasks/built/capabilities/0/solidify", { headers: ORIGIN });
  const [capability] = (await client.get("/api/capabilities")).json();
  assert.ok(capability.status === "failed" && capability.check_ok === false && capability.check_output.includes("Exit code 3"));
  assert.equal((await client.patch(`/api/capabilities/${capability.id}`, { json: { enabled: true }, headers: ORIGIN })).status_code, 409);
  assert.ok(!capabilities.section().includes("飞书发消息"));
});

test("only files inside the task's folder are kept, and a proposal can be dismissed", async () => {
  const { api, client } = taskApi(folder());
  const run = finished(api);
  run.capability_proposals = [{ ...run.capability_proposals[0], files: ["../../outside"] }, { ...run.capability_proposals[0] }];
  api.db.saveRun(run);
  const response = await client.post("/api/tasks/built/capabilities/0/solidify", { headers: ORIGIN });
  assert.ok(response.status_code === 422 && response.text.includes("不在任务目录里"));
  assert.deepEqual(capabilities.library(), []);
  const dismissed = await client.post("/api/tasks/built/capabilities/1/dismiss", { headers: ORIGIN });
  assert.equal(dismissed.json().capability_proposals[1].status, "dismissed");
});

test("the platform page lists what the steps know how to use, with each skill's line", async () => {
  const { client } = taskApi(folder());
  const listed = (await client.get("/api/skills")).json();
  assert.ok(listed.some((item: any) => item.name === "synopsys-vcs" && item.tools.includes("vcs") && item.machine === false));
  const vcs = listed.find((item: any) => item.name === "synopsys-vcs");
  assert.ok("summary" in vcs && vcs.summary.startsWith("用 Synopsys VCS"));
});

// ---- test_quick.py ----

const QUICK = '{"quick": true, "title": "海边女孩头像", "capability": "tool_use", "needs_images": true, "acceptance": "一张方形的海边女孩头像图片"}';
const SOLO = '{"shape": "solo", "title": "修登录报错", "capability": "coding", "needs_images": false, "acceptance": "登录不再报错，测试通过"}';

/** The cheap model's answer to whether a task is quick, and a planner that records being asked. */
function judging(api: Api, answer: string): [string[], string[]] {
  chatting(api);
  const asked: string[] = [];
  const planned: string[] = [];
  api.providers.complete = async (_modelId: string, prompt: string) => {
    asked.push(prompt);
    return new ProviderResult(answer, 100, 10);
  };
  api.deps.autonomousPlan = async (prompt: string) => {
    planned.push(prompt);
    return TaskPlanSchema.parse({ summary: "排好的计划", nodes: [{ id: "a", title: "做", instructions: "i", capability: "coding" }] });
  };
  return [asked, planned];
}

test("a quick task gets one easy step, without the lead's planning", async () => {
  const { api, client } = taskApi(folder());
  settings.quick_tasks = true;
  const [asked, planned] = judging(api, QUICK);
  const created = await client.post("/api/tasks", { json: { prompt: "画一张海边女孩的头像" }, headers: ORIGIN });
  assert.equal(created.status_code, 201, created.text);
  const plan = created.json().plan;
  assert.ok(planned.length === 0 && asked.length === 1 && asked[0].startsWith("Is this request work that one capable model"));
  assert.ok(asked[0].includes("a small game"));
  const [node] = plan.nodes;
  assert.deepEqual([node.title, node.difficulty, node.needs_images, node.capability], ["海边女孩头像", "easy", true, "tool_use"]);
  assert.ok(node.instructions.includes("画一张海边女孩的头像") && plan.planning_note.startsWith("一步就能做完"));
  assert.equal(created.json().status, "awaiting_confirmation");
});

test("a task that must make pictures is allowed the internet when an MCP server makes them", async () => {
  // The image server reaches its service from the step's sandbox.
  const { api, client } = taskApi(folder());
  settings.quick_tasks = true;
  judging(api, QUICK);
  let created = (await client.post("/api/tasks", { json: { prompt: "画一张海边女孩的头像" }, headers: ORIGIN })).json();
  assert.equal(created.allow_network, false); // no image server: nothing changes
  settings.mcp_servers = { minimax: { command: ["minimax-mcp"], makes_images: true } };
  created = (await client.post("/api/tasks", { json: { prompt: "画一张海边女孩的头像" }, headers: ORIGIN })).json();
  assert.equal(created.allow_network, true);
  assert.equal(api.db.events(created.id)[0].data.allow_network, true);
});

for (const answer of ['{"quick": false}', "不确定", '{"quick": "yes"}']) {
  test(`anything else is planned as before: ${answer}`, async () => {
    const { api, client } = taskApi(folder());
    settings.quick_tasks = true;
    const [, planned] = judging(api, answer);
    const created = await client.post("/api/tasks", { json: { prompt: "做一个记账网站" }, headers: ORIGIN });
    assert.ok(created.status_code === 201 && planned.length === 1);
  });
}

test("without the setting, or for a project, every task is planned", async () => {
  const { api, client } = taskApi(folder());
  const [asked, planned] = judging(api, QUICK);
  await client.post("/api/tasks", { json: { prompt: "画一张头像" }, headers: ORIGIN });
  assert.ok(planned.length === 1 && asked.length === 0);
  settings.quick_tasks = true;
  const project = join(folder(), "proj");
  mkdirSync(project);
  settings.project_roots = [folder()];
  await client.post("/api/tasks", { json: { prompt: "画一张头像", project_dir: project }, headers: ORIGIN });
  assert.ok(planned.length === 2 && !asked.some((prompt) => prompt.startsWith("Is this request")));
});

test("work one model carries through alone gets one hard step, in a project too", async () => {
  const { api, client } = taskApi(folder());
  settings.solo_tasks = true;
  const [asked, planned] = judging(api, SOLO);
  const project = join(folder(), "proj");
  mkdirSync(project);
  settings.project_roots = [folder()];
  const created = await client.post("/api/tasks", { json: { prompt: "修一下登录报错", project_dir: project }, headers: ORIGIN });
  assert.equal(created.status_code, 201, created.text);
  const plan = created.json().plan;
  const [node] = plan.nodes;
  assert.ok(planned.length === 0 && asked[0].startsWith("How should this request be done?") && asked[0].includes("project folder"));
  assert.deepEqual([node.difficulty, node.needs_workspace, plan.in_project], ["hard", true, true]);
  assert.ok(plan.planning_note.startsWith("一个模型连续做完"));
});

test("a small program is quick, and the step does only what was asked", async () => {
  // Regression: "写一个贪吃蛇的游戏" was judged one model's long work (hard), and the step wrote two
  // test suites, a headless demo and a README: six minutes instead of one or two.
  const { api, client } = taskApi(folder());
  Object.assign(settings, { quick_tasks: true, solo_tasks: true });
  const [asked] = judging(api, '{"shape": "quick", "title": "贪吃蛇", "capability": "coding", "acceptance": "能玩"}');
  let created = await client.post("/api/tasks", { json: { prompt: "写一个贪吃蛇的游戏" }, headers: ORIGIN });
  assert.ok(asked[0].split("- solo:")[0].includes("a small game such as snake"));
  const [node] = created.json().plan.nodes;
  assert.ok(node.difficulty === "easy" && node.instructions.endsWith(QUICK_SCOPE));
  assert.ok(node.instructions.includes("没要求的测试套件、演示脚本、说明文档都不用写"));
  // Work one model carries through is held to what was asked too.
  judging(api, SOLO);
  created = await client.post("/api/tasks", { json: { prompt: "修一下登录报错" }, headers: ORIGIN });
  assert.ok(created.json().plan.nodes[0].instructions.endsWith(SOLO_SCOPE));
});

// ---- test_safety.py ----

for (const host of ["evil.example", "evil.example:8000", "192.168.1.5:8000"]) {
  test(`a rebinding host is refused: ${host}`, async () => {
    const { client } = taskApi(folder());
    assert.equal((await client.get("/api/tasks", { headers: { host } })).status_code, 403);
  });
}

for (const host of ["127.0.0.1:8000", "localhost", "LOCALHOST:8000", "[::1]:8000"]) {
  test(`a local host is served: ${host}`, async () => {
    const { client } = taskApi(folder());
    assert.equal((await client.get("/api/tasks", { headers: { host } })).status_code, 200);
  });
}

test("cross-site writes are refused, but the console's and the CLI's pass", async () => {
  const { client } = taskApi(folder());
  const url = "/api/tasks/missing/cancel";
  assert.equal((await client.post(url, { headers: { origin: "https://evil.example" } })).status_code, 403);
  assert.equal((await client.post(url, { headers: { origin: "null" } })).status_code, 403);
  assert.equal((await client.post(url, { headers: ORIGIN })).status_code, 404);
  assert.equal((await client.post(url)).status_code, 404);
});

test("startup pauses interrupted runs instead of resuming them", async () => {
  const { api } = taskApi(folder());
  api.catalogSync.start = () => {};
  for (const [runId, status] of [["running", "running"], ["queued", "queued"]]) {
    api.db.saveRun(ExecutionRunSchema.parse({ id: runId, prompt: "demo", status, budget_usd: 1, plan: { summary: "demo", nodes: [] } }));
  }
  api.start();
  try {
    for (const runId of ["running", "queued"]) {
      assert.equal(api.db.getRun(runId)!.status, "paused");
      assert.ok(!api.executor.tasks.has(runId));
      assert.deepEqual(api.db.events(runId).map((event) => [event.kind, event.data]), [["approval.required", { reason: "interrupted" }]]);
    }
  } finally {
    await api.close();
  }
});

// ---- test_engineer.py ----

test("the API lists jobs and refuses what the engineer cannot take", async () => {
  const { client } = taskApi(folder());
  const overview = (await client.get("/api/engineer")).json();
  assert.ok(overview.available === false && overview.jobs.length === 0);
  const refused = await client.post("/api/engineer/jobs", { json: { request: "加一个按钮" } });
  assert.ok(refused.status_code === 409 && refused.json().detail.includes("不可用"));
  assert.equal((await client.post("/api/engineer/jobs/nope/approve")).status_code, 409);
  assert.equal((await client.get("/api/engineer/jobs/nope/activity")).status_code, 404);
});

test("the API shows a working job's activity, and nothing once it stops", async () => {
  const { api, client } = taskApi(folder());
  const job = EngineerJobSchema.parse({ request: "加一个按钮", status: "editing" });
  api.db.saveEngineerJob(job);
  api.executor.engineerLogs.set(job.id, Array.from({ length: 5 }, (_, n) => ({ turn: 0, tool: "command", detail: `echo ${n}`, ok: true })));
  const shown = (await client.get(`/api/engineer/jobs/${job.id}/activity`, { params: { limit: 2 } })).json();
  assert.ok(shown.running && shown.total === 5);
  assert.deepEqual(shown.calls.map((call: any) => call.detail), ["echo 3", "echo 4"]);
  api.executor.engineerLogs.delete(job.id);
  assert.deepEqual((await client.get(`/api/engineer/jobs/${job.id}/activity`)).json(), { running: false, total: 0, calls: [] });
});

test("the user brings the engineer into a task", async () => {
  const { api, client } = taskApi(folder());
  assert.equal((await client.post("/api/tasks/nope/engineer", { json: { request: "修沙箱" } })).status_code, 404);
  api.db.saveRun(ExecutionRunSchema.parse({ id: "t", prompt: "p", status: "paused", budget_usd: 1, plan: { summary: "s", nodes: [] } }));
  const refused = await client.post("/api/tasks/t/engineer", { json: { request: "修沙箱", kind: "repair" } });
  assert.ok(refused.status_code === 409 && refused.json().detail.includes("不可用"));
  api.executor.engineerAvailable = () => true;
  api.executor.engineerKick = () => {};
  const joined = await client.post("/api/tasks/t/engineer", { json: { request: "让步骤沙箱能连许可证端口", kind: "repair" } });
  assert.ok(joined.status_code === 201 && joined.json().run_id === "t" && joined.json().origin === "user");
  const listed = (await client.get("/api/engineer", { params: { run_id: "t" } })).json().jobs;
  assert.deepEqual(listed.map((job: any) => job.id), [joined.json().id]);
  assert.deepEqual((await client.get("/api/engineer", { params: { run_id: "other" } })).json().jobs, []);
});
