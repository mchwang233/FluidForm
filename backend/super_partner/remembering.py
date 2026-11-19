"""What chats remember about the people they talk with (settings.user_memory).

A chat writes a REMEMBER line for a lasting preference or fact someone tells it, a FORGET line to
drop one (or calls the Remember and Forget tools: chat_actions.py). FluidForm keeps them in
<data_dir>/memory.json, by where they were said: WEB for the owner's own chats on the web page,
"<capability>:<conversation>" for a conversation an automation brings (api.automation_message).
Every new chat there is told them, so a chat started afresh (another model, a day later) still
knows them; the owner sees and deletes them on the 记住的事 page (GET/DELETE /api/memory)."""
from __future__ import annotations

import json
import re
import threading
from pathlib import Path

from .config import settings

WEB = "web"
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


_lock = threading.Lock()


def _path() -> Path:
    return Path(settings.data_dir) / "memory.json"


def load() -> dict[str, list[str]]:
    """Every place's facts; a missing or broken file is nothing remembered."""
    try:
        data = json.loads(_path().read_text())
    except (OSError, ValueError):
        return {}
    return {str(key): [str(fact) for fact in facts if isinstance(fact, str)]
            for key, facts in data.items() if isinstance(facts, list)} if isinstance(data, dict) else {}


def _save(data: dict[str, list[str]]) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({key: facts for key, facts in data.items() if facts}, ensure_ascii=False, indent=1))
    temporary.replace(path)


def facts(key: str) -> list[str]:
    return load().get(key, [])


def update(key: str, remembered: list[str], forgotten: list[str]) -> list[str]:
    with _lock:
        data = load()
        data[key] = apply(data.get(key, []), remembered, forgotten)
        _save(data)
        return data[key]


def delete(key: str, fact: str) -> bool:
    """Drop one fact, as the owner asked on the page; whether it was there."""
    with _lock:
        data = load()
        if fact not in data.get(key, []):
            return False
        data[key] = [item for item in data[key] if item != fact]
        _save(data)
        return True


def adopt(key: str, old: list[str]) -> None:
    """Facts kept the earlier way (an automation's state), moved here once."""
    if old:
        with _lock:
            data = load()
            data[key] = apply(data.get(key, []), [fact for fact in old if isinstance(fact, str)], [])
            _save(data)


def take(key: str, text: str) -> str:
    """An answer without its REMEMBER and FORGET lines, which update what is kept at ``key`` when
    settings.user_memory is on (off, the lines are only taken out)."""
    shown, remembered, forgotten = split(text)
    if shown != text and settings.user_memory and (remembered or forgotten):
        update(key, remembered, forgotten)
    return shown


def automation_key(capability_id: str, conversation: str) -> str:
    return f"{capability_id}:{conversation}"
