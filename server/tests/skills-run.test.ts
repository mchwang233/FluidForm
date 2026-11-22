// Preparing this machine's skills before a task: the executor tests of tests/test_skills.py, ported.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import * as agent from "../src/agent.js";
import { settings } from "../src/config.js";
import { Database } from "../src/db.js";
import * as environment from "../src/environment.js";
import { Executor } from "../src/executor.js";
import { ExecutionRunSchema } from "../src/models.js";
import { type CompleteOptions, ProviderResult } from "../src/providers.js";
import * as skillDiscovery from "../packages/learning/src/skill-discovery.js";
import * as skills from "../src/skills.js";
import { conftest } from "./helpers/conftest.js";
import { model } from "./helpers/lead-run.js";

const { folder } = conftest();
const savedSource = skills.places.source;
const savedDiscover = skillDiscovery.deps.discover;
const GENERAL = "---\nname: fake-sim\ndescription: Drive the fake simulator.\ntools: [fakesim, fakerep]\n---\n# Fake simulator\nCompile with `fakesim -c`.\n";
const MODELS = { "x:flash": model("x:flash", 90) };
const needsBwrap = { skip: !agent.sandboxAvailable() && "bubblewrap is not installed" };

/** library: a general skill for the fake simulator. */
beforeEach(() => {
  const source = join(folder(), "source");
  mkdirSync(join(source, "fake-sim"), { recursive: true });
  writeFileSync(join(source, "fake-sim", "SKILL.md"), GENERAL);
  skills.places.source = source;
  Object.assign(settings, { data_dir: join(folder(), "data"), workspace_root: join(folder(), "workspaces") });
});
afterEach(() => {
  skills.places.source = savedSource;
  skillDiscovery.deps.discover = savedDiscover;
});

/** A model that writes the skill it is asked for, and does the steps. */
class Machine {
  skillPrompts: string[] = [];
  stepPrompts: string[] = [];
  configuredModels(ids: Iterable<string>) {
    return new Set(ids);
  }

  async complete(modelId: string, prompt: string): Promise<ProviderResult> {
    if (prompt.includes("write this machine's skill")) {
      this.skillPrompts.push(prompt);
      return new ProviderResult("---\nname: fake-sim\ndescription: fake-sim here\ntools: [fakesim]\n---\n# Here\nRun `fakesim -c a.sv` after `source env.sh`.\n", 1, 1, modelId);
    }
    if (prompt !== "Reply with just: OK") this.stepPrompts.push(prompt); // the check that the model answers
    return new ProviderResult("done", 1, 1, modelId);
  }
}

function task(db: Database, runId: string, network = false): void {
  db.saveRun(ExecutionRunSchema.parse({ id: runId, prompt: "用 fakesim 验证", status: "queued", budget_usd: 1, allow_network: network,
    plan: { summary: "s", nodes: [{ id: "n", title: "仿真", instructions: "用 fakesim 编译并运行测试", capability: "coding", model_id: "x:flash" }], requires: ["fakesim --version"] } }));
}
const onlyFakesim = async () => ["fakesim"];

test("reusing first takes the general skill there is, without writing one", async () => {
  settings.skill_reuse_first = true;
  const db = new Database(join(folder(), "t.db"));
  task(db, "reuse");
  const machine = new Machine();
  const executor = new Executor(db, machine, MODELS);
  executor.available = onlyFakesim;
  assert.deepEqual(await executor.prepareSkills("reuse", folder(), []), ["fake-sim"]);
  assert.equal(machine.skillPrompts.length, 0);
  assert.ok(!existsSync(skills.machineDir()));
  const selected = db.events("reuse").filter((e) => e.kind === "run.skill_selected");
  assert.equal((selected[0].data as Record<string, unknown>).origin, "general");
});

test("a search comes before a bounded writing, only when the network is allowed", async () => {
  for (const network of [false, true]) {
    Object.assign(settings, { skill_reuse_first: true, skill_generation_max_turns: 4, data_dir: join(folder(), `data-${network}`) });
    skills.places.source = join(folder(), "empty");
    const db = new Database(join(folder(), `t-${network}.db`));
    task(db, "missing", network);
    const executor = new Executor(db, new Machine(), MODELS);
    const actions: string[] = [];
    executor.available = onlyFakesim;
    skillDiscovery.deps.discover = async () => {
      actions.push("search");
      return { skill: null, reason: "No match" };
    };
    executor.complete = async (_run, _node, _modelId, _prompt, _workspace, options: CompleteOptions = {}) => {
      actions.push("generate");
      assert.equal(options.max_turns, 4);
      return new ProviderResult(GENERAL, 1, 1, "x:flash");
    };
    assert.deepEqual(await executor.prepareSkills("missing", folder(), []), ["fakesim"]);
    assert.deepEqual(actions, network ? ["search", "generate"] : ["generate"]);
  }
});

test("a public skill is only a reference for this machine's skill", async () => {
  settings.skill_reuse_first = true;
  skills.places.source = join(folder(), "empty");
  const db = new Database(join(folder(), "t.db"));
  task(db, "online", true);
  const executor = new Executor(db, new Machine(), MODELS);
  const searched: string[][] = [];
  const prompts: string[] = [];
  executor.available = onlyFakesim;
  skillDiscovery.deps.discover = async (tools: string[]) => {
    searched.push(tools);
    const skill = skills.parse(GENERAL.replace("Compile with", "Public: compile with"))!;
    skill.source_url = "https://github.com/example/skills/blob/main/SKILL.md";
    skill.source_revision = "b".repeat(40);
    return { skill, reason: "" };
  };
  executor.complete = async (_run, _node, modelId, prompt) => {
    prompts.push(prompt);
    return new ProviderResult("---\nname: fakesim\ndescription: here\ntools: [fakesim]\n---\n# Here\n", 1, 1, modelId);
  };
  assert.deepEqual(await executor.prepareSkills("online", folder(), []), ["fakesim"]);
  assert.ok(prompts[0].includes("Public: compile with") && prompts[0].includes("not checked on this machine"));
  // The step is given this machine's skill, never the public one.
  assert.deepEqual(skills.forStep("fakesim -c a.sv").map((s) => s.machine), [true]);
  // The cached public skill is the reference next time, without another search.
  for (const name of readdirSync(skills.machineDir())) rmSync(join(skills.machineDir(), name, "SKILL.md"), { force: true });
  assert.deepEqual(await executor.prepareSkills("online", folder(), []), ["fakesim"]);
  assert.ok(searched.length === 1 && prompts[1].includes("Public: compile with"));
});

test("the deadline for writing a skill does not hold up the task's start", async () => {
  Object.assign(settings, { skill_reuse_first: true, skill_preparation_timeout: 0.01 });
  skills.places.source = join(folder(), "empty");
  const db = new Database(join(folder(), "t.db"));
  task(db, "timeout");
  const executor = new Executor(db, new Machine(), MODELS);
  const cancelled: boolean[] = [];
  executor.available = onlyFakesim;
  executor.writeSkill = async (_run, _workspace, _name, _tools, _general, _checks, signal) => {
    await new Promise<void>((_, fail) => signal!.addEventListener("abort", () => {
      cancelled.push(true);
      fail(signal!.reason);
    }));
    return "";
  };
  assert.deepEqual(await executor.prepareSkills("timeout", folder(), []), []);
  assert.deepEqual(cancelled, [true]);
  const event = db.events("timeout").filter((e) => e.kind === "run.skills_prepared").at(-1)!;
  assert.ok((event.data as Record<string, unknown[]>).failed.length);
});

test("the skill is prepared once and given to the steps", needsBwrap, async () => {
  Object.assign(settings, { preflight: true, review_nodes: false });
  const tools = environment.prepare();
  for (const name of ["fakesim", "fakerep"]) {
    writeFileSync(join(tools, "bin", name), "#!/bin/sh\necho fake 1.0\n");
    chmodSync(join(tools, "bin", name), 0o755);
  }
  const db = new Database(join(folder(), "t.db"));
  const machine = new Machine();
  const executor = new Executor(db, machine, MODELS);
  task(db, "first");
  await executor.execute("first");
  const first = db.getRun("first")!;
  assert.ok(first.status === "succeeded");
  assert.deepEqual(first.preflight!.skills, ["fake-sim"]);
  const [prompt, ...more] = machine.skillPrompts;
  assert.equal(more.length, 0);
  assert.ok(prompt.includes("fakesim --version") && prompt.includes("Compile with `fakesim -c`")); // what was checked, the general skill
  const saved = readFileSync(join(skills.machineDir(), "fake-sim", "SKILL.md"), "utf8");
  assert.ok(saved.includes("source env.sh") && saved.includes("fakerep"));
  assert.ok(machine.stepPrompts[0].includes("source env.sh"));
  // The next task on this machine uses it as it is.
  task(db, "second");
  await executor.execute("second");
  assert.equal(machine.skillPrompts.length, 1);
  assert.deepEqual(db.getRun("second")!.preflight!.skills, ["fake-sim"]);
  const scratch = existsSync(settings.workspace_root) ? readdirSync(settings.workspace_root).flatMap((name) => {
    try {
      return readdirSync(join(settings.workspace_root, name)).filter((entry) => entry.startsWith(".skill-"));
    } catch {
      return [];
    }
  }) : [];
  assert.deepEqual(scratch, []); // the scratch folder is gone
});
