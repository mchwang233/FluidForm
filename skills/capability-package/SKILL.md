---
name: capability-package
description: How to add a capability that FluidForm runs as a package (a chat app's bot, an integration with an outside service, a background service, a tool for tasks) as its platform engineer, so it goes live without restarting FluidForm. Use it when the requested component is something people or other apps use through FluidForm rather than a change to how FluidForm itself plans, runs or shows tasks.
---

# Adding a capability as a package

A capability package is a folder FluidForm installs, switches on and off, and runs in a sandbox of its
own. A change that touches only one package's folder, plus its tests and docs, is installed while
FluidForm runs: no restart, no downtime. Anything else (`server/src`, `frontend`, an extension) is
applied by restarting the service, which takes every task, page and chat app offline for a while.
So build a new capability as a package, and keep the change inside it.

## Where it goes

- The package: `server/packages/<id>/` (`id` is `a-z0-9-`). FluidForm ships it and installs it from
  there.
- Its test: one file `server/tests/<id>.test.ts`, or new tests in `server/tests/api-packages.test.ts`
  (it has a fake automation, `pkg()`, and helpers to install and switch it on).
- Its note: `docs/design/<id>.md`, and one line for it in `docs/ARCHITECTURE.md`.
- Nothing else. If the core truly lacks something the package needs (an event, a field in a message),
  say so in the plan as a separate, small core change: it is applied by a restart, the package is not.

## The package

Read `docs/design/capability-packages.md` for the whole format, and the header of
`server/src/capability-runner.ts` for what an automation and FluidForm say to each other.

- `capability.json`: `id`, `name` (in the user's language), `kind`, `version`, `summary`, `usage`,
  `check`, `secrets`, `domains`, `entry`.
  - `kind`: `automation` (a process that keeps running: a chat app's bot), `service` (provides
    something FluidForm asks of it), `tool` (a command the steps of tasks may run).
  - `secrets`: the names of the keys it needs (app id, token). Never a value: the user fills them in
    on the capabilities page.
  - `domains`: every host it reaches (`*.example.com` for subdomains). Its sandbox reaches no other.
  - `check`: a command that proves it loads and works, run without network when it is installed. A
    package whose check fails is not switched on.
  - `entry`: for an automation, the command that runs it (`python3 bot.py`).
- `requirements.txt`: Python packages, each pinned to an exact version (`name==1.2.3`). An unpinned
  dependency changes under it at the next install.
- `SKILL.md`: its manual for people, in their language: what it does, what to fill in, where to find
  those values in the outside service.
- `CHAT.md` (a chat app's bot, optional): how to talk there (length, mentions, formatting).
- Its code. Use the outside service's official SDK when there is one (see the platform-engineer
  skill: take what already works).

## An automation

- It talks JSON lines on stdin and stdout, as `capability-runner.ts` says: `status` lines for how it
  is doing, a `message` for each thing someone asks (with `conversation`, `origin`, `sender`,
  `sender_id`, `attachments`), and it reads `reply` (with `files`) and `task_ended` (with `files`).
- It writes only in its data folder (`SP_DATA_DIR` in its environment; its own folder is
  `SP_CAPABILITY_DIR`, read-only) and `/tmp`.
- It never logs a secret, a token or a whole message body.
- Make it testable without the outside service: put the SDK behind one small object the test can
  replace, as the test's fake automation does.

## Tests

- The check command passes offline in the package's own folder.
- In `server/tests/`: the package installs (`check_ok`), and its messages reach FluidForm and the
  replies come back (a fake of the outside service, never the real one).
- `cd server && npm run check` and the test file, as the platform-engineer skill says.

## Report

Say what the user must do to use it: which secrets to fill in on the capabilities page, and where in
the outside service to find them. A new package is switched on once installed, and runs as soon as its
secrets are there.
