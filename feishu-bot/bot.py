"""若水的飞书机器人: a capability package (docs/design/capability-packages.md).

Super Partner runs this in the capabilities' sandbox. It holds Feishu's long connection (no public
address needed), and for each message it answers asks Super Partner over stdin/stdout (JSON lines):
``{"op": "message", ...}`` out, ``{"re": ..., "reply": ...}`` back. When a task it asked for ends,
Super Partner sends ``{"event": "task_ended", ...}`` and the result is replied under the message.

The only way out of the sandbox is the proxy in HTTPS_PROXY, which reaches only the hosts in
capability.json. Its data folder (SP_DATA_DIR) keeps the ids it has answered.
"""
from __future__ import annotations

import json
import logging
import os
import re
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

# Messages sent this long before it started are the backlog: not answered.
BACKLOG_SECONDS = 60
# Message ids remembered so one delivered twice is answered once.
SEEN_KEEP = 500
# A reply longer than this is cut, with a note that the rest is in Super Partner.
MAX_REPLY_CHARS = 3500
CUT_NOTE = "\n\n……（太长了，完整内容在若水里）"
# How long a message waits for Super Partner's answer.
REPLY_WAIT = 1800
# How a mention appears in a message's text.
MENTION = re.compile(r"@_user_\d+\s*")


def wanted(message_type: str, chat_type: str, content: str, mentions: list, create_time_ms: int,
           started_at: float) -> Optional[str]:
    """The text to answer, or None: only text, privately or when @-mentioned in a group, and not
    the backlog from before it started."""
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


def cut(text: str) -> str:
    return text if len(text) <= MAX_REPLY_CHARS else text[:MAX_REPLY_CHARS].rstrip() + CUT_NOTE


class Seen:
    """Ids answered lately, kept in the data folder across restarts."""

    def __init__(self, folder: Path):
        self.path, self.lock = folder / "seen.json", threading.Lock()
        try:
            self.ids = list(json.loads(self.path.read_text()))
        except (OSError, ValueError):
            self.ids = []

    def first(self, message_id: str) -> bool:
        """True the first time ``message_id`` is seen."""
        with self.lock:
            if message_id in self.ids:
                return False
            self.ids = [*self.ids, message_id][-SEEN_KEEP:]
            self.path.write_text(json.dumps(self.ids))
            return True


class Host:
    """Super Partner, over stdin and stdout."""

    def __init__(self, on_event):
        self.on_event = on_event
        self.pending: dict[str, list] = {}
        self.lock = threading.Lock()

    def send(self, payload: dict) -> None:
        with self.lock:
            sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
            sys.stdout.flush()

    def status(self, text: str) -> None:
        self.send({"op": "status", "text": text})

    def ask(self, conversation: str, text: str, origin: dict) -> Optional[str]:
        request, done = uuid.uuid4().hex, threading.Event()
        self.pending[request] = [done, None]
        self.send({"op": "message", "id": request, "conversation": conversation, "text": text, "origin": origin})
        done.wait(REPLY_WAIT)
        return self.pending.pop(request, [None, None])[1]

    def listen(self) -> None:
        for line in sys.stdin:
            try:
                payload = json.loads(line)
            except ValueError:
                continue
            if "re" in payload and payload["re"] in self.pending:
                self.pending[payload["re"]][1] = payload.get("reply")
                self.pending[payload["re"]][0].set()
            elif payload.get("event") == "task_ended":
                threading.Thread(target=self.on_event, args=(payload,), daemon=True).start()
        os._exit(0)  # Super Partner has gone


class StatusLog(logging.Handler):
    """The SDK's own log, turned into the status Super Partner shows."""

    def __init__(self, host: Host):
        super().__init__(logging.INFO)
        self.host = host

    def emit(self, record: logging.LogRecord) -> None:
        text = record.getMessage()
        if "connected to" in text:
            self.host.status("已连接")
        elif "reconnect" in text or record.levelno >= logging.ERROR:
            self.host.status(f"连接有问题：{text[:150]}")


def main() -> None:
    import lark_oapi as lark
    import lark_oapi.ws.client as ws_client
    from lark_oapi.api.im.v1 import ReplyMessageRequest, ReplyMessageRequestBody

    # The SDK connects its websocket directly; here the proxy is the only way out.
    direct = ws_client._ws_connect_kwargs

    def through_proxy(*args, **kwargs):
        options = direct(*args, **kwargs)
        options.pop("proxy", None)
        return options
    ws_client._ws_connect_kwargs = through_proxy

    app_id, app_secret = os.environ["FEISHU_APP_ID"], os.environ["FEISHU_APP_SECRET"]
    client = lark.Client.builder().app_id(app_id).app_secret(app_secret).build()
    seen = Seen(Path(os.environ.get("SP_DATA_DIR", ".")))

    def reply(message_id: str, text: str) -> None:
        request = (ReplyMessageRequest.builder().message_id(message_id)
                   .request_body(ReplyMessageRequestBody.builder().msg_type("text")
                                 .content(json.dumps({"text": cut(text)}, ensure_ascii=False)).build()).build())
        response = client.im.v1.message.reply(request)
        if not response.success():
            print(f"飞书回复失败：{response.code} {response.msg}", file=sys.stderr, flush=True)

    def task_ended(payload: dict) -> None:
        if message_id := (payload.get("origin") or {}).get("message_id"):
            reply(message_id, str(payload.get("text") or ""))

    host = Host(task_ended)
    threading.Thread(target=host.listen, name="host", daemon=True).start()
    logging.getLogger("Lark").addHandler(StatusLog(host))
    started = time.time()

    def answer(message_id: str, chat_id: str, text: str) -> None:
        if result := host.ask(chat_id, text, {"message_id": message_id, "chat_id": chat_id}):
            reply(message_id, result)

    def on_message(data) -> None:
        message = data.event.message
        text = wanted(message.message_type or "", message.chat_type or "", message.content or "",
                      [item.key for item in (message.mentions or []) if item.key], int(message.create_time or 0), started)
        if text is not None and seen.first(message.message_id):
            threading.Thread(target=answer, args=(message.message_id, message.chat_id, text), daemon=True).start()

    handler = lark.EventDispatcherHandler.builder("", "").register_p2_im_message_receive_v1(on_message).build()
    host.status("正在连接飞书…")
    lark.ws.Client(app_id, app_secret, event_handler=handler, log_level=lark.LogLevel.INFO).start()


def check() -> None:
    """Without network: the SDK is installed, and which messages are answered."""
    import lark_oapi  # noqa: F401

    now = time.time()
    text = json.dumps({"text": "@_user_1 你好"})
    assert wanted("text", "p2p", json.dumps({"text": "你好"}), [], int(now * 1000), now) == "你好"
    assert wanted("text", "group", text, [], int(now * 1000), now) is None
    assert wanted("text", "group", text, ["@_user_1"], int(now * 1000), now) == "你好"
    assert wanted("image", "p2p", text, [], int(now * 1000), now) is None
    assert wanted("text", "p2p", text, [], int((now - 3600) * 1000), now) is None
    print("ok")


if __name__ == "__main__":
    check() if "--check" in sys.argv else main()
