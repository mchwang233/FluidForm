"""FluidForm 的飞书机器人: a capability package (docs/design/capability-packages.md).

Super Partner runs this in the capabilities' sandbox. It holds Feishu's long connection (no public
address needed), and for each message it answers asks Super Partner over stdin/stdout (JSON lines):
``{"op": "message", ...}`` out, ``{"re": ..., "reply": ...}`` back. When a task it asked for ends,
Super Partner sends ``{"event": "task_ended", ...}`` and the result is replied under the message.

The only way out of the sandbox is the proxy in HTTPS_PROXY, which reaches only the hosts in
capability.json. Its data folder (SP_DATA_DIR) keeps the ids it has answered, and the pictures and
files of a message while they are handed over: downloaded to ``inbox/`` there and named in the
message's ``attachments``, Super Partner takes them.
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
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

# Messages sent this long before it started are the backlog: not answered.
BACKLOG_SECONDS = 60
# Message ids remembered so one delivered twice is answered once.
SEEN_KEEP = 500
# A reply longer than this is cut, with a note that the rest is in Super Partner.
MAX_REPLY_CHARS = 3500
CUT_NOTE = "\n\n……（太长了，完整内容在 FluidForm 里）"
# How long a message waits for Super Partner's answer.
REPLY_WAIT = 1800
# How a mention appears in a message's text.
MENTION = re.compile(r"@_user_\d+\s*")
# Where a message's pictures and files wait, in its data folder, until Super Partner takes them.
INBOX = "inbox"
# What Super Partner takes with one message.
MAX_FILES = 10
# The reaction on a message while it is being answered (Feishu's "typing" emoji), taken off after.
WORKING_EMOJI = "Typing"


@dataclass
class Incoming:
    """What a message asks: its words, and the pictures (image keys) and files (key, name) with it."""
    text: str
    images: list = field(default_factory=list)
    files: list = field(default_factory=list)


def _post(content: dict) -> Incoming:
    """Rich text: its title and paragraphs as lines, its pictures in order."""
    body = content.get("content") if isinstance(content.get("content"), list) else []
    lines, images = [content.get("title") or ""], []
    for paragraph in body:
        words = []
        for item in paragraph if isinstance(paragraph, list) else []:
            tag = item.get("tag") if isinstance(item, dict) else None
            if tag in {"text", "a", "code_block"}:
                words.append(str(item.get("text") or ""))
            elif tag in {"img", "media"} and item.get("image_key"):
                images.append(item["image_key"])
        lines.append("".join(words))
    return Incoming("\n".join(line for line in lines if line.strip()), images)


def wanted(message_type: str, chat_type: str, content: str, mentions: list, create_time_ms: int,
           started_at: float) -> Optional[Incoming]:
    """What to answer, or None: text, rich text, a picture or a file, privately or when
    @-mentioned in a group, and not the backlog from before it started."""
    if message_type not in {"text", "post", "image", "file"} or chat_type not in {"p2p", "group"}:
        return None
    if chat_type == "group" and not mentions:
        return None
    if create_time_ms and create_time_ms / 1000 < started_at - BACKLOG_SECONDS:
        return None
    try:
        body = json.loads(content or "{}")
        if not isinstance(body, dict):
            return None
    except ValueError:
        return None
    if message_type == "text":
        incoming = Incoming(str(body.get("text") or ""))
    elif message_type == "post":
        incoming = _post(body)
    elif message_type == "image":
        incoming = Incoming("", [body["image_key"]] if body.get("image_key") else [])
    else:
        incoming = Incoming("", [], [(body["file_key"], str(body.get("file_name") or "file"))] if body.get("file_key") else [])
    incoming.text = MENTION.sub("", incoming.text).strip()
    incoming.images, incoming.files = incoming.images[:MAX_FILES], incoming.files[:MAX_FILES - len(incoming.images[:MAX_FILES])]
    return incoming if incoming.text or incoming.images or incoming.files else None


def safe_name(name: str) -> str:
    name = re.sub(r"[^\w.\-\u4e00-\u9fff]+", "_", Path(name).name)[:80].strip("._")
    return name or "file"


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

    def ask(self, conversation: str, text: str, origin: dict, attachments: tuple = ()) -> Optional[str]:
        request, done = uuid.uuid4().hex, threading.Event()
        self.pending[request] = [done, None]
        message = {"op": "message", "id": request, "conversation": conversation, "text": text, "origin": origin}
        if attachments:
            message["attachments"] = list(attachments)
        self.send(message)
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
    from lark_oapi.api.im.v1 import (
        CreateMessageReactionRequest,
        CreateMessageReactionRequestBody,
        DeleteMessageReactionRequest,
        Emoji,
        GetMessageResourceRequest,
        ReplyMessageRequest,
        ReplyMessageRequestBody,
    )

    # The SDK connects its websocket directly; here the proxy is the only way out.
    direct = ws_client._ws_connect_kwargs

    def through_proxy(*args, **kwargs):
        options = direct(*args, **kwargs)
        options.pop("proxy", None)
        return options
    ws_client._ws_connect_kwargs = through_proxy

    app_id, app_secret = os.environ["FEISHU_APP_ID"], os.environ["FEISHU_APP_SECRET"]
    client = lark.Client.builder().app_id(app_id).app_secret(app_secret).build()
    data = Path(os.environ.get("SP_DATA_DIR", "."))
    seen = Seen(data)

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

    warned = set()

    def working(message_id: str) -> Optional[str]:
        """Show the asker it is being answered: a "typing" reaction on their message; its id."""
        request = (CreateMessageReactionRequest.builder().message_id(message_id)
                   .request_body(CreateMessageReactionRequestBody.builder()
                                 .reaction_type(Emoji.builder().emoji_type(WORKING_EMOJI).build()).build()).build())
        try:
            response = client.im.v1.message_reaction.create(request)
        except Exception as exc:  # only a courtesy: never in the way of the answer
            print(f"飞书表情回复失败：{exc}", file=sys.stderr, flush=True)
            return None
        if response.success() and response.data:
            return response.data.reaction_id
        if "reaction" not in warned:  # once: most likely the permission is missing
            warned.add("reaction")
            print(f"飞书表情回复失败（需要「发送、删除消息表情回复」权限）：{response.code} {response.msg}",
                  file=sys.stderr, flush=True)
        return None

    def done(message_id: str, reaction_id: Optional[str]) -> None:
        if reaction_id:
            try:
                client.im.v1.message_reaction.delete(
                    DeleteMessageReactionRequest.builder().message_id(message_id).reaction_id(reaction_id).build())
            except Exception as exc:
                print(f"飞书表情撤回失败：{exc}", file=sys.stderr, flush=True)

    def download(message_id: str, key: str, kind: str, name: str) -> Optional[str]:
        """A picture or file of the message, saved in the inbox; its path there, or None."""
        request = GetMessageResourceRequest.builder().message_id(message_id).file_key(key).type(kind).build()
        response = client.im.v1.message_resource.get(request)
        if not response.success() or response.file is None:
            what = "图片" if kind == "image" else "文件"
            print(f"飞书{what}下载失败：{response.code} {response.msg}", file=sys.stderr, flush=True)
            return None
        relative = f"{INBOX}/{safe_name(message_id)}-{uuid.uuid4().hex[:8]}-{safe_name(response.file_name or name)}"
        (data / INBOX).mkdir(exist_ok=True)
        (data / relative).write_bytes(response.file.read())
        return relative

    def answer(message_id: str, chat_id: str, incoming: Incoming) -> None:
        reaction = working(message_id)
        try:
            names = [download(message_id, key, "image", "image.png") for key in incoming.images]
            names += [download(message_id, key, "file", name) for key, name in incoming.files]
            kept = tuple(name for name in names if name)
            if not incoming.text and not kept:
                reply(message_id, "图片或文件没能下载下来：请主人检查应用是否开通了「获取与上传图片或文件资源」权限。")
                return
            if result := host.ask(chat_id, incoming.text, {"message_id": message_id, "chat_id": chat_id}, kept):
                reply(message_id, result)
        finally:
            done(message_id, reaction)

    def on_message(data) -> None:
        message = data.event.message
        incoming = wanted(message.message_type or "", message.chat_type or "", message.content or "",
                          [item.key for item in (message.mentions or []) if item.key], int(message.create_time or 0), started)
        if incoming is not None and seen.first(message.message_id):
            threading.Thread(target=answer, args=(message.message_id, message.chat_id, incoming), daemon=True).start()

    handler = lark.EventDispatcherHandler.builder("", "").register_p2_im_message_receive_v1(on_message).build()
    host.status("正在连接飞书…")
    lark.ws.Client(app_id, app_secret, event_handler=handler, log_level=lark.LogLevel.INFO).start()


def check() -> None:
    """Without network: the SDK is installed, and which messages are answered."""
    import lark_oapi  # noqa: F401

    now, ms = time.time(), int(time.time() * 1000)
    text = json.dumps({"text": "@_user_1 你好"})
    assert wanted("text", "p2p", json.dumps({"text": "你好"}), [], ms, now) == Incoming("你好")
    assert wanted("text", "group", text, [], ms, now) is None
    assert wanted("text", "group", text, ["@_user_1"], ms, now) == Incoming("你好")
    assert wanted("text", "p2p", text, [], int((now - 3600) * 1000), now) is None
    # A picture, a file, and rich text with words and pictures (in a group, @ it in rich text).
    assert wanted("image", "p2p", json.dumps({"image_key": "img_1"}), [], ms, now) == Incoming("", ["img_1"])
    assert wanted("image", "group", json.dumps({"image_key": "img_1"}), [], ms, now) is None
    sent_file = json.dumps({"file_key": "f_1", "file_name": "报价.pdf"})
    assert wanted("file", "p2p", sent_file, [], ms, now) == Incoming("", [], [("f_1", "报价.pdf")])
    post = {"title": "", "content": [[{"tag": "at", "user_id": "@_user_1"}, {"tag": "text", "text": " 这张图里是什么？"}],
                                     [{"tag": "img", "image_key": "img_2"}]]}
    assert wanted("post", "group", json.dumps(post), ["@_user_1"], ms, now) == Incoming("这张图里是什么？", ["img_2"])
    assert wanted("image", "p2p", json.dumps({}), [], ms, now) is None
    assert wanted("sticker", "p2p", json.dumps({"file_key": "s"}), [], ms, now) is None
    assert safe_name("../../etc/passwd") == "passwd" and safe_name("a b/截图.png") == "截图.png"
    print("ok")


if __name__ == "__main__":
    check() if "--check" in sys.argv else main()
