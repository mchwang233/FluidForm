// skill-discovery.ts: tests/test_skill_discovery.py, ported. Public skill discovery is bounded,
// reusable, and never a machine verification claim.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { settings } from "../src/config.js";
import * as discovery from "../packages/learning/src/skill-discovery.js";
import * as skills from "../src/skills.js";

const TEXT = "---\nname: demo-tool\ndescription: Use demo-tool\n---\n# Usage\nRun `demo-tool --check`.\n";
const SHA = "a".repeat(40);
const saved = { ...settings };
beforeEach(() => {
  settings.data_dir = join(mkdtempSync(join(tmpdir(), "discovery-")), "data");
});
afterEach(() => {
  Object.assign(settings, saved);
  discovery.limits.SEARCH_TIMEOUT = 30;
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Reply = (url: URL, init: RequestInit) => Response | Promise<Response>;
function fetcherFor(reply: Reply, requests: [URL, RequestInit][] = []): discovery.Fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    requests.push([url, init]);
    return reply(url, init);
  }) as discovery.Fetch;
}
function github(text = TEXT): Reply {
  return (url, init) => {
    assert.equal(url.host, "api.github.com");
    assert.ok(!Object.keys(init.headers ?? {}).some((key) => key.toLowerCase() === "authorization"));
    if (url.pathname === "/search/repositories") return json({ items: [{ full_name: "example/tool-skills", default_branch: "main" }] });
    if (url.pathname.includes("/git/trees/")) {
      return json({ tree: [{ path: "skills/demo-tool/SKILL.md", type: "blob", mode: "100644", sha: SHA, size: Buffer.byteLength(text) }] });
    }
    if (url.pathname.includes("/git/blobs/")) return json({ encoding: "base64", content: Buffer.from(text).toString("base64") });
    throw new Error(String(url));
  };
}

test("discovery reuses a public skill with its provenance and runs nothing", async () => {
  const requests: [URL, RequestInit][] = [];
  const result = await discovery.discover(["demo-tool"], { fetcher: fetcherFor(github(), requests) });
  assert.ok(result.skill);
  assert.deepEqual(result.skill.tools, ["demo-tool"]);
  assert.ok(!result.skill.machine && result.skill.source_url.includes("example/tool-skills"));
  assert.equal(result.skill.source_revision, SHA);
  assert.equal(requests.length, 3);
  assert.ok(requests[0][0].searchParams.get("q")!.includes("demo-tool"));
  const path = skills.saveDiscovered(result.skill);
  assert.equal(readFileSync(path, "utf8"), TEXT); // upstream metadata and content kept verbatim
  const [cached] = skills.discovered(["demo-tool"]);
  assert.ok(cached.source_revision === SHA && !cached.machine);
  // Never one of the skills a step is given; only a reference for writing this machine's one.
  assert.deepEqual(skills.library().filter((skill) => skill.source_url), []);
  assert.deepEqual(skills.discovered(["other"]), []);
});

test("discovery rejects invalid or irrelevant content", async () => {
  for (const content of ["not a skill", TEXT.replaceAll("demo-tool", "unrelated-tool")]) {
    const result = await discovery.discover(["demo-tool"], { fetcher: fetcherFor(github(content)) });
    assert.ok(result.skill === null && result.reason);
  }
});

test("a search failure does not block and a rate limit is not retried", async () => {
  const seen: [URL, RequestInit][] = [];
  const result = await discovery.discover(["demo-tool"], { fetcher: fetcherFor(() => new Response("", { status: 429, headers: { "Retry-After": "3600" } }), seen) });
  assert.ok(result.skill === null && result.reason.includes("429") && seen.length === 1);
});

test("discovery has a total deadline", async () => {
  discovery.limits.SEARCH_TIMEOUT = 0.01;
  const result = await discovery.discover(["demo-tool"], { fetcher: fetcherFor(() => new Promise<Response>(() => undefined)) });
  assert.ok(result.skill === null && result.reason.toLowerCase().includes("timeout"));
});

test("discovery follows no redirects and never searches the task's text", async () => {
  const seen: [URL, RequestInit][] = [];
  const result = await discovery.discover(["demo-tool"], { fetcher: fetcherFor((_url, init) => {
    assert.equal(init.redirect, "manual");
    return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
  }, seen) });
  assert.ok(result.skill === null && seen.length === 1);
  assert.ok(seen[0][0].searchParams.get("q")!.includes("demo-tool"));
});

test("a malformed search result is an advisory miss", async () => {
  const result = await discovery.discover(["demo-tool"], { fetcher: fetcherFor(() => json([])) });
  assert.ok(result.skill === null && result.reason);
});

test("an unrelated first repository does not use up every candidate", async () => {
  const normal = github();
  const firstBlobs: URL[] = [];
  const result = await discovery.discover(["demo-tool"], { fetcher: fetcherFor((url, init) => {
    if (url.pathname === "/search/repositories") {
      return json({ items: [{ full_name: "example/unrelated", default_branch: "main" }, { full_name: "example/tool-skills", default_branch: "main" }] });
    }
    if (url.pathname.includes("/unrelated/git/trees/")) {
      return json({ tree: Array.from({ length: 10 }, (_, i) => ({ path: `skills/other-${i}/SKILL.md`, type: "blob", mode: "100644", sha: SHA, size: 100 })) });
    }
    if (url.pathname.includes("/unrelated/git/blobs/")) {
      firstBlobs.push(url);
      return json({ encoding: "base64", content: Buffer.from("unrelated").toString("base64") });
    }
    return normal(url, init);
  }) });
  assert.ok(result.skill && result.skill.source_url.includes("tool-skills"));
  assert.ok(firstBlobs.length <= 2);
});

test("modified cached text is not silently reused", async () => {
  const result = await discovery.discover(["demo-tool"], { fetcher: fetcherFor(github()) });
  const path = skills.saveDiscovered(result.skill!);
  writeFileSync(path, readFileSync(path, "utf8") + "unrecorded modification");
  assert.deepEqual(skills.discovered().filter((skill) => skill.path === path), []);
  assert.ok(existsSync(path));
});
