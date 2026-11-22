# 能力包: capabilities installed and removed on their own

## 目标

A capability (docs/design/capabilities.md) can be uploaded as a package and uninstalled again,
without changing FluidForm's source or restarting it. An automation package keeps running in
the background (the runner capabilities.md left for later). FluidForm knows nothing of any one
service: the Feishu bot, built into the core before, becomes the first package
(`feishu-bot/` on the `capabilities` branch), which can be uninstalled and uploaded again.

## The package

A zip of one folder (or of its contents):

| File | |
|---|---|
| `capability.json` | `id` (`a-z0-9-`), `name`, `kind` (tool, automation), `version`, `summary`, `usage`, `check`, `secrets` (environment variables it needs), `domains` (hosts it may reach; `*.example.com` for subdomains), `entry` (an automation: the command that runs it) |
| `SKILL.md` | its manual; written from the manifest when missing |
| `CHAT.md` | optional, for an automation: how to talk where it brings people's messages (an IM's manners). The model answering in its chats is told it first (`supervisor.chat_guide`, at most `MAX_CHAT_GUIDE_CHARS`), with whether the chat is private or a group (`origin["chat_type"]`: `p2p`, `group`) |
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
  - The steps' sandbox rules: the home folder and FluidForm's data are hidden, and there is
    no network of its own.
  - Its folder is read-only. Its data folder (`<data_dir>/capability-data/<id>/`) is the only
    place it can write, besides its own `/tmp`.
  - **Domain proxy:** the only way out is a proxy in FluidForm, bridged in on a Unix socket
    (`HTTPS_PROXY`). It lets a connection through only to a declared host, on port 443 or 80,
    and through the user's own proxy when the service has one. A refused host is written to the
    capability's log.
  - Its secrets are given to it as environment variables, only to it: the environment of the
    sandbox process, never bwrap `--setenv` arguments, which every user can read in its command line
    (`agent.without_env_args`, used for the steps' sandbox too).
- **`capability_runner.py`** (new): runs enabled automations. Each one is a process speaking
  JSON lines:
  - **From the automation** (stdout):
    - `{"op": "status", "text": …}`;
    - `{"op": "message", "id", "conversation", "text", "origin": {…}}`: someone asked something.
      With `"attachments": [path, …]`, files sent along (a picture, a document): paths in its data
      folder. FluidForm takes each one into its own attachments and removes it there; a path
      outside that folder, a link, or a file over `MAX_ATTACHMENT_BYTES` is refused with a log
      line. The chat or task gets them as files the user attached; a chat whose chosen model
      cannot see images is answered by one that can, saying so. A message of files alone reads
      "（见附件）".
      A message with neither words nor files, said where it was called on (an @ and nothing
      else), reads "（只 @ 了你，没有别的话）", with what the group said before.
  - **To the automation** (stdin):
    - `{"re": id, "reply": …, "files": […]}`: the answer, and the files to send with it (paths in its
      data folder, `outbox/`, which it removes once sent). A chat with tools (chat-tools.md) makes a
      picture or a file in its own folder and names it on a `SEND: <name>` line; FluidForm sends
      only those, from that folder only, at most `MAX_SENT_FILES`, each within the attachment size
      (`_send_files`), and the chat keeps "（发了：…）" with the answer;
    - `{"event": "task_ended", "origin": {…}, "text": …}`.
    - A message may say `"addressed": false` (said where it was not called on: a group message
      without @ it), `"sender"` and `"people"` (the names of the group's people: the chat is told
      them with the message, not kept in what the chat shows, so an answer can write "@name" and
      the package turns it into its app's @; `group_people` bounds them). The cheapest model decides whether it is meant for it
      (`triage.addressed`; failure or doubt: no). If not, it is not answered (`reply` null) but
      kept, per conversation (`state["heard"]`, bounded by `keep_heard`), and the next message it
      answers there is told what the group said before. Pictures and files
      sent there are kept too (`state["heard_files"]`, the latest `MAX_HEARD_FILES`) and come with
      that next message: a picture cannot @ the bot, so the question about it comes after it.
      Each such message leaves a line in the automation's log (kept, or answered). Past its day's budget it stays quiet
      there, with no notice.
    - `{"progress": id, "text": …}`: a chat's answer while it is being written, all of it so far,
      at most every `PROGRESS_SECONDS`, before its `re`. An API model's streamed text
      (`streaming.listener`, heard in `providers._stream`, set only around the chat's lead, so
      planning and other calls are not passed on); a membership CLI answers at once. An
      automation that does not know it ignores it.
  - **Restarts:** a crash is restarted after a pause, at most `MAX_RESTARTS` times in a row; then
    it stays stopped with its log.
  - **Spending (2026-11-22, the user's decision):** counted by the day and shown on the card, never a
    limit: no daily budget, no amounts said in the chat app. A chat from an automation
    (`origin.capability`) is count-only (`budget.countOnly`): when pricing does not answer, it
    answers all the same and that call is not counted. A task planned from it has its own budget,
    confirmed by the owner, as any task.
  - **State:** kept in `<data_dir>/capability-host/<id>.json`, out of the capability's reach:
    the spend, the chat that holds each conversation, the count, the chat model
    preference (`model_id`, null means automatic), and the last preference applied to each chat
    (`chat_preferences`). Old state defaults to automatic; these settings survive restart and
    package upgrades and stay independent for each capability.
- **`api.py`:**
  - Every message from an automation goes to the conversation's own chat (no project folder), whose
    model sees the whole conversation. It is not classified on its own: a fragment of a sentence
    ("关于戏剧的") was taken for work, without what was said before.
    - Work is asked for by that model (`supervisor.AUTOMATION_WORK`): once it knows what is
      wanted, it ends its answer with `TASK: {"request": …}`, a self-contained request. FluidForm
      plans the task (`_automation_task`), with the chat's transcript as its background and the
      chat's files as its own, waiting for the owner's confirmation. The answer, without the line,
      says the plan is ready; the chat keeps it as sent. The line is never shown, not even while
      the answer is being written (`supervisor.for_person`).
    - The task's origin remembers the conversation and the chat (`conversation`, `chat_run`).
      When it ends, the chat shows how, and its model is told with the next message
      (`state["notes"]`).
  - `ExecutionRun.origin` remembers `{"capability": id, …the package's origin}`. When the task
    ends (`Executor.end_listeners`), its result is sent to that automation.
  - Endpoints:
    - `POST /api/capabilities/upload`: raw zip body, as attachments are sent.
    - `PUT` and `DELETE /api/capabilities/{id}/secrets`.
    - `PUT /api/capabilities/{id}/budget`.
    - `PUT /api/capabilities/{id}/model`: `{"model_id": "…"}` selects a chat model;
      `{"model_id": null}` restores automatic selection. Only uploaded automations accept this
      setting. Models must appear in the existing `GET /api/chats/models` list: configured,
      enabled API models or membership CLIs that support conversations, with routing scores and
      available quota. Invalid choices return 422 and leave the saved choice intact.
    - `GET /api/capabilities/runtime`.
  - Enabling an uploaded capability needs `confirmed: true`, the user having seen what it may
    reach and which secrets it gets. `DELETE` uninstalls.
- **`secrets.py`:** private secrets are named `capability/<id>/<VARIABLE>`: in the keyring, never
  in a file or in FluidForm's environment.
- **`frontend/capabilities.tsx`:** 平台工程师 → 能力 gets:
  - **上传能力包;**
  - for each package:
    - its version;
    - its secrets form;
    - for an automation: its state, today's spend and the daily budget, the log, and a **聊天模型**
      dropdown with automatic/API/membership CLI choices, a save button, saved state and errors;
  - a confirmation before enabling, listing hosts and secrets;
  - **卸载.**
- **Removed from the core:** `feishu.py`, the Feishu endpoints, settings, menu item and panel
  (`frontend/feishu.tsx`), and the optional dependency `lark-oapi`.
- **The `capabilities` branch:** packages are kept apart from FluidForm's source, on a branch
  of their own with no shared history (`feishu-bot/`: the Feishu bot).
  - Its own `lark-oapi` in its `requirements.txt`.
  - Reaches `*.feishu.cn` and `*.larksuite.com`.
  - Answers private messages and @ in groups, once each, never the backlog.
  - Replies under the message as a card (Markdown shown as it is meant), written word by word as the
    answer comes (CardKit streaming, 1.0.5), and sends a task's result back.
  - Pictures, rich text with pictures, and files are downloaded into its data folder and sent
    along (1.0.3). In a group only rich text can @ it, so a picture there goes in a rich-text message.
- **`settings.capability_packages`** (`FLUIDFORM_CAPABILITY_PACKAGES`, off by default): without
  it, nothing can be uploaded and no automation runs.

## 聊天模型的生效范围

在 **平台 → 能力 → 飞书机器人 → 聊天模型** 选择并保存。通用的自动化能力控制面板提供
这个入口，飞书能力包不需要修改，也不需要重启。

设置只决定通过该能力发来的聊天消息由谁回答。消息分类继续使用现有的廉价 API 模型，
转成任务后的规划、执行与预算保持原有规则。

新对话使用所选模型。已有对话在下一条消息开始回复前读取最新设置；正在生成的回复先
完成，不会被切断或改写。切换模型会建立新的 API/CLI 会话，由 `supervisor.chat_opening`
复用 `handover` / `chat_transcript` 交接最近的对话，沿用 `MAX_CHAT_HANDOVER_CHARS` 限长。
恢复自动选择会为已有对话重新选模型；一直使用自动的对话继续保留原会话。

若保存后模型被停用、移除、额度耗尽，或调用失败，沿用现有可用模型与后备机制，并在
回复和运行日志中提示实际回答的模型。保存的偏好保留，后续消息仍会优先尝试它。
模型列表中暂时没有的已保存选项仍显示其标识，不会在界面里悄悄变成“自动”。

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
- **Chat models:** persistence across reload/upgrade, per-capability isolation, invalid-choice
  rejection, actual API/CLI selection, a change saved while a reply is in flight, fresh sessions
  with bounded recent context, restoring automatic selection, and visible fallback without
  changing classification or task planning.

A package checks itself (`check` in its manifest, run when installed): `feishu-bot` checks which
messages it answers.
`mission-actions.test.mjs` covers the shelf: uploading, the secrets form, the confirmation before
enabling, and uninstalling. It also covers model selection, saving state, reopening with the
saved choice, restoring automatic, save/list errors, and an unavailable saved model.

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

## 服务（`kind: "service"`）

FluidForm 本体用到的能力（聊天、计价）可以由能力包提供（docs/design/chat-and-pricing-packages.md）。

- `capability.json` 写 `kind: "service"`、`entry`（运行它的命令）和 `provides`：它提供哪种能力
  （现在有 `chat`、`pricing`，`service-names.ts`）。
- 任何包都可以写 `requires`：它需要哪些能力。启用时缺了就拒绝（"需要先启用聊天能力"）；
  被别的已启用的包需要的能力，它的提供者不能停用、卸载，也不能删掉密钥。同一种能力同时只能有一个包提供。
  某种能力还没有做成包之前，由 FluidForm 自己提供（`services.builtIn`）。
- 运行方式和自动化一样：能力包沙箱里的后台进程，挂了自动重启。它和 FluidForm 之间是 JSON-RPC 2.0，
  stdin/stdout 一行一条，两边都能发请求（和 MCP 一样）。FluidForm 问它（`ServiceHost.request`），它问 FluidForm
  （`ServiceHost.handle` 注册的方法）；要用密钥、要动这台机器的事都由 FluidForm 代办，它拿不到任何 key。
  通知 `status` 设置能力卡片上的状态文字；stderr 写进它的日志。进程停了，正在等它回答的请求立刻失败。
- 接口：`GET /api/capabilities/provided` 列出每种能力现在由谁提供（包的 id、`builtin` 或没有）；
  `/api/capabilities/runtime` 也带上服务的状态和这份列表。
- 测试：`server/tests/services.test.ts`。

### 随 FluidForm 提供的包

`server/packages/<id>` 里的包在第一次启动时装上并启用（`bundled.ts`），条件是允许能力包、这台机器有沙箱；
有新版本时更新（保持原来的启用状态）；用户卸载后不再装回（`<data_dir>/bundled.json` 记着提供过哪些）。
服务包可以用 Node 写：沙箱里能找到 FluidForm 自己用的 `node`（即使它装在被隐藏的主目录里）。现在有：计价（`pricing`）、聊天（`chat`）。聊天包第一次安装时把本体以前的 `<data_dir>/memory.json` 搬进它的数据目录（`bundled.CARRIED`）。

## 界面（`kind: "interface"`）

FluidForm 的核心是 API 服务和命令行（`fluidform`）：发起任务、自动在会员 CLI 和 API 模型之间选，
以及管理任务、模型、key、能力包。其他界面都是能力，网页控制台也是。

- `capability.json` 写 `kind: "interface"` 和 `site`（网页文件夹，默认 `site`，里面要有 `index.html`）。
  不运行任何进程，不需要沙箱、密钥和域名。
- 启用后 FluidForm 在 `/<id>/` 提供它（`interfaces.ts`）：找不到的路径给 `index.html`（页面自己用 `#` 路由），
  路径出不了网页文件夹。`/` 跳到网页控制台（`web`），没有就说明怎么用命令行。`api`、`health` 这些地址不能当 id。
- 页面从 FluidForm 自己的地址发写请求，这个来源总是允许（主机名已经检查过）。所以界面包能用 FluidForm 的全部接口：
  启用时要说清楚这一点。
- 网页控制台是 `server/packages/web`：`frontend` 的 `npm run package` 把页面构建进 `site/`（`./start.sh` 每次都构建），
  随 FluidForm 提供、默认启用；内容变了就重新安装（`bundled.ts` 按文件内容比较，不只看版本号）。
  停用或卸载后用 `fluidform capabilities enable web` 再启用。开发页面时照旧在 `frontend` 里 `npm run dev`。
