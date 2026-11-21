// What FluidForm keeps in the OS keyring, under the service "super-partner".
export const SERVICE = "super-partner";

export const PROVIDER_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY", deepseek: "DEEPSEEK_API_KEY",
  qwen: "DASHSCOPE_API_KEY", doubao: "ARK_API_KEY",
  glm: "ZHIPU_API_KEY", minimax: "MINIMAX_API_KEY", kimi: "MOONSHOT_API_KEY",
};

// Everything kept in the keyring: model provider keys plus the GitHub token used to publish.
export const SECRET_ENV: Record<string, string> = { ...PROVIDER_ENV, github: "GITHUB_TOKEN" };

// Secrets only FluidForm itself reads and hands to one capability (capability packages), named
// capability/<id>/<VARIABLE>: kept in the keyring and never put in this process's environment,
// which the CLIs that steps run inherit.
export const PRIVATE_SECRET = /^capability\/[a-z0-9][a-z0-9-]*\/[A-Za-z_][A-Za-z0-9_]*$/;
