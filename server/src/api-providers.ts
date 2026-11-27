// API model providers (docs/design/model-packages.md): DeepSeek is FluidForm's own; every other
// provider comes from a model package shipped in server/packages, a capability.json with no code: its
// "provider" (how to reach it) and its "models" (catalog entries). FluidForm keeps the wire protocols
// (OpenAI-compatible, Anthropic, Gemini), the keys and the calls; a package says which protocol it
// speaks and where. Switched off, its models are not offered and its key is kept.
import * as extensions from "./extensions.js";
import type { Capability } from "./models.js";

/** How FluidForm talks to it: an OpenAI-compatible chat API, or Anthropic's or Gemini's own. */
export type Wire = "openai" | "anthropic" | "gemini";

export type ApiProvider = {
  /** The prefix of its model ids ("kimi" for "kimi:kimi-k3"). */
  id: string;
  /** What the page calls it. */
  label: string;
  /** The environment variable its key is kept in (and its name in the keyring). */
  key_env: string;
  wire: Wire;
  /** Its chat completions endpoint (the OpenAI-compatible wire). */
  chat_url?: string;
  /** The list of its models: a key is checked against it; with ``official``, the catalog reads it too. */
  models_url: string;
  official?: boolean;
  /** Its provider in the public catalog (models.dev). */
  catalog?: string;
  /** What leaderboards call its maker. */
  aliases?: string[];
  /** The reasoning efforts it takes, least first; a request for another gets the next it takes up,
   *  or its most. Without, the whole scale. */
  efforts?: string[];
  /** It takes the effort as given, unscaled. */
  raw_effort?: boolean;
  /** The request field limiting the output (OpenAI calls it max_completion_tokens). */
  max_tokens_field?: string;
};

/** FluidForm's own provider: always there, whatever packages are on. */
export const CORE: ApiProvider = {
  id: "deepseek", label: "DeepSeek", key_env: "DEEPSEEK_API_KEY", wire: "openai",
  chat_url: "https://api.deepseek.com/chat/completions", models_url: "https://api.deepseek.com/models", official: true,
  catalog: "deepseek", aliases: ["deepseek", "深度求索"], raw_effort: true,
};

function fromPackage(item: extensions.Extension): ApiProvider | null {
  const given = item.provider as Partial<ApiProvider> | null;
  if (!given || typeof given.id !== "string" || typeof given.key_env !== "string" || typeof given.models_url !== "string") return null;
  if (!["openai", "anthropic", "gemini"].includes(String(given.wire))) return null;
  return { label: given.id, ...given } as ApiProvider;
}

/** Every provider FluidForm knows: its own, and each shipped package's, on or off. */
export const declared: readonly ApiProvider[] = [CORE, ...extensions.shipped.map(fromPackage).filter((item): item is ApiProvider => item !== null)];

export const byId = (id: string): ApiProvider | null => declared.find((item) => item.id === id) ?? null;

/** The package that brings ``id``; null for FluidForm's own. */
export const ownerOf = (id: string) => (id === CORE.id ? null : extensions.providing(`model:api:${id}`));

// The switches (capabilities on disk). provided.ts hands its reader over when it loads: importing it
// here would be a cycle (secret-names, which the keyring's own process reads, starts from this module).
let library: () => Capability[] = () => [];
export function readSwitchesWith(read: () => Capability[]): void {
  library = read;
}

// What tests replace: whether a package is on.
export const deps = {
  on: (extension: extensions.Extension): boolean => extensions.on(extension, library()),
};

/** Whether ``id`` is offered now: FluidForm's own, or its package is on. */
export function inUse(id: string): boolean {
  if (!byId(id)) return false;
  const owner = ownerOf(id);
  return owner === null || deps.on(owner);
}

/** The providers offered now. */
export const active = (): ApiProvider[] => declared.filter((item) => inUse(item.id));

/** The provider of ``modelId`` ("kimi:kimi-k3"), if it is offered now. */
export const ofModel = (modelId: string): ApiProvider | null => {
  const provider = byId(modelId.split(":", 1)[0]);
  return provider && inUse(provider.id) ? provider : null;
};

/** Every provider's key variable, on or off: the keyring keeps them all. */
export const KEY_ENV: Record<string, string> = Object.fromEntries(declared.map((item) => [item.id, item.key_env]));
