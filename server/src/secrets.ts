// API keys and private secrets in the OS keyring. The keyring
// is only ever touched in a child process (keyring-worker.ts) that is killed when it takes too
// long: a locked desktop keyring can wait forever for an unlock prompt. Secrets travel in pipes,
// never on a command line, in a log line or on disk.
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { extname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { log } from "./log.js";
import { PRIVATE_SECRET, PROVIDER_ENV, SECRET_ENV } from "./secret-names.js";

export { PRIVATE_SECRET, PROVIDER_ENV, SECRET_ENV, SERVICE } from "./secret-names.js";

export const timing = { KEYRING_TIMEOUT: 5.0, KEYRING_RETRY_SECONDS: 30.0 };

export class KeyringUnavailable extends Error {
  constructor(message = "The OS keyring did not respond; it may be locked") {
    super(message);
  }
}

type Answer = { code: number | null; stdout: string; timedOut: boolean };

const here = fileURLToPath(import.meta.url);
const WORKER = join(here, "..", `keyring-worker${extname(here)}`);

/** Runs the worker with ``input`` on stdin; kills it after ``seconds``. */
function runWorker(args: string[], input: string, seconds: number): Promise<Answer> {
  // Run as this process runs: compiled JS directly, TS source through tsx.
  // (tsx found from this file, not from wherever the service was started).
  const loader = extname(here) === ".ts" ? ["--import", import.meta.resolve("tsx")] : [];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...loader, WORKER, ...args], { stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, seconds * 1000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, stdout: "", timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, timedOut });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

// What tests replace: how the worker is run.
export const deps = { runWorker };

/** Change the keyring in a child process that can be killed. */
async function keyringWrite(action: "set" | "delete", provider: string, value: string | null = null,
  seconds = timing.KEYRING_TIMEOUT): Promise<void> {
  const answer = await deps.runWorker([action], JSON.stringify({ provider, value }), seconds);
  if (answer.timedOut || answer.code === null) throw new KeyringUnavailable();
  if (answer.code) throw new KeyringUnavailable("No usable OS keyring is available");
}

/** Store a key and use it now; "keyring", or "session" if only kept in memory. */
export async function setProviderKey(provider: string, value: string): Promise<"keyring" | "session"> {
  if (!(provider in SECRET_ENV)) throw new Error(`Unsupported provider: ${provider}`);
  let stored: "keyring" | "session" = "keyring";
  try {
    await keyringWrite("set", provider, value);
  } catch {
    log.warning(`OS keyring unavailable; the ${provider} key is kept for this session only.`);
    stored = "session";
  }
  process.env[SECRET_ENV[provider]] = value;
  return stored;
}

/** Stop using a key; "keyring", or "session" if a saved copy may still be in the keyring. */
export async function deleteProviderKey(provider: string): Promise<"keyring" | "session"> {
  if (!(provider in SECRET_ENV)) throw new Error(`Unsupported provider: ${provider}`);
  let removed: "keyring" | "session" = "keyring";
  try {
    await keyringWrite("delete", provider);
  } catch {
    removed = "session";
  }
  delete process.env[SECRET_ENV[provider]];
  return removed;
}

// Kept here for this session when the keyring cannot be used.
export const sessionSecrets = new Map<string, string>();

function checkPrivate(name: string): void {
  if (!PRIVATE_SECRET.test(name)) throw new Error(`Unsupported secret: ${name}`);
}

/** Store a private secret; "keyring", or "session" if only kept in memory. */
export async function setSecret(name: string, value: string): Promise<"keyring" | "session"> {
  checkPrivate(name);
  sessionSecrets.set(name, value);
  try {
    await keyringWrite("set", name, value);
  } catch {
    log.warning(`OS keyring unavailable; ${name} is kept for this session only.`);
    return "session";
  }
  return "keyring";
}

export async function deleteSecret(name: string): Promise<void> {
  checkPrivate(name);
  sessionSecrets.delete(name);
  try {
    await keyringWrite("delete", name);
  } catch {
    // a saved copy may stay; nothing more can be done now
  }
}

/** A private secret, from this session or the keyring; null when not stored or not readable. */
export async function getSecret(name: string): Promise<string | null> {
  checkPrivate(name);
  if (sessionSecrets.has(name)) return sessionSecrets.get(name)!;
  const answer = await deps.runWorker(["get"], JSON.stringify({ provider: name, value: null }), timing.KEYRING_TIMEOUT);
  let value: string | null = null;
  if (answer.code === 0) {
    try {
      value = (JSON.parse(answer.stdout || "{}") as { value?: string | null }).value ?? null;
    } catch {
      value = null;
    }
  }
  if (value) sessionSecrets.set(name, value);
  return value || null;
}

/** Let processes of this user read the keyring one after another: several at once make a
 *  desktop keyring slow enough to time out. After ``wait`` seconds a process goes ahead anyway. */
export async function oneAtATime<T>(wait: number, work: () => Promise<T>): Promise<T> {
  const uid = userInfo().uid;
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  let lockDir = tmpdir();
  if (runtimeDir) {
    try {
      const info = statSync(runtimeDir);
      if (info.isDirectory() && info.uid === uid) lockDir = runtimeDir;
    } catch {
      // fall back to tmpdir
    }
  }
  const path = join(lockDir, `fluidform-keyring-${uid}.ts.lock`);
  const deadline = Date.now() + wait * 1000;
  let locked = false;
  while (!locked && Date.now() < deadline) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      locked = true;
    } catch {
      // Held by a process that is gone: take it over.
      try {
        const holder = Number(readFileSync(path, "utf8"));
        if (holder) process.kill(holder, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          try {
            unlinkSync(path);
          } catch {
            // another took it first
          }
          continue;
        }
      }
      await sleep(50);
    }
  }
  try {
    return await work();
  } finally {
    if (locked) {
      try {
        unlinkSync(path);
      } catch {
        // already gone
      }
    }
  }
}

/** The saved keys, read by a child that is killed if the keyring waits for an unlock dialog;
 *  tried once more, given twice the time, if it is only slow. */
async function readInChild(seconds: number): Promise<Record<string, unknown>> {
  for (const limit of [seconds, seconds * 2]) {
    const answer = await oneAtATime(limit * 3, () => deps.runWorker([], "", limit));
    if (answer.timedOut) continue;
    if (answer.code !== 0) throw new KeyringUnavailable();
    const values = JSON.parse(answer.stdout);
    if (typeof values !== "object" || values === null || Array.isArray(values)) throw new KeyringUnavailable("Invalid keyring response");
    return values as Record<string, unknown>;
  }
  throw new KeyringUnavailable();
}

// Set when the last read of the keyring failed (locked, missing or too slow): saved keys may
// exist that are not loaded yet. keepLoadingKeys tries again until a read succeeds.
let unavailable = false;

export function keyringUnavailable(): boolean {
  return unavailable;
}

/** Load saved keys without letting a locked desktop keyring block startup; the providers whose
 *  key this call loaded. */
export async function hydrateProviderKeys(seconds = 10.0): Promise<string[]> {
  if (Object.values(SECRET_ENV).every((envName) => envName in process.env)) {
    unavailable = false;
    return [];
  }
  let values: Record<string, unknown>;
  try {
    values = await readInChild(seconds);
  } catch {
    // An error's text may contain credentials: only a fixed message.
    if (!unavailable) {
      log.warning("OS keyring unavailable or timed out; continuing with environment credentials. "
        + `Unlock the keyring: saved API keys are loaded on the next retry (every ${timing.KEYRING_RETRY_SECONDS} s).`);
    }
    unavailable = true;
    return [];
  }
  unavailable = false;
  const loaded: string[] = [];
  for (const [provider, envName] of Object.entries(SECRET_ENV)) {
    const value = values[envName];
    if (typeof value === "string" && value && !(envName in process.env)) {
      process.env[envName] = value;
      loaded.push(provider);
    }
  }
  return loaded;
}

/** While the keyring is unavailable, read it again every ``interval`` seconds, so keys saved
 *  there work once it is unlocked, without a restart. ``onLoaded`` is told which keys arrived. */
export async function keepLoadingKeys(onLoaded?: (providers: string[]) => void, interval?: number,
  seconds = 5.0, hydrate = hydrateProviderKeys, signal?: AbortSignal): Promise<void> {
  while (unavailable && !signal?.aborted) {
    await sleep((interval ?? timing.KEYRING_RETRY_SECONDS) * 1000, undefined, { signal });
    const loaded = await hydrate(seconds);
    if (loaded.length) {
      log.info(`Loaded saved API keys from the OS keyring: ${loaded.join(", ")}`);
      onLoaded?.(loaded);
    }
  }
}

export function configuredProviders(): string[] {
  return Object.entries(PROVIDER_ENV).filter(([, envName]) => process.env[envName]).map(([provider]) => provider);
}
