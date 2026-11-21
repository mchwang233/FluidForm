// preflight.ts's checks and prompts: their tests in test_preflight, test_quick and test_skills, ported.
// The tests of the check inside the executor come with the executor.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { settings } from "../src/config.js";
import { ExecutionRunSchema, PreflightCheckSchema, TaskNodeSchema } from "../src/models.js";
import * as preflight from "../src/preflight.js";
import * as skills from "../src/skills.js";

const saved = { ...settings };
const savedSource = skills.places.source;
const savedHome = process.env.CODEX_HOME;
let folder: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "preflight-"));
  process.env.CODEX_HOME = join(folder, "codex-home"); // conftest.own_codex_home
  Object.assign(settings, { preflight: true, review_nodes: false, workspace_root: join(folder, "workspaces"), data_dir: join(folder, "data") });
});
afterEach(() => {
  Object.assign(settings, saved);
  skills.places.source = savedSource;
  if (savedHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedHome;
});

const MISSING = "command -v no-such-tool-for-preflight";
const uid = process.getuid!();
const task = (requires: string[], network = false, plan: Record<string, unknown> = {}) =>
  ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "queued", budget_usd: 1, allow_network: network, plan: { summary: "s", nodes: [], requires, ...plan } });

/** Codex's own sandbox, where ``missing`` is not found. */
function codexSandbox({ missing = [] as string[], unusable = false, output = null as string | null } = {}) {
  return {
    commands: [] as string[],
    async sandboxRun(_modelId: string, command: string): Promise<[string, boolean]> {
      this.commands.push(command);
      if (unusable) return ["error: unrecognized subcommand 'sandbox'", false];
      if (command === preflight.CLI_SANDBOX_COMMAND) return [output ?? `sp-write\n${uid}`, true];
      return missing.some((tool) => command.includes(tool)) ? ["Exit code 1", false] : ["ok", true];
    },
  };
}

test("the tools checked are the lead's and those the checks call", () => {
  const node = TaskNodeSchema.parse({ id: "n", title: "t", instructions: "i", capability: "coding", files: ["sim/run.sh"],
    check: "cd sim && iverilog -g2012 -o a tb.v && ./run.sh && make test" });
  // The lead's commands block; a program a check calls only warns (the task may build it), and the
  // task's own script and what the lead already named are left out.
  assert.deepEqual(preflight.toolCommands(task(["vcs -ID", "make --version"], false, { nodes: [node] })),
    [["vcs -ID", true], ["make --version", true], ["command -v iverilog", false]]);
});

test("a working sandbox and tool pass, and a missing tool fails", async () => {
  const checks = await preflight.sandboxChecks(task(["sh -c 'exit 0'", MISSING]), folder);
  assert.deepEqual(checks.map((item) => item.ok), [true, true, false], JSON.stringify(checks, null, 1));
  assert.ok(checks[0].name.startsWith("步骤沙箱") && checks[2].output.includes("Exit code 1"));
});

test("the repair is told what failed and how steps run", () => {
  const run = ExecutionRunSchema.parse({ id: "r", prompt: "写 FIFO", status: "queued", budget_usd: 1, allow_network: false, plan: { summary: "s", nodes: [] } });
  const failed = [PreflightCheckSchema.parse({ name: "工具", command: "vcs -ID", ok: false, output: "vcs: command not found" })];
  const prompt = preflight.repairPrompt(run, failed, join(folder, "w"), join(folder, "tools"));
  assert.ok(prompt.includes("vcs -ID") && prompt.includes("vcs: command not found") && prompt.includes("no network"));
  assert.ok(prompt.includes(`${join(folder, "tools")}/bin`) && prompt.includes("STATUS: FIXED"));
});

test("the tools are checked in Codex's own sandbox too", async () => {
  const cli = codexSandbox({ missing: ["vcs"] });
  const checks = await preflight.cliChecks(cli, task(["vcs -ID", "make --version"]), folder, new Set(["cli:codex", "x:flash"]));
  assert.deepEqual(checks.map((c) => [c.command, c.ok, c.blocking]), [["(内置)", true, true], ["vcs -ID", false, true], ["make --version", true, true]]);
  assert.ok(checks.every((c) => c.name.startsWith("Codex 沙箱")));
  // Not when Codex cannot run the task's steps.
  assert.deepEqual(await preflight.cliChecks(cli, task(["vcs -ID"]), folder, new Set(["x:flash"])), []);
});

test("an old Codex, or the internet, is only a warning", async () => {
  const [old] = await preflight.cliChecks(codexSandbox({ unusable: true }), task(["vcs -ID"]), folder, new Set(["cli:codex"]));
  assert.ok(!old.ok && !old.blocking);
  const checks = await preflight.cliChecks(codexSandbox(), task([], true), folder, new Set(["cli:codex"]));
  assert.ok(!checks.at(-1)!.blocking && checks.at(-1)!.name.includes("互联网"));
});

test("a shell unable to read the hidden home's startup files still passes", async () => {
  // Regression: "bash: ~/.bashrc: Permission denied" (the home is hidden on purpose) failed the check.
  const noisy = `/bin/bash: /home/u/.bashrc: Permission denied\nbash: /home/u/.bash_profile: No such file or directory\nsp-write\n${uid}`;
  let [check] = await preflight.cliChecks(codexSandbox({ output: noisy }), task([]), folder, new Set(["cli:codex"]));
  assert.ok(check.ok);
  // Anything else printed still fails it.
  [check] = await preflight.cliChecks(codexSandbox({ output: `something else\nsp-write\n${uid}` }), task([]), folder, new Set(["cli:codex"]));
  assert.ok(!check.ok);
  assert.equal(preflight.withoutShellNoise("bash: /etc/x: Permission denied\nok"), "bash: /etc/x: Permission denied\nok");
});

test("a failed check is not remembered", () => {
  settings.preflight_cache_minutes = 60;
  preflight.PASSED.clear();
  const run = task([], false, { nodes: [{ id: "n", title: "t", instructions: "i", capability: "coding" }] });
  assert.equal(preflight.passedBefore(preflight.cacheKey(run)), null);
});

const GENERAL = "---\nname: fake-sim\ndescription: Drive the fake simulator.\ntools: [fakesim, fakerep]\n---\n# Fake simulator\nCompile with `fakesim -c`.\n";

test("the tools to prepare are the special ones the task names", () => {
  const source = join(folder, "source");
  mkdirSync(join(source, "fake-sim"), { recursive: true });
  writeFileSync(join(source, "fake-sim", "SKILL.md"), GENERAL);
  skills.places.source = source;
  const run = ExecutionRunSchema.parse({ id: "r", prompt: "用 fakerep 出报告", status: "queued", budget_usd: 1, plan: { summary: "s", nodes: [],
    requires: ["make --version", "command -v other-tool"], parts: [{ id: "p", title: "仿真", goal: "fakesim 回归" }] } });
  const tools = preflight.neededTools(run, skills.library());
  assert.deepEqual(tools, ["other-tool", "fakesim", "fakerep"]); // not make: every step knows it
  const groups = preflight.toolGroups(tools, skills.library());
  assert.deepEqual(groups.map(([name, names]) => [name, names]), [["fake-sim", ["fakesim", "fakerep"]], ["other-tool", ["other-tool"]]]);
  assert.ok(preflight.withTools(GENERAL, ["x"]).includes("tools: [fakesim, fakerep, x]"));
});
