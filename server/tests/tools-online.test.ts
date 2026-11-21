// agent.ts's pictures, web, MCP and review reads; quota.ts; web.ts: tests from test_images,
// test_web, test_mcp, test_review_evidence, test_continue, test_preflight, test_defaults and
// test_quota, ported.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import * as agent from "../src/agent.js";
import { Workspace } from "../src/agent.js";
import { settings } from "../src/config.js";
import { Database } from "../src/db.js";
import * as images from "../src/images.js";
import * as mcp from "../src/mcp.js";
import { ExecutionRunSchema, TaskNodeSchema } from "../src/models.js";
import * as quality from "../src/quality.js";
import { isQuotaError, QuotaTracker, resetTime } from "../src/quota.js";
import * as web from "../src/web.js";

const saved = { ...settings };
const env = { ...process.env };
const deps = { images: { ...images.deps }, web: { ...web.deps }, mcp: { ...mcp.deps } };
let folder = "";
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "online-"));
});
afterEach(() => {
  Object.assign(settings, saved);
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  Object.assign(images.deps, deps.images);
  Object.assign(web.deps, deps.web);
  Object.assign(mcp.deps, deps.mcp);
  mcp.LISTED.clear();
  rmSync(folder, { recursive: true, force: true });
});

class Budget {
  charged: number[] = [];
  constructor(public left: number) {}
  canSpend(cost: number) {
    return this.left >= cost;
  }
  async recordUsd(cost: number) {
    this.charged.push(cost);
    this.left -= cost;
  }
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(32)]);

test("the project map lists files with their lengths", () => {
  mkdirSync(join(folder, "src"));
  writeFileSync(join(folder, "src", "app.py"), "a\nb\nc\n");
  mkdirSync(join(folder, "shots"));
  writeFileSync(join(folder, "shots", "a.png"), Buffer.from("\x89PNG", "latin1"));
  for (const hidden of [".tmp-verify", "node_modules"]) {
    mkdirSync(join(folder, hidden));
    writeFileSync(join(folder, hidden, "x.txt"), "x");
  }
  const text = agent.projectMap(folder);
  assert.ok(text.includes("src/app.py (3 lines)") && text.includes("shots/: 1 binary files (.png)") && !text.includes("x.txt"), text);
});

test("a long file is read whole in one call", async () => {
  writeFileSync(join(folder, "app.js"), Array.from({ length: 2500 }, (_, i) => `line ${i} ` + "x".repeat(30) + "\n").join(""));
  const ws = new Workspace(folder);
  const text = await ws.call("Read", { file_path: "app.js" });
  // Claude Code's default: the first 2000 lines, and how to go on.
  assert.ok(text.includes("line 1999") && !text.includes("line 2000") && text.includes("[lines 1-2000 of 2500; pass offset"));
  assert.ok((await ws.call("Read", { file_path: "app.js", offset: 2001 })).includes("line 2499"));
});

test("pictures and searches use the keys there are", () => {
  process.env.ZHIPU_API_KEY = "g";
  delete process.env.MINIMAX_API_KEY;
  settings.image_models = null;
  settings.web_search_models = null;
  assert.deepEqual([images.available(), web.searchServices()], [["glm:cogview-4"], ["glm:search_std"]]);
  process.env.MINIMAX_API_KEY = "m";
  assert.deepEqual(images.available(), ["minimax:image-01", "glm:cogview-4"]);
  // [] still means none.
  settings.image_models = [];
  settings.web_search_models = [];
  assert.deepEqual([images.available(), web.searchServices()], [[], []]);
  delete process.env.ZHIPU_API_KEY;
  settings.web_search_models = null;
  assert.deepEqual(web.searchServices(), []);
});

test("the image tool saves the picture in its own format and charges it", async () => {
  process.env.ZHIPU_API_KEY = "g";
  process.env.MINIMAX_API_KEY = "m";
  settings.image_models = ["minimax:image-01", "glm:cogview-4"];
  images.deps.generate = async (prompt, shape = "square") => {
    assert.deepEqual([prompt, shape], ["头像", "square"]);
    return [JPEG, "minimax:image-01"];
  };
  const workspace = new Workspace(folder);
  const budget = new Budget(1);
  workspace.budget = budget;
  let [output, ok] = await workspace.run("GenerateImage", { prompt: "头像", file_path: "out/avatar.png" });
  assert.ok(ok && output.includes("avatar.jpg") && readFileSync(join(folder, "out", "avatar.jpg")).equals(JPEG));
  assert.deepEqual(budget.charged, [images.price("minimax:image-01")]);
  // Not when the budget cannot pay for it, nor for a reviewer.
  workspace.budget = new Budget(0);
  [output, ok] = await workspace.run("GenerateImage", { prompt: "头像", file_path: "b.png" });
  assert.ok(!ok && output.includes("budget"));
  [output, ok] = await new Workspace(folder, { readOnly: true }).run("GenerateImage", { prompt: "x", file_path: "c.png" });
  assert.ok(!ok);
});

const jpeg = (width: number, height: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF\0"),
  Buffer.alloc(9), Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03]), Buffer.alloc(9 + 16)]);

test("reading a picture says what it is instead of failing", async () => {
  // Regression: Read answered "is a binary file" (an error) for a picture GenerateImage had just
  // made, and a model that tried to look at it reported the finished step as UNABLE.
  writeFileSync(join(folder, "avatar.jpg"), jpeg(1024, 1024));
  const png = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n\0\0\0\rIHDR", "latin1"), Buffer.from([0, 0, 0, 64, 0, 0, 0, 32]), Buffer.alloc(8)]);
  writeFileSync(join(folder, "icon.png"), png);
  const workspace = new Workspace(folder);
  let [output, ok] = await workspace.run("Read", { file_path: "avatar.jpg" });
  assert.ok(ok && output.includes("is a picture (JPG, 1024×1024") && output.includes("not a reason to report the work as not done"), output);
  [output, ok] = await workspace.run("Read", { file_path: "icon.png" });
  assert.ok(ok && output.includes("64×32"));
  // Other binary files are still refused, and the image tool no longer sends models to look.
  writeFileSync(join(folder, "a.zip"), "PK");
  assert.ok(!(await workspace.run("Read", { file_path: "a.zip" }))[1]);
  assert.ok(agent.IMAGE_TOOL.description.includes("Read does not show pictures"));
});

// A fake MCP server, in Node.
const SERVER = `
const readline = require("node:readline");
const reply = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (!("id" in message)) return;
  let answer = null;
  if (message.method === "initialize") {
    process.stdout.write("not json on stdout\\n");
    answer = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "t" } };
  } else if (message.method === "tools/list") {
    answer = { tools: [{ name: "add", description: "Adds", inputSchema: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } } } },
      { name: "secret", inputSchema: "bad" }] };
  } else if (message.method === "tools/call") {
    const args = message.params.arguments;
    if (message.params.name === "secret") answer = { content: [{ type: "text", text: process.env.TOKEN || "none" }] };
    else if (!("a" in args)) answer = { content: [{ type: "text", text: "a is missing" }], isError: true };
    else {
      reply({ jsonrpc: "2.0", method: "notifications/progress", params: {} });
      answer = { content: [{ type: "text", text: String(args.a + args.b) }] };
    }
  }
  reply({ jsonrpc: "2.0", id: message.id, result: answer });
});
`;

function serverWorkspace(sandboxed: boolean, secrets = true): Workspace {
  const script = join(folder, "server.cjs");
  writeFileSync(script, SERVER);
  settings.mcp_servers = { calc: { command: [process.execPath, script], ...(secrets ? { secrets: ["TOKEN"] } : {}) } };
  mcp.deps.secretsFor = async () => ({ TOKEN: "s3cret" });
  const workspace = new Workspace(folder);
  // The protocol, without depending on bubblewrap here: the command as it is.
  if (!sandboxed) workspace.sandboxArgs = (command: string) => ["/bin/sh", "-c", command];
  return workspace;
}

test("a server's tools are listed once and called", async () => {
  const server = serverWorkspace(false);
  const tools = await mcp.definitions(server);
  assert.deepEqual(tools.map((tool) => tool.name), ["mcp__calc__add", "mcp__calc__secret"]);
  assert.deepEqual((tools[0].parameters as any).properties.a, { type: "integer" });
  assert.deepEqual(tools[1].parameters, { type: "object", properties: {} });
  assert.deepEqual(await server.run("mcp__calc__add", { a: 2, b: 3 }), ["5", true]);
  const [output, ok] = await server.run("mcp__calc__add", { b: 3 });
  assert.ok(!ok && output.includes("a is missing"));
  // Its secrets reach it as its environment.
  assert.deepEqual(await server.run("mcp__calc__secret", {}), ["s3cret", true]);
  assert.equal(mcp.LISTED.size, 1);
});

test("a reviewer gets no MCP tools, and a broken server is skipped", async () => {
  const server = serverWorkspace(false);
  assert.deepEqual(await mcp.definitions(new Workspace(folder, { readOnly: true })), []);
  settings.mcp_servers = { gone: { command: ["false"] }, "Bad Name": { command: ["x"] } };
  assert.deepEqual(await mcp.definitions(server), []);
  assert.equal([...mcp.LISTED.values()][0][1], null);
  const [output, ok] = await server.run("mcp__gone__x", {});
  assert.ok(!ok && output.includes("unknown tool"));
});

test("an MCP server runs in the step's sandbox", async () => {
  const workspace = serverWorkspace(true, false);
  assert.equal((await mcp.definitions(workspace))[0].name, "mcp__calc__add");
  assert.deepEqual(await workspace.run("mcp__calc__add", { a: 1, b: 1 }), ["2", true]);
});

test("every model is told where it runs", async () => {
  // A model that does not know it is in a sandbox works around limits it does not see.
  const step = await agent.agentInstructions(null, false, "/w");
  for (const part of ["Where you are: a sandbox", "not root", "home folder is hidden", "Commands have no network access"]) assert.ok(step.includes(part), part);
  assert.ok((await agent.agentInstructions(null, true, "/w")).includes("this task allows the internet"));
  assert.ok(agent.HOST_INSTRUCTIONS.includes("not in the task's steps' sandbox"));
  const run = ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "queued", budget_usd: 1, allow_network: true, plan: { summary: "s", nodes: [] } });
  for (const modelId of ["cli:codex", "cli:claude"]) {
    const [prompt] = quality.nodePrompt(TaskNodeSchema.parse({ id: "n", title: "t", instructions: "i", capability: "coding", model_id: modelId }), run, 4000);
    assert.ok(prompt.includes("FluidForm runs you in your own sandbox") && prompt.includes("allows the internet"));
    assert.ok(prompt.includes("find . -name '*.o' -delete")); // the same note for every CLI
  }
  const apiStep = TaskNodeSchema.parse({ id: "n", title: "t", instructions: "i", capability: "coding", model_id: "x:flash" });
  assert.ok(!quality.nodePrompt(apiStep, run, 4000)[0].includes("FluidForm runs you"));
});

const NOW = new Date(Date.UTC(2026, 9, 15, 2, 0));
const SESSION_LIMIT = "claude failed: You've hit your session limit · resets 2pm (Asia/Shanghai)";
const HOUR = 3600_000;

for (const period of ["usage", "session", "weekly", "daily", "monthly"]) {
  test(`a membership ${period} limit is a quota error`, () => {
    assert.ok(isQuotaError(`claude failed: You've hit your ${period} limit · resets 2pm (Asia/Shanghai)`));
  });
}

test("a session reset uses the reported time zone", () => {
  assert.deepEqual(resetTime(SESSION_LIMIT, NOW), new Date(Date.UTC(2026, 9, 15, 6)));
  assert.deepEqual(resetTime(SESSION_LIMIT, new Date(Date.UTC(2026, 9, 15, 7))), new Date(Date.UTC(2026, 9, 16, 6)));
  // Unknown zone names keep the machine-local fallback: 2pm here.
  assert.equal(resetTime(SESSION_LIMIT.replace("Asia/Shanghai", "Unknown/Zone"), NOW).getHours(), 14);
});

test("quota messages are recognised and their reset times read", () => {
  assert.ok(isQuotaError("claude failed: Claude AI usage limit reached|1760500800"));
  assert.ok(isQuotaError("deepseek returned 402: Insufficient Balance"));
  assert.ok(isQuotaError("You've hit your usage limit. Try again in 2 hours 13 minutes."));
  assert.ok(!isQuotaError("claude failed: unknown option --foo"));
  const epoch = Math.floor((NOW.getTime() + 3 * HOUR) / 1000);
  assert.deepEqual(resetTime(`Claude AI usage limit reached|${epoch}`, NOW), new Date(NOW.getTime() + 3 * HOUR));
  assert.deepEqual(resetTime("hit your usage limit, try again in 2 hours 13 minutes", NOW), new Date(NOW.getTime() + 2 * HOUR + 13 * 60_000));
  assert.deepEqual(resetTime("openai returned 429: rate limit", NOW), new Date(NOW.getTime() + 5 * 60_000));
  assert.deepEqual(resetTime("deepseek returned 402: Insufficient Balance", NOW), new Date(NOW.getTime() + HOUR));
  const resets = resetTime("You've hit your limit · resets 3pm", NOW);
  assert.deepEqual([resets.getHours(), resets.getMinutes()], [15, 0]);
  assert.ok(NOW < resets && resets.getTime() <= NOW.getTime() + 24 * HOUR);
});

test("cooldowns and model-scoped error rules survive a restart", () => {
  const database = new Database(join(folder, "shared.db"));
  const tracker = new QuotaTracker(database);
  const message = "provider denied request: E_WINDOW_EMPTY request_id=abcd-1234";
  tracker.learn("x:one", message, "quota", "run1", "d1");
  const marked = tracker.mark("x:one", "usage limit reached");
  tracker.mark("y:two", "y returned 503", "unavailable");
  const restarted = new QuotaTracker(database);
  assert.equal(restarted.error("x:one").until.getTime(), Math.floor(marked.until.getTime())); // stored to the millisecond
  assert.equal(restarted.error("y:two").kind, "unavailable");
  assert.equal(restarted.classify("x:one", message.replace("abcd-1234", "new-id")), "quota");
  assert.equal(restarted.classify("x:other", message), null);
  assert.equal(restarted.classify("x:one", "provider denied request: BAD_PARAMETER"), null);
  restarted.clear("x:one");
  assert.ok(!new QuotaTracker(database).exhausted("x:one"));
  // Clearing a cooldown does not discard the learned fix for the next occurrence.
  assert.equal(new QuotaTracker(database).classify("x:one", message), "quota");
  assert.equal(new QuotaTracker(database).rules[0].diagnosis_id, "d1");
  database.close();
});

test("a review reads a log's tail and line ranges", async () => {
  mkdirSync(join(folder, ".tmp-verify"));
  writeFileSync(join(folder, ".tmp-verify", "tests.log"), "test passed\n".repeat(5000) + "Ran 155 tests in 92.794s\nOK\n");
  writeFileSync(join(folder, "db.py"), "first\nmigration\nlast\n");
  const ws = new Workspace(folder, { readOnly: true, readableFiles: [".tmp-verify/tests.log"] });
  const output = await ws.call("Read", { file_path: ".tmp-verify/tests.log", offset: -2 });
  assert.ok(output.includes("5001\tRan 155 tests in 92.794s\n  5002\tOK") && output.includes("5001-5002 of 5002"), output);
  assert.ok((await ws.call("Read", { file_path: "db.py", offset: 2, limit: 1 })).includes("migration"));
});

test("a review refuses changes and private or outside reads", async () => {
  const root = join(folder, "work");
  mkdirSync(root);
  writeFileSync(join(root, "db.py"), "original\n");
  const blocked = [".env", ".env.local", "credentials.json", "secrets.json", "server.pem", ".ssh/id_rsa", ".aws/credentials", ".git/config",
    ".tmp-verify/unreferenced.log", ".tmp-verify/.env", ".tmp-verify/secrets.json"];
  for (const name of blocked) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), "private-value\n");
  }
  writeFileSync(join(folder, "outside.txt"), "outside-value\n");
  symlinkSync(join(folder, "outside.txt"), join(root, "outside-link"));
  symlinkSync(join(root, ".env"), join(root, "secret-link"));
  const ws = new Workspace(root, { readOnly: true, host: true, network: true,
    readableFiles: [".env", ".tmp-verify/.env", ".tmp-verify/secrets.json", ".ssh/id_rsa", "../outside.txt"] });
  for (const name of [...blocked, "../outside.txt", join(folder, "outside.txt"), "outside-link", "secret-link"]) {
    assert.ok((await ws.call("Read", { file_path: name })).startsWith("Error:"), name);
  }
  const listing = await ws.call("LS", {});
  assert.ok(listing.includes("db.py") && !listing.includes(".env") && !listing.includes("credentials.json") && !listing.includes("secret-link"));
  assert.ok((await ws.call("LS", { path: ".." })).startsWith("Error:"));
  for (const [name, args] of [["Write", { file_path: "created.txt", content: "changed" }],
    ["Edit", { file_path: "db.py", old_string: "original", new_string: "changed" }]] as [string, Record<string, unknown>][]) {
    assert.ok((await ws.call(name, args)).includes("read-only"));
  }
  if (agent.sandboxAvailable()) {
    // Its commands cannot change the workspace or see its credentials either, nor reach the network.
    assert.ok((await ws.call("Bash", { command: "touch created.txt; echo x >> db.py" })).toLowerCase().includes("read-only"));
    // (An uncited log in a hidden folder is not private: only the file tools leave it out.)
    const hidden = blocked.filter((name) => name !== ".tmp-verify/unreferenced.log");
    const seen = await ws.call("Bash", { command: "cat db.py " + hidden.join(" ") + " secret-link; ls -a .ssh" });
    assert.ok(seen.includes("original") && !seen.includes("private-value"), seen);
    assert.equal(ws.network, false);
  }
  assert.equal(readFileSync(join(root, "db.py"), "utf8"), "original\n");
});

for (const name of ["build/tb/compile.log", "build/reports/coverage.txt", "rtl/build/sim.out"]) {
  test(`an explicit build log is reviewable without entering the source inventory: ${name}`, async () => {
    const log = join(folder, name);
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, "simulation detail\n".repeat(5000) + "SIMULATION_PASS\nRC=0\n");
    writeFileSync(join(dirname(log), "unreferenced.log"), "not cited\n");
    assert.ok(!quality.fileState(folder).has(name) && !quality.workspaceListing(folder).includes(name));
    const references = quality.mentionedFiles(folder, `Check \`${name}\` and \`${log}\`.`);
    assert.deepEqual(references, [name]);
    assert.ok(quality.changeEvidence(folder, references, { referenced: references }).includes("SIMULATION_PASS\nRC=0"));
    assert.ok(!quality.changeEvidence(folder, [name]).includes("SIMULATION_PASS"));
    const ws = new Workspace(folder, { readOnly: true, readableFiles: references });
    assert.ok((await ws.call("Read", { file_path: name, offset: -2 })).includes("SIMULATION_PASS"));
    assert.ok((await ws.call("Read", { file_path: join(dirname(log), "unreferenced.log") })).startsWith("Error:"));
    for (const [tool, args] of [["Write", { file_path: name, content: "changed" }], ["Edit", { file_path: name, old_string: "RC=0", new_string: "RC=1" }]] as
      [string, Record<string, unknown>][]) assert.ok((await ws.call(tool, args)).includes("read-only"));
    if (agent.sandboxAvailable()) {
      assert.ok((await ws.call("Bash", { command: `echo RC=1 > ${name}` })).toLowerCase().includes("read-only"));
      // A check is rerun on a copy in its own /tmp.
      const copied = await ws.call("Bash", { command: `mkdir -p /tmp/check && cp ${name} /tmp/check/ && echo RC=1 >> /tmp/check/*.${name.split(".").pop()} && tail -1 /tmp/check/*.${name.split(".").pop()}` });
      assert.equal(copied.trim(), "RC=1");
    }
    assert.ok(readFileSync(log, "utf8").endsWith("SIMULATION_PASS\nRC=0\n"));
  });
}

test("explicit build logs cannot bypass private paths or link targets", async () => {
  const root = join(folder, "project");
  mkdirSync(root);
  const blocked = ["build/.env.log", "build/credentials.txt", "build/secrets.log", "build/server.pem", "build/.aws/check.log", "build/.git/check.log",
    "build/.super-partner/check.log", "build/node_modules/check.log", "build/.venv/check.log", "build/.review/check.log", "build/program.py",
    "build/simulation", "build/summary.json", "dist/check.log"];
  for (const name of blocked) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), "private-value\n");
  }
  writeFileSync(join(folder, "outside.log"), "outside-value\n");
  symlinkSync(join(folder, "outside.log"), join(root, "build/outside.log"));
  symlinkSync(join(root, "build/credentials.txt"), join(root, "build/alias.log"));
  symlinkSync(join(root, "build/.aws"), join(root, "build/private"));
  blocked.push("build/outside.log", "build/alias.log", "build/private/check.log", "../outside.log");
  assert.deepEqual(quality.mentionedFiles(root, blocked.join(" ")), []);
  const evidence = quality.changeEvidence(root, blocked, { referenced: blocked });
  assert.ok(!evidence.includes("private-value") && !evidence.includes("outside-value"));
  const ws = new Workspace(root, { readOnly: true, readableFiles: blocked });
  for (const name of blocked) assert.ok((await ws.call("Read", { file_path: name })).startsWith("Error:"), name);
});

function services(): void {
  process.env.ZHIPU_API_KEY = "g";
  settings.web_search_models = ["glm:search_std"];
  settings.web_fetch = true;
}

test("a search asks the service with its key", async () => {
  services();
  const fetcher: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init!.body));
    assert.ok(new Headers(init?.headers).get("authorization") === "Bearer g" && String(input).endsWith("/web_search"));
    assert.deepEqual([body.search_engine, body.search_query, body.count], ["search_std", "北京天气", 3]);
    return new Response(JSON.stringify({ search_result: [{ title: "北京天气预报", link: "https://weather.example/bj", content: "晴，5°C", publish_date: "2026-11-19" }] }));
  };
  const [results, service] = await web.search("北京天气", 3, fetcher);
  assert.equal(service, "glm:search_std");
  assert.equal(web.formatResults(results), "1. 北京天气预报\nhttps://weather.example/bj\n2026-11-19\n晴，5°C");
});

test("the web tools are for steps allowed the internet, and searches are charged", async () => {
  services();
  assert.deepEqual(web.toolsFor(new Workspace(folder)), []);
  assert.deepEqual(web.toolsFor(new Workspace(folder, { network: true, readOnly: true })), []);
  const online = new Workspace(folder, { network: true });
  assert.deepEqual(web.toolsFor(online).map((tool) => tool.name), ["WebSearch", "WebFetch"]);
  web.deps.search = async () => [[{ title: "t", url: "https://a.example", date: null, excerpt: null, site: null }], "glm:search_std"];
  const budget = new Budget(1);
  online.budget = budget;
  let [output, ok] = await online.run("WebSearch", { query: "x" });
  assert.ok(ok && output.includes("https://a.example"));
  assert.deepEqual(budget.charged, [web.price("glm:search_std")]);
  online.budget = new Budget(0);
  [output, ok] = await online.run("WebSearch", { query: "x" });
  assert.ok(!ok && output.includes("budget"));
  // A step without the internet cannot use them, even by name.
  assert.ok(!(await new Workspace(folder).run("WebSearch", { query: "x" }))[1]);
});

test("a page is read as text", async () => {
  services();
  web.deps.isPublic = async () => true;
  const html = "<html><head><title>天气</title><script>var x=1</script></head><body><h1>北京</h1><p>晴，5°C</p><style>p{}</style></body></html>";
  const fetcher: typeof fetch = async (input) => (new URL(String(input)).pathname === "/old"
    ? new Response(null, { status: 301, headers: { location: "/new" } })
    : new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }));
  const text = await web.fetchPage("https://weather.example/old", fetcher);
  assert.ok(text.startsWith("https://weather.example/new") && text.includes("# 天气") && text.includes("北京") && text.includes("晴，5°C"), text);
  assert.ok(!text.includes("var x") && !text.includes("p{}"));
});

for (const url of ["http://127.0.0.1:8000/api/tasks", "http://localhost/", "http://10.0.0.5/", "http://[::1]/", "file:///etc/passwd", "http://user:pw@example.com/"]) {
  test(`addresses of this machine or its network are refused: ${url}`, async () => {
    services();
    await assert.rejects(web.fetchPage(url, async () => new Response("secret")), web.WebError);
  });
}

test("a redirect to this machine is refused", async () => {
  services();
  web.deps.isPublic = async (host) => host !== "127.0.0.1";
  await assert.rejects(web.fetchPage("https://public.example/", async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8000/api/tasks" } })),
    /not a public address/);
});

test("the log says what was searched or read", () => {
  assert.equal(agent.describeCall("WebSearch", { query: "北京天气" }), "北京天气");
  assert.equal(agent.describeCall("WebFetch", { url: "https://a.example/x" }), "https://a.example/x");
  assert.equal(agent.describeCall("StartTask", { request: "做网站" }), "做网站");
  assert.equal(agent.describeCall("Read", { file_path: "a.txt" }), "a.txt");
});
