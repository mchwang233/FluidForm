// A finished task's output: its files, a ZIP download, and publishing to GitHub.
//
// A task without a project writes into its scratch folder, and all of it is the output. A task on a
// project changed files in the user's own checkout, so only the files its steps changed are output, and
// that checkout is never pushed from here.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { settings } from "./config.js";
import { type ExecutionRun, folderId } from "./models.js";
import { writeZip } from "./zip.js";

// Tool and review folders the agents leave behind are not part of the output.
export const SKIP = new Set([".git", ".review", ".claude", ".codex", "node_modules", "__pycache__", ".venv", "venv", ".super-partner"]);
export const MAX_FILES = 5_000;
export const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
export const MAX_VIEW_BYTES = 1024 * 1024;
export const GITHUB_API = "https://api.github.com";
export const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
export const GITHUB_REMOTE = /^(git@github\.com:|https:\/\/github\.com\/)[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?(\.git)?\/?$/;

export class PublishError extends Error {}

export type OutputFile = { path: string; size: number };

export function outputRoot(run: ExecutionRun): string {
  return run.project_dir ? run.project_dir : join(settings.workspace_root, folderId(run));
}

const isDir = (path: string) => existsSync(path) && statSync(path).isDirectory();
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Relative path and size of every output file. */
export function outputFiles(run: ExecutionRun): OutputFile[] {
  const root = outputRoot(run);
  if (!isDir(root)) return [];
  let candidates: string[] = [];
  if (run.project_dir) candidates = [...new Set(run.plan.nodes.flatMap((node) => node.changed_files))].sort(byName).map((name) => join(root, name));
  else {
    // os.walk, top down: a folder's files, then its folders in name order.
    const walk = (folder: string) => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(folder, { withFileTypes: true });
      } catch {
        return;
      }
      const folders = entries.filter((entry) => entry.isDirectory() && !SKIP.has(entry.name)).map((entry) => entry.name).sort(byName);
      candidates.push(...entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name).sort(byName).map((name) => join(folder, name)));
      if (candidates.length >= MAX_FILES) return;
      for (const name of folders) {
        if (candidates.length >= MAX_FILES) return;
        walk(join(folder, name));
      }
    };
    walk(root);
  }
  const found: OutputFile[] = [];
  for (const path of candidates.slice(0, MAX_FILES)) {
    try {
      const info = lstatSync(path);
      if (info.isFile()) found.push({ path: relative(root, path).split("\\").join("/"), size: info.size });
    } catch {
      // gone, or never there (a project's deleted file)
    }
  }
  return found;
}

/** An output file by its relative path; anything else (escapes, unlisted files) is refused. */
export function resolveOutput(run: ExecutionRun, path: string): string {
  if (!outputFiles(run).some((item) => item.path === path)) throw new PublishError("文件不在这个任务的输出里");
  return join(outputRoot(run), path);
}

export function readOutput(run: ExecutionRun, path: string): string {
  const data = readFileSync(resolveOutput(run, path)).subarray(0, MAX_VIEW_BYTES + 1);
  if (data.subarray(0, 8192).includes(0)) throw new PublishError("这是二进制文件，请下载 ZIP 后查看");
  return new TextDecoder("utf-8").decode(data.subarray(0, MAX_VIEW_BYTES)) + (data.length > MAX_VIEW_BYTES ? "\n[... 文件过大，只显示前 1 MB]" : "");
}

const STATUS: Record<string, string> = { succeeded: "已完成", failed: "失败", unable: "无法完成", blocked: "未执行" };

/** A readable record of the task: request, final result, and each step's output. */
export function resultMarkdown(run: ExecutionRun): string {
  const lines = [`# ${run.plan.summary}`, "", `> ${run.prompt}`, "", "## 最终结果", "", run.final_result || "（无）", ""];
  run.plan.nodes.forEach((node, index) => {
    lines.push(`## ${String(index + 1).padStart(2, "0")} ${node.title}（${STATUS[node.status] ?? node.status} · ${node.model_id || "未分配"}）`, "");
    if (node.unable_reason) lines.push(`**无法完成的原因**：${node.unable_reason}`, "");
    lines.push(node.result || "（无输出）", "");
  });
  return lines.join("\n");
}

export function slug(run: ExecutionRun): string {
  const base = run.plan.summary.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 40);
  return `${base || "task"}-${new Date(run.created_at).toISOString().slice(0, 10).replaceAll("-", "")}-${run.id.slice(0, 6)}`;
}

export function archive(run: ExecutionRun): Buffer {
  const root = outputRoot(run);
  let total = 0;
  const entries = [];
  const names = new Set<string>();
  for (const item of outputFiles(run)) {
    total += item.size;
    if (total > MAX_ARCHIVE_BYTES) throw new PublishError("输出文件超过 200 MB，无法打包");
    const path = join(root, item.path);
    entries.push({ name: item.path, data: readFileSync(path), deflate: true, modified: statSync(path).mtime, mode: statSync(path).mode & 0o777 | 0o100000 });
    names.add(item.path);
  }
  entries.push({ name: names.has("RESULT.md") ? "SUPER_PARTNER_RESULT.md" : "RESULT.md", data: resultMarkdown(run), deflate: true });
  return writeZip(entries);
}

const clean = (text: string, token: string | null) => (token ? text.replaceAll(token, "***") : text);

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv, token: string | null = null): void {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8", timeout: 120_000 });
  if (result.status !== 0) throw new PublishError(clean(`git ${args[0]} 失败：${(result.stderr || result.stdout || String(result.error ?? "")).trim().slice(-400)}`, token));
}

function identity(): [string, string] {
  const get = (key: string) => (spawnSync("git", ["config", "--global", key], { encoding: "utf8" }).stdout ?? "").trim();
  return [get("user.name") || "FluidForm", get("user.email") || "super-partner@localhost"];
}

/** Commit the task's output in a fresh repository and push it as ``main``. */
export function pushSnapshot(run: ExecutionRun, remote: string, token: string | null = null): void {
  mkdirSync(settings.data_dir, { recursive: true });
  const staging = mkdtempSync(join(settings.data_dir, "publish-"));
  try {
    writeFileSync(join(staging, "RESULT.md"), resultMarkdown(run));
    for (const item of outputFiles(run)) {
      const target = join(staging, item.path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(outputRoot(run), item.path), target);
    }
    const [name, email] = identity();
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
    if (token) {
      // The token goes in through the environment, never on a command line or in the URL.
      const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
      Object.assign(env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` });
    }
    git(["init", "-q", "-b", "main"], staging, env);
    git(["add", "-A"], staging, env);
    git(["commit", "-q", "-m", `${run.plan.summary}\n\nGenerated by FluidForm from task ${run.id}.`], staging, env);
    git(["push", "-q", remote, "main"], staging, env, token);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function createRepository(token: string, name: string, isPrivate: boolean, description: string, fetcher: typeof fetch = fetch): Promise<Record<string, any>> {
  const response = await fetcher(`${GITHUB_API}/user/repos`, { method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "content-type": "application/json" },
    body: JSON.stringify({ name, private: isPrivate, description: description.slice(0, 300), auto_init: false }) });
  if (response.status === 401) throw new PublishError("GitHub 令牌无效或已过期");
  if (response.status === 422) throw new PublishError(`GitHub 上已经有名为 ${name} 的仓库，换个名字再试`);
  const text = await response.text();
  if (response.status >= 400) throw new PublishError(clean(`GitHub 创建仓库失败（${response.status}）：${text.slice(0, 200)}`, token));
  return JSON.parse(text);
}

export function checkRemote(given: string): string {
  const remote = given.trim();
  if (!GITHUB_REMOTE.test(remote)) throw new PublishError("请填写 GitHub 仓库地址，例如 git@github.com:you/repo.git");
  return remote;
}
