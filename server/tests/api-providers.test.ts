// api-providers.ts and the API model packages (server/packages/{openai,anthropic,google,qwen,doubao,
// glm,minimax,kimi}): DeepSeek is FluidForm's own, every other provider a package that only declares.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as apiProviders from "../src/api-providers.js";
import { PROVIDERS } from "../src/benchmarks.js";
import { builtinModels, ownModels } from "../src/catalog.js";
import { OFFICIAL_URLS, PUBLIC_PROVIDERS } from "../src/catalog-sync.js";
import { ProviderRegistry, reasoningFields } from "../src/providers.js";
import { PROVIDER_ENV } from "../src/secret-names.js";

const savedOn = apiProviders.deps.on;
const savedEnv = { ...process.env };
afterEach(() => {
  apiProviders.deps.on = savedOn;
  for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name];
  Object.assign(process.env, savedEnv);
});

const PACKAGED = ["anthropic", "doubao", "glm", "google", "kimi", "minimax", "openai", "qwen"];

test("DeepSeek is FluidForm's own provider; every other one comes from its package", () => {
  assert.deepEqual(apiProviders.declared.map((item) => item.id).sort(), ["deepseek", ...PACKAGED].sort());
  assert.equal(apiProviders.ownerOf("deepseek"), null);
  for (const id of PACKAGED) assert.equal(apiProviders.ownerOf(id)?.id, id);
  // FluidForm's own seed holds no other provider's models; their packages bring them.
  assert.ok(ownModels().every((model) => model.channel === "cli" || ["deepseek", "mock"].includes(model.provider)));
  assert.ok(builtinModels().some((model) => model.id === "kimi:kimi-k3"));
  assert.ok(builtinModels().some((model) => model.id === "anthropic:claude-sonnet-5"));
});

test("every provider's key keeps its name, so keys saved before are still found", () => {
  assert.deepEqual(PROVIDER_ENV, {
    openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", google: "GEMINI_API_KEY", deepseek: "DEEPSEEK_API_KEY",
    qwen: "DASHSCOPE_API_KEY", doubao: "ARK_API_KEY", glm: "ZHIPU_API_KEY", minimax: "MINIMAX_API_KEY", kimi: "MOONSHOT_API_KEY",
  });
});

test("the catalog and the leaderboards read the same sources as before", () => {
  assert.deepEqual(PUBLIC_PROVIDERS, { openai: "openai", anthropic: "anthropic", google: "google", deepseek: "deepseek", qwen: "alibaba-cn",
    doubao: "volcengine", glm: "zhipuai", minimax: "minimax", kimi: "moonshotai-cn" });
  assert.deepEqual(OFFICIAL_URLS, { openai: "https://api.openai.com/v1/models", anthropic: "https://api.anthropic.com/v1/models",
    google: "https://generativelanguage.googleapis.com/v1beta/models", deepseek: "https://api.deepseek.com/models" });
  assert.deepEqual(PROVIDERS, {
    openai: "openai", anthropic: "anthropic", google: "google", googledeepmind: "google", deepseek: "deepseek", 深度求索: "deepseek",
    alibaba: "qwen", alibabacloud: "qwen", 阿里巴巴: "qwen", 阿里云: "qwen", 字节跳动: "doubao", bytedance: "doubao", 火山引擎: "doubao",
    zai: "glm", zhipuai: "glm", 智谱ai: "glm", 智谱: "glm", minimax: "minimax", 稀宇科技: "minimax", moonshotai: "kimi", 月之暗面: "kimi", kimi: "kimi",
  });
});

test("each provider is asked for a reasoning effort as before", () => {
  const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "odd"];
  // What FluidForm asked each for before the providers became packages.
  const before = (provider: string, effort: string) => {
    const scale = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
    let level = scale.includes(effort) ? effort : effort === "ultra" ? "max" : "medium";
    const rank = (name: string) => scale.indexOf(name);
    if (provider === "anthropic") return { output_config: { effort: ({ none: "low", minimal: "low" } as Record<string, string>)[level] ?? level } };
    if (provider === "google") return { generationConfig: { thinkingConfig: { thinkingLevel: rank(level) <= rank("low") ? "low" : "high" } } };
    if (provider === "deepseek") return { reasoning_effort: effort };
    if (provider === "glm") return { reasoning_effort: rank(level) <= rank("low") ? "low" : rank(level) <= rank("high") ? "high" : "max" };
    if (provider === "openai" && level === "max") level = "xhigh";
    return { reasoning_effort: level };
  };
  for (const provider of ["deepseek", ...PACKAGED]) {
    for (const effort of efforts) assert.deepEqual(reasoningFields(provider, effort), before(provider, effort), `${provider} ${effort}`);
  }
});

test("a provider whose package is off is not offered, and keeps its key", async () => {
  process.env.MOONSHOT_API_KEY = "k";
  process.env.DEEPSEEK_API_KEY = "d";
  const registry = new ProviderRegistry(null as never, {} as never);
  assert.ok(registry.configuredModels(["kimi:kimi-k3", "deepseek:deepseek-chat"]).has("kimi:kimi-k3"));
  apiProviders.deps.on = (extension) => extension.id !== "kimi";
  assert.ok(!apiProviders.inUse("kimi"));
  assert.ok(!apiProviders.active().some((item) => item.id === "kimi"));
  const configured = registry.configuredModels(["kimi:kimi-k3", "deepseek:deepseek-chat"]);
  assert.ok(!configured.has("kimi:kimi-k3"));
  assert.ok(configured.has("deepseek:deepseek-chat"), "FluidForm's own provider stays");
  assert.equal(PROVIDER_ENV.kimi, "MOONSHOT_API_KEY", "its key is still read from the keyring");
  await assert.rejects(registry.complete("kimi:kimi-k3", "hi"), /没有启用/);
  // DeepSeek cannot be switched off: no package owns it.
  apiProviders.deps.on = () => false;
  assert.ok(apiProviders.inUse("deepseek"));
});
