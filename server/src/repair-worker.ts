// Applying a checked repair of FluidForm, and rolling it back.
//
// This file uses only Node's own modules and syntax Node can run from the .ts file as it is (types
// only, nothing to compile): a frozen copy of it applies the repair from outside the API's service,
// and can roll it back even when the new version does not start.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

// What a repair may read and change: the source, never live tasks, secrets, dependencies or git.
export const SOURCE_DIRS = new Set(["server", "frontend", "scripts", "docs", "skills", "evals"]);
export const ROOT_FILES = new Set(["README.md", "AGENTS.md", "CLAUDE.md", "Dockerfile", "compose.yaml", ".gitignore", ".dockerignore", "start.sh", "stop.sh"]);
export const SKIP = new Set([".git", ".agents", ".aws", ".claude", ".codex", ".fluidform", ".super-partner", "workspaces", ".venv", "node_modules", "dist", "build",
  "coverage", "__pycache__"]);
export const SUFFIXES = new Set([".py", ".ts", ".tsx", ".js", ".mjs", ".css", ".html", ".json", ".sh", ".md", ".svg", ".png", ".webp"]);
export const PRIVATE = new Set(["credentials.json", "secrets.json", ".env"]);
// The largest is a recorded test fixture (server/tests/golden, 5.3 MB); tests/platform-repair.test.ts
// keeps this checkout within it.
export const MAX_FILE_BYTES = 16_000_000;
// Built from frontend/, never source: rebuilt when a repair is applied.
export const BUILT_DIRS = new Set(["server/packages/web/site"]);
export const MAX_SOURCE_FILES = 5000;
export const HEALTH_SECONDS = 60;
export const BUILD_SECONDS = 600;
// How long a restart may take: longer than systemd waits for the old process before killing it (90 s by
// default), so a slow stop is a slow restart, not a failed repair.
export const RESTART_SECONDS = 150;

export class RepairError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepairError";
  }
}

export type FileState = { sha256: string; mode: number };
export type Job = Record<string, any> & { id: string; folder: string; status: string; files: string[] };

export function atomicJson(path: string, value: unknown): void {
  const temporary = path + ".tmp";
  writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

/** A consistent copy of the database at ``source`` (it may be in use). */
export async function backupDatabase(source: string, destination: string): Promise<void> {
  const live = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(live, destination);
  } finally {
    live.close();
  }
}

const extension = (name: string) => {
  const at = name.lastIndexOf(".");
  return at > 0 ? name.slice(at) : "";
};

/** A snapshot of the source only: never live tasks, secrets, dependencies or git. */
export function sourceFiles(root: string): Record<string, FileState> {
  const result: Record<string, FileState> = {};
  // os.walk(root, followlinks=False): a link to a folder is listed as a folder, and not entered.
  const walk = (folder: string, parts: string[]) => {
    const entries = readdirSync(folder, { withFileTypes: true });
    const isFolder = (entry: (typeof entries)[number]) => entry.isDirectory() || (entry.isSymbolicLink() && safeIsDir(join(folder, entry.name)));
    const folders = entries.filter((entry) => isFolder(entry) && !SKIP.has(entry.name) && (parts.length > 0 || SOURCE_DIRS.has(entry.name))
      && !BUILT_DIRS.has([...parts, entry.name].join("/")));
    for (const entry of folders) if (entry.isSymbolicLink()) throw new RepairError(`源码目录不能是符号链接：${[...parts, entry.name].join("/")}`);
    for (const entry of entries.filter((item) => !isFolder(item))) {
      const name = entry.name;
      const rel = [...parts, name].join("/");
      if (PRIVATE.has(name) || name.startsWith(".env.") || (!parts.length && !ROOT_FILES.has(name)) || (parts.length && !SUFFIXES.has(extension(name)))) continue;
      if (entry.isSymbolicLink() || !entry.isFile()) throw new RepairError(`源码文件不能是符号链接：${rel}`);
      const info = statSync(join(folder, name));
      if (info.size > MAX_FILE_BYTES || Object.keys(result).length >= MAX_SOURCE_FILES) throw new RepairError("平台修复源码范围过大。");
      result[rel] = { sha256: createHash("sha256").update(readFileSync(join(folder, name))).digest("hex"), mode: info.mode & 0o777 };
    }
    for (const entry of folders) walk(join(folder, entry.name), [...parts, entry.name]);
  };
  walk(root, []);
  return Object.fromEntries(Object.entries(result).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
}

function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function same(a: Record<string, FileState>, b: Record<string, FileState>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function changed(before: Record<string, FileState>, after: Record<string, FileState>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((name) => JSON.stringify(before[name]) !== JSON.stringify(after[name])).sort();
}

export function serviceProperties(unit: string): Record<string, string> {
  const result = spawnSync("systemctl", ["--user", "show", unit, "--property=MainPID,WorkingDirectory,ActiveState"], { encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) throw new RepairError(`systemctl show ${unit} failed: ${(result.stderr || String(result.error ?? "")).trim()}`);
  return Object.fromEntries(result.stdout.split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

/** Run a command to its end; throws when it fails (subprocess.run(..., check=True)). */
export function run(args: string[], options: { cwd?: string; timeout?: number } = {}): void {
  const result = spawnSync(args[0], args.slice(1), { cwd: options.cwd, encoding: "utf8", timeout: (options.timeout ?? 90) * 1000 });
  if (result.status !== 0) throw new RepairError(`${args.join(" ")} failed: ${(result.stderr || result.stdout || String(result.error ?? "")).trim().slice(-2000)}`);
}

/** The new version answers /health, from a new process of the service. */
export function waitHealthy(job: Job, timeout = HEALTH_SECONDS): void {
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    const answer = spawnSync("curl", ["--noproxy", "*", "--silent", "--fail", "--max-time", "2", `${job.api_url}/health`], { encoding: "utf8", timeout: 5000 });
    try {
      const body = JSON.parse(answer.stdout);
      const pid = deps.serviceProperties(job.unit).MainPID;
      if (body.status === "ok" && body.pid === Number(pid || 0) && pid !== String(job.old_pid)) return;
    } catch {
      // not yet
    }
    spawnSync("sleep", ["0.5"]);
  }
  throw new RepairError(`新版本在 ${timeout} 秒内未通过服务健康检查。`);
}

/** What tests replace: the service manager, commands, and the health check. */
export const deps = { serviceProperties, run, waitHealthy };

const inside = (path: string, root: string) => path.startsWith(root + sep);

export function installFiles(job: Job, rollback = false): void {
  const root = job.root as string;
  const source = join(job.folder, rollback ? "before" : "source");
  const wanted = (rollback ? job.before : job.after) as Record<string, FileState>;
  const realRoot = realpathSync(root);
  for (const name of job.files) {
    const destination = join(root, name);
    let parent = dirname(destination);
    while (!existsSync(parent)) parent = dirname(parent);
    const linked = existsSync(destination) || isLink(destination) ? lstatSync(destination).isSymbolicLink() : false;
    if (!inside(join(realpathSync(parent), relative(parent, destination)), realRoot) || linked) throw new RepairError(`修复路径越界或变成符号链接：${name}`);
    if (!(name in wanted)) {
      rmSync(destination, { force: true });
      continue;
    }
    mkdirSync(dirname(destination), { recursive: true });
    const temporary = destination + ".sp-repair-tmp";
    copyFileSync(join(source, name), temporary);
    chmodSync(temporary, wanted[name].mode);
    renameSync(temporary, destination);
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The server's compiled code and the web console's page from their source, which a restart runs. */
export function build(job: Job): void {
  if (existsSync(join(job.root, "server", "package.json"))) deps.run(["npm", "run", "build"], { cwd: join(job.root, "server"), timeout: BUILD_SECONDS });
  // The page is a package FluidForm serves: a repair of frontend/ shows only once that is built again.
  const frontend = join(job.root, "frontend");
  if (job.files.some((name) => name.startsWith("frontend/")) && existsSync(join(frontend, "node_modules"))) {
    deps.run(["npm", "run", "package"], { cwd: frontend, timeout: BUILD_SECONDS });
  }
}

export async function activate(jobPath: string): Promise<void> {
  const job = JSON.parse(readFileSync(jobPath, "utf8")) as Job;
  let applied = false;
  try {
    if (job.status !== "scheduled" || !same(sourceFiles(job.root), job.before)) throw new RepairError("平台源码或修复状态发生变化，停止应用补丁。");
    if (!same(sourceFiles(join(job.folder, "source")), job.after)) throw new RepairError("验证后的修复副本发生变化，停止应用补丁。");
    const service = deps.serviceProperties(job.unit);
    if (service.MainPID !== String(job.old_pid) || service.WorkingDirectory !== job.root) throw new RepairError("目标服务已发生变化，停止重启。");
    Object.assign(job, { status: "activating", activation_started_at: Date.now() / 1000 });
    atomicJson(jobPath, job);
    if (job.database_path) await backupDatabase(job.database_path, join(job.folder, "database-before.db"));
    applied = true;
    installFiles(job);
    build(job);
    deps.run(["systemctl", "--user", "restart", job.unit], { timeout: RESTART_SECONDS });
    deps.waitHealthy(job);
    job.status = "activated";
  } catch (error) {
    Object.assign(job, { status: "failed", error: (error as Error)?.message ?? String(error) });
    if (applied) {
      try {
        // Refuse to overwrite a third party's edits made during activation.
        const current = sourceFiles(job.root);
        for (const name of job.files) {
          const now = JSON.stringify(current[name]);
          if (now !== JSON.stringify(job.before[name]) && now !== JSON.stringify(job.after[name])) throw new RepairError(`回滚发现并发修改，已保留：${name}`);
        }
        installFiles(job, true);
        build(job);
        deps.run(["systemctl", "--user", "restart", job.unit], { timeout: RESTART_SECONDS });
        deps.waitHealthy(job);
        job.status = "rolled_back";
      } catch (rollback) {
        job.error += `；回滚检查：${(rollback as Error)?.message ?? rollback}`;
      }
    }
  }
  job.finished_at = Date.now() / 1000;
  atomicJson(jobPath, job);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathOr(process.argv[1])) await activate(process.argv[2]);

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

