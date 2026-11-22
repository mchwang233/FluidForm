# Files in every box

## 目标

Only the 新建 box took files. Everywhere else you talk to FluidForm (a task's conversation
with its lead, an answer to the lead's question, the 平台 page, 需求变更, 转成任务, a reply to the
platform engineer), a screenshot or a log had to be described in words. Every box now takes files:
pasted, dropped, or picked with its paperclip.

## 改动

- **Frontend** (`attachments.tsx`): `takesFiles(files)` handles paste and drop on a box,
  `ClipButton` picks files, `AttachmentTray` shows them before sending, `SentFiles` under a sent
  message. Uploads are the existing `POST /api/attachments`; a box sends the ids with its message.
  A message may be files alone, except a new request to the platform engineer, which says what it is for.
- **A task's files** (`attachments.attach`): files sent to a task join `ExecutionRun.attachments`,
  so later steps and the planner see them as they see the files the task was started with, and
  deleting the task deletes them. At most `MAX_TASK_ATTACHMENTS` in all.
- **The lead** (`Executor.ask_lead`): the task's files it has not been given go with its next call,
  whatever prompted it (a message, an answer to its question, a decision). `lead_seen_attachments`
  records what it has had; a chat's first message is just the first such call.
- **The platform engineer**: `EngineerJob.attachments` gathers the request's and the replies' files;
  each call gives them to its model (`providers.complete(attachments=)`: a CLI gets their paths, an
  API model text inline and images as images).
- Messages keep their files (`LeadMessage`, `DiagnosisMessage`, `EngineerMessage.attachments`),
  shown under them.

## 测试

`test_chat.py`: a file sent later reaches the lead once and joins the task; old records are not
resent their files; an answer to the lead's question carries files. `test_engineer.py`: the
engineer's model gets the request's and the reply's files. `mission-actions.test.mjs`: paste and
drop in the task conversation and on the 平台 page send the files.

## 风险

- Old records load: every new field defaults to empty; `lead_seen_attachments` is `None` in
  them, meaning a lead that has already spoken had all the task's files.
- The files are the user's own, sent on purpose; nothing is sent that was not added to a box.
  Uploads are bounded as before (20 MB each, 10 per message).
- An API lead whose model cannot see images is told their names instead of being sent them.
