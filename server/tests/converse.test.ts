// providers.ts's conversations and CLI calls: their tests in test_activity, test_chat, test_quick and
// test_supervisor, ported.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import * as files from "../src/attachments.js";
import { ProviderError } from "../src/budget.js";
import * as cli from "../src/cli-channels.js";
import { CliError, InputTooLarge } from "../src/cli-channels.js";
import { settings } from "../src/config.js";
import { SupervisorSessionSchema } from "../src/models.js";
import { ProviderRegistry, ProviderResult } from "../src/providers.js";
import * as quickly from "../packages/planning/src/quick.js";
import { isolated, registryWith } from "./helpers/providers.js";

const { folder } = isolated();
const savedDeps = { ...cli.deps };
afterEach(() => {
  Object.assign(cli.deps, savedDeps);
});
const session = (fields: Record<string, unknown>) => SupervisorSessionSchema.parse(fields);

test("a provider's CLI call keeps the final answer and the whole raw stream", async () => {
  const trace = join(folder(), "trace.jsonl");
  const registry = new ProviderRegistry();
  cli.deps.which = () => "python3";
  // The real CLI completion and process runner, with a portable fake executable.
  const run = registry.cli.run.bind(registry.cli);
  registry.cli.run = (spec, _command, cwd, _stdin, timeout, options) => run(spec, ["python3", "-c",
    "import json; print(json.dumps({'result': '回答', 'usage': {'input_tokens': 1, 'output_tokens': 2}}))"], cwd, null, timeout, options);
  const result = await registry.complete("cli:claude", "work", { workspace: folder(), tool_trace: trace, allow_api_fallback: false });
  const records = readFileSync(trace, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(result.text, "回答");
  const raw = Buffer.concat(records.filter((r) => r.type === "cli.stdout").map((r) => Buffer.from(r.data, "base64"))).toString();
  assert.equal(JSON.parse(raw).result, result.text);
  assert.ok(records.some((r) => r.type === "cli.exit" && r.exit_code === 0 && Object.keys(r).length === 2));
  assert.deepEqual(records.at(-1), { type: "cli.result", text: result.text, model_id: "cli:claude" });
});

const PNG = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(64)]);

test("a conversation message carries attachments to either kind of model", async () => {
  const shot = files.save("error.png", PNG);
  const log = files.save("trace.log", Buffer.from("KeyError 'id'\n"));
  const registry = new ProviderRegistry();
  const calls: [string, string[]][] = [];
  registry.complete = async (_modelId, prompt, options = {}) => {
    calls.push([prompt, (options.attachments ?? []).map((item) => item.name)]);
    return new ProviderResult("看到了。", 10, 10);
  };
  const api = session({ model_id: "x:api" });
  await registry.converse(api, "这是什么错？", { attachments: [shot, log] });
  await registry.converse(api, "怎么修？");
  // An API model: text inline and kept in the conversation; the image sent as an image, once.
  const [[first, images], [second, later]] = calls;
  assert.ok(first.includes("KeyError 'id'") && second.includes("KeyError 'id'"));
  assert.deepEqual([images, later], [["error.png"], []]);
  assert.ok((api.history[0] as any).content.includes("KeyError 'id'"));
  // A CLI: told where the files are, allowed to read just those folders, the image given as an image.
  const commands: [string[], string][] = [];
  registry.cli.runInput = async (_spec, command, _cwd, prompt) => {
    commands.push([command, prompt]);
    throw new CliError("stop here");
  };
  cli.deps.which = (name) => `/usr/bin/${name}`;
  for (const modelId of ["cli:codex", "cli:claude"]) {
    await assert.rejects(registry.converse(session({ model_id: modelId, cwd: join(folder(), modelId) }), "这是什么错？", { attachments: [shot, log] }), ProviderError);
  }
  const [[codex, codexPrompt], [claude]] = commands;
  const folders = new Set([shot, log].map((item) => dirname(files.path(item))));
  assert.ok(codex.includes(`--image=${files.path(shot)}`) && codexPrompt.includes(files.path(log)));
  const table = codex.find((arg) => arg.includes("filesystem="))!;
  for (const where of folders) assert.ok(table.includes(`"${where}" = "read"`), where);
  assert.deepEqual(new Set(claude.slice(claude.indexOf("--add-dir") + 1).slice(0, 2)), folders);
});

test("a quick job past its time stops and says so", async () => {
  const registry = new ProviderRegistry();
  const called: any[] = [];
  registry.complete = async (_modelId, _prompt, options = {}) => {
    called.push(options);
    await new Promise((done) => setTimeout(done, 5000).unref());
    return new ProviderResult("late", 0, 0);
  };
  const chat = session({ model_id: "x:best", cwd: folder() });
  const result = await registry.converse(chat, "查一下天气", { tools: { folder: folder(), network: true, turns: 20, seconds: 0.05 } });
  assert.ok(result.text.includes("秒内没做完") && result.text.includes("排成任务"));
  assert.ok(called[0].act === true && called[0].max_turns === 20 && called[0].network === true);
  assert.equal(called[0].workspace, folder());
  assert.equal((chat.history.at(-1) as any).content, result.text);
});

const QUICK = '{"quick": true, "title": "海边女孩头像", "capability": "tool_use", "needs_images": true, "acceptance": "一张方形的海边女孩头像图片"}';
const SOLO = '{"shape": "solo", "title": "修登录报错", "capability": "coding", "needs_images": false, "acceptance": "登录不再报错，测试通过"}';
const cheap = { id: "x:cheap", input_per_million: 0, output_per_million: 0, cached_input_per_million: 0 } as any;
const answering = (text: string) => ({ complete: async () => new ProviderResult(text, 1, 1) });

test("a quick answer is read defensively", async () => {
  const [step] = await quickly.quick("x", answering('好的：{"quick": true, "capability": "rm -rf"}'), cheap);
  assert.ok(step && step.capability === "tool_use" && step.title === "x" && step.needs_images === false);
  assert.equal((await quickly.quick("x", answering("{"), cheap))[0], null);
  assert.equal((await quickly.quick("x", answering(QUICK), null))[0], null);
});

test("shapes are read defensively", async () => {
  assert.equal((await quickly.quick("x", answering(SOLO), cheap, true))[0]!.shape, "solo");
  assert.equal((await quickly.quick("x", answering('{"shape": "plan"}'), cheap, true))[0], null);
  // A project's task is never "quick" (it touches their files), and without solo never judged.
  assert.equal((await quickly.quick("x", answering('{"shape": "quick"}'), cheap, true, true))[0], null);
  assert.equal((await quickly.quick("x", answering(SOLO), cheap, false, true))[0], null);
  // Without solo, the old question and answer.
  assert.equal((await quickly.quick("x", answering(SOLO), cheap))[0], null);
});

test("an API refinement's effort is sent, and the lead's default stays", async () => {
  process.env.DEEPSEEK_API_KEY = "test";
  const sent: any[] = [];
  const registry = registryWith(() => ({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), sent);
  await registry.converse(session({ model_id: "deepseek:deepseek-flash", reasoning_effort: "low" }), "split");
  await registry.converse(session({ model_id: "deepseek:deepseek-flash" }), "lead");
  assert.equal(sent[0].reasoning_effort, "low");
  assert.equal(sent[1].reasoning_effort, settings.lead_reasoning_effort);
});

for (const modelId of ["cli:codex", "cli:claude"]) {
  test(`a CLI refinement's effort survives a new and a resumed session (${modelId})`, async () => {
    const log = join(folder(), "args.log");
    const name = modelId.split(":")[1];
    const answer = name === "claude" ? '{"result": "ok", "session_id": "s-1"}'
      : '{"type":"thread.started","thread_id":"s-1"}\n{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}';
    const bin = join(folder(), "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, name), `#!/bin/sh\necho "$@" >> ${log}\ncat > /dev/null\ncat <<'ANSWER'\n${answer}\nANSWER\n`);
    chmodSync(join(bin, name), 0o755);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    const registry = new ProviderRegistry();
    const chat = session({ model_id: modelId, cwd: folder(), reasoning_effort: "low" });
    await registry.converse(chat, "split");
    await registry.converse(chat, "correct dependency");
    for (const args of readFileSync(log, "utf8").split("\n").filter(Boolean)) {
      assert.ok(args.includes(name === "codex" ? 'model_reasoning_effort="low"' : "--effort low"), args);
      assert.ok(!args.includes('model_reasoning_effort="max"'));
    }
    assert.equal(chat.session_id, "s-1");
  });
}

for (const raw of [false, true]) {
  test(`a CLI's input too large never falls back to the API (${raw ? "a plain failure" : "InputTooLarge"})`, async () => {
    const registry = new ProviderRegistry();
    const invoked: string[] = [];
    registry.cli.complete = async (modelId) => {
      invoked.push(modelId);
      throw new (raw ? CliError : InputTooLarge)("input_too_large: required instructions exceed input budget");
    };
    registry.quota.classify = () => assert.fail("Input size is not quota or model unavailability");
    await assert.rejects(registry.complete("cli:codex", "must retain", { workspace: folder(), allow_api_fallback: true }), InputTooLarge);
    assert.deepEqual(invoked, ["cli:codex"]);
  });
}
