// Reads or changes the OS keyring for secrets.ts, in a process of its own that can be killed: a
// locked desktop keyring can wait forever for an unlock prompt. The request comes on stdin, the
// answer goes to stdout; secrets travel only through these pipes.
// Usage: keyring-worker [get|set|delete] (with {"provider", "value"} on stdin); without an action,
// every saved provider key not in the environment, as {ENV_NAME: value}.
// SUPER_PARTNER_KEYRING_BACKEND names a module exporting {getPassword, setPassword,
// deletePassword} (service, name[, value]) to use instead of the OS keyring (tests).
import { pathToFileURL } from "node:url";
import { SECRET_ENV, SERVICE } from "./secret-names.js";

type Backend = {
  getPassword(service: string, name: string): string | null | Promise<string | null>;
  setPassword(service: string, name: string, value: string): void | Promise<void>;
  deletePassword(service: string, name: string): boolean | void | Promise<boolean | void>;
};

async function backend(): Promise<Backend> {
  const custom = process.env.SUPER_PARTNER_KEYRING_BACKEND;
  if (custom) return (await import(pathToFileURL(custom).href)) as Backend;
  const { Entry } = await import("@napi-rs/keyring");
  return {
    getPassword: (service, name) => new Entry(service, name).getPassword() ?? null,
    setPassword: (service, name, value) => new Entry(service, name).setPassword(value),
    deletePassword: (service, name) => new Entry(service, name).deletePassword(),
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<number> {
  const action = process.argv[2];
  const keyring = await backend();
  if (action === "get" || action === "set" || action === "delete") {
    const request = JSON.parse(await readStdin()) as { provider: string; value: string | null };
    try {
      if (action === "get") {
        process.stdout.write(JSON.stringify({ value: (await keyring.getPassword(SERVICE, request.provider)) ?? null }));
      } else if (action === "set") {
        await keyring.setPassword(SERVICE, request.provider, request.value ?? "");
      } else {
        try {
          await keyring.deletePassword(SERVICE, request.provider);
        } catch {
          // not there: nothing to delete
        }
      }
    } catch {
      return 2; // never echo the error: it may contain the credential
    }
    return 0;
  }
  const values: Record<string, string> = {};
  let asked = 0;
  let failed = 0;
  for (const [provider, envName] of Object.entries(SECRET_ENV)) {
    if (envName in process.env) continue;
    asked += 1;
    try {
      const value = await keyring.getPassword(SERVICE, provider);
      if (value) values[envName] = value;
    } catch {
      failed += 1;
    }
  }
  // No read worked: a locked or missing keyring, not one holding no keys.
  if (asked && failed === asked) return 3;
  process.stdout.write(JSON.stringify(values));
  return 0;
}

main().then((code) => process.exit(code), () => process.exit(2));
