// What tests/conftest.py gives every Python test, for the TS tests: the platform's defaults (not this
// machine's .env), a temporary data folder and workspace, no diagnosis, no check before the first
// step, the user's Codex config and cache and the membership CLIs out of reach, and the former defaults of the settings that
// are on now (a test of one turns it on). Settings and the environment are restored after each test.
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "node:test";
import * as cliChannels from "../../src/cli-channels.js";
import { loadSettings, settings } from "../../src/config.js";

/** The membership CLIs (Claude Code, Codex, Gemini): never run by a test unless it says so. */
const CLI_EXECUTABLES = new Set(Object.values(cliChannels.CLI_SPECS).map((spec) => spec.executable));
const realWhich = cliChannels.deps.which;
/** For the one test that means to run a real CLI: the machine's own lookup again. */
export const allowRealClis = () => {
  cliChannels.deps.which = realWhich;
};

// What these settings default to now (docs/design/fewer-settings.md); a test of something else runs
// without them, as before.
export const ON_BY_DEFAULT: Record<string, unknown> = { quick_tasks: false, solo_tasks: false, resume_after_restart: false, chat_tools: false,
  chat_tools_network: false, chat_action_tools: false, user_memory: false, web_fetch: false, engineer_repairs: false, preflight_cache_minutes: 0,
  head_start: false, capability_proposals: false, capability_packages: false, chat_tool_seconds: 120, chat_tool_turns: 20,
  // Nothing taken from keys a test machine may have in its environment.
  image_models: [], web_search_models: [] };

/** Registers the hooks for the tests of the calling file; ``folder()`` is the test's own temporary folder. */
export function conftest(): { folder: () => string } {
  const saved = { ...settings };
  const env = { ...process.env };
  let folder = "";
  beforeEach(() => {
    folder = realpathSync(mkdtempSync(join(tmpdir(), "sp-test-")));
    // The platform's defaults, not this machine's .env: the same tests must pass on any machine.
    Object.assign(settings, { ...loadSettings({}, process.env, join(folder, "no.env")) });
    Object.assign(settings, {
      // isolated_environment
      data_dir: join(folder, "data"), workspace_root: join(folder, "workspaces"), auto_diagnose: false, problem_naming: false, acceptance: true,
      contract_call_floors: false, platform_self_repair: false, skill_reuse_first: false, employee_teams: false, team_reasoning_effort: "",
      planning_reasoning_effort: "", planning_call_timeout: 0,
      // own_codex_home, no_preflight, former_defaults
      lead_root: join(folder, "leads"), preflight: false, ...ON_BY_DEFAULT,
    });
    process.env.CODEX_HOME = join(folder, "codex-home");
    // A step, lead or repair that reached a real CLI would spend the user's membership: only the fakes
    // a test makes in its own folder are found.
    cliChannels.deps.which = (name: string) => {
      const found = realWhich(name);
      return found && CLI_EXECUTABLES.has(name) && !found.startsWith(folder + "/") ? null : found;
    };
  });
  afterEach(() => {
    cliChannels.deps.which = realWhich;
    Object.assign(settings, saved);
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  });
  return { folder: () => folder };
}

import { builtinModels } from "../../src/catalog.js";
import { CapabilityScoreSchema, type ModelProfile } from "../../src/models.js";

/** conftest.scored_models: the built-in catalog with uniform stand-in scores, as if Artificial Analysis
 *  had scored every model (the bare catalog routes nothing but the demo model). */
export function scoredModels(): ModelProfile[] {
  const scores = Object.fromEntries(Object.keys(CapabilityScoreSchema.parse({})).map((key) => [key, 90]));
  return builtinModels().map((model) => (model.scores === null ? { ...model, scores: CapabilityScoreSchema.parse(scores) } : model));
}
