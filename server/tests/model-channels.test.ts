// model-channels.ts and the model packages (server/packages/agy): a membership CLI brought in by a
// package, called only inside FluidForm's sandbox, switched off with its package.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { channel as agy, parse as agyParse, args as agyArgs, stdin as agyStdin, HOSTS } from "../packages/agy/src/index.js";
import { channel as gemini, parse as geminiParse } from "../packages/gemini-cli/src/index.js";
import { channel as qwen } from "../packages/qwen-code/src/index.js";
import { sandboxAvailable } from "../src/agent.js";
import { builtinModels, ownModels } from "../src/catalog.js";
import * as cli from "../src/cli-channels.js";
import { CliChannelRegistry, CliError, keepsConversations, specFor } from "../src/cli-channels.js";
import { settings } from "../src/config.js";
import * as modelChannels from "../src/model-channels.js";
import { type ChannelCall, type ModelChannel, register } from "../src/model-channels.js";
import * as provided from "../src/provided.js";
import { failureKind } from "../src/quota.js";

const saved = { ...settings };
const savedDeps = { ...modelChannels.deps };
const savedCli = { ...cli.deps };
const savedOn = provided.deps.extensionOn;
const savedHome = process.env.HOME;
let folder: string;

beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), "mc-")));
  Object.assign(settings, { data_dir: join(folder, "data"), workspace_root: join(folder, "workspaces") });
  mkdirSync(join(folder, "data"), { recursive: true });
});
afterEach(() => {
  Object.assign(settings, saved);
  Object.assign(modelChannels.deps, savedDeps);
  Object.assign(cli.deps, savedCli);
  provided.deps.extensionOn = savedOn;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

const call = (cwd: string, extra: Partial<ChannelCall> = {}): ChannelCall => ({ prompt: "hi", cwd, lead: false, sessionId: null, readable: [], ...extra });
const result = (fields: Record<string, unknown>) => JSON.stringify({ event: "result", result: { conversation_id: "c-1", status: "SUCCESS",
  response: "done", usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 3 }, ...fields } });

// ---- the agy package: how it is called and read -------------------------------------------------

test("agy gets its prompt on stdin, not as an argument, so a long prompt fits", () => {
  const prompt = "x".repeat(300_000);
  const given = agyArgs(call("/w", { prompt }));
  assert.ok(given.includes("--print="), "print mode with no text: the prompt is read from stdin");
  assert.ok(!given.some((arg) => arg.includes("xxxx")));
  assert.deepEqual(JSON.parse(agyStdin(call("/w", { prompt }))), { event: "user", message: { content: prompt } });
});

test("agy runs its commands without its own reviewer or prompts: FluidForm's sandbox is the boundary", () => {
  const given = agyArgs(call("/w"));
  const settingsJson = JSON.parse(given[given.indexOf("--settings") + 1]);
  // Auto mode's reviewer could send commands out of agy's sandbox anyway; Default mode with every
  // command allowed never waits for an approval nobody can give.
  assert.equal(settingsJson.agentMode, "");
  // Its file tools read anywhere (the sandbox decides what there is): a read waiting for an approval is
  // denied headless and agy answers nothing. Only a repair may write outside its folder.
  assert.deepEqual(settingsJson.permissions.allow, ["command(*)", "read_file(/)"]);
  const repairArgs = agyArgs(call("/w", { repair: true }));
  assert.deepEqual(JSON.parse(repairArgs[repairArgs.indexOf("--settings") + 1]).permissions.allow, ["command(*)", "read_file(/)", "write_file(/)"]);
  assert.ok(given.includes("accept-edits"), "a step edits without asking");
  const lead = agyArgs(call("/w", { lead: true, sessionId: "c-9", readable: ["/att"] }));
  assert.ok(!lead.includes("accept-edits"));
  assert.deepEqual(lead.slice(lead.indexOf("--conversation"), lead.indexOf("--conversation") + 2), ["--conversation", "c-9"]);
  assert.deepEqual(lead.slice(lead.indexOf("--add-dir"), lead.indexOf("--add-dir") + 2), ["--add-dir", "/att"]);
});

test("agy's answer is the stream's result: text, usage and conversation", () => {
  const out = [JSON.stringify({ event: "init", conversation_id: "c-1" }), "not json", result({})].join("\n");
  assert.deepEqual(agyParse(out), { text: "done", usage: { input_tokens: 10, output_tokens: 4, cached_input_tokens: 3 }, sessionId: "c-1",
    error: null, quota: false });
  const failed = agyParse(result({ status: "ERROR", response: "", error: "invalid model selection" }));
  assert.equal(failed.error, "invalid model selection");
  assert.equal(failed.quota, false);
  assert.equal(agyParse("").error, "agy printed no answer");
});

test("an empty answer from agy is no answer: what it said along the way, or why it said nothing", () => {
  const step = (index: number, text: string) => JSON.stringify({ event: "step_update", step_update: { step_index: index, step_type: "agent_response", text_delta: text } });
  const spoke = agyParse([step(2, "First "), step(2, "draft"), step(5, "Final "), step(5, "report"), result({ response: "" })].join("\n"));
  assert.equal(spoke.text, "Final report");
  assert.equal(spoke.error, null);
  const silent = agyParse(result({ response: "", denied_actions: [{ action: "read_file", display_name: "ReadFile" }] }));
  assert.equal(silent.error, "agy 没有给出回答（被拒绝的操作：ReadFile）");
});

test("agy's quota message is a quota, and FluidForm reads it as one", async () => {
  const reply = agyParse(result({ status: "ERROR", response: "", error: "You have exhausted your quota on this model." }));
  assert.equal(reply.quota, true);
  // channelRun turns it into words the quota tracker knows.
  const fake = fakeChannel(folder, `print(${JSON.stringify(result({ status: "ERROR", response: "", error: "You have exhausted your quota on this model." }))})`);
  noSandbox();
  const error = await new CliChannelRegistry().channelRun(fake, call(workspace()), false, 30).catch((caught) => caught);
  assert.ok(error instanceof CliError);
  assert.equal(failureKind(error.message), "quota");
});

test("a CLI step cut off keeps the conversation it had begun, for the next attempt to go on in", async () => {
  const fake = fakeChannel(folder, `print(json.dumps({"event": "start", "conversation_id": "c-9"}), flush=True)\nimport time\ntime.sleep(30)`);
  noSandbox();
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 1500);
  const error = await new CliChannelRegistry().channelRun(fake, call(workspace()), false, 60, { signal: stop.signal }).catch((caught) => caught);
  assert.equal(error.cli_session, "c-9");
});

test("a step goes on in its conversation, and starts afresh when the CLI no longer has it", async () => {
  provided.deps.extensionOn = () => true;
  noSandbox();
  // Like agy: --conversation <id> continues one; an unknown one is an error.
  fakeChannel(folder, `
args = sys.argv
given = args[args.index("--conversation") + 1] if "--conversation" in args else None
if given == "gone":
    sys.stderr.write("conversation gone not found\\n"); sys.exit(1)
print(${JSON.stringify(result({}))}.replace('"done"', json.dumps("went on in " + given if given else "fresh")))`);
  cli.deps.which = (name: string) => (name === "agy" ? join(folder, "bin", "fakecli") : null);
  const registry = new CliChannelRegistry();
  assert.equal((await registry.complete("cli:agy", "go on", workspace(), { session: "c-9", timeout: 30 })).text, "went on in c-9");
  assert.equal((await registry.complete("cli:agy", "go on", workspace(), { session: "gone", timeout: 30 })).text, "fresh");
  assert.equal((await registry.complete("cli:agy", "go on", workspace(), { timeout: 30 })).text, "fresh");
});

test("a model package's CLI that fails without an answer reports what it printed", async () => {
  const fake = fakeChannel(folder, "sys.stderr.write('login expired, run agy to sign in\\n'); sys.exit(3)");
  noSandbox();
  modelChannels.deps.ownNetwork = async (command) => command;
  // No bwrap needed for this: the call runs as a repair would, on the host.
  const error = await new CliChannelRegistry().channelRun(fake, call(workspace()), false, 30, {}, true).catch((caught) => caught);
  assert.ok(error instanceof CliError);
  assert.match(error.message, /printed no answer.*login expired/s);
});

test("the agy package's model is in the catalog, and its package says what it brings", () => {
  const model = builtinModels().find((item) => item.id === "cli:agy");
  assert.ok(!ownModels().some((item) => item.id === "cli:agy"), "it comes with its package, not FluidForm's own seed");
  assert.ok(model);
  assert.equal(model.channel, "cli");
  assert.equal(model.provider, "google");
  const manifest = JSON.parse(readFileSync(new URL("../packages/agy/capability.json", import.meta.url), "utf8"));
  assert.equal(manifest.kind, "extension");
  assert.deepEqual(manifest.provides, ["model:cli:agy"]);
  assert.equal(modelChannels.ownerOf("cli:agy")?.id, "agy");
  assert.ok(HOSTS.every((host) => host.endsWith(".googleapis.com")), "with no internet it reaches only Google's APIs");
});

// ---- the switch --------------------------------------------------------------------------------

test("a model package switched off takes its CLI away: no status, no spec, no lead", () => {
  provided.deps.extensionOn = () => true;
  assert.equal(modelChannels.channelFor("cli:agy"), agy);
  assert.equal(specFor("cli:agy")?.executable, "agy");
  assert.ok(keepsConversations("cli:agy"));
  const registry = new CliChannelRegistry();
  cli.deps.which = () => null;
  assert.ok("cli:agy" in registry.statuses);
  provided.deps.extensionOn = (extension) => extension.id !== "agy";
  assert.equal(modelChannels.channelFor("cli:agy"), null);
  assert.equal(specFor("cli:agy"), null);
  assert.ok(!keepsConversations("cli:agy"));
  assert.ok(!("cli:agy" in registry.statuses), "switching it off is seen without a restart");
  assert.ok(!registry.availableModelIds().has("cli:agy"));
});

// ---- the sandbox -------------------------------------------------------------------------------

function workspace(): string {
  const path = join(folder, "workspaces", "task", "step");
  mkdirSync(path, { recursive: true });
  return path;
}

/** A channel whose CLI is a Python script: it reads the prompt on stdin, runs ``body`` and prints its own result. */
function fakeChannel(where: string, body: string, extra: Partial<ModelChannel> = {}): ModelChannel {
  const bin = join(where, "bin");
  mkdirSync(bin, { recursive: true });
  const path = join(bin, "fakecli");
  writeFileSync(path, `#!/usr/bin/python3\nimport sys, os, json, socket\nprompt = sys.stdin.read()\n${body}\n`);
  chmodSync(path, 0o755);
  cli.deps.which = (name: string) => (name === "fakecli" ? path : null);
  return { id: "cli:fake", executable: "fakecli", auth_command: ["--version"], fallback_model_id: "google:gemini-pro", sessions: true,
    state: [".fake"], hosts: ["model.example.com"], args: () => [], stdin: (given) => given.prompt,
    parse: (stdout) => agyParse(stdout), ...extra };
}

function noSandbox(): void {
  modelChannels.deps.sandboxAvailable = () => true;
  modelChannels.deps.hostPorts = async () => [];
}

test("without bwrap a model package's CLI does not run at all", async () => {
  const fake = fakeChannel(folder, "print('never')");
  modelChannels.deps.sandboxAvailable = () => false;
  await assert.rejects(new CliChannelRegistry().channelRun(fake, call(workspace()), false, 30), /bubblewrap/);
});

test("a networked step gets the network a Codex step gets; the lead never does", async () => {
  const fake = fakeChannel(folder, "print('x')");
  modelChannels.deps.sandboxAvailable = () => true;
  modelChannels.deps.hostPorts = async () => [];
  const seen: string[][] = [];
  modelChannels.deps.ownNetwork = async (command) => {
    seen.push(command);
    return command;
  };
  let command: string[] = [];
  await modelChannels.withSandbox(fake, ["/bin/true"], call(workspace()), true, async (given) => (command = given));
  assert.equal(seen.length, 1);
  assert.ok(!command.includes("--unshare-net"));
  await modelChannels.withSandbox(fake, ["/bin/true"], call(workspace(), { lead: true }), true, async (given) => (command = given));
  assert.equal(seen.length, 1, "the lead is not given the internet");
  assert.ok(command.includes("--unshare-net"));
  const lead = modelChannels.fileSystem(fake, "/bin/true", call(workspace(), { lead: true }));
  assert.equal(lead[lead.indexOf(workspace()) - 1], "--ro-bind", "the lead only reads its folder");
});

const realSandbox = { skip: !sandboxAvailable() && "bwrap is not installed" };

test("a model package's CLI sees only its folder and its own state, whatever it runs", realSandbox, async () => {
  const home = join(folder, "home");
  mkdirSync(join(home, ".fake"), { recursive: true });
  writeFileSync(join(home, ".fake", "login"), "token-of-the-cli");
  writeFileSync(join(home, "secret"), "the user's key");
  writeFileSync(join(folder, "data", "fluidform.db"), "every task");
  mkdirSync(join(folder, "workspaces", "other-task"), { recursive: true });
  writeFileSync(join(folder, "workspaces", "other-task", "notes"), "another task's work");
  process.env.HOME = home;
  const fake = fakeChannel(folder, `
def can_read(path):
    try:
        open(path).read(); return True
    except OSError: return False
def can_write(path):
    try:
        open(path, "w").write("x"); return True
    except OSError: return False
found = {"login": can_read(os.path.expanduser("~/.fake/login")), "secret": can_read(os.path.expanduser("~/secret")),
  "data": can_read(${JSON.stringify(join(folder, "data", "fluidform.db"))}),
  "other": can_read(${JSON.stringify(join(folder, "workspaces", "other-task", "notes"))}),
  "write_here": can_write("made.txt"), "write_outside": can_write(${JSON.stringify(join(folder, "outside.txt"))}),
  "prompt": prompt}
print(json.dumps({"event": "result", "result": {"status": "SUCCESS", "response": json.dumps(found), "conversation_id": "c"}}))`);
  modelChannels.deps.hostPorts = async () => [];
  const reply = await new CliChannelRegistry().channelRun(fake, call(workspace(), { prompt: "do it" }), false, 60);
  const { write_outside: _private, ...found } = JSON.parse(reply.text);
  assert.deepEqual(found, { login: true, secret: false, data: false, other: false, write_here: true, prompt: "do it" });
  assert.ok(existsSync(join(workspace(), "made.txt")));
  // Under /tmp, which is its own there: what it wrote outside its folder never reaches the disk.
  assert.ok(!existsSync(join(folder, "outside.txt")));
});

test("with no internet a model package's CLI reaches its own hosts through FluidForm's proxy and the recorded host ports, nothing else",
  realSandbox, async () => {
    const listening: Server[] = [];
    const listen = () => new Promise<number>((done) => {
      const server = createServer((socket) => socket.end("hello\n"));
      listening.push(server);
      server.listen(0, "127.0.0.1", () => done((server.address() as { port: number }).port));
    });
    const recorded = await listen();
    const other = await listen();
    try {
      const fake = fakeChannel(folder, `
def reach(port):
    try:
        s = socket.create_connection(("127.0.0.1", port), timeout=3); data = s.recv(16); s.close(); return data.decode().strip()
    except OSError as error: return "blocked"
def through_proxy(host):
    try:
        s = socket.create_connection(("127.0.0.1", 8118), timeout=3)
        s.sendall(("CONNECT %s:443 HTTP/1.1\\r\\nHost: %s:443\\r\\n\\r\\n" % (host, host)).encode())
        answer = s.recv(64).decode().split("\\r\\n")[0]; s.close(); return answer
    except OSError: return "no proxy"
found = {"recorded": reach(${recorded}), "other": reach(${other}), "proxy_env": os.environ.get("HTTPS_PROXY"),
  "elsewhere": through_proxy("example.org")}
print(json.dumps({"event": "result", "result": {"status": "SUCCESS", "response": json.dumps(found), "conversation_id": "c"}}))`);
      modelChannels.deps.hostPorts = async () => [recorded];
      const reply = await new CliChannelRegistry().channelRun(fake, call(workspace()), false, 60);
      const found = JSON.parse(reply.text);
      assert.equal(found.recorded, "hello", "a recorded host port (a license server) is reached");
      assert.equal(found.other, "blocked", "no other local service, such as FluidForm's API");
      assert.equal(found.proxy_env, "http://127.0.0.1:8118");
      assert.match(found.elsewhere, /403/, "the proxy lets only its declared hosts through");
    } finally {
      for (const server of listening) server.close();
    }
  });

// ---- Gemini CLI and Qwen Code: moved into packages, called as before, now sandboxed ---------------

test("Gemini CLI and Qwen Code are model packages, called as they were before", () => {
  for (const [channel, executable] of [[gemini, "gemini"], [qwen, "qwen"]] as const) {
    assert.equal(channel.executable, executable);
    assert.deepEqual(channel.args(call("/w", { prompt: "do it" })), ["-p", "do it", "--output-format", "json"]);
    assert.equal(channel.stdin(call("/w")), null);
    assert.equal(channel.sessions, false, "neither leads a task");
    assert.equal(modelChannels.ownerOf(channel.id)?.provides[0], `model:${channel.id}`);
  }
  assert.ok(!ownModels().some((item) => item.channel === "cli"), "FluidForm has no CLI built in");
  assert.ok(builtinModels().some((item) => item.id === "cli:gemini") && builtinModels().some((item) => item.id === "cli:qwen"));
  assert.ok(!ownModels().some((item) => item.id === "cli:gemini" || item.id === "cli:qwen"));
});

test("Gemini CLI's answer is read as before: its JSON response, or its text", () => {
  assert.deepEqual(geminiParse(JSON.stringify({ response: "hello", stats: {} })), { text: "hello", usage: {}, sessionId: null, error: null, quota: false });
  assert.equal(geminiParse("plain words\n").text, "plain words");
  const usage = geminiParse(JSON.stringify({ result: "x", usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 3 } })).usage;
  assert.deepEqual(usage, { input_tokens: 8, output_tokens: 2, cached_input_tokens: 3 });
});

/** A Node CLI installed as npm does: node_modules/<package>/ under the home, a link to it in bin/. */
function npmCli(home: string): string {
  const root = join(home, ".npm-global", "lib", "node_modules", "fake-cli");
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fake-cli" }));
  writeFileSync(join(root, "lib", "answer.js"), "module.exports = 'from its own module';\n");
  writeFileSync(join(root, "cli.js"), `#!/usr/bin/env node
const answer = require("./lib/answer.js");
process.stdin.resume();
process.stdin.on("data", () => undefined).on("end", () => console.log(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: answer } })));
`);
  chmodSync(join(root, "cli.js"), 0o755);
  mkdirSync(join(home, ".npm-global", "bin"), { recursive: true });
  const link = join(home, ".npm-global", "bin", "fakecli");
  symlinkSync(join(root, "cli.js"), link);
  return link;
}

test("a CLI installed with npm is kept whole in the sandbox: its package, not only its script", () => {
  const home = join(folder, "home");
  process.env.HOME = home;
  const link = npmCli(home);
  assert.deepEqual(modelChannels.programFiles(link), [join(home, ".npm-global", "lib", "node_modules", "fake-cli")]);
  assert.deepEqual(modelChannels.programFiles("/bin/true"), [realpathSync("/bin/true")]);
});

test("a CLI installed with npm in the hidden home runs in the sandbox", realSandbox, async () => {
  const home = join(folder, "home");
  process.env.HOME = home;
  const link = npmCli(home);
  const fake = fakeChannel(folder, "");
  cli.deps.which = (name: string) => (name === "fakecli" ? link : null);
  modelChannels.deps.hostPorts = async () => [];
  const reply = await new CliChannelRegistry().channelRun(fake, call(workspace()), false, 60);
  assert.equal(reply.text, "from its own module");
});

test("a network without the internet: the recorded host ports and the declared hosts through the proxy, nothing else", realSandbox, async () => {
  const listening: Server[] = [];
  const listen = () => new Promise<number>((done) => {
    const server = createServer((socket) => socket.end("hello\n"));
    listening.push(server);
    server.listen(0, "127.0.0.1", () => done((server.address() as { port: number }).port));
  });
  const recorded = await listen();
  const other = await listen();
  modelChannels.deps.hostPorts = async () => [recorded];
  const script = join(folder, "probe.py");
  writeFileSync(script, `import socket, os, json
def reach(port):
    try:
        s = socket.create_connection(("127.0.0.1", port), timeout=3); data = s.recv(16); s.close(); return data.decode().strip()
    except OSError: return "blocked"
def through(host):
    s = socket.create_connection(("127.0.0.1", 8118), timeout=3)
    s.sendall(("CONNECT %s:443 HTTP/1.1\\r\\nHost: %s:443\\r\\n\\r\\n" % (host, host)).encode())
    answer = s.recv(64).decode().split("\\r\\n")[0]; s.close(); return answer
print(json.dumps({"recorded": reach(${recorded}), "other": reach(${other}), "elsewhere": through("example.org")}))
`);
  try {
    const found = await modelChannels.withoutInternet(["/usr/bin/python3", script], ["model.example.com"], (command, env) =>
      new CliChannelRegistry().run({ id: "x", executable: "python3", auth_command: [], invoke_args: [], fallback_model_id: "" }, command, folder, null, 30,
        { extraEnv: env }));
    const result = JSON.parse(found);
    assert.equal(result.recorded, "hello", "the license server is reached");
    assert.equal(result.other, "blocked", "no other local service");
    assert.match(result.elsewhere, /403/, "the proxy lets only the declared hosts through");
  } finally {
    for (const server of listening) server.close();
  }
});
