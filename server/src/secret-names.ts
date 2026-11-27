// What FluidForm keeps in the OS keyring, under the service "fluidform"; what it kept as Super
// Partner ("super-partner") is copied over when first read (keyring-worker.ts).
import { KEY_ENV } from "./api-providers.js";

export const SERVICE = "fluidform";
export const FORMER_SERVICE = "super-partner";

// Each API provider's key (api-providers.ts: DeepSeek's and every shipped model package's, on or off).
export const PROVIDER_ENV: Record<string, string> = { ...KEY_ENV };

// Everything kept in the keyring: model provider keys plus the GitHub token used to publish.
export const SECRET_ENV: Record<string, string> = { ...PROVIDER_ENV, github: "GITHUB_TOKEN" };

// Secrets only FluidForm itself reads and hands to one capability (capability packages), named
// capability/<id>/<VARIABLE>: kept in the keyring and never put in this process's environment,
// which the CLIs that steps run inherit.
export const PRIVATE_SECRET = /^capability\/[a-z0-9][a-z0-9-]*\/[A-Za-z_][A-Za-z0-9_]*$/;
