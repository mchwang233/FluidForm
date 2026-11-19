"""Telling a conversation from a task, when the user leaves it to Super Partner (api.start).

One short call to the cheapest API model (routing.brief_writer's choice). Anything that goes
wrong, or no such model, means a task: what Super Partner did before chats existed. Either way
the user can switch: a chat turns into a task (api.promote_chat), a task waiting for
confirmation into a chat (api.task_to_chat)."""
from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Optional

from .budget import token_cost
from .models import ModelProfile

log = logging.getLogger(__name__)

# The answer is a few tokens; a slow model is not worth waiting for.
TIMEOUT_SECONDS = 20
# Characters of the request the model is shown.
MAX_REQUEST_CHARS = 4000

PROMPT = (
    "Classify a request a user typed into FluidForm, a tool that either chats with a model or "
    "plans and runs a task (models change files, build, test, write documents).\n"
    "task: it asks for work to be done or something to be produced: write, change, fix, build, "
    "implement, generate, refactor, migrate, deploy, test, or research and write up a deliverable.\n"
    "chat: it asks a question, an explanation, an opinion, advice or a comparison that is answered "
    "in a reply, with nothing to produce or change.\n"
    "If it is both or unclear, it is a task.\n"
    'Answer with only {"kind": "chat"} or {"kind": "task"}.\n\nRequest:\n'
)
KIND = re.compile(r'"kind"\s*:\s*"(chat|task)"')


ADDRESSED_PROMPT = (
    "You are {name}, an assistant in a group chat. Its members mostly talk among themselves; you "
    "answer only a message meant for you: it asks you (by name or by what you do) a question or for "
    "help, follows up on your last answer, or asks the group something an assistant is expected to "
    "answer. Members talking to each other, small talk, thanks, announcements: not for you. When "
    "unsure, it is not for you.\n"
    'Answer with only {{"reply": true}} or {{"reply": false}}.\n\nRecent messages:\n{context}\n\nNew message:\n{text}'
)
REPLY = re.compile(r'"reply"\s*:\s*(true|false)')


async def addressed(text: str, context: str, name: str, providers, model: Optional[ModelProfile]) -> tuple[bool, float]:
    """Whether a group message nobody @-mentioned the assistant in is meant for it, and what deciding
    cost. Anything that goes wrong, or no model, keeps it quiet."""
    if model is None:
        return False, 0.0
    prompt = ADDRESSED_PROMPT.format(name=name, context=context[-MAX_REQUEST_CHARS:] or "（none）",
                                     text=text[:MAX_REQUEST_CHARS])
    try:
        result = await asyncio.wait_for(providers.complete(model.id, prompt, effort="low"), TIMEOUT_SECONDS)
    except Exception as exc:
        log.warning("deciding whether to answer with %s failed: %s", model.id, exc)
        return False, 0.0
    cost = token_cost(model, result.input_tokens, result.output_tokens, result.cached_input_tokens)
    match = REPLY.search(result.text or "")
    return bool(match and match.group(1) == "true"), cost


def read_kind(text: str) -> str:
    """"chat" only when the answer clearly says so."""
    match = KIND.search(text or "")
    if match:
        return match.group(1)
    try:
        value = json.loads(text)
    except (TypeError, ValueError):
        return "task"
    return "chat" if isinstance(value, dict) and value.get("kind") == "chat" else "task"


async def classify(text: str, providers, model: Optional[ModelProfile]) -> tuple[str, float]:
    """("chat" | "task", what deciding cost)."""
    if model is None:
        return "task", 0.0
    try:
        result = await asyncio.wait_for(
            providers.complete(model.id, PROMPT + text[:MAX_REQUEST_CHARS], effort="low"), TIMEOUT_SECONDS)
    except Exception as exc:  # any failure leaves the request a task, as before
        log.warning("triage with %s failed: %s", model.id, exc)
        return "task", 0.0
    cost = token_cost(model, result.input_tokens, result.output_tokens, result.cached_input_tokens)
    return read_kind(result.text), cost
