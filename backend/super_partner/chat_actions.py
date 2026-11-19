"""What a chat asks FluidForm to do, as tool calls instead of lines it writes (settings.chat_action_tools).

A chat model with tools (supervisor.chat_tools) gets StartTask, SendFile, CallEngineer, and with
settings.user_memory Remember and Forget. Each call is noted as the line the chat would have
written (TASK, SEND, ENGINEER, REMEMBER, FORGET) and added to the end of its
answer (Providers.converse), so one place reads them, whichever way they were asked for."""
from __future__ import annotations

import contextvars
import json
from typing import Optional

TOOLS = {
    "StartTask": {
        "name": "StartTask",
        "description": (
            "Has FluidForm plan and do bigger work as a task (a program, a document of several parts, "
            "long research), after your answer. The request is all the planner sees besides this "
            "conversation: write in it everything it depends on that was said or sent here (what, for "
            "whom, style, constraints, which pictures). Say in your answer what you are having planned. "
            "At most once per answer; never for what you can answer or do yourself."
        ),
        "parameters": {"type": "object", "properties": {
            "request": {"type": "string", "description": "The work, complete and self-contained"},
        }, "required": ["request"]},
    },
    "SendFile": {
        "name": "SendFile",
        "description": ("Sends the person a picture or a file you saved in your folder, with your answer. "
                        "At most 5 per answer; a picture as png or jpg."),
        "parameters": {"type": "object", "properties": {
            "name": {"type": "string", "description": "Its name in your folder, e.g. avatar.png"},
        }, "required": ["name"]},
    },
    "CallEngineer": {
        "name": "CallEngineer",
        "description": ("Brings FluidForm's platform engineer into this conversation, to repair FluidForm "
                        "itself or add a capability it lacks. Only when the person asks for it, or FluidForm "
                        "itself is at fault."),
        "parameters": {"type": "object", "properties": {
            "kind": {"type": "string", "enum": ["repair", "component"]},
            "request": {"type": "string", "description": "What to repair or add, why, and the evidence"},
        }, "required": ["kind", "request"]},
    },
    "Remember": {
        "name": "Remember",
        "description": ("Keeps a lasting fact or preference someone told you (how they like answers, their "
                        "role, what they work on), for later conversations here. Never a secret."),
        "parameters": {"type": "object", "properties": {
            "fact": {"type": "string", "description": "<who>: <the fact, one short sentence>"},
        }, "required": ["fact"]},
    },
    "Forget": {
        "name": "Forget",
        "description": "Drops a fact you kept that they corrected or asked you to forget.",
        "parameters": {"type": "object", "properties": {
            "words": {"type": "string", "description": "Words from that fact"},
        }, "required": ["words"]},
    },
}
# The calls of the answer being written, and which tools it has: set by Providers.converse.
pending: contextvars.ContextVar[Optional[tuple[list[str], frozenset]]] = contextvars.ContextVar(
    "chat_actions", default=None)
MAX_SENDS = 5


def offered() -> list[dict]:
    """The action tools for the answer being written, if any."""
    current = pending.get()
    return [TOOLS[name] for name in TOOLS if current and name in current[1]]


def run(name: str, args: dict) -> tuple[str, bool]:
    """Note one call as its line; it happens after the answer."""
    current = pending.get()
    if not current or name not in current[1]:
        return f"Error: {name} is not available here", False
    lines, _ = current
    text = (args.get("request") or "").strip() if isinstance(args.get("request"), str) else ""
    if name == "StartTask":
        if not text:
            return "Error: request is required", False
        if any(line.startswith("TASK:") for line in lines):
            return "Error: one task per answer; put everything in the first request", False
        lines.append("TASK: " + json.dumps({"request": text}, ensure_ascii=False))
        return "Noted: FluidForm plans it after your answer. Say in your answer what you are having planned.", True
    if name == "SendFile":
        file = args.get("name")
        if not isinstance(file, str) or not file.strip() or "\n" in file:
            return "Error: name is required", False
        if sum(line.startswith("SEND:") for line in lines) >= MAX_SENDS:
            return f"Error: at most {MAX_SENDS} files per answer", False
        lines.append(f"SEND: {file.strip()}")
        return "Noted: it is sent with your answer.", True
    if name in {"Remember", "Forget"}:
        value = args.get("fact" if name == "Remember" else "words")
        if not isinstance(value, str) or not value.strip() or "\n" in value.strip():
            return "Error: one line of text is required", False
        lines.append(f"{'REMEMBER' if name == 'Remember' else 'FORGET'}: {value.strip()}")
        return "Noted.", True
    if not text:
        return "Error: request is required", False
    kind = args.get("kind") if args.get("kind") in {"repair", "component"} else "repair"
    lines.append("ENGINEER: " + json.dumps({"kind": kind, "request": text}, ensure_ascii=False))
    return "Noted: the platform engineer joins this conversation after your answer.", True


def with_actions(text: str, lines: list[str]) -> str:
    """An answer with the lines its tool calls stand for at its end."""
    return "\n".join([text.rstrip(), *lines]) if lines else text
