"""FluidForm 的飞书机器人: a capability package (docs/design/capability-packages.md).

Feishu's side is Feishu's own channel SDK (lark-channel-sdk, by Lark Technologies: the long
connection, messages read as text and resources, duplicates dropped, replies, streaming cards,
the "typing" reaction, pictures and files, group members, "@name" made a real @). What is left
here is FluidForm's side: for each message it answers it asks FluidForm over stdin/stdout (JSON
lines): ``{"op": "message", ...}`` out, ``{"re": ..., "reply": ...}`` back. When a task it asked
for ends, FluidForm sends ``{"event": "task_ended", ...}`` and the result is replied under the
message.

The only way out of the sandbox is the proxy in HTTPS_PROXY, which reaches only the hosts in
capability.json. Its data folder (SP_DATA_DIR) keeps the pictures and files of a message while
they are handed over (downloaded to ``inbox/`` there and named in the message's ``attachments``;
FluidForm takes them), the files FluidForm sends with an answer (``outbox/``), and the 成员N names
of people whose names Feishu does not give.
"""
from __future__ import annotations

import asyncio
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
# A reply longer than this is cut, with a note that the rest is in FluidForm.
MAX_REPLY_CHARS = 3500
CUT_NOTE = "\n\n……（太长了，完整内容在 FluidForm 里）"
# How long a message waits for FluidForm's answer.
REPLY_WAIT = 1800
# Where a message's pictures and files wait, in its data folder, until FluidForm takes them.
INBOX = "inbox"
# Where FluidForm puts the files it sends with an answer, in the data folder.
OUTBOX = "outbox"
# What FluidForm takes with one message.
MAX_FILES = 10
# The kinds of message answered.
TYPES = {"text", "post", "image", "file"}
# People send one thought as several messages: wait this long after someone's last one before
# passing them on, together (Gather). The SDK's own batching merges a whole chat, every sender
# together, so it is off and this keeps each person's messages apart.
GATHER_SECONDS = 4.0
# Where a picture or a file sits in a message's text (the SDK's rendering), taken out: the
# picture or file itself goes along as an attachment.
MEDIA_MARK = re.compile(r"!\[image\]\([^)]*\)|<(?:file|audio|video|media|sticker|folder)\b[^>]*/>|\[(?:image|file)\]")
# A name after "@" in an answer, up to a space or punctuation.
NAMED = re.compile(r"@([^\s@，。,.:：;；!！?？、()（）<>]{1,20})")
EVERYONE = ("所有人", "all")


def cut(text: str) -> str:
    return text if len(text) <= MAX_REPLY_CHARS else text[:MAX_REPLY_CHARS].rstrip() + CUT_NOTE


def safe_name(name: str) -> str:
    name = re.sub(r"[^\w.\-一-鿿]+", "_", Path(name).name)[:80].strip("._")
    return name or "file"


def sent_name(stored: str) -> str:
    """A sent file's own name: FluidForm stores it as <8 hex>-<name>."""
    return re.sub(r"^[0-9a-f]{8}-", "", stored) or stored


def picture(head: bytes) -> bool:
    """Whether a file is a picture Feishu shows, by its first bytes, not its name."""
    return head.startswith((b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff", b"GIF87a", b"GIF89a")) or \
        (head[:4] == b"RIFF" and head[8:12] == b"WEBP")


def words(text: str) -> str:
    """A message's words: the SDK's text without the marks of its pictures and files."""
    return re.sub(r"[ \t]+\n", "\n", MEDIA_MARK.sub("", text or "")).strip()


def spaced(text: str, names) -> str:
    """``text`` with a space around each "@name" of someone known: Chinese runs a name into what is
    around it ("好，@张三你看下"), and the SDK reads a mention only from a space to a space."""
    known = sorted((name for name in names if name), key=len, reverse=True)
    if not known:
        return text
    pattern = re.compile("@(" + "|".join(re.escape(name) for name in known) + ")")

    def space(found) -> str:
        # The longest name wins ("@张三丰" is not "@张三" + "丰").
        before, after = text[found.start() - 1:found.start()], text[found.end():found.end() + 1]
        return ((" " if before and not before.isspace() else "") + found.group(0)
                + (" " if after and not after.isspace() else ""))
    return pattern.sub(space, text)


def card_mentions(text: str) -> str:
    """Mentions as a card's Markdown writes them (``<at id=…></at>``), not a message's."""
    return re.sub(r'<at user_id="([^"]+)">[^<]*</at>', r"<at id=\1></at>", text)


@dataclass
class Piece:
    """One message to pass on: its words, its pictures and files (type, key, name), and whether it
    called on the bot (False: said in a group without @ it, for FluidForm to decide)."""
    message_id: str
    text: str
    resources: list = field(default_factory=list)
    addressed: bool = True


def merged(pieces: list) -> Piece:
    """Several messages one person sent in a row, as one, under the last of them: their words line
    by line, their pictures and files together; called on if any of them was."""
    texts = [piece.text for piece in pieces if piece.text]
    resources = [item for piece in pieces for item in piece.resources][:MAX_FILES]
    return Piece(pieces[-1].message_id, "\n".join(texts), resources, any(piece.addressed for piece in pieces))


class Gather:
    """Holds what one person sends in one chat until they stop for ``seconds``, then hands it on
    once: ``ready(key, pieces)``, oldest first. Each new message starts the wait again."""

    def __init__(self, ready, seconds: float = GATHER_SECONDS):
        self.ready, self.seconds = ready, seconds
        self.waiting: dict = {}

    def add(self, key, piece) -> None:
        pieces, timer = self.waiting.get(key, ([], None))
        if timer:
            timer.cancel()
        loop = asyncio.get_running_loop()
        self.waiting[key] = ([*pieces, piece], loop.call_later(self.seconds, self._done, key))

    def _done(self, key) -> None:
        pieces, _ = self.waiting.pop(key, ([], None))
        if pieces:
            asyncio.ensure_future(self.ready(key, pieces))


class Aliases:
    """成员N for each person whose name Feishu does not give (the members list needs a permission),
    per chat, kept in the data folder so they stay the same after a restart."""

    def __init__(self, folder: Path):
        self.path = folder / "aliases.json"
        try:
            self.chats = {chat: dict(names) for chat, names in json.loads(self.path.read_text()).items()}
        except (OSError, ValueError, AttributeError):
            self.chats = {}

    def name_of(self, chat_id: str, open_id: str) -> str:
        kept = self.chats.setdefault(chat_id, {})
        if open_id not in kept:
            kept[open_id] = f"成员{len(kept) + 1}"
            self.path.write_text(json.dumps(self.chats, ensure_ascii=False))
        return kept[open_id]

    def known(self, chat_id: str) -> dict:
        return {alias: open_id for open_id, alias in self.chats.get(chat_id, {}).items()}


def roster(members, aliases: dict) -> dict:
    """Name -> open_id of a chat's people: Feishu's names (one two people share is left out, never
    guessed), their 成员N, and everyone."""
    count: dict = {}
    for member in members:
        count[member.name] = count.get(member.name, 0) + 1
    named = {member.name: member.id for member in members if member.name and count[member.name] == 1}
    return {**{name: "all" for name in EVERYONE}, **aliases, **named}


class Host:
    """FluidForm, over stdin and stdout."""

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
        """FluidForm's answer, and the files to send with it (paths in the data folder); ``heard``
        hears the answer as it is being written ({"progress": ...}); ``people``: the names of the
        group's people, so the answer can @ them."""
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
                self.on_event(payload)
        os._exit(0)  # FluidForm has gone


class StatusLog(logging.Handler):
    """The SDK's warnings and errors, as the status FluidForm shows. Its info lines are not taken:
    the connection's address carries its ticket."""

    def __init__(self, host: Host):
        super().__init__(logging.WARNING)
        self.host = host

    def emit(self, record: logging.LogRecord) -> None:
        self.host.status(f"连接有问题：{record.getMessage()[:150]}")


class Reply:
    """An answer as it is written: one streaming card (the SDK's CardKit typewriter) that each
    piece rewrites, finished with the whole answer. ``finish`` returns False when no card could be
    made, so the answer is sent as a plain message instead."""

    def __init__(self, channel, chat_id: str, message_id: str, mark):
        self.channel, self.chat_id, self.message_id, self.mark = channel, chat_id, message_id, mark
        self.queue: asyncio.Queue = asyncio.Queue()
        self.task: Optional[asyncio.Task] = None

    def heard(self, text: str) -> None:
        if self.task is None:
            self.task = asyncio.ensure_future(self._stream())
        self.queue.put_nowait(text)

    async def _stream(self) -> None:
        async def producer(stream) -> None:
            while (text := await self.queue.get()) is not None:
                await stream.set_content(card_mentions(self.mark(cut(text))))
        await self.channel.stream(self.chat_id, {"markdown": producer}, {"reply_to": self.message_id})

    async def finish(self, text: str) -> bool:
        self.heard(text)
        self.queue.put_nowait(None)
        try:
            await self.task
            return True
        except Exception as exc:
            print(f"飞书卡片回复失败：{exc}", file=sys.stderr, flush=True)
            return False


def main() -> None:
    from lark_channel import FeishuChannel
    from lark_channel.core.enum import LogLevel
    from lark_channel.channel.config import (
        ChannelConfig, MediaCacheConfig, PolicyConfig, SafetyConfig, TextBatchConfig, TransportConfig,
    )
    from lark_channel.channel.outbound.markdown.resolve_mentions import resolve_mentions_in_text

    data = Path(os.environ.get("SP_DATA_DIR", "."))
    config = ChannelConfig(
        app_id=os.environ["FEISHU_APP_ID"], app_secret=os.environ["FEISHU_APP_SECRET"],
        # Its info lines include the connection's address with its ticket.
        log_level=LogLevel.WARNING,
        # The sandbox's proxy is the only way out.
        transport=TransportConfig(proxy_url=os.environ.get("HTTPS_PROXY") or None, trust_env_proxy=False),
        # Every message comes in; whether one in a group is meant for it, FluidForm decides.
        policy=PolicyConfig(require_mention=False),
        # Merging is per person (Gather); the SDK keeps dropping what was delivered twice.
        safety=SafetyConfig(text_batch=TextBatchConfig(max_messages=1)),
        media_cache=MediaCacheConfig(enabled=False),
        resolve_sender_names=True,
    )
    channel = FeishuChannel(config=config)
    aliases = Aliases(data)
    started = time.time()
    loop: Optional[asyncio.AbstractEventLoop] = None

    async def people(chat_id: str) -> dict:
        """Who is in a group, name -> open_id (the SDK caches it)."""
        try:
            members = await channel.get_chat_members(chat_id)
        except Exception as exc:
            print(f"读不到群成员（需要「查看群成员」权限 im:chat.members:read）：{exc}", file=sys.stderr, flush=True)
            members = []
        return roster(members, aliases.known(chat_id))

    def marker(known: dict):
        """Each "@name" of someone known, a real @."""
        return lambda text: resolve_mentions_in_text(spaced(text, known), known.get)

    async def send_text(chat_id: str, message_id: str, text: str, mark=lambda text: text) -> None:
        try:
            await channel.send(chat_id, {"markdown": mark(cut(text))}, {"reply_to": message_id})
        except Exception as exc:
            print(f"飞书回复失败：{exc}", file=sys.stderr, flush=True)

    async def send_files(chat_id: str, message_id: str, sent: list) -> None:
        """The files FluidForm sent with an answer, each replied under the message: a picture as a
        picture (as a file if Feishu will not take it as one), anything else as a file. Removed
        once sent, or once it could not be."""
        outbox = (data / OUTBOX).resolve()
        for relative in sent[:MAX_FILES]:
            path = (data / relative).resolve()
            if outbox not in path.parents or not path.is_file():
                continue
            name = sent_name(path.name)
            try:
                if picture(path.read_bytes()[:16]):
                    result = await channel.send(chat_id, {"image": {"source": str(path)}}, {"reply_to": message_id})
                    if getattr(result, "success", False):
                        continue
                await channel.send(chat_id, {"file": {"source": str(path), "file_name": name}}, {"reply_to": message_id})
            except Exception as exc:
                print(f"飞书发送文件失败（{name}）：{exc}", file=sys.stderr, flush=True)
            finally:
                path.unlink(missing_ok=True)

    async def download(message_id: str, kind: str, key: str, name: str) -> Optional[str]:
        """A picture or file of the message, saved in the inbox; its path there, or None."""
        try:
            body = await channel.download_resource(key, kind, message_id)
        except Exception as exc:
            body = None
            print(f"飞书{'图片' if kind == 'image' else '文件'}下载失败：{exc}", file=sys.stderr, flush=True)
        if not body:
            return None
        relative = f"{INBOX}/{safe_name(message_id)}-{uuid.uuid4().hex[:8]}-{safe_name(name)}"
        (data / INBOX).mkdir(exist_ok=True)
        (data / relative).write_bytes(body)
        return relative

    async def answer(chat_id: str, chat_type: str, sender: str, piece: Piece) -> None:
        group = chat_type == "group"
        known = await people(chat_id) if group else {}
        mark = marker(known)
        names = [item for item in await asyncio.gather(*[download(piece.message_id, kind, key, name)
                                                         for kind, key, name in piece.resources]) if item]
        if piece.addressed and not piece.text and not names and piece.resources:
            await send_text(chat_id, piece.message_id, "图片或文件没能下载下来：请主人检查应用是否开通了「获取与上传图片或文件资源」权限。")
            return
        if not piece.addressed and not piece.text and not names:
            return
        # Being answered: Feishu's "typing" reaction on the message; not before FluidForm decides
        # that one said in a group without @ it is meant for it.
        typing = await channel.add_typing_reaction(piece.message_id) if piece.addressed else None
        try:
            reply = Reply(channel, chat_id, piece.message_id, mark)
            origin = {"message_id": piece.message_id, "chat_id": chat_id, **({"chat_type": chat_type} if chat_type else {})}
            heard = lambda text: loop.call_soon_threadsafe(reply.heard, text)  # noqa: E731
            result, files = await asyncio.to_thread(
                host.ask, chat_id, piece.text, origin, tuple(names), heard, piece.addressed, sender,
                sorted(name for name in known if name not in EVERYONE and not re.fullmatch(r"成员\d+", name)))
            if result and not await reply.finish(result):
                await send_text(chat_id, piece.message_id, result, mark)
            elif not result and piece.addressed and not await reply.finish("（没有回答）"):
                await send_text(chat_id, piece.message_id, "（没有回答）")
            elif not result and reply.task:
                await reply.finish("（没有回答）")
            await send_files(chat_id, piece.message_id, files)
        finally:
            if typing:
                await channel.remove_typing_reaction(piece.message_id, typing)

    async def gathered(key, pieces) -> None:
        chat_id, chat_type, open_id, name = key
        sender = (name or aliases.name_of(chat_id, open_id)) if chat_type == "group" and open_id else ""
        await answer(chat_id, chat_type, sender, merged(pieces))

    gather = Gather(gathered)

    async def on_message(msg) -> None:
        if msg.sender_is_bot or msg.raw_content_type not in TYPES or msg.chat_type not in ("p2p", "group"):
            return
        if msg.create_time and msg.create_time / 1000 < started - BACKLOG_SECONDS:
            return  # the backlog from before it started
        addressed = msg.chat_type == "p2p" or msg.mentioned_bot
        # Its own @ goes; anyone else's stays as "@name", so what was said keeps its sense.
        text = words(msg.body_text if msg.mentioned_bot else msg.content_text)
        resources = [(item.type, item.file_key, item.file_name or ("image.png" if item.type == "image" else "file"))
                     for item in msg.resources or [] if item.type in ("image", "file") and item.file_key][:MAX_FILES]
        if not text and not resources and not (addressed and msg.raw_content_type in ("text", "post")):
            return  # only @ it, nothing else: still asked (FluidForm answers what came before)
        gather.add((msg.chat_id, msg.chat_type, msg.sender_id or "", msg.sender_name or ""),
                   Piece(msg.message_id, text, resources, addressed))

    def task_ended(payload: dict) -> None:
        origin = payload.get("origin") or {}
        if origin.get("message_id") and origin.get("chat_id") and loop:
            asyncio.run_coroutine_threadsafe(
                send_text(origin["chat_id"], origin["message_id"], str(payload.get("text") or "")), loop)

    host = Host(task_ended)
    channel.on("message", on_message)
    channel.on("reconnecting", lambda *_: host.status("连接断开，正在重连…"))
    channel.on("reconnected", lambda *_: host.status("已连接"))
    logging.getLogger("Lark").addHandler(StatusLog(host))

    async def run() -> None:
        nonlocal loop
        loop = asyncio.get_running_loop()
        threading.Thread(target=host.listen, name="host", daemon=True).start()
        host.status("正在连接飞书…")
        await channel.start_background(timeout=60)
        host.status("已连接")
        await asyncio.Event().wait()

    asyncio.run(run())


def check() -> None:
    """Without network: the SDK is installed, and what is passed on and how answers are marked."""
    import lark_channel  # noqa: F401
    from lark_channel.channel.outbound.markdown.resolve_mentions import resolve_mentions_in_text

    # A message's words, without the marks of its pictures and files.
    assert words("这张图里是什么？\n![image](img_1)") == "这张图里是什么？"
    assert words('<file key="f_1" name="报价.pdf"/>') == "" and words("[image]") == ""
    # "@name" in an answer @s that person for real, if the chat has shown who they are; a name run
    # into what follows too; a name two people share is not guessed; anyone else stays plain text.

    @dataclass
    class Member:
        id: str
        name: str

    known = roster([Member("ou_1", "张三"), Member("ou_2", "张三丰"), Member("ou_3", "李四"), Member("ou_4", "李四")],
                   {"成员1": "ou_9"})
    mark = lambda text: resolve_mentions_in_text(spaced(text, known), known.get)  # noqa: E731
    assert mark("@张三丰 和 @张三，看下") == '<at user_id="ou_2">张三丰</at> 和 <at user_id="ou_1">张三</at> ，看下'
    assert mark("@李四 在吗") == "@李四 在吗" and mark("@王五 在吗") == "@王五 在吗"
    assert mark("@成员1 好，@所有人 明天放假") == '<at user_id="ou_9">成员1</at> 好， <at user_id="all">所有人</at> 明天放假'
    assert card_mentions('<at user_id="ou_1">张三</at> 好') == "<at id=ou_1></at> 好"
    # Messages sent in a row are passed on once, together, after the sender stops; each person's apart.
    assert merged([Piece("m1", "我想问下"), Piece("m2", "", [("image", "img_1", "image.png")], False),
                   Piece("m3", "这是什么猫")]) == \
        Piece("m3", "我想问下\n这是什么猫", [("image", "img_1", "image.png")], True)

    async def gathering() -> list:
        handed = []

        async def ready(key, pieces):
            handed.append((key, [piece.text for piece in pieces]))
        gather = Gather(ready, seconds=0.1)
        for word in ("那个", "我想问下", "这是什么猫"):
            gather.add(("chat", "u1"), Piece("m", word))
            await asyncio.sleep(0.03)
        gather.add(("chat", "u2"), Piece("m", "你好"))
        await asyncio.sleep(0.3)
        return handed
    assert sorted(asyncio.run(gathering())) == [(("chat", "u1"), ["那个", "我想问下", "这是什么猫"]), (("chat", "u2"), ["你好"])]
    # Files: their own names, pictures known by their bytes, names made safe.
    assert sent_name("0a1b2c3d-猫.png") == "猫.png" and sent_name("cat.png") == "cat.png"
    assert picture(b"\x89PNG\r\n\x1a\n" + b"\0" * 8) and not picture(b"%PDF-1.7")
    assert safe_name("../../etc/passwd") == "passwd" and safe_name("a b/截图.png") == "截图.png"
    assert cut("x" * 4000).endswith(CUT_NOTE) and cut("短") == "短"
    # The 成员N of people Feishu does not name stay the same after a restart.
    import tempfile
    with tempfile.TemporaryDirectory() as folder:
        first = Aliases(Path(folder))
        assert first.name_of("oc_1", "ou_9") == "成员1" and first.name_of("oc_1", "ou_8") == "成员2"
        assert Aliases(Path(folder)).name_of("oc_1", "ou_9") == "成员1"
        assert Aliases(Path(folder)).known("oc_1") == {"成员1": "ou_9", "成员2": "ou_8"}
    print("ok")


if __name__ == "__main__":
    check() if "--check" in sys.argv else main()
