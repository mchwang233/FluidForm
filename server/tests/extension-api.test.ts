// The packages FluidForm ships (server/packages/*/src) reach its core only through src/extension-api.ts,
// so what they depend on is declared in one place.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const packages = new URL("../packages/", import.meta.url).pathname;
const sources = (folder: string): string[] => readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
  const path = join(folder, entry.name);
  if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
  return /\.(ts|mjs|js)$/.test(entry.name) ? [path] : [];
});

test("packages import the core only from extension-api", () => {
  const reaching: string[] = [];
  for (const file of sources(packages)) {
    for (const [, path] of readFileSync(file, "utf8").matchAll(/from\s+"((?:\.\.\/)+src\/[^"]+)"/g)) {
      if (!path.endsWith("src/extension-api.js")) reaching.push(`${relative(packages, file)}: ${path}`);
    }
  }
  assert.deepEqual(reaching, [], "add what a package needs to src/extension-api.ts and import it from there");
});
