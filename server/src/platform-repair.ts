// Repairs of Super Partner itself: a copy of its source, edited, checked, then
// applied by a restart. The copy is checked in a sandbox (types, the database's records, the server's
// and the frontend's tests, the build); a worker outside the service (repair-worker.ts, copied with the
// job so a repair cannot change it) puts the files in place, builds the server, restarts the service
// and rolls it all back when the new version does not answer.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, copyFileSync, existsSync, openSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as agent from "./agent.js";
import * as environment from "./environment.js";
import { atomicJson, backupDatabase, changed, deps as worker, type FileState, RepairError, same, sourceFiles } from "./repair-worker.js";

export { RepairError, sourceFiles, changed } from "./repair-worker.js";
export const CHECK_TIMEOUT = 600;
export const MAX_DIFF_CHARS = 60_000;
// What a repair must keep: the entry points and build configuration, and every regression test.
export const ENTRY_FILES = ["server/package.json", "server/src/main.ts", "frontend/package.json"];
export const TEST_DIRS = ["server/tests/", "frontend/tests/", "tests/"];
// Where a regression test for the repair goes, and where the repair itself.
export const REGRESSION_DIRS = ["server/tests/", "frontend/tests/"];
export const CODE_DIRS = ["server/src/", "frontend/", "scripts/"];

// How to diagnose and repair the platform, and where its code is; given to every model that does.
export const REPAIR_GUIDES = ["skills/platform-repair/SKILL.md", "docs/ARCHITECTURE.md", "skills/platform-rules/SKILL.md"];
// How the platform engineer adds a component (engineer.ts).
export const COMPONENT_GUIDES = ["skills/platform-engineer/SKILL.md", "docs/ARCHITECTURE.md", "skills/platform-rules/SKILL.md"];

/** The repair skill (or another of ``names``) and the architecture map from ``root``, without the
 *  skill's front matter, so that a model of any kind follows the same procedure. */
export function repairGuide(root: string | null, names: string[] = REPAIR_GUIDES): string {
  const parts: string[] = [];
  for (const name of names) {
    if (!root) continue;
    const path = join(root, name);
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    let text = readFileSync(path, "utf8");
    if (text.startsWith("---\n")) {
      const at = text.indexOf("\n---\n");
      if (at >= 0) text = text.slice(at + 5);
    }
    parts.push(`<<< ${name} >>>\n${text.trim()}`);
  }
  return parts.join("\n\n");
}

/** A prepared copy of the source (Python's job dict). */
export type RepairJob = Record<string, any> & { id: string; folder: string; status: string; files: string[] };
export type CheckSeen = (title: string, ok: boolean | null) => void;

/** What the executor needs of platform repairs. */
export interface PlatformRepairs {
  readonly enabled: boolean;
  readonly root: string | null;
  context(): string;
  prepare(runId: string | null, diagnosisId: string | null, options?: { allowNetwork?: boolean }): Promise<RepairJob>;
  save(job: RepairJob): void;
  load(identifier: string | null | undefined): RepairJob | null;
  stale(job: RepairJob): boolean;
  edited(job: RepairJob): string[];
  diff(job: RepairJob): string;
  check(job: RepairJob, seen?: CheckSeen): Promise<{ name: string }[]>;
  schedule(job: RepairJob): void;
  launch(job: RepairJob): Promise<void>;
  pending(): RepairJob | null;
  clearPending(job: RepairJob): void;
}


/** The source checkout to repair: ``configured``, or the one this server runs from. */
export function sourceRoot(configured: string | null = null): string | null {
  const root = configured ? resolve(configured) : resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  return ENTRY_FILES.slice(0, 2).every((name) => existsSync(join(root, name)) && statSync(join(root, name)).isFile()) ? root : null;
}

/** The service start.sh made for ``root`` (scripts/service.sh: cksum of its path). */
export function unitName(root: string): string {
  const result = spawnSync("cksum", [], { input: root, encoding: "utf8" });
  if (result.status !== 0) throw new RepairError("cksum failed");
  return `super-partner-${result.stdout.split(/\s+/)[0]}-api.service`;
}

/** What tests replace: starting a check's or the worker's process. */
export const deps = { spawn: (command: string, args: string[], options: Parameters<typeof spawn>[2]): ChildProcess => spawn(command, args, options),
  networkAvailable: () => agent.networkAvailable() };

type Check = { returncode: number; output: string };

/** The worker as it is shipped beside this module (repair-worker.ts, or .js once built). */
const WORKER = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./repair-worker.ts" : "./repair-worker.js", import.meta.url));

const DATABASE_PROBE = `import { DatabaseSync } from "node:sqlite";
import { Database } from "../server/src/db.js";

const path = process.argv[2];
const quoted = (name) => '"' + name.replaceAll('"', '""') + '"';
const rows = (connection, table, columns) => connection.prepare("SELECT " + columns.map(quoted).join(",") + " FROM " + quoted(table)).all()
  .map((row) => JSON.stringify(columns.map((column) => row[column]))).sort();
const raw = new DatabaseSync(path);
const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name);
const columns = Object.fromEntries(tables.map((table) => [table, raw.prepare("PRAGMA table_info(" + quoted(table) + ")").all().map((row) => row.name)]));
const before = Object.fromEntries(tables.map((table) => [table, rows(raw, table, columns[table])]));
raw.close();
const database = new Database(path);
try {
  database.listRuns();
  database.listModels();
  for (const table of tables) {
    if (JSON.stringify(rows(database.connection, table, columns[table])) !== JSON.stringify(before[table])) throw new Error("Existing records changed: " + table);
  }
  if (database.connection.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw new Error("quick_check failed");
} finally {
  database.connection.close();
}
console.log("Existing records remain compatible");
`;

function lines(path: string): string[] {
  if (!existsSync(path) || !statSync(path).isFile()) return [];
  const data = readFileSync(path);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data).split(/(?<=\n)/).filter((line) => line !== "");
  } catch {
    return ["(binary file)\n"];
  }
}

/** difflib.unified_diff of two files' lines, three lines of context. */
export function unifiedDiff(a: string[], b: string[], fromName: string, toName: string): string {
  // The longest common subsequence's matches, then hunks around the differences.
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  type Op = [" " | "-" | "+", string, number, number];
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) ops.push([" ", a[i], i++, j++]);
    else if (j < m && (i >= n || table[i][j + 1] >= table[i + 1][j])) ops.push(["+", b[j], i, j++]);
    else ops.push(["-", a[i], i++, j]);
  }
  if (!ops.some((op) => op[0] !== " ")) return "";
  const context = 3;
  const out = [`--- ${fromName}\n`, `+++ ${toName}\n`];
  let at = 0;
  while (at < ops.length) {
    while (at < ops.length && ops[at][0] === " ") at += 1;
    if (at >= ops.length) break;
    let start = Math.max(0, at - context);
    let end = at;
    for (let k = at; k < ops.length; k += 1) {
      if (ops[k][0] !== " ") end = k;
      else if (k - end > context * 2) break;
    }
    const stop = Math.min(ops.length, end + context + 1);
    const hunk = ops.slice(start, stop);
    const aStart = hunk[0][2];
    const bStart = hunk[0][3];
    const aCount = hunk.filter((op) => op[0] !== "+").length;
    const bCount = hunk.filter((op) => op[0] !== "-").length;
    const range = (first: number, count: number) => (count === 1 ? `${first + 1}` : `${count ? first + 1 : first},${count}`);
    out.push(`@@ -${range(aStart, aCount)} +${range(bStart, bCount)} @@\n`);
    for (const [kind, text] of hunk) out.push(kind + text + (text.endsWith("\n") ? "" : "\n\\ No newline at end of file\n"));
    at = stop;
    start = stop;
  }
  return out.join("");
}

export class SourceRepairs implements PlatformRepairs {
  readonly root: string | null;
  readonly directory: string;
  readonly apiUrl: string;
  readonly databasePath: string | null;

  constructor(root: string | null, dataDir: string, apiUrl: string, readonly enabled = true, databasePath: string | null = null) {
    this.root = sourceRoot(root);
    this.directory = join(resolve(dataDir), "platform-repairs");
    this.apiUrl = apiUrl.replace(/\/+$/, "");
    this.databasePath = databasePath ? resolve(databasePath) : null;
  }

  context(): string {
    if (!this.enabled) return "Platform self-repair is disabled in the application configuration.";
    if (!this.root) return "No editable FluidForm source checkout was found in this installation.";
    return `FluidForm source checkout (read-only during investigation): ${this.root}\n`
      + "Its code is under server/src and frontend; regression tests are under server/tests and frontend/tests. "
      + "The repair controller will provide an isolated copy, run independent checks, preserve local data, and activate validated fixes "
      + "for all projects. Never modify live source, credentials, task records or Git history.\n"
      + `Only if FluidForm itself is at fault: find its code with ${this.root}/${REPAIR_GUIDES[1]} and diagnose as ${this.root}/${REPAIR_GUIDES[0]} says. `
      + "Both are about FluidForm's own code, not the task: never tell the task's steps to read or follow them.";
  }

  /** A fresh copy of the source to edit. ``runId``: the task it is for, if any. */
  async prepare(runId: string | null, diagnosisId: string | null, { allowNetwork = false }: { allowNetwork?: boolean } = {}): Promise<RepairJob> {
    if (!this.enabled || !this.root) throw new RepairError("平台自修复未启用，或当前安装没有可编辑的 FluidForm 源码。");
    const unit = unitName(this.root);
    let service: Record<string, string>;
    try {
      service = worker.serviceProperties(unit);
    } catch {
      throw new RepairError("平台自动生效需要由 start.sh 启动的用户服务；无法连接该服务管理器。");
    }
    if (service.MainPID !== String(process.pid) || service.WorkingDirectory !== this.root) throw new RepairError("当前 API 不是此源码目录的受管服务，不能安全自动重启其他进程。");
    mkdirSync(this.directory, { recursive: true });
    const folder = join(this.directory, randomBytes(16).toString("hex"));
    mkdirSync(folder, { mode: 0o700 });
    const before = sourceFiles(this.root);
    for (const name of Object.keys(before)) {
      for (const copy of ["before", "source"]) {
        const destination = join(folder, copy, name);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(join(this.root, name), destination);
      }
    }
    // The installed dependencies, shared read-only: a repair does not install packages.
    for (const part of ["frontend", "server"]) {
      const dependencies = join(this.root, part, "node_modules");
      if (existsSync(dependencies) && statSync(dependencies).isDirectory()) {
        mkdirSync(join(folder, "source", part), { recursive: true });
        symlinkSync(dependencies, join(folder, "source", part, "node_modules"), "dir");
      }
    }
    const activate = join(folder, WORKER.endsWith(".ts") ? "activate.ts" : "activate.js");
    copyFileSync(WORKER, activate);
    const job: RepairJob = { id: folder.split("/").at(-1)!, scope: "super_partner", status: "editing", run_id: runId, diagnosis_id: diagnosisId, root: this.root,
      folder, unit, old_pid: process.pid, database_path: this.databasePath, api_url: this.apiUrl, before, files: [], checks: [], allow_network: allowNetwork,
      activate, created_at: Date.now() / 1000 };
    this.save(job);
    return job;
  }

  save(job: RepairJob): void {
    atomicJson(join(job.folder, "job.json"), job);
  }

  /** A copy prepared earlier, by its id; null if it is gone. */
  load(identifier: string | null | undefined): RepairJob | null {
    if (!identifier || !/^[0-9a-f]{32}$/.test(identifier)) return null;
    const path = join(this.directory, identifier, "job.json");
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as RepairJob) : null;
  }

  /** The live source has changed since the copy was made: applying it would overwrite that. */
  stale(job: RepairJob): boolean {
    return !this.root || !same(sourceFiles(this.root), job.before);
  }

  /** The files the copy has changed so far, checked or not (an edit a restart cut off). */
  edited(job: RepairJob): string[] {
    try {
      return changed(job.before, sourceFiles(join(job.folder, "source")));
    } catch {
      return [];
    }
  }

  /** A unified diff of what the copy changed, for the user to read before applying it. */
  diff(job: RepairJob): string {
    const text = (job.files ?? []).map((name) => unifiedDiff(lines(join(job.folder, "before", name)), lines(join(job.folder, "source", name)), `a/${name}`, `b/${name}`)).join("");
    return text.length <= MAX_DIFF_CHARS ? text : text.slice(0, MAX_DIFF_CHARS) + "\n… (diff truncated)\n";
  }

  pending(): RepairJob | null {
    const path = join(this.directory, "pending.json");
    if (!existsSync(path)) return null;
    const identifier = String(JSON.parse(readFileSync(path, "utf8")).id ?? "");
    if (!/^[0-9a-f]{32}$/.test(identifier)) throw new RepairError("平台修复记录标识无效。");
    return JSON.parse(readFileSync(join(this.directory, identifier, "job.json"), "utf8")) as RepairJob;
  }

  clearPending(job: RepairJob): void {
    const current = this.pending();
    if (current && current.id === job.id) unlinkSync(join(this.directory, "pending.json"));
  }

  schedule(job: RepairJob): void {
    this.save(job);
    atomicJson(join(this.directory, "pending.json"), { id: job.id });
  }

  /** Run the checks; ``seen(title, ok)`` hears each one start (null) and end. */
  async check(job: RepairJob, seen?: CheckSeen): Promise<{ name: string }[]> {
    const source = join(job.folder, "source");
    const after = sourceFiles(source);
    const files = changed(job.before, after);
    if (!files.length) throw new RepairError("诊断没有修改平台源码，不能报告修复完成。");
    const required = new Set([...ENTRY_FILES, ...Object.keys(job.before).filter((name) => TEST_DIRS.some((dir) => name.startsWith(dir)))]);
    if ([...required].some((name) => !(name in after))) throw new RepairError("平台修复不能删除应用入口、构建配置或原有回归测试。");
    if (!files.some((name) => REGRESSION_DIRS.some((dir) => name.startsWith(dir)))) throw new RepairError("平台修复需要新增或更新能复现当前缺陷的回归测试。");
    if (!files.some((name) => CODE_DIRS.some((dir) => name.startsWith(dir)) && !name.startsWith("frontend/tests/"))) throw new RepairError("只有测试变化，没有实际的平台修复。");
    Object.assign(job, { status: "validating", files, after, checks: [] });
    this.save(job);
    const server = join(source, "server");
    const frontend = join(source, "frontend");
    const snapshot = join(source, ".validation", "database-compatibility.db");
    const probe = join(source, ".validation", "database-probe.ts");
    const commands: [string, string[], string][] = [
      ["TypeScript check", ["npm", "run", "check"], server],
      ["Server tests", ["npm", "test"], server],
      ["Frontend tests", ["npm", "test"], frontend],
      ["Frontend build", ["npm", "run", "build"], frontend],
    ];
    // Migrations are checked against a private copy of real records. The copy is removed before the
    // model can hear back and edit the candidate again.
    if (this.databasePath) commands.splice(1, 0, ["Existing database compatibility", [join(server, "node_modules", ".bin", "tsx"), probe, snapshot], server]);
    for (const [title, command, cwd] of commands) {
      const database = title === "Existing database compatibility";
      if (database) {
        mkdirSync(dirname(snapshot), { recursive: true });
        await backupDatabase(this.databasePath!, snapshot);
        writeFileSync(probe, DATABASE_PROBE);
      }
      seen?.(title, null);
      let result: Check;
      try {
        result = await this.checkCommand(command, cwd, source, { allowNetwork: Boolean(job.allow_network) });
        seen?.(title, !result.returncode);
      } finally {
        if (database) for (const end of ["", "-wal", "-shm", "-journal"]) rmSync(snapshot + end, { force: true });
        if (database) rmSync(probe, { force: true });
      }
      job.checks.push({ name: title, ...result });
      this.save(job);
      if (result.returncode) throw new RepairError(`${title} 未通过：\n${result.output}`);
    }
    if (!same(sourceFiles(source), after)) throw new RepairError("验证过程中源码发生变化，必须重新检查。");
    job.status = "validated";
    this.save(job);
    return job.checks;
  }

  /** ``command`` in a sandbox over the copy: no real data, no home, no keys; the network only when
   *  the task allows it. */
  async checkCommand(command: string[], cwd: string, source: string, { allowNetwork = false }: { allowNetwork?: boolean } = {}): Promise<Check> {
    if (!environment.which("bwrap")) throw new RepairError("平台修复验证需要 bubblewrap，以隔离真实任务数据。");
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", HOME: join(source, ".validation", "home"),
      SUPER_PARTNER_CATALOG_AUTO_SYNC: "false", SUPER_PARTNER_PLATFORM_SELF_REPAIR: "false", SUPER_PARTNER_DATA_DIR: join(source, ".validation", "data"),
      SUPER_PARTNER_DATABASE_PATH: join(source, ".validation", "data", "test.db"), SUPER_PARTNER_WORKSPACE_ROOT: join(source, ".validation", "workspaces"),
      SUPER_PARTNER_VALIDATION_ALLOW_NETWORK: String(allowNetwork) };
    if (allowNetwork) for (const name of agent.PROXY_ENV) if (process.env[name] !== undefined) env[name] = process.env[name]!;
    mkdirSync(join(source, ".validation", "home"), { recursive: true });
    const home = realOr(userInfo().homedir || homedir());
    const hidden = home !== "/" && existsSync(home) ? ["--tmpfs", home] : [];
    // Expose installed runtimes and dependencies read-only, not the checkout holding the real
    // database, credentials, other projects, or private files in the home.
    const runtimes = new Set<string>([dirname(dirname(realOr(process.execPath)))]);
    if (this.root) for (const part of ["frontend", "server"]) runtimes.add(join(this.root, part, "node_modules"));
    for (const executable of ["node", "npm"]) {
      const located = environment.which(executable);
      if (located) runtimes.add(dirname(dirname(realOr(located))));
    }
    const mounts = [...runtimes].sort().filter((path) => existsSync(path) && statSync(path).isDirectory() && path.startsWith(home + "/")).flatMap((path) => ["--ro-bind", path, path]);
    const network = allowNetwork && deps.networkAvailable() ? agent.networkPrefix(agent.proxyPorts()) : [];
    const isolated = allowNetwork ? [] : ["--unshare-net"];
    // Tests may start a nested network sandbox; bubblewrap's private /dev would otherwise hide the TUN
    // device pasta needs, even with the network allowed.
    const tun = allowNetwork && isCharDevice("/dev/net/tun") ? ["--dev-bind", "/dev/net/tun", "/dev/net/tun"] : [];
    const args = [...network, "bwrap", "--ro-bind", "/", "/", "--tmpfs", "/tmp", ...hidden, ...mounts, "--bind", source, source,
      "--dev", "/dev", ...tun, "--proc", "/proc", ...isolated, "--die-with-parent", "--", ...command];
    // Output to a file, not a pipe: pasta passes nothing on to a socket (Node's pipes are sockets).
    const captured = join(source, ".validation", `output-${randomBytes(4).toString("hex")}.log`);
    const fd = openSync(captured, "w");
    let code: number | null;
    try {
      const child = deps.spawn(args[0], args.slice(1), { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
      code = await new Promise<number | null>((done, fail) => {
        const timer = setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            // gone
          }
          fail(new RepairError(`检查超过 ${CHECK_TIMEOUT} 秒没有结束，已停止。`));
        }, CHECK_TIMEOUT * 1000);
        child.once("error", (error) => {
          clearTimeout(timer);
          fail(error);
        });
        child.once("close", (status) => {
          clearTimeout(timer);
          done(status);
        });
      });
    } finally {
      closeSync(fd);
    }
    const output = readFileSync(captured).toString("utf8");
    rmSync(captured, { force: true });
    return { returncode: code ?? 1, output: output.slice(-8000) };
  }

  async launch(job: RepairJob): Promise<void> {
    if (!same(sourceFiles(job.root), job.before)) throw new RepairError("验证期间平台源码被其他操作修改，已保留这些改动；本次修复未覆盖它们。");
    job.status = "scheduled";
    this.schedule(job);
    const log = join(job.folder, "activation.log");
    const command = ["--user", "--quiet", "--collect", `--unit=${job.unit.slice(0, -8)}-repair-${job.id.slice(0, 12)}`,
      `--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`, "--", process.execPath, job.activate ?? join(job.folder, "activate.js"),
      join(job.folder, "job.json")];
    const child = deps.spawn("systemd-run", command, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (data: Buffer) => chunks.push(data));
    child.stderr?.on("data", (data: Buffer) => chunks.push(data));
    const code = await new Promise<number | null>((done) => {
      child.once("error", () => done(127));
      child.once("close", (status) => done(status));
    });
    if (code) {
      Object.assign(job, { status: "failed", error: Buffer.concat(chunks).toString("utf8").slice(-2000) });
      this.save(job);
      throw new RepairError(`平台修复生效任务启动失败：${job.error}`);
    }
  }
}

function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isCharDevice(path: string): boolean {
  try {
    return statSync(path).isCharacterDevice();
  } catch {
    return false;
  }
}

export type { FileState };
