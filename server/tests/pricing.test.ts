// The pricing package (server/packages/pricing) as FluidForm runs it: shipped, installed and enabled at
// the first start, a service answering over JSON-RPC in the capabilities' sandbox; and FluidForm
// without it (docs/design/chat-and-pricing-packages.md).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import * as bundled from "../src/bundled.js";
import * as capabilities from "../src/capabilities.js";
import * as sandbox from "../src/capability-sandbox.js";
import { settings } from "../src/config.js";
import { ModelProfileSchema, TaskNodeSchema } from "../src/models.js";
import * as pricing from "../src/pricing.js";
import * as routing from "../src/routing.js";
import * as secrets from "../src/secrets.js";
import * as services from "../src/services.js";
import { conftest } from "./helpers/conftest.js";
import { withoutPricing } from "./helpers/pricing.js";
import { type Client, taskApi } from "./helpers/task-api.js";

const { folder } = conftest();
const ORIGIN = { origin: "http://localhost:5173" };
const saved = { sandbox: { ...sandbox.deps }, pricing: { ...pricing.deps }, runWorker: secrets.deps.runWorker };
const hosts: services.ServiceHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stopAll();
  Object.assign(sandbox.deps, saved.sandbox);
  Object.assign(pricing.deps, saved.pricing);
  secrets.deps.runWorker = saved.runWorker;
});

/** The API with packages allowed and the shipped packages offered, run without bwrap; pricing asked
 *  of the real service, not in-process. */
async function shipped(): Promise<{ api: ReturnType<typeof taskApi>["api"]; client: Client }> {
  const given = taskApi(folder());
  settings.capability_packages = true;
  sandbox.deps.missing = () => "";
  sandbox.deps.wrap = (where, _data, command, env) => ["env", "-i", ...Object.entries({ ...env, PATH: `${env.PATH}:${process.env.PATH}` })
    .map(([name, value]) => `${name}=${value}`), "/bin/bash", "-c", `cd '${where}' && ${command}`];
  secrets.deps.runWorker = async () => ({ code: 0, stdout: '{"value": null}', timedOut: false });
  hosts.push(given.api.services);
  pricing.deps.enabled = () => services.available("pricing");
  pricing.deps.ask = (method, params) => given.api.services.request("pricing", method, params);
  for (const item of await bundled.offer()) given.api.services.start(item);
  return given;
}

const api = (id: string, price: number) => ModelProfileSchema.parse({ id, provider: id.split(":")[0], display_name: id, context_window: 200_000,
  input_per_million: price, output_per_million: price * 4, cached_input_per_million: price / 10,
  scores: { coding: 90, planning: 90, research: 90, chinese: 90, tool_use: 90, structured_output: 90, reliability: 90 } });

test("the pricing package ships enabled, and prices over JSON-RPC in its sandbox", async () => {
  const { client } = await shipped();
  const installed = capabilities.load("pricing")!;
  assert.deepEqual([installed.kind, installed.status, installed.provides], ["service", "active", ["pricing"]]);
  assert.deepEqual((await client.get("/api/capabilities/provided")).json().pricing, "pricing");
  // What the package says a call cost is what the formula gives.
  const flash = api("deepseek:flash", 0.15);
  assert.ok(Math.abs(await pricing.charge(flash, 10_000, 100, 9_000) - (1_000 * 0.15 + 9_000 * 0.015 + 100 * 0.6) / 1e6) < 1e-12);
  // A cheaper model is chosen, and the task estimated.
  const step = TaskNodeSchema.parse({ id: "n", title: "t", instructions: "i", capability: "coding", quality_threshold: 80 });
  const dear = api("x:dear", 3);
  const routed = await routing.routeNode(step, [dear, flash], new Set([dear.id, flash.id]));
  assert.equal(routed.model_id, flash.id);
  assert.ok(routed.estimated_cost_usd > 0);
  assert.equal((await pricing.estimate([routed], 2))!.hard_limit_usd, 2);
  // Offered once: uninstalled, it stays so.
  assert.equal((await client.delete("/api/capabilities/pricing", { headers: ORIGIN })).status_code, 204);
  assert.deepEqual(await bundled.offer(), []);
  assert.equal(capabilities.load("pricing"), null);
  assert.ok(!pricing.enabled());
  const offered = JSON.parse(readFileSync(join(settings.data_dir, "bundled.json"), "utf8"));
  assert.ok(offered.pricing.startsWith("1.0.0#") && /^\d+\.\d+\.\d+#/.test(offered.chat), JSON.stringify(offered));
});

test("switched off, the pricing package stops answering and nothing more is priced", async () => {
  const { client, api: app } = await shipped();
  assert.equal((await client.patch("/api/capabilities/pricing", { json: { enabled: false }, headers: ORIGIN })).status_code, 200);
  assert.ok(!app.services.running("pricing") && !pricing.enabled());
  assert.equal(await pricing.charge(api("x:a", 1), 1_000_000, 0), 0);
  assert.equal(await pricing.estimate([], 2), null);
});

test("enabled but not answering, pricing stops the spending", async () => {
  await shipped();
  pricing.deps.ask = async () => {
    throw new services.ServiceError("charge 在 30 秒内没有回答");
  };
  await assert.rejects(pricing.charge(api("x:a", 1), 10, 10), (error) => error instanceof pricing.PricingUnavailable && /停止花钱/.test(error.message));
});

test("without pricing, models are chosen by score alone, and a model without a price can be", async () => {
  const restore = withoutPricing();
  try {
    const step = TaskNodeSchema.parse({ id: "n", title: "t", instructions: "i", capability: "coding", quality_threshold: 80 });
    const strong = ModelProfileSchema.parse({ ...api("x:strong", 9), input_per_million: null, output_per_million: null,
      scores: { ...api("x:a", 1).scores!, coding: 99 } });
    const cheap = api("x:cheap", 0.1);
    const hard = { ...step, difficulty: "hard" } as typeof step;
    await routing.routeNode(hard, [cheap, strong], new Set([cheap.id, strong.id]));
    assert.equal(hard.model_id, strong.id);
    assert.equal(hard.estimated_cost_usd, 0);
    assert.match(hard.routing_note!, /选分最高的/);
    assert.equal(await pricing.estimate([hard], 2), null);
  } finally {
    restore();
  }
});
