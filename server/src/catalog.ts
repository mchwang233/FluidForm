// Conservative seed data. Unverified prices cannot be used for real billing claims. FluidForm's own:
// the membership CLIs, DeepSeek and the demo model; every other provider's models come with its
// package (server/packages/<id>/capability.json, builtinModels).
// Routing scores come only from Artificial Analysis (scoring); only the offline demo model carries
// fixed scores.
import * as extensions from "./extensions.js";
import { type ModelProfile, ModelProfileSchema } from "./models.js";

const SEED: Record<string, unknown>[] = [
  { id: "cli:codex", provider: "openai", display_name: "Codex CLI (membership)", context_window: 1_000_000,
    input_per_million: 0, output_per_million: 0, supports_vision: true, pricing_verified: true, channel: "cli", execution_priority: 0 },
  { id: "cli:claude", provider: "anthropic", display_name: "Claude Code CLI (membership)", context_window: 200_000,
    input_per_million: 0, output_per_million: 0, supports_vision: true, pricing_verified: true, channel: "cli", execution_priority: 0 },
  { id: "cli:gemini", provider: "google", display_name: "Gemini CLI (membership)", context_window: 1_000_000,
    input_per_million: 0, output_per_million: 0, supports_vision: true, pricing_verified: true, channel: "cli", execution_priority: 0 },
  { id: "cli:qwen", provider: "qwen", display_name: "Qwen Code CLI (membership)", context_window: 128_000,
    input_per_million: 0, output_per_million: 0, pricing_verified: true, channel: "cli", execution_priority: 0 },
  { id: "deepseek:deepseek-chat", provider: "deepseek", display_name: "DeepSeek Chat", context_window: 128_000,
    input_per_million: 0.3, output_per_million: 1.2, pricing_verified: false },
  { id: "mock:local", provider: "mock", display_name: "Local Demo Model", context_window: 128_000,
    input_per_million: 0.01, output_per_million: 0.02,
    scores: { coding: 80, planning: 80, research: 80, chinese: 80, tool_use: 80, structured_output: 80, reliability: 80 },
    scores_source: "demo", pricing_verified: true, execution_priority: 1000 },
];

/** FluidForm's own models: the membership CLIs, DeepSeek and the demo model. */
export function ownModels(): ModelProfile[] {
  return SEED.map((model) => ModelProfileSchema.parse(model));
}

/** What the catalog is seeded with: FluidForm's own models, and those the shipped model packages
 *  bring (on or off: off, they are not offered; model-channels.ts, api-providers.ts). */
export function builtinModels(): ModelProfile[] {
  return [...ownModels(), ...extensions.shipped.flatMap((item) => item.models).map((model) => ModelProfileSchema.parse(model))];
}
