"""The Feishu bot (docs/design/feishu.md): Super Partner answers private and @ messages in Feishu.

What a message becomes (a chat's answer, or a task waiting for confirmation) is decided by the
API (``api.feishu_message``); this module receives the messages, keeps the bot's state and budget,
and sends the replies. Feishu's SDK (``lark-oapi``, optional) holds a long connection, so no public
address is needed; its client keeps its own event loop, so it runs in a thread of its own and hands
each message to the service's loop.

The App ID and Secret are kept in the keyring (``secrets.get_secret``), never in the state file or
the environment.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
import time
from collections.abc import Awaitable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

from . import secrets
from .config import settings

log = logging.getLogger(__name__)

APP_ID, APP_SECRET = "feishu_app_id", "feishu_app_secret"
# Message ids remembered so one delivered twice is answered once.
SEEN_KEEP = 500
# A reply longer than this is cut, with a note that the rest is in Super Partner.
MAX_REPLY_CHARS = 3500
# Messages sent this long before the bot started are the backlog: not answered.
BACKLOG_SECONDS = 60
# How a mention appears in a message's text.
MENTION = re.compile(r"@_user_\d+\s*")
CUT_NOTE = "\n\n……（太长了，完整内容在搭子里）"


@dataclass
class Message:
    """A message the bot is to answer."""
    message_id: str
    chat_id: str
    chat_type: str  # p2p | group
    text: str
    sender: str = ""


def installed() -> bool:
    try:
        import lark_oapi  # noqa: F401
    except ImportError:
        return False
    return True


def configured() -> bool:
    return bool(secrets.get_secret(APP_ID) and secrets.get_secret(APP_SECRET))


def wanted(message_type: str, chat_type: str, content: str, mentions: list[str], create_time_ms: int,
           started_at: float) -> Optional[str]:
    """The text to answer, or None: only text, privately or when @-mentioned in a group, and not
    the backlog from before the bot started."""
    if message_type != "text" or chat_type not in {"p2p", "group"}:
        return None
    if chat_type == "group" and not mentions:
        return None
    if create_time_ms and create_time_ms / 1000 < started_at - BACKLOG_SECONDS:
        return None
    try:
        text = json.loads(content or "{}").get("text", "")
    except (ValueError, AttributeError):
        return None
    text = MENTION.sub("", text).strip()
    return text or None


def today() -> str:
    """The bot's day, on this machine's clock: the budget starts again at its midnight."""
    return datetime.now().astimezone().date().isoformat()


def cut(text: str) -> str:
    return text if len(text) <= MAX_REPLY_CHARS else text[:MAX_REPLY_CHARS].rstrip() + CUT_NOTE


def state_path() -> Path:
    return Path(settings.data_dir) / "feishu.json"


def load_state() -> dict:
    state = {"enabled": False, "daily_budget_usd": settings.feishu_daily_budget_usd, "spent": {},
             "notified": "", "chats": {}, "seen": [], "handled": 0}
    try:
        state.update(json.loads(state_path().read_text()))
    except (OSError, ValueError):
        pass
    return state


class Sender:
    """Replies through Feishu's API (the SDK's client, called off the service's loop)."""

    def __init__(self, app_id: str, app_secret: str):
        import lark_oapi as lark

        self.client = lark.Client.builder().app_id(app_id).app_secret(app_secret).build()

    async def reply(self, message_id: str, text: str) -> None:
        from lark_oapi.api.im.v1 import ReplyMessageRequest, ReplyMessageRequestBody

        request = (ReplyMessageRequest.builder().message_id(message_id)
                   .request_body(ReplyMessageRequestBody.builder().msg_type("text")
                                 .content(json.dumps({"text": cut(text)}, ensure_ascii=False)).build()).build())
        response = await asyncio.to_thread(self.client.im.v1.message.reply, request)
        if not response.success():
            raise RuntimeError(f"飞书回复失败：{response.code} {response.msg}")


class Bot:
    """The bot's state, budget and replies; ``handle`` decides what a message becomes and returns
    the reply (and what deciding and answering cost)."""

    def __init__(self, handle: Callable[[Message], Awaitable[tuple[Optional[str], float]]]):
        self.handle = handle
        self.state = load_state()
        self.sender: Optional[Sender] = None
        self.status, self.error = "off", ""
        self.started_at = 0.0
        self.thread: Optional[threading.Thread] = None
        self.thread_loop: Optional[asyncio.AbstractEventLoop] = None
        self.lock = asyncio.Lock()

    # ---- state ----
    def save(self) -> None:
        state_path().parent.mkdir(parents=True, exist_ok=True)
        state_path().write_text(json.dumps(self.state, ensure_ascii=False, indent=1))

    def spent_today(self) -> float:
        return float(self.state["spent"].get(today(), 0.0))

    def spend(self, amount: float) -> None:
        if amount > 0:
            # Only today's spend is kept.
            self.state["spent"] = {today(): round(self.spent_today() + amount, 6)}
            self.save()

    def remaining(self) -> float:
        return max(0.0, float(self.state["daily_budget_usd"]) - self.spent_today())

    def public(self) -> dict:
        return {"available": settings.feishu_bot, "installed": installed(), "configured": configured(),
                "enabled": bool(self.state["enabled"]), "status": self.status, "error": self.error,
                "daily_budget_usd": float(self.state["daily_budget_usd"]), "spent_today_usd": self.spent_today(),
                "handled": int(self.state.get("handled", 0)), "conversations": len(self.state["chats"])}

    # ---- messages ----
    async def receive(self, message: Message) -> None:
        """Answer a message once, within the day's budget."""
        async with self.lock:
            if message.message_id in self.state["seen"]:
                return
            self.state["seen"] = [*self.state["seen"], message.message_id][-SEEN_KEEP:]
            self.save()
            if self.remaining() <= 0:
                if self.state.get("notified") != today():
                    self.state["notified"] = today()
                    self.save()
                    await self.reply(message.message_id, f"今天的额度（${float(self.state['daily_budget_usd']):g}）用完了，明天再来；"
                                                         "也可以请主人在搭子里调高。")
                return
        try:
            text, cost = await self.handle(message)
        except Exception as exc:
            log.exception("feishu message %s failed", message.message_id)
            text, cost = f"这条没能处理：{str(exc)[:200]}", 0.0
        self.spend(cost)
        self.state["handled"] = int(self.state.get("handled", 0)) + 1
        self.save()
        if text:
            await self.reply(message.message_id, text)

    async def reply(self, message_id: str, text: str) -> None:
        if not self.sender:
            log.warning("feishu reply dropped: no sender")
            return
        try:
            await self.sender.reply(message_id, text)
        except Exception as exc:
            self.error = str(exc)[:300]
            log.warning("feishu reply failed: %s", exc)

    # ---- the long connection ----
    def start(self, loop: asyncio.AbstractEventLoop) -> bool:
        """Connect, when switched on and set up; False (and why, in ``error``) when it cannot."""
        if self.thread and self.thread.is_alive():
            return True
        if not settings.feishu_bot:
            self.status, self.error = "off", "SUPER_PARTNER_FEISHU_BOT 没有开启"
            return False
        if not installed():
            self.status, self.error = "error", "没有安装飞书 SDK：pip install 'super-partner[feishu]'"
            return False
        app_id, app_secret = secrets.get_secret(APP_ID), secrets.get_secret(APP_SECRET)
        if not (app_id and app_secret):
            self.status, self.error = "error", "还没有填 App ID 和 App Secret"
            return False
        self.sender = Sender(app_id, app_secret)
        self.started_at, self.status, self.error = time.time(), "connecting", ""
        self.thread = threading.Thread(target=self._run, args=(app_id, app_secret, loop), name="feishu", daemon=True)
        self.thread.start()
        return True

    def _run(self, app_id: str, app_secret: str, loop: asyncio.AbstractEventLoop) -> None:
        import lark_oapi as lark
        import lark_oapi.ws.client as ws_client

        # The SDK's client runs on a loop of its module's; give it one of this thread's.
        own = asyncio.new_event_loop()
        asyncio.set_event_loop(own)
        ws_client.loop = own
        self.thread_loop = own

        def on_message(data) -> None:
            event = data.event
            message = event.message
            text = wanted(message.message_type or "", message.chat_type or "", message.content or "",
                          [item.key for item in (message.mentions or []) if item.key],
                          int(message.create_time or 0), self.started_at)
            if text is None:
                return
            sender = event.sender.sender_id.open_id if event.sender and event.sender.sender_id else ""
            asyncio.run_coroutine_threadsafe(
                self.receive(Message(message.message_id, message.chat_id, message.chat_type, text, sender or "")), loop)

        handler = lark.EventDispatcherHandler.builder("", "").register_p2_im_message_receive_v1(on_message).build()
        client = lark.ws.Client(app_id, app_secret, event_handler=handler, log_level=lark.LogLevel.WARNING)
        self.status = "connected"
        try:
            client.start()
        except RuntimeError as exc:
            if "stopped" not in str(exc):  # stopped by stop()
                self.status, self.error = "error", f"连接飞书失败：{str(exc)[:300]}"
                return
        except Exception as exc:
            self.status, self.error = "error", f"连接飞书失败：{str(exc)[:300]}"
            return
        self.status = "off"

    def stop(self) -> None:
        own, self.thread_loop = self.thread_loop, None
        if own and own.is_running():
            own.call_soon_threadsafe(own.stop)
        self.status = "off"
