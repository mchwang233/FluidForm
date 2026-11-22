// Packages shipped with FluidForm (server/packages): installed and enabled the first time FluidForm
// starts (one that runs a process, with capability packages allowed and a sandbox to run them; an
// interface, a web page FluidForm serves, and an extension, always), and brought up to date when what
// ships changes.
// One the user uninstalled stays uninstalled (what was offered is kept in bundled.json).
// docs/design/chat-and-pricing-packages.md.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as capabilities from "./capabilities.js";
import * as packages from "./capability-packages.js";
import * as sandbox from "./capability-sandbox.js";
import { settings } from "./config.js";
import * as extensions from "./extensions.js";
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
  if (!existsSync(deps.folder())) return [];
  const running = settings.capability_packages && !sandbox.deps.missing();
  const given = offered();
  const done: Capability[] = [];
  for (const entry of readdirSync(deps.folder(), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = join(deps.folder(), entry.name);
    let version = "";
    let id = entry.name;
    let extension = false;
    try {
      const manifest = JSON.parse(readFileSync(join(source, packages.MANIFEST), "utf8"));
      [id, version] = [String(manifest.id), `${manifest.version ?? ""}#${digest(source)}`];
      extension = manifest.kind === extensions.KIND;
      if (manifest.kind !== "interface" && !extension && !running) continue;
    } catch {
      continue;
    }
    const installed = capabilities.load(id);
    const fresh = !(id in given);
    // Uninstalled after it was offered: the user's choice stands. A task's own capability of that
    // name is left alone.
    // An extension cannot be uninstalled, only switched off; another package with its id is left alone.
    if ((!fresh && !installed && !extension) || (installed && installed.source !== "upload")) continue;
    if (extension && installed && installed.kind !== extensions.KIND) {
      log.error(`could not install the shipped extension ${id}: another package has that id`);
      continue;
    }
    if (!fresh && installed && given[id] === version) continue;
    try {
      const capability = await packages.installFolder(source);
      if (fresh) carryOver(capability);
      // New: on, as features are. Updated: as it was.
      if (capability.status !== "failed" && (fresh || !installed || installed.status === "active")) {
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

/** What a shipped package's files hold, so a changed build (the web console's) is installed again
 *  although its version is the same. */
function digest(folder: string): string {
  const hash = createHash("sha256");
  const walk = (parts: string[]) => {
    for (const entry of readdirSync(join(folder, ...parts), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.isDirectory()) walk([...parts, entry.name]);
      else if (entry.isFile()) hash.update(`${[...parts, entry.name].join("/")}\0`).update(readFileSync(join(folder, ...parts, entry.name)));
    }
  };
  walk([]);
  return hash.digest("hex").slice(0, 16);
}
