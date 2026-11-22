// Extensions: the packages shipped with FluidForm that run inside it, with what it may do
// (docs/design/task-capabilities.md). Only the ones in server/packages count: what an installed
// package's record says is whether it is on, never what it provides or where its code is. So an
// uploaded package cannot become one.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./log.js";
import type { Capability } from "./models.js";

export const KIND = "extension";

export type Extension = { id: string; name: string; provides: string[] };

function read(folder: string): Extension[] {
  if (!existsSync(folder)) return [];
  const found: Extension[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name, "capability.json");
    if (!entry.isDirectory() || !existsSync(path)) continue;
    try {
      const given = JSON.parse(readFileSync(path, "utf8"));
      if (given.kind === KIND) found.push({ id: String(given.id), name: String(given.name), provides: given.provides.map(String) });
    } catch (error) {
      log.error(`could not read the shipped package ${entry.name}: ${(error as Error).message}`);
    }
  }
  return found;
}

/** The extensions this FluidForm ships, as they were when it started. */
export const shipped: readonly Extension[] = read(fileURLToPath(new URL("../packages/", import.meta.url)));

export const byId = (id: string) => shipped.find((item) => item.id === id) ?? null;
export const providing = (name: string) => shipped.find((item) => item.provides.includes(name)) ?? null;

/** Whether ``extension`` is on: unless the user switched it off (features are on). */
export function on(extension: Extension, library: Capability[]): boolean {
  const record = library.find((item) => item.id === extension.id && item.kind === KIND);
  return !record || record.status === "active";
}
