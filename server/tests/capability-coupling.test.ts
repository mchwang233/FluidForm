// How tightly the task capabilities (server/packages/*/src) are tied to the core, counted from the
// source (docs/design/capability-ports.md). Each count may only go down: a package that needs more of
// the core gets it through its port and host, not through the executor or a wider extension-api.
// When a count goes down, lower its number here, so it cannot creep back up.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SERVER } from "../src/paths.js";

const EXPECTED = {
  // Package functions that run as the executor (``this: Leading``, …) and so can reach all of it.
  executorBound: 21,
  // Core methods that hand the executor to a package (``.call(this, …)``).
  bridges: 43,
  // Places in the core that ask for a capability by name (``uses.lead()``, ``available("lead")``),
  // besides features.ts and provided.ts, which answer them.
  namedChecks: 47,
  // Core modules extension-api hands to packages whole (``export * as``), and names it hands one by one.
  apiModules: 14,
  apiNames: 199,
};

const LAYERS = /\bthis:\s*(?:ExecutorBase|Reviewing|Leading|Diagnosing|SelfRepair|Engineering|Preflighting|Executor)\b/g;

function files(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const count = (texts: string[], pattern: RegExp) => texts.reduce((sum, text) => sum + [...text.matchAll(pattern)].length, 0);

function measure() {
  const packages = join(SERVER, "packages");
  const packageCode = readdirSync(packages, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .flatMap((entry) => { try { return files(join(packages, entry.name, "src")); } catch { return []; } })
    .map((path) => readFileSync(path, "utf8"));
  const core = files(join(SERVER, "src"));
  const coreCode = core.map((path) => readFileSync(path, "utf8"));
  const asking = core.filter((path) => !/[/\\](features|provided)\.ts$/.test(path)).map((path) => readFileSync(path, "utf8"));
  const api = readFileSync(join(SERVER, "src", "extension-api.ts"), "utf8");
  const named = [...api.matchAll(/^export (?:type )?\{([^}]*)\}/gm)].flatMap((match) => match[1].split(",").map((name) => name.trim()).filter(Boolean));
  return {
    executorBound: count(packageCode, LAYERS),
    bridges: count(coreCode, /\.call\(this\b/g),
    namedChecks: count(asking, /\buses\.[A-Za-z]+\(/g) + count(asking, /\bavailable\(\s*"[a-z-]+"/g),
    apiModules: count([api], /^export \* as /gm),
    apiNames: named.length,
  };
}

test("the task capabilities are no more tied to the core than before", () => {
  const now = measure();
  for (const [name, expected] of Object.entries(EXPECTED) as [keyof typeof EXPECTED, number][]) {
    assert.ok(now[name] <= expected, `${name} went up from ${expected} to ${now[name]}: give the package what it needs through `
      + "its port and host instead (docs/design/capability-ports.md)");
    assert.equal(now[name], expected, `${name} went down from ${expected} to ${now[name]}: lower EXPECTED.${name} to ${now[name]} so it stays down`);
  }
});
