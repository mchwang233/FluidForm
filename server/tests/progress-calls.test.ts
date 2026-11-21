// Progress checks and limits on model calls: their tests in test_progress,
// test_packages, test_recovery_regressions and test_review_evidence, ported.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as agent from "../src/agent.js";
import { BudgetExceeded, ProviderError, RequestBudget, StepLimitExceeded } from "../src/budget.js";
import { settings } from "../src/config.js";
import { ModelProfileSchema } from "../src/models.js";
import * as progress from "../src/progress.js";
import { AsyncEvent } from "../src/py.js";
import { ModelUnavailable } from "../src/quota.js";
import { isolated, registryWith } from "./helpers/providers.js";

const { folder } = isolated();
const READ = { id: "c", type: "function", function: { name: "list_dir", arguments: JSON.stringify({ path: "." }) } };
const reply = (message: Record<string, unknown>) => ({ choices: [{ message, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const hang = () => new Promise<never>(() => undefined);
// Progress checks every 0.2 s instead of every 10 minutes.
const often = () => {
  settings.progress_check_minutes = 0.2 / 60;
};
function alive(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(")").pop()!.trim().split(" ")[0] !== "Z";
  } catch {
    return false;
  }
}

test("a package far past its turns goes to the lead", async () => {
  process.env.DEEPSEEK_API_KEY = "test";
  const registry = registryWith(() => reply({ content: null, tool_calls: [READ] }));
  const asked: string[] = [];
  const lead = async (evidence: string) => {
    asked.push(evidence);
    return asked.length === 1 ? null : "一直在读同一个目录，这个包太大，应拆开";
  };
  await assert.rejects(registry.complete("deepseek:deepseek-flash", "work", { workspace: folder(), act: true, overrun: [5, lead] }),
    (error: Error) => error instanceof ProviderError && error.message.includes(progress.OVERRUN));
  assert.deepEqual(asked.map((evidence) => evidence.split(" ", 1)[0]), ["10", "20"]);
});

test("an API model works past the old limit while the checks say continue", async () => {
  often();
  process.env.DEEPSEEK_API_KEY = "test";
  const turns = 60;
  const checks: string[] = [];
  const registry = registryWith((request) => reply(request.body.messages.length > 2 * turns ? { content: "done" } : { content: null, tool_calls: [READ] }));
  const slow = registry.post.bind(registry);
  registry.post = async (...args: Parameters<typeof slow>) => {
    await wait(10);
    return slow(...args);
  };
  const result = await registry.complete("deepseek:deepseek-flash", "work", { workspace: folder(), act: true, watch: async (evidence) => {
    checks.push(evidence);
    return null;
  } });
  assert.ok(result.text === "done" && result.turns > 40 && !result.turn_limit);
  assert.ok(checks.length && checks.at(-1)!.includes("list_dir"));
});

test("an API model the check finds stuck is stopped", async () => {
  often();
  process.env.DEEPSEEK_API_KEY = "test";
  const registry = registryWith(async () => {
    await wait(50);
    return reply({ content: null, tool_calls: [READ] });
  });
  await assert.rejects(registry.complete("deepseek:deepseek-flash", "work", { workspace: folder(), act: true, watch: async () => "一直在列同一个目录" }),
    (error: Error) => error instanceof ProviderError && error.message.includes("一直在列同一个目录") && error.message.includes(progress.STOPPED));
});

test("a stuck CLI is stopped with its processes and does not fall back", async () => {
  often();
  const child = join(folder(), "child.pid");
  const bin = join(folder(), "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nsleep 30 &\necho $! > ${child}\nwait\n`);
  chmodSync(join(bin, "codex"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const registry = registryWith([]);
  await assert.rejects(registry.complete("cli:codex", "hi", { workspace: folder(), watch: async () => "开发服务器一直在前台运行，没有任何进展" }),
    (error: Error) => error instanceof ProviderError && error.message.includes("开发服务器一直在前台运行"));
  const pid = Number(readFileSync(child, "utf8"));
  for (let i = 0; i < 200 && alive(pid); i += 1) await wait(10);
  assert.ok(!alive(pid));
});

test("a request the model never answers is checked while it waits", async () => {
  often();
  process.env.DEEPSEEK_API_KEY = "test";
  const registry = registryWith(hang);
  await assert.rejects(registry.complete("deepseek:deepseek-flash", "work", { workspace: folder(), act: true,
    watch: async (evidence) => (evidence.includes("nothing back yet") ? "一直等不到模型回复" : null) }), /一直等不到模型回复/);
});

test("a reply past its deadline fails at once and its model steps aside", async () => {
  process.env.DEEPSEEK_API_KEY = "test";
  settings.api_reply_deadline = 0.2;
  const sent: unknown[] = [];
  const registry = registryWith(hang, sent);
  await assert.rejects(registry.complete("deepseek:deepseek-flash", "work", { workspace: folder(), act: true }),
    (error: Error) => error instanceof ModelUnavailable && error.message.includes("分钟没有回复"));
  assert.equal(sent.length, 1);
});

test("an artifact's hard turn limit makes no extra summary request and keeps the trace", async () => {
  process.env.DEEPSEEK_API_KEY = "test";
  const calls: unknown[] = [];
  const turns: number[] = [];
  const tools: number[] = [];
  const modelId = "deepseek:deepseek-flash";
  const model = ModelProfileSchema.parse({ id: modelId, provider: "deepseek", display_name: "test", input_per_million: 1, output_per_million: 1 });
  const budget = Object.assign(new RequestBudget({ models: { [modelId]: model }, remaining: () => 1, reservations: new Map(), charge: async () => undefined,
    changed: new AsyncEvent(), turnRemaining: () => 2 - turns.length, useTurn: async () => {
      turns.push(1);
    } }), {
    beginTool: async () => {
      if (tools.length >= 2) throw new StepLimitExceeded("达到声明工具调用上限");
      tools.push(1);
    },
    toolRemaining: () => 2 - tools.length,
  });
  const registry = registryWith(() => reply({ content: "Still working", tool_calls: [READ] }), calls);
  Object.assign(registry.models, { [modelId]: model });
  const log: unknown[] = [];
  const trace = join(folder(), "trace.jsonl");
  const result = await registry.complete(modelId, "work", { workspace: folder(), act: true, spend_ok: budget, tool_log: log as any, tool_trace: trace });
  assert.ok(calls.length === 2 && turns.length === 2 && result.turns === 2);
  assert.ok(result.turn_limit && log.length === 2 && readFileSync(trace, "utf8").split("\n").filter(Boolean).length === 2);
  assert.ok(result.input_tokens === 2 && result.output_tokens === 2);
  assert.equal(tools.length, 2);
});

test("the final reply is checked against the budget", async () => {
  const registry = registryWith(() => ({ choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 1000, completion_tokens: 50 } }));
  registry.configuredModels = (ids) => new Set([...ids].filter((id) => !registry.quota.exhausted(id)));
  registry.maxAttempts = 1;
  process.env.DEEPSEEK_API_KEY = "test";
  const checked: number[] = [];
  await assert.rejects(registry.complete("deepseek:primary", "work", { workspace: folder(), spend_ok: { allows: (_id, incoming = 0, outgoing = 0) => {
    checked.push(incoming + outgoing);
    return incoming + outgoing < 1000;
  } } }), (error: any) => {
    assert.ok(error instanceof BudgetExceeded);
    assert.equal(error.usage.input_tokens, 1000);
    return true;
  });
  assert.deepEqual(checked, [0, 1050]);
});

for (const provider of ["openai", "anthropic", "google"]) {
  test(`an API review exposes only read tools and returns the log's tail (${provider})`, async () => {
    for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"]) process.env[name] = "test";
    const review = join(folder(), "review");
    const project = join(folder(), "project");
    mkdirSync(review);
    mkdirSync(join(project, ".tmp-verify"), { recursive: true });
    writeFileSync(join(project, ".tmp-verify", "tests.log"), "details\n".repeat(5000) + "Ran 155 tests\nOK\n");
    const calls: [string, Record<string, unknown>][] = [["Read", { file_path: ".tmp-verify/tests.log", offset: -2 }], ["Write", { file_path: "bad.txt", content: "bad" }]];
    const verdict = '{"passed":true,"reason":"verified"}';
    const sent: any[] = [];
    const registry = registryWith((request) => {
      sent.push(request.body);
      const first = sent.length === 1;
      if (provider === "openai") {
        return { choices: [{ message: first ? { tool_calls: calls.map(([name, args], i) => ({ id: String(i), type: "function", function: { name, arguments: JSON.stringify(args) } })) }
          : { content: verdict } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
      }
      if (provider === "anthropic") {
        return { content: first ? calls.map(([name, input], i) => ({ type: "tool_use", id: String(i), name, input })) : [{ type: "text", text: verdict }],
          usage: { input_tokens: 10, output_tokens: 5 } };
      }
      return { candidates: [{ content: { role: "model", parts: first ? calls.map(([name, args]) => ({ functionCall: { name, args } })) : [{ text: verdict }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } };
    });
    const result = await registry.complete(`${provider}:reviewer`, "Review the work", { workspace: review, review_workspace: project,
      review_files: [".tmp-verify/tests.log"], max_turns: 3 });
    assert.ok(result.text === verdict && result.input_tokens === 20 && result.output_tokens === 10);
    const offered = provider === "openai" ? sent[0].tools.map((tool: any) => tool.function.name)
      : provider === "anthropic" ? sent[0].tools.map((tool: any) => tool.name) : sent[0].tools[0].functionDeclarations.map((tool: any) => tool.name);
    assert.deepEqual(new Set(offered), new Set(["Read", "Glob", "Grep", "LS", ...(agent.sandboxAvailable() ? ["Bash"] : [])]));
    const second = JSON.stringify(sent[1]);
    assert.ok(second.includes("\\tRan 155 tests\\n  5002\\tOK"), second.slice(0, 2000));
    assert.ok(second.includes("Error:") && second.includes("read-only"));
    assert.ok(!existsSync(join(project, "bad.txt")) && !existsSync(join(review, "bad.txt")));
  });
}
