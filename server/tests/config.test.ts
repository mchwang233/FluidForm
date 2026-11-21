// tests/test_profiles.py and the settings parts of tests/test_defaults.py, ported; and how the
// environment and .env are read (pydantic-settings).
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadSettings, PROFILES, readDotenv, SETTING_NAMES } from "../src/config.js";

const none = join(tmpdir(), "no-such-folder", ".env");

test("a profile sets its settings unless one is given", () => {
  const plain = loadSettings({}, {}, none);
  assert.deepEqual([plain.profile, plain.quick_tasks, plain.acceptance], ["", true, false]);
  const careful = loadSettings({ profile: "careful", preflight_cache_minutes: 5 }, {}, none);
  assert.ok(careful.acceptance && !careful.quick_tasks && careful.preflight_cache_minutes === 5);
  const given = loadSettings({}, { SUPER_PARTNER_PROFILE: "careful", SUPER_PARTNER_QUICK_TASKS: "true" }, none);
  assert.ok(given.acceptance && given.quick_tasks && !given.solo_tasks);
});

test("every profile names real settings", () => {
  for (const values of Object.values(PROFILES)) {
    for (const name of Object.keys(values)) assert.ok((SETTING_NAMES as string[]).includes(name), name);
  }
  assert.throws(() => loadSettings({ profile: "turbo" }, {}, none));
});

test("without any setting the features are on", () => {
  const plain = loadSettings({}, {}, none);
  assert.ok([plain.quick_tasks, plain.solo_tasks, plain.resume_after_restart, plain.chat_tools,
    plain.chat_tools_network, plain.chat_action_tools, plain.user_memory, plain.web_fetch,
    plain.engineer_repairs].every(Boolean));
  assert.deepEqual([plain.preflight_cache_minutes, plain.chat_tool_seconds, plain.chat_tool_turns], [60, 300, 50]);
  assert.ok(plain.image_models === null && plain.web_search_models === null && !plain.acceptance);
  // Still switched off on purpose: they widen the sandbox, or cost money nobody asked for.
  assert.ok(!plain.allow_host_shell);
  assert.deepEqual(plain.project_roots, [homedir()]);
});

test("the former profiles read as the defaults", () => {
  for (const name of ["fast", "balanced"]) assert.equal(loadSettings({ profile: name }, {}, none).profile, "");
  const careful = loadSettings({ profile: "careful" }, {}, none);
  assert.ok(careful.acceptance && !careful.quick_tasks && !careful.solo_tasks);
});

test("an old .env naming removed settings still loads", () => {
  const folder = mkdtempSync(join(tmpdir(), "settings-"));
  writeFileSync(join(folder, ".env"), "SUPER_PARTNER_DIRECT_TASK_PLANNING=true\nSUPER_PARTNER_ADAPTIVE_REFINEMENT=true\n");
  const loaded = loadSettings({}, { SUPER_PARTNER_DIRECT_TASK_PLANNING: "false" }, join(folder, ".env"));
  assert.ok(loaded.employee_teams && loaded.head_start && loaded.capability_packages);
  assert.ok(!("direct_task_planning" in loaded));
});

test("the environment wins over .env; lists and objects are JSON; names are any case", () => {
  const folder = mkdtempSync(join(tmpdir(), "settings-"));
  writeFileSync(join(folder, ".env"), [
    "# a comment", "export SUPER_PARTNER_DATA_DIR=/data/fluidform", "SUPER_PARTNER_DEFAULT_BUDGET_USD='3.5'",
    'SUPER_PARTNER_SANDBOX_ENV=["VCS_HOME", "PATH"]', "super_partner_quick_tasks=off  # inline comment",
  ].join("\n"));
  const loaded = loadSettings({}, { SUPER_PARTNER_DEFAULT_BUDGET_USD: "4", SUPER_PARTNER_CLI_PLANS: '{"cli:codex": {"monthly_usd": 200}}' },
    join(folder, ".env"));
  assert.equal(loaded.data_dir, "/data/fluidform");
  assert.equal(loaded.default_budget_usd, 4);
  assert.deepEqual(loaded.sandbox_env, ["VCS_HOME", "PATH"]);
  assert.equal(loaded.quick_tasks, false);
  assert.deepEqual(loaded.cli_plans, { "cli:codex": { monthly_usd: 200 } });
  assert.equal(loaded.dbPath, join("/data/fluidform", "super-partner.db"));
  assert.ok(loaded.given.has("data_dir") && !loaded.given.has("acceptance"));
});

test("values out of range or of the wrong kind are refused", () => {
  assert.throws(() => loadSettings({}, { SUPER_PARTNER_TEAM_MAX_EMPLOYEES: "13" }, none));
  assert.throws(() => loadSettings({}, { SUPER_PARTNER_HEAD_START: "maybe" }, none));
  assert.throws(() => loadSettings({ provider_limits: { deepseek: { rpm: -1 } } }, {}, none));
});

test("an old .env naming the removed tool extensions and hooks still loads", () => {
  const loaded = loadSettings({}, { SUPER_PARTNER_API_TOOL_HOOKS: '{"before_tool": []}', SUPER_PARTNER_API_TOOL_EXTENSIONS: "{}" }, none) as unknown as Record<string, unknown>;
  assert.ok(!("api_tool_hooks" in loaded) && !("api_tool_extensions" in loaded));
});

test("switching profile while running keeps what was given alone", () => {
  const settings = loadSettings({ quick_tasks: true }, {}, none);
  settings.useProfile("careful");
  assert.ok(settings.acceptance && settings.quick_tasks && !settings.solo_tasks);
  assert.deepEqual(settings.givenAlone("careful"), ["quick_tasks"]);
  settings.useProfile("");
  assert.ok(!settings.acceptance && settings.solo_tasks && settings.preflight_cache_minutes === 60);
  assert.throws(() => settings.useProfile("turbo"));
});

test(".env lines as python-dotenv reads them", () => {
  assert.deepEqual(readDotenv('A=1\n B = "two words"\nC=\'x # not a comment\'\nD=3 # comment\n#E=4\nF="a\\nb"'),
    { A: "1", B: "two words", C: "x # not a comment", D: "3", F: "a\nb" });
});

test("defaults that matter on their own", () => {
  const plain = loadSettings({}, {}, none);
  // The URG probe of task 72e1d53b exited normally after 2143.923 seconds; a 30-minute call
  // limit could not cover that long regression and cut the platform repair short.
  assert.ok(plain.repair_call_minutes * 60 > 2143.923);
  assert.equal(plain.max_steps_per_provider, 0); // spreading steps over providers is off unless set
});
