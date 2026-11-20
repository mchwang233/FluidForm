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
# The card element an answer is written into.
ANSWER = "answer"
# People send one thought as several messages: wait this long after someone's last one before
# passing them on, together (Gather).
GATHER_SECONDS = 4.0


@dataclass
class Incoming:
    """What a message asks: its words, and the pictures (image keys) and files (key, name) with it.
    ``addressed`` False: said in a group without @ it, for FluidForm to decide whether to answer."""
    text: str
    images: list = field(default_factory=list)
    files: list = field(default_factory=list)
    addressed: bool = True


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
            elif tag == "at" and item.get("user_id"):
                words.append(str(item["user_id"]) + " ")  # its mark, named or dropped as in text (wanted)
            elif tag in {"img", "media"} and item.get("image_key"):
                images.append(item["image_key"])
        lines.append("".join(words))
    return Incoming("\n".join(line for line in lines if line.strip()), images)


def wanted(message_type: str, chat_type: str, content: str, mentions: dict, create_time_ms: int,
           started_at: float, me: Optional[frozenset] = None) -> Optional[Incoming]:
    """What to pass on, or None: text, rich text, a picture or a file, privately or when @-ed in a
    group; in a group without @ it, its words only, ``addressed`` False. Never the backlog from
    before it started. ``mentions`` maps each mark (@_user_1) to a name; ``me`` holds the marks
    that are this bot (None when it cannot tell: any mention is taken for it)."""
    if message_type not in {"text", "post", "image", "file"} or chat_type not in {"p2p", "group"}:
        return None
    mine = set(mentions) if me is None else set(me)
    called = chat_type == "p2p" or bool(set(mentions) & mine)
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
    # Its own mark goes; anyone else's becomes their name, so what was said keeps its sense.
    incoming.text = MENTION.sub(lambda m: "" if m.group(0).strip() in mine else f"@{mentions.get(m.group(0).strip(), '')} ",
                                incoming.text).strip()
    # Not called on: still passed on, pictures and files too (a picture cannot @ it, and the
    # question about it comes next); FluidForm decides whether to answer.
    incoming.addressed = called
    incoming.images, incoming.files = incoming.images[:MAX_FILES], incoming.files[:MAX_FILES - len(incoming.images[:MAX_FILES])]
    if called and message_type in {"text", "post"}:
        return incoming  # even only @ it, nothing else: still asked (FluidForm answers what came before)
    return incoming if incoming.text or incoming.images or incoming.files else None


# Who a card's @ marks are (open_id -> name), for its preview: there a mark shows as written.
AT_NAMES: dict = {"all": "所有人"}
AT_MARK = re.compile(r"<at id=([^>\s]+)></at>")


def summary(text: str) -> str:
    """A card's preview in the chat list: its first line, without Markdown's marks, an @ as "@name"."""
    first = next((line for line in text.splitlines() if line.strip()), "")
    first = AT_MARK.sub(lambda found: "@" + AT_NAMES.get(found.group(1), "某人"), first)
    return re.sub(r"[*_`#>\[\]]|^\s*[-+] ", "", first).strip()[:60] or "回复"


def card_json(text: str, streaming: bool = False) -> dict:
    """A reply as a card (schema 2.0): its Markdown shown as meant, which a text message is not.
    ``streaming``: written word by word as the answer comes (Feishu's CardKit streaming)."""
    config = {"summary": {"content": summary(text)}}
    if streaming:
        config.update(streaming_mode=True, summary={"content": "正在回答…"},
                      streaming_config={"print_frequency_ms": {"default": 40}, "print_step": {"default": 2}})
    return {"schema": "2.0", "config": config,
            "body": {"elements": [{"tag": "markdown", "content": text, "element_id": ANSWER}]}}


# Someone a reply names: "@张三" (a name from an @ in the chat), "@成员2" (who said something, as
# the chat shows them to FluidForm) or "@所有人"/"@all". Feishu only @s by id, so these become its
# mention marks; anyone it has not seen stays plain text.
EVERYONE = ("所有人", "all")


def with_mentions(text: str, known: dict, card: bool = True) -> str:
    """``text`` with each "@name" of someone in ``known`` (name -> open_id) a real @: in a card
    ``<at id=…></at>``, in a text message ``<at user_id="…">name</at>``."""
    people = {**{name: "all" for name in EVERYONE}, **{name: open_id for name, open_id in known.items() if name and open_id}}
    pattern = re.compile("@(" + "|".join(re.escape(name) for name in sorted(people, key=len, reverse=True)) + ")")

    def mark(found) -> str:
        name, open_id = found.group(1), people[found.group(1)]
        if card and open_id != "all" and len(AT_NAMES) < 5000:
            AT_NAMES[open_id] = name
        return f"<at id={open_id}></at>" if card else f'<at user_id="{open_id}">{"所有人" if open_id == "all" else name}</at>'
    return pattern.sub(mark, text)


# A name after "@" in a reply: up to the next space or punctuation.
NAMED = re.compile(r"@([^\s@，。,.:：;；!！?？、()（）<>]{1,20})")


def unknown_names(text: str, known: dict) -> list:
    """The "@name"s in ``text`` that ``known`` cannot turn into an @ (with_mentions)."""
    marked = with_mentions(text, known)
    return [name for name in NAMED.findall(marked) if name not in EVERYONE]


class People:
    """Per chat, who is in it, kept in the data folder across restarts: their names (name ->
    open_id; a name two people share is left out, never guessed) and, for whoever speaks without
    a name known, 成员N. ``lookup(chat_id)`` gives the chat's members as Feishu lists them
    ({open_id: name}, or None if it will not say); asked when a chat is first seen, every
    ROSTER_EVERY after, and when a reply names someone not known (at most every LOOKUP_EVERY)."""

    ROSTER_EVERY, LOOKUP_EVERY, MAX_NAMES = 1800, 300, 200

    def __init__(self, folder: Path, lookup=lambda chat_id: None):
        self.path, self.lookup, self.lock, self.asked = folder / "people.json", lookup, threading.Lock(), {}
        try:
            self.chats = {chat: {"names": dict(kept.get("names") or {}), "aliases": dict(kept.get("aliases") or {})}
                          for chat, kept in json.loads(self.path.read_text()).items()}
        except (OSError, ValueError, AttributeError):
            self.chats = {}

    def _chat(self, chat_id: str) -> dict:
        return self.chats.setdefault(chat_id, {"names": {}, "aliases": {}})

    def _save(self) -> None:
        self.path.write_text(json.dumps(self.chats, ensure_ascii=False))

    def learn(self, chat_id: str, name: str, open_id: str) -> None:
        """Someone's name, from an @ of them."""
        if not (chat_id and name and open_id):
            return
        with self.lock:
            names = self._chat(chat_id)["names"]
            if names.get(name) != open_id:
                names[name] = open_id
                self._save()

    def refresh(self, chat_id: str, every: float = ROSTER_EVERY) -> None:
        """The chat's members asked again, if not asked within ``every`` seconds."""
        if not chat_id or time.time() - self.asked.get(chat_id, 0) < every:
            return
        self.asked[chat_id] = time.time()
        listed = self.lookup(chat_id)
        if not listed:
            return
        count: dict = {}
        for name in listed.values():
            count[name] = count.get(name, 0) + 1
        with self.lock:
            self._chat(chat_id)["names"] = {name: open_id for open_id, name in listed.items() if name and count[name] == 1}
            self._save()

    def name_of(self, chat_id: str, open_id: str) -> str:
        """Who said it: their name if known, else the chat's 成员N (the same after a restart)."""
        if not open_id:
            return ""
        with self.lock:
            kept = self._chat(chat_id)
            for name, known in kept["names"].items():
                if known == open_id:
                    return name
            if open_id not in kept["aliases"]:
                kept["aliases"][open_id] = f"成员{len(kept['aliases']) + 1}"
                self._save()
            return kept["aliases"][open_id]

    def names(self, chat_id: str) -> list:
        """The names of the chat's people, for the model to @ them by."""
        return sorted(self.chats.get(chat_id, {}).get("names", {}))[:self.MAX_NAMES]

    def known(self, chat_id: str) -> dict:
        kept = self.chats.get(chat_id) or {"names": {}, "aliases": {}}
        return {**{alias: open_id for open_id, alias in kept["aliases"].items()}, **kept["names"]}

    def mark(self, chat_id: str, text: str, card: bool = True) -> str:
        """``text`` with the "@name"s of this chat's people as real @s (with_mentions)."""
        if unknown_names(text, self.known(chat_id)):
            self.refresh(chat_id, self.LOOKUP_EVERY)
        return with_mentions(text, self.known(chat_id), card)


def merged(items: list) -> Incoming:
    """Several messages one person sent in a row, as one: their words line by line, their pictures
    and files together; called on if any of them was."""
    texts = [item.text for item in items if item.text]
    images = [key for item in items for key in item.images][:MAX_FILES]
    files = [entry for item in items for entry in item.files][:MAX_FILES - len(images)]
    return Incoming("\n".join(texts), images, files, any(item.addressed for item in items))


class Gather:
    """Holds what one person sends in one chat until they stop for ``seconds``, then hands it on
    once: ``ready(key, messages)``, oldest first. Each new message starts the wait again."""

    def __init__(self, ready, seconds: float = GATHER_SECONDS):
        self.ready, self.seconds, self.lock = ready, seconds, threading.Lock()
        self.waiting: dict = {}

    def add(self, key, message) -> None:
        with self.lock:
            items, timer = self.waiting.get(key, ([], None))
            if timer:
                timer.cancel()
            timer = threading.Timer(self.seconds, self._done, args=(key,))
            timer.daemon = True
            self.waiting[key] = ([*items, message], timer)
            timer.start()

    def _done(self, key) -> None:
        with self.lock:
            items, _ = self.waiting.pop(key, ([], None))
        if items:
            self.ready(key, items)


class Typing:
    """A reply card written as the answer comes: started on its first piece, then the newest piece
    written each time the last write is done (one at a time, in order), and finished with the
    whole answer. ``cards`` does the calls: start(card) -> card id or None, write(card_id, text,
    sequence) -> ok, close(card_id, text, sequence) -> ok."""

    def __init__(self, cards):
        self.cards, self.lock, self.calls = cards, threading.Lock(), threading.Lock()
        self.card_id, self.sequence, self.latest = None, 0, None
        self.writing = self.failed = self.closed = False

    def heard(self, text: str) -> None:
        with self.lock:
            if self.failed or self.closed:
                return
            self.latest = cut(text)
            if self.writing:
                return
            self.writing = True
        threading.Thread(target=self._flush, daemon=True).start()

    def _flush(self) -> None:
        while True:
            with self.lock:
                text, self.latest = self.latest, None
                if text is None or self.failed or self.closed:
                    self.writing = False
                    return
            with self.calls:
                if self.closed:
                    continue
                if self.card_id is None:
                    self.card_id = self.cards.start(card_json(text, streaming=True))
                    self.failed = self.card_id is None
                    self.sequence = 1
                else:
                    self.sequence += 1
                    self.cards.write(self.card_id, text, self.sequence)

    def finish(self, text: str) -> bool:
        """Write the whole answer and stop streaming; False when no card was started (or it
        could not be finished), so the answer still has to be sent."""
        with self.lock:
            self.closed = True
        with self.calls:
            if self.card_id is None or self.failed:
                return False
            self.sequence += 1
            written = self.cards.write(self.card_id, cut(text), self.sequence)
            self.sequence += 1
            return self.cards.close(self.card_id, cut(text), self.sequence) and written


# Where FluidForm puts the files it sends with an answer, in the data folder.
OUTBOX = "outbox"
# Feishu's kinds of file, by extension; anything else is a "stream".
FILE_TYPES = {".pdf": "pdf", ".doc": "doc", ".docx": "doc", ".xls": "xls", ".xlsx": "xls", ".ppt": "ppt",
              ".pptx": "ppt", ".mp4": "mp4", ".opus": "opus"}


def file_type(name: str) -> str:
    return FILE_TYPES.get(Path(name).suffix.lower(), "stream")


def picture(head: bytes) -> bool:
    """Whether a file is a picture Feishu shows, by its first bytes, not its name."""
    return head.startswith((b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff", b"GIF87a", b"GIF89a")) or \
        (head[:4] == b"RIFF" and head[8:12] == b"WEBP")


def sent_name(stored: str) -> str:
    """A sent file's own name: FluidForm stores it as <8 hex>-<name>."""
    return re.sub(r"^[0-9a-f]{8}-", "", stored) or stored


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

    def ask(self, conversation: str, text: str, origin: dict, attachments: tuple = (),
            heard=None, addressed: bool = True, sender: str = "", people=()) -> tuple[Optional[str], list]:
        """Super Partner's answer, and the files to send with it (paths in the data folder);
        ``heard`` hears the answer as it is being written ({"progress": ...}); ``people``: the names
        of the group's people, so the answer can @ them."""
        request, done = uuid.uuid4().hex, threading.Event()
        self.pending[request] = [done, None, heard, []]
        message = {"op": "message", "id": request, "conversation": conversation, "text": text, "origin": origin}
        if attachments:
            message["attachments"] = list(attachments)
        if not addressed:
            message["addressed"] = False
        if sender:
            message["sender"] = sender
        if people:
            message["people"] = list(people)
        self.send(message)
        done.wait(REPLY_WAIT)
        _, answer, _, files = self.pending.pop(request, [None, None, None, []])
        return answer, files

    def listen(self) -> None:
        for line in sys.stdin:
            try:
                payload = json.loads(line)
            except ValueError:
                continue
            if "re" in payload and payload["re"] in self.pending:
                waiting = self.pending[payload["re"]]
                waiting[1] = payload.get("reply")
                waiting[3] = [str(item) for item in payload.get("files") or [] if isinstance(item, str)]
                waiting[0].set()
            elif "progress" in payload and payload["progress"] in self.pending:
                if heard := self.pending[payload["progress"]][2]:
                    heard(str(payload.get("text") or ""))
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
    from lark_oapi.api.cardkit.v1 import (
        ContentCardElementRequest,
        ContentCardElementRequestBody,
        CreateCardRequest,
        CreateCardRequestBody,
        SettingsCardRequest,
        SettingsCardRequestBody,
    )
    from lark_oapi.api.im.v1 import (
        CreateFileRequest,
        CreateFileRequestBody,
        CreateImageRequest,
        CreateImageRequestBody,
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
    warned = set()

    def bot_open_id() -> Optional[str]:
        """This bot's own id, to tell an @ of it from an @ of someone else; None if unknown."""
        try:
            request = (lark.BaseRequest.builder().http_method(lark.HttpMethod.GET).uri("/open-apis/bot/v3/info")
                       .token_types({lark.AccessTokenType.TENANT}).build())
            response = client.request(request)
            return (json.loads(response.raw.content).get("bot") or {}).get("open_id") or None
        except Exception as exc:
            print(f"读不到机器人自己的 id：{exc}", file=sys.stderr, flush=True)
            return None

    def send_reply(message_id: str, kind: str, content: dict) -> bool:
        request = (ReplyMessageRequest.builder().message_id(message_id)
                   .request_body(ReplyMessageRequestBody.builder().msg_type(kind)
                                 .content(json.dumps(content, ensure_ascii=False)).build()).build())
        try:
            response = client.im.v1.message.reply(request)
        except Exception as exc:
            print(f"飞书回复失败：{exc}", file=sys.stderr, flush=True)
            return False
        if not response.success():
            print(f"飞书回复失败（{kind}）：{response.code} {response.msg}", file=sys.stderr, flush=True)
        return response.success()

    def reply(message_id: str, text: str, chat_id: str = "") -> None:
        """As a card, so its Markdown shows as meant; as plain text if a card cannot be sent.
        ``chat_id``: where it goes, so an "@name" of someone there @s them."""
        if not send_reply(message_id, "interactive", card_json(people.mark(chat_id, cut(text)))):
            send_reply(message_id, "text", {"text": people.mark(chat_id, cut(text), card=False)})

    def chat_members(chat_id: str) -> Optional[dict]:
        """The chat's members ({open_id: name}); None if Feishu will not say."""
        found, token = {}, ""
        try:
            for _ in range(20):
                query = "?member_id_type=open_id&page_size=100" + (f"&page_token={token}" if token else "")
                request = (lark.BaseRequest.builder().http_method(lark.HttpMethod.GET)
                           .uri(f"/open-apis/im/v1/chats/{chat_id}/members{query}")
                           .token_types({lark.AccessTokenType.TENANT}).build())
                body = json.loads(client.request(request).raw.content)
                if body.get("code"):
                    if "members" not in warned:  # once: most likely the permission is missing
                        warned.add("members")
                        print(f"读不到群成员（需要「查看群成员」权限 im:chat.members:read）：{body.get('code')} {body.get('msg')}",
                              file=sys.stderr, flush=True)
                    return None
                page = body.get("data") or {}
                found.update({item["member_id"]: item["name"] for item in page.get("items") or []
                              if item.get("name") and item.get("member_id")})
                token = page.get("page_token") or ""
                if not page.get("has_more") or not token:
                    break
        except Exception as exc:
            print(f"读不到群成员：{exc}", file=sys.stderr, flush=True)
            return None
        return found

    def ok(response, what: str) -> bool:
        if not response.success() and what not in warned:  # once: most likely a missing permission
            warned.add(what)
            print(f"飞书卡片{what}失败（需要「创建与更新卡片」权限）：{response.code} {response.msg}",
                  file=sys.stderr, flush=True)
        return response.success()

    class Cards:
        """CardKit's calls for one reply (Typing)."""

        def __init__(self, message_id: str):
            self.message_id = message_id

        def start(self, card: dict) -> Optional[str]:
            try:
                response = client.cardkit.v1.card.create(CreateCardRequest.builder().request_body(
                    CreateCardRequestBody.builder().type("card_json").data(json.dumps(card, ensure_ascii=False)).build()).build())
                if not ok(response, "创建") or not response.data:
                    return None
                card_id = response.data.card_id
                sent = send_reply(self.message_id, "interactive", {"type": "card", "data": {"card_id": card_id}})
                return card_id if sent else None
            except Exception as exc:
                print(f"飞书卡片创建失败：{exc}", file=sys.stderr, flush=True)
                return None

        def write(self, card_id: str, text: str, sequence: int) -> bool:
            try:
                return ok(client.cardkit.v1.card_element.content(
                    ContentCardElementRequest.builder().card_id(card_id).element_id(ANSWER).request_body(
                        ContentCardElementRequestBody.builder().content(text).sequence(sequence)
                        .uuid(f"w-{card_id}-{sequence}").build()).build()), "更新")
            except Exception as exc:
                print(f"飞书卡片更新失败：{exc}", file=sys.stderr, flush=True)
                return False

        def close(self, card_id: str, text: str, sequence: int) -> bool:
            settings = {"config": {"streaming_mode": False, "summary": {"content": summary(text)}}}
            try:
                return ok(client.cardkit.v1.card.settings(
                    SettingsCardRequest.builder().card_id(card_id).request_body(
                        SettingsCardRequestBody.builder().settings(json.dumps(settings, ensure_ascii=False))
                        .sequence(sequence).uuid(f"c-{card_id}-{sequence}").build()).build()), "收尾")
            except Exception as exc:
                print(f"飞书卡片收尾失败：{exc}", file=sys.stderr, flush=True)
                return False

    def task_ended(payload: dict) -> None:
        if message_id := (payload.get("origin") or {}).get("message_id"):
            reply(message_id, str(payload.get("text") or ""))

    host = Host(task_ended)
    threading.Thread(target=host.listen, name="host", daemon=True).start()
    logging.getLogger("Lark").addHandler(StatusLog(host))
    started = time.time()

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

    def upload(path: Path, name: str, image: bool) -> Optional[tuple[str, dict]]:
        """A file uploaded to Feishu, as the message that shows it: ("image", ...) or ("file", ...)."""
        try:
            with path.open("rb") as body:
                if image:
                    response = client.im.v1.image.create(CreateImageRequest.builder().request_body(
                        CreateImageRequestBody.builder().image_type("message").image(body).build()).build())
                    if response.success() and response.data:
                        return "image", {"image_key": response.data.image_key}
                else:
                    response = client.im.v1.file.create(CreateFileRequest.builder().request_body(
                        CreateFileRequestBody.builder().file_type(file_type(name)).file_name(name).file(body).build()).build())
                    if response.success() and response.data:
                        return "file", {"file_key": response.data.file_key}
            print(f"飞书上传失败（{name}）：{response.code} {response.msg}", file=sys.stderr, flush=True)
        except Exception as exc:
            print(f"飞书上传失败（{name}）：{exc}", file=sys.stderr, flush=True)
        return None

    def send_files(message_id: str, sent: list) -> None:
        """The files FluidForm sent with an answer, each replied under the message: a picture as a
        picture (as a file if Feishu will not take it as one), anything else as a file. Removed once
        sent, or once it could not be."""
        outbox = (data / OUTBOX).resolve()
        for relative in sent[:MAX_FILES]:
            path = (data / relative).resolve()
            if outbox not in path.parents or not path.is_file():
                continue
            name = sent_name(path.name)
            try:
                image = picture(path.read_bytes()[:16])
                made = upload(path, name, True) if image else None
                made = made or upload(path, name, False)
                if made:
                    send_reply(message_id, *made)
            finally:
                path.unlink(missing_ok=True)

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

    def answer(message_id: str, chat_id: str, incoming: Incoming, sender: str = "", chat_type: str = "",
               names: tuple = ()) -> None:
        origin = {"message_id": message_id, "chat_id": chat_id, **({"chat_type": chat_type} if chat_type else {})}

        def marked(typing):
            return lambda text: typing.heard(people.mark(chat_id, text))
        if not incoming.addressed:
            # Not called on: no "typing" until FluidForm decides it is meant for it.
            names = [download(message_id, key, "image", "image.png") for key in incoming.images]
            names += [download(message_id, key, "file", name) for key, name in incoming.files]
            kept = tuple(name for name in names if name)
            if not incoming.text and not kept:
                return
            typing = Typing(Cards(message_id))
            result, files = host.ask(chat_id, incoming.text, origin, kept, marked(typing), addressed=False, sender=sender,
                                         people=names)
            if result and not typing.finish(people.mark(chat_id, result)):
                reply(message_id, result, chat_id)
            send_files(message_id, files)
            return
        reaction = working(message_id)
        try:
            names = [download(message_id, key, "image", "image.png") for key in incoming.images]
            names += [download(message_id, key, "file", name) for key, name in incoming.files]
            kept = tuple(name for name in names if name)
            if not incoming.text and not kept and (incoming.images or incoming.files):
                reply(message_id, "图片或文件没能下载下来：请主人检查应用是否开通了「获取与上传图片或文件资源」权限。")
                return
            typing = Typing(Cards(message_id))
            result, files = host.ask(chat_id, incoming.text, origin, kept, marked(typing), sender=sender, people=names)
            if result and not typing.finish(people.mark(chat_id, result)):
                reply(message_id, result, chat_id)
            elif not result:
                typing.finish("（没有回答）")
            send_files(message_id, files)
        finally:
            done(message_id, reaction)

    me_id = bot_open_id()
    # Per group, who is in it: speakers are called by name, and a reply's "@name" @s them.
    people = People(data, chat_members)

    def on_message(data) -> None:
        message, sender = data.event.message, data.event.sender
        if sender is not None and sender.sender_type not in (None, "user"):
            return  # other bots (and itself)
        mentions = {item.key: item.name or "" for item in (message.mentions or []) if item.key}
        # Which @ is this bot: by its id, or, not knowing it, by Feishu saying the one @-ed is a bot.
        known = bool(me_id) or any(item.mentioned_type for item in (message.mentions or []))
        me = frozenset(item.key for item in (message.mentions or []) if item.key and item.id and (
            item.id.open_id == me_id if me_id else item.mentioned_type == "bot")) if known else None
        incoming = wanted(message.message_type or "", message.chat_type or "", message.content or "", mentions,
                          int(message.create_time or 0), started, me)
        group = message.chat_type == "group"
        for item in message.mentions or []:
            if group and item.name and item.id and item.id.open_id and item.key not in (me or ()) \
                    and item.id.open_id != me_id:
                people.learn(message.chat_id, item.name, item.id.open_id)
        if incoming is not None and seen.first(message.message_id):
            person = sender.sender_id.open_id if sender and sender.sender_id else ""
            gather.add((message.chat_id, person), (message.message_id, message.chat_type or "", incoming))

    def gathered(key, items) -> None:
        """Someone's messages in a row, answered once, under the last of them."""
        chat_id, person = key
        message_id, chat_type, _ = items[-1]
        who, names = "", []
        if chat_type == "group":
            people.refresh(chat_id)
            who, names = people.name_of(chat_id, person), people.names(chat_id)
        answer(message_id, chat_id, merged([incoming for _, _, incoming in items]), who, chat_type, names)

    gather = Gather(gathered)

    handler = lark.EventDispatcherHandler.builder("", "").register_p2_im_message_receive_v1(on_message).build()
    host.status("正在连接飞书…")
    lark.ws.Client(app_id, app_secret, event_handler=handler, log_level=lark.LogLevel.INFO).start()


def check() -> None:
    """Without network: the SDK is installed, and which messages are answered."""
    import lark_oapi  # noqa: F401

    now, ms = time.time(), int(time.time() * 1000)
    text = json.dumps({"text": "@_user_1 你好"})
    assert wanted("text", "p2p", json.dumps({"text": "你好"}), {}, ms, now) == Incoming("你好")
    # In a group: @ it, it is asked; without @ it, the words go on unaddressed (FluidForm decides).
    assert wanted("text", "group", text, {"@_user_1": "机器人"}, ms, now) == Incoming("你好")
    only = json.dumps({"text": "@_user_1"})
    assert wanted("text", "group", only, {"@_user_1": "机器人"}, ms, now, frozenset({"@_user_1"})) == Incoming("")
    assert wanted("text", "group", json.dumps({"text": "@_user_2"}), {"@_user_2": "张三"}, ms, now, frozenset()) \
        == Incoming("@张三", addressed=False)
    assert wanted("text", "group", text, {"@_user_1": "机器人"}, ms, now, frozenset({"@_user_1"})) == Incoming("你好")
    said = json.dumps({"text": "@_user_2 明天几点开会？"})
    alone = frozenset()
    other = Incoming("@张三 明天几点开会？", addressed=False)
    assert wanted("text", "group", said, {"@_user_2": "张三"}, ms, now, alone) == other
    assert wanted("text", "group", json.dumps({"text": "大家好"}), {}, ms, now, alone) == Incoming("大家好", addressed=False)
    photo = Incoming("", ["img_1"], addressed=False)
    assert wanted("image", "group", json.dumps({"image_key": "img_1"}), {}, ms, now, frozenset()) == photo
    assert wanted("text", "p2p", text, {}, int((now - 3600) * 1000), now) is None
    # A picture, a file, and rich text with words and pictures (in a group, @ it in rich text).
    assert wanted("image", "p2p", json.dumps({"image_key": "img_1"}), {}, ms, now) == Incoming("", ["img_1"])
    sent_file = json.dumps({"file_key": "f_1", "file_name": "报价.pdf"})
    assert wanted("file", "p2p", sent_file, {}, ms, now) == Incoming("", [], [("f_1", "报价.pdf")])
    post = {"title": "", "content": [[{"tag": "at", "user_id": "@_user_1"}, {"tag": "text", "text": " 这张图里是什么？"}],
                                     [{"tag": "img", "image_key": "img_2"}]]}
    assert wanted("post", "group", json.dumps(post), {"@_user_1": "机器人"}, ms, now) == Incoming("这张图里是什么？", ["img_2"])
    assert wanted("image", "p2p", json.dumps({}), {}, ms, now) is None
    assert wanted("sticker", "p2p", json.dumps({"file_key": "s"}), {}, ms, now) is None
    assert safe_name("../../etc/passwd") == "passwd" and safe_name("a b/截图.png") == "截图.png"
    # Replies are cards; one being written is written in order, the newest piece each time.
    assert card_json("**WAL** 是预写日志")["config"]["summary"]["content"] == "WAL 是预写日志"
    # Regression: the chat list showed a reply's @ as "<at id=ou_…></at>".
    marked = with_mentions("@叶玉文 在吗？@所有人", {"叶玉文": "ou_8"})
    assert card_json(marked)["config"]["summary"]["content"] == "@叶玉文 在吗？@所有人"
    assert summary("<at id=ou_x></at> 好") == "@某人 好"
    assert card_json("x", streaming=True)["config"]["streaming_mode"] is True

    class Fake:
        def __init__(self, card_id="c1"):
            self.card_id, self.calls = card_id, []

        def start(self, card):
            self.calls.append(("start", card["body"]["elements"][0]["content"]))
            time.sleep(0.05)
            return self.card_id

        def write(self, card_id, text, sequence):
            self.calls.append(("write", text, sequence))
            return True

        def close(self, card_id, text, sequence):
            self.calls.append(("close", text, sequence))
            return True

    fake = Fake()
    typing = Typing(fake)
    for piece in ("W", "WA", "WAL", "WAL 是"):
        typing.heard(piece)
    time.sleep(0.2)
    assert typing.finish("WAL 是预写日志。")
    typing.heard("late")
    assert fake.calls[0] == ("start", "W") and fake.calls[-2:] == [("write", "WAL 是预写日志。", fake.calls[-2][2]),
                                                                  ("close", "WAL 是预写日志。", fake.calls[-1][2])]
    sequences = [call[2] for call in fake.calls[1:]]
    assert sequences == sorted(sequences) and len(set(sequences)) == len(sequences)
    assert ("write", "WAL 是", 2) in fake.calls  # the newest piece, not every one
    failed = Typing(Fake(card_id=None))
    failed.heard("W")
    time.sleep(0.1)
    assert failed.finish("WAL") is False and Typing(Fake()).finish("x") is False
    # "@name" in a reply @s that person for real, if the chat has shown who they are.
    known = {"张三": "ou_1", "张三丰": "ou_2", "成员2": "ou_3"}
    assert with_mentions("@张三丰 和 @张三 看下，@成员2 也是", known) == \
        "<at id=ou_2></at> 和 <at id=ou_1></at> 看下，<at id=ou_3></at> 也是"
    assert with_mentions("@所有人 明天放假，@李四 不认识", known) == "<at id=all></at> 明天放假，@李四 不认识"
    assert with_mentions("@张三 好", known, card=False) == '<at user_id="ou_1">张三</at> 好'
    assert with_mentions("@all 注意", {}, card=False) == '<at user_id="all">所有人</at> 注意'
    # A group's people: called by name once Feishu lists them (a name two share is not guessed),
    # else 成员N; someone a reply names but not known is looked up; all of it kept across restarts.
    import tempfile
    with tempfile.TemporaryDirectory() as folder:
        asked, listed = [], {"ou_1": "张三", "ou_2": "李四", "ou_3": "李四"}
        roster = People(Path(folder), lambda chat_id: asked.append(chat_id) or dict(listed))
        assert roster.name_of("oc_1", "ou_9") == "成员1" and roster.mark("oc_1", "@成员1 好") == "<at id=ou_9></at> 好"
        roster.refresh("oc_1")
        roster.refresh("oc_1")
        assert asked == ["oc_1"] and roster.names("oc_1") == ["张三"] and roster.name_of("oc_1", "ou_1") == "张三"
        assert roster.mark("oc_1", "@张三 和 @李四") == "<at id=ou_1></at> 和 @李四"
        listed["ou_4"] = "叶玉文"
        roster.asked["oc_1"] = 0
        assert roster.mark("oc_1", "@叶玉文 在吗？") == "<at id=ou_4></at> 在吗？" and len(asked) == 2
        assert roster.mark("oc_1", "@王五 在吗") == "@王五 在吗" and len(asked) == 2  # not again so soon
        roster.learn("oc_1", "小王", "ou_5")
        again = People(Path(folder))
        assert again.name_of("oc_1", "ou_9") == "成员1" and again.name_of("oc_1", "ou_7") == "成员2"
        assert again.mark("oc_1", "@小王 @叶玉文", card=False) == \
            '<at user_id="ou_5">小王</at> <at user_id="ou_4">叶玉文</at>'
        assert unknown_names("@所有人 @张三，@成员1。", {"成员1": "ou_1"}) == ["张三"]
    # Files FluidForm sends: their own names, pictures known by their bytes, Feishu's file kinds.
    assert sent_name("0a1b2c3d-猫.png") == "猫.png" and sent_name("cat.png") == "cat.png"
    assert picture(b"\x89PNG\r\n\x1a\n" + b"\0" * 8) and not picture(b"%PDF-1.7")
    assert file_type("报价.PDF") == "pdf" and file_type("表.xlsx") == "xls" and file_type("a.zip") == "stream"
    # Messages sent in a row are passed on once, together, after the sender stops.
    assert merged([Incoming("我想问下"), Incoming("", ["img_1"], addressed=False), Incoming("这是什么猫")]) == \
        Incoming("我想问下\n这是什么猫", ["img_1"], [], True)
    handed = []
    gather = Gather(lambda key, items: handed.append((key, [item for item in items])), seconds=0.1)
    for word in ("那个", "我想问下", "这是什么猫"):
        gather.add(("chat", "u1"), word)
        time.sleep(0.03)
    gather.add(("chat", "u2"), "你好")
    time.sleep(0.3)
    assert sorted(handed) == [(("chat", "u1"), ["那个", "我想问下", "这是什么猫"]), (("chat", "u2"), ["你好"])]
    print("ok")


if __name__ == "__main__":
    check() if "--check" in sys.argv else main()
