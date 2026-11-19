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


QUICK_PROMPT = (
    "Is this request work that one capable model can do by itself in one go, in a few minutes, with "
    "a sandbox, the internet and an image tool, without anyone's project files: make one picture, "
    "write one short document, convert or calculate something, look something up and summarise it, or "
    "write one small program that stands on its own (a small game, a script, one web page)? "
    "Not quick: several deliverables, larger software to build or change, long research, anything needing "
    "the user's existing files, or anything unclear.\n"
    'Answer with only JSON: {{"quick": true or false, "title": "a short title in the request\'s language", '
    '"capability": "coding | research | chinese | tool_use | structured_output | planning", '
    '"needs_images": true or false, "acceptance": "how to tell it is done, one sentence"}}\n\nRequest:\n{text}'
)
# With settings.solo_tasks: also work one model can carry through by itself with tools, at length.
SHAPE_PROMPT = (
    "How should this request be done? It goes to models with a sandbox, the internet, an image tool{project}.\n"
    "- quick: one model in one go, a few minutes, without anyone's project files: one picture, one short "
    "document, a conversion or calculation, look something up and summarise it, or one small program that "
    "stands on its own (a small game such as snake, a script, a calculator, one web page).\n"
    "- solo: one capable model carrying it through by itself with its tools, step after step, in up to an "
    "hour: one coherent piece of work with one result that takes real work, such as fixing a bug, adding "
    "one feature, a program of several parts, or one report from research{in_project}.\n"
    "- plan: anything else: several separate deliverables, a system with several parts, work needing "
    "several kinds of expertise in turn, or anything unclear. When unsure, plan.\n"
    'Answer with only JSON: {{"shape": "quick | solo | plan", "title": "a short title in the request\'s language", '
    '"capability": "coding | research | chinese | tool_use | structured_output | planning", '
    '"needs_images": true or false, "acceptance": "how to tell it is done, one sentence"}}\n\nRequest:\n{text}'
)
QUICK_CAPABILITIES = {"coding", "research", "chinese", "tool_use", "structured_output", "planning"}


async def quick(text: str, providers, model: Optional[ModelProfile], solo: bool = False,
                project: bool = False) -> tuple[Optional[dict], float]:
    """Whether a task is quick (one step, no plan needed), and the step if so; what deciding cost.
    With ``solo``, also whether one model can carry it through alone (shape "solo"); a task in a
    ``project`` can only be that. Anything unclear, or going wrong, means it is planned as usual (None)."""
    if model is None or (project and not solo):
        return None, 0.0
    prompt = (SHAPE_PROMPT.format(text=text[:MAX_REQUEST_CHARS],
                                  project=" and the user's project folder" if project else "",
                                  in_project=" in the user's project" if project else "")
              if solo else QUICK_PROMPT.format(text=text[:MAX_REQUEST_CHARS]))
    try:
        result = await asyncio.wait_for(providers.complete(model.id, prompt, effort="low"), TIMEOUT_SECONDS)
    except Exception as exc:
        log.warning("judging whether a task is quick with %s failed: %s", model.id, exc)
        return None, 0.0
    cost = token_cost(model, result.input_tokens, result.output_tokens, result.cached_input_tokens)
    found = re.search(r"\{.*\}", result.text or "", re.DOTALL)
    try:
        step = json.loads(found.group(0)) if found else None
    except ValueError:
        step = None
    if not isinstance(step, dict):
        return None, cost
    shape = step.get("shape") if solo else ("quick" if step.get("quick") is True else None)
    if shape not in ({"solo"} if project else {"quick", "solo"}):
        return None, cost
    return {"shape": shape, "title": str(step.get("title") or text.splitlines()[0])[:80].strip() or "任务",
            "capability": step.get("capability") if step.get("capability") in QUICK_CAPABILITIES else "tool_use",
            "needs_images": step.get("needs_images") is True,
            "acceptance": str(step.get("acceptance") or "")[:500]}, cost


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
