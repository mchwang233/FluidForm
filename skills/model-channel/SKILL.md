---
name: model-channel
description: How to add or change a model channel in FluidForm itself (an API provider, or a membership CLI such as Claude Code, Codex, Gemini CLI, agy), so that its steps stay sandboxed, reach exactly what the task allows, report their real errors and are counted against quota. Use it with skills/platform-engineer/SKILL.md whenever a model or CLI is added, upgraded, or misbehaves in a step (cannot reach a license server, reaches what it should not, loses its output, keeps being picked while out of quota).
---

# Adding a model channel

A channel is how FluidForm runs one model: an API provider (`providers.ts`, `catalog.ts`), a built-in
CLI (`cli-channels.ts` `CLI_SPECS`, `catalog.ts`), or a **model package** (`server/packages/<id>`,
`docs/design/model-packages.md`). A new CLI is a model package: its `capability.json` (kind
`extension`, `provides: ["model:cli:<name>"]`, its catalog entry in `models`) and its `src/index.ts`,
which exports a `ModelChannel` (`model-channels.ts`): its arguments, stdin, how to read its output and
quota, its login folders (`state`) and model hosts (`hosts`). It runs no command: FluidForm runs every
call in its own sandbox for it (`withSandbox`), which is the boundary whatever the CLI's own sandbox
does. Follow `server/packages/agy`.

A new **API provider** is a package with only a `capability.json` (`provides: ["model:api:<id>"]`,
`provider` and `models`; `api-providers.ts`), like `server/packages/kimi`. If it speaks the
OpenAI-compatible wire, nothing else changes: give its URLs, key variable, the efforts it accepts
(`efforts`) and its output-limit field. A new wire protocol is core work in `providers.ts`.

Each built-in CLI brings **its own sandbox**, and each one behaves differently. Never assume;
measure every item below on the real CLI before writing code, and keep the measured answers in the
design note.

Every pitfall here was hit at least once. The check is the cure.

## 1. What its steps can reach

Run one real call per case with a probe script in a scratch task folder under `workspace_root`
(the CLI may refuse an untrusted folder elsewhere), asking the model to run only `bash probe.sh`
and repeat its output. A compound command in the prompt may be held for approval instead.

```sh
# probe.sh: each line prints what got through
ls ~ | head -3                                  # the home folder: listed is acceptable, read is not
head -c1 <data_dir>/fluidform.db && echo DB_READ # the platform's database: must fail
head -c1 ~/.claude.json && echo CRED_READ        # other CLIs' logins: must fail
head -c1 <another task folder>/README.md && echo OTHER_TASK_READ   # must fail
echo x > <outside the task folder>/t && echo OUTSIDE_WRITE           # must fail
curl -s -m5 --noproxy '*' http://127.0.0.1:<FluidForm port>/api/tasks && echo API   # must fail
curl -s -m5 http://127.0.0.1:<FluidForm port>/api/tasks && echo API_VIA_PROXY       # must fail
curl -s -m10 https://pypi.org/simple/pip/ -o /dev/null && echo INTERNET  # only when the task allows it
lmutil lmstat -c <license port>@localhost       # a recorded host port: must work
```

Run it **with and without** the task's network permission. The rules:

| Must | Why it went wrong before |
|---|---|
| Steps never run outside a sandbox | Gemini CLI and Qwen run unsandboxed: they read the home folder and reach every local service |
| The FluidForm API is never reachable, with or without the internet | A networked Codex step shared the host's network and got `200` from `/api/tasks` |
| Recorded host ports (`environment.hostPorts()`, `sandbox.json` `host_ports`) are reachable, and only those | Claude Code's sandbox denied all of localhost, so VCS could not get a license |
| Nothing the CLI calls "leave the sandbox" runs unasked | Some CLIs (agy Auto mode, Claude `allowUnsandboxedCommands`) let a reviewer or the model run a command outside: turn it off |

How the existing channels meet them (reuse these, do not invent a fourth way):

- **API models**: FluidForm's own bwrap (`agent.ts` `sandboxArgs`); host ports by Unix socket and
  socat (`portBridge`, `listenScript`); the internet through pasta (`networkPrefix`, `--no-map-gw`).
- **Codex**: its permission profile (`codexStepPermissions`); with the internet, the whole CLI in a
  network of its own (`agent.ownNetwork`): pasta forwards only the proxies and the host ports.
- **Claude Code**: its settings (`withNetwork`, `withHostPorts`): only `127.0.0.1:<port>` in
  `allowedDomains`, and `CLAUDE_ENV_FILE` (`withClaudeBridge`, `proxyListenScript`) bridges each port
  through its proxy inside each command, because license clients ignore proxies.
- **Model packages** (agy): FluidForm's bwrap around the whole CLI (`model-channels.withSandbox`):
  the home hidden but for its `state`; with the internet, `ownNetwork`; without, `--unshare-net`, the
  host ports by Unix socket and only its `hosts` through `DomainProxy`. Its commands run outside its
  own sandbox and still inside this one.

## 2. Pitfalls in running it

- **pasta replaces socket stdio with `/dev/null`.** Node's "pipes" are sockets, so a CLI under pasta
  loses its prompt and its output. `ownNetwork` puts bash in front to make real pipes; reuse it.
- **`spawnSync` blocks the event loop**: a test server in the same process never answers.
- **bash reads `~/.bashrc` when stdin is a socket** (Node's pipes): a test's PATH gets reordered. Use
  `bash --norc` in tests.
- **A CLI run as pasta's root** cannot start its own sandbox: map the user back (bwrap `--uid`).
- **Headless runs deny tools silently** (agy: `denied_actions` in the JSON, empty `response`): allow
  exactly the tools steps need in the settings passed per call, never by editing the user's settings.
- **The CLI's own sandbox may hide or deny paths the step needs**: the tools folder
  (`environment.toolsDir()`) and the profiles (`environment.profiles()`) must be readable inside.
- **agy (1.5.18) cannot be kept in its own sandbox.** Print mode always turns its terminal sandbox on
  (the log says "Print mode: enabling terminal sandbox"; `enableTerminalSandbox: false` does not
  change it), that sandbox has no network and no loopback (no license), and nothing keeps a command
  in it: Auto mode's reviewer sends commands out, `toolPermission: "proceed-in-sandbox"` with Default
  mode denies every command headless, and with `command(*)` allowed all commands run outside.
  `unsandboxed(...)` rules are ignored on personal accounts. So FluidForm's sandbox is the boundary,
  and agy runs in Default mode (`agentMode: ""`) with `command(*)`, which needs no reviewer.
- **A CLI that calls its model through a proxy** (agy: `HTTPS_PROXY`) works with no internet behind
  `DomainProxy` given its hosts. Find them with a logging CONNECT proxy, not from the docs.
- **The prompt as an argument is limited to 128 KiB** (`MAX_ARG_STRLEN`): pass it on stdin (agy:
  `--print=` with `--input-format stream-json`, one `{"event":"user","message":{"content":…}}` line).
- **A model refuses a probe that looks like an attack** ("probe the sandbox", "bypass"): ask for the
  real job ("check the license server is up and download the page") with a script that does it.
- **A test script run outside the service reads `.fluidform` under the current folder**: set
  `FLUIDFORM_DATA_DIR`, or it sees no recorded host ports and the license check fails for no reason.
- **`pkill -f <pattern>` matches the shell running it** when the pattern is in its own command line.

## 3. Its answers and its errors

- Parse the structured output (`--output-format json` or JSON lines): the text, usage (input,
  output, cached tokens) and the status. Keep a fixture of a real success and a real failure in the
  test.
- **The real error may not be on stderr.** Codex prints a warning on stderr and the reason
  (`turn.failed`) on stdout; `failureDetail` must pick the reason (`reportedError`).
- **Quota messages vary per CLI and per plan** ("hit your 5-hour limit", "You have exhausted your
  quota on this model", "prepaid balance is insufficient"). Get the CLI's real wording (its
  changelog often quotes it), add a case to `tests/tools-online.test.ts` ("a membership … limit is a
  quota error") and check `failureKind` returns `"quota"` and `resetTime` reads its reset time. An
  unrecognised quota error keeps the exhausted model in routing, and every retry fails in seconds.

## 4. The lead's conversation (if the CLI can lead)

A lead reads and runs read-only commands; it never edits. Check its conversation can be continued
(the CLI's conversation id), that it is read-only in its sandbox, and that a lost conversation is
recognised (`SESSION_MISSING`).

## 5. Tests and the note

- Unit tests with a fake CLI on PATH (`fakeCli` in `tests/cli-channels.test.ts`) for the arguments
  each case gets: step, step with the internet, step with host ports, repair, lead.
- A test with the real sandbox where it can run without a model (`codex sandbox`, pasta, bwrap):
  `tests/sandbox.test.ts`, skipped when the tool is missing.
- One real end-to-end call per case before reporting, through `CliChannelRegistry.complete` (not the
  CLI by hand), with the probe above. Say in the report what you could not run (no quota, no login).
- The design note lists the probe's results per case, as `docs/design/cli-step-network.md` does.
