// An automation's chat through the real provider adapters: pricing only keeps count
// (docs/design/capability-packages.md, Spending).
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { settings } from "../src/config.js";
import { Database } from "../src/db.js";
import { Executor } from "../src/executor.js";
import { ExecutionRunSchema, ModelProfileSchema } from "../src/models.js";
import * as pricing from "../src/pricing.js";
import { deepseek, isolated, registryWith } from "./helpers/providers.js";

const { folder } = isolated();

for (const automation of [true, false]) {
  test(`pricing not answering ${automation ? "does not stop an automation's chat" : "stops a chat on the page"}`, async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    settings.chat_tools = false;
    const id = "deepseek:deepseek-flash";
    const model = ModelProfileSchema.parse({ id, provider: "deepseek", display_name: "Flash", context_window: 128000,
      input_per_million: 1, output_per_million: 1, scores: { coding: 80, planning: 80, reliability: 80 } });
    const registry = registryWith([deepseek({ content: "答好了" }, "stop")]);
    Object.assign(registry.models, { [id]: model });
    const db = new Database(join(folder(), "chat.db"));
    db.saveRun(ExecutionRunSchema.parse({ id: "c", prompt: "在吗", kind: "chat", status: "draft", budget_usd: 1, actual_cost_usd: 50,
      ...(automation ? { origin: { capability: "bot" } } : {}), supervisor: { model_id: id, cwd: join(folder(), "chat") },
      plan: { summary: "在吗", nodes: [] } }));
    const ask = pricing.deps.ask;
    pricing.deps.ask = async () => {
      throw new Error("连不上");
    };
    try {
      const executor = new Executor(db, registry as any, { [id]: model });
      const answered = executor.askLead("c", "在吗");
      if (automation) assert.equal(await answered, "答好了");
      else await assert.rejects(answered, /停止花钱/);
    } finally {
      pricing.deps.ask = ask;
      db.close();
    }
  });
}
