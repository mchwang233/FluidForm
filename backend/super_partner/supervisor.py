"""The task's lead: the strong model that plans a task keeps one conversation with it until the
task ends, and is asked what to do as things happen (docs/design/supervisor.md).

Here: choosing the lead, starting and continuing its conversation, and handing the task over to
a new conversation when the old one is lost or its model runs out of quota."""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from typing import Optional

from . import folders
from .budget import ProviderError
from .cli_channels import SESSION_CLIS, SessionLost
from .config import settings
from .models import ExecutionRun, ModelProfile, NodeStatus, SupervisorSession
from .quota import ModelUnavailable

ROLE = (
    "You are the lead of a multi-model task in FluidForm. You plan it, and you stay with it "
    "until it ends: as its steps run on other models, you will be told what happened and asked "
    "what to do next. Keep the whole task in mind: its goal, the plan and why each step exists, "
    "and what has happened so far. You may read files and run read-only commands to look things "
    "up; do not edit anything, the steps' models do the work. Answer in the format each message "
    "asks for.\n\n"
)
CHAT_ROLE = (
    "You are talking with the user in FluidForm. This is a conversation, not a task: nothing is "
    "planned or run. Answer their questions directly and helpfully, in Chinese unless they write in "
    "another language. You may read files and run read-only commands to look things up; do not edit "
    "anything. If what they want needs real work done (files changed, programs built), say so: they "
    "can turn this conversation into a task.\n\n"
)
# Earlier messages a chat's new conversation is told about when its old one is lost.
MAX_CHAT_HANDOVER_CHARS = 20_000
# An API lead's conversation is sent whole every time; past this, older exchanges are dropped.
MAX_HISTORY_CHARS = 300_000
# Leads tried in turn for one message when a conversation is lost or a model is unavailable.
MAX_LEADS = 3
# Step results quoted in a hand-over.
MAX_RESULT_CHARS = 600


def candidates(models: list[ModelProfile], configured: set[str], exclude=()) -> list[ModelProfile]:
    """Possible leads, best first: membership CLIs that keep conversations (no extra cost, and they
    can look at the files), then API models; the best planners first."""
    eligible = [
        model for model in models
        if model.enabled and model.routing_ready and model.id in configured and model.id not in exclude
        and model.id not in settings.helper_only_models
        and model.provider != "mock" and (model.channel != "cli" or model.id in SESSION_CLIS)
    ]
    return sorted(eligible, key=lambda model: (
        model.channel != "cli", -model.scores.planning, -model.scores.reliability,
        (model.input_per_million or 0) + (model.output_per_million or 0),
    ))


def new_session(model: ModelProfile, previous: Optional[SupervisorSession] = None,
                folder: Optional[str] = None) -> SupervisorSession:
    """A fresh conversation for ``model``, in a folder of its own (a CLI conversation is tied to it),
    or in ``folder``: a chat's project, which it may read."""
    session = SupervisorSession(model_id=model.id, cwd=folder or str(folders.lead_folder(model.id)))
    if previous and previous.model_id:
        session.previous = [*previous.previous, previous.model_id]
    return session


def trim(session: SupervisorSession) -> None:
    """Keep an API lead's conversation within MAX_HISTORY_CHARS: the first exchange (its role and
    the plan) stays, the oldest after it go."""
    def size():
        return sum(len(item.get("content") or "") for item in session.history)

    dropped = 0
    while size() > MAX_HISTORY_CHARS and len(session.history) > 4:
        del session.history[2:4]
        dropped += 1
    if dropped and not session.history[2]["content"].startswith("[Earlier events"):
        session.history[2]["content"] = (f"[Earlier events of this task were left out to save space; "
                                         f"ask for details if you need them.]\n\n{session.history[2]['content']}")


def chat_transcript(run: ExecutionRun, limit: int = MAX_CHAT_HANDOVER_CHARS) -> str:
    """The finished messages of a chat, oldest first, as many of the latest as fit in ``limit``."""
    lines, size = [], 0
    for message in reversed([item for item in run.lead_messages if item.status == "done" and item.text]):
        line = f"{'用户' if message.role == 'user' else '助手'}：{message.text}"
        if size + len(line) > limit:
            break
        lines.append(line)
        size += len(line)
    return "\n\n".join(reversed(lines))


def identity(model: Optional[ModelProfile]) -> str:
    """Who a chat's model is, told to it: it cannot know itself, and guesses (a model trained on
    another's conversations takes itself for that one)."""
    if model is None:
        return ""
    way = "a membership CLI" if model.channel == "cli" else "its API"
    return (f"You are {model.display_name} ({model.id}, through {way}). If asked which model you are, "
            "say so; do not guess another.\n\n")


def chat_guide(run: ExecutionRun) -> str:
    """For a chat an automation brings messages to (a Feishu bot): how to talk there, from its
    package's CHAT.md, and whether it is a private chat or a group (``origin["chat_type"]``)."""
    origin = run.origin or {}
    if not origin.get("capability"):
        return ""
    from .capability_packages import chat_guide as package_guide

    guide = package_guide(str(origin["capability"]))
    where = {"p2p": "This is a private chat with one person.",
             "group": "This is a group chat: several people, who mostly talk among themselves."}.get(origin.get("chat_type"), "")
    return "".join(f"{part}\n\n" for part in (where, f"How to talk here:\n{guide}" if guide else "") if part) + AUTOMATION_WORK


# What a chat an automation brings messages to is told about work (automation_message reads it).
AUTOMATION_WORK = (
    "Work: when they want real work done (files changed, a program built, an image or a document "
    "made, research written up), FluidForm plans it as a task that waits for its owner's "
    "confirmation, then reports here how it went. When you know enough to describe it, end your "
    "answer with one line:\n"
    'TASK: {"request": "the work, complete and self-contained"}\n'
    "The request is all the planner sees besides this conversation: write in it everything it "
    "depends on that was said or sent here (what, for whom, style, constraints, which pictures). In "
    "your answer, say in a sentence what you are having planned. If it is unclear what they want, "
    "ask first and write no TASK line; never write one for what you can answer yourself.\n\n"
)
TASK_LINE = re.compile(r"^\s*TASK:\s*(\{.*\})\s*$", re.MULTILINE)
# Lines an answer ends with for FluidForm, not the person (TASK, ENGINEER): kept from what they see.
ACTION_LINE = re.compile(r"^\s*(TASK|ENGINEER|SEND):", re.MULTILINE)
# A file an automation chat's answer sends the person, one per line: its name in the chat's folder.
SEND_LINE = re.compile(r"^\s*SEND:\s*(.+?)\s*$", re.MULTILINE)


def split_sends(text: str) -> tuple[str, list[str]]:
    """An answer without its SEND lines, and the files they name."""
    names = [name.strip("`'\" ") for name in SEND_LINE.findall(text or "")]
    return (SEND_LINE.sub("", text or "").strip() if names else text), [name for name in names if name]


def split_task(text: str) -> tuple[str, Optional[str]]:
    """An automation chat's answer without its TASK line, and the work that line asks for."""
    found = TASK_LINE.search(text or "")
    if not found:
        # A TASK line that cannot be read asks for nothing, and is not shown either.
        return re.sub(r"^\s*TASK:.*$", "", text or "", flags=re.MULTILINE).strip() if "TASK:" in (text or "") else text, None
    try:
        request = json.loads(found.group(1)).get("request")
    except (json.JSONDecodeError, AttributeError):
        request = None
    request = request.strip() if isinstance(request, str) else ""
    return (text[:found.start()] + text[found.end():]).strip(), request or None


def for_person(text: str) -> str:
    """What of an answer being written the person sees: up to a line meant for FluidForm."""
    found = ACTION_LINE.search(text or "")
    return text[:found.start()].rstrip() if found else text


def chat_tools(run: ExecutionRun) -> Optional[dict]:
    """What a chat may use for quick jobs (settings.chat_tools): its own scratch folder, the
    internet if allowed, and its limits per message. None: only talk (the setting is off, or it
    is about a project, which a chat only reads)."""
    if run.kind != "chat" or not settings.chat_tools or run.project_dir:
        return None
    folder = Path(settings.workspace_root) / run.folder_id
    folder.mkdir(parents=True, exist_ok=True)
    return {"folder": folder, "network": settings.chat_tools_network, "turns": settings.chat_tool_turns,
            "seconds": settings.chat_tool_seconds}


def tool_skills(message: str) -> str:
    """The skills for the tools a message names, for a chat with tools, as a step gets them."""
    from . import skills

    found = skills.section(skills.for_step(message))
    return f"\n\n{found}" if found else ""


def chat_tools_note(run: ExecutionRun, model: Optional[ModelProfile]) -> str:
    """A chat with tools is told what they are for: quick jobs now, bigger work as a task."""
    tools = chat_tools(run) if model is not None and model.channel != "cli" else None
    if not tools:
        return ""
    from . import capabilities

    online = (" Its commands can reach the internet (not this machine's services)." if tools["network"]
              else " Its commands have no internet.")
    automation = bool((run.origin or {}).get("capability"))
    bigger = "ask for it with the TASK line below" if automation else "say so: they can turn this conversation into a task"
    send = (" To send them a picture or a file you made, save it in your folder and end your answer with "
            "one line per file, SEND: <its name in your folder> (at most 5; a picture as png or jpg)."
            if automation else "")
    built = capabilities.section()
    return ("Quick jobs you do yourself, right away, without asking: this overrides \"nothing is run\" "
            f"above. You have tools (Bash, Read, Write, Edit, Glob, Grep, LS) in this chat's own folder, "
            f"{tools['folder']}.{online} Use them for what takes a minute: look something up online (the "
            "weather: curl -s 'wttr.in/Beijing?format=3&lang=zh'; an exchange rate; a page they link), "
            "calculate, convert, read or make a small file. One message gets at most "
            f"{tools['turns']} tool calls and {tools['seconds']} seconds: keep it small, and answer with "
            "what you found. Anything bigger (a program, a document of several parts, the user's own "
            f"project, long research) is a task: {bigger}. Never say you looked something up when you "
            f"did not.{send}\n\n" + (f"{built}\n\n" if built else ""))


def chat_role(run: ExecutionRun, model: Optional[ModelProfile] = None) -> str:
    """What a chat's model is told first: its role, who it is, what it may do itself, and how to
    talk where it is."""
    return CHAT_ROLE + identity(model) + chat_tools_note(run, model) + chat_guide(run)


def chat_opening(run: ExecutionRun, text: str, model: Optional[ModelProfile] = None) -> str:
    """A message in a chat: its first one carries the role, who ``model`` (its own) is, how to talk
    there, and the folder it may read."""
    if run.supervisor and run.supervisor.calls:
        return text
    if run.supervisor and run.supervisor.previous:
        # A deliberate model change starts a fresh native/API session, as a lost session does.
        return chat_role(run, model) + handover(run, model.id if model else None) + text
    folder = f"The user's project folder, which you may read: {run.project_dir}\n\n" if run.project_dir else ""
    return chat_role(run, model) + folder + text


def handover(run: ExecutionRun, current: Optional[str] = None) -> str:
    """What a new lead needs to take over a running task: the request, the plan and where every
    step stands, and the latest problems."""
    if run.kind == "chat":
        earlier = chat_transcript(run)
        session = run.supervisor
        # The models of earlier sessions (the same model included, in a conversation of its own);
        # the session in ``run`` is either the new one (``current``) or the one before it.
        others = [item for item in dict.fromkeys([*(session.previous if session else []),
                                                  *([session.model_id] if session and session.model_id != current else [])]) if item]
        who = f" ({', '.join(others)})" if others else ""
        return (f"This conversation continues one the user had with another model{who}; the 助手 replies below "
                "are that model's, not yours, and what it said about itself is not about you. The messages so far:\n"
                f"{earlier or '（none）'}\n\n" + (f"Project folder you may read: {run.project_dir}\n\n" if run.project_dir else ""))
    lines = [
        "You are taking over as the lead of a task that is already under way.",
        f"Request:\n{run.prompt}",
        *([f"Background:\n{run.background}"] if run.background else []),
        f"Plan: {run.plan.summary}",
        f"Working directory: {run.project_dir or settings.workspace_root / run.folder_id}",
        "Steps:",
    ]
    if run.plan.employees:
        from .team import assignment_prompt
        lines.append(assignment_prompt(run.plan))
    for node in run.plan.nodes:
        deps = f" (after {', '.join(node.dependencies)})" if node.dependencies else ""
        lines.append(f"- [{node.id}] {node.title}{part_of(run, node)}{deps}: {node.status.value}, {len(node.attempts)} attempts, "
                     f"model {node.model_id}" + (f", employee {node.employee_id}, delegated by {node.delegation_parent_id}" if node.employee_id else ""))
        if node.status == NodeStatus.SUCCEEDED and (node.summary or node.result):
            lines.append(f"  result: {(node.summary or node.result)[:MAX_RESULT_CHARS]}")
        elif node.attempts and node.attempts[-1].outcome != "passed":
            lines.append(f"  last attempt: {node.attempts[-1].outcome}: {(node.attempts[-1].reason or '')[:MAX_RESULT_CHARS]}")
        if node.unable_reason:
            lines.append(f"  cannot be done here: {node.unable_reason[:MAX_RESULT_CHARS]}")
    if run.error:
        lines.append(f"Current problem: {run.error}")
    return "\n".join(lines) + "\n\n"


def chat_folder(run: ExecutionRun) -> Optional[str]:
    """Where a chat's conversation runs: its project, read-only; tasks' leads get folders of their own."""
    return run.project_dir if run.kind == "chat" else None


def role(run: ExecutionRun, model: Optional[ModelProfile] = None) -> str:
    return chat_role(run, model) if run.kind == "chat" else ROLE


async def converse(providers, session: SupervisorSession, prompt: str, charged, attachments=(),
                   tools: Optional[dict] = None) -> tuple[str, SupervisorSession]:
    """Send ``prompt`` to ``session``'s lead through ``charged(model_id, call)``, which bills the
    call to the task. Returns the reply and the session, now continued. ``tools``: a chat's quick
    jobs (chat_tools)."""
    extra = {"attachments": list(attachments)} if attachments else {}
    if tools:
        extra["tools"] = tools
    result = await charged(session.model_id, lambda budget: providers.converse(session, prompt, spend_ok=budget, **extra))
    if session.history:
        trim(session)
    return result.text, session


async def ask(providers, models: list[ModelProfile], configured: set[str], run: ExecutionRun,
              prompt: str, charged, attachments=()) -> tuple[str, SupervisorSession]:
    """Ask the task's lead; a lost conversation or an unavailable model hands the task over to
    the next best lead, which is briefed first."""
    session = run.supervisor if run.supervisor and run.supervisor.model_id else None
    message = prompt
    tried: set[str] = set()
    by_id = {model.id: model for model in models}
    last_error: Optional[Exception] = None
    for _ in range(MAX_LEADS):
        if session is None:
            pick = next(iter(candidates(models, configured, tried)), None)
            if pick is None:
                break
            session = new_session(pick, run.supervisor, chat_folder(run))
            message = role(run, pick) + handover(run, pick.id) + prompt
        try:
            model = by_id.get(session.model_id)
            tools = chat_tools(run) if model is not None and model.channel != "cli" else None
            return await converse(providers, session, message + (tool_skills(message) if tools else ""), charged,
                                  attachments, tools)
        except SessionLost as exc:
            # The model is fine; only its conversation is gone. Brief a new one.
            last_error = exc
            model = by_id.get(session.model_id)
            session = new_session(model, session, chat_folder(run)) if model else None
            message = role(run, model) + handover(run, model.id if model else None) + prompt
        except (ModelUnavailable, ProviderError, asyncio.TimeoutError) as exc:
            last_error = exc
            tried.add(session.model_id)
            session = None
    raise ProviderError(f"没有可用的负责人模型：{last_error or '没有可用的模型'}")


# --- deciding what to do after a failed attempt -------------------------------------------------

ACTIONS = ("retry", "switch_model", "accept", "unable", "ask_user", "repair_environment", "repair_platform",
           "request_component", "rework", "replan", "done")
# What the lead may answer when every step has finished.
FINAL_ACTIONS = ("done", "rework", "replan")
ACTION_RULES = {
    "rework": "- rework: send the steps listed in targets back to be redone, with instructions "
              "saying exactly what to change. Only for real problems the task needs fixed; not for new "
              "requirements the task never asked for, and not when the verification itself is wrong.\n",
    "retry": "- retry: the same model again. Only if the next attempt will do something materially different.\n",
    "switch_model": "- switch_model: another model from the list takes the step (a model that keeps failing "
                    "it, or one too weak for it).\n",
    "accept": "- accept: the result is good enough for the task's goal although its check failed (the check "
              "was wrong, or asked for more than the task needs); say why.\n",
    "unable": "- unable: the step's goal cannot be reached in this environment and no repair can change that "
              "(hardware, an account, a licence or credentials the task does not have). The rest of the "
              "task goes on without it.\n",
    "ask_user": "- ask_user: only the user can decide or provide something (a choice, credentials, budget, "
                "permission). The task pauses until they answer.\n",
    "repair_environment": "- repair_environment: something outside the task blocks it (missing software, sandbox "
                          "or machine limits, configuration). A repair session with access to this machine "
                          "fixes it, then the step runs again.\n",
    "repair_platform": "- repair_platform: FluidForm itself (its scheduler, tools or sandbox) is at fault; say "
                       "what and where. Its platform engineer (平台工程师) makes a source repair, checked and "
                       "applied, then the task continues.\n",
    "request_component": "- request_component: the task needs a capability FluidForm does not have (a tool for "
                         "the steps, a model channel, a kind of step or check) and no repair of a defect would "
                         "give it. Say in instructions what to add and why. FluidForm's platform engineer "
                         "(平台工程师) plans it, the user approves, and it is built, checked and applied; the task waits, "
                         "then you decide again.\n",
    "replan": "- replan: change the plan in \"plan\": add steps, remove steps that have not finished, or rewrite "
              "the instructions of steps that have not finished (splitting a step that is too big, adding a "
              "missing prerequisite, dropping one the task does not need). Finished steps stay as they are.\n",
    "done": "- done: the result does what the request asked; the task ends.\n",
}
PLAN_FORMAT = (
    '"plan": {"add": [{"key": "new1", "title": "...", "instructions": "...", "acceptance_criteria": "...", '
    '"capability": "coding | planning | research | chinese | tool_use | structured_output", '
    '"difficulty": "easy | normal | hard", "dependencies": ["ids of existing steps or keys of added ones"], '
    '"verifies": ["optional: ids or keys of steps this one verifies"], '
    '"files": ["files it creates or changes, at most 5"], "reads": ["files it reads for reference"], '
    '"provides": "what later steps can rely on", "check": "a command that shows it works", '
    '"part": "optional: id of the plan part it belongs to; by default the part of the step decided on"}], '
    '"remove": ["ids of steps that have not finished"], '
    '"update": [{"id": "...", "title": "optional", "instructions": "optional", "acceptance_criteria": "optional", '
    '"dependencies": ["optional: the full new list"], "files": ["optional: the full new list"], '
    '"reads": ["optional"], "provides": "optional", "check": "optional"}]}'
)


def decision_format(rework: bool = False, final: bool = False) -> str:
    """How to answer; a failed verification may also send steps back (``rework``), and when
    every step has finished (``final``) the lead says whether the task is done."""
    actions = list(FINAL_ACTIONS) if final else [
        action for action in ACTIONS if action != "done" and (rework or action != "rework")]
    return (
        "Reply with only a JSON object:\n"
        f'{{"action": "{" | ".join(actions)}", '
        '"reason": "one or two sentences in Chinese, shown to the user", '
        '"instructions": "for retry / switch_model / rework: exactly what must be done differently; '
        'for repair_*: what to repair; for request_component: what to add and why", "model_id": "switch_model only: one of the models listed", '
        + ('"targets": ["rework only: ids of the steps to redo"], ' if rework or final else "")
        + (PLAN_FORMAT + ", " if "replan" in actions else "")
        + '"question": "ask_user only, in Chinese", "options": ["ask_user only: up to 4 answers"], '
        '"user_action": "unable only: what the user could do to make it possible", '
        '"engineer": {"kind": "repair | component", "request": "optional, with any action: a fault in Super '
        'Partner itself, or a capability it lacks, that you found and this decision does not deal with; the '
        'platform engineer (平台工程师) joins the task\'s conversation and works on it in the background"}}\n'
        + "".join(ACTION_RULES[action] for action in actions)
    )


DECISION_FORMAT = decision_format()
MAX_EVIDENCE_CHARS = 1500


def part_of(run: ExecutionRun, node) -> str:
    """Where a step sits in a plan made in parts: " in [id] Part › Sub-part"."""
    path = run.plan.part_path(node.part_id)
    return f" in [{path[-1].id}] {' › '.join(part.title for part in path)}" if path else ""


def _steps(run: ExecutionRun) -> list[str]:
    return [f"- [{node.id}] {node.title}{part_of(run, node)}: {node.status.value}" for node in run.plan.nodes]


def _models(choices: list[ModelProfile], node) -> list[str]:
    return [f"- {model.id} ({model.channel}, {node.capability} {model.scores.score_for(node.capability):g}, "
            f"reliability {model.scores.reliability:g})" for model in choices]


BLOCKED_NOTE = (
    "This step stopped as BLOCKED: something it needs is missing or a target it must meet was not "
    "reached (see why above). Decide what unblocks it: rework the steps it builds on (targets) with "
    "instructions saying exactly what to add or fix, which redoes them and then this step; "
    "repair_environment or repair_platform when the machine or FluidForm is at fault; retry when "
    "something has changed; accept when what it delivered is enough for the request; ask_user when "
    "only the user can decide (for example whether a target can be relaxed); unable to stop.")


def failure_message(run: ExecutionRun, node, attempt, verdict, choices: list[ModelProfile],
                    left: tuple[int, int], upstream: Optional[set[str]] = None) -> str:
    """Tell the lead an attempt of ``node`` failed, with the evidence, and ask what to do;
    ``upstream``: the finished steps it builds on, which rework may send back."""
    from .diagnosis import NETWORK_CHOICE, _tool_summary

    earlier = [f"- {item.model_id}: {item.outcome}: {(item.reason or '')[:200]}" for item in node.attempts[:-1][-6:]]
    lines = [
        f"EVENT: an attempt failed. Step [{node.id}] {node.title} ({node.capability}, {node.difficulty}).",
        f"Attempt {len(node.attempts)} by {attempt.model_id}: {attempt.outcome}.",
        f"Why it was not accepted: {verdict.reason}",
        *([f"What the check says to change: {verdict.fix}"] if verdict.fix and verdict.fix != verdict.reason else []),
        *([f"Its answer (start):\n{node.result[:MAX_EVIDENCE_CHARS]}"] if node.result else []),
        *([_tool_summary(attempt, True)] if attempt.tool_calls else []),
        f"Files this step has changed: {', '.join(node.changed_files[:30]) or '(none)'}",
        *(["Earlier attempts of this step:", *earlier] if earlier else []),
        "Where the steps stand:", *_steps(run),
        "Models that can take this step:", *_models(choices, node),
        *([f"Steps it builds on, which rework may send back: {', '.join(sorted(upstream))}"] if upstream else []),
        f"Decisions left: {left[0]} for this step, {left[1]} for the task; after that the task pauses for the user.",
        ("This task allows the internet." if run.allow_network else
         "This task does not allow the internet. If the step itself must reach it while it runs, "
         f'ask_user with "{NETWORK_CHOICE}" among the options; choosing it allows the internet at once.'),
        "",
        ("Decide what to do with this step. You may look at the files in the working directory "
         f"({run.project_dir or settings.workspace_root / run.folder_id}) first."),
        decision_format(rework=bool(upstream)),
    ]
    return "\n".join(lines)


def limit_note(node, granted: dict) -> str:
    """Added to a failure at a contract step's declared limit: what deciding to go on grants."""
    contract = node.artifact_contract
    outputs = ", ".join(item.path for item in contract.outputs)
    return (f"This step stopped at its declared limit ({contract.max_turns} tool calls, "
            f"${contract.max_cost_usd:g}); it has used {max(node.contract_turns, node.contract_tool_calls)} calls "
            f"and ${node.contract_cost_usd:.4f}. Its declared outputs: {outputs}. Deciding retry, "
            f"switch_model or replan grants it more: up to {granted['max_turns']} tool calls and "
            f"${granted['max_cost_usd']:g} in all, keeping what it has written. Say in instructions what "
            "it must finish first. To make the work smaller, replan into smaller steps; to stop, "
            "decide unable.")


def verification_message(run: ExecutionRun, verifier, verdict, choices: list[ModelProfile],
                         left: tuple[int, int]) -> str:
    """Tell the lead a verification failed, with what it found and what it checked, and ask
    whether to send work back."""
    verified = [node for node in run.plan.nodes if node.id in verifier.verifies]
    lines = [
        f"EVENT: a verification failed. Step [{verifier.id}] {verifier.title} checks "
        + ", ".join(f"[{node.id}] {node.title}" for node in verified) + ".",
        f"What it found: {verdict.reason}",
        *([f"What it says to change: {verdict.fix}"] if verdict.fix and verdict.fix != verdict.reason else []),
        f"Its report (start):\n{(verifier.result or '')[:MAX_EVIDENCE_CHARS]}",
        f"Work sent back so far in this task: {run.rework_rounds} times.",
        "The steps it checks:",
    ]
    for node in verified:
        lines.append(f"- [{node.id}] {node.title}, by {node.model_id}, {len(node.attempts)} attempts; "
                     f"review: {(node.review or '')[:300]}")
        lines.append(f"  result: {(node.summary or node.result or '')[:800]}")
    lines += [
        "Where the steps stand:", *_steps(run),
        "Models that can run the verification:", *_models(choices, verifier),
        f"Decisions left: {left[0]} for this step, {left[1]} for the task; after that the task pauses for the user.",
        "",
        ("Judge the findings first: are they real problems the task needs fixed, new requirements it "
         "never asked for, or mistakes of the verification itself? Then decide."),
        decision_format(rework=True),
    ]
    return "\n".join(lines)


def final_message(run: ExecutionRun, left: int) -> str:
    """Every step has finished: the lead checks the result as a whole against the request."""
    lines = [
        ("EVENT: every step has finished. Before the task ends, check the result as a whole against "
         "the request: does it really do what was asked, and do the pieces fit together?"),
        f"Request:\n{run.prompt}",
        f"Working directory: {run.project_dir or settings.workspace_root / run.folder_id}",
        "The steps and their results:",
    ]
    for node in run.plan.nodes:
        lines.append(f"- [{node.id}] {node.title} (by {node.model_id}): {(node.review or '')[:200]}")
        lines.append(f"  result: {(node.summary or node.result or '')[:800]}")
    lines += [
        f"Decisions left for the task: {left}.",
        "",
        ("You may look at the files first. If something the request asked for is missing or wrong, "
         "rework the steps that should fix it, or replan to add what is missing."),
        decision_format(final=True),
    ]
    return "\n".join(lines)


def overrun_message(node, turns: int, expected: int, evidence: str) -> str:
    """A work package taking far more turns than planned: going on, or stopped (and then split)."""
    return "\n".join([
        (f"EVENT: work package [{node.id}] {node.title} was planned for about {expected} tool turns and has "
         f"taken {turns}."),
        f"Its files: {', '.join(node.files) or '-'}; reads: {', '.join(node.reads) or '-'}",
        f"What it has been doing:\n{evidence}",
        ("Is it still doing its own package and close to done, or is the package too big, under-specified, "
         "or going wrong? Stopped, the attempt fails and you then decide what to do (for a package too "
         "big: replan to split it). End with exactly one line: `VERDICT: CONTINUE` or "
         "`VERDICT: STOP: <why, in Chinese>`."),
    ])


def critical_overrun_message(node, model_id: str, minutes: float, expected: float, waiting: list[str],
                             evidence: str) -> str:
    """A step the rest of the task waits for, running far past its expected time on its model."""
    return "\n".join([
        (f"EVENT: step [{node.id}] {node.title} has run {minutes:.0f} minutes on {model_id}; about "
         f"{expected:.0f} were expected. It is not stuck, but {len(waiting)} steps wait for it: "
         + "; ".join(waiting[:8]) + "."),
        f"What it has been doing:\n{evidence}",
        ("Should it go on, or stop so that you can give it to a faster model (switch_model) or split it? "
         "Its files stay in the working directory for the next attempt. Stop it only if it is slow or "
         "off track, not when it is about to finish. End with exactly one line: `VERDICT: CONTINUE` or "
         "`VERDICT: STOP: <why, in Chinese>`."),
    ])


def chat_message(text: str) -> str:
    """The user writing to the lead directly, not answering one of its questions."""
    return (
        "MESSAGE from the user (they can see the task, its steps and your decisions):\n"
        f"{text}\n\n"
        "Answer in Chinese, in a few sentences, as yourself: the lead who has followed this task. "
        "No decision JSON is needed here. If they ask for a change (to a step, the plan, or how you "
        "decide), say what you will do; you will act on it at your next decisions.\n"
        "The platform engineer (平台工程师) changes FluidForm itself: its sandbox, tools, scheduler or "
        "model channels. If the user asks for it, or you find that FluidForm itself is at fault or lacks "
        "a capability the task needs, bring it into this conversation now, not at a later decision: end your "
        "answer with one line\n"
        'ENGINEER: {"kind": "repair or component", "request": "what to repair or add, why, and the evidence"}\n'
        "A repair is applied once it passes its checks; a component waits for the user's approval. Its plan, "
        "questions and progress appear in this conversation."
    )


ENGINEER_LINE = re.compile(r"^\s*ENGINEER:\s*(\{.*\})\s*$", re.MULTILINE)


def read_engineer(value) -> Optional[dict]:
    """A call for the platform engineer ({"kind", "request"}), or None if it is not one."""
    if not isinstance(value, dict) or not str(value.get("request") or "").strip():
        return None
    kind = str(value.get("kind") or "repair").strip()
    return {"kind": kind if kind in {"repair", "component"} else "repair", "request": str(value["request"]).strip()[:6000]}


def split_engineer(text: str) -> tuple[str, Optional[dict]]:
    """A chat answer without its ENGINEER line, and the call that line makes."""
    found = ENGINEER_LINE.search(text or "")
    if not found:
        return text, None
    try:
        call = read_engineer(json.loads(found.group(1)))
    except json.JSONDecodeError:
        call = None
    return (text[:found.start()] + text[found.end():]).strip(), call


ENGINEER_STATES = {
    "queued": "queued", "planning": "writing its plan", "plan_ready": "plan written, waiting for the user's approval",
    "needs_input": "waiting for the user's answer", "editing": "making the change in a copy",
    "validating": "checking the change", "ready": "change checked, waiting for the user to apply it",
    "applying": "being applied (FluidForm restarts)", "applied": "applied", "failed": "failed",
    "rejected": "given up by the user", "cancelled": "cancelled",
}


def engineer_updates(jobs) -> str:
    """What changed in the platform engineer's work for this task since the lead last heard."""
    lines = ["UPDATE from the platform engineer (平台工程师) on its work for this task:"]
    for job in jobs:
        lines.append(f"- [{job.id}] {job.kind} \"{job.title}\": {ENGINEER_STATES.get(job.status, job.status)}")
        if job.status in {"applied", "failed"} and (job.report or job.error):
            lines.append(f"  {(job.error or job.report)[:600]}")
    return "\n".join(lines) + "\n\n"


MAX_REPAIR_REPORT = 3000


def repair_message(run: ExecutionRun, node, diagnosis, choices: list[ModelProfile], left: tuple[int, int]) -> str:
    """The repair the lead asked for has ended: hand it its outcome before the step runs again."""
    outcome = (f"It ended with status {diagnosis.verdict or 'none'}." if diagnosis.status == "done"
               else f"It did not finish: {diagnosis.error or 'no reason given'}.")
    return "\n".join([
        f"EVENT: the repair you asked for step [{node.id}] {node.title} has ended. {outcome}",
        f"Its report:\n{(diagnosis.report or '(none)')[:MAX_REPAIR_REPORT]}",
        "Where the steps stand:", *_steps(run),
        "Models that can take this step:", *_models(choices, node),
        f"Decisions left: {left[0]} for this step, {left[1]} for the task; after that the task pauses for the user.",
        "",
        ("Decide what to do with the step now. Run it again only if the report shows the obstacle was "
         "removed and checked (for example a login or command that now works); if the repair did not "
         "do that, do not send the step back to meet the same obstacle: repair again differently, ask "
         "the user, or mark it unable."),
        DECISION_FORMAT,
    ])


ENGINEER_OUTCOMES = {
    "applied": "It was built, checked and applied: FluidForm now has it.",
    "failed": "It could not be built or applied.",
    "rejected": "The user gave it up: it will not be added.",
    "cancelled": "It was cancelled.",
}


def engineer_message(run: ExecutionRun, node, job, choices: list[ModelProfile], left: tuple[int, int]) -> str:
    """The component the lead asked the platform engineer for is done with: its outcome."""
    talk = [f"- {item.role}: {item.text[:400]}" for item in job.messages[-6:] if item.role in {"user", "engineer"}]
    return "\n".join([
        f"EVENT: the component you asked for, for step [{node.id}] {node.title}, is done with. "
        + ENGINEER_OUTCOMES.get(job.status, f"It ended as {job.status}."),
        f"What you asked for: {job.request[:800]}",
        *([f"The plan:\n{job.plan[:MAX_REPAIR_REPORT]}"] if job.plan else []),
        *([f"Its report:\n{job.report[:MAX_REPAIR_REPORT]}"] if job.report else []),
        *([f"Why it failed: {job.error[:800]}"] if job.error else []),
        *([f"Changed files: {', '.join(job.files[:30])}"] if job.files else []),
        *(["What the user and the engineer said:", *talk] if talk else []),
        "Where the steps stand:", *_steps(run),
        "Models that can take this step:", *_models(choices, node),
        f"Decisions left: {left[0]} for this step, {left[1]} for the task; after that the task pauses for the user.",
        "",
        "Decide what to do with the step now. Without the component, do not send the step back to the same wall.",
        DECISION_FORMAT,
    ])


def answer_message(node, question: str, answer: str, rework: bool = False) -> str:
    """Hand the user's answer to the lead's question back to it."""
    return "\n".join([
        f"EVENT: the user answered your question about step [{node.id}] {node.title}.",
        f"Your question: {question}",
        f"Their answer: {answer}",
        "",
        "Decide what to do with this step now.",
        decision_format(rework),
    ])


def parse_decision(text: str, model_ids: set[str], targets: Optional[set[str]] = None,
                   final: bool = False) -> Optional[dict]:
    """The decision in the lead's reply, or None if there is no valid one. ``targets`` are the
    steps rework may send back; without them, rework is not a valid answer. ``final``: every step
    has finished, and only done, rework and replan are."""
    start, end = (text or "").find("{"), (text or "").rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        payload = json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return None
    allowed = FINAL_ACTIONS if final else tuple(action for action in ACTIONS if action != "done")
    if not isinstance(payload, dict) or payload.get("action") not in allowed:
        return None
    clean = {key: str(payload[key]).strip() for key in ("action", "reason", "instructions", "model_id",
                                                         "question", "user_action") if payload.get(key)}
    options = payload.get("options")
    clean["options"] = [str(item).strip()[:300] for item in options if str(item).strip()][:4] if isinstance(options, list) else []
    if clean["action"] == "switch_model" and clean.get("model_id") not in model_ids:
        return None
    if clean["action"] == "ask_user" and not clean.get("question"):
        return None
    if clean["action"] == "request_component" and not (clean.get("instructions") or clean.get("reason")):
        return None
    if call := read_engineer(payload.get("engineer")):
        clean["engineer"] = call
    if clean["action"] == "rework":
        chosen = payload.get("targets") or sorted(targets or ())
        if not targets or not isinstance(chosen, list) or not set(map(str, chosen)) <= targets:
            return None
        clean["targets"] = [str(item) for item in chosen]
    if clean["action"] == "replan":
        plan = payload.get("plan")
        if not isinstance(plan, dict) or not any(plan.get(key) for key in ("add", "remove", "update")):
            return None
        clean["plan"] = plan
    return clean
