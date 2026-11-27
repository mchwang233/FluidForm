// Conservative seed data. Unverified prices cannot be used for real billing claims. FluidForm's own:
// DeepSeek and the demo model; every other provider's models come with its
// package (server/packages/<id>/capability.json, builtinModels).
// Routing scores come only from Artificial Analysis (scoring); only the offline demo model carries
// fixed scores.
import type { Database } from "./db.js";
import * as extensions from "./extensions.js";
import { type ModelProfile, ModelProfileSchema } from "./models.js";

const SEED: Record<string, unknown>[] = [
  { id: "deepseek:deepseek-chat", provider: "deepseek", display_name: "DeepSeek Chat", context_window: 128_000,
    input_per_million: 0.3, output_per_million: 1.2, pricing_verified: false },
  { id: "mock:local", provider: "mock", display_name: "Local Demo Model", context_window: 128_000,
    input_per_million: 0.01, output_per_million: 0.02,
    scores: { coding: 80, planning: 80, research: 80, chinese: 80, tool_use: 80, structured_output: 80, reliability: 80 },
    scores_source: "demo", pricing_verified: true, execution_priority: 1000 },
];

/** FluidForm's own models: DeepSeek and the demo model. */
export function ownModels(): ModelProfile[] {
  return SEED.map((model) => ModelProfileSchema.parse(model));
}

/** What the catalog is seeded with: FluidForm's own models, and those the shipped model packages
 *  bring (on or off: off, they are not offered; model-channels.ts, api-providers.ts). */
export function builtinModels(): ModelProfile[] {
  return [...ownModels(), ...extensions.shipped.flatMap((item) => item.models).map((model) => ModelProfileSchema.parse(model))];
}

/** The catalog: what is saved, with the seed's missing entries added. Restarting must preserve
 *  discoveries and user choices (model research, packages/research, finds the rest). */
export function seedCatalog(db: Database): Record<string, ModelProfile> {
  const models: Record<string, ModelProfile> = Object.fromEntries(db.listModels().map((model) => [model.id, model]));
  const missing = builtinModels().filter((model) => !(model.id in models));
  db.saveModels(missing);
  for (const model of missing) models[model.id] = model;
  return models;
}

/** Where routing scores come from (model research's scoring): a model without them is not listed or routed. */
export const AA_SOURCE = "artificial_analysis";
