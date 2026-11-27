// Bounded public SKILL.md discovery. No task text, credentials, installs or
// remote code execution.
//
// Repository search works without a GitHub token; code search does not. Search by tool name, inspect
// a few matching trees, then read immutable Markdown blobs. A miss or rate limit is advisory. The
// caller owns the task's network permission and persists a successful general reference.
import { pyRegex, skills } from "../../../src/extension-api.js";

export const limits = { SEARCH_TIMEOUT: 30 };
export const MAX_REPOSITORIES = 3;
export const MAX_CANDIDATES = 6;
export const MAX_PER_REPOSITORY = 2;
export const MAX_REQUESTS = 12;
export const MAX_SKILL_BYTES = 40_000;
export const MAX_RESPONSE_BYTES = 2_000_000;
const REQUEST_TIMEOUT = 8;

export type Discovery = { skill: skills.Skill | null; reason: string };
export type Fetch = typeof fetch;

/** A request that did not succeed (httpx's HTTPStatusError). */
class HTTPStatusError extends Error {
  override name = "HTTPStatusError";
}

const TOOL = pyRegex(String.raw`^[\w.+-]{2,64}$`);
const REPOSITORY = pyRegex(String.raw`^[\w.-]+/[\w.-]+$`);
const SHA = /^[a-f0-9]{40,64}$/;
const quote = (text: string) => encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const quotePath = (text: string) => text.split("/").map(quote).join("/");

// Parts of an install path that say nothing about what a program is.
const PLAIN_PARTS = new Set(["bin", "sbin", "usr", "local", "opt", "home", "lib", "lib64", "share", "tools", "tool", "linux", "linux64", "amd64",
  "x86_64", "workspace", "workspaces", "apps", "app", "software", "packages", "current", "latest", "default", "release", "install", "node_modules"]);

/** What a program's install paths say about it, in words a skill about it would use (".../synopsys/
 *  vc_static/V-2023.12/bin/vcf": synopsys, vc_static, static): kept on this machine, never sent. */
export function contextWords(paths: string[], tools: string[]): string[] {
  const own = new Set(tools.map((tool) => tool.toLowerCase()));
  const words = new Set<string>();
  for (const path of paths) {
    for (const part of path.toLowerCase().split("/")) {
      if (!part || /\d/.test(part) || part.startsWith(".") || PLAIN_PARTS.has(part) || own.has(part)) continue;
      for (const word of [part, ...part.split(/[_.-]+/)]) if (word.length >= 3 && !PLAIN_PARTS.has(word) && !own.has(word)) words.add(word);
    }
  }
  return [...words];
}

/** Whether a skill's text is about the program on this machine: it names one of ``context`` (from its
 *  install path), or there is nothing to tell by. 2026-11-27: "vcf" found a VMware Cloud Foundation
 *  skill for Synopsys VC Formal. */
export function fits(text: string, context: string[]): boolean {
  return !context.length || context.some((word) => skills.namesTool(text, word));
}

/** The first structurally valid, tool-matching public skill, or an explicit reason. ``context`` (words
 *  from where the tools are installed, contextWords) is checked here, never sent. */
export async function discover(tools: string[], { fetcher = fetch, context = [] }: { fetcher?: Fetch; context?: string[] } = {}): Promise<Discovery> {
  const wanted = [...new Set(tools.filter((tool) => TOOL.test(tool)).map((tool) => tool.toLowerCase()))].slice(0, 2);
  if (!wanted.length) return { skill: null, reason: "No searchable tool name" };
  const stop = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<Discovery>((done) => {
    timer = setTimeout(() => {
      stop.abort();
      done({ skill: null, reason: "Public skill search timeout" });
    }, limits.SEARCH_TIMEOUT * 1000);
  });
  try {
    return await Promise.race([search(fetcher, wanted, stop.signal, context), deadline]);
  } catch (error) {
    if (stop.signal.aborted) return { skill: null, reason: "Public skill search timeout" };
    // URLs contain only public tool names and repositories; no task or credential is sent.
    const problem = error as Error;
    return { skill: null, reason: `Public skill search unavailable: ${problem.name}: ${String(problem.message).slice(0, 180)}` };
  } finally {
    clearTimeout(timer);
    stop.abort();
  }
}

async function search(fetcher: Fetch, tools: string[], signal: AbortSignal, context: string[]): Promise<Discovery> {
  let remaining = MAX_REQUESTS;
  const get = async (path: string, params: Record<string, string | number> = {}): Promise<any> => {
    if (remaining <= 0) throw new Error("skill search request limit reached");
    remaining -= 1;
    const query = new URLSearchParams(Object.entries(params).map(([key, value]): [string, string] => [key, String(value)])).toString();
    const url = "https://api.github.com" + path + (query ? `?${query}` : "");
    // Fixed public host and no redirects: search results cannot redirect the host to local data.
    const response = await fetcher(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "FluidForm-Skill-Discovery" },
      redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT * 1000)]) });
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel();
      throw new HTTPStatusError(`'${response.status} ${response.statusText}' for url '${url}'`);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) throw new Error("skill discovery response too large");
        chunks.push(chunk);
      }
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
  const field = (value: any, key: string, fallback: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`'${typeof value}' object has no attribute 'get'`);
    return key in value ? value[key] : fallback;
  };

  const seen = new Set<string>();
  let inspected = 0;
  for (const tool of tools) {
    const data = await get("/search/repositories", { q: `${tool} skill in:name,description archived:false fork:false`, per_page: MAX_REPOSITORIES });
    for (const repo of (field(data, "items", []) as any[]).slice(0, MAX_REPOSITORIES)) {
      const name = String(field(repo, "full_name", ""));
      const branch = String(field(repo, "default_branch", "main"));
      if (seen.has(name) || !REPOSITORY.test(name)) continue;
      seen.add(name);
      const tree = await get(`/repos/${name}/git/trees/${quote(branch)}`, { recursive: "1" });
      const candidates = (field(tree, "tree", []) as any[]).filter((item) => {
        const path = String(field(item, "path", ""));
        const size = field(item, "size", 0);
        return field(item, "type", null) === "blob" && field(item, "mode", null) === "100644" && path.split("/").at(-1) === "SKILL.md"
          && typeof size === "number" && size > 0 && size <= MAX_SKILL_BYTES && !path.split("/").includes("..")
          && SHA.test(String(field(item, "sha", "")));
      });
      // Paths naming a wanted tool first (a stable sort, as Python's).
      const named = (item: any) => tools.some((wanted) => String(item.path).toLowerCase().includes(wanted));
      candidates.sort((a, b) => Number(!named(a)) - Number(!named(b)));
      for (const item of candidates.slice(0, MAX_PER_REPOSITORY)) {
        if (inspected >= MAX_CANDIDATES || remaining <= 0) return { skill: null, reason: "No matching standalone skill within search limit" };
        inspected += 1;
        const blob = await get(`/repos/${name}/git/blobs/${item.sha}`);
        if (field(blob, "encoding", null) !== "base64") continue;
        const raw = Buffer.from(String(field(blob, "content", "")), "base64");
        if (raw.length > MAX_SKILL_BYTES) continue;
        const skill = skills.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
        if (!skill || !skill.description || !skill.body) continue;
        const text = `${skill.name}\n${skill.description}\n${skill.body}`;
        if (!tools.every((wanted) => skills.namesTool(text, wanted)) || !fits(text, context)) continue;
        skill.tools = tools;
        skill.source_url = `https://github.com/${name}/blob/${quote(branch)}/${quotePath(item.path)}`;
        skill.source_revision = item.sha;
        return { skill, reason: "" };
      }
    }
  }
  return { skill: null, reason: "No matching public SKILL.md found" };
}

/** How a public skill is searched for; tests replace it. */
export const deps = { discover };
