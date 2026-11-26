// Steps in their own files and folders running together: tests/test_scopes.py, ported.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { settings } from "../src/config.js";
import type { Database } from "../src/db.js";
import { Executor } from "../src/executor.js";
import { TaskNodeSchema } from "../src/models.js";
import { ProviderResult } from "../src/providers.js";
import * as quality from "../src/quality.js";
import { sleep } from "../src/tasks.js";
import { conftest } from "./helpers/conftest.js";
import { leadDatabase, MODELS } from "./helpers/lead-run.js";

const { folder } = conftest();
let database: Database;
beforeEach(() => {
  database = leadDatabase(folder());
  settings.lead_decisions = false;
});

/** Each step writes its file and waits a moment; records how many ran at once. */
class Team {
  now = 0;
  most = 0;
  constructor(readonly root: string) {}

  configuredModels(ids: Iterable<string>) {
    return new Set(ids);
  }

  async complete(modelId: string, prompt: string, _options: object = {}): Promise<ProviderResult> {
    this.now += 1;
    this.most = Math.max(this.most, this.now);
    const name = prompt.split("写 ")[1].split(/\s/)[0];
    writeFileSync(join(this.root, name), "done\n");
    await sleep(0.05);
    this.now -= 1;
    return new ProviderResult("做完了", 0, 0, modelId);
  }
}

/** a takes a while; b, which waits for a, sets up its testbench in the meantime. */
class Early extends Team {
  prompts: string[] = [];
  seen: Record<string, string> = {};

  override async complete(modelId: string, prompt: string, options: object = {}): Promise<ProviderResult> {
    this.prompts.push(prompt);
    if (prompt.includes("HEAD START")) {
      this.seen.a = database.getRun("r")!.plan.nodes.find((node) => node.id === "a")!.status;
      writeFileSync(join(this.root, "tb", "tb.sv"), "testbench\n");
      return new ProviderResult("搭好了 tb/tb.sv，只差接上 a 的模块", 0, 0, modelId);
    }
    if (prompt.includes("写 a.sv")) await sleep(0.1);
    return super.complete(modelId, prompt, options);
  }
}

/** a also rewrites spec.txt, which b reads, while b is at work; only on its first try. */
class Intruding extends Team {
  tries = 0;
  override async complete(modelId: string, prompt: string, options: object = {}): Promise<ProviderResult> {
    if (prompt.includes("写 a.sv")) {
      this.tries += 1;
      if (this.tries === 1) writeFileSync(join(this.root, "spec.txt"), "changed\n");
    }
    return super.complete(modelId, prompt, options);
  }
}

function project(steps: [string, string, string[]][], folders = false): string {
  const root = join(folder(), "proj");
  mkdirSync(root);
  writeFileSync(join(root, "README.md"), "# p\n");
  const run = database.getRun("r")!;
  run.project_dir = root;
  run.plan.nodes = steps.map(([key, name, paths]) => TaskNodeSchema.parse({ id: key, title: key, instructions: `写 ${name}`, capability: "coding", model_id: "x:api",
    needs_workspace: true, [folders ? "folders" : "files"]: paths }));
  database.saveRun(run);
  return root;
}

function waitingProject(bFolders: string[]): string {
  const root = project([["a", "rtl/a.sv", ["rtl/"]], ["b", "tb/b.sv", bFolders]], true);
  mkdirSync(join(root, "rtl"));
  mkdirSync(join(root, "tb"));
  const run = database.getRun("r")!;
  run.plan.nodes[1].dependencies = ["a"];
  database.saveRun(run);
  return root;
}

const nodeKinds = (nodeId: string) => database.events("r").filter((event) => (event.data as Record<string, unknown>).node_id === nodeId).map((event) => event.kind);

test("packages with their own files run together and keep their own changes", async () => {
  const team = new Team(project([["a", "a.css", ["a.css"]], ["b", "b.js", ["b.js"]]]));
  await new Executor(database, team, MODELS).execute("r");
  assert.equal(team.most, 2);
  assert.deepEqual(database.getRun("r")!.plan.nodes.map((node) => node.changed_files), [["a.css"], ["b.js"]]);
});

test("steps without a scope take turns", async () => {
  const team = new Team(project([["a", "a.css", []], ["b", "b.js", ["b.js"]]]));
  await new Executor(database, team, MODELS).execute("r");
  assert.equal(team.most, 1);
});

test("a step waiting for the folder shows as queued, and its time starts when it gets in", async () => {
  const root = project([["a", "a.css", []], ["b", "b.js", []]]);
  const seen: Record<string, [string, boolean, string | null]> = {};
  class Watching extends Team {
    override async complete(modelId: string, prompt: string, options: object = {}): Promise<ProviderResult> {
      if (prompt.split("写 ")[1].split(/\s/)[0] === "a.css") {
        await sleep(0.05); // let b reach the folder lock
        const other = database.getRun("r")!.plan.nodes.find((node) => node.id === "b")!;
        seen.b = [other.status, other.waiting_for_folder, other.started_at];
      }
      return super.complete(modelId, prompt, options);
    }
  }
  await new Executor(database, new Watching(root), MODELS).execute("r");
  const [status, waiting, queuedAt] = seen.b;
  assert.deepEqual([status, waiting], ["running", true]);
  const after = database.getRun("r")!.plan.nodes.find((node) => node.id === "b")!;
  assert.ok(!after.waiting_for_folder && after.started_at! > queuedAt!);
  const kinds = nodeKinds("b");
  assert.ok(kinds.indexOf("node.queued") < kinds.indexOf("node.dequeued") && kinds.includes("node.queued"));
});

test("steps owning different folders run together and keep their own changes", async () => {
  const root = project([["a", "core/a.sv", ["core/"]], ["b", "periph/b.sv", ["periph/"]]], true);
  mkdirSync(join(root, "core"));
  mkdirSync(join(root, "periph"));
  const team = new Team(root);
  await new Executor(database, team, MODELS).execute("r");
  assert.equal(team.most, 2);
  assert.deepEqual(database.getRun("r")!.plan.nodes.map((node) => node.changed_files), [["core/a.sv"], ["periph/b.sv"]]);
});

test("steps owning nested folders take turns", async () => {
  const root = project([["a", "rtl/a.sv", ["rtl/"]], ["b", "rtl/core/b.sv", ["rtl/core/"]]], true);
  mkdirSync(join(root, "rtl", "core"), { recursive: true });
  const team = new Team(root);
  await new Executor(database, team, MODELS).execute("r");
  assert.equal(team.most, 1);
});

test("a step owning folders is told to write only there", () => {
  const node = TaskNodeSchema.parse({ id: "a", title: "a", instructions: "写核", capability: "coding", folders: ["rtl/core/"] });
  const [prompt] = quality.nodePrompt(node, database.getRun("r")!, 1000);
  assert.ok(prompt.includes("Your folders: rtl/core/") && prompt.includes("only inside yours"));
});

test("a step waiting for another starts early and finishes with what it did", async () => {
  settings.head_start = true;
  const team = new Early(waitingProject(["tb/"]));
  await new Executor(database, team, MODELS).execute("r");
  const result = database.getRun("r")!;
  const b = result.plan.nodes[1];
  assert.equal(team.seen.a, "running"); // b started while a was at work
  assert.ok(result.status === "succeeded" && b.attempts.length === 1); // the early start is not an attempt
  assert.ok(!b.preparing && b.head_start!.startsWith("搭好了"));
  const final = team.prompts.at(-1)!;
  assert.ok(final.includes("写 tb/b.sv") && !final.includes("HEAD START") && final.includes("只差接上 a 的模块"));
  const kinds = nodeKinds("b");
  assert.ok(kinds.indexOf("node.head_start") >= 0 && kinds.indexOf("node.head_start") < kinds.indexOf("node.head_started") && kinds.indexOf("node.head_started") < kinds.indexOf("node.started"));
});

test("a step without its own folders or files waits without starting early", async () => {
  settings.head_start = true;
  const team = new Early(waitingProject([])); // it could need the whole folder
  await new Executor(database, team, MODELS).execute("r");
  assert.equal(database.getRun("r")!.status, "succeeded");
  assert.ok(!team.prompts.some((prompt) => prompt.includes("HEAD START")) && team.most === 1);
});

test("steps wait for their inputs unless starting early is turned on", async () => {
  const team = new Early(waitingProject(["tb/"]));
  await new Executor(database, team, MODELS).execute("r");
  assert.ok(!team.prompts.some((prompt) => prompt.includes("HEAD START")) && team.most === 1);
});

test("a step whose inputs are in use does not start early", async () => {
  settings.head_start = true;
  const root = waitingProject(["tb/"]);
  const run = database.getRun("r")!;
  Object.assign(run.plan.nodes[1], { files: ["tb/b.sv"], reads: ["rtl/a.sv"], folders: [] }); // it reads what a is writing
  database.saveRun(run);
  const team = new Early(root);
  await new Executor(database, team, MODELS).execute("r");
  const result = database.getRun("r")!;
  assert.ok(result.status === "succeeded" && result.plan.nodes[1].attempts.length === 1);
  // It neither waited for the folder in a head start nor held a place while a worked.
  assert.ok(!team.prompts.some((prompt) => prompt.includes("HEAD START")) && team.most === 1);
});

test("a step that changes what a step alongside reads does not pass", async () => {
  const root = project([["a", "a.sv", ["a.sv"]], ["b", "b.sv", ["b.sv"]]]);
  writeFileSync(join(root, "spec.txt"), "spec\n");
  const run = database.getRun("r")!;
  run.plan.nodes[1].reads = ["spec.txt"];
  database.saveRun(run);
  const team = new Intruding(root);
  await new Executor(database, team, MODELS).execute("r");
  const result = database.getRun("r")!;
  const a = result.plan.nodes[0];
  assert.equal(team.most, 2);
  assert.ok(a.attempts[0].reason!.includes("改了自己范围外的文件 spec.txt") && a.attempts[0].reason!.includes("「b」"));
  assert.ok(result.status === "succeeded" && a.attempts.length === 2); // its retry stayed in its own files
});

test("a step is credited only with its own folder: not home files, nor what a step alongside wrote beyond its own", async () => {
  const root = project([["a", "core/a.sv", ["core/"]], ["b", "periph/b.sv", ["periph/"]]], true);
  for (const name of ["core", "periph", "sim", ".claude"]) mkdirSync(join(root, name));
  class Noisy extends Team {
    override async complete(modelId: string, prompt: string, options: object = {}): Promise<ProviderResult> {
      if (prompt.includes("写 core/a.sv")) {
        // HOME is the working directory: shells and tools leave their state at its top.
        writeFileSync(join(root, ".bashrc"), "x\n");
        writeFileSync(join(root, ".gitconfig"), "x\n");
        writeFileSync(join(root, ".claude", "settings.json"), "{}\n");
        return super.complete(modelId, prompt, options);
      }
      // b writes beyond its folder and is still at work when a finishes.
      writeFileSync(join(root, "sim", "b.log"), "log\n");
      const result = await super.complete(modelId, prompt, options);
      await sleep(0.15);
      return result;
    }
  }
  const team = new Noisy(root);
  await new Executor(database, team, MODELS).execute("r");
  assert.equal(team.most, 2);
  const [a, b] = database.getRun("r")!.plan.nodes;
  assert.deepEqual(a.changed_files, ["core/a.sv"]);
  assert.deepEqual(b.changed_files, ["periph/b.sv"]);
});
