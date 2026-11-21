// Packages shipped with FluidForm (server/packages): installed and enabled the first time FluidForm
// starts with capability packages allowed and a sandbox to run them, and brought up to date when a
// newer version ships. One the user uninstalled stays uninstalled (what was offered is kept in
// bundled.json). docs/design/chat-and-pricing-packages.md.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as capabilities from "./capabilities.js";
import * as packages from "./capability-packages.js";
import * as sandbox from "./capability-sandbox.js";
import { settings } from "./config.js";
import { log } from "./log.js";
import type { Capability } from "./models.js";

export const deps = {
  // Where the shipped packages are: server/packages, from src/ and from dist/ alike.
  folder: () => fileURLToPath(new URL("../packages/", import.meta.url)),
};

type Offered = Record<string, string>;
const store = () => join(settings.data_dir, "bundled.json");

function offered(): Offered {
  try {
    const found = JSON.parse(readFileSync(store(), "utf8"));
    return found && typeof found === "object" && !Array.isArray(found) ? found : {};
  } catch {
    return {};
  }
}

/** Install what has not been offered yet (enabled) and update what is installed and older. Returns
 *  the packages installed or updated. */
export async function offer(): Promise<Capability[]> {
  if (!settings.capability_packages || sandbox.deps.missing() || !existsSync(deps.folder())) return [];
  const given = offered();
  const done: Capability[] = [];
  for (const entry of readdirSync(deps.folder(), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = join(deps.folder(), entry.name);
    let version = "";
    let id = entry.name;
    try {
      const manifest = JSON.parse(readFileSync(join(source, packages.MANIFEST), "utf8"));
      [id, version] = [String(manifest.id), String(manifest.version ?? "")];
    } catch {
      continue;
    }
    const installed = capabilities.load(id);
    const fresh = !(id in given);
    // Uninstalled after it was offered: the user's choice stands. A task's own capability of that
    // name is left alone.
    if ((!fresh && !installed) || (installed && installed.source !== "upload")) continue;
    if (!fresh && installed && installed.version === version) continue;
    try {
      const capability = await packages.installFolder(source);
      if (fresh) carryOver(capability);
      // New: on, as features are. Updated: as it was.
      if (capability.status !== "failed" && (fresh || installed?.status === "active")) {
        capability.status = "active";
        capabilities.save(capability);
      }
      done.push(capability);
      given[id] = version;
      mkdirSync(settings.data_dir, { recursive: true });
      writeFileSync(store(), JSON.stringify(given, null, 2));
    } catch (error) {
      log.error(`could not install the shipped package ${id}: ${(error as Error)?.stack ?? error}`);
    }
  }
  return done;
}

// What FluidForm kept itself before a package took it over, by package: moved into its data folder
// when it is first installed, so nothing is lost (old records must load).
export const CARRIED: Record<string, string[]> = { chat: ["memory.json"] };

function carryOver(capability: Capability): void {
  for (const name of CARRIED[capability.id] ?? []) {
    const source = join(settings.data_dir, name);
    const target = join(packages.dataFolder(capability.id), name);
    if (!existsSync(source) || existsSync(target)) continue;
    mkdirSync(packages.dataFolder(capability.id), { recursive: true });
    renameSync(source, target);
  }
}
