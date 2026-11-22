// agent.ts's sandbox and environment.ts's licence ports: tests/test_agent.py (and the sandbox
// tests of test_capability_packages, test_call_runtime and test_platform_repair), ported. These
// run real bwrap and pasta commands, as the Python tests did.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as agent from "../src/agent.js";
import { Workspace } from "../src/agent.js";
import { settings } from "../src/config.js";
import * as environment from "../src/environment.js";
import { log } from "../src/log.js";
import { randomBytes } from "node:crypto";
import { shlexQuote, shlexSplit } from "../src/py.js";

const saved = { ...settings };
const env = { ...process.env };
const deps = { ...agent.deps };
const overrides = environment.deps.overrides;
let folder = "";

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "sandbox-"));
  Object.assign(settings, { data_dir: join(folder, "data"), workspace_root: join(folder, "workspaces"), database_path: null,
    sandbox_env: [], sandbox_profiles: [], sandbox_host_ports: [] });
  // Never load this machine's own scripts or ports in these tests.
  environment.deps.overrides = () => ({});
});
afterEach(() => {
  Object.assign(settings, saved);
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  Object.assign(agent.deps, deps);
  environment.deps.overrides = overrides;
  rmSync(folder, { recursive: true, force: true });
});

/** Live network checks run only when the validation task permits networking (conftest.network_enabled). */
const networkAllowed = () => process.env.FLUIDFORM_VALIDATION_ALLOW_NETWORK !== "false";

/** command_workspace: command I/O and file isolation without needing a network namespace. */
function commandWorkspace(): Workspace {
  const root = join(folder, "command work");
  mkdirSync(root);
  agent.deps.sandboxPorts = async () => [];
  agent.deps.networkAvailable = () => false;
  return new Workspace(root, { network: true });
}

function server(answer: string): Promise<[Server, number]> {
  const made = createServer((socket) => socket.end(answer));
  return new Promise((done) => made.listen(0, "127.0.0.1", () => done([made, (made.address() as { port: number }).port])));
}

test("commands load the EDA profile before running tools", async () => {
  const ws = commandWorkspace();
  const eda = join(ws.root, "EDA tool's setup");
  const vcsHome = join(eda, "vcs");
  const verdiHome = join(eda, "verdi");
  for (const [tool, place] of [["vcs", join(vcsHome, "linux64/bin")], ["urg", join(vcsHome, "linux64/bin")], ["verdi", join(verdiHome, "bin")]]) {
    mkdirSync(place, { recursive: true });
    writeFileSync(join(place, tool), `#!/bin/sh\nprintf '%s:%s:%s\\n' ${tool} "$VCS_HOME" "$SNPSLMD_LICENSE_FILE"\n`);
    chmodSync(join(place, tool), 0o755);
  }
  const profile = join(eda, ".edarc");
  writeFileSync(profile, `export VCS_HOME=${shlexQuote(vcsHome)}\nexport VERDI_HOME=${shlexQuote(verdiHome)}\n`
    + 'PATH="$PATH:$VCS_HOME/linux64/bin:$VERDI_HOME/bin"\nexport SNPSLMD_LICENSE_FILE=27000@license.test\nexport LM_LICENSE_FILE="$SNPSLMD_LICENSE_FILE"\n');
  settings.sandbox_profiles = [profile, join(eda, "absent.sh")];
  process.env.OPENAI_API_KEY = "should-not-reach-the-command";
  const output = await ws.call("Bash", { command: "vcs && urg && verdi && echo license=$LM_LICENSE_FILE; echo key=${OPENAI_API_KEY:-none}" });
  assert.ok(!output.startsWith("Exit code") && !output.startsWith("Error"), output);
  for (const tool of ["vcs", "urg", "verdi"]) assert.ok(output.includes(`${tool}:${vcsHome}:27000@license.test\n`), output);
  assert.ok(output.includes("license=27000@license.test\n") && output.endsWith("key=none"));
});

for (const code of [0, 7]) {
  test(`commands return stdout and stderr without an EDA profile (exit ${code})`, async () => {
    const output = await commandWorkspace().call("Bash", { command: `echo stdout-visible; printf '%s\\n' 'literal "$HOME"'; echo stderr-visible >&2; exit ${code}` });
    const lines = 'stdout-visible\nliteral "$HOME"\nstderr-visible';
    assert.equal(output, code ? `Exit code ${code}\n${lines}` : lines);
  });
}

test("a command's timeout keeps its stdout and stderr", async () => {
  const output = await commandWorkspace().call("Bash", { command: "echo before-timeout; echo error-before-timeout >&2; sleep 5", timeout: 1000 });
  assert.ok(output.startsWith("Command timed out after 1s"));
  assert.ok(output.split("\n").includes("before-timeout") && output.split("\n").includes("error-before-timeout"));
});

test("Bash keeps /tmp and its directory through the attempt", async () => {
  // Like Claude Code's Bash: /tmp and the working directory carry over between commands, shell
  // variables do not, and nothing may be written outside the workspace and /tmp.
  const ws = commandWorkspace();
  let output = await ws.call("Bash", { command: 'test "$TMPDIR" = /tmp && mkdir -p /tmp/sync_chk sub && '
    + "printf '%s\\n' 'module sync_tb; endmodule' > /tmp/sync_chk/sync_tb.sv && "
    + `printf '%s\\n' absolute > ${shlexQuote(join(ws.root, "absolute.txt"))} && export SP_VAR=set && cd sub` });
  assert.equal(output, "(the command printed no output)");
  assert.equal(readFileSync(join(ws.root, "absolute.txt"), "utf8"), "absolute\n");
  output = await ws.call("Bash", { command: "cat /tmp/sync_chk/sync_tb.sv; pwd; echo var=${SP_VAR:-unset}; "
    + "touch /usr/sp-command-write-test 2>/dev/null && echo escaped || echo outside-blocked" });
  assert.equal(output, `module sync_tb; endmodule\n${join(ws.root, "sub")}\nvar=unset\noutside-blocked`);
  // Leaving the working directory does not carry over: the next command starts there again, and the model is told.
  assert.equal(await ws.call("Bash", { command: "cd /tmp/sync_chk && pwd" }), `/tmp/sync_chk\nShell cwd was reset to ${ws.root}`);
  assert.equal(await ws.call("Bash", { command: "pwd" }), ws.root);
  const tmp = ws.tmp();
  ws.close();
  assert.ok(!existsSync(tmp));
  const instructions = await ws.instructions();
  assert.ok(instructions.includes("/tmp for this whole attempt") && instructions.includes("working directory between calls"));
  assert.ok(instructions.includes("in /tmp (the same /tmp Bash sees)"));
});

test("the file tools stay inside the working directory", async () => {
  const root = join(folder, "work");
  mkdirSync(root);
  writeFileSync(join(folder, "secret.txt"), "secret");
  symlinkSync(join(folder, "secret.txt"), join(root, "link"));
  const ws = new Workspace(root);
  assert.equal(await ws.call("Write", { file_path: "src/app.js", content: "let a = 1;\n" }), "Created src/app.js (1 lines)");
  assert.equal(await ws.call("Edit", { file_path: "src/app.js", old_string: "1", new_string: "2" }), "Edited src/app.js (1 replacement):\n     1\tlet a = 2;");
  assert.equal(await ws.call("Read", { file_path: "src/app.js" }), "     1\tlet a = 2;");
  assert.equal(await ws.call("Read", { file_path: join(root, "src/app.js") }), "     1\tlet a = 2;");
  assert.ok((await ws.call("LS", {})).startsWith("./\nsrc/\n"));
  for (const [name, args] of [["Read", { file_path: "../secret.txt" }], ["Read", { file_path: "/etc/passwd" }], ["Read", { file_path: "link" }],
    ["Write", { file_path: "../escape.txt", content: "x" }]] as [string, Record<string, unknown>][]) {
    assert.ok((await ws.call(name, args)).includes("outside the working directory"), name);
  }
  assert.ok(!existsSync(join(folder, "escape.txt")));
  assert.ok((await ws.call("Edit", { file_path: "src/app.js", old_string: "zzz", new_string: "y" })).includes("was not found"));
  assert.ok((await ws.call("Write", { __invalid__: "{oops" })).includes("JSON object"));
  assert.ok((await ws.call("rm_rf", {})).includes("unknown tool"));
});

for (const overrideHome of [false, true]) {
  test(`commands run sandboxed, without keys, network or writes outside (HOME ${overrideHome ? "changed" : "as is"})`, async () => {
    if (overrideHome) {
      mkdirSync(join(folder, "temporary-home"));
      process.env.HOME = join(folder, "temporary-home");
    }
    process.env.OPENAI_API_KEY = "sk-should-not-leak";
    const root = join(resolve(settings.workspace_root), "_agent_test");
    mkdirSync(root, { recursive: true });
    const ws = new Workspace(root);
    const args = ws.sandboxArgs("true");
    const tmpfs = args.map((value, index) => (value === "--tmpfs" ? args[index + 1] : null)).filter(Boolean);
    assert.ok(tmpfs.includes(userInfo().homedir));
    const output = await ws.call("Bash", { command: "echo made > inside.txt; cat inside.txt; echo key=${OPENAI_API_KEY:-none}; "
      // Above the working directory is a throwaway in-memory home: writes never reach disk.
      + 'touch "$(dirname "$PWD")/escape.txt"; '
      + "touch /usr/escape.txt 2>/dev/null && echo system-escaped || echo system-blocked; ls /home/*/.ssh 2>/dev/null | wc -l" });
    assert.ok(!output.startsWith("Exit code") && !output.startsWith("Error"), output);
    assert.ok(output.includes("made") && output.includes("key=none") && output.includes("system-blocked"), output);
    assert.ok(output.trimEnd().endsWith("0"));
    assert.equal(readFileSync(join(root, "inside.txt"), "utf8"), "made\n");
    assert.ok(!existsSync(join(dirname(root), "escape.txt")));
    assert.ok((await ws.call("Bash", { command: "sleep 5", timeout: 1000 })).includes("timed out"));
  });
}

test("only listed host ports reach the sandbox", async () => {
  const [listed, port] = await server("hello-from-host\n");
  const [unlisted, other] = await server("hello-from-host\n");
  try {
    settings.sandbox_host_ports = [port];
    settings.sandbox_env = ["SP_TOOL_HOME"];
    process.env.SP_TOOL_HOME = "/opt/tool";
    const root = join(resolve(settings.workspace_root), "_agent_ports_test");
    mkdirSync(root, { recursive: true });
    const output = await new Workspace(root).call("Bash", { command: `timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/${port}; cat <&3' || echo listed-failed; `
      + `timeout 2 bash -c 'exec 3<>/dev/tcp/127.0.0.1/${other}' 2>/dev/null && echo unlisted-open || echo unlisted-blocked; echo tool=$SP_TOOL_HOME` });
    assert.ok(output.includes("hello-from-host") && output.includes("unlisted-blocked") && output.includes("tool=/opt/tool"), output);
    assert.ok((await agent.agentInstructions()).includes(`local ports ${port}`));
  } finally {
    listed.close();
    unlisted.close();
  }
});

test("the host ports are the setting's and this machine's record, nothing found by itself", async () => {
  settings.sandbox_host_ports = [26585];
  environment.deps.overrides = () => ({ host_ports: [27021, 26585, "x", 0, 70000] });
  assert.deepEqual(await environment.hostPorts(), [26585, 27021]);
});

test("a task allowing the network reaches out, but not local services", { skip: !networkAllowed() && "The task disabled network access" }, async () => {
  const [proxy, port] = await server("hello-from-proxy\n");
  const [service, other] = await server("hello-from-proxy\n");
  try {
    for (const name of agent.PROXY_ENV) delete process.env[name];
    process.env.HTTPS_PROXY = `http://127.0.0.1:${port}`;
    const root = join(resolve(settings.workspace_root), "_agent_network_test");
    mkdirSync(root, { recursive: true });
    const ws = new Workspace(root, { network: true });
    assert.deepEqual(agent.proxyPorts(), [port]);
    assert.ok(!ws.sandboxArgs("true").includes("--unshare-net"));
    const route = "awk '$2 == \"00000000\" {f = 1} END {exit !f}' /proc/net/route && echo routed || echo no-route";
    const output = await ws.call("Bash", { command: `${route}; `
      // A route out exists, the user's local proxy is forwarded, other local ports are not.
      + `timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/${port}; cat <&3' || echo proxy-failed; `
      + `timeout 2 bash -c 'exec 3<>/dev/tcp/127.0.0.1/${other}' 2>/dev/null && echo local-open || echo local-blocked; echo proxy=$HTTPS_PROXY` });
    assert.ok(output.startsWith("routed") && output.includes("hello-from-proxy") && output.includes("local-blocked"), output);
    assert.ok(output.includes(`proxy=http://127.0.0.1:${port}`));
    const instructions = await ws.instructions();
    assert.ok(instructions.includes("allows the internet") && !instructions.includes("no network"));
    // Without the task's permission there is no route out at all.
    assert.ok((await new Workspace(root).call("Bash", { command: route })).includes("no-route"));
  } finally {
    proxy.close();
    service.close();
  }
});

test("tools from environment repairs reach the sandbox", async () => {
  const tools = environment.prepare();
  writeFileSync(join(tools, "bin", "mytool"), "#!/bin/sh\necho tool-ran\n");
  chmodSync(join(tools, "bin", "mytool"), 0o755);
  writeFileSync(join(tools, "python", "mymod.py"), "print('module-ran')\n");
  writeFileSync(join(tools, "sandbox.json"), JSON.stringify({ env: { EDA_HOME: "/opt/eda", PATH: "/evil", "bad name": "x" } }));
  environment.deps.overrides = overrides; // this test's own record
  const root = join(resolve(settings.workspace_root), "_agent_tools_test");
  mkdirSync(root, { recursive: true });
  const output = await new Workspace(root).call("Bash", { command: "mytool; python3 -c 'import mymod'; echo eda=$EDA_HOME; "
    + `touch ${tools}/bin/x 2>/dev/null && echo tools-writable || echo tools-readonly` });
  assert.ok(output.includes("tool-ran") && output.includes("module-ran") && output.includes("eda=/opt/eda") && output.includes("tools-readonly"), output);
});

/** A scratch folder outside /tmp, which every sandbox replaces with its own. */
function outsideTmp(): string {
  return mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".sandbox-test-"));
}

test("a step cannot read other tasks or the platform's data", async () => {
  // Only this task's folder and the shared tools: not the other tasks' folders, the platform's
  // database (every task's requests, plans and lead conversations) or the rest of its data.
  const place = outsideTmp();
  try {
    Object.assign(settings, { data_dir: join(place, "data"), workspace_root: join(place, "workspaces") });
    const elsewhere = join(place, "db", "elsewhere.db");
    mkdirSync(dirname(elsewhere));
    writeFileSync(elsewhere, "other database");
    settings.database_path = elsewhere;
    const tools = environment.prepare();
    writeFileSync(join(tools, "bin", "mytool"), "#!/bin/sh\necho tool-ran\n");
    chmodSync(join(tools, "bin", "mytool"), 0o755);
    writeFileSync(join(settings.data_dir, "fluidform.db"), "all tasks");
    mkdirSync(join(settings.data_dir, "supervisors"));
    const mine = join(settings.workspace_root, "task-a");
    const other = join(settings.workspace_root, "task-b");
    mkdirSync(mine, { recursive: true });
    mkdirSync(other);
    writeFileSync(join(other, "secret.txt"), "task b");
    const output = await new Workspace(mine).call("Bash", { command: `ls ${settings.workspace_root}; cat ${other}/secret.txt `
      + `${settings.data_dir}/fluidform.db ${elsewhere} 2>/dev/null; ls ${settings.data_dir}; mytool; echo ok > ${mine}/mine.txt && cat ${mine}/mine.txt` });
    for (const hidden of ["task b", "all tasks", "other database", "task-b", "supervisors"]) assert.ok(!output.includes(hidden), `${hidden}: ${output}`);
    assert.ok(output.includes("task-a") && output.includes("tool-ran") && output.trimEnd().endsWith("ok"), output);
  } finally {
    rmSync(place, { recursive: true, force: true });
  }
});

test("a task in the platform's own folder still cannot read its data", async () => {
  const place = outsideTmp();
  try {
    const project = join(place, "project");
    Object.assign(settings, { data_dir: join(project, ".fluidform"), workspace_root: join(project, "workspaces"), database_path: null });
    const tools = environment.prepare();
    writeFileSync(join(tools, "bin", "mytool"), "#!/bin/sh\necho tool-ran\n");
    chmodSync(join(tools, "bin", "mytool"), 0o755);
    writeFileSync(join(settings.data_dir, "fluidform.db"), "all tasks");
    mkdirSync(join(project, "workspaces", "task-b"), { recursive: true });
    writeFileSync(join(project, "main.py"), "print('project')\n");
    const output = await new Workspace(project).call("Bash", { command: "cat main.py; cat .fluidform/fluidform.db 2>/dev/null; ls workspaces; mytool" });
    assert.ok(output.includes("print('project')") && output.includes("tool-ran"), output);
    assert.ok(!output.includes("all tasks") && !output.includes("task-b"));
  } finally {
    rmSync(place, { recursive: true, force: true });
  }
});

for (const network of [false, true]) {
  test(`command output arrives, the internet ${network ? "allowed" : "not allowed"}`,
    { skip: network && !networkAllowed() && "The task disabled network access" }, async () => {
    // Python: under uvloop (whose pipes are sockets) a command behind pasta came back empty; a pipe
    // Node makes is a socket pair too, so the output goes through a file.
    const workspace = new Workspace(folder, { network });
    try {
      assert.equal(await workspace.call("Bash", { command: "echo hello; echo oops >&2; exit 3" }), "Exit code 3\nhello\noops");
    } finally {
      workspace.close();
    }
  });
}

test("a step allowed the internet is still the user, not root", { skip: !networkAllowed() && "The task disabled network access" }, async () => {
  // pasta makes the sandbox root of a namespace of its own: a step would think it is root.
  writeFileSync(join(folder, "mine.txt"), "x");
  const workspace = new Workspace(folder, { network: true });
  try {
    const output = await workspace.call("Bash", { command: "id -u; stat -c %u mine.txt; touch new.txt" });
    assert.deepEqual(output.split(/\s+/).filter(Boolean), [String(userInfo().uid), String(userInfo().uid)]);
    assert.equal(statSync(join(folder, "new.txt")).uid, userInfo().uid);
  } finally {
    workspace.close();
  }
});

test("host-mode commands leave the sandbox but cannot use sudo", async () => {
  process.env.OPENAI_API_KEY = "sk-should-not-leak";
  const root = join(folder, "work");
  mkdirSync(root);
  const output = await new Workspace(root, { host: true }).call("Bash", { command: `echo made > ${folder}/outside.txt; echo key=\${OPENAI_API_KEY:-none}; `
    + "sudo -n true 2>/dev/null && echo became-root || echo sudo-blocked" });
  assert.ok(output.includes("key=none") && output.includes("sudo-blocked"), output);
  assert.equal(readFileSync(join(folder, "outside.txt"), "utf8"), "made\n");
  assert.ok((await new Workspace(root, { host: true }).instructions()).includes("without root"));
});

test("profiles come from the setting and the machine's record", async () => {
  // Which scripts commands load is this machine's business: none by default, then the setting and
  // the recorded sandbox.json, each once; the instructions name them only when there are some.
  assert.ok(environment.profiles().length === 0 && environment.shellSetup() === "");
  assert.ok(!(await agent.agentInstructions()).includes("first loads"));
  settings.sandbox_profiles = ["/opt/tools/setup.sh"];
  environment.deps.overrides = () => ({ profiles: ["/eda/env.sh", "/opt/tools/setup.sh", 3] });
  assert.deepEqual(environment.profiles(), ["/opt/tools/setup.sh", "/eda/env.sh"]);
  assert.ok(environment.shellSetup().includes("if [ -r /eda/env.sh ]; then . /eda/env.sh"));
  assert.ok((await agent.agentInstructions()).includes("Each command first loads /opt/tools/setup.sh, /eda/env.sh"));
});

test("a step's environment is not on its command line", async () => {
  // Regression: the step's variables (a proxy with its password, say) were bwrap --setenv
  // arguments, which every user of the machine can read; now they are its environment.
  const secret = "pw-" + randomBytes(6).toString("hex");
  process.env.SP_TEST_SECRET = secret;
  const ws = commandWorkspace();
  settings.sandbox_env = ["SP_TEST_SECRET"];
  const output = await ws.call("Bash", { command: 'echo "inside=$SP_TEST_SECRET"; for f in /proc/[0-9]*/cmdline; do tr "\\0" " " < $f; echo; done' });
  assert.ok(output.includes(`inside=${secret}`));
  assert.equal(output.split(secret).length - 1, 1, output);
});

test("the environment leaves the command line", () => {
  const args = ["bwrap", "--ro-bind", "/", "/", "--clearenv", "--setenv", "TOKEN", "s3cret", "--setenv", "PATH", "/usr/bin",
    "--chdir", "/x", "--", "/bin/bash", "-c", "echo --setenv A b", "--clearenv"];
  const [kept, found] = agent.withoutEnvArgs(args);
  assert.deepEqual(found, { TOKEN: "s3cret", PATH: "/usr/bin" });
  assert.ok(!kept.includes("s3cret") && !kept.slice(0, kept.indexOf("--")).includes("--clearenv"));
  // The command itself is left as it was.
  assert.deepEqual(kept.slice(kept.indexOf("--")), ["--", "/bin/bash", "-c", "echo --setenv A b", "--clearenv"]);
  assert.ok(kept[0].endsWith("bwrap"));
});


test("the environment leaves the command line of a sandbox allowed the internet too", () => {
  // Regression: pasta's own "--" came first, so bwrap kept --clearenv and every --setenv on its command
  // line: a proxy's password could be read by any user, and an MCP server's key never reached it.
  const args = [...agent.networkPrefix([]), "bwrap", "--ro-bind", "/", "/", "--clearenv", "--setenv", "HTTPS_PROXY", "http://u:pw@proxy:1",
    "--chdir", "/x", "--", "/bin/bash", "-c", "echo hi"];
  const [kept, found] = agent.withoutEnvArgs(args);
  assert.deepEqual(found, { HTTPS_PROXY: "http://u:pw@proxy:1" });
  assert.ok(!kept.join(" ").includes("pw@proxy") && !kept.includes("--clearenv"));
  assert.ok(kept[0].endsWith("pasta") && kept.includes("bwrap"));
  assert.deepEqual(kept.slice(kept.lastIndexOf("--")), ["--", "/bin/bash", "-c", "echo hi"]);
});
