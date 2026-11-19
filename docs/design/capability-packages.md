# 能力包: capabilities installed and removed on their own

## 目标

A capability (docs/design/capabilities.md) can be uploaded as a package and uninstalled again,
without changing Super Partner's source or restarting it. An automation package keeps running in
the background (the runner capabilities.md left for later). Super Partner knows nothing of any one
service: the Feishu bot, built into the core before, becomes the first package
(`feishu-bot/` on the `capabilities` branch), which can be uninstalled and uploaded again.

## The package

A zip of one folder (or of its contents):

| File | |
|---|---|
| `capability.json` | `id` (`a-z0-9-`), `name`, `kind` (tool, automation), `version`, `summary`, `usage`, `check`, `secrets` (environment variables it needs), `domains` (hosts it may reach; `*.example.com` for subdomains), `entry` (an automation: the command that runs it) |
| `SKILL.md` | its manual; written from the manifest when missing |
| `requirements.txt` | optional: Python packages, installed into its own environment |
| its code | anything else |

Checked on upload: paths stay inside the folder, no links, at most `MAX_CAPABILITY_BYTES`
unpacked and `MAX_PACKAGE_FILES` files.

## 改动

- **`capability_packages.py`** (new): install and uninstall.
  - **Install:**
    - Unpacks the package into `<tools_dir>/capabilities/<id>/`, replacing an older version. It
      keeps the older version's secrets and state; the new code is switched off until the user
      enables it again.
    - With `requirements.txt`, builds `.venv` there. The venv and its `pip install` run in the
      capabilities' sandbox, reaching only the package index through the domain proxy.
    - Runs its check without network. A failed environment or check leaves it `failed`, with the
      output.
    - An uploaded package starts `disabled`, whatever its check said.
  - **Uninstall:** stops it and removes its folder, its data folder, its state and its secrets.
    The chats it started stay, as the user's conversations.
- **`capability_sandbox.py`** (new): how a capability's commands run.
  - The steps' sandbox rules: the home folder and Super Partner's data are hidden, and there is
    no network of its own.
  - Its folder is read-only. Its data folder (`<data_dir>/capability-data/<id>/`) is the only
    place it can write, besides its own `/tmp`.
  - **Domain proxy:** the only way out is a proxy in Super Partner, bridged in on a Unix socket
    (`HTTPS_PROXY`). It lets a connection through only to a declared host, on port 443 or 80,
    and through the user's own proxy when the service has one. A refused host is written to the
    capability's log.
  - Its secrets are given to it as environment variables, only to it.
- **`capability_runner.py`** (new): runs enabled automations. Each one is a process speaking
  JSON lines:
  - **From the automation** (stdout):
    - `{"op": "status", "text": …}`;
    - `{"op": "message", "id", "conversation", "text", "origin": {…}}`: someone asked something.
  - **To the automation** (stdin):
    - `{"re": id, "reply": …}`;
    - `{"event": "task_ended", "origin": {…}, "text": …}`.
  - **Restarts:** a crash is restarted after a pause, at most `MAX_RESTARTS` times in a row; then
    it stays stopped with its log.
  - **Daily budget:** each automation has one (`capability_daily_budget_usd`, changeable). Past
    it, the asker is told once a day, then nothing more is answered that day.
  - **State:** kept in `<data_dir>/capability-host/<id>.json`, out of the capability's reach:
    the budget, the spend, the chat that holds each conversation, the count.
- **`api.py`:**
  - A message from an automation is decided as 新建's 自动 decides (`triage.classify`):
    - a question is answered by the conversation's own chat (no project folder);
    - work is planned as a task waiting for the owner's confirmation.
  - `ExecutionRun.origin` remembers `{"capability": id, …the package's origin}`. When the task
    ends (`Executor.end_listeners`), its result is sent to that automation.
  - Endpoints:
    - `POST /api/capabilities/upload`: raw zip body, as attachments are sent.
    - `PUT` and `DELETE /api/capabilities/{id}/secrets`.
    - `PUT /api/capabilities/{id}/budget`.
    - `GET /api/capabilities/runtime`.
  - Enabling an uploaded capability needs `confirmed: true`, the user having seen what it may
    reach and which secrets it gets. `DELETE` uninstalls.
- **`secrets.py`:** private secrets are named `capability/<id>/<VARIABLE>`: in the keyring, never
  in a file or in Super Partner's environment.
- **`frontend/capabilities.tsx`:** 平台工程师 → 能力 gets:
  - **上传能力包;**
  - for each package:
    - its version;
    - its secrets form;
    - for an automation: its state, today's spend and the daily budget, the log;
  - a confirmation before enabling, listing hosts and secrets;
  - **卸载.**
- **Removed from the core:** `feishu.py`, the Feishu endpoints, settings, menu item and panel
  (`frontend/feishu.tsx`), and the optional dependency `lark-oapi`.
- **The `capabilities` branch:** packages are kept apart from Super Partner's source, on a branch
  of their own with no shared history (`feishu-bot/`: the Feishu bot).
  - Its own `lark-oapi` in its `requirements.txt`.
  - Reaches `*.feishu.cn` and `*.larksuite.com`.
  - Answers private messages and @ in groups, once each, never the backlog.
  - Replies under the message, and sends a task's result back.
- **`settings.capability_packages`** (`SUPER_PARTNER_CAPABILITY_PACKAGES`, off by default): without
  it, nothing can be uploaded and no automation runs.

## 测试

`tests/test_capability_packages.py`:

- **Package checks:** a package with a path leaving its folder, a link, too large, or no valid
  manifest is refused.
- **Upload:** it is installed disabled with its manual. Uploading a new version keeps its secrets
  and state.
- **Uninstall:** it removes the folder, data, state and secrets, and stops it.
- **Domain proxy:** a declared host gets through, an undeclared one gets 403 and a log line.
- **Sandbox:** the bwrap arguments hide the home folder and the data folder, keep its folder
  read-only, and give no network but the proxy.
- **Runner** (a fake automation, a small Python script run without the sandbox):
  - a question is answered in the conversation's chat, and the next one goes on there;
  - work becomes a task waiting for confirmation, and its result reaches the automation;
  - past the budget: one notice, then quiet;
  - a crash is restarted, then left stopped.
- **API:**
  - refuses without the setting;
  - enabling needs `confirmed` and its secrets;
  - secrets go only to the keyring.
- **Old records load.**

A package checks itself (`check` in its manifest, run when installed): `feishu-bot` checks which
messages it answers.
`mission-actions.test.mjs` covers the shelf: uploading, the secrets form, the confirmation before
enabling, and uninstalling.

## 风险

- **Uploaded code is someone's code running for the owner.**
  - It runs only in the sandbox:
    - its own folder is read-only;
    - it can write only its data folder;
    - it reaches only the hosts it declared;
    - it gets only its own secrets.
  - It needs the owner's confirmation to start. Tasks it asks for wait for the owner's
    confirmation as any task does, and its spending has a daily limit.
- **The domain proxy only sees host names** (CONNECT). A declared host is trusted with whatever
  the capability sends it.
- **It needs `bwrap` and `socat`.** Without them a package can be installed, but its environment
  and an automation cannot run. The shelf says so.
- **`pip` runs a package's build scripts**, in the sandbox, reaching only the package index.
