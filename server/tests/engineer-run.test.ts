// The platform engineer at work: the tests of tests/test_engineer.py that use platform repairs, ported.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import * as activity from "../src/activity.js";
import * as files from "../src/attachments.js";
import { settings } from "../src/config.js";
import { Database } from "../src/db.js";
import * as engineer from "../src/engineer.js";
import { Executor } from "../src/executor.js";
import { DiagnosisSchema, ExecutionRunSchema, type SupervisorSession, TaskNodeSchema } from "../src/models.js";
import * as platform from "../src/platform-repair.js";
import { type CompleteOptions, ProviderResult } from "../src/providers.js";
import * as worker from "../src/repair-worker.js";
import { conftest } from "./helpers/conftest.js";
import { decision, leadDatabase, MODELS, Team } from "./helpers/lead-run.js";
import { API, editCandidate, passingCheck, sourceCheckout } from "./helpers/source-checkout.js";

const { folder } = conftest();
const PLAN = "- 目标: 加一个导出按钮\n- 改动: frontend/x.tsx\n- 测试: 导出测试\n- 风险: 无\nSTATUS: PLAN";
const savedCheck = platform.SourceRepairs.prototype.checkCommand;
const savedWorker = { ...worker.deps };
const savedCommit = engineer.deps.commit;
afterEach(() => {
  platform.SourceRepairs.prototype.checkCommand = savedCheck;
  Object.assign(worker.deps, savedWorker);
  engineer.deps.commit = savedCommit;
});

/** Plans with PLAN; builds by editing the copy (editCandidate). */
class Engineer {
  prompts: [string, string][] = [];
  options: CompleteOptions[] = [];
  constructor(readonly plan = PLAN) {}

  configuredModels(ids: Iterable<string>) {
    return new Set(ids);
  }

  async complete(modelId: string, prompt: string, options: CompleteOptions = {}): Promise<ProviderResult> {
    this.prompts.push([prompt, options.workspace!]);
    this.options.push(options);
    assert.equal(options.repair, false);
    if (prompt.startsWith("[[fluidform:platform-engineer:plan]]")) return new ProviderResult(this.plan, 0, 0, modelId);
    editCandidate({ folder: join(options.workspace!, "..") });
    return new ProviderResult("改了 api.py，加了回归测试。\nSTATUS: FIXED", 0, 0, modelId);
  }
}

/** Says what it does in plain words first, as it is asked to. */
class PlainEngineer extends Engineer {
  override async complete(modelId: string, prompt: string, options: CompleteOptions = {}): Promise<ProviderResult> {
    const result = await super.complete(modelId, prompt, options);
    const plain = prompt.includes("plan]]") ? "HEADLINE: 导出按钮\nPLAIN: 在结果页加一个导出按钮，点一下下载 CSV。\n" : "HEADLINE：结果导出\nPLAIN：结果页现在可以导出 CSV 了。\n";
    return new ProviderResult(plain + result.text, 0, 0, modelId);
  }
}

let root: string;
let activated: Record<string, any>[];
beforeEach(() => {
  root = sourceCheckout(folder());
  Object.assign(settings, { platform_root: root, platform_self_repair: true });
  platform.SourceRepairs.prototype.checkCommand = passingCheck;
  const guide = join(root, "skills/platform-engineer/SKILL.md");
  mkdirSync(join(root, "skills/platform-engineer"), { recursive: true });
  writeFileSync(guide, "---\nname: platform-engineer\n---\n# Adding a component to FluidForm\n");
  activated = [];
});

function build(providers: unknown = new Engineer(), db: Database | null = null): Executor {
  const executor = new Executor(db ?? new Database(join(folder(), "test.db")), providers as never, MODELS);
  executor.activatePlatform = async (job) => {
    activated.push(job);
  };
  return executor;
}

async function idle(executor: Executor): Promise<void> {
  while (executor.engineerTask && !executor.engineerTask.done) await new Promise((done) => setTimeout(done, 10));
  await new Promise((done) => setImmediate(done));
}

test("a component is planned, approved, built, checked, and applied only when approved", async () => {
  const providers = new Engineer();
  const executor = build(providers);
  let job = executor.engineerRequest("给结果页加一个导出按钮");
  await idle(executor);
  job = executor.db.getEngineerJob(job.id)!;
  assert.ok(job.status === "plan_ready" && job.plan!.includes("导出按钮") && !job.plan!.includes("STATUS"));
  // Planning read a copy, which is gone, and edited nothing.
  const plannedIn = providers.prompts[0][1];
  assert.ok(plannedIn !== root && !existsSync(plannedIn));
  assert.ok(providers.prompts[0][0].includes("# Adding a component to FluidForm"));
  assert.ok(readFileSync(join(root, API), "utf8").includes("broken"));
  executor.engineerApprove(job.id);
  await idle(executor);
  job = executor.db.getEngineerJob(job.id)!;
  assert.ok(job.status === "ready" && job.diff!.includes("+export const VALUE = 'fixed'"), job.diff ?? "");
  assert.ok(job.files.includes("server/tests/new-regression.test.ts") && job.checks.length);
  assert.ok(providers.prompts.at(-1)![0].includes("Approved plan:") && providers.prompts.at(-1)![0].includes("导出按钮"));
  assert.ok(!activated.length && readFileSync(join(root, API), "utf8").includes("broken"));
  executor.engineerApprove(job.id);
  job = executor.db.getEngineerJob(job.id)!;
  await new Promise((done) => setImmediate(done));
  assert.ok(job.status === "applying" && executor.platformPending!.engineer_job_id === job.id);
  assert.deepEqual(activated.map((item) => item.id), [job.repair_id]);
});

test("an applied change is committed, and the job ends", async () => {
  const executor = build();
  let job = executor.engineerRequest("修复：状态显示错误", "repair");
  await idle(executor);
  job = executor.db.getEngineerJob(job.id)!;
  // A repair needs no approval: once checked it is applied.
  assert.ok(job.status === "applying" && executor.platformPending);
  const commits: [string[], string][] = [];
  engineer.deps.commit = (_root, changed, message) => {
    commits.push([changed, message]);
    return "abc12345ff";
  };
  executor.finishPlatform({ ...executor.platformPending!, status: "activated" });
  job = executor.db.getEngineerJob(job.id)!;
  assert.ok(job.status === "applied" && job.commit === "abc12345ff" && job.finished_at);
  assert.deepEqual(commits[0][0], job.files);
  assert.ok(commits[0][1].includes("platform engineer"));
  assert.equal(executor.platformPending, null);
});

test("an engineer's call gets the long regression budget", async () => {
  const providers = new Engineer();
  const executor = build(providers);
  executor.engineerRequest("修复：状态显示错误", "repair");
  await idle(executor);
  assert.ok(providers.options.length && providers.options.every((item) => item.cli_timeout === settings.repair_call_minutes * 60));
  assert.ok(settings.repair_call_minutes * 60 > 2143.923);
});

test("the user can send a plan back, and give a job up", async () => {
  const providers = new Engineer();
  const executor = build(providers);
  let job = executor.engineerRequest("加一个导出按钮");
  await idle(executor);
  executor.engineerReply(job.id, "导出成 CSV，不要 Excel");
  await idle(executor);
  const prompt = providers.prompts.at(-1)![0];
  assert.ok(prompt.includes("导出成 CSV") && prompt.includes("Your previous plan"));
  assert.equal(executor.db.getEngineerJob(job.id)!.status, "plan_ready");
  job = await executor.engineerReject(job.id);
  assert.equal(job.status, "rejected");
  assert.throws(() => executor.engineerApprove(job.id), engineer.EngineerError);
});

test("a change made against older source is redone instead of overwriting", async () => {
  const executor = build();
  let job = executor.engineerRequest("加一个导出按钮");
  await idle(executor);
  executor.engineerApprove(job.id);
  await idle(executor);
  const first = executor.db.getEngineerJob(job.id)!.repair_id;
  writeFileSync(join(root, API), "export const VALUE = 'broken';\n// someone else's edit\n");
  executor.engineerApprove(job.id);
  await idle(executor);
  job = executor.db.getEngineerJob(job.id)!;
  assert.ok(!activated.length && job.status === "ready" && job.repair_id !== first);
  assert.ok(job.messages.some((item) => item.text.includes("源码在这期间有了更新")));
});

test("the engineer asks when a choice is the user's", async () => {
  const executor = build(new Engineer('要接哪家？\nQUESTION: 接入哪个厂商？\nOPTIONS: ["DeepSeek", "Kimi"]\nSTATUS: NEEDS_INPUT'));
  let job = executor.engineerRequest("接入一个新的 API 厂商");
  await idle(executor);
  job = executor.db.getEngineerJob(job.id)!;
  assert.deepEqual([job.status, job.question, job.choices], ["needs_input", "接入哪个厂商？", ["DeepSeek", "Kimi"]]);
});

test("a retrospective's change waits for approval of its plan and of its result", async () => {
  const executor = build();
  const job = executor.engineerRequest("改进拆分规则并增加验证", "component", "retrospective", { improvementId: "lesson" });
  await idle(executor);
  assert.ok(executor.db.getEngineerJob(job.id)!.status === "plan_ready" && !activated.length);
  executor.engineerApprove(job.id);
  await idle(executor);
  assert.ok(executor.db.getEngineerJob(job.id)!.status === "ready" && !activated.length);
});

test("the lead asks for a component, and decides again when it is done", async () => {
  const db = leadDatabase(folder());
  Object.assign(settings, { platform_root: root, platform_self_repair: true });
  const builder = new Engineer();
  class LeadAndEngineer extends Team {
    override async complete(modelId: string, prompt: string, options: CompleteOptions = {}): Promise<ProviderResult> {
      if (prompt.startsWith("[[fluidform:platform-engineer:")) return builder.complete(modelId, prompt, options);
      return super.complete(modelId, prompt, options);
    }
  }
  const team = new LeadAndEngineer([decision("request_component", { instructions: "给执行模型加一个读 PDF 的工具" }), decision("unable", { user_action: "换成文本格式的资料" })], 10);
  const executor = build(team, db);
  await executor.execute("r");
  let run = db.getRun("r")!;
  assert.ok(run.status === "paused" && run.engineer_job_id);
  assert.equal(run.decisions[0].engineer_job_id, run.engineer_job_id);
  await idle(executor);
  const job = db.getEngineerJob(run.engineer_job_id!)!;
  assert.deepEqual([job.origin, job.status, job.run_id], ["lead", "plan_ready", "r"]);
  assert.ok(builder.prompts[0][0].includes("The lead of a running task asks for it") && builder.prompts[0][0].includes("读 PDF 的工具"));
  await executor.engineerReject(job.id);
  for (let i = 0; i < 100 && db.getRun("r")!.plan.nodes[0].status !== "unable"; i += 1) await new Promise((done) => setTimeout(done, 10));
  run = db.getRun("r")!;
  assert.ok(team.lead.at(-1)!.includes("EVENT: the component you asked for") && team.lead.at(-1)!.includes("gave it up"));
  assert.ok(run.engineer_job_id === null && run.plan.nodes[0].status === "unable");
  assert.deepEqual(run.decisions.map((item) => item.event), ["attempt_failed", "engineer_done"]);
});

test("a platform repair the lead asked for goes back to it once applied", async () => {
  const db = leadDatabase(folder());
  const executor = build(new Team([]), db);
  const run = db.getRun("r")!;
  run.status = "paused";
  run.maintenance_id = "repair1";
  run.plan.nodes[0].status = "pending";
  run.diagnoses = [DiagnosisSchema.parse({ id: "d", trigger: "lead_repair", node_id: "a", decision_id: "x", status: "done", repair_id: "repair1" })];
  db.saveRun(run);
  const asked: unknown[] = [];
  executor.afterRepair = async (runId, nodeId, diagnosisId) => {
    asked.push([runId, nodeId, diagnosisId, db.getRun(runId)!.diagnoses[0].verdict]);
    return true;
  };
  executor.start = (runId: string) => {
    asked.push(["started", runId]);
  };
  executor.finishPlatform({ id: "repair1", status: "activated", run_id: "r", files: ["server/src/x.ts"], folder: "" });
  await new Promise((done) => setTimeout(done, 50));
  // The lead heard first; only after its decision does the task go on.
  assert.deepEqual(asked, [["r", "a", "d", "platform_fixed"], ["started", "r"]]);
});

test("the lead brings the engineer into the chat, and hears how it goes", async () => {
  const db = leadDatabase(folder());
  class Lead extends Team {
    override async converse(session: SupervisorSession, prompt: string): Promise<ProviderResult> {
      this.lead.push(prompt);
      return new ProviderResult('是沙箱的问题。\nENGINEER: {"kind": "repair", "request": "让步骤沙箱能连宿主机许可证端口"}', 0, 0, session.model_id);
    }
  }
  const team = new Lead([]);
  const executor = build(team, db);
  const kick = executor.engineerKick;
  executor.engineerKick = () => undefined; // keep the job queued for the test
  assert.ok(executor.startLeadChat("r", "应该是你沙箱的问题，请平台工程师修"));
  await executor.leadTasks.get("r")!.promise;
  const reply = db.getRun("r")!.lead_messages.at(-1)!;
  assert.ok(reply.text.startsWith("是沙箱的问题。") && !reply.text.includes("ENGINEER:") && reply.text.includes("已请平台工程师加入"));
  const job = db.getEngineerJob(reply.engineer_job_id!)!;
  assert.deepEqual([job.origin, job.kind, job.run_id, job.status], ["lead", "repair", "r", "queued"]);
  assert.ok(team.lead[0].includes("ENGINEER: {")); // it was told how to bring the engineer in
  // Its next message to the lead starts with what the engineer did, once.
  job.status = "applied";
  db.saveEngineerJob(job);
  await executor.askLead("r", "还好吗");
  await executor.askLead("r", "现在呢");
  assert.ok(team.lead[1].startsWith("UPDATE from the platform engineer") && team.lead[1].includes('"让步骤沙箱能连宿主机许可证端口": applied'));
  assert.ok(!team.lead[2].startsWith("UPDATE"));
  executor.engineerKick = kick;
});

test("a decision can bring the engineer in without holding the step", async () => {
  const db = leadDatabase(folder());
  const team = new Team([decision("accept", { engineer: { kind: "repair", request: "步骤沙箱连不到许可证服务" } })]);
  const executor = build(team, db);
  executor.engineerKick = () => undefined;
  await executor.execute("r");
  const run = db.getRun("r")!;
  assert.ok(run.status === "succeeded" && run.engineer_job_id === null);
  const job = db.getEngineerJob(run.decisions[0].engineer_job_id!)!;
  assert.deepEqual([job.origin, job.node_id, job.request], ["lead", "a", "步骤沙箱连不到许可证服务"]);
});

test("the engineer says what it does in plain words for the user", async () => {
  const providers = new PlainEngineer();
  const executor = build(providers);
  let job = executor.engineerRequest("给结果页加一个导出按钮，用 papaparse 生成 CSV");
  await idle(executor);
  job = executor.db.getEngineerJob(job.id)!;
  // It is asked for them, and they are kept apart from the plan.
  assert.ok(providers.prompts[0][0].includes("HEADLINE:") && providers.prompts[0][0].includes("PLAIN:"));
  assert.deepEqual([job.headline, job.plan_plain], ["导出按钮", "在结果页加一个导出按钮，点一下下载 CSV。"]);
  assert.ok(!job.plan!.includes("HEADLINE") && !job.plan!.includes("PLAIN") && job.plan!.includes("导出按钮"));
  executor.engineerApprove(job.id);
  await idle(executor);
  job = executor.db.getEngineerJob(job.id)!;
  assert.deepEqual([job.headline, job.plain], ["结果导出", "结果页现在可以导出 CSV 了。"]);
  assert.ok(!job.report!.includes("HEADLINE") && job.messages.at(-1)!.text === "结果页现在可以导出 CSV 了。");
});

test("going on with a conversation tells the engineer what came before", async () => {
  const providers = new PlainEngineer();
  const executor = build(providers);
  let first = executor.engineerRequest("给结果页加一个导出按钮");
  await idle(executor);
  executor.engineerApprove(first.id);
  await idle(executor);
  first = executor.db.getEngineerJob(first.id)!;
  assert.equal(engineer.threadOf(first), first.id);
  // Said on in the same conversation once the first work is done: a new job in it, told what came before.
  const later = executor.engineerRequest("导出的文件名加上日期", "component", "user", { threadId: first.id });
  assert.deepEqual([later.thread_id, engineer.threadOf(later)], [first.id, first.id]);
  assert.ok(later.context.includes("给结果页加一个导出按钮") && later.context.includes("结果页现在可以导出 CSV 了"));
  await idle(executor);
  const prompt = providers.prompts.at(-1)![0];
  assert.ok(prompt.includes("Earlier in this conversation") && prompt.includes("给结果页加一个导出按钮") && prompt.includes("导出的文件名加上日期"));
  // A task's jobs are its conversation; going on in it keeps the job with the task.
  const task = executor.engineerRequest("放行许可证端口", "repair", "user", { threadId: "task:r9" });
  assert.ok(task.run_id === "r9" && engineer.threadOf(task) === "task:r9");
  assert.throws(() => executor.engineerRequest("随便", "repair", "user", { threadId: "nothing-here" }), engineer.EngineerError);
});

test("files sent to the engineer are given to its model", async () => {
  settings.data_dir = join(folder(), "data");
  const providers = new Engineer();
  const executor = build(providers);
  const shot = files.save("bug.png", Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(32)]));
  const log = files.save("trace.log", Buffer.from("boom\n"));
  const job = executor.engineerRequest("加一个导出按钮，像截图这样", "component", "user", { attachments: [shot] });
  await idle(executor);
  executor.engineerReply(job.id, "", null, [log]);
  await idle(executor);
  assert.deepEqual((providers.options[0].attachments ?? []).map((item) => item.name), ["bug.png"]);
  assert.deepEqual((providers.options.at(-1)!.attachments ?? []).map((item) => item.name), ["bug.png", "trace.log"]);
  const saved = executor.db.getEngineerJob(job.id)!;
  assert.deepEqual(saved.messages.filter((m) => m.role === "user").map((m) => [m.text, m.attachments.map((a) => a.name)]),
    [["加一个导出按钮，像截图这样", ["bug.png"]], ["（见附件）", ["trace.log"]]]);
});

test("while it works its page shows what it is doing", async () => {
  let working!: () => void;
  const started = new Promise<void>((done) => (working = done));
  let goOn!: () => void;
  const going = new Promise<void>((done) => (goOn = done));
  class Showing extends Engineer {
    override async complete(modelId: string, prompt: string, options: CompleteOptions = {}): Promise<ProviderResult> {
      if (!prompt.startsWith("[[fluidform:platform-engineer:plan]]")) {
        for (const event of [{ type: "item.started", item: { id: "c1", type: "command_execution", command: "npm test -- tests/x.test.ts" } },
          { type: "item.completed", item: { id: "c1", type: "command_execution", command: "npm test -- tests/x.test.ts", exit_code: 0, aggregated_output: "1 passed" } },
          { type: "item.completed", item: { id: "f1", type: "file_change", status: "completed", changes: [{ kind: "update", path: API }] } }]) {
          activity.noteLine(JSON.stringify(event));
        }
        working();
        await going;
      }
      return super.complete(modelId, prompt, options);
    }
  }
  const executor = build(new Showing());
  const seen: Record<string, any>[][] = [];
  let jobId = "";
  platform.SourceRepairs.prototype.checkCommand = async () => {
    seen.push((executor.engineerLogs.get(jobId) ?? []).filter((entry) => entry.tool === "check").map((entry) => ({ ...entry })));
    return passingCheck();
  };
  const job = executor.engineerRequest("修复：状态显示错误", "repair");
  jobId = job.id;
  await Promise.race([started, new Promise((_, fail) => setTimeout(() => fail(new Error("never worked")), 5000).unref())]);
  // The model's commands and file changes, as Codex prints them.
  assert.deepEqual(executor.engineerLogs.get(job.id)!.map((entry) => [entry.tool, entry.detail, entry.ok]),
    [["command", "npm test -- tests/x.test.ts", true], ["file_change", `update ${API}`, true]]);
  goOn();
  await idle(executor);
  // Each of the platform's checks was shown running, then passed.
  assert.ok(seen[0].at(-1)!.running && seen[1][0].ok === true);
  const names = new Set(seen.at(-1)!.map((entry) => entry.detail));
  assert.ok(names.has("TypeScript check") && names.has("Server tests"));
  // Kept only while it works.
  assert.ok(!executor.engineerLogs.has(job.id));
});

test("a job that spent its budget asks before going on", async () => {
  // Regression: a job with a $2 budget ended at $12.81: a membership CLI is charged only when its call
  // ends, and nothing checked the budget before the next piece of work.
  const providers = new Engineer();
  const executor = build(providers);
  let job = executor.engineerRequest("加一个导出按钮");
  await idle(executor);
  job = executor.db.getEngineerJob(job.id)!;
  job.cost_usd = job.budget_usd; // the plan used it all
  executor.db.saveEngineerJob(job);
  const calls = providers.prompts.length;
  executor.engineerApprove(job.id);
  await idle(executor);
  job = executor.db.getEngineerJob(job.id)!;
  assert.equal(providers.prompts.length, calls); // no call was made past the budget
  assert.ok(job.status === "needs_input");
  assert.deepEqual(job.choices, [engineer.MORE_BUDGET, engineer.STOP]);
  assert.ok(job.question!.includes("用完了"));
  const spent = job.cost_usd;
  executor.engineerReply(job.id, "", engineer.MORE_BUDGET);
  await idle(executor);
  job = executor.db.getEngineerJob(job.id)!;
  assert.ok(Math.abs(job.budget_usd - (spent + settings.engineer_budget_usd)) < 1e-9);
  assert.ok(job.status === "ready" && providers.prompts.length > calls);
});

test("the records list the engineer's repairs of this machine", () => {
  const executor = build();
  executor.db.saveRun(ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "succeeded", budget_usd: 1,
    plan: { summary: "仿真回归", title: "仿真回归", nodes: [TaskNodeSchema.parse({ id: "n", title: "跑 VCS", instructions: "i", capability: "coding" })] }, diagnoses: [
      { id: "d1", trigger: "manual", node_id: "n", status: "done", verdict: "fixed", report: "重启了 lmgrd" },
      { id: "d2", trigger: "lead", node_id: "n", status: "done", question: "要联网吗？" }, // a question, not a look
      { id: "d3", trigger: "auto", node_id: "n", status: "done", scope: "fluidform" }, // a job of its own
      { id: "d4", trigger: "preflight", status: "running" }] }));
  const [item, ...more] = executor.engineerOverview().environment;
  assert.equal(more.length, 0);
  assert.deepEqual([item.id, item.task, item.step, item.trigger, item.verdict], ["d1", "仿真回归", "跑 VCS", "manual", "fixed"]);
  assert.equal(item.summary, "重启了 lmgrd");
  assert.deepEqual(executor.engineerOverview(30, "r").environment, []);
});

test("work a restart cut off goes on from its changes", async () => {
  // Regression: after a restart the engineer did the whole change again from the start.
  const providers = new Engineer();
  const db = new Database(join(folder(), "test.db"));
  const executor = build(providers, db);
  let job = executor.engineerRequest("加一个导出按钮");
  await idle(executor);
  executor.engineerApprove(job.id);
  await idle(executor);
  job = db.getEngineerJob(job.id)!;
  assert.ok(job.status === "ready" && job.files.length);
  job.status = "editing"; // as a restart finds it mid-edit
  db.saveEngineerJob(job);
  const again = build(providers, db);
  again.restoreEngineer();
  await idle(again);
  job = db.getEngineerJob(job.id)!;
  assert.ok(job.messages.some((m) => m.text === "服务重启打断了这项工作；已经改了的保留着，接着做。"));
  assert.ok(providers.prompts.at(-1)![0].includes("The copy already has your earlier changes to:"));
  assert.equal(job.status, "ready");
});

/** Adds a capability package (and its test and doc), touching nothing that runs in FluidForm. */
class PackageEngineer extends Engineer {
  constructor(readonly kind = "automation", readonly also: string | null = null) {
    super();
  }

  override async complete(modelId: string, prompt: string, options: CompleteOptions = {}): Promise<ProviderResult> {
    if (prompt.startsWith("[[fluidform:platform-engineer:plan]]")) return new ProviderResult(PLAN, 0, 0, modelId);
    const source = join(options.workspace!, "..", "source");
    mkdirSync(join(source, "server/packages/demo-bot"), { recursive: true });
    writeFileSync(join(source, "server/packages/demo-bot/capability.json"), JSON.stringify({ id: "demo-bot", kind: this.kind, version: "1.0.0" }));
    writeFileSync(join(source, "server/packages/demo-bot/bot.py"), "print('hi')\n");
    writeFileSync(join(source, "server/tests/demo-bot.test.ts"), "// its test\n");
    writeFileSync(join(source, "docs/ARCHITECTURE.md"), "# FluidForm architecture map\n- demo-bot\n");
    if (this.also) writeFileSync(join(source, this.also), "export {};\n// changed\n");
    return new ProviderResult("加了 demo-bot 能力包。\nSTATUS: FIXED", 0, 0, modelId);
  }
}

async function readyPackage(providers: Engineer, install: (source: string) => Promise<any>) {
  const executor = build(providers);
  const calls: [string, string][] = [];
  executor.packageHooks = {
    install: async (source) => { calls.push(["install", source]); return install(source); },
    remove: async (id) => { calls.push(["remove", id]); },
  };
  engineer.deps.commit = () => "abc1234567";
  let job = executor.engineerRequest("加一个演示机器人");
  await idle(executor);
  executor.engineerApprove(job.id);
  await idle(executor);
  job = executor.db.getEngineerJob(job.id)!;
  assert.equal(job.status, "ready");
  executor.engineerApprove(job.id);
  await executor.maintenanceTask?.settled();
  return { executor, calls, job: executor.db.getEngineerJob(job.id)! };
}

test("adding a capability package installs it, without restarting FluidForm", async () => {
  // Regression: a DingTalk bot (a package, its test, a doc) was applied by a restart that took the
  // service down, then timed out and was rolled back.
  const { executor, calls, job } = await readyPackage(new PackageEngineer(), async () => ({ id: "demo-bot", status: "active" }));
  assert.equal(activated.length, 0);
  assert.deepEqual(calls, [["install", join(root, "server/packages/demo-bot")]]);
  assert.ok(job.status === "applied" && job.messages.some((item) => item.text.includes("服务没有重启")), JSON.stringify(job.messages.at(-1)));
  assert.ok(existsSync(join(root, "server/packages/demo-bot/bot.py")) && readFileSync(join(root, "docs/ARCHITECTURE.md"), "utf8").includes("demo-bot"));
  assert.ok(!executor.packageApplying && !executor.platformPending);
});

test("a package that fails its check is taken out again, and its files put back", async () => {
  const { calls, job } = await readyPackage(new PackageEngineer(), async () => ({ id: "demo-bot", status: "failed", check_output: "ImportError: no module" }));
  assert.deepEqual(calls.map(([what]) => what), ["install", "remove"]);
  assert.ok(job.status === "failed" && job.error!.includes("ImportError"));
  assert.ok(!existsSync(join(root, "server/packages/demo-bot/bot.py")));
  assert.equal(readFileSync(join(root, "docs/ARCHITECTURE.md"), "utf8"), "# FluidForm architecture map\n");
});

test("a change that also touches FluidForm's own code, or an extension, is applied by a restart", async () => {
  for (const providers of [new PackageEngineer("automation", "server/src/main.ts"), new PackageEngineer("extension")]) {
    activated = [];
    const { calls, job } = await readyPackage(providers, async () => ({ status: "active" }));
    assert.ok(calls.length === 0 && activated.length === 1 && job.status === "applying", job.kind);
  }
});

test("which changes are one package's alone", () => {
  const where = join(folder(), "pkgs");
  for (const [id, kind] of [["bot", "automation"], ["ext", "extension"], ["site", "interface"]]) {
    mkdirSync(join(where, "server/packages", id), { recursive: true });
    writeFileSync(join(where, "server/packages", id, "capability.json"), JSON.stringify({ id, kind }));
  }
  assert.equal(engineer.packageOnly(where, ["server/packages/bot/bot.py", "server/tests/bot.test.ts", "docs/x.md", "skills/s/SKILL.md"]), "bot");
  assert.equal(engineer.packageOnly(where, ["server/packages/bot/bot.py", "server/src/api.ts"]), null);
  assert.equal(engineer.packageOnly(where, ["server/packages/ext/index.mjs"]), null);
  assert.equal(engineer.packageOnly(where, ["server/packages/site/site/index.html"]), null);
  assert.equal(engineer.packageOnly(where, ["docs/x.md"]), null);
  assert.equal(engineer.packageOnly(where, ["server/packages/bot/a", "server/packages/gone/b"]), null);
});
