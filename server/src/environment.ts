// Fixes to the machine that tasks run on, shared by every sandbox.
//
// An automatic diagnosis may repair the environment a task needs: it installs software into the
// tools folder and records environment variables and host ports in its sandbox.json. Every task
// command then sees them: API models' sandboxed commands get the folder mounted read-only, and every
// command, CLI ones included, gets bin on PATH, python on PYTHONPATH and the recorded variables.
//
//     <data_dir>/tools/
//       bin/            executables (or symlinks to them)
//       python/         packages from pip install --target
//       sandbox.json    {"env": {"NAME": "value"}, "host_ports": [26585]}
//
// Only the ports listed reach the sandbox. A service that picks its ports at each start (a FlexLM
// license server's vendor daemons) is pinned to fixed ports by its own configuration, and those are
// listed (skills/steps/flexlm-license).
import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { settings } from "./config.js";
import { log } from "./log.js";
import { isObject, shlexQuote } from "./py.js";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Set by the sandbox itself, or would let a recorded value change what every command loads.
export const RESERVED_ENV = new Set(["PATH", "HOME", "PYTHONPATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "LANG"]);

export function toolsDir(): string {
  return resolve(settings.data_dir, "tools");
}

export function prepare(): string {
  const root = toolsDir();
  for (const folder of [join(root, "bin"), join(root, "python")]) mkdirSync(folder, { recursive: true });
  return root;
}

function readOverrides(): Record<string, unknown> {
  const path = join(toolsDir(), "sandbox.json");
  if (!existsSync(path) || !statSync(path).isFile()) return {};
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return isObject(data) ? data : {};
  } catch {
    log.warning(`Ignoring unreadable ${path}`);
    return {};
  }
}

// What tests replace: this machine's recorded sandbox.json.
export const deps = { overrides: readOverrides };
const overrides = () => deps.overrides();

export function recordedEnv(): Record<string, string> {
  const env = overrides().env;
  if (!isObject(env)) return {};
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => typeof value === "string" && ENV_NAME.test(name)
    && !RESERVED_ENV.has(name))) as Record<string, string>;
}

/** The host ports sandboxed commands may reach: the setting's and this machine's record. */
export async function hostPorts(): Promise<number[]> {
  const recorded = overrides().host_ports;
  const ports = Array.isArray(recorded) ? recorded.filter((port) => Number.isInteger(port) && port > 0 && port < 65536) : [];
  return [...new Set<number>([...settings.sandbox_host_ports, ...ports])].sort((a, b) => a - b);
}

/** shutil.which: the first executable named ``name`` on ``path``. */
export function which(name: string, path = process.env.PATH ?? ""): string | null {
  if (name.includes("/")) {
    try {
      accessSync(name, constants.X_OK);
      return statSync(name).isFile() ? name : null;
    } catch {
      return null;
    }
  }
  for (const folder of path.split(delimiter)) {
    if (!folder) continue;
    const candidate = join(folder, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/** ``base`` with the tools folder on PATH and PYTHONPATH and the recorded variables. */
export function commandEnv(base: Record<string, string>): Record<string, string> {
  const root = toolsDir();
  const env = { ...base, ...recordedEnv() };
  env.PATH = `${join(root, "bin")}:${base.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`;
  env.PYTHONPATH = [join(root, "python"), base.PYTHONPATH].filter(Boolean).join(":");
  return env;
}

/** The scripts each step command sources first: the setting, then this machine's record. */
export function profiles(): string[] {
  const recorded = overrides().profiles;
  const listed = [...settings.sandbox_profiles, ...(Array.isArray(recorded) ? recorded : [])];
  return [...new Set(listed.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map(String))];
}

/** Source the configured profiles in the command's sandbox, with its sanitized environment; a
 *  missing one is skipped. A non-interactive bash does not read a profile itself. Keep
 *  initialization in the child shell: it must not run on the host or redirect the caller's
 *  stdout/stderr. */
export function shellSetup(): string {
  return profiles().map(shlexQuote).map((profile) => `if [ -r ${profile} ]; then . ${profile} || exit $?; fi\n`).join("");
}
