// The user's own project folders: which ones a task may work in, their git state, and
// finding them under the allowed roots.
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { settings } from "./config.js";
import * as environment from "./environment.js";
import { head } from "./py.js";

export const MAX_CONTEXT_ENTRIES = 60;
export const MAX_DISCOVERED = 300;
export const DISCOVER_DEPTH = 4;
export const DISCOVER_SECONDS = 3.0;
// Dependency, build, and OS folders that hold no projects of their own but are slow to walk.
export const SKIP_DISCOVERY = new Set(["node_modules", "__pycache__", "venv", "site-packages", "vendor", "dist", "build", "target",
  "snap", "Library", "Applications", "Pictures", "Music", "Videos", "Downloads"]);

export class ProjectDirError extends Error {
  override name = "ProjectDirError";
}

export class NativePickerError extends Error {
  override name = "NativePickerError";
}

export const limits = { NATIVE_PICKER_TIMEOUT: 300 };
// What tests replace.
export const deps = { which: (name: string) => environment.which(name) };

/** The API runs on the user's own machine, so it can open the desktop's folder dialog. */
export function nativePickerStatus(): { available: boolean; reason: string | null } {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return { available: false, reason: "No desktop session is attached to the API process" };
  if (!deps.which("zenity")) return { available: false, reason: "zenity is not installed" };
  return { available: true, reason: null };
}

/** Open the dialog at the requested folder when it is allowed, else at the first root. */
function pickerStart(start: string | null): string {
  if (start) {
    try {
      return resolveProjectDir(start);
    } catch (error) {
      if (!(error instanceof ProjectDirError)) throw error;
    }
  }
  return allowedRoots()[0];
}

/** Open the desktop folder dialog; null when the user cancels it. */
export async function nativePickDirectory(start: string | null = null, signal?: AbortSignal): Promise<string | null> {
  const status = nativePickerStatus();
  if (!status.available) throw new NativePickerError(status.reason!);
  const child = spawn("zenity", ["--file-selection", "--directory", "--title=选择项目目录", `--filename=${pickerStart(start)}/`],
    { stdio: ["ignore", "pipe", "pipe"], detached: true });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout!.on("data", (chunk: Buffer) => out.push(chunk));
  child.stderr!.on("data", (chunk: Buffer) => err.push(chunk));
  const kill = () => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // gone
    }
  };
  const code = await new Promise<number | null>((done, fail) => {
    const timer = setTimeout(() => {
      kill();
      fail(Object.assign(new Error("folder dialog timed out"), { name: "TimeoutError" }));
    }, limits.NATIVE_PICKER_TIMEOUT * 1000);
    const stop = () => {
      clearTimeout(timer);
      kill();
      fail(signal!.reason);
    };
    signal?.addEventListener("abort", stop, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on("close", (value) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      done(value);
    });
  });
  if (code === 1) return null;
  if (code) throw new NativePickerError(head(Buffer.concat(err).toString("utf8").trim(), 200) || "Folder dialog failed");
  return resolveProjectDir(Buffer.concat(out).toString("utf8").trim());
}

const expandUser = (path: string) => (path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
/** Path.resolve(): absolute, with symbolic links resolved as far as the path exists. */
export function real(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = resolve(absolute, "..");
    return parent === absolute ? absolute : join(real(parent), basename(absolute));
  }
}

export function allowedRoots(): string[] {
  return settings.project_roots.map((root) => real(expandUser(root)));
}

export const isWithin = (path: string, root: string) => path === root || path.startsWith(root === "/" ? "/" : root + sep);
const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

function existingDirInRoots(raw: string): string {
  let path = expandUser(raw);
  if (!isAbsolute(path)) throw new ProjectDirError("Project directory must be an absolute path");
  path = real(path);
  if (!isDir(path)) throw new ProjectDirError(`Project directory does not exist: ${path}`);
  const roots = allowedRoots();
  if (!roots.some((root) => isWithin(path, root))) throw new ProjectDirError(`Project directory must be inside an allowed root: ${roots.join(", ")}`);
  return path;
}

/** Validate a user-supplied project directory and return its canonical path. */
export function resolveProjectDir(raw: string): string {
  const path = existingDirInRoots(raw);
  if (isWithin(path, real(settings.data_dir))) throw new ProjectDirError("Project directory cannot be inside the FluidForm data directory");
  return path;
}

function git(path: string, ...args: string[]): string | null {
  const result = spawnSync("git", ["-C", path, ...args], { encoding: "utf8", timeout: 5000 });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

export type GitSnapshot = { git: false } | { git: true; head: string; branch: string | null; uncommitted_files: number };

/** Record where the project started so the user can diff or revert agent edits. */
export function gitSnapshot(path: string): GitSnapshot {
  const commit = git(path, "rev-parse", "HEAD");
  if (commit === null) return { git: false };
  const status = git(path, "status", "--porcelain") || "";
  return { git: true, head: commit, branch: git(path, "rev-parse", "--abbrev-ref", "HEAD"), uncommitted_files: status ? status.split(/\r\n|\n|\r/).length : 0 };
}

/** A short, planner-facing description of the target project. */
export function projectContext(path: string): string {
  const entries = readdirSync(path, { withFileTypes: true }).filter((entry) => entry.name !== ".git")
    .map((entry) => ({ name: entry.name, dir: entry.isDirectory() || (entry.isSymbolicLink() && isDir(join(path, entry.name))) }))
    .sort((a, b) => Number(!a.dir) - Number(!b.dir) || (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));
  const names = entries.slice(0, MAX_CONTEXT_ENTRIES).map((entry) => (entry.dir ? `${entry.name}/` : entry.name));
  if (entries.length > MAX_CONTEXT_ENTRIES) names.push(`... (${entries.length - MAX_CONTEXT_ENTRIES} more)`);
  const snapshot = gitSnapshot(path);
  const gitLine = snapshot.git ? `git branch ${snapshot.branch ?? "None"}, ${snapshot.uncommitted_files} uncommitted file(s)` : "not a git repository";
  return `Target project: ${path} (${gitLine})\nTop-level entries: ${names.join(", ") || "(empty)"}`;
}

/** Recent work touches the git index or HEAD, so their modification time ranks active projects first. */
function gitMarkerTime(path: string): number {
  const times: number[] = [];
  for (const name of ["index", "HEAD"]) {
    try {
      times.push(statSync(join(path, ".git", name)).mtimeMs / 1000);
    } catch {
      // not there
    }
  }
  if (!times.length) {
    try {
      times.push(statSync(join(path, ".git")).mtimeMs / 1000);
    } catch {
      // not there
    }
  }
  return times.length ? Math.max(...times) : 0;
}

export type Discovered = { name: string; path: string; active_at: number };

/** Find git checkouts under the allowed roots, most recently active first. The walk is breadth-first,
 *  skips hidden and dependency folders, never follows symlinks out of the roots, stops descending at a
 *  repository, and gives up after a time budget. */
export function discoverProjects(maxDepth = DISCOVER_DEPTH, limit = MAX_DISCOVERED, seconds = DISCOVER_SECONDS): { projects: Discovered[]; truncated: boolean } {
  const deadline = performance.now() + seconds * 1000;
  const dataDir = real(settings.data_dir);
  const queue: [string, number][] = allowedRoots().map((root) => [root, 0]);
  const found: Discovered[] = [];
  let truncated = false;
  while (queue.length) {
    if (found.length >= limit || performance.now() > deadline) {
      truncated = true;
      break;
    }
    const [path, depth] = queue.shift()!;
    let children;
    try {
      children = readdirSync(path, { withFileTypes: true }).sort((a, b) => {
        const [x, y] = [a.name.toLowerCase(), b.name.toLowerCase()];
        return x < y ? -1 : x > y ? 1 : 0;
      });
    } catch {
      continue;
    }
    if (children.some((child) => child.name === ".git")) {
      found.push({ name: basename(path), path, active_at: gitMarkerTime(path) });
      continue;
    }
    if (depth >= maxDepth) continue;
    for (const child of children) {
      if (child.name.startsWith(".") || SKIP_DISCOVERY.has(child.name)) continue;
      const where = join(path, child.name);
      if (child.isDirectory() && !isWithin(where, dataDir)) queue.push([where, depth + 1]);
    }
  }
  // A stable sort, latest first (Python's sort with reverse=True keeps equal ones in order).
  found.sort((a, b) => b.active_at - a.active_at);
  return { projects: found, truncated };
}

/** Validate a project directory and describe its git state for the web console. */
export function inspectProject(raw: string): Record<string, unknown> {
  const path = resolveProjectDir(raw);
  return { path, ...gitSnapshot(path) };
}
