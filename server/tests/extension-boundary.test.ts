// FluidForm itself does not import an extension's code (docs/design/task-capabilities.md): it loads
// it while the extension is on (extensions.load).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SERVER } from "../src/paths.js";
import * as planning from "../src/planning.js";
import { without } from "./helpers/capabilities.js";
import { conftest } from "./helpers/conftest.js";

conftest();

test("nothing in src imports a package's code", () => {
  for (const name of readdirSync(join(SERVER, "src")).filter((item) => item.endsWith(".ts"))) {
    assert.doesNotMatch(readFileSync(join(SERVER, "src", name), "utf8"), /(from|import\()\s*["'][^"']*packages\//, name);
  }
});

test("without the planning capability its code is not used", async () => {
  const restore = without("planning");
  try {
    await assert.rejects(planning.autonomousPlan("做一个工具", [], new Set(), {}), /没有启用规划能力/);
  } finally {
    restore();
  }
});

test("loading an extension reads all of its code: nothing is left to read from a rebuilt disk", () => {
  for (const id of ["planning", "lead", "engineer", "learning"]) {
    const folder = join(SERVER, "packages", id, "src");
    const read = new Set<string>();
    const follow = (name: string) => {
      if (read.has(name)) return;
      read.add(name);
      for (const match of readFileSync(join(folder, name), "utf8").matchAll(/^(?:import|export)\b[^;]*?["']\.\/([\w-]+)\.js["'];/gm)) follow(`${match[1]}.ts`);
    };
    follow("index.ts");
    assert.deepEqual(readdirSync(folder).filter((name) => name.endsWith(".ts") && !read.has(name)), [], id);
  }
});
