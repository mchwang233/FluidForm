# Capabilities: what a finished task leaves the platform able to do

## 目标

A task often builds something useful beyond itself: a client for a service, a converter, a
bot that answers messages. Skills and lessons (`learning.py`) keep *knowledge*; nothing kept the
*thing*. Capabilities do: once solidified, later tasks and chats can use it, and an automation
can keep running.

| Kind | Example | Used by |
|---|---|---|
| tool | send a Feishu message, read a Feishu doc | later steps, told how to run it |
| automation | auto-reply to Feishu messages, a morning digest | the runner (capability-packages.md) |

A capability is **working code and its manual**: the files the task built, and a `SKILL.md` beside
them in the skills' own format (用法, 说明, 代码, 检查, 需要). A skill alone (`skills/`) is only a manual.

## Flow

1. **Proposed when a task succeeds** (`settings.capability_proposals`, off by default): the task's
   lead is asked, in its own conversation, whether the task built something reusable, and
   answers with up to three capability cards (name, kind, summary, usage, files, check, secrets,
   domains). They are kept on the run (`ExecutionRun.capability_proposals`). A lead that says
   nothing, or cannot be asked, leaves none; the task's end is never held up.
2. **Solidified by the user, once** (结果页 → 固化): the card's files are copied from the task's
   folder into `<tools_dir>/capabilities/<id>/` with a `capability.json`, and its check runs in a
   step's sandbox (no network) in that folder. Passing makes it active; failing keeps it, marked
   failed with the output, so it can be fixed or removed. Tools act for the user, so the first
   use is a decision of the user's; after that no confirmation is asked.
3. **Listed on the platform engineer page** (平台工程师 → 能力): kind, status, what it does, how to
   run it, the task it came from; enable, disable, remove.
4. **Used**: every step and planner is told the active tools (name, summary, usage, folder),
   as it is told this machine's skills. `tools_dir` is readable in the steps' sandbox.

## Not in this step

- Running automations: done by capability packages (docs/design/capability-packages.md). A
  capability solidified from a task has no entry and does not run; made into a package and
  uploaded, it can.
- Secrets for tools that steps run: a tool names the variables it needs; steps are not given them.

## 风险

- A capability is code a model wrote. It is never run outside the steps' sandbox by the platform;
  its check runs there without network.
- Copying is bounded: only paths inside the task's folder, at most `MAX_CAPABILITY_BYTES`.
- Old records load: new fields have defaults; without the setting nothing changes.
