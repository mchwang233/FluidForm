// Model research (server/packages/research, research.ts): the catalogs, prices, leaderboards and
// routing scores are a capability, switched on and off without a restart.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as bundled from "../src/bundled.js";
import { settings } from "../src/config.js";
import { uses } from "../src/features.js";
import * as research from "../src/research.js";
import { conftest } from "./helpers/conftest.js";
import { taskApi } from "./helpers/task-api.js";

const { folder } = conftest();
const ORIGIN = { origin: "http://localhost:5173" };

test("model research is a capability: off, nothing is looked up and the scores stay; on again, it runs", async () => {
  settings.catalog_auto_sync = false; // nothing fetched from the internet by itself
  const { api, client } = taskApi(folder());
  await bundled.offer();
  api.start();
  try {
    await research.begin(api.db, api.models);
    assert.ok(uses.research());
    const status = (await client.get("/api/models/sync")).json();
    assert.equal(status.disabled, undefined);
    assert.ok("benchmarks" in status, "its look-ups are reported");
    const set = (enabled: boolean) => client.patch("/api/capabilities/research", { json: { enabled, confirmed: true }, headers: ORIGIN });

    const scored = Object.values(api.models).map((model) => model.scores);
    assert.equal((await set(false)).status_code, 200);
    assert.ok(!uses.research());
    assert.equal(research.current(), null, "switched off, it stops at once");
    assert.equal((await client.get("/api/models/sync")).json().disabled, true);
    const refused = await client.post("/api/models/sync", { headers: ORIGIN });
    assert.equal(refused.status_code, 409);
    assert.match(refused.text, /模型调研已停用/);
    // The models keep the scores they had.
    assert.deepEqual(Object.values(api.models).map((model) => model.scores), scored);

    assert.equal((await set(true)).status_code, 200);
    assert.notEqual(research.current(), null, "switched on, it runs again without a restart");
    assert.equal((await client.get("/api/models/sync")).json().disabled, undefined);
  } finally {
    await api.close();
  }
});
