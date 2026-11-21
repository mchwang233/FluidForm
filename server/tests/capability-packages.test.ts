// Automation packages, their sandbox and their runner: the tests of tests/test_capability_packages.py
// that need no API routes, ported.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import * as files from "../src/attachments.js";
import * as capabilities from "../src/capabilities.js";
import * as packages from "../src/capability-packages.js";
import * as runner from "../src/capability-runner.js";
import * as sandbox from "../src/capability-sandbox.js";
import { settings } from "../src/config.js";
import { CapabilitySchema } from "../src/models.js";
import { shlexQuote } from "../src/py.js";
import { conftest } from "./helpers/conftest.js";
import { type Entry, zipOf } from "./helpers/zip-writer.js";

const { folder } = conftest();
const saved = { ...sandbox.deps };
const savedTake = runner.deps.takeFiles;
const savedPorts = new Set(sandbox.ALLOWED_PORTS);
const savedWait = runner.limits.PICTURE_WAIT_SECONDS;
afterEach(() => {
  Object.assign(sandbox.deps, saved);
  runner.deps.takeFiles = savedTake;
  sandbox.ALLOWED_PORTS.clear();
  for (const port of savedPorts) sandbox.ALLOWED_PORTS.add(port);
  runner.limits.PICTURE_WAIT_SECONDS = savedWait;
});
const needsSandbox = { skip: Boolean(sandbox.missing()) && "needs bwrap and socat" };
const PNG = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(32)]);
const realHome = () => {
  try {
    return realpathSync(homedir());
  } catch {
    return homedir();
  }
};

/** A package zip; ``extra`` adds more entries. */
function pkg({ manifest = {}, extra = [], top = "pkg/" }: { manifest?: Record<string, unknown>; extra?: Entry[]; top?: string } = {}): Buffer {
  const body = { id: "fake-bot", name: "假机器人", kind: "automation", version: "1.0", summary: "测试用", entry: "python3 fake.py", secrets: ["TOKEN"],
    domains: ["*.example.com"], ...manifest };
  return zipOf([{ name: top + "capability.json", data: JSON.stringify(body) }, { name: top + "fake.py", data: "print('hi')\n" },
    { name: top + "asks.json", data: "[]" }, ...extra]);
}

/** A capability's folder and data folder, under the test's data folder. */
function places(): [string, string] {
  settings.data_dir = join(folder(), "data");
  const where = join(folder(), "data", "tools", "capabilities", "x");
  const data = join(folder(), "data", "capability-data", "x");
  mkdirSync(where, { recursive: true });
  mkdirSync(data, { recursive: true });
  return [where, data];
}

async function echoServer(): Promise<[Server, number]> {
  const server = createServer((socket) => socket.once("data", (data) => socket.end(data)));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  return [server, (server.address() as { port: number }).port];
}

/** CONNECT through the proxy's socket: the reply's head, and the connection. */
function through(proxyFolder: string, target: string): Promise<[string, Socket]> {
  return new Promise((done, fail) => {
    const socket = connect(`${proxyFolder}/${sandbox.PROXY_PORT}.sock`, () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let head = "";
    const onData = (data: Buffer) => {
      head += data.toString("latin1");
      if (head.includes("\r\n\r\n")) {
        socket.off("data", onData);
        done([head, socket]);
      }
    };
    socket.on("data", onData);
    socket.once("error", fail);
  });
}

test("a package that could reach outside its folder, or is unclear, is refused", () => {
  for (const [data, reason] of [[Buffer.from("not a zip"), "不是 zip"], [pkg({ extra: [{ name: "pkg/../evil.py", data: "x" }] }), "不安全的路径"],
    [pkg({ extra: [{ name: "elsewhere/x.py", data: "x" }] }), "不在能力的文件夹里"], [pkg({ extra: [{ name: "pkg/.venv/bin/python", data: "x" }] }), ".venv"],
    [pkg({ manifest: { id: "Bad Id" } }), "id 只能"], [pkg({ manifest: { entry: "" } }), "entry"], [pkg({ manifest: { secrets: ["PATH"] } }), "密钥名不能用"],
    [pkg({ manifest: { domains: ["http://x.com/a"] } }), "domains"]] as const) {
    assert.throws(() => packages.read(data), (error: Error) => error instanceof packages.PackageError && error.message.includes(reason), reason);
  }
  // And a good one is read.
  const capability = packages.read(pkg());
  assert.deepEqual([capability.id, capability.files, capability.status], ["fake-bot", ["asks.json", "capability.json", "fake.py"], "disabled"]);
});

test("a compressed package installs, switched off, with its manual", async () => {
  // Packages zipped by hand are deflated; the Python tests' are stored.
  settings.data_dir = join(folder(), "data");
  const data = zipOf([{ name: "capability.json", data: JSON.stringify({ id: "zipped", name: "压缩包", kind: "tool", summary: "s", usage: "python3 run.py" }), deflate: true },
    { name: "run.py", data: "print('x')\n".repeat(200), deflate: true }]);
  const capability = await packages.install(data);
  assert.deepEqual([capability.id, capability.status, capability.check_ok], ["zipped", "disabled", null]);
  assert.equal(readFileSync(join(capabilities.root(), "zipped", "run.py"), "utf8"), "print('x')\n".repeat(200));
  assert.ok(readFileSync(join(capabilities.root(), "zipped", capabilities.MANUAL), "utf8").includes("python3 run.py"));
});

test("a package with a link is refused", () => {
  assert.throws(() => packages.read(pkg({ extra: [{ name: "pkg/link", data: "x", mode: 0o120777 }] })), (error: Error) => error.message.includes("链接"));
});

test("what the group said is kept bounded", () => {
  const kept = runner.keepHeard(Array.from({ length: 50 }, (_, n) => `成员：${n}`.repeat(100)));
  assert.ok(kept.length <= runner.MAX_HEARD_LINES && kept.reduce((sum, line) => sum + [...line].length, 0) <= runner.MAX_HEARD_CHARS);
  assert.ok(kept.at(-1)!.startsWith("成员：49"));
});

test("the sandbox hides the home and the data, keeps its folder read-only and has no network", () => {
  const [where, data] = places();
  const env = sandbox.environmentFor(where, data, { TOKEN: "v" }, true);
  const args = sandbox.wrap(where, data, "python3 bot.py", env, "/tmp/sp-cap-x");
  const joined = args.join(" ");
  // The home folder is hidden; Super Partner's data is too (here it is under /tmp, its own tmpfs).
  assert.ok(joined.includes(`--tmpfs ${realHome()}`) && joined.includes("--tmpfs /tmp "));
  assert.ok(joined.includes(`--ro-bind ${where} ${where}`) && joined.includes(`--bind ${data} ${data}`));
  assert.ok(args.includes("--unshare-net") && args.includes("--clearenv") && joined.includes("--setenv TOKEN v"));
  assert.ok(joined.includes(`socat TCP-LISTEN:${sandbox.PROXY_PORT}`));
  assert.ok(sandbox.wrap(where, data, "x", env, null, true).join(" ").includes(`--bind ${where} ${where}`));
  assert.ok(env.HTTPS_PROXY.endsWith(`:${sandbox.PROXY_PORT}`) && !sandbox.wrap(where, data, "x", env, null).join(" ").includes("socat"));
});

test("only the hosts declared are allowed", () => {
  for (const [host, ok] of [["open.feishu.cn", true], ["feishu.cn", true], ["evilfeishu.cn", false], ["api.example.org", true], ["x.api.example.org", false]] as const) {
    assert.equal(sandbox.allowed(host, ["*.feishu.cn", "api.example.org"]), ok, host);
  }
});

test("the proxy lets through only the hosts declared", async () => {
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  const [server, port] = await echoServer();
  sandbox.ALLOWED_PORTS.clear();
  sandbox.ALLOWED_PORTS.add(port);
  const logged: string[] = [];
  const proxy = await new sandbox.DomainProxy(["localhost"], (line) => logged.push(line)).open();
  try {
    const [head, socket] = await through(proxy.folder!, `localhost:${port}`);
    assert.ok(head.includes(" 200 "));
    const echoed = new Promise<string>((done) => socket.once("data", (data) => done(data.toString())));
    socket.write("ping");
    assert.equal(await echoed, "ping");
    socket.destroy();
    const [refused, other] = await through(proxy.folder!, `example.com:${port}`);
    other.destroy();
    assert.ok(refused.includes(" 403 ") && logged.at(-1)!.includes("example.com"));
  } finally {
    await proxy.close();
    server.close();
  }
});

test("in the real sandbox it writes only its data and reaches only the proxy", needsSandbox, async () => {
  const [where, data] = places();
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  const [server, port] = await echoServer();
  sandbox.ALLOWED_PORTS.clear();
  sandbox.ALLOWED_PORTS.add(port);
  const probe = "import json, os, socket\nout = {}\n"
    + "for name, path in (('folder', 'x.txt'), ('data', os.environ['SP_DATA_DIR'] + '/x.txt')):\n"
    + "    try:\n        open(path, 'w').write('x'); out[name] = True\n    except OSError:\n        out[name] = False\n"
    + `try:\n    socket.create_connection(('127.0.0.1', ${port}), 2); out['direct'] = True\nexcept OSError:\n    out['direct'] = False\n`
    + `s = socket.create_connection(('127.0.0.1', ${sandbox.PROXY_PORT}), 5)\n`
    + `s.sendall(b'CONNECT localhost:${port} HTTP/1.1\\r\\n\\r\\n'); head = s.recv(200)\n`
    + "s.sendall(b'hi'); out['proxied'] = head.startswith(b'HTTP/1.1 200') and s.recv(10) == b'hi'\nprint(json.dumps(out))\n";
  writeFileSync(join(where, "probe.py"), probe);
  try {
    const [output, ok] = await sandbox.run(where, data, `${shlexQuote(sandbox.python()!)} probe.py`, 30, { domains: ["localhost"] });
    assert.ok(ok, output);
    assert.deepEqual(JSON.parse(output.split("\n").at(-1)!), { folder: false, data: true, direct: false, proxied: true });
  } finally {
    server.close();
  }
});

test("in the real sandbox its secrets are in its environment, not on any command line", needsSandbox, async () => {
  // Regression: secrets were bwrap --setenv arguments, readable by every user in /proc/<pid>/cmdline.
  const [where, data] = places();
  const secret = "s3cret-" + randomBytes(6).toString("hex");
  await sandbox.launched(where, data, 'echo "inside=$TOKEN"; sleep 30', async (child) => {
    const line = await new Promise<string>((done) => child.stdout!.once("data", (chunk: Buffer) => done(chunk.toString())));
    assert.equal(line.trim(), `inside=${secret}`);
    const children = readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, "utf8").split(/\s+/).filter(Boolean).map(Number);
    const lines: Buffer[] = [];
    for (const pid of [child.pid!, ...children]) {
      try {
        lines.push(readFileSync(`/proc/${pid}/cmdline`));
      } catch {
        // gone
      }
    }
    assert.ok(lines.length && !lines.some((item) => item.includes(secret)));
  }, { secrets: { TOKEN: secret } });
});

test("a command reaching no host runs without a proxy", async () => {
  // Run directly (tests never need bwrap), with the environment the sandbox gives.
  sandbox.deps.missing = () => "";
  sandbox.deps.wrap = (where, _data, command, env) => ["env", "-i", ...Object.entries({ ...env, PATH: process.env.PATH! }).map(([name, value]) => `${name}=${value}`),
    "/bin/bash", "-c", `cd ${shlexQuote(where)} && ${command}`];
  const where = join(folder(), "x");
  mkdirSync(where);
  const [output, ok] = await sandbox.run(where, join(folder(), "data"), 'echo "proxy=$HTTPS_PROXY"', 10);
  assert.ok(ok && output === "proxy=", output);
});

test("its environment is built in the sandbox, reaching only the package index", async () => {
  settings.data_dir = join(folder(), "data");
  sandbox.deps.missing = () => "";
  mkdirSync(join(capabilities.root(), "x"), { recursive: true });
  writeFileSync(join(capabilities.root(), "x", "requirements.txt"), "lark-oapi\n");
  const ran: [string, Record<string, any>][] = [];
  sandbox.deps.run = async (_where, _data, command, _timeout, options = {}) => {
    ran.push([command, options]);
    return ["", true];
  };
  assert.deepEqual(await packages.build(CapabilitySchema.parse({ id: "x", name: "x" })), ["", true]);
  const [[command, options], ...more] = ran;
  assert.equal(more.length, 0);
  assert.ok(command.includes("-m venv .venv") && command.includes("pip install") && options.writable === true);
  assert.ok(options.domains.includes("pypi.org") && options.domains.includes("files.pythonhosted.org"));
});

test("a question about a picture waits for the picture sent just after", async () => {
  // Regression: "这个图片的背景在哪里" came a moment before its picture: "我这边还没看到图片".
  runner.limits.PICTURE_WAIT_SECONDS = 2.0;
  const seen: [string, string[]][] = [];
  const replies: Record<string, unknown>[] = [];
  const running = new runner.Runner(async (_capability, asked) => {
    seen.push([asked.text, asked.attachments.map((item) => item.name)]);
    return ["答", 0];
  });
  const item = running.get("fake-bot");
  const picture = files.save("bg.png", PNG);
  running.send = async (_item, payload) => {
    replies.push(payload);
  };
  runner.deps.takeFiles = (_item, _id, names) => (Array.isArray(names) && names.length ? [picture] : []);
  const bot = CapabilitySchema.parse({ id: "fake-bot", name: "假机器人", kind: "automation", summary: "s" });
  const base = { op: "message", conversation: "g", sender: "成员1" };
  const question = running.ask(item, bot, { ...base, id: "1", text: "这个图片的背景在哪里" });
  await new Promise((done) => setTimeout(done, 200));
  await running.ask(item, bot, { ...base, id: "2", text: "", attachments: ["bg.png"] });
  await question;
  assert.deepEqual(seen, [["这个图片的背景在哪里", ["bg.png"]]]);
  assert.ok(replies.some((reply) => reply.re === "2" && reply.reply === null));
  // A picture sent a moment before is the one meant: no waiting then.
  const started = performance.now();
  await running.ask(item, bot, { ...base, id: "3", text: "这张图里是谁" });
  assert.ok(performance.now() - started < 1000);
});

