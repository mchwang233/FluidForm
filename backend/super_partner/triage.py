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
    "Classify a request a user typed into Super Partner, a tool that either chats with a model or "
    "plans and runs a task (models change files, build, test, write documents).\n"
    "task: it asks for work to be done or something to be produced: write, change, fix, build, "
    "implement, generate, refactor, migrate, deploy, test, or research and write up a deliverable.\n"
    "chat: it asks a question, an explanation, an opinion, advice or a comparison that is answered "
    "in a reply, with nothing to produce or change.\n"
    "If it is both or unclear, it is a task.\n"
    'Answer with only {"kind": "chat"} or {"kind": "task"}.\n\nRequest:\n'
)
KIND = re.compile(r'"kind"\s*:\s*"(chat|task)"')


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
