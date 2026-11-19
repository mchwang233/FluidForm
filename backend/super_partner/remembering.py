"""What an automation's chat remembers about the people it talks with (settings.user_memory).

The chat writes a REMEMBER line for a lasting preference or fact someone tells it, a FORGET line
to drop one (or calls the Remember and Forget tools: chat_actions.py). FluidForm keeps them by
conversation, in the automation's state (api.automation_message), and tells them to every new chat
of that conversation, so a chat started afresh (another model, a day later) still knows them."""
from __future__ import annotations

import re

MAX_FACTS = 30
MAX_FACT_CHARS = 300
REMEMBER_LINE = re.compile(r"^\s*REMEMBER:\s*(.+?)\s*$", re.MULTILINE)
FORGET_LINE = re.compile(r"^\s*FORGET:\s*(.+?)\s*$", re.MULTILINE)
# Never kept, whatever the chat writes: what looks like a secret.
SECRET = re.compile(r"(password|passwd|secret|token|api[_ -]?key|密码|口令|密钥|sk-[A-Za-z0-9]{8,})", re.IGNORECASE)

GUIDE = (
    "Remembering: when someone tells you something lasting about themselves or how they want to be "
    "helped (how they like answers, their role, what they work on, names they use), or asks you to "
    "remember something, end your answer with one line per fact:\n"
    "REMEMBER: <who>: <the fact, one short sentence>\n"
    "and to drop one they correct or ask you to forget: FORGET: <words from that fact>. Not for what "
    "matters only now, and never a password, key or other secret. You are told what you remember "
    "when a conversation starts.\n\n"
)


def split(text: str) -> tuple[str, list[str], list[str]]:
    """An answer without its REMEMBER and FORGET lines, and what they say."""
    remembered = [fact.strip()[:MAX_FACT_CHARS] for fact in REMEMBER_LINE.findall(text or "")]
    forgotten = [words.strip() for words in FORGET_LINE.findall(text or "")]
    if not remembered and not forgotten:
        return text, [], []
    shown = FORGET_LINE.sub("", REMEMBER_LINE.sub("", text or "")).strip()
    return shown, [fact for fact in remembered if fact], [words for words in forgotten if words]


def apply(facts: list[str], remembered: list[str], forgotten: list[str]) -> list[str]:
    """The facts kept after an answer: forgotten ones dropped, new ones added (no secrets, no
    repeats), the oldest dropped past MAX_FACTS."""
    kept = [fact for fact in facts if not any(words.lower() in fact.lower() for words in forgotten)]
    for fact in remembered:
        if SECRET.search(fact) or fact in kept:
            continue
        kept.append(fact)
    return kept[-MAX_FACTS:]


def told(facts: list[str]) -> str:
    """What a new chat is told first, or "" when there is nothing."""
    if not facts:
        return ""
    return ("你记得的（这段对话里的人以前告诉你的，可能已过时）：\n" + "\n".join(f"- {fact}" for fact in facts) + "\n\n")
