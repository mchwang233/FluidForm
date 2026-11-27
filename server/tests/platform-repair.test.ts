// platform-repair.ts: tests/test_platform_repair.py, ported, on a checkout laid out as after the switch
// (server/ and frontend/; the regression tests in server/tests).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as agent from "../src/agent.js";
import { settings } from "../src/config.js";
import { Database } from "../src/db.js";
import { Executor } from "../src/executor.js";
import { DiagnosisSchema, ExecutionRunSchema, ModelProfileSchema, NodeAttemptSchema } from "../src/models.js";
import * as platform from "../src/platform-repair.js";
import { type CompleteOptions, ProviderResult } from "../src/providers.js";
import * as worker from "../src/repair-worker.js";
import { conftest } from "./helpers/conftest.js";
import { API, editCandidate, passingCheck, prepareWithoutService, sourceCheckout } from "./helpers/source-checkout.js";

const { folder } = conftest();
const savedWorker = { ...worker.deps };
const savedPlatform = { ...platform.deps };
afterEach(() => {
  Object.assign(worker.deps, savedWorker);
  Object.assign(platform.deps, savedPlatform);
});

let checkout: string;
beforeEach(() => {
  checkout = sourceCheckout(folder());
});
const passing = passingCheck;
const manager = () => new platform.SourceRepairs(checkout, join(folder(), "data"), "http://localhost:8000");

async function candidate() {
  const repairs = manager();
  repairs.checkCommand = passing;
  const job = await repairs.prepare("r", "d");
  editCandidate(job);
  await repairs.check(job);
  return [repairs, job] as const;
}

test("the source copy and its checks keep data and the user's edits apart", async () => {
  const [repairs, job] = await candidate();
  const copied = join(job.folder, "source");
  for (const name of [".env", "workspaces", ".fluidform"]) assert.ok(!existsSync(join(copied, name)), name);
  assert.ok(readFileSync(join(checkout, API), "utf8").includes("broken"));
  assert.ok(readFileSync(join(copied, API), "utf8").includes("unrelated user edit"));
  assert.equal(job.checks.length, 4);
  assert.equal(job.status, "validated");
  assert.equal(repairs.pending(), null);
  // The worker goes with the job, so a repair cannot change what applies it.
  assert.ok(existsSync(job.activate) && readFileSync(job.activate, "utf8").includes("export async function activate"));
});

test("copies no longer in use are removed; one in use, pending or just made stays", async () => {
  const repairs = manager();
  const made = await Promise.all([0, 1, 2, 3].map(() => repairs.prepare("r", "d")));
  const [used, waiting, old, fresh] = made;
  repairs.schedule(waiting);
  const later = Date.now() / 1000 + platform.SWEEP_MIN_AGE_SECONDS + 1;
  // The fresh one was just made: as if made now, at sweep time.
  repairs.save({ ...fresh, created_at: later });
  assert.deepEqual(repairs.sweep(new Set([used.id]), later), [old.id]);
  assert.ok(!existsSync(old.folder));
  for (const job of [used, waiting, fresh]) assert.ok(existsSync(job.folder));
});

test("failed checks and a missing regression test cannot apply a patch", async () => {
  const repairs = manager();
  const job = await repairs.prepare("r", "d");
  writeFileSync(join(job.folder, "source", API), "export const VALUE = 'fixed';\n");
  await assert.rejects(repairs.check(job), /回归测试/);
  editCandidate(job);
  repairs.checkCommand = async () => ({ returncode: 1, output: "regression still fails" });
  await assert.rejects(repairs.check(job), /regression still fails/);
  assert.ok(readFileSync(join(checkout, API), "utf8").includes("broken"));
  assert.equal(repairs.pending(), null);
});

test("older repairs without network permission are checked offline", async () => {
  const repairs = manager();
  const job = await repairs.prepare("r", "d");
  delete job.allow_network;
  editCandidate(job);
  const permissions: boolean[] = [];
  repairs.checkCommand = async (_command, _cwd, _source, { allowNetwork = false } = {}) => {
    permissions.push(allowNetwork);
    return passing();
  };
  await repairs.check(job);
  assert.deepEqual(permissions, [false, false, false, false]);
});

test("checks follow the task's network and proxy rules, without provider keys", async () => {
  for (const allowNetwork of [false, true]) {
    for (const pasta of [false, true]) {
      const repairs = manager();
      const job = await repairs.prepare("r", "d", { allowNetwork });
      const source = join(job.folder, "source");
      for (const name of agent.PROXY_ENV) delete process.env[name];
      Object.assign(process.env, { HTTPS_PROXY: "http://127.0.0.1:3180", NO_PROXY: "example.test", OPENAI_API_KEY: "private-provider-key" });
      const captured: { args: string[]; env: Record<string, string> } = { args: [], env: {} };
      platform.deps.spawn = (command, args, options) => {
        captured.args = [command, ...args];
        captured.env = options!.env as Record<string, string>;
        const child = new EventEmitter() as never as import("node:child_process").ChildProcess;
        Object.assign(child, { pid: 0 });
        writeSync((options!.stdio as number[])[1], "checked\n");
        setImmediate(() => child.emit("close", 0));
        return child;
      };
      platform.deps.networkAvailable = () => pasta;
      const result = await repairs.checkCommand(["true"], source, source, { allowNetwork });
      const label = `${allowNetwork} ${pasta}`;
      assert.deepEqual(result, { returncode: 0, output: "checked\n" }, label);
      const { args, env } = captured;
      assert.equal(!args.includes("--unshare-net"), allowNetwork, label);
      assert.equal(args[0] === "pasta", allowNetwork && pasta, label);
      if (allowNetwork && pasta) {
        assert.equal(args[args.indexOf("-T") + 1], "3180");
        assert.ok(args.includes("--no-map-gw"));
      }
      assert.equal(env.HTTPS_PROXY, allowNetwork ? "http://127.0.0.1:3180" : undefined, label);
      assert.equal(env.NO_PROXY, allowNetwork ? "example.test" : undefined, label);
      assert.ok(!("OPENAI_API_KEY" in env));
      assert.equal(env.FLUIDFORM_VALIDATION_ALLOW_NETWORK, String(allowNetwork));
      assert.equal(env.FLUIDFORM_DATA_DIR, join(source, ".validation", "data"));
    }
  }
});

test("the real check sandbox obeys the network permission and keeps data private", { skip: !agent.sandboxAvailable() && "bubblewrap is not installed" }, async (t) => {
  for (const allowNetwork of [false, true]) {
    if (allowNetwork && (!agent.networkAvailable() || process.env.FLUIDFORM_VALIDATION_ALLOW_NETWORK === "false")) {
      t.diagnostic("pasta is not installed, or the network is not allowed here: only the offline case ran");
      continue;
    }
    const repairs = manager();
    const job = await repairs.prepare("r", "d", { allowNetwork });
    const source = join(job.folder, "source");
    const greet = () => createServer((socket) => socket.end("validation-proxy"));
    const proxy = greet();
    const local = greet();
    await Promise.all([proxy, local].map((server) => new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()))));
    const [port, other] = [proxy, local].map((server) => (server.address() as { port: number }).port);
    for (const name of agent.PROXY_ENV) delete process.env[name];
    process.env.HTTPS_PROXY = `http://127.0.0.1:${port}`;
    process.env.OPENAI_API_KEY = "private-provider-key";
    // A bounded local probe checks the route and proxy rules without reaching the internet.
    const probe = `const { existsSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const net = require("node:net");
const receive = (port) => new Promise((done) => { const s = net.connect({ host: "127.0.0.1", port: Number(port) }); let text = "";
  s.setTimeout(2000, () => { s.destroy(); done(null); }); s.on("data", (d) => (text += d)); s.on("end", () => done(text)); s.on("error", () => done(null)); });
(async () => {
  writeFileSync("validation-output.txt", "checked");
  const route = readFileSync("/proc/net/route", "utf8").split("\\n").some((line) => line.split(/\\s+/)[1] === "00000000");
  let tun = false; try { tun = statSync("/dev/net/tun").isCharacterDevice(); } catch {}
  console.log(JSON.stringify({ route, proxy: await receive(process.argv[1]), local: await receive(process.argv[2]), proxy_env: process.env.HTTPS_PROXY ?? null,
    key: process.env.OPENAI_API_KEY ?? null, private_file_visible: existsSync(process.argv[3]), tun }));
})();`;
    try {
      const result = await repairs.checkCommand([process.execPath, "-e", probe, String(port), String(other), join(checkout, ".env")], source, source, { allowNetwork });
      assert.equal(result.returncode, 0, `${allowNetwork}: ${result.output}`);
      const observed = JSON.parse(result.output.trim().split("\n").at(-1)!);
      assert.equal(observed.route, allowNetwork);
      assert.equal(observed.proxy, allowNetwork ? "validation-proxy" : null);
      assert.equal(observed.proxy_env, allowNetwork ? `http://127.0.0.1:${port}` : null);
      assert.equal(observed.local, null);
      assert.ok(observed.key === null && !observed.private_file_visible);
      assert.equal(observed.tun, allowNetwork);
      assert.equal(readFileSync(join(source, "validation-output.txt"), "utf8"), "checked");
    } finally {
      proxy.close();
      local.close();
    }
  }
});

test("source changes made meanwhile are not overwritten", async () => {
  const [repairs, job] = await candidate();
  writeFileSync(join(checkout, API), "another edit arrived\n");
  await assert.rejects(repairs.launch(job), /其他操作修改/);
  assert.equal(readFileSync(join(checkout, API), "utf8"), "another edit arrived\n");
});

test("applying installs, builds and restarts, or rolls back, without touching task data", async () => {
  for (const healthy of [true, false]) {
    const [repairs, job] = await candidate();
    job.status = "scheduled";
    repairs.save(job);
    const commands: string[][] = [];
    worker.deps.run = (args) => {
      commands.push(args);
    };
    let checks = 0;
    worker.deps.waitHealthy = () => {
      checks += 1;
      if (!healthy && checks === 1) throw new worker.RepairError("new API did not start");
    };
    await worker.activate(join(job.folder, "job.json"));
    const saved = JSON.parse(readFileSync(join(job.folder, "job.json"), "utf8"));
    assert.equal(saved.status, healthy ? "activated" : "rolled_back", String(healthy));
    const content = readFileSync(join(checkout, API), "utf8");
    assert.ok(content.includes(healthy ? "fixed" : "broken") && content.includes("unrelated user edit"));
    // Each time: the server is built from the source in place, then the service restarted.
    const once = [["npm", "run", "build"], ["systemctl", "--user", "restart", job.unit]];
    assert.deepEqual(commands, healthy ? once : [...once, ...once]);
    assert.equal(readFileSync(join(checkout, ".fluidform/fluidform.db"), "utf8"), "keep task data");
    assert.equal(readFileSync(join(checkout, "workspaces/kept/file.txt"), "utf8"), "keep project");
    assert.equal(existsSync(join(checkout, "server/tests/new-regression.test.ts")), healthy);
    // Undo the applied fix for the next case.
    writeFileSync(join(checkout, API), "export const VALUE = 'broken';\n// unrelated user edit\n");
    rmSync(join(checkout, "server/tests/new-regression.test.ts"), { force: true });
  }
});

test("a candidate changed after its checks is not applied", async () => {
  const [repairs, job] = await candidate();
  job.status = "scheduled";
  repairs.save(job);
  writeFileSync(join(job.folder, "source", API), "unverified change");
  await worker.activate(join(job.folder, "job.json"));
  assert.equal(JSON.parse(readFileSync(join(job.folder, "job.json"), "utf8")).status, "failed");
  assert.ok(readFileSync(join(checkout, API), "utf8").includes("broken"));
});

test("the worker runs as plain Node from its own copy", async () => {
  // A frozen copy runs with no compiler and none of the server's modules.
  const [, job] = await candidate();
  const { spawnSync } = await import("node:child_process");
  const done = spawnSync(process.execPath, [job.activate, join(job.folder, "job.json")], { encoding: "utf8" });
  assert.equal(done.status, 0, done.stderr);
  // The job was validated, not scheduled: it refuses, and says so.
  const saved = JSON.parse(readFileSync(join(job.folder, "job.json"), "utf8"));
  assert.ok(saved.status === "failed" && saved.error.includes("停止应用补丁"));
});

// test_diagnosis's models, a one-step task and providers that fail.
const model = (id: string, planning: number, channel = "api") => ({ id, provider: id.split(":")[0], display_name: id, channel, context_window: 1_000_000,
  input_per_million: 1, output_per_million: 1, execution_priority: channel === "cli" ? 0 : 100, scores: { coding: 90, planning, reliability: 90 } });
const MODELS = Object.fromEntries([model("x:api", 99), model("cli:claude", 90, "cli")].map((m) => [m.id, ModelProfileSchema.parse(m)]));
function oneNodeRun(db: Database): void {
  db.saveRun(ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "queued", budget_usd: 1, use_cli: true,
    plan: { summary: "s", nodes: [{ id: "n", title: "Check", instructions: "run node --check", capability: "coding", model_id: "x:api" }] } }));
}
const providers = { configuredModels: (ids: Iterable<string>) => new Set(ids), complete: async () => {
  throw new Error("node is not installed");
} };

test("a platform diagnosis edits a copy, and only then schedules applying it", async () => {
  for (const [networkBefore, networkAfter] of [[false, false], [true, true], [false, true], [true, false]]) {
    Object.assign(settings, { platform_root: checkout, platform_self_repair: true, auto_diagnose: true, review_nodes: false });
    const db = new Database(join(folder(), `test-${networkBefore}-${networkAfter}.db`));
    const { ProviderError } = await import("../src/budget.js");
    const platformProvider = { configuredModels: (ids: Iterable<string>) => new Set(ids), async complete(modelId: string, prompt: string, options: CompleteOptions = {}) {
      if (prompt.startsWith("[[fluidform:platform-repair]]")) {
        assert.equal(options.repair, false);
        // Every model that repairs gets the skill and the map, and its copy has them too.
        assert.ok(prompt.includes("# Repairing FluidForm") && prompt.includes("architecture map") && !prompt.includes("name: platform-repair"));
        const workspace = options.workspace!;
        assert.ok(existsSync(join(workspace, "AGENTS.md")) && existsSync(join(workspace, "skills/platform-repair/SKILL.md")) && workspace !== checkout);
        assert.equal(JSON.parse(readFileSync(join(dirname(workspace), "job.json"), "utf8")).allow_network, networkBefore);
        const current = db.getRun("r")!;
        current.allow_network = networkAfter;
        db.saveRun(current);
        editCandidate({ folder: dirname(workspace) });
        return new ProviderResult("修复调度器并添加回归检查。\nSTATUS: FIXED", 0, 0, modelId);
      }
      if (options.repair) {
        assert.ok(prompt.includes(checkout) && prompt.includes("LOCATION:") && prompt.includes(`${checkout}/skills/platform-repair/SKILL.md`));
        // Only the paths: a task diagnosis must not take the platform guide for the task's.
        assert.ok(!prompt.includes("# Repairing FluidForm"));
        return new ProviderResult("FluidForm 调度器没有正确处理步骤状态。\nSTATUS: PLATFORM_REPAIR", 0, 0, modelId);
      }
      throw new ProviderError("scheduler defect");
    } };
    oneNodeRun(db);
    const current = db.getRun("r")!;
    current.allow_network = networkBefore;
    db.saveRun(current);
    const executor = new Executor(db, platformProvider, MODELS);
    const permissions: boolean[] = [];
    (executor.platform as platform.SourceRepairs).checkCommand = async (_command, _cwd, _source, { allowNetwork = false } = {}) => {
      permissions.push(allowNetwork);
      return passing();
    };
    let launched!: () => void;
    const applied = new Promise<void>((done) => (launched = done));
    executor.activatePlatform = async () => launched();
    await executor.execute("r");
    assert.ok(executor.platformPending, JSON.stringify(db.events("r").map((e) => [e.kind, e.data])).slice(0, 3000));
    await Promise.race([applied, new Promise((_, fail) => setTimeout(() => fail(new Error("never applied")), 2000).unref())]);
    const run = db.getRun("r")!;
    assert.equal(run.status, "paused");
    assert.equal(run.maintenance_id, executor.platformPending!.id);
    assert.equal(run.plan.nodes[0].status, "pending");
    assert.equal(run.diagnoses.at(-1)!.scope, "fluidform");
    assert.equal(run.diagnoses.at(-1)!.verdict, "platform_pending");
    assert.equal(executor.platformPending!.allow_network, networkAfter);
    // The database's records are checked too: five checks.
    assert.deepEqual(permissions, Array(5).fill(networkAfter));
    assert.ok(readFileSync(join(checkout, API), "utf8").includes("broken"));
  }
});

test("a task repair retry keeps the failed test and its error from a long check report", async () => {
  Object.assign(settings, { platform_root: checkout, platform_self_repair: true, platform_repair_attempts: 2 });
  const db = new Database(join(folder(), "feedback.db"));
  try {
    oneNodeRun(db);
    const run = db.getRun("r")!;
    const diagnosis = DiagnosisSchema.parse({ id: "d", trigger: "auto", node_id: "n" });
    run.diagnoses.push(diagnosis);
    db.saveRun(run);
    const executor = new Executor(db, providers, MODELS);
    prepareWithoutService(executor.platform as platform.SourceRepairs);
    const prompts: string[] = [];
    executor.diagnoseWith = async (_run, _diagnosis, _node, prompt, workspace) => {
      prompts.push(prompt);
      editCandidate({ folder: dirname(workspace) });
      return [new ProviderResult("已修复。\nSTATUS: FIXED", 0, 0), "x:api", 0];
    };
    const output = "not ok 1 - task reply regression\n  ---\n  error: 'expected a reply, got none'\n  ...\n"
      + "ok 2 - a later passing check\n".repeat(2000) + "# fail 1\n";
    let checked = 0;
    (executor.platform as platform.SourceRepairs).checkCommand = async (command, cwd, source) => {
      if (command.join(" ") === "npm test" && cwd === join(source, "server") && checked++ === 0) {
        return { returncode: 1, output: platform.failureOutput(output) };
      }
      return passing();
    };
    executor.activatePlatform = async () => undefined;
    await executor.fixPlatform(run, diagnosis, run.plan.nodes[0], "回复丢失");
    assert.equal(prompts.length, 2);
    const feedback = prompts[1].split("The independent check failed. Fix it and recheck:\n")[1];
    assert.match(feedback, /not ok 1 - task reply regression/);
    assert.match(feedback, /expected a reply, got none/);
    assert.match(feedback, /# fail 1/);
    assert.ok(feedback.length <= 6000);
    assert.ok(executor.platformPending);
    await executor.maintenanceTask!.settled();
  } finally {
    db.close();
  }
});

test("a repair waits for a restart longer than systemd waits for the old process", async () => {
  // Regression: the restart timed out at 90 s, exactly when systemd killed the old process that would
  // not stop, and a good repair (a DingTalk bot) was rolled back.
  const [repairs, job] = await candidate();
  job.status = "scheduled";
  repairs.save(job);
  const timeouts: number[] = [];
  worker.deps.run = (args, options) => {
    if (args[1] === "--user" && args[2] === "restart") timeouts.push(options?.timeout ?? 0);
  };
  worker.deps.waitHealthy = () => undefined;
  await worker.activate(join(job.folder, "job.json"));
  assert.ok(timeouts.length && timeouts.every((seconds) => seconds > 90 + 30), String(timeouts));
});

test("a restart resumes only the held runs with budget left", () => {
  const db = new Database(join(folder(), "test.db"));
  oneNodeRun(db);
  const original = db.getRun("r")!;
  for (const [id, status, marker, budget] of [["held", "paused", "repair", 1], ["user-paused", "paused", null, 1], ["cancelled", "cancelled", "repair", 1],
    ["over-budget", "paused", "repair", 0]] as const) {
    db.saveRun(ExecutionRunSchema.parse({ ...structuredClone(original), id, status, maintenance_id: marker, budget_usd: budget, actual_cost_usd: 0.1,
      diagnoses: [DiagnosisSchema.parse({ id: "d", trigger: "auto", status: "done", repair_id: "repair" })] }));
  }
  const executor = new Executor(db, providers as never, MODELS);
  const restarted: string[] = [];
  executor.start = (runId: string) => {
    restarted.push(runId);
  };
  executor.finishPlatform({ id: "repair", status: "activated", run_id: "held", files: ["server/src/x.ts"], folder: "" });
  assert.deepEqual(restarted, ["held"]);
  assert.equal(db.getRun("user-paused")!.status, "paused");
  assert.equal(db.getRun("cancelled")!.status, "cancelled");
  assert.equal(db.getRun("over-budget")!.status, "paused");
  assert.equal((db.sharedRepairs()[0] as Record<string, unknown>).scope, "fluidform");
});

test("links in the source cannot take a repair outside it", () => {
  const external = join(folder(), "secret.ts");
  writeFileSync(external, "private");
  symlinkSync(external, join(checkout, "server/linked.ts"));
  assert.throws(() => platform.sourceFiles(checkout), /符号链接/);
});

test("every platform change is given the platform's rules", () => {
  // Repairs and components alike get the limits on changing FluidForm: no facts about one machine
  // in its source, the sandbox closed by default, no git in the copy.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  for (const names of [platform.REPAIR_GUIDES, platform.COMPONENT_GUIDES]) {
    const guide = platform.repairGuide(root, names);
    assert.ok(guide.includes("<<< skills/platform-rules/SKILL.md >>>"));
    assert.ok(guide.includes("No facts about this machine in the source") && guide.includes("Do not use git"));
    assert.ok(!guide.startsWith("---"));
  }
  // The map stays second: diagnosis prompts point to it by position.
  assert.equal(platform.REPAIR_GUIDES[1], "docs/ARCHITECTURE.md");
});

test("applying keeps outcomes and asks for the evidence to be recovered before more work", () => {
  for (const answer of [null, "current attempt answer"]) {
    const db = new Database(join(folder(), `recovery-${Boolean(answer)}.db`));
    oneNodeRun(db);
    const run = db.getRun("r")!;
    run.status = "paused";
    run.maintenance_id = "repair";
    const node = run.plan.nodes[0];
    node.attempts = [NodeAttemptSchema.parse({ outcome: "error", result: answer })];
    node.result = "older answer";
    node.feedback = "keep the previous acceptance requirements";
    run.diagnoses = [DiagnosisSchema.parse({ id: "d", node_id: node.id, trigger: "auto", status: "done", repair_id: "repair" })];
    db.saveRun(run);
    const executor = new Executor(db, providers as never, MODELS);
    executor.start = () => undefined;
    executor.finishPlatform({ id: "repair", status: "activated", run_id: "r", files: [], folder: "" });
    const saved = db.getRun("r")!.plan.nodes[0];
    assert.equal(saved.attempts[0].outcome, "error");
    assert.equal(saved.result, "older answer");
    assert.ok(saved.feedback!.startsWith("keep the previous acceptance requirements"));
    assert.ok(saved.feedback!.includes("先核对") && saved.feedback!.includes("不要重复整轮工作"));
    assert.ok(saved.feedback!.includes(answer ? "本次回答已保存" : "本次回答未记录"));
    assert.ok(saved.feedback!.includes("不代表任务验收通过"));
  }
});

test("a diff shows what the copy changed", async () => {
  const [repairs, job] = await candidate();
  const diff = repairs.diff(job);
  assert.ok(diff.includes(`--- a/${API}`) && diff.includes(`+++ b/${API}`));
  assert.ok(diff.includes("-export const VALUE = 'broken';") && diff.includes("+export const VALUE = 'fixed';"));
  assert.ok(diff.includes("+++ b/server/tests/new-regression.test.ts") && diff.includes("+// the regression"));
});

test("this very checkout fits a repair's snapshot, without the page built from it", () => {
  const files = worker.sourceFiles(fileURLToPath(new URL("../../", import.meta.url)));
  assert.ok("server/tests/golden/routing.json" in files && "server/packages/planning/src/index.ts" in files);
  assert.ok("evals/basic.json" in files); // the checks run the suite that reads it
  assert.ok(!Object.keys(files).some((name) => name.startsWith("server/packages/web/site/")));
});

test("applying a repair of the page builds the page again", () => {
  mkdirSync(join(checkout, "frontend", "node_modules"), { recursive: true });
  const ran: string[] = [];
  worker.deps.run = (args: string[]) => {
    ran.push(args.join(" "));
  };
  worker.build({ id: "j", folder: "", status: "", root: checkout, files: ["frontend/src.tsx"] });
  assert.deepEqual(ran, ["npm run build", "npm run package"]);
  ran.length = 0;
  worker.build({ id: "j", folder: "", status: "", root: checkout, files: ["server/src/api.ts"] });
  assert.deepEqual(ran, ["npm run build"]);
});

test("a failed check says which test failed, however much ran after it", () => {
  const output = `not ok 2 - the one that failed\n  error: 'boom'\n${"ok 3 - fine\n".repeat(3000)}# fail 1\n`;
  const said = platform.failureOutput(output);
  assert.ok(said.length <= 8000 && said.includes("the one that failed") && said.endsWith("# fail 1\n"));
});
