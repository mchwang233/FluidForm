// cli-channels.ts: its tests in test_activity, test_agent, test_attachments, test_core, test_executor,
// test_preflight, test_progress and test_supervisor, ported.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import * as activity from "../src/activity.js";
import { proxyListenScript, Workspace } from "../src/agent.js";
import * as calls from "../src/calls.js";
import { builtinModels } from "../src/catalog.js";
import * as cli from "../src/cli-channels.js";
import { CLI_SPECS, CliChannelRegistry, CliError, InputTooLarge, SessionLost } from "../src/cli-channels.js";
import { settings } from "../src/config.js";
import { shlexQuote } from "../src/py.js";

const saved = { ...settings };
const savedDeps = { ...cli.deps };
const savedPath = process.env.PATH;
const savedHome = process.env.CODEX_HOME;
let folder: string;

beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), "cli-")));
  Object.assign(settings, { data_dir: join(folder, "data"), workspace_root: join(folder, "workspaces") });
  process.env.CODEX_HOME = join(folder, "codex-home");
});
afterEach(() => {
  Object.assign(settings, saved);
  Object.assign(cli.deps, savedDeps);
  process.env.PATH = savedPath;
  if (savedHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedHome;
});
after(() => undefined);

const python = "python3";
const spec = (executable = "python") => ({ ...CLI_SPECS["cli:codex"], id: "python", executable });
const lines = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const message = (text: string) => JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

function fakeCli(name: string, script: string): void {
  const bin = join(folder, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), script);
  chmodSync(join(bin, name), 0o755);
  process.env.PATH = `${bin}:${savedPath}`;
}

function alive(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(")").pop()!.trim().split(" ")[0] !== "Z";
  } catch {
    return false;
  }
}

test("a CLI step records what it prints as it goes", async () => {
  const script = `import json,sys,time\nprint(json.dumps({'type':'item.completed','item':{'id':'a','type':'agent_message','text':'hi'}}), flush=True)\ntime.sleep(0.3)\n`;
  const log: activity.LogEntry[] = [];
  const seen: activity.LogEntry[] = [];
  await activity.recording(log, async () => {
    const looking = wait(200).then(() => seen.push(...log));
    await new CliChannelRegistry().run(spec(), [python, "-c", script], folder, null, 30);
    await looking;
  });
  assert.deepEqual(seen.map((entry) => entry.detail), ["hi"]);
});

test("a CLI trace keeps its raw output, stderr and exit status on failure", async () => {
  const trace = join(folder, "trace", "attempt.jsonl");
  const output = JSON.stringify({ type: "item.started", item: { id: "c", type: "command_execution", command: "check" } }) + "\n";
  const script = `import sys; sys.stdout.write(${JSON.stringify(output)}); sys.stdout.flush(); sys.stderr.write('problem'); sys.exit(3)`;
  await assert.rejects(new CliChannelRegistry().run(spec(), [python, "-c", script], folder, null, 30, { toolTrace: trace }), /failed/);
  const records = lines(trace);
  const joined = (kind: string) => Buffer.concat(records.filter((r) => r.type === kind).map((r) => Buffer.from(r.data, "base64"))).toString();
  assert.equal(joined("cli.stdout"), output);
  assert.equal(joined("cli.stderr"), "problem");
  assert.deepEqual([records.at(-1).type, records.at(-1).exit_code], ["cli.exit", 3]);
});

test("a cancelled CLI keeps its partial trace and exit status", async () => {
  const trace = join(folder, "cancelled.jsonl");
  const stop = new AbortController();
  const running = new CliChannelRegistry().run(spec(), [python, "-c", "import time; print('partial evidence', flush=True); time.sleep(60)"],
    folder, null, 30, { toolTrace: trace, signal: stop.signal });
  for (let i = 0; i < 300 && !(existsSync(trace) && readFileSync(trace, "utf8").includes("cli.stdout")); i += 1) await wait(10);
  stop.abort();
  await assert.rejects(running, { name: "AbortError" });
  const records = lines(trace);
  assert.ok(records.some((r) => r.type === "cli.stdout") && records.some((r) => r.type === "cli.interrupted"));
  assert.equal(records.at(-1).type, "cli.exit");
  assert.notEqual(records.at(-1).exit_code, 0);
});

test("CLI sandboxes open to the internet only for a task allowing it", () => {
  const opened = cli.withNetwork("cli:claude", [...CLI_SPECS["cli:claude"].invoke_args]);
  const given = JSON.parse(opened[opened.indexOf("--settings") + 1]);
  assert.deepEqual(given.sandbox.network.allowedDomains, ["*"]);
  assert.ok(given.sandbox.network.deniedDomains.includes("127.0.0.1"));
  assert.equal(given.sandbox.allowUnsandboxedCommands, false);
  assert.ok(cli.codexStepPermissions(process.cwd(), true).join(" ").includes("network={ enabled = true }"));
  assert.ok(!cli.codexStepPermissions(process.cwd(), false).some((arg) => arg.endsWith("network={ enabled = true }")));
});

test("repairs have the real /dev, so they can start a step's sandbox", () => {
  const host = new Workspace(folder, { host: true }).hostArgs("true");
  assert.deepEqual(host.slice(host.indexOf("--dev-bind") + 1, host.indexOf("--dev-bind") + 3), ["/dev", "/dev"]);
  assert.ok(!host.includes("--dev"));
  const command = cli.repairCommand("codex", ["exec"]);
  assert.deepEqual(command.slice(command.indexOf("--dev-bind") + 1, command.indexOf("--dev-bind") + 3), ["/dev", "/dev"]);
  assert.ok(!command.includes("--dev"));
});

test("a CLI failure reports the reason from its JSON output", () => {
  const usage = Buffer.from(JSON.stringify({ type: "result", is_error: true, result: "Claude AI usage limit reached" }));
  assert.equal(cli.failureDetail(usage, Buffer.alloc(0)), "Claude AI usage limit reached");
  assert.equal(cli.failureDetail(Buffer.from("plain words"), Buffer.alloc(0)), "plain words");
  assert.equal(cli.failureDetail(Buffer.from("ignored"), Buffer.from("bad flag\n")), "bad flag");
  assert.equal(cli.failureDetail(Buffer.alloc(0), Buffer.alloc(0)), "no output");
});

test("a Codex failure reports its failed turn, not a warning on stderr", () => {
  const limit = "You've hit your usage limit. Try again at Nov 28th, 2026 2:27 PM.";
  const events = [{ type: "thread.started", thread_id: "t" }, { type: "turn.started" }, { type: "error", message: limit },
    { type: "turn.failed", error: { message: limit } }].map((event) => JSON.stringify(event)).join("\n");
  const warning = Buffer.from("warning: Untrusted project-local configuration is disabled.\n");
  assert.equal(cli.failureDetail(Buffer.from(events), warning), limit);
  // No failed turn: stderr as before.
  assert.equal(cli.failureDetail(Buffer.from(JSON.stringify({ type: "turn.started" })), warning), warning.toString().trim());
});

test("Claude Code runs commands only inside its sandbox", () => {
  const args = CLI_SPECS["cli:claude"].invoke_args;
  assert.ok(!args.includes("--dangerously-skip-permissions") && !args.includes("bypassPermissions"));
  assert.equal(args[args.indexOf("--settings") + 1], cli.CLAUDE_SANDBOX_SETTINGS);
  assert.deepEqual(JSON.parse(cli.CLAUDE_SANDBOX_SETTINGS).sandbox, { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false });
});

test("CLI fallbacks name catalog models", () => {
  const ids = new Set(builtinModels().map((model) => model.id));
  for (const item of Object.values(CLI_SPECS)) assert.ok(ids.has(item.fallback_model_id), item.fallback_model_id);
});

test("a cancelled CLI call kills the processes it spawned", async () => {
  const pidFile = join(folder, "child.pid");
  fakeCli("codex", `#!/bin/sh\nsleep 30 &\necho $! > ${pidFile}\nwait\n`);
  const stop = new AbortController();
  const running = new CliChannelRegistry().complete("cli:codex", "hi", folder, { signal: stop.signal });
  while (!existsSync(pidFile) || !readFileSync(pidFile, "utf8").trim()) await wait(10);
  const pid = Number(readFileSync(pidFile, "utf8"));
  stop.abort();
  await assert.rejects(running, { name: "AbortError" });
  for (let i = 0; i < 200 && alive(pid); i += 1) await wait(10);
  assert.ok(!alive(pid));
});

test("a Codex step may write in /tmp but not read what is already there", () => {
  const shared = join(folder, "shared");
  for (const name of ["other-session/notes", "keys.json"]) {
    mkdirSync(join(shared, name, ".."), { recursive: true });
    writeFileSync(join(shared, name), "private");
  }
  let rules = new Map<string, string>();
  cli.sharedTmp(join(folder, "elsewhere", "task"), rules, shared);
  assert.deepEqual(Object.fromEntries(rules), { [shared]: "write", [join(shared, "keys.json")]: "deny", [join(shared, "other-session")]: "deny" });
  rules = new Map();
  cli.sharedTmp(join(folder, "elsewhere", "task"), rules, shared, 1);
  assert.deepEqual(Object.fromEntries(rules), { ":slash_tmp": "deny" });
});

test("a /tmp whose entries' names would not fit in one argument is denied as a whole", () => {
  // Regression: about 1,500 test folders in /tmp made the profile's -c argument too long (spawn E2BIG).
  const shared = join(folder, "crowded");
  mkdirSync(shared);
  const long = "x".repeat(200);
  for (let i = 0; i < 400; i += 1) mkdirSync(join(shared, `${long}-${i}`));
  const rules = new Map<string, string>();
  cli.sharedTmp(join(folder, "elsewhere", "task"), rules, shared);
  assert.deepEqual(Object.fromEntries(rules), { ":slash_tmp": "deny" });
  const options = cli.codexStepPermissions(join(folder, "task"), false);
  assert.ok(options.every((arg) => Buffer.byteLength(arg) < 128 * 1024));
});

test("a Codex step's own temporary folder is under the hidden data folder", async () => {
  let made = "";
  await cli.withPrivateTmp(true, async (tmp) => {
    made = tmp!;
    assert.ok(tmp!.startsWith(join(settings.data_dir, "tmp") + "/"));
  });
  assert.ok(made && !existsSync(made));
});

// Progress checks every 0.2 s instead of every 10 minutes.
const often = () => {
  settings.progress_check_minutes = 0.2 / 60;
};

test("a CLI past its timeout is checked, not killed", async () => {
  often();
  fakeCli("codex", "#!/bin/sh\necho work > made.txt\nsleep 1\necho finished\n");
  const checks: string[] = [];
  const text = await new CliChannelRegistry().complete("cli:codex", "hi", folder, { timeout: 0.1, watch: async (evidence) => {
    checks.push(evidence);
    return null;
  } });
  assert.equal(text.text, "finished");
  assert.ok(checks.length && checks[0].includes("made.txt") && checks[0].includes("sleep"), checks.join("\n---\n"));
});

test("a CLI's child in a session of its own is still seen running", async () => {
  often();
  const child = join(folder, "child.pid");
  const code = `import os,time; os.setsid(); open(${JSON.stringify(child)},'w').write(str(os.getpid())); time.sleep(30)`;
  fakeCli("codex", `#!/bin/sh\n${python} -c ${shlexQuote(code)} &\ni=0\n`
    + `while [ ! -s ${shlexQuote(child)} ] && [ $i -lt 200 ]; do i=$((i+1)); sleep 0.01; done\nsleep 1\necho finished\n`);
  const checks: string[] = [];
  try {
    const text = await new CliChannelRegistry().complete("cli:codex", "hi", folder, { timeout: 0.1, watch: async (evidence) => {
      checks.push(evidence);
      return null;
    } });
    assert.equal(text.text, "finished");
    assert.ok(checks.some((evidence) => evidence.includes("time.sleep(30)")), checks.join("\n---\n"));
  } finally {
    const pid = existsSync(child) ? readFileSync(child, "utf8").trim() : "";
    if (/^\d+$/.test(pid)) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        // gone
      }
    }
  }
});

test("a growing log and the output it prints are shown to the checker", async () => {
  often();
  fakeCli("codex", "#!/bin/sh\ni=0\n"
    + "while [ $i -lt 30 ]; do i=$((i+1)); echo \"regression $i\" >> run.log; "
    + "printf '{\"type\":\"item.completed\",\"item\":{\"id\":\"m%s\",\"type\":\"agent_message\",\"text\":\"regression %s\"}}\\n' \"$i\" \"$i\"; sleep 0.05; done\n"
    + "sleep 1\nprintf '{\"type\":\"item.completed\",\"item\":{\"id\":\"done\",\"type\":\"agent_message\",\"text\":\"finished\"}}\\n'\n");
  const checks: string[] = [];
  const text = await activity.recording([], () => new CliChannelRegistry().complete("cli:codex", "hi", folder, { timeout: 0.1, watch: async (evidence) => {
    checks.push(evidence);
    return null;
  } }));
  assert.equal(text.text, "finished");
  assert.ok(checks.some((evidence) => evidence.includes("run.log") && evidence.includes("larger")), checks.join("\n---\n"));
  assert.ok(checks.some((evidence) => evidence.includes("printed")), checks.join("\n---\n"));
});

const codexSpec = CLI_SPECS["cli:codex"];
const completeIn = (registry: CliChannelRegistry, prompt: string) =>
  registry.completeIn(codexSpec, "codex", ["exec"], false, null, prompt, folder, 10, [], false, false, null, null, null);

test("Codex's final input boundary reserves room for the envelope", async () => {
  for (const character of ["x", "界"]) {
    const registry = new CliChannelRegistry();
    const sent: Buffer[] = [];
    registry.run = async (_spec, _command, _cwd, stdin) => {
      sent.push(stdin!);
      return message("ok");
    };
    cli.deps.codexSettings = () => [];
    const limit = cli.CODEX_INPUT_LIMIT - cli.CODEX_INPUT_RESERVE;
    const prompt = character.repeat(Math.floor(limit / Buffer.byteLength(character)));
    await completeIn(registry, prompt);
    assert.deepEqual(sent, [Buffer.from(prompt)]);
    await assert.rejects(completeIn(registry, prompt + character), InputTooLarge);
    assert.equal(sent.length, 1);
  }
});

function deliveryPrompt(files: string[]): string {
  return "用户约束：覆盖率100%\n"
    + "Current project deliveries, including your earlier work (inspect referenced files for details):\n"
    + JSON.stringify([{ id: "bridge", files, status: "blocked", result: "1,889 项候选尚未批准；APB16、AXI16/512/1024、地址12及33–64待裁定" }])
    + "\nAcceptance criteria: 负责人最终验收\n追加文件正文：保持接口";
}

test("Codex compacts its final input and retries a rejection only once", async () => {
  const original = deliveryPrompt(Array.from({ length: 18000 }, (_, i) => `coverage/run.vdb/${i}-` + "x".repeat(100)));
  for (const reject of [null, "once", "always"]) {
    const registry = new CliChannelRegistry();
    const sent: string[] = [];
    registry.run = async (_spec, _command, _cwd, stdin) => {
      sent.push(stdin!.toString());
      if (reject === "always" || (reject && sent.length === 1)) throw new CliError('codex failed: {"code":"input_too_large"}');
      return message("ok");
    };
    cli.deps.codexSettings = () => [];
    const record = { warnings: [] as string[] } as any;
    await calls.current.run([null, record], async () => {
      if (reject === "always") await assert.rejects(completeIn(registry, original), InputTooLarge);
      else assert.equal((await completeIn(registry, original)).text, "ok");
    });
    assert.equal(sent.length, reject ? 2 : 1);
    assert.ok(sent[0].length < original.length);
    if (reject) assert.ok(sent[1].length < sent[0].length);
    for (const prompt of sent) {
      assert.ok(Buffer.byteLength(prompt) <= cli.CODEX_INPUT_LIMIT - cli.CODEX_INPUT_RESERVE);
      for (const kept of ["1,889 项候选尚未批准", "APB16、AXI16/512/1024、地址12及33–64待裁定", "用户约束：覆盖率100%", "负责人最终验收", "追加文件正文：保持接口"]) {
        assert.ok(prompt.includes(kept), kept);
      }
    }
    assert.ok(record.warnings.some((warning: string) => warning.includes(String(original.length)) && warning.includes(String(sent[0].length))));
  }
});

test("only a Codex step allowed the internet runs in a network of its own", async () => {
  const registry = new CliChannelRegistry();
  const commands: string[][] = [];
  cli.deps.which = (name) => join(folder, name);
  cli.deps.codexSettings = () => [];
  cli.deps.codexStepPermissions = () => [];
  cli.deps.ownNetwork = async (command) => ["own-network", ...command];
  registry.run = async (_spec, command) => {
    commands.push(command);
    return command.includes("cli:claude") ? '{"result":"ok"}' : message("ok");
  };
  await registry.complete("cli:codex", "联网的一步", folder, { network: true });
  await registry.complete("cli:codex", "不联网的一步", folder);
  await registry.complete("cli:claude", "联网的一步", folder, { network: true }); // its own sandbox keeps localhost out
  const [networked, offline, claude] = commands;
  assert.equal(networked[0], "own-network");
  assert.equal(networked[1], join(folder, "codex"));
  assert.notEqual(offline[0], "own-network");
  assert.notEqual(claude[0], "own-network");
});

test("a networked check in Codex's sandbox runs in the network a step gets", async () => {
  const log = join(folder, "argv.log");
  fakeCli("own-network", `#!/bin/sh\necho "$@" > ${log}\necho checked\n`);
  cli.deps.which = (name) => join(folder, name);
  cli.deps.codexStepPermissions = () => [];
  cli.deps.ownNetwork = async (command) => [join(folder, "bin", "own-network"), ...command];
  const [output, ok] = await new CliChannelRegistry().sandboxRun("cli:codex", "true", folder, 10, true);
  assert.ok(ok && output.includes("checked"), output);
  assert.ok(readFileSync(log, "utf8").startsWith(`${join(folder, "codex")} sandbox`));
});

test("Claude Code's sandbox opens only the recorded host ports, never every local service", () => {
  const settingsOf = (args: string[]) => JSON.parse(args[args.indexOf("--settings") + 1]).sandbox;
  const base = CLI_SPECS["cli:claude"].invoke_args;
  assert.deepEqual(cli.withHostPorts(base, []), base);
  const offline = settingsOf(cli.withHostPorts(base, [26585, 36013]));
  assert.deepEqual(offline.network, { allowedDomains: ["127.0.0.1:26585", "127.0.0.1:36013"], allowLocalBinding: true });
  assert.equal(offline.allowUnsandboxedCommands, false);
  const online = settingsOf(cli.withHostPorts(cli.withNetwork("cli:claude", base), [26585]));
  assert.deepEqual(online.network.allowedDomains, ["*", "127.0.0.1:26585"]);
  // 127.0.0.1 on the deny list would win over its listed port; localhost and ::1 stay closed.
  assert.deepEqual(online.network.deniedDomains, ["localhost", "::1"]);
});

test("a Claude Code step gets the bridge to the host ports while it runs", async () => {
  const registry = new CliChannelRegistry();
  const seen: [string[], string][] = [];
  cli.deps.which = (name) => join(folder, name);
  cli.deps.hostPorts = async () => [26585];
  registry.run = async (_spec, command, _cwd, _stdin, _timeout, options) => {
    const file = options?.extraEnv?.CLAUDE_ENV_FILE ?? "";
    seen.push([command, file && readFileSync(file, "utf8")]);
    return '{"result":"ok"}';
  };
  await registry.complete("cli:claude", "跑 VCS", folder);
  await registry.complete("cli:claude", "修环境", folder, { repair: true });
  const [[step, script], [repair, none]] = seen;
  assert.ok(step[step.indexOf("--settings") + 1].includes("127.0.0.1:26585"));
  assert.ok(script.includes("TCP-LISTEN:26585") && script.includes("PROXY:"), script);
  assert.ok(!repair.join(" ").includes("127.0.0.1:26585") && none === "");
  assert.ok(!readdirSync(tmpdir()).some((name) => name.startsWith("sp-claude-") && existsSync(join(tmpdir(), name, "env.sh"))));
});

test("the bridge goes out through the sandbox's proxy, with its credentials", () => {
  const log = join(folder, "socat.log");
  fakeCli("socat", `#!/bin/sh\necho "$@" >> ${log}\n`);
  const before = join(folder, "mine.sh");
  writeFileSync(before, "echo user-env-loaded\n");
  const script = proxyListenScript([26585], before);
  // --norc: bash reads ~/.bashrc when its stdin is a socket, as Node's pipes are.
  const done = spawnSync("bash", ["--norc", "-c", script.replace(/for _ in .*done/, "true") + "echo ok"], { encoding: "utf8",
    env: { PATH: process.env.PATH!, http_proxy: "http://srt.abc:secret@127.0.0.1:3128" } });
  assert.equal(done.stdout, "user-env-loaded\nok\n");
  for (let i = 0; i < 100 && !existsSync(log); i += 1) spawnSync("sleep", ["0.02"]);
  assert.equal(readFileSync(log, "utf8").trim(), "TCP-LISTEN:26585,bind=127.0.0.1,fork,reuseaddr PROXY:127.0.0.1:127.0.0.1:26585,proxyport=3128,proxyauth=srt.abc:secret");
  // No proxy (not in Claude Code's sandbox): nothing listens.
  const plain = spawnSync("bash", ["--norc", "-c", script + "echo ok"], { encoding: "utf8", env: { PATH: process.env.PATH! } });
  assert.equal(plain.stdout, "user-env-loaded\nok\n");
});

test("a Codex lead rebuilds a rejected input without changing its conversation", async () => {
  const registry = new CliChannelRegistry();
  const sent: [string[], Buffer][] = [];
  cli.deps.which = (name) => join(folder, name);
  cli.deps.codexSettings = () => [];
  cli.deps.codexStepPermissions = () => [];
  registry.run = async (_spec, command, _cwd, stdin) => {
    sent.push([command, stdin!]);
    return sent.length === 1 ? '{"type":"turn.failed","error":{"code":"input_too_large"}}' : message("ok");
  };
  const [text, sid] = await registry.converse("cli:codex", deliveryPrompt(Array.from({ length: 500 }, (_, i) => `reports/${i}.txt`)), folder, { sessionId: "saved" });
  assert.deepEqual([text.text, sid], ["ok", "saved"]);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0][0], sent[1][0]);
  assert.ok(sent[1][1].length < sent[0][1].length);
});

test("a Codex rejection with nothing removable is not retried", async () => {
  const registry = new CliChannelRegistry();
  const sent: Buffer[] = [];
  registry.run = async (_spec, _command, _cwd, stdin) => {
    sent.push(stdin!);
    throw new CliError("input_too_large");
  };
  await assert.rejects(registry.runInput(codexSpec, ["codex"], folder, "必须保留：1,889 项候选尚未批准", 10), InputTooLarge);
  assert.equal(sent.length, 1);
});

test("a resumed Codex conversation gets its options in its own scope", async () => {
  // Exec's -c flags before `resume` are not inherited by the resume parser.
  cli.deps.which = (name) => join(folder, name);
  cli.deps.codexServers = () => ["test_mcp"];
  Object.assign(settings, { codex_without_extras: true, codex_lead_service_tier: "fast" });
  const registry = new CliChannelRegistry();
  const commands: string[][] = [];
  registry.run = async (_spec, command) => {
    commands.push(command);
    return '{"type":"thread.started","thread_id":"saved"}\n' + message("ok");
  };
  const [text, sid] = await registry.converse("cli:codex", "plan", folder, { sessionId: "saved", effort: "high" });
  assert.deepEqual([text.text, sid], ["ok", "saved"]);
  const resumed = commands[0].slice(commands[0].indexOf("resume") + 1);
  for (const option of ['model_reasoning_effort="high"', 'service_tier="fast"', "mcp_servers.test_mcp.enabled=false",
    `default_permissions="${cli.CODEX_LEAD_PROFILE}"`, `permissions.${cli.CODEX_LEAD_PROFILE}.extends=":read-only"`]) {
    assert.ok(resumed.includes(option), option);
  }
  for (const feature of cli.CODEX_EXTRAS) assert.equal(resumed[resumed.indexOf(feature) - 1], "--disable");
});

test("Claude Code and Codex continue their own conversations", async () => {
  const log = join(folder, "args.log");
  fakeCli("claude", `#!/bin/sh\necho "$@" >> ${log}\ncat > /dev/null\necho '{"result": "好的", "session_id": "c-1"}'\n`);
  fakeCli("codex", `#!/bin/sh\necho "$@" >> ${log}\ncat > /dev/null\necho '{"type":"thread.started","thread_id":"x-9"}'\necho '${message("收到")}'\n`);
  const registry = new CliChannelRegistry();
  const [text, sid] = await registry.converse("cli:claude", "规划", folder);
  assert.deepEqual([text.text, sid], ["好的", "c-1"]);
  await registry.converse("cli:claude", "接下来？", folder, { sessionId: "c-1" });
  const [reply, thread] = await registry.converse("cli:codex", "规划", folder);
  assert.deepEqual([reply.text, thread], ["收到", "x-9"]);
  await registry.converse("cli:codex", "接下来？", folder, { sessionId: "x-9" });
  const [first, second, third, fourth] = readFileSync(log, "utf8").split("\n");
  assert.ok(first.includes("--session-id") && second.includes("--resume c-1") && first.includes("Edit,Write,NotebookEdit"));
  assert.ok(third.includes('extends=":read-only"') && !third.includes("--sandbox"));
  assert.ok(fourth.startsWith("exec ") && fourth.includes("resume x-9") && fourth.includes('extends=":read-only"'));
  // The lead thinks hardest, in both a new and a continued conversation.
  assert.ok(third.includes('model_reasoning_effort="max"') && fourth.includes('model_reasoning_effort="max"'));
});

test("Codex runs with the platform's effort and without the user's extras", async () => {
  const home = process.env.CODEX_HOME!;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.toml"), 'model = "x"\n[mcp_servers.node_repl]\ncommand = "n"\n'
    + '[mcp_servers."my server"]\ncommand = "m"\n[mcp_servers.node_repl.env]\nA = "1"\n');
  const log = join(folder, "args.log");
  fakeCli("codex", `#!/bin/sh\necho "$@" >> ${log}\ncat > /dev/null\necho '{"type":"thread.started","thread_id":"x-9"}'\necho '${message("收到")}'\n`);
  settings.codex_lead_service_tier = "fast";
  const registry = new CliChannelRegistry();
  await registry.converse("cli:codex", "规划", folder);
  await registry.complete("cli:codex", "做这一步", folder, { effort: "low" });
  await registry.complete("cli:codex", "照旧", folder);
  const [lead, step, plain] = readFileSync(log, "utf8").split("\n");
  assert.ok(lead.includes('model_reasoning_effort="max"') && lead.includes('service_tier="fast"'));
  assert.ok(step.includes('model_reasoning_effort="low"') && !step.includes("service_tier"));
  assert.ok(!plain.includes("model_reasoning_effort")); // nothing asked: the user's own setting
  for (const line of [lead, step, plain]) {
    assert.ok(line.includes("--disable plugins") && line.includes("--disable apps"));
    // A -c key is split on dots with quotes taken literally: only plain names are turned off.
    assert.ok(line.includes("mcp_servers.node_repl.enabled=false") && !line.includes("my server") && !line.includes('"node_repl"'));
  }
  assert.deepEqual(cli.codexServers(), ["node_repl", "my server"]);
  settings.codex_without_extras = false;
  assert.deepEqual(cli.codexSettings("high"), ["-c", 'model_reasoning_effort="high"']);
});

test("a conversation the CLI no longer has is reported as lost", async () => {
  fakeCli("claude", "#!/bin/sh\necho 'No conversation found with session ID: c-1' >&2\nexit 1\n");
  await assert.rejects(new CliChannelRegistry().converse("cli:claude", "接下来？", folder, { sessionId: "c-1" }), SessionLost);
});

test("Codex may delete files in its folder, and the rule is gone after", async () => {
  // A folder of the project's own stays; a repair, outside Codex's sandbox, gets none.
  const seen = join(folder, "seen.txt");
  fakeCli("codex", `#!/bin/sh\ncat > /dev/null\ncat ${cli.CODEX_RULES} >> ${seen} 2>/dev/null || echo none >> ${seen}\necho done\n`);
  const scratch = join(folder, "scratch");
  const project = join(folder, "project");
  mkdirSync(scratch);
  mkdirSync(join(project, ".codex"), { recursive: true });
  writeFileSync(join(project, ".codex", "config.toml"), "# the project's own");
  const registry = new CliChannelRegistry();
  await registry.complete("cli:codex", "做这一步", scratch);
  await registry.complete("cli:codex", "做这一步", project);
  assert.equal(readFileSync(seen, "utf8"), cli.CODEX_ALLOW.repeat(2));
  assert.ok(!existsSync(join(scratch, ".codex")));
  assert.ok(!existsSync(join(project, cli.CODEX_RULES)) && existsSync(join(project, ".codex", "config.toml")));
  cli.deps.repairCommand = (executable, args) => [executable, ...args];
  await registry.complete("cli:codex", "修环境", scratch, { repair: true });
  assert.ok(readFileSync(seen, "utf8").endsWith("none\n"));
});

test("a lead call runs while Codex keeps printing and stops when it goes quiet", async () => {
  // A long refinement is not cut off at a fixed time; one that prints nothing for long is.
  const registry = new CliChannelRegistry();
  const busy = "import time\nfor i in range(8):\n    print(i, flush=True); time.sleep(0.1)\nprint('done')";
  const output = await registry.run(spec("codex"), [python, "-c", busy], folder, Buffer.alloc(0), 30, { idle: 0.5 });
  assert.ok(output.trim().endsWith("done")); // 0.8 s in all, never 0.5 s quiet
  const quiet = "import time\nprint('thinking', flush=True)\ntime.sleep(5)";
  await assert.rejects(registry.run(spec("codex"), [python, "-c", quiet], folder, Buffer.alloc(0), 30, { idle: 0.3 }), /no output for 0.3s/);
});
