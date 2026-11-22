// What FluidForm kept as Super Partner, moved to its new names when it starts (rename.ts).
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { settings } from "../src/config.js";
import { migrate, moveFolder } from "../src/rename.js";
import { conftest } from "./helpers/conftest.js";

const { folder } = conftest();

test("the data folder, its database and the leads' folders move to FluidForm's names, linked from the old", () => {
  const former = join(folder(), ".super-partner");
  mkdirSync(join(former, "tools"), { recursive: true });
  writeFileSync(join(former, "super-partner.db"), "db");
  writeFileSync(join(former, "super-partner.db-wal"), "wal");
  writeFileSync(join(former, "tools", "tool"), "t");
  const cache = join(folder(), "cache");
  mkdirSync(join(cache, "super-partner", "leads"), { recursive: true });
  process.env.XDG_CACHE_HOME = cache;
  Object.assign(settings, { data_dir: join(folder(), ".fluidform"), database_path: null, lead_root: "" });
  migrate();
  assert.deepEqual([readFileSync(join(folder(), ".fluidform", "fluidform.db"), "utf8"), readFileSync(join(folder(), ".fluidform", "fluidform.db-wal"), "utf8")],
    ["db", "wal"]);
  // A path kept in a record still reaches it.
  assert.ok(lstatSync(former).isSymbolicLink() && readFileSync(join(former, "tools", "tool"), "utf8") === "t");
  assert.equal(realpathSync(join(cache, "super-partner")), realpathSync(join(cache, "fluidform")));
  // Once moved, nothing moves again; nothing is overwritten.
  migrate();
  assert.equal(moveFolder(join(folder(), "nothing"), join(folder(), "else")), false);
  mkdirSync(join(folder(), "a"));
  mkdirSync(join(folder(), "b"));
  assert.equal(moveFolder(join(folder(), "a"), join(folder(), "b")), false);
  assert.ok(existsSync(join(folder(), "a")));
});
