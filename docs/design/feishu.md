# 飞书机器人: Super Partner answers in Feishu

## 目标

Message the bot in Feishu (privately, or @ it in a group) and Super Partner answers there: a
question is answered in the conversation, as a chat; work that needs doing becomes a task, planned
and waiting for the owner to confirm in Super Partner, and its result is sent back to Feishu when it
ends. This is the first automation (docs/design/capabilities.md): something that keeps running
without anyone at the page.

## 改动

- **`feishu.py`** (new): the bot.
  - Its long connection uses Feishu's SDK (`lark-oapi`, an optional dependency:
    `pip install super-partner[feishu]`). It needs no public address. The SDK's client keeps its own
    event loop, so it runs in a thread of its own; a message is handed to the server's loop.
  - Which messages it answers (`wanted`):
    - text, privately, or in a group where it is @-mentioned (the mention is taken out);
    - each message once (Feishu may deliver one again);
    - only after the service started, never the backlog.
  - Its state is kept in `<data_dir>/feishu.json`: on or off, the daily budget, today's spend, the
    Super Partner chat that holds each Feishu conversation, and the ids seen lately. It survives a
    restart.
- **The App ID and App Secret** are kept in the OS keyring like the model keys
  (`secrets.SECRET_ENV`: `feishu_app_id`, `feishu_app_secret`), never in a file or the source.
- **Deciding** (`api.feishu_message`), by the same triage as 新建's 自动 (`triage.classify`):
  - **A chat:** the Feishu conversation's chat (one per Feishu chat, named 飞书 · …, listed with the
    others) answers. Its reply goes back as a reply to the message. Long replies are cut, with a note
    that the rest is in Super Partner.
  - **A task:** it is planned (`_new_task`) and waits for confirmation like any task. Feishu is told
    its name and estimate. `ExecutionRun.origin` remembers the Feishu message, and when the task
    ends (`Executor.end_listeners`, called with the end events) its result is sent there.
- **Spend:** what deciding and answering cost is counted per day. Past the daily budget it answers
  once that the day's budget is used up, then stays quiet until the next day. A task's own budget is
  the one confirmed for it, as always.
- **API:**
  - `GET /api/feishu`: whether it is available, installed and configured, on or off, its connection
    state and last error, today's spend and the budget.
  - `PUT /api/feishu`: on or off, and the budget.
  - `PUT` and `DELETE /api/feishu/credentials`: store or remove the App ID and Secret.
  - The bot starts with the service when on and configured, and stops with it.
- **Settings menu → 飞书机器人** (`frontend/feishu.tsx`): its state, App ID and Secret, the switch,
  the daily budget, and how to set the app up in Feishu's console (bot, long connection, the
  `im.message.receive_v1` event, permissions to read private and @ messages and to send as the bot).
- **`settings.feishu_bot`** (`SUPER_PARTNER_FEISHU_BOT`, off by default): without it the bot never
  starts and the panel says how to turn it on.

## 测试

`tests/test_feishu.py`. Feishu itself is replaced by a fake sender, the models by the fakes of
`test_chat.py`.

- Which messages are answered: private yes; group only when @-mentioned, with the mention removed;
  not text, no; once each.
- A question gets the chat's answer as a reply, and the same Feishu conversation goes on in the same
  chat.
- Work becomes a task waiting for confirmation, Feishu is told, and its result is sent when it ends.
- Past the budget: one notice, then quiet.
- The credentials go to the keyring, never into the state file.
- The API refuses to switch on without the setting or the credentials.
- Old records load (`origin` is empty).

`mission-actions.test.mjs`: the panel shows the state, saves the credentials and switches the bot.

## 风险

- **Messages come from people other than the owner.** The bot answers what they ask with the
  owner's models and money. That is why there is the daily budget, why a task always waits for the
  owner's confirmation, and why it is off unless switched on. A chat started from Feishu runs with
  no project folder, so it reads none of the owner's files.
- The SDK's connection may drop; the SDK reconnects by itself, and the panel shows the last error.
- A new dependency, optional: without it the panel says to install it, and nothing else changes.
