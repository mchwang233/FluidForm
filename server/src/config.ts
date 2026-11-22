// FluidForm's settings: FLUIDFORM_* (or the former SUPER_PARTNER_*) from the environment
// and a .env file, read as pydantic-settings reads them, so one .env serves both backends.
// Precedence: values given in code, then the environment, then .env, then the defaults.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { JSON_SETTINGS, SettingsFields } from "./config-fields.js";

// Settings that go together, chosen with one name (FLUIDFORM_PROFILE, or 设置 → 工作方式); a
// setting given on its own still wins. Empty: every setting keeps its own default.
export const PROFILES: Record<string, Record<string, unknown>> = {
  // Every task planned by the lead, every step's result accepted by another model.
  careful: { quick_tasks: false, solo_tasks: false, acceptance: true, review_easy_steps: true, preflight_cache_minutes: 0 },
};
// Profiles there were before the defaults did what they did: read as no profile.
export const FORMER_PROFILES = new Set(["fast", "balanced"]);
// Settings there are no more (docs/design/fewer-settings.md): an old .env naming them still loads.
export const RETIRED = new Set([
  // Built-in tools replaced by MCP servers (mcp_servers): pictures, web search, reading a page.
  "image_models", "web_search_models", "web_fetch", "direct_task_planning", "adaptive_refinement",
  // Removed by the user's decision with the move to TypeScript: tools and hooks are added with MCP or skills.
  "api_tool_extensions", "api_tool_hooks",
  // An automation's spending is counted, not limited (docs/design/capability-packages.md).
  "capability_daily_budget_usd"]);

const SettingsObject = z.object(SettingsFields).superRefine((value, context) => {
  for (const limits of Object.values(value.provider_limits)) {
    if (Object.keys(limits).some((key) => !["concurrency", "rpm", "tpm"].includes(key))
      || Object.values(limits).some((limit) => limit < 0)) {
      context.addIssue({ code: "custom", path: ["provider_limits"],
        message: "provider limits accept only nonnegative concurrency, rpm and tpm" });
    }
  }
});
export type SettingsValues = z.output<typeof SettingsObject>;
export const SETTING_NAMES = Object.keys(SettingsFields) as (keyof SettingsValues)[];

/** A .env file as python-dotenv reads it: KEY=VALUE lines, "export " allowed, quotes removed,
 *  # comments; a double-quoted value takes \n escapes. */
export function readDotenv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const found = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!found) continue;
    let value = found[2];
    if (/^"(.*)"$/s.test(value)) value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
    else if (/^'(.*)'$/s.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "").trim();
    values[found[1]] = value;
  }
  return values;
}

// The database's file in the data folder (it was super-partner.db: rename.ts moves it).
export const DATABASE = "fluidform.db";
export const FORMER_DATABASE = "super-partner.db";

// What the settings are called: FLUIDFORM_*, and SUPER_PARTNER_* as they were named before (an older
// .env goes on working; the new name wins when both are given).
export const PREFIX = "FLUIDFORM_";
export const FORMER_PREFIX = "SUPER_PARTNER_";

/** FLUIDFORM_* (or SUPER_PARTNER_*) values by setting name (lower case, as pydantic-settings matches them). */
function prefixed(source: Record<string, string | undefined>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const prefix of [FORMER_PREFIX, PREFIX]) {
    for (const [key, raw] of Object.entries(source)) {
      if (raw === undefined || !key.toUpperCase().startsWith(prefix)) continue;
      const name = key.slice(prefix.length).toLowerCase();
      if (!(name in SettingsFields)) continue;
      values[name] = JSON_SETTINGS.has(name) ? JSON.parse(raw) : raw;
    }
  }
  return values;
}

export class SettingsMethods {
  /** The settings given rather than defaulted (pydantic's model_fields_set). */
  declare readonly given: ReadonlySet<string>;

  /** The settings of ``profile`` given on their own, which it does not change. */
  givenAlone(this: Settings, profile: string): string[] {
    return Object.keys(PROFILES[profile] ?? {}).filter((name) => this.given.has(name));
  }

  /** Switch to another profile while running: the old one's settings go back to their defaults,
   *  the new one's apply; those given alone stay. */
  useProfile(this: Settings, profile: string): void {
    const next = FORMER_PROFILES.has(profile) ? "" : profile;
    if (!(next in PROFILES) && next !== "") throw new Error(`unknown profile ${next}`);
    const defaults = SettingsObject.parse({});
    for (const name of Object.keys(PROFILES[this.profile] ?? {})) {
      if (!this.given.has(name)) (this as unknown as Record<string, unknown>)[name] = (defaults as Record<string, unknown>)[name];
    }
    (this as { profile: string }).profile = next;
    applyProfile(this);
  }

  /** The profile picked on the page, which outlasts a restart and wins over FLUIDFORM_PROFILE. */
  get profilePath(): string {
    return join((this as unknown as Settings).data_dir, "profile.json");
  }

  loadSavedProfile(this: Settings): void {
    let saved: unknown;
    try {
      saved = (JSON.parse(readFileSync(this.profilePath, "utf8")) as { profile?: unknown }).profile;
    } catch {
      return;
    }
    if (typeof saved === "string" && (saved in PROFILES || FORMER_PROFILES.has(saved) || saved === "")) {
      this.useProfile(saved);
    }
  }

  get dbPath(): string {
    const self = this as unknown as Settings;
    return self.database_path ?? join(self.data_dir, DATABASE);
  }

  prepare(this: Settings): void {
    mkdirSync(this.data_dir, { recursive: true });
    mkdirSync(this.workspace_root, { recursive: true });
  }
}

export type Settings = SettingsValues & SettingsMethods;

function applyProfile(settings: Settings): void {
  const self = settings as Record<string, unknown> & Settings;
  if (FORMER_PROFILES.has(self.profile)) (self as { profile: string }).profile = "";
  for (const [name, value] of Object.entries(PROFILES[self.profile] ?? {})) {
    if (!self.given.has(name)) self[name] = value;
  }
}

/** The settings: ``init`` (as Settings(**init) in Python), then ``env``, then the .env file at
 *  ``envFile``, then the defaults. Throws on a value that is not valid. */
export function loadSettings(init: Record<string, unknown> = {}, env: Record<string, string | undefined> = process.env,
  envFile = ".env"): Settings {
  const fromFile = existsSync(envFile) ? prefixed(readDotenv(readFileSync(envFile, "utf8"))) : {};
  const merged: Record<string, unknown> = { ...fromFile, ...prefixed(env), ...init };
  for (const name of Object.keys(merged)) if (RETIRED.has(name)) delete merged[name];
  const values = SettingsObject.parse(merged);
  const settings = Object.assign(Object.create(SettingsMethods.prototype), values) as Settings;
  Object.defineProperty(settings, "given", { value: new Set(Object.keys(merged).filter((name) => name in SettingsFields)), configurable: true });
  applyProfile(settings);
  return settings;
}

/** The settings this process runs with. */
export const settings: Settings = loadSettings();
