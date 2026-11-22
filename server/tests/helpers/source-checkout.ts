// test_platform_repair's source_checkout: a FluidForm checkout laid out as after the switch
// (server/ and frontend/, regression tests in server/tests), with data, secrets and tasks that a
// repair must not touch, and the service manager saying this process is its service.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as worker from "../../src/repair-worker.js";

export const API = "server/src/api.ts";

export function sourceCheckout(folder: string): string {
  const root = join(folder, "app");
  const files: Record<string, string> = {
    "server/package.json": "{}\n", "server/src/main.ts": "export {};\n", [API]: "export const VALUE = 'broken';\n// unrelated user edit\n",
    "frontend/package.json": "{}\n", "server/tests/regression.test.ts": "// existing\n",
    "skills/platform-repair/SKILL.md": "---\nname: platform-repair\n---\n# Repairing FluidForm\n", "docs/ARCHITECTURE.md": "# FluidForm architecture map\n",
    "AGENTS.md": "# FluidForm\n", ".fluidform/fluidform.db": "keep task data", ".env": "keep private configuration", "workspaces/kept/file.txt": "keep project",
  };
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), contents);
  }
  worker.deps.serviceProperties = () => ({ MainPID: String(process.pid), WorkingDirectory: root, ActiveState: "active" });
  return root;
}

/** test_platform_repair.edit_candidate: the fix, and a regression test for it. */
export function editCandidate(job: { folder: string }): void {
  const source = join(job.folder, "source");
  writeFileSync(join(source, API), readFileSync(join(source, API), "utf8").replace("broken", "fixed"));
  writeFileSync(join(source, "server/tests/new-regression.test.ts"), "// the regression\n");
}

export const passingCheck = async () => ({ returncode: 0, output: "checks passed" });
