// projects.ts and briefing.ts: tests/test_projects.py and tests/test_briefing.py, ported.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import * as briefing from "../src/briefing.js";
import * as planningBriefs from "../packages/planning/src/brief.js";
import { settings } from "../src/config.js";
import { ModelProfileSchema } from "../src/models.js";
import * as projects from "../src/projects.js";
import { NativePickerError, ProjectDirError } from "../src/projects.js";
import { ProviderResult } from "../src/providers.js";

const saved = { ...settings };
const env = { ...process.env };
const deps = { ...projects.deps };
let folder: string;
let root: string;
beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), "projects-")));
  // conftest's project_root: the allowed root, with the data folder inside one of its projects.
  root = join(folder, "home");
  mkdirSync(join(root, "app"), { recursive: true });
  Object.assign(settings, { project_roots: [root], data_dir: join(root, "app", ".fluidform"), workspace_root: join(folder, "scratch") });
});
afterEach(() => {
  Object.assign(settings, saved);
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  Object.assign(projects.deps, deps);
  projects.limits.NATIVE_PICKER_TIMEOUT = 300;
});

test("a project folder under a root is accepted", () => {
  assert.equal(projects.resolveProjectDir(`${root}/app/../app`), join(root, "app"));
});

test("bad paths, folders outside the roots and the data folder are rejected", () => {
  assert.throws(() => projects.resolveProjectDir("relative/app"), (e: Error) => e instanceof ProjectDirError && e.message.includes("absolute"));
  assert.throws(() => projects.resolveProjectDir("/nonexistent-fluidform-dir"), /does not exist/);
  assert.throws(() => projects.resolveProjectDir(folder), /allowed root/);
  mkdirSync(settings.data_dir);
  assert.throws(() => projects.resolveProjectDir(settings.data_dir), /data directory/);
});

test("the git snapshot and context describe a repository", () => {
  const repo = join(folder, "repo");
  mkdirSync(repo);
  spawnSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "hi");
  spawnSync("git", ["-C", repo, "add", "."]);
  spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  writeFileSync(join(repo, "new.txt"), "x");
  const snapshot = projects.gitSnapshot(repo) as any;
  assert.ok(snapshot.git && snapshot.branch === "main" && snapshot.uncommitted_files === 1);
  const context = projects.projectContext(repo);
  assert.ok(context.includes("README.md") && context.includes("1 uncommitted"));
  assert.deepEqual(projects.gitSnapshot(folder), { git: false });
});

function makeRepo(path: string, touched: number): string {
  mkdirSync(join(path, ".git"), { recursive: true });
  writeFileSync(join(path, ".git", "HEAD"), "ref: refs/heads/main\n");
  utimesSync(join(path, ".git", "HEAD"), touched, touched);
  return path;
}

test("discovery finds repositories, most recent first", () => {
  const old = makeRepo(join(root, "work", "old"), 1000);
  const fresh = makeRepo(join(root, "work", "new"), 2000);
  makeRepo(join(root, "work", "new", "nested"), 3000); // inside a repo: not listed
  makeRepo(join(root, "web", "node_modules", "pkg"), 4000); // dependency folder
  makeRepo(join(root, ".hidden", "repo"), 5000); // hidden folder
  makeRepo(join(root, "a", "b", "c", "d", "e", "deep"), 6000); // beyond max depth
  makeRepo(join(folder, "outside"), 7000);
  symlinkSync(join(folder, "outside"), join(root, "link")); // symlinks are not followed
  const result = projects.discoverProjects();
  assert.deepEqual(result.projects.map((entry) => entry.path), [fresh, old]);
  assert.ok(result.projects[0].name === "new" && !result.truncated);
});

test("discovery stops at the limit", () => {
  for (let index = 0; index < 5; index += 1) makeRepo(join(root, `repo${index}`), index);
  const result = projects.discoverProjects(projects.DISCOVER_DEPTH, 3);
  assert.ok(result.projects.length === 3 && result.truncated);
});

test("inspecting describes a project and rejects bad paths", () => {
  assert.deepEqual(projects.inspectProject(join(root, "app")), { path: join(root, "app"), git: false });
  assert.throws(() => projects.inspectProject(folder), /allowed root/);
  assert.throws(() => projects.inspectProject(join(root, "missing")), /does not exist/);
});

test("the native picker needs a desktop and zenity", () => {
  delete process.env.DISPLAY;
  delete process.env.WAYLAND_DISPLAY;
  assert.deepEqual(projects.nativePickerStatus(), { available: false, reason: "No desktop session is attached to the API process" });
  process.env.DISPLAY = ":0";
  projects.deps.which = () => null;
  assert.equal(projects.nativePickerStatus().reason, "zenity is not installed");
  projects.deps.which = (name) => `/bin/${name}`;
  assert.deepEqual(projects.nativePickerStatus(), { available: true, reason: null });
});

function fakeZenity(script: string): void {
  writeFileSync(join(folder, "zenity"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(folder, "zenity"), 0o755);
  process.env.PATH = `${folder}:${env.PATH}`;
  process.env.DISPLAY = ":0";
}

test("the native picker returns the chosen folder, or null when cancelled", async () => {
  fakeZenity(`echo ${join(root, "app")}`);
  assert.equal(await projects.nativePickDirectory(), join(root, "app"));
  fakeZenity("exit 1");
  assert.equal(await projects.nativePickDirectory(), null);
});

test("the native picker rejects a folder outside the roots and reports a failed dialog", async () => {
  fakeZenity("echo /etc");
  await assert.rejects(projects.nativePickDirectory(), (e: Error) => e instanceof ProjectDirError && e.message.includes("allowed root"));
  fakeZenity("echo 'cannot open display' >&2\nexit 255");
  await assert.rejects(projects.nativePickDirectory(), (e: Error) => e instanceof NativePickerError && e.message.includes("cannot open display"));
});

test("the native picker kills a dialog that outlives its timeout", async () => {
  fakeZenity("sleep 30");
  projects.limits.NATIVE_PICKER_TIMEOUT = 0.2;
  await assert.rejects(projects.nativePickDirectory(), { name: "TimeoutError" });
});

test("the native picker opens at the requested folder when it is allowed", async () => {
  // The fake dialog echoes the folder it was asked to start in.
  fakeZenity('for arg; do case "$arg" in --filename=*) echo "${arg#--filename=}";; esac; done');
  assert.equal(await projects.nativePickDirectory(join(root, "app")), join(root, "app"));
  assert.equal(await projects.nativePickDirectory(folder), root);
  assert.equal(await projects.nativePickDirectory(), root);
});

/** Summarizes every file it is sent, and records which. */
function writer() {
  const state = { summarized: [] as string[], overviews: 0 };
  const ask = async (prompt: string) => {
    if (prompt.startsWith(planningBriefs.OVERVIEW_PROMPT)) {
      state.overviews += 1;
      return "A small tool. Run tests with: python -m pytest";
    }
    const paths = [...prompt.matchAll(/^=== (.+) ===$/gm)].map((match) => match[1]);
    state.summarized.push(...paths);
    return JSON.stringify(Object.fromEntries(paths.map((path) => [path, `about ${path}`])));
  };
  return Object.assign(ask, { state });
}

function project(path: string): string {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "app.py"), "def main():\n    pass\n");
  writeFileSync(join(path, "README.md"), "# Tool\n");
  writeFileSync(join(path, "out.log"), "noise\n");
  writeFileSync(join(path, ".env"), "KEY=secret\n");
  return path;
}

test("the brief is written once, then only for changed files", async () => {
  const code = project(join(folder, "p"));
  const data = join(folder, "data");
  const ask = writer();
  let brief = await planningBriefs.refresh(code, data, ask);
  assert.deepEqual([...ask.state.summarized].sort(), ["README.md", "app.py"]); // no logs, no secrets
  assert.ok(brief.overview!.startsWith("A small tool"));
  writeFileSync(join(code, "app.py"), "def main():\n    return 1\n");
  unlinkSync(join(code, "README.md"));
  ask.state.summarized.length = 0;
  brief = await planningBriefs.refresh(code, data, ask);
  assert.deepEqual(ask.state.summarized, ["app.py"]);
  assert.deepEqual(Object.keys(brief.files), ["app.py"]);
  assert.equal(ask.state.overviews, 1);
  const text = briefing.render(code, brief);
  assert.ok(text.includes("app.py (2 lines): about app.py") && text.includes("Run tests with") && !text.includes("KEY=secret"));
});

test("a failed summary leaves the file listed without one", () => {
  const text = briefing.render(project(join(folder, "q")), { files: {} });
  assert.ok(text.includes("app.py (2 lines)") && !text.includes("Project brief"));
});

test("the planner gets the brief", async () => {
  const code = project(join(folder, "proj"));
  const cheap = ModelProfileSchema.parse({ id: "cheap:api", provider: "cheap", display_name: "cheap:api", channel: "api", context_window: 1_000_000,
    input_per_million: 1, output_per_million: 1, execution_priority: 100, scores: { coding: 80, planning: 80, reliability: 90 } });
  const providers = { complete: async (modelId: string, prompt: string) => new ProviderResult(await writer()(prompt), 1000, 100, modelId) };
  const [text, cost] = await planningBriefs.planningBrief(code, join(folder, "data"), providers, cheap);
  assert.ok(text.includes("app.py (2 lines): about app.py") && cost > 0);
});
