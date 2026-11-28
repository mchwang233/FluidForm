// Extensions: the packages shipped with FluidForm that run inside it, with what it may do
// (docs/design/task-capabilities.md). Only the ones in server/packages count: what an installed
// package's record says is whether it is on, never what it provides or where its code is. So an
// uploaded package cannot become one.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PACKAGES } from "./paths.js";
import { log } from "./log.js";
import type { Capability } from "./models.js";

export const KIND = "extension";

/** ``models``: the catalog entries of the models a model package brings (model-channels.ts). */
/** ``provider``: how to reach the API provider a model package brings (api-providers.ts). */
export type Extension = { id: string; name: string; provides: string[]; models: Record<string, unknown>[]; provider: Record<string, unknown> | null };

function read(folder: string): Extension[] {
  if (!existsSync(folder)) return [];
  const found: Extension[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name, "capability.json");
    if (!entry.isDirectory() || !existsSync(path)) continue;
    try {
      const given = JSON.parse(readFileSync(path, "utf8"));
      if (given.kind === KIND) {
        const models = Array.isArray(given.models) ? given.models.filter((item: unknown) => item && typeof item === "object") : [];
        const provider = given.provider && typeof given.provider === "object" && !Array.isArray(given.provider) ? given.provider : null;
        found.push({ id: String(given.id), name: String(given.name), provides: given.provides.map(String), models, provider });
      }
    } catch (error) {
      log.error(`could not read the shipped package ${entry.name}: ${(error as Error).message}`);
    }
  }
  return found;
}

/** The extensions this FluidForm ships, as they were when it started. */
export const shipped: readonly Extension[] = read(PACKAGES);

export const byId = (id: string) => shipped.find((item) => item.id === id) ?? null;
export const providing = (name: string) => shipped.find((item) => item.provides.includes(name)) ?? null;

/** Whether ``extension`` is on: unless the user switched it off (features are on). */
export function on(extension: Extension, library: Capability[]): boolean {
  const record = library.find((item) => item.id === extension.id && item.kind === KIND);
  return !record || record.status === "active";
}

// Beside this module's folder, as source and as built: packages/<id>/src/index.
const entry = (id: string) => fileURLToPath(new URL(`../packages/${id}/src/index${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`, import.meta.url));

const loaded = new Map<string, Promise<any>>();

/** The code of the shipped extension ``id``: never from the data folder, where only its switch is. */
export async function load<T>(id: string): Promise<T> {
  if (!byId(id)) throw new Error(`no shipped extension ${id}`);
  // A package that only declares (an API model provider's) has no code.
  if (!existsSync(entry(id))) return {} as T;
  // Kept, not imported again: import() looks at the disk each time.
  let loading = loaded.get(id);
  if (!loading) {
    loading = import(pathToFileURL(entry(id)).href).then(async (code) => {
      await code.ready?.();
      return code;
    });
    loaded.set(id, loading);
    loading.catch(() => loaded.delete(id));
  }
  return (await loading) as T;
}

/** Read the code of every extension that is on, so that rebuilding the server under a running
 *  FluidForm does not take it away or mix two versions: it runs what it started with. */
export async function preload(library: Capability[]): Promise<void> {
  for (const item of shipped) if (on(item, library)) await load(item.id);
}

/** What a package's code must offer: ``load<Port>`` takes it on trust, so each package's entry states
 *  ``export type Contract = Implements<Port, typeof import("./index.js")>`` and stops compiling when
 *  its exports and the port the core calls it through part (docs/design/capability-ports.md). */
export type Implements<Port, Code extends Port> = Code;
