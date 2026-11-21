// quality.ts: tests from test_quality, test_review_evidence and test_unable, ported.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ExecutionRunSchema, TaskNodeSchema, type TaskNode } from "../src/models.js";
import * as quality from "../src/quality.js";

const folder = () => mkdtempSync(join(tmpdir(), "quality-"));
const node = (id: string, deps: string[] = [], fields: Record<string, unknown> = {}): TaskNode => TaskNodeSchema.parse({
  id, title: `Task ${id}`, instructions: `do ${id}`, capability: "coding", dependencies: deps, model_id: "x:cheap", ...fields });
const write = (root: string, name: string, text: string | Buffer) => {
  mkdirSync(join(root, name, ".."), { recursive: true });
  writeFileSync(join(root, name), text);
};
function commit(root: string): void {
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args]);
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "fixture");
}

test("retry feedback keeps only the original rework", () => {
  const rework = "验证（Check）发现问题：invalid token must return 403";
  const once = quality.retryFeedback(rework, "first rejection");
  const twice = quality.retryFeedback(`${once}\n诊断建议：advice`, "second rejection");
  assert.equal(once, `${rework}\n本次验收意见：first rejection`);
  assert.equal(twice, `${rework}\n本次验收意见：second rejection`);
  assert.equal(quality.retryFeedback("an earlier rejection", "new rejection"), "new rejection");
  assert.equal(quality.retryFeedback(null, "new rejection"), "new rejection");
});

test("the review prompt shows rework and discounts sandbox errors", () => {
  const prompt = quality.reviewPrompt(node("a", [], { feedback: "验证（Check）发现问题：invalid token must return 403" }), "done", [], "", false);
  assert.ok(prompt.includes("invalid token must return 403") && prompt.includes("supersede"));
  assert.ok(prompt.includes("sandbox") && prompt.includes("socket"));
  assert.ok(!quality.reviewPrompt(node("a"), "done", [], "", false).includes("Rework requirements"));
});

test("changed files skip VCS and dependency folders", () => {
  const root = folder();
  write(root, "keep.py", "a");
  write(root, "node_modules/x.js", "a");
  const before = quality.fileState(root);
  write(root, "keep.py", "changed!");
  write(root, "new.txt", "n");
  write(root, "node_modules/y.js", "a");
  assert.deepEqual(quality.changedFiles(before, quality.fileState(root)), ["keep.py", "new.txt"]);
});

test("the handoff lists upstream files and truncates without a summary", () => {
  const upstream = node("a", [], { changed_files: ["src/app.py", "README.md"], result: "y".repeat(50) });
  const downstream = node("b", ["a"]);
  const run = ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "running", budget_usd: 1, plan: { summary: "s", nodes: [upstream, downstream] } });
  const [prompt, inputs] = quality.nodePrompt(downstream, run, 10);
  assert.ok(prompt.includes("Files it changed: src/app.py, README.md") && prompt.includes("40 more characters omitted"));
  assert.deepEqual(inputs.map((input) => [input.form, input.changed_files]), [["truncated", 2]]);
});

test("a review sees changed contents in a workspace without git", () => {
  const root = folder();
  write(root, "static/app.js", 'go("#/todos/" + todo.id);\n');
  write(root, ".review/notes.txt", "reviewer scratch");
  write(root, "logo.png", Buffer.from("\x89PNG\0\0binary", "latin1"));
  const changed = ["static/app.js", ".review/notes.txt", "logo.png"];
  const evidence = quality.changeEvidence(root, changed);
  const prompt = quality.reviewPrompt(node("a"), "done", changed, evidence, false);
  assert.ok(prompt.includes('go("#/todos/" + todo.id);') && evidence.includes("static/app.js"));
  assert.ok(!evidence.includes("reviewer scratch") && !evidence.includes("PNG"));
});

test("review evidence includes untracked files in a git workspace", () => {
  const root = folder();
  write(root, "old.py", "x = 1\n");
  commit(root);
  write(root, "old.py", "x = 2\n");
  write(root, "new.py", "brand_new = True\n");
  const evidence = quality.changeEvidence(root, ["new.py", "old.py"]);
  assert.ok(evidence.includes("+x = 2") && evidence.includes("brand_new = True"));
});

test("review evidence is clipped", () => {
  const root = folder();
  write(root, "big.txt", "y".repeat(quality.MAX_DIFF_CHARS * 2));
  const evidence = quality.changeEvidence(root, ["big.txt"]);
  assert.ok(evidence.length < quality.MAX_DIFF_CHARS + 200 && evidence.includes("clipped"));
});

test("mentioned files stay inside the workspace", () => {
  const parent = folder();
  const root = join(parent, "ws");
  write(root, "src/main.py", "x");
  write(parent, "outside.txt", "x");
  assert.deepEqual(quality.mentionedFiles(root, `See src/main.py, ${root}/src/main.py, ../outside.txt and missing/file.py.`), ["src/main.py"]);
});

for (const tracked of [false, true]) {
  test(`a long delivery document cannot displace code and tests (${tracked ? "tracked" : "untracked"})`, () => {
    const root = folder();
    write(root, "DELIVERY.md", "previous delivery\n");
    write(root, "db.py", "CREATE_TABLE = 'CREATE TABLE email_tokens'\n");
    write(root, "test_db.py", "def test_existing_users_migrated(): pass\n");
    if (tracked) commit(root);
    write(root, "DELIVERY.md", "delivery detail\n".repeat(quality.MAX_DIFF_CHARS));
    const evidence = quality.changeEvidence(root, ["DELIVERY.md", "db.py", "test_db.py"]);
    assert.ok(evidence.includes("CREATE TABLE email_tokens") && evidence.includes("def test_existing_users_migrated"));
    assert.ok(evidence.includes("clipped") && evidence.length < quality.MAX_DIFF_CHARS + 1000);
  });

  test(`inline evidence filters private files and link targets (${tracked ? "tracked" : "untracked"})`, () => {
    const parent = folder();
    const root = join(parent, "work");
    mkdirSync(root);
    for (const name of [".env", "credentials.json", "secrets.json", "server.key"]) write(root, name, "private-value\n");
    write(parent, "outside.py", "outside-value\n");
    symlinkSync(join(parent, "outside.py"), join(root, "outside.py"));
    symlinkSync(join(root, ".env"), join(root, "alias.py"));
    if (tracked) {
      commit(root);
      write(root, ".env", "private-value-updated\n");
    }
    const files = readdirSync(root).filter((name) => {
      try {
        return statSync(join(root, name)).isFile();
      } catch {
        return false;
      }
    });
    const evidence = quality.changeEvidence(root, files);
    for (const hidden of ["private-value", "outside-value", "credentials.json", "alias.py"]) assert.ok(!evidence.includes(hidden), hidden);
  });
}

test("an explicit verification log is included, but private files are not", () => {
  const root = folder();
  write(root, ".tmp-verify/backend.log", "test detail\n".repeat(10_000) + "Ran 155 tests in 92.794s\nOK\n");
  write(root, ".env", "SECRET=never-include\n");
  write(root, ".tmp-verify/credentials.json", '{"token":"never-include"}');
  write(root, "db.py", "migrated = True\n");
  const references = quality.mentionedFiles(root, "See db.py, .tmp-verify/backend.log:10001, .env and .tmp-verify/credentials.json");
  assert.deepEqual(references, ["db.py", ".tmp-verify/backend.log"]);
  const evidence = quality.changeEvidence(root, references, { referenced: references });
  assert.ok(evidence.includes("Ran 155 tests in 92.794s\nOK") && !evidence.includes("never-include"));
  assert.ok(!quality.changeEvidence(root, [".tmp-verify/backend.log"]).includes("Ran 155 tests"));
});

for (const text of ["BLOCKED: missing evidence", "STATUS: BLOCKED", '{"status":"blocked","reason":"missing evidence"}']) {
  test(`a blocked claim is never a passing review: ${text}`, () => assert.ok(quality.blockedClaim(text)));
}

test("a step is told which work belongs to other steps", () => {
  const steps = [TaskNodeSchema.parse({ id: "build", title: "构建网站", instructions: "构建网站", capability: "coding", model_id: "x:api" }),
    TaskNodeSchema.parse({ id: "deploy", title: "部署上线", instructions: "部署上线", capability: "coding", model_id: "x:api", dependencies: ["build"] })];
  const run = ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "running", budget_usd: 1, plan: { summary: "s", nodes: steps } });
  const [prompt] = quality.nodePrompt(steps[0], run, 4000);
  assert.ok(prompt.includes("Other steps of this task, not yours: 部署上线") && prompt.includes("Judge only this step"));
  assert.ok(quality.reviewPrompt(steps[0], "x", [], "", false).includes("only this task"));
});

for (const claim of ["none", "NONE", "  None.  ", "no", "null", "false", "n/a", "N/A.", "not applicable", "no blockers",
  "No blocking issues.", "无", "无。", "没有", "不适用", "无阻塞", "无阻塞项", "没有阻塞", "没有阻塞项"]) {
  test(`an UNABLE line saying nothing is blocked is ignored: ${JSON.stringify(claim)}`, () => {
    assert.equal(quality.unableClaim(`本步骤已完成。\nUNABLE: ${claim}\n`), null);
  });
}

for (const reason of ["No credentials are available; deployment requires a key.", "none of the required services are reachable",
  "N/A: the required server is unavailable", "无权限连接服务器，尚未部署。", "没有凭据，无法发布。",
  "无阻塞项是上次的结论；本次缺少许可证。", "none; deployment still needs credentials"]) {
  test(`a real UNABLE reason is kept, negative words and all: ${reason}`, () => {
    assert.equal(quality.unableClaim(`准备工作已完成。\nUNABLE: ${reason}`), reason);
  });
}

for (const [text, expected] of [["UNABLE: none\nUNABLE: missing credentials", "missing credentials"],
  ["UNABLE: missing credentials\nUNABLE: none", null], ["Report mentions UNABLE: none in passing.", null]] as [string, string | null][]) {
  test(`the last UNABLE declaration counts: ${JSON.stringify(text)}`, () => assert.equal(quality.unableClaim(text), expected));
}
