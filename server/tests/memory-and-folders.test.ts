// remembering.ts and folders.ts: tests/test_capability_packages.py, test_memory.py and
// test_folders.py (their parts about these modules), ported.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { settings } from "../src/config.js";
import * as folders from "../src/folders.js";
import { remembering } from "./helpers/chat-package.js";

const saved = { data_dir: settings.data_dir, workspace_root: settings.workspace_root, user_memory: settings.user_memory,
  lead_root: settings.lead_root };
let folder = "";
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "memory-"));
  Object.assign(settings, { data_dir: folder, workspace_root: join(folder, "ws"), lead_root: join(folder, "leads") });
});
afterEach(() => Object.assign(settings, saved));

test("memory lines are read and kept within bounds", () => {
  assert.deepEqual(remembering.split("好的\nREMEMBER: a: 用 Python\nFORGET: Java"), ["好的", ["a: 用 Python"], ["Java"]]);
  assert.deepEqual(remembering.split("没有"), ["没有", [], []]);
  const facts = remembering.apply(Array.from({ length: remembering.MAX_FACTS }, (_, i) => `f${i}`), ["new", "f3", "我的 API key 是 x"], ["f0"]);
  assert.ok(facts.length === remembering.MAX_FACTS && facts[facts.length - 1] === "new" && !facts.includes("f0"));
  assert.equal(facts.filter((fact) => fact === "f3").length, 1);
  assert.equal(remembering.told([]), "");
});

test("a broken memory file is nothing remembered", () => {
  writeFileSync(join(folder, "memory.json"), "{bad");
  assert.deepEqual(remembering.load(), {});
  remembering.update("web", ["a"], []);
  assert.deepEqual(remembering.facts("web"), ["a"]);
});

test("facts are kept by place, taken out of answers and deleted", () => {
  settings.user_memory = true;
  assert.equal(remembering.take("web", "好的\nREMEMBER: 成员1: 喜欢简短"), "好的");
  assert.deepEqual(remembering.facts("web"), ["成员1: 喜欢简短"]);
  settings.user_memory = false;
  assert.equal(remembering.take("web", "嗯\nREMEMBER: 不记"), "嗯"); // off: only taken out
  assert.deepEqual(remembering.facts("web"), ["成员1: 喜欢简短"]);
  assert.equal(remembering.remove("web", "没有这条"), false);
  assert.equal(remembering.remove("web", "成员1: 喜欢简短"), true);
  assert.deepEqual(remembering.load(), {}); // an emptied place is not kept
});

test("folder names are English words and the time", () => {
  assert.equal(folders.slug("Async FIFO: VCS/UVM verification & coverage!"), "async-fifo-vcs-uvm-verification-coverage");
  assert.equal(folders.slug("写一个通用异步fifo"), "fifo");
  assert.equal(folders.slug("写一个命令行工具"), "task");
  const when = new Date(2026, 9, 21, 14, 41); // local time, as Python's astimezone() names it
  const name = folders.taskFolder("async-fifo-uvm", when);
  assert.equal(name, "20261021-1441-async-fifo-uvm");
  assert.ok(statSync(join(settings.workspace_root, name)).isDirectory());
  // The same name twice in a minute: the second gets a number.
  assert.equal(folders.taskFolder("async-fifo-uvm", when), "20261021-1441-async-fifo-uvm-2");
  const lead = folders.leadFolder("deepseek:deepseek-flash");
  assert.ok(lead.startsWith(join(folder, "leads")) && lead.endsWith("-lead-deepseek-flash") && existsSync(lead));
});
