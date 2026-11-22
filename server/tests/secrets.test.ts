// tests/test_secrets.py, ported.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { log } from "../src/log.js";
import * as secrets from "../src/secrets.js";
import { PROVIDER_ENV, SECRET_ENV } from "../src/secrets.js";

const FAKE_KEYRING = `
import { writeFileSync } from "node:fs";
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
async function mode() {
  const m = process.env.TEST_KEYRING_MODE;
  if (m === "locked") { writeFileSync(process.env.TEST_KEYRING_PID, String(process.pid)); await sleep(60); }
  return m;
}
export async function getPassword(service, name) {
  const m = await mode();
  if (m === "unavailable") throw new Error("No keyring available");
  if (m === "broken") throw new Error("sensitive-credential-must-not-be-logged");
  return "saved-" + name;
}
export async function setPassword(service, name, value) {
  if ((await mode()) === "unavailable") throw new Error("No keyring available: sensitive-credential-must-not-be-logged");
  writeFileSync(process.env.TEST_KEYRING_STORE, name + "=" + value);
}
export async function deletePassword(service, name) {
  if ((await mode()) === "unavailable") throw new Error("No keyring available: sensitive-credential-must-not-be-logged");
  writeFileSync(process.env.TEST_KEYRING_STORE, "deleted " + name);
}
`;

let folder = "";
let logged: string[] = [];
const saved = { ...process.env };
const originalRun = secrets.deps.runWorker;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "keyring-"));
  writeFileSync(join(folder, "fake-keyring.mjs"), FAKE_KEYRING);
  for (const envName of Object.values(SECRET_ENV)) delete process.env[envName];
  process.env.FLUIDFORM_KEYRING_BACKEND = join(folder, "fake-keyring.mjs");
  process.env.TEST_KEYRING_STORE = join(folder, "store.txt");
  delete process.env.TEST_KEYRING_MODE;
  logged = [];
  log.capture((_, message) => logged.push(message));
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  log.capture(null);
  secrets.deps.runWorker = originalRun;
  secrets.timing.KEYRING_TIMEOUT = 5;
});

const gone = (pidFile: string) => {
  try {
    process.kill(Number(readFileSync(pidFile, "utf8")), 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
};

test("hydrate loads saved keys and preserves the environment", async () => {
  process.env.OPENAI_API_KEY = "environment-key";
  await secrets.hydrateProviderKeys();
  assert.equal(process.env.OPENAI_API_KEY, "environment-key");
  for (const [provider, envName] of Object.entries(PROVIDER_ENV)) {
    if (provider !== "openai") assert.equal(process.env[envName], `saved-${provider}`);
  }
});

test("a locked keyring does not block startup or leave its worker", async () => {
  const pidFile = join(folder, "keyring.pid");
  process.env.TEST_KEYRING_MODE = "locked";
  process.env.TEST_KEYRING_PID = pidFile;
  process.env.OPENAI_API_KEY = "environment-key";
  const started = Date.now();
  await secrets.hydrateProviderKeys(1);
  assert.ok(Date.now() - started < 5000);
  assert.ok(logged.join("\n").includes("keyring unavailable or timed out"));
  assert.equal(process.env.OPENAI_API_KEY, "environment-key");
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
  assert.ok(gone(pidFile));
});

for (const mode of ["unavailable", "broken"]) {
  test(`a keyring that is ${mode} is not fatal and logs no secret`, async () => {
    process.env.TEST_KEYRING_MODE = mode;
    await secrets.hydrateProviderKeys();
    assert.ok(!Object.values(PROVIDER_ENV).some((envName) => envName in process.env));
    assert.ok(!logged.join("\n").includes("sensitive-credential"));
  });
}

test("a saved key goes to the keyring and replaces the environment's value", async () => {
  process.env.OPENAI_API_KEY = "old-key-value";
  assert.equal(await secrets.setProviderKey("openai", "new-key-value"), "keyring");
  assert.equal(readFileSync(join(folder, "store.txt"), "utf8"), "openai=new-key-value");
  assert.equal(process.env.OPENAI_API_KEY, "new-key-value");
  assert.equal(await secrets.deleteProviderKey("openai"), "keyring");
  assert.equal(readFileSync(join(folder, "store.txt"), "utf8"), "deleted openai");
  assert.equal(process.env.OPENAI_API_KEY, undefined);
});

test("a locked keyring does not hang saving and keeps the key for the session", async () => {
  const pidFile = join(folder, "keyring.pid");
  process.env.TEST_KEYRING_MODE = "locked";
  process.env.TEST_KEYRING_PID = pidFile;
  secrets.timing.KEYRING_TIMEOUT = 1;
  const started = Date.now();
  assert.equal(await secrets.setProviderKey("deepseek", "session-key-value"), "session");
  assert.ok(Date.now() - started < 5000);
  assert.equal(process.env.DEEPSEEK_API_KEY, "session-key-value");
  assert.ok(gone(pidFile));
  assert.equal(await secrets.deleteProviderKey("deepseek"), "session");
  assert.equal(process.env.DEEPSEEK_API_KEY, undefined);
});

test("an unavailable keyring on saving does not leak the key", async () => {
  process.env.TEST_KEYRING_MODE = "unavailable";
  assert.equal(await secrets.setProviderKey("openai", "sensitive-credential-value"), "session");
  assert.ok(!logged.join("\n").includes("sensitive-credential"));
});

test("a slow keyring is asked again with more time", async () => {
  const limits: number[] = [];
  secrets.deps.runWorker = async (_args, _input, seconds) => {
    limits.push(seconds);
    return limits.length === 1 ? { code: null, stdout: "", timedOut: true }
      : { code: 0, stdout: '{"DEEPSEEK_API_KEY": "saved"}', timedOut: false };
  };
  await secrets.hydrateProviderKeys(2);
  assert.equal(process.env.DEEPSEEK_API_KEY, "saved");
  assert.deepEqual(limits, [2, 4]);
});

test("processes read the keyring one after another", async () => {
  // Several processes starting at once (tests, workers) do not crowd the keyring.
  const script = join(folder, "reader.mts");
  const module = fileURLToPath(new URL("../src/secrets.ts", import.meta.url));
  writeFileSync(script, `import { oneAtATime } from ${JSON.stringify(module)};
await oneAtATime(10, async () => { console.log(performance.timeOrigin + performance.now());
  await new Promise((r) => setTimeout(r, 300)); console.log(performance.timeOrigin + performance.now()); });`);
  const run = () => new Promise<number[]>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", script], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("close", () => resolve(out.trim().split("\n").map(Number)));
  });
  const spans = (await Promise.all([run(), run(), run()])).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i += 1) assert.ok(spans[i - 1][1] <= spans[i][0], JSON.stringify(spans));
});

test("keys load once a keyring locked at startup is unlocked", async () => {
  process.env.TEST_KEYRING_MODE = "unavailable";
  assert.deepEqual(await secrets.hydrateProviderKeys(), []);
  assert.ok(secrets.keyringUnavailable());
  assert.equal(process.env.DEEPSEEK_API_KEY, undefined);
  delete process.env.TEST_KEYRING_MODE;
  const arrived: string[] = [];
  await secrets.keepLoadingKeys((providers) => arrived.push(...providers), 0);
  assert.ok(!secrets.keyringUnavailable());
  assert.equal(process.env.DEEPSEEK_API_KEY, "saved-deepseek");
  assert.ok(arrived.includes("deepseek") && arrived.includes("minimax"));
  assert.equal(logged.filter((line) => line.includes("keyring unavailable or timed out")).length, 1);
});

test("no retry while the keyring was read", async () => {
  await secrets.hydrateProviderKeys();
  assert.ok(!secrets.keyringUnavailable());
  await secrets.keepLoadingKeys(undefined, 0, 5, async () => assert.fail("read again"));
});

test("private secrets: only capability names, kept for the session", async () => {
  await assert.rejects(secrets.setSecret("OPENAI_API_KEY", "x"));
  assert.equal(await secrets.setSecret("capability/feishu-bot/APP_SECRET", "v1"), "keyring");
  assert.equal(readFileSync(join(folder, "store.txt"), "utf8"), "capability/feishu-bot/APP_SECRET=v1");
  assert.equal(await secrets.getSecret("capability/feishu-bot/APP_SECRET"), "v1");
  assert.equal(await secrets.getSecret("capability/other/TOKEN"), "saved-capability/other/TOKEN");
  await secrets.deleteSecret("capability/feishu-bot/APP_SECRET");
  assert.equal(readFileSync(join(folder, "store.txt"), "utf8"), "deleted capability/feishu-bot/APP_SECRET");
});

// A keyring that keeps each service's secrets apart, in a JSON file.
const BY_SERVICE = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const file = () => process.env.TEST_KEYRING_STORE;
const load = () => (existsSync(file()) ? JSON.parse(readFileSync(file(), "utf8")) : {});
const save = (data) => writeFileSync(file(), JSON.stringify(data));
export function getPassword(service, name) { return load()[service]?.[name] ?? null; }
export function setPassword(service, name, value) { const data = load(); (data[service] ??= {})[name] = value; save(data); }
export function deletePassword(service, name) { const data = load(); delete data[service]?.[name]; save(data); }
`;

test("a secret kept under the former name (super-partner) is found, copied under FluidForm's, and deleted under both", async () => {
  writeFileSync(join(folder, "by-service.mjs"), BY_SERVICE);
  process.env.FLUIDFORM_KEYRING_BACKEND = join(folder, "by-service.mjs");
  const store = join(folder, "store.json");
  process.env.TEST_KEYRING_STORE = store;
  writeFileSync(store, JSON.stringify({ "super-partner": { "capability/feishu-bot/FEISHU_APP_SECRET": "old-secret" } }));
  assert.equal(await secrets.getSecret("capability/feishu-bot/FEISHU_APP_SECRET"), "old-secret");
  const kept = JSON.parse(readFileSync(store, "utf8"));
  assert.deepEqual([kept.fluidform["capability/feishu-bot/FEISHU_APP_SECRET"], kept["super-partner"]["capability/feishu-bot/FEISHU_APP_SECRET"]],
    ["old-secret", "old-secret"]);
  await secrets.deleteSecret("capability/feishu-bot/FEISHU_APP_SECRET");
  assert.equal(await secrets.getSecret("capability/feishu-bot/FEISHU_APP_SECRET"), null);
});
