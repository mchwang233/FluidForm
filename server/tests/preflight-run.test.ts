// The check before a task's first step, inside the executor: tests/test_preflight.py, ported.
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, test } from "node:test";
import * as agent from "../src/agent.js";
import * as cliChannels from "../src/cli-channels.js";
import { settings } from "../src/config.js";
import { Database } from "../src/db.js";
import { Executor } from "../src/executor.js";
import { type ExecutionRun, ExecutionRunSchema, TaskNodeSchema } from "../src/models.js";
import * as preflight from "../packages/learning/src/preflight.js";
import { ProviderResult } from "../src/providers.js";
import { ModelUnavailable } from "../src/quota.js";
import { allowRealClis, conftest } from "./helpers/conftest.js";
import { model } from "./helpers/lead-run.js";

// Codex's real home, before the tests give each their own.
const REAL_CODEX_HOME = cliChannels.codexHome();
const { folder } = conftest();
beforeEach(() => {
  Object.assign(settings, { preflight: true, review_nodes: false, workspace_root: join(folder(), "workspaces"), data_dir: join(folder(), "data") });
  preflight.PASSED.clear();
});

const needsBwrap = { skip: !agent.sandboxAvailable() && "bubblewrap is not installed" };
const MISSING = "command -v no-such-tool-for-preflight";
const MODELS = Object.fromEntries([model("x:flash", 90), model("y:gone", 90), model("cli:claude", 96, "cli")].map((m) => [m.id, m]));
const withCodex = () => ({ ...MODELS, "cli:codex": model("cli:codex", 96, "cli") });
const uid = process.getuid!();

/** Codex's own sandbox, where ``missing`` is not found. */
class CodexSandbox {
  commands: string[] = [];
  constructor(readonly missing: string[] = [], readonly unusable = false) {}

  async sandboxRun(_modelId: string, command: string, _cwd?: string, _timeout?: number): Promise<[string, boolean]> {
    this.commands.push(command);
    if (this.unusable) return ["error: unrecognized subcommand 'sandbox'", false];
    if (command === preflight.CLI_SANDBOX_COMMAND) return [`sp-write\n${uid}`, true];
    return this.missing.some((tool) => command.includes(tool)) ? ["Exit code 1", false] : ["ok", true];
  }
}

/** Models for the steps, the repair and the checks' tiny requests; y:gone never answers. */
class Machine {
  steps: string[] = [];
  repairs: string[] = [];
  pings: string[] = [];
  cli?: CodexSandbox;

  configuredModels(ids: Iterable<string>) {
    return new Set(ids);
  }

  async complete(modelId: string, prompt: string): Promise<ProviderResult> {
    if (modelId === "y:gone") throw new ModelUnavailable(modelId, new Date(), "y:gone 服务暂时不可用");
    if (prompt === "Reply with just: OK") {
      this.pings.push(modelId);
      return new ProviderResult("OK", 1, 1, modelId);
    }
    if (prompt.includes("these checks failed")) {
      this.repairs.push(prompt);
      return new ProviderResult("找不到这个工具，需要用户安装。\nSTATUS: BLOCKED\nUSER_ACTION: 安装它", 0, 0, modelId);
    }
    this.steps.push(prompt);
    return new ProviderResult("done", 1, 1, modelId);
  }
}

function task(db: Database, requires: string[] = [], modelId = "x:flash"): ExecutionRun {
  const run = ExecutionRunSchema.parse({ id: "r", prompt: "写一个模块并编译", status: "queued", budget_usd: 1,
    plan: { summary: "s", nodes: [{ id: "n", title: "编译", instructions: "编译它", capability: "coding", model_id: modelId }], requires } });
  db.saveRun(run);
  return run;
}
const taskWith = (requires: string[], network = false) => ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "queued", budget_usd: 1, allow_network: network,
  plan: { summary: "s", nodes: [], requires } });
const oneStep = () => [TaskNodeSchema.parse({ id: "n", title: "t", instructions: "i", capability: "coding", model_id: "x:flash" })];
const eventData = (db: Database, kind: string) => db.events("r").filter((event) => event.kind === kind).map((event) => event.data as Record<string, unknown>);

/** A home with keys and other projects, Codex's own folder in it, and the platform's folders. */
function fakeHome(): string {
  const home = join(folder(), "home");
  for (const name of [".ssh/id_rsa", ".codex/auth.json", ".codex/tmp/arg0/x", "code/other/main.c", "notes.txt"]) {
    mkdirSync(dirname(join(home, name)), { recursive: true });
    writeFileSync(join(home, name), "private");
  }
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  for (const name of ["this-task", "other-task"]) mkdirSync(join(settings.workspace_root, name), { recursive: true });
  mkdirSync(join(settings.data_dir, "tools", "bin"), { recursive: true });
  writeFileSync(join(settings.data_dir, "fluidform.db"), "db");
  return home;
}

/** The inline TOML table of paths (all keys and values are JSON strings) as an object. */
function rulesOf(args: string[]): Record<string, string> {
  const [table] = args.filter((arg) => arg.includes("filesystem=")).map((arg) => arg.split("filesystem=").slice(1).join("filesystem="));
  return JSON.parse(table.replaceAll('" = "', '": "'));
}
const resolve = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};
const resolved = (rules: Record<string, string>) => Object.fromEntries(Object.entries(rules).map(([path, mode]) => [path.startsWith("/") ? resolve(path) : path, mode]));

test("a missing tool is repaired once, then the task waits before any step", needsBwrap, async () => {
  const db = new Database(join(folder(), "t.db"));
  task(db, [MISSING]);
  const machine = new Machine();
  const executor = new Executor(db, machine, MODELS);
  await executor.execute("r");
  let run = db.getRun("r")!;
  assert.ok(run.status === "paused" && machine.steps.length === 0);
  assert.ok(machine.repairs.length === 1 && machine.repairs[0].includes(MISSING));
  assert.ok(run.error!.includes(MISSING) && run.preflight!.passed === false && run.preflight!.repaired);
  assert.deepEqual(eventData(db, "approval.required").map((data) => data.reason), ["preflight_failed"]);
  // The user goes on anyway: checked again, not repaired again, and the steps run.
  run.status = "queued";
  db.saveRun(run);
  await executor.execute("r");
  run = db.getRun("r")!;
  assert.ok(run.status === "succeeded" && machine.steps.length === 1 && machine.repairs.length === 1);
  assert.deepEqual(eventData(db, "run.preflight").map((data) => data.overruled), [false, true]);
});

test("a task whose checks pass runs, and a model not answering is only a warning", needsBwrap, async () => {
  const db = new Database(join(folder(), "t.db"));
  const given = task(db, ["sh -c 'exit 0'"]);
  given.plan.nodes.push(TaskNodeSchema.parse({ id: "m", title: "另一步", instructions: "i", capability: "coding", model_id: "y:gone", status: "succeeded" }));
  db.saveRun(given);
  const machine = new Machine();
  await new Executor(db, machine, MODELS).execute("r");
  const run = db.getRun("r")!;
  assert.ok(run.status === "succeeded" && run.preflight!.passed && machine.repairs.length === 0);
  assert.deepEqual(machine.pings, ["x:flash"]);
  const [warning, ...more] = preflight.failures(run.preflight!.checks, false);
  assert.equal(more.length, 0);
  assert.ok(warning.command === "y:gone" && warning.output.includes("不可用"));
  // Checked once: going on with the task later does not check again.
  assert.equal(eventData(db, "run.preflight").length, 1);
});

test("the check can be turned off", async () => {
  settings.preflight = false;
  const db = new Database(join(folder(), "t.db"));
  task(db, [MISSING]);
  await new Executor(db, new Machine(), MODELS).execute("r");
  assert.ok(db.getRun("r")!.status === "succeeded" && db.getRun("r")!.preflight === null);
});

test("a tool Codex cannot find stops the task before any step", needsBwrap, async () => {
  const machine = new Machine();
  machine.cli = new CodexSandbox(["fakesim"]);
  const db = new Database(join(folder(), "t.db"));
  const executor = new Executor(db, machine, withCodex());
  const run = taskWith(["true fakesim"]);
  run.plan.nodes = oneStep();
  db.saveRun(run);
  assert.equal(await executor.preflight("r"), false);
  const failed = db.getRun("r")!.preflight!.checks.filter((c) => !c.ok);
  assert.deepEqual(failed.map((c) => c.name), ["Codex 沙箱：工具"]);
  assert.equal(machine.steps.length, 0);
});

test("a Codex step reads only its folder and what it needs", () => {
  const home = resolve(fakeHome());
  const cwd = join(settings.workspace_root, "this-task");
  const rules = resolved(rulesOf(cliChannels.codexStepPermissions(cwd, false)));
  const data = resolve(settings.data_dir);
  const denied = new Set(Object.entries(rules).filter(([, mode]) => mode === "deny").map(([path]) => path));
  for (const path of [join(home, ".ssh"), join(home, "code"), join(home, "notes.txt"), join(home, ".codex", "auth.json"), join(data, "fluidform.db"),
    join(resolve(settings.workspace_root), "other-task")]) assert.ok(denied.has(path), path);
  // Its folder is under /tmp here: the rest of /tmp is denied entry by entry instead.
  assert.ok(denied.has(":slash_tmp") || [...denied].some((path) => path.startsWith("/tmp/")));
  assert.ok(!denied.has(join(home, ".codex", "tmp")) && !denied.has(join(data, "tools"))); // Codex's helper, the tools
  assert.ok(rules[resolve(cwd)] === "write" && rules[":tmpdir"] === "write");
  // A lead reads, the tasks' folders included, and nothing is written.
  const lead = rulesOf(cliChannels.codexStepPermissions(join(home, ".codex"), false, { lead: true }));
  assert.ok(!Object.values(lead).includes("write") && !Object.keys(lead).some((path) => path.includes("other-task")));
  // A chat's lead may read its own attachments, and no one else's.
  const mine = join(data, "attachments", "mine", "content");
  mkdirSync(mine, { recursive: true });
  mkdirSync(join(data, "attachments", "theirs", "content"), { recursive: true });
  const chat = resolved(rulesOf(cliChannels.codexStepPermissions(join(home, ".codex"), false, { lead: true, readable: [mine] })));
  assert.ok(chat[mine] === "read" && !Object.values(chat).includes("write"));
  assert.equal(chat[join(data, "attachments", "theirs")], "deny");
});

test("Codex reading the platform's data is a warning", async () => {
  const home = fakeHome();
  settings.database_path = join(settings.data_dir, "fluidform.db");
  class Leaky extends CodexSandbox {
    override async sandboxRun(modelId: string, command: string, cwd?: string, timeout?: number): Promise<[string, boolean]> {
      if (command.includes("readable:")) return [`readable: ${settings.dbPath}`, true];
      return super.sandboxRun(modelId, command, cwd, timeout);
    }
  }
  const checks = await preflight.cliChecks(new Leaky(), taskWith([]), join(settings.workspace_root, "this-task"), new Set(["cli:codex"]));
  const [privacy] = checks.filter((c) => c.name.includes("读不到"));
  assert.ok(!privacy.ok && !privacy.blocking);
  assert.equal(cliChannels.codexHome(), join(home, ".codex"));
});

test("in Codex's real sandbox a step cannot read keys or other tasks", { skip: !cliChannels.deps.which("codex") && "Codex is not installed" }, async (t) => {
  // With the real Codex: the profile is accepted and enforced (bubblewrap).
  const home = fakeHome();
  // Codex needs its own helper, which it keeps in its real home; this test's home lacks it.
  process.env.CODEX_HOME = REAL_CODEX_HOME;
  allowRealClis(); // only its sandbox runs: no model is asked anything
  const cwd = join(settings.workspace_root, "this-task");
  const script = `cat ${home}/.ssh/id_rsa; cat ${settings.workspace_root}/other-task/../other-task 2>&1; cat ${settings.data_dir}/fluidform.db; `
    + "echo mine > own.txt && cat own.txt; echo t > $TMPDIR/t && cat $TMPDIR/t; echo s > /tmp/sp-step-$$ && cat /tmp/sp-step-$$ && rm /tmp/sp-step-$$";
  const [output] = await new cliChannels.CliChannelRegistry().sandboxRun("cli:codex", script, cwd, 60);
  if (output.includes("unknown") || output.includes("requires")) {
    t.skip(`this Codex cannot use permission profiles: ${output.slice(0, 200)}`);
    return;
  }
  const lines = output.split("\n");
  assert.ok(!lines.includes("private") && !lines.includes("db")); // what the files hold never comes back
  assert.ok(lines.includes("mine") && lines.includes("t") && lines.includes("s"), output); // its own folder, TMPDIR and /tmp work
});

test("the platform's own check still failing after the repair goes to the platform engineer", needsBwrap, async () => {
  // Regression: a failing check of FluidForm's own sandbox only paused the task; the diagnosis said
  // it was FluidForm's to fix, and nobody did.
  class Noisy extends CodexSandbox {
    override async sandboxRun(modelId: string, command: string, cwd?: string, timeout?: number): Promise<[string, boolean]> {
      if (command === preflight.CLI_SANDBOX_COMMAND) return ["sp-write\nnot-the-user", true];
      return super.sandboxRun(modelId, command, cwd, timeout);
    }
  }
  const machine = new Machine();
  machine.cli = new Noisy();
  const db = new Database(join(folder(), "t.db"));
  const executor = new Executor(db, machine, withCodex());
  const asked: [string, { kind?: string; request: string }, string][] = [];
  executor.engineerJoin = (runId, call, origin) => {
    asked.push([runId, call, origin]);
    return [null, "不可用"];
  };
  const given = taskWith([]);
  given.plan.nodes = oneStep();
  db.saveRun(given);
  assert.equal(await executor.preflight("r"), false);
  const [[runId, call, origin]] = asked;
  assert.ok(runId === "r" && origin === "diagnosis" && call.kind === "repair");
  assert.ok(call.request.includes("Codex 沙箱：写工作目录") && call.request.includes("not-the-user"));
  assert.ok(db.getRun("r")!.error!.includes("平台工程师"));
  // Once: going on anyway does not ask again.
  const run = db.getRun("r")!;
  run.status = "queued";
  db.saveRun(run);
  await executor.preflight("r");
  assert.equal(asked.length, 1);
});
