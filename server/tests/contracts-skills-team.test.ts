// contracts.ts, skills.ts, capabilities.ts and team.ts: tests from test_activity, test_safety,
// test_packages, test_capabilities, test_skills, test_skill_discovery and test_team, ported.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import * as capabilities from "../src/capabilities.js";
import { settings } from "../src/config.js";
import * as contracts from "../src/contracts.js";
import { ArtifactSchema, EmployeeSchema, ExecutionRunSchema, ModelProfileSchema, NodeAttemptSchema, TaskNodeSchema, TaskPlanSchema } from "../src/models.js";
import * as diagnosis from "../src/diagnosis.js";
import * as progress from "../src/progress.js";
import * as quality from "../src/quality.js";
import { NoEligibleModelError } from "../src/routing.js";
import * as skills from "../src/skills.js";
import * as team from "../src/team.js";

const saved = { data_dir: settings.data_dir, workspace_root: settings.workspace_root, database_path: settings.database_path,
  contract_call_floors: settings.contract_call_floors };
let folder = "";
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "batch3-"));
  settings.data_dir = join(folder, "data");
  settings.workspace_root = join(folder, "workspaces");
});
afterEach(() => {
  Object.assign(settings, saved);
  skills.places.source = skills.SOURCE;
});
const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

const contract = (maxTurns: number, difficulty = "hard") => ({ difficulty, artifact_contract: {
  inputs: [], outputs: [{ path: "rtl/fifo.sv" }], acceptance_commands: ["true"], blocked_when: ["no vcs"], max_turns: maxTurns, max_cost_usd: 0.3 } });

test("a tight limit is raised to the floor for its difficulty, with its cost", async () => {
  settings.contract_call_floors = true;
  const raised = contracts.declarations(contract(30)).artifact_contract as any;
  assert.deepEqual([raised.max_turns, raised.max_cost_usd], [80, 0.8]);
  const kept = contracts.declarations(contract(100)).artifact_contract as any;
  assert.deepEqual([kept.max_turns, kept.max_cost_usd], [100, 0.3]);
  assert.equal((contracts.declarations(contract(5, "easy")).artifact_contract as any).max_turns, 20);
});

test("the contract prompt puts the deliverables first", async () => {
  const node = TaskNodeSchema.parse({ id: "n", title: "t", instructions: "i", capability: "coding", ...contracts.declarations(contract(80)) });
  node.contract_tool_calls = 12;
  const text = contracts.prompt(node);
  assert.ok(text.includes("Write every declared output first (rtl/fifo.sv)") && text.includes("12 of 80 tool calls") && text.includes("not yours"));
});

test("unknown and incomplete tools are not reported as failures or old answers", async () => {
  const old = NodeAttemptSchema.parse({ outcome: "rejected", result: "old answer", result_source: "provider" });
  const latest = NodeAttemptSchema.parse({ outcome: "error", tool_calls: [{ turn: 0, tool: "command", detail: "unknown check" },
    { turn: 0, tool: "command", detail: "unfinished check", status: "incomplete" }] });
  const node = TaskNodeSchema.parse({ id: "n", title: "t", instructions: "i", capability: "coding", result: "old answer", attempts: [old, latest] });
  const run = ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "failed", budget_usd: 1, plan: { summary: "s", nodes: [node] } });
  const history = diagnosis.history(run, []).join("\n");
  assert.ok(!history.includes("Last result:") && history.includes("attempt 1 result") && history.includes("attempt 2 result: unknown"));
  const summary = diagnosis.toolSummary(run.plan.nodes[0].attempts[1], true);
  assert.ok(!summary.includes("failed") && summary.includes("unknown") && summary.includes("incomplete"));
  const notes = quality.attemptNotes(run.plan.nodes[0]);
  assert.ok(notes.includes("unknown: unknown check") && notes.includes("incomplete: unfinished check"));
  const lines = progress.logLines(run.plan.nodes[0].attempts[1].tool_calls).join("\n");
  assert.ok(lines.includes("unknown") && lines.includes("incomplete") && !lines.includes("failed"));
});

for (const [title, files] of [["实现 URG 文本解析及内容验收器", ["scripts/parse_report.py", "tests/test_parse_report.py"]],
  ["编写 URG 复现和报告追溯说明", ["docs/reproduce.md"]]] as [string, string[]][]) {
  test(`report preparation is not report production: ${title}`, async () => {
    const node = TaskNodeSchema.parse({ id: "helper", title, instructions: "Prepare the helper and test it with fixtures.",
      capability: "coding", files, acceptance_criteria: "Unit tests pass." });
    assert.deepEqual(contracts.stages(node), new Set());
    assert.deepEqual(contracts.nodeProblems(node, { coverage: true }), []);
  });
}

for (const unsafe of ["../outside.txt", "/tmp/outside.txt", ".env", ".git/config", "secrets.json", ".fluidform/tasks.db"]) {
  test(`artifact paths cannot read private or outside files: ${unsafe}`, async () => {
    assert.throws(() => contracts.fingerprint(folder, ArtifactSchema.parse({ path: unsafe })), contracts.ArtifactBlocked);
  });
}

test("an artifact folder does not follow links out of it", async () => {
  const root = join(folder, "work");
  mkdirSync(join(root, "coverage.vdb"), { recursive: true });
  writeFileSync(join(folder, "outside"), "outside");
  symlinkSync(join(folder, "outside"), join(root, "coverage.vdb", "link"));
  assert.throws(() => contracts.fingerprint(root, ArtifactSchema.parse({ path: "coverage.vdb", kind: "directory" })), /符号链接/);
});

test("an artifact folder records links within itself without following them", async () => {
  // VCS links shared files across the tests of a coverage database.
  const root = join(folder, "work");
  const common = join(root, "fifo.vdb", "common");
  const seed = join(root, "fifo.vdb", "testdata", "seed1");
  mkdirSync(common, { recursive: true });
  mkdirSync(seed, { recursive: true });
  writeFileSync(join(common, "shape.xml"), "<shape/>");
  symlinkSync("../../common/shape.xml", join(seed, "shape.xml"));
  const vdb = ArtifactSchema.parse({ path: "fifo.vdb", kind: "directory" });
  const before = contracts.fingerprint(root, vdb);
  unlinkSync(join(seed, "shape.xml"));
  symlinkSync("../../common/other.xml", join(seed, "shape.xml"));
  assert.notEqual(contracts.fingerprint(root, vdb), before); // where a link points is part of the evidence
  symlinkSync("../../../", join(seed, "escape"));
  assert.throws(() => contracts.fingerprint(root, vdb), /符号链接/);
});

test("artifact checks cannot read the platform's own data, whatever it is called", async () => {
  settings.data_dir = join(folder, "private-store");
  settings.workspace_root = join(folder, "all-jobs");
  settings.database_path = join(folder, "hidden.sqlite");
  for (const name of ["private-store/evidence.txt", "all-jobs/another-task/report.txt", "hidden.sqlite", "hidden.sqlite-wal"]) {
    write(join(folder, name), "private-data");
    assert.throws(() => contracts.fingerprint(folder, ArtifactSchema.parse({ path: name })), /平台/, name);
  }
  const own = join(settings.workspace_root, "this-task");
  write(join(own, "report.txt"), "own evidence");
  assert.ok(contracts.fingerprint(own, ArtifactSchema.parse({ path: "report.txt" })));
});

test("a key file is refused for holding a key, not for its name", async () => {
  // VCS writes ucli.key, a log of simulator commands, into every run directory.
  const run = join(folder, "artifacts", "run1");
  write(join(run, "sim.log"), "PASS");
  write(join(run, "ucli.key"), "run\nquit\n");
  const artifacts = ArtifactSchema.parse({ path: "artifacts", kind: "directory" });
  assert.ok(contracts.fingerprint(folder, artifacts));
  write(join(run, "server.key"), "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n");
  assert.throws(() => contracts.fingerprint(folder, artifacts), /私钥/);
});

const CARD = { name: "飞书发消息", kind: "tool", summary: "向飞书群发一条消息。", usage: "python send.py --chat <id> --text <内容>",
  guide: "- 群 ID 在飞书群设置里\n- 一条消息最多 4000 字", files: ["feishu"], check: "python3 feishu/send.py --help",
  secrets: ["FEISHU_APP_ID", "FEISHU_APP_SECRET"], domains: ["open.feishu.cn"] };

test("the lead's capability cards are read carefully", async () => {
  const text = "这样吧：\n```json\n" + JSON.stringify({ capabilities: [CARD, { ...CARD, name: "无文件", files: [] },
    { ...CARD, name: "x", kind: "daemon" }, { ...CARD, name: "y" }, { ...CARD, name: "z" }] }) + "\n```";
  const cards = capabilities.readCards(text);
  // Nothing to keep without files; an unknown kind is a tool; at most three.
  assert.deepEqual(cards.map((card) => [card.name, card.kind]), [["飞书发消息", "tool"], ["x", "tool"], ["y", "tool"]]);
  assert.deepEqual(cards[0].secrets, ["FEISHU_APP_ID", "FEISHU_APP_SECRET"]);
  assert.equal(cards[0].status, "proposed");
  assert.ok(cards[0].guide.includes("群 ID") && capabilities.PROMPT.includes('"guide"'));
  assert.deepEqual(capabilities.readCards("没有"), []);
  assert.deepEqual(capabilities.readCards('{"capabilities": []}'), []);
});

test("a skill may carry a line for the user, and old ones still load", async () => {
  const withLine = skills.parse("---\nname: x\ndescription: Using x.\nsummary: 怎么用 x\ntools: [x]\n---\n# x\n")!;
  assert.deepEqual([withLine.description, withLine.summary, withLine.tools], ["Using x.", "怎么用 x", ["x"]]);
  assert.equal(skills.parse("---\nname: y\ndescription: Using y.\n---\n# y\n")!.summary, "");
});

test("invalid cached provenance cannot break skill loading", async () => {
  const root = join(settings.data_dir, "skills-discovered", "bad");
  write(join(root, "SKILL.md"), "---\nname: demo-tool\ndescription: Use demo-tool\n---\n# Usage\nRun `demo-tool --check`.\n");
  writeFileSync(join(root, "source.json"), JSON.stringify({ source_url: ["bad"] }));
  assert.ok(!skills.discovered().some((skill) => skill.path === join(root, "SKILL.md")));
});

const GENERAL = "---\nname: fake-sim\ndescription: Drive the fake simulator.\ntools: [fakesim, fakerep]\n---\n# Fake simulator\nCompile with `fakesim -c`.\n";
const LESSON = "---\nname: fake-sim-lesson\ndescription: seeds\ntools: [fakesim]\n---\nPass `+seed=N` or runs repeat.\n";
function library(): void {
  const source = join(folder, "source");
  write(join(source, "fake-sim", "SKILL.md"), GENERAL);
  skills.places.source = source;
}

test("a skill is read and matched by the tools a step names", async () => {
  library();
  const [general] = skills.library();
  assert.deepEqual([general.name, general.tools, general.machine], ["fake-sim", ["fakesim", "fakerep"], false]);
  assert.deepEqual(skills.forStep("Run FAKESIM on the RTL").map((skill) => skill.name), ["fake-sim"]);
  assert.deepEqual(skills.forStep("fakesimulator, /opt/fakesim-2/bin"), []); // other words, a path
  skills.saveMachine("fake-sim", GENERAL.replace("# Fake simulator", "# Here: source env.sh first"));
  const [mine, theirs] = skills.forStep("fakesim -c a.sv");
  assert.ok(mine.machine && !theirs.machine); // this machine's first
  assert.ok(skills.section([mine, theirs]).includes("this machine's are right"));
});

test("a step is given the skills for the tools it uses", async () => {
  library();
  const run = ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "queued", budget_usd: 1, plan: { summary: "s", nodes: [] } });
  const sim = TaskNodeSchema.parse({ id: "a", title: "编译", instructions: "用 fakesim 编译并运行", capability: "coding" });
  const doc = TaskNodeSchema.parse({ id: "b", title: "文档", instructions: "写 README", capability: "coding" });
  assert.ok(quality.nodePrompt(sim, run, 4000)[0].includes("Skill: fake-sim"));
  assert.ok(!quality.nodePrompt(doc, run, 4000)[0].includes("Skill:"));
});

test("a lesson is written into this machine's skill and taken out again", async () => {
  library();
  const original = GENERAL.replace("# Fake simulator", "# Here: source env.sh first");
  const path = skills.saveMachine("fake-sim", original);
  assert.deepEqual(skills.addLesson("l1", "Seeds", LESSON, ["fakesim"]), [path]);
  skills.addLesson("l2", "Licence", LESSON.replace("Pass `+seed=N` or runs repeat.", "Wait for the licence."), ["fakesim"]);
  const [mine] = skills.forStep("fakesim -c a.sv");
  assert.ok(mine.body.indexOf("Wait for the licence") < mine.body.indexOf("+seed=N") && mine.body.indexOf("+seed=N") < mine.body.indexOf("source env.sh"));
  assert.ok(skills.section([mine]).includes("Pass `+seed=N`"));
  skills.removeLesson("l2");
  skills.removeLesson("l1");
  assert.equal(readFileSync(path, "utf8"), original);
});

test("a skill made of a lesson alone goes with it", async () => {
  library();
  const [path] = skills.addLesson("l1", "Seeds", LESSON, ["fakesim"]);
  assert.ok(skills.forStep("fakesim")[0].machine && readFileSync(path, "utf8").includes("+seed=N"));
  skills.removeLesson("l1");
  assert.ok(!existsSync(path) && !skills.library().some((skill) => skill.machine));
});

test("the GitHub reference skill reaches steps and employees that look on GitHub", async () => {
  const [guide] = skills.library().filter((skill) => skill.name === "github-reference");
  assert.deepEqual(new Set(guide.tools), new Set(["github", "gh"]));
  assert.ok(!guide.machine && guide.body.length <= skills.MAX_SKILL_CHARS); // given whole, not cut off
  for (const rule of ["gh_rank.py", "never run its scripts", "REFERENCE: OWNER/REPO@SHA", "license"]) assert.ok(guide.body.includes(rule), rule);
  assert.ok(skills.forStep("在 GitHub 上找一个成熟的 JSON 解析库作为参考实现").some((skill) => skill.name === guide.name));
  assert.ok(!skills.forStep("写 README 并整理目录").some((skill) => skill.name === guide.name));
  const plan = TaskPlanSchema.parse({ summary: "s", nodes: [], employees: [{ id: "dev", name: "开发", role: "实现解析器", model_id: "test:m",
    capabilities: ["coding"], skills: ["github-reference"] }] });
  team.refreshSkills(plan);
  assert.ok(plan.employees[0].skill_context.includes("Skill: github-reference"));
});

const employees = () => [
  EmployeeSchema.parse({ id: "builder", name: "开发", role: "实现模块并集成", model_id: "test:build", capabilities: ["coding"] }),
  EmployeeSchema.parse({ id: "tester", name: "验证", role: "独立检验", model_id: "test:verify", capabilities: ["coding", "research"] }),
];
const runWithTeam = () => ExecutionRunSchema.parse({ id: "team-run", prompt: "完成完整模块，保留兼容性", budget_usd: 10, status: "queued",
  plan: { summary: "module", nodes: [{ id: "parent", title: "实现模块", instructions: "build", capability: "coding", files: ["app.py"],
    employee_id: "builder", model_id: "test:build" }], employees: employees(), team_brief: "接口不变；通过独立验证才交付" } });

test("an employee's context carries the whole goal, the agreements and accepted earlier work", async () => {
  const run = runWithTeam();
  run.plan.nodes.push(TaskNodeSchema.parse({ id: "earlier", title: "设计", instructions: "design", capability: "coding", employee_id: "builder",
    status: "succeeded", result: "已确认接口 version=1", provides: "parse(data)" }));
  const [prompt] = quality.nodePrompt(run.plan.nodes[0], run, 1000);
  for (const part of [run.prompt, run.plan.team_brief, "已确认接口 version=1", "tester", "DELEGATE_TASKS"]) assert.ok(prompt.includes(part), part);
});

test("an employee's context bounds a large file inventory without losing pending decisions", async () => {
  const run = runWithTeam();
  const node = run.plan.nodes[0];
  node.acceptance_criteria = "真实覆盖率达到100%，由负责人最终整体验收";
  const pending = "1,889 项候选尚未批准；APB16、AXI16/512/1024、地址12及33–64的参数范围待裁定";
  const inventory = Array.from({ length: 18000 }, (_, i) => `coverage/run.vdb/snps/coverage/db/test-${String(i).padStart(6, "0")}-` + "x".repeat(70));
  assert.ok(JSON.stringify(inventory).length > 2_000_000);
  run.plan.nodes.push(TaskNodeSchema.parse({ id: "bridge", title: "桥交付", instructions: "bridge", capability: "coding", employee_id: "builder",
    status: "blocked", changed_files: inventory, files: ["coverage/run.vdb", "reports/decisions.md"], result: "检查记录\n".repeat(1000) + pending,
    feedback: pending }));
  const before = JSON.stringify(run);
  const [prompt] = quality.nodePrompt(node, run, 1000);
  assert.ok(prompt.length < 40_000);
  for (const required of [run.prompt, run.plan.team_brief, node.instructions, node.acceptance_criteria, pending, "coverage/run.vdb",
    "reports/decisions.md", '"file_count": 18000', '"status": "blocked"']) assert.ok(prompt.includes(required), required);
  assert.equal(JSON.stringify(run), before);
});

test("a named skill is carried even when the task does not mention its tool", async () => {
  const run = runWithTeam();
  run.plan.employees[0].skills = ["special-guide"];
  team.refreshSkills(run.plan, [{ name: "special-guide", description: "guide", tools: ["special"], summary: "", body: "verified invocation procedure",
    path: null, machine: false, source_url: "", source_revision: "", text: "" }]);
  assert.ok(quality.nodePrompt(run.plan.nodes[0], run, 1000)[0].includes("verified invocation procedure"));
});

test("the lead's assignment stands when its own bar is above the employee's model", async () => {
  const catalog = ["build", "verify"].map((name) => ModelProfileSchema.parse({ id: `test:${name}`, provider: "test", display_name: name,
    scores: Object.fromEntries(["coding", "planning", "research", "chinese", "tool_use", "structured_output", "reliability"].map((key) => [key, 95])),
    scores_source: "artificial_analysis", context_window: 200000, max_output_tokens: 4096, input_per_million: 1, output_per_million: 1, supports_tools: true }));
  catalog[0].scores!.coding = 85.8; // the builder's model; the verifier's stays at 95
  const run = runWithTeam();
  const node = run.plan.nodes[0];
  node.quality_threshold = 90;
  await team.route(node, run.plan, catalog, new Set(catalog.map((model) => model.id)));
  assert.deepEqual([node.model_id, node.quality_threshold], ["test:build", 85.8]);
  assert.ok(node.routing_note!.includes("门槛从 90 调到该模型的 85.8"));
  await assert.rejects(team.route(node, run.plan, catalog, new Set(["test:verify"])),
    (error: Error) => error instanceof NoEligibleModelError && error.message.includes("开发")); // a model that cannot run still needs the lead
});
