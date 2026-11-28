// FluidForm itself does not import an extension's code (docs/design/task-capabilities.md): it loads
// it while the extension is on (extensions.load).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SERVER } from "../src/paths.js";
import * as extensions from "../src/extensions.js";
import { base, planning } from "../src/ports/planning.js";
import { without } from "./helpers/capabilities.js";
import { conftest } from "./helpers/conftest.js";

conftest();

test("nothing in src imports a package's code", () => {
  for (const name of readdirSync(join(SERVER, "src"), { recursive: true }).map(String).filter((item) => item.endsWith(".ts"))) {
    assert.doesNotMatch(readFileSync(join(SERVER, "src", name), "utf8"), /(from|import\()\s*["'][^"']*packages\//, name);
  }
});

test("without the planning capability its code is not used: FluidForm plans one step itself", async () => {
  const restore = without("planning");
  try {
    assert.equal(await planning(), base);
    const plan = await (await planning()).plan({ prompt: "做一个工具", request: "做一个工具", background: null, projectDir: null, projectContext: null,
      models: [], configured: new Set(), session: {} as any, brief: null }, {} as any);
    assert.deepEqual(plan.nodes.map((node) => node.title), ["做一个工具"]);
    await assert.rejects((await planning()).changePlan({} as any, {}, [], new Set()), /没有启用规划能力/);
  } finally {
    restore();
  }
  // On again: the extension's code, which meets the port (its entry's Contract).
  assert.equal(await planning(), await extensions.load("planning"));
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
