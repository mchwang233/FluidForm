// agent.ts's file tools: tests/test_tools.py, ported.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as agent from "../src/agent.js";
import { Workspace } from "../src/agent.js";

function ws(): Workspace {
  const root = join(mkdtempSync(join(tmpdir(), "tools-")), "work");
  for (const folder of ["rtl", "tb", "node_modules"]) mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, "rtl", "fifo.sv"), "module fifo;\n  logic full;\n  logic empty;\nendmodule\n");
  writeFileSync(join(root, "rtl", "sync.sv"), "module sync;\nendmodule\n");
  writeFileSync(join(root, "tb", "tb_fifo.sv"), "module tb_fifo;\n  fifo dut();\n  // FULL check\nendmodule\n");
  writeFileSync(join(root, "node_modules", "skip.sv"), "module fifo_in_deps;\n");
  const later = Date.now() / 1000 + 10;
  utimesSync(join(root, "rtl", "sync.sv"), later, later);
  return new Workspace(root);
}

test("the tools offered are Claude Code's", () => {
  assert.deepEqual(agent.toolsFor(true).map((tool) => tool.name), ["Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS"]);
  assert.deepEqual(agent.toolsFor(true, true).map((tool) => tool.name), ["Bash", "Read", "Glob", "Grep", "LS"]);
  assert.deepEqual(agent.toolsFor(false, true).map((tool) => tool.name), ["Read", "Glob", "Grep", "LS"]);
  assert.ok(!agent.toolsFor(false).some((tool) => tool.name === "Bash"));
  const edit = agent.TOOLS.find((tool) => tool.name === "Edit")!.parameters as any;
  assert.deepEqual(edit.required, ["file_path", "old_string", "new_string"]);
  assert.ok("replace_all" in edit.properties);
});

test("Glob finds files newest first, without build folders", async () => {
  const workspace = ws();
  const found = (await workspace.call("Glob", { pattern: "**/*.sv" })).split("\n");
  assert.equal(found[0], "rtl/sync.sv");
  assert.deepEqual([...found].sort(), ["rtl/fifo.sv", "rtl/sync.sv", "tb/tb_fifo.sv"]);
  assert.ok(!(await workspace.call("Glob", { pattern: "**/*.sv" })).includes("node_modules"));
  assert.equal(await workspace.call("Glob", { pattern: "*.sv", path: "tb" }), "tb/tb_fifo.sv");
  assert.notEqual(await workspace.call("Glob", { pattern: "**/*.{sv,v}" }), "No files found");
  assert.equal(await workspace.call("Glob", { pattern: "**/*.vhd" }), "No files found");
});

test("Grep lists files, shows lines with context, or counts", async () => {
  const workspace = ws();
  assert.deepEqual((await workspace.call("Grep", { pattern: String.raw`module \w*fifo` })).split("\n").sort(), ["rtl/fifo.sv", "tb/tb_fifo.sv"]);
  const content = await workspace.call("Grep", { pattern: "full", "-i": true, output_mode: "content", glob: "*.sv" });
  assert.deepEqual(content.split("\n"), ["rtl/fifo.sv:2:  logic full;", "tb/tb_fifo.sv:3:  // FULL check"]);
  const around = await workspace.call("Grep", { pattern: "full", output_mode: "content", "-A": 1, path: "rtl" });
  assert.deepEqual(around.split("\n"), ["rtl/fifo.sv:2:  logic full;", "rtl/fifo.sv-3-  logic empty;"]);
  assert.equal(await workspace.call("Grep", { pattern: "module", output_mode: "count", path: "rtl/fifo.sv" }), "rtl/fifo.sv:2");
  assert.equal(await workspace.call("Grep", { pattern: "nothing-like-this" }), "No matches found");
  assert.ok((await workspace.call("Grep", { pattern: "(unclosed" })).startsWith("Error: invalid regular expression"));
  const capped = await workspace.call("Grep", { pattern: "e", output_mode: "content", head_limit: 2 });
  assert.ok(capped.split("\n").length === 3 && capped.includes("output cut at 2 lines"));
});

test("Read numbers lines and reads from the end", async () => {
  const workspace = ws();
  assert.equal(await workspace.call("Read", { file_path: "rtl/fifo.sv", offset: 2, limit: 2 }),
    "     2\t  logic full;\n     3\t  logic empty;\n[lines 2-3 of 4; pass offset to read more]");
  assert.equal(await workspace.call("Read", { file_path: "rtl/fifo.sv", offset: -1 }), "     4\tendmodule\n[lines 4-4 of 4; pass offset to read more]");
  assert.ok((await workspace.call("Read", { file_path: "rtl" })).includes("is a directory: use LS"));
  assert.ok((await workspace.call("Read", { file_path: "rtl/sync.sv", offset: 9 })).includes("past the end"));
});

test("Edit needs a unique match unless replace_all", async () => {
  const workspace = ws();
  assert.ok((await workspace.call("Edit", { file_path: "rtl/fifo.sv", old_string: "logic", new_string: "bit" })).includes("occurs 2 times"));
  const result = await workspace.call("Edit", { file_path: "rtl/fifo.sv", old_string: "logic", new_string: "bit", replace_all: true });
  assert.ok(result.startsWith("Edited rtl/fifo.sv (2 replacements):") && result.includes("     2\t  bit full;"));
  assert.ok((await workspace.call("Edit", { file_path: "rtl/fifo.sv", old_string: "bit", new_string: "bit" })).includes("are the same"));
  assert.ok((await workspace.call("Edit", { file_path: "rtl/new.sv", old_string: "a", new_string: "b" })).includes("use Write"));
});

test("MultiEdit applies all edits or none", async () => {
  const workspace = ws();
  const path = join(workspace.root, "rtl/fifo.sv");
  const before = readFileSync(path, "utf8");
  const failed = await workspace.call("MultiEdit", { file_path: "rtl/fifo.sv", edits: [{ old_string: "full", new_string: "is_full" },
    { old_string: "missing", new_string: "x" }] });
  assert.ok(failed.startsWith("Error: edit 2: old_string was not found"));
  assert.equal(readFileSync(path, "utf8"), before);
  const done = await workspace.call("MultiEdit", { file_path: "rtl/fifo.sv", edits: [{ old_string: "full", new_string: "is_full" },
    { old_string: "empty", new_string: "is_empty" }] });
  assert.ok(done.startsWith("Edited rtl/fifo.sv (2 edits):"));
  assert.ok(readFileSync(path, "utf8").includes("is_full") && readFileSync(path, "utf8").includes("is_empty"));
});

test("the log describes each call briefly", () => {
  assert.equal(agent.describeCall("Bash", { command: "make sim" }), "make sim");
  assert.equal(agent.describeCall("Grep", { pattern: "full", glob: "*.sv" }), "full (*.sv)");
  assert.equal(agent.describeCall("MultiEdit", { file_path: "a.sv", edits: [{}, {}] }), "a.sv (2 edits)");
  assert.equal(agent.describeCall("Read", { file_path: "a.sv", offset: 10 }), "a.sv (from line 10)");
});

test("long command output keeps its start and end", () => {
  const clipped = agent.clip("start\n" + "x".repeat(100_000) + "\nend");
  assert.ok(clipped.startsWith("start") && clipped.endsWith("end") && clipped.includes("characters cut"));
});

test("a review searches only what it may read", async () => {
  const root = join(mkdtempSync(join(tmpdir(), "tools-")), "project");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.py"), "SECRET_KEY = 1\n");
  writeFileSync(join(root, ".env"), "SECRET_KEY = 2\n");
  assert.equal(await new Workspace(root, { readOnly: true }).call("Grep", { pattern: "SECRET_KEY" }), "src/app.py");
});

test("the file tools reach the same /tmp as Bash", async () => {
  // A model writes a scratch script to /tmp with Write and runs it with Bash, as in Claude Code.
  const workspace = ws();
  assert.equal(await workspace.call("Write", { file_path: "/tmp/check.py", content: "print('hi')\n" }), "Created /tmp/check.py (1 lines)");
  assert.ok((await workspace.call("Read", { file_path: "/tmp/check.py" })).startsWith("     1\tprint('hi')"));
  assert.ok((await workspace.call("Edit", { file_path: "/tmp/check.py", old_string: "hi", new_string: "ok" })).startsWith("Edited /tmp/check.py (1 replacement)"));
  assert.equal(await workspace.call("Glob", { pattern: "*.py", path: "/tmp" }), "/tmp/check.py");
  assert.equal(readFileSync(join(workspace.tmp(), "check.py"), "utf8"), "print('ok')\n");
  assert.ok((await workspace.call("Write", { file_path: "/tmp/../etc/x", content: "" })).includes("outside the working directory"));
  assert.ok((await workspace.call("Read", { file_path: "/etc/hostname" })).includes("outside the working directory"));
  assert.match(await workspace.call("Bash", { command: "cat /tmp/check.py" }), /print\('ok'\)/);
});

test("a review and a host repair keep /tmp out of reach", async () => {
  const root = join(mkdtempSync(join(tmpdir(), "tools-")), "w");
  mkdirSync(root);
  for (const workspace of [new Workspace(root, { readOnly: true }), new Workspace(root, { host: true })]) {
    assert.ok((await workspace.call("Read", { file_path: "/tmp/x" })).startsWith("Error:"));
  }
});

test("the instructions say where the file tools work", async () => {
  const text = await agent.agentInstructions(null, false, "/w");
  assert.ok(!text.includes("Files outside it are read-only") && text.includes("and in /tmp"));
});
