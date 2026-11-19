"""What the lead's planning conversations share (task_planning.py, team.py): asking once more when
a reply is not the plan asked for, the plan's short name, and the limits on a plan."""
from __future__ import annotations

from collections.abc import Awaitable
from typing import Callable

from .planner import _extract_json

# Most tasks one plan has, with what replanning adds (replan.py, team.py).
MAX_TASKS = 60
# Said to the lead whenever it plans for a task that allows the internet (planner.WORK_RULES).
INTERNET_NOTE = "(This task allows the internet: its steps' commands may download packages and call external services.)"
# Commands a plan may name to check the task's tools before it runs (TaskPlan.requires).
MAX_REQUIRES = 12
MAX_REQUIRE_CHARS = 4000
# Characters of a plan's short name (TaskPlan.title); a longer one is cut here.
MAX_TITLE_CHARS = 24

# One message to the lead in its conversation, and its reply.
Say = Callable[[str], Awaitable[str]]


async def _ask(say: Say, message: str, read):
    """Ask, and once more in the same conversation if the reply is not what was asked for."""
    reply = await say(message)
    try:
        return read(_extract_json(reply))
    except (ValueError, TypeError, KeyError) as exc:
        reply = await say(f"That reply was not a valid plan ({exc}). Reply with the JSON object "
                          "described, and nothing else.")
        return read(_extract_json(reply))


def plan_title(payload: dict) -> str:
    """The plan's short name as the lead gave it, on one line and bounded; "" if none."""
    text = " ".join(str(payload.get("title") or "").split())
    return text.rstrip("。.!！?？")[:MAX_TITLE_CHARS]
