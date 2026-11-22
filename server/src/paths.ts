// Where this FluidForm's server is, the same from its source (src/) and as built (dist/src/).
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function find(folder: string): string {
  if (existsSync(join(folder, "package.json")) && existsSync(join(folder, "packages"))) return folder;
  const up = dirname(folder);
  if (up === folder) throw new Error("FluidForm's server folder was not found");
  return find(up);
}

/** The server folder. */
export const SERVER = find(dirname(fileURLToPath(import.meta.url)));
/** The packages shipped with FluidForm. */
export const PACKAGES = join(SERVER, "packages");
