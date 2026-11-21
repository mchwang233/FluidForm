// publish.ts: test_push_snapshot_to_an_existing_repository from tests/test_publish.py, and the
// functions its API tests go through (those come with the API routes).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { settings } from "../src/config.js";
import { ExecutionRunSchema } from "../src/models.js";
import * as publish from "../src/publish.js";
import { ZipFile } from "../src/zip.js";
import { conftest } from "./helpers/conftest.js";

const { folder } = conftest();

const finishedRun = (id = "done", projectDir: string | null = null, changed: string[] = []) => ExecutionRunSchema.parse({ id, prompt: "写一个游戏", status: "succeeded",
  budget_usd: 1, project_dir: projectDir, final_result: "Game is ready", plan: { summary: "Tetris game", nodes: [{ id: "n", title: "Build", instructions: "build",
    capability: "coding", model_id: "cli:codex", status: "succeeded", result: "Built the game", changed_files: changed }] } });

function scratch(): string {
  settings.workspace_root = join(folder(), "workspaces");
  const root = join(settings.workspace_root, "done");
  mkdirSync(join(root, "tetris"), { recursive: true });
  writeFileSync(join(root, "tetris", "index.html"), "<canvas></canvas>");
  writeFileSync(join(root, "tetris", "logo.bin"), Buffer.from([0, 1]));
  for (const [dir, name, text] of [[".review", "note.txt", "internal"], [".claude", "settings.json", "{}"]]) {
    mkdirSync(join(root, dir));
    writeFileSync(join(root, dir, name), text);
  }
  return root;
}

const bareRemote = () => {
  const remote = join(folder(), "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  return remote;
};
const remoteFiles = (remote: string) => execFileSync("git", ["--git-dir", remote, "ls-tree", "-r", "--name-only", "main"], { encoding: "utf8" }).split(/\s+/).filter(Boolean);

test("the output skips the agents' folders and stays inside", () => {
  scratch();
  const run = finishedRun();
  assert.deepEqual(publish.outputFiles(run).map((item) => item.path), ["tetris/index.html", "tetris/logo.bin"]);
  assert.equal(publish.readOutput(run, "tetris/index.html"), "<canvas></canvas>");
  for (const path of ["../../etc/passwd", ".review/note.txt", "tetris/../.claude/settings.json"]) assert.throws(() => publish.readOutput(run, path), publish.PublishError);
  assert.throws(() => publish.readOutput(run, "tetris/logo.bin"), (error: Error) => error.message.includes("二进制"));
});

test("the archive holds the output and a record of the result", () => {
  scratch();
  const run = finishedRun();
  assert.ok(publish.slug(run).startsWith("tetris-game-"));
  const bundle = new ZipFile(publish.archive(run));
  assert.deepEqual(bundle.infolist().map((item) => item.filename).sort(), ["RESULT.md", "tetris/index.html", "tetris/logo.bin"]);
  const record = bundle.read("RESULT.md").toString();
  assert.ok(record.includes("Game is ready") && record.includes("Built the game") && record.includes("写一个游戏"));
  assert.equal(bundle.read("tetris/index.html").toString(), "<canvas></canvas>");
});

test("a project's task only outputs the files it changed", () => {
  const project = join(folder(), "project");
  mkdirSync(project);
  writeFileSync(join(project, "app.py"), "changed");
  writeFileSync(join(project, "untouched.py"), "mine");
  assert.deepEqual(publish.outputFiles(finishedRun("proj", project, ["app.py", "deleted.py"])).map((item) => item.path), ["app.py"]);
});

test("a snapshot is pushed to a repository there is", () => {
  Object.assign(settings, { workspace_root: join(folder(), "workspaces"), data_dir: join(folder(), "data") });
  mkdirSync(settings.data_dir);
  mkdirSync(join(settings.workspace_root, "done"), { recursive: true });
  writeFileSync(join(settings.workspace_root, "done", "main.py"), "print('hi')");
  const remote = bareRemote();
  publish.pushSnapshot(finishedRun(), remote);
  assert.deepEqual(remoteFiles(remote), ["RESULT.md", "main.py"]);
  assert.deepEqual(readdirSync(settings.data_dir), []); // staging is cleaned up
  assert.equal(publish.checkRemote("git@github.com:me/repo.git"), "git@github.com:me/repo.git");
  assert.throws(() => publish.checkRemote("git@github.com:me/repo.git; rm -rf /"), publish.PublishError);
});

test("creating a repository sends the token and keeps it out of errors", async () => {
  const sent: [string | null, unknown][] = [];
  const ok = (async (_url: string | URL, init: RequestInit = {}) => {
    sent.push([new Headers(init.headers).get("authorization"), JSON.parse(String(init.body))]);
    return Response.json({ html_url: "https://github.com/me/tetris" }, { status: 201 });
  }) as typeof fetch;
  assert.deepEqual(await publish.createRepository("ghp_x", "tetris", true, "Tetris game", ok), { html_url: "https://github.com/me/tetris" });
  assert.deepEqual(sent, [["Bearer ghp_x", { name: "tetris", private: true, description: "Tetris game", auto_init: false }]]);
  const leaky = (async () => new Response("bad ghp_x", { status: 500 })) as typeof fetch;
  await assert.rejects(publish.createRepository("ghp_x", "t", false, "", leaky), (error: Error) => error.message.includes("***") && !error.message.includes("ghp_x"));
  await assert.rejects(publish.createRepository("ghp_x", "t", false, "", (async () => new Response("", { status: 422 })) as typeof fetch), /已经有名为 t 的仓库/);
});
