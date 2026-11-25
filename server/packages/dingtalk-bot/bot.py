"""DingTalk Stream <-> FluidForm automation JSON lines. Text messages only.

The host owns conversations, task approval and cancellation. Webhooks, tickets and
access tokens stay in this process, never in origin, stdout, logs or files.
"""
import hashlib
import json
import os
import queue
import random
import signal
import sys
import threading
import time
from collections import OrderedDict
from urllib.parse import urlencode

from transport import MAX_BYTES, TransportError, WebSocket, address, post

TOPIC = "/v1.0/im/bot/messages/get"
API = "https://api.dingtalk.com/v1.0"
MAX_PENDING = 256
MAX_SEEN = 4096
MAX_TEXT = 20000
FILE_NOTE = "文件请到 FluidForm 网页中查看；钉钉暂只发送文字。"


def string(value, limit=1024):
    return value if isinstance(value, str) and len(value) <= limit else ""


def successful(result):
    if result.get("errcode", 0) not in (0, "0") or result.get("code", 0) not in (0, "0", "", None):
        raise TransportError("钉钉拒绝了请求，请检查应用权限和配置")
    return result


def chunks(text):
    """Keep each text below the API byte limit, without splitting a UTF-8 character."""
    part, size = [], 0
    for char in text:
        count = len(char.encode("utf-8"))
        if size + count > 3000:
            yield "".join(part)
            part, size = [], 0
        part.append(char)
        size += count
    if part:
        yield "".join(part)


class DingTalk:
    def __init__(self, client_id, client_secret, request=post, clock=time.time):
        self.client_id, self.client_secret = client_id, client_secret
        self.request, self.clock = request, clock
        self.token, self.expires = "", 0

    def open(self):
        result = successful(self.request(API + "/gateway/connections/open", {
            "clientId": self.client_id, "clientSecret": self.client_secret,
            "subscriptions": [{"type": "CALLBACK", "topic": TOPIC}],
            "ua": "fluidform-dingtalk/1.0"}))
        endpoint, ticket = result.get("endpoint"), string(result.get("ticket"), 4096)
        parsed = address(endpoint, stream=True)
        if not ticket:
            raise TransportError("钉钉未返回连接凭证")
        return endpoint + ("&" if parsed.query else "?") + urlencode({"ticket": ticket})

    def access_token(self):
        if not self.token or self.expires <= self.clock():
            result = successful(self.request(API + "/oauth2/accessToken", {
                "appKey": self.client_id, "appSecret": self.client_secret}))
            token = string(result.get("accessToken"), 8192)
            duration = result.get("expireIn")
            if not token or not isinstance(duration, (int, float)) or duration <= 0:
                raise TransportError("钉钉未返回访问凭证")
            self.token, self.expires = token, self.clock() + max(0, duration - 60)
        return self.token

    def send(self, route, text):
        for part in chunks(text):
            hook = route.get("webhook")
            if hook and route.get("expires", 0) > self.clock() * 1000:
                parsed = address(hook)
                if parsed.hostname != "oapi.dingtalk.com" or parsed.path != "/robot/sendBySession":
                    raise TransportError("钉钉会话地址无效")
                result = self.request(hook, {"msgtype": "text", "text": {"content": part}})
                if result.get("errcode") in (0, "0"):
                    continue
                # A definite refusal (e.g. an expired session) can use the official send API.
                if "errcode" not in result:
                    raise TransportError("钉钉未确认回复")
            body = {"robotCode": self.client_id, "msgKey": "sampleText",
                    "msgParam": json.dumps({"content": part}, ensure_ascii=False)}
            if route.get("chat_type") == "group" and route.get("conversation_id"):
                endpoint = "/robot/groupMessages/send"
                body["openConversationId"] = route["conversation_id"]
            elif route.get("chat_type") == "p2p" and route.get("user_id"):
                endpoint = "/robot/oToMessages/batchSend"
                body["userIds"] = [route["user_id"]]
            else:
                raise TransportError("钉钉缺少收件人信息，请发布企业应用后重试")
            result = successful(self.request(API + endpoint, body,
                {"x-acs-dingtalk-access-token": self.access_token()}))
            if not result.get("processQueryKey") or result.get("invalidStaffIdList") or result.get("flowControlledStaffIdList"):
                raise TransportError("钉钉未接受消息，请检查应用范围、权限或限流")


class Bridge:
    def __init__(self, emit, send, clock=time.time):
        self.emit, self.send, self.clock = emit, send, clock
        self.pending, self.seen = {}, OrderedDict()
        self.lock = threading.Lock()

    def receive(self, body):
        if not isinstance(body, dict):
            return
        kind = string(body.get("conversationType"))
        conversation = string(body.get("conversationId"))
        mid = string(body.get("msgId"))
        sender = string(body.get("senderStaffId")) or string(body.get("senderId"))
        if kind not in ("1", "2") or not conversation or not mid or not sender:
            return
        identity = json.dumps([string(body.get("chatbotCorpId")), kind, conversation], ensure_ascii=False)
        # The host bounds conversation names to 200 characters. Hash the full identity
        # so long IDs cannot collide after that truncation.
        scope = "dingtalk:" + hashlib.sha256(identity.encode("utf-8")).hexdigest()
        key = json.dumps([scope, mid], ensure_ascii=False)
        origin = {"chat_type": "group" if kind == "2" else "p2p", "conversation_id": conversation,
                  "user_id": string(body.get("senderStaffId")), "message_id": mid}
        route = dict(origin)
        hook, expires = body.get("sessionWebhook"), body.get("sessionWebhookExpiredTime")
        if hook:
            parsed = address(hook)
            if parsed.hostname != "oapi.dingtalk.com" or parsed.path != "/robot/sendBySession":
                raise TransportError("钉钉会话地址无效")
            if isinstance(expires, (int, float)):
                route.update(webhook=hook, expires=expires)
        with self.lock:
            cutoff = self.clock() - 7200
            while self.seen and next(iter(self.seen.values())) < cutoff:
                self.seen.popitem(last=False)
            if key in self.seen:
                return
            if len(self.pending) >= MAX_PENDING:
                raise TransportError("待回复消息过多")
            # The host replies promptly to superseded, /stop and /new messages too.
            self.pending[key] = route
            self.seen[key] = self.clock()
            if len(self.seen) > MAX_SEEN:
                self.seen.popitem(last=False)
        try:
            if body.get("msgtype") != "text":
                note = "目前只支持文字，请用文字描述你的问题。" if kind == "1" or body.get("isInAtList") is True else None
                self.reply({"re": key, "reply": note})
                return
            content = body.get("text")
            text = content.get("content") if isinstance(content, dict) else None
            if not isinstance(text, str) or len(text) > MAX_TEXT:
                self.reply({"re": key, "reply": "这条消息过长或格式不正确，请分段发送文字。"})
                return
            self.emit({"op": "message", "id": key, "conversation": scope, "text": text.strip(),
                       "sender": string(body.get("senderNick"), 200), "sender_id": sender,
                       "addressed": kind == "1" or body.get("isInAtList") is True, "origin": origin})
        except Exception:
            with self.lock:
                self.pending.pop(key, None)
                self.seen.pop(key, None)
            raise

    def reply(self, event):
        if not isinstance(event, dict) or "progress" in event:
            return
        if "re" in event:
            with self.lock:
                route = self.pending.pop(string(event["re"], 8192), None)
            if route is None or event.get("reply") is None or event.get("superseded"):
                return
            text = string(event.get("reply"), MAX_BYTES)
        elif event.get("event") in ("task_ended", "task_question") and isinstance(event.get("origin"), dict):
            # No saved webhook needed: notifications survive an adapter restart.
            origin = event["origin"]
            route = {key: string(origin.get(key)) for key in ("chat_type", "conversation_id", "user_id")}
            text = string(event.get("text"), MAX_BYTES)
        else:
            return
        if event.get("files"):
            text += ("\n\n" if text else "") + FILE_NOTE
        if text:
            self.send(route, text)


def acknowledge(frame, bridge):
    headers = frame.get("headers")
    if not isinstance(headers, dict):
        return None
    topic, kind = headers.get("topic"), frame.get("type")
    if kind == "SYSTEM" and topic == "disconnect":
        raise TransportError("钉钉要求重新连接")
    if kind == "SYSTEM" and topic == "ping":
        data = json.loads(frame.get("data", "{}"))
    elif kind == "CALLBACK" and topic == TOPIC:
        bridge.receive(json.loads(frame.get("data", "{}")))
        data = {"response": None}
    else:
        return None
    return {"code": 200, "headers": {"contentType": "application/json", "messageId": headers.get("messageId", "")},
            "message": "OK", "data": json.dumps(data, ensure_ascii=False)}


def run(client, emit, incoming=sys.stdin, connect=WebSocket):
    stop = threading.Event()
    outgoing = queue.Queue(maxsize=MAX_PENDING)
    bridge = Bridge(emit, lambda route, text: outgoing.put_nowait((route, text)))

    def listen():
        try:
            while not stop.is_set():
                line = incoming.readline(MAX_BYTES + 1)
                if not line:
                    break
                if len(line.encode("utf-8")) > MAX_BYTES:
                    emit({"op": "status", "text": "FluidForm 消息过长，已停止连接"})
                    break
                try:
                    bridge.reply(json.loads(line))
                except Exception:
                    emit({"op": "status", "text": "未能处理 FluidForm 的回复，请重试"})
        finally:
            stop.set()

    def deliver():
        while not stop.is_set():
            try:
                route, text = outgoing.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                client.send(route, text)
            except Exception:
                # Never log a response body, exception or URL: they can contain tokens.
                emit({"op": "status", "text": "钉钉发送失败，请检查应用权限、发布范围或连接后重试"})

    threading.Thread(target=listen, daemon=True).start()
    threading.Thread(target=deliver, daemon=True).start()
    delay = 1
    while not stop.is_set():
        ws = None
        try:
            ws = connect(client.open())
            started = time.monotonic()
            emit({"op": "status", "text": "钉钉已连接"})
            while not stop.is_set():
                response = acknowledge(ws.receive(), bridge)
                if response is not None:
                    ws.send(response)
        except Exception:
            if not stop.is_set():
                emit({"op": "status", "text": "钉钉连接中断，正在重连；持续失败时请检查应用配置"})
        finally:
            if ws is not None:
                ws.close()
                if time.monotonic() - started > 60:
                    delay = 1
        stop.wait(delay + random.random())
        delay = min(delay * 2, 60)


def main():
    output_lock = threading.Lock()

    def emit(value):
        with output_lock:
            print(json.dumps(value, ensure_ascii=False), flush=True)

    client_id, client_secret = os.environ.get("DINGTALK_CLIENT_ID"), os.environ.get("DINGTALK_CLIENT_SECRET")
    if not client_id or not client_secret:
        emit({"op": "status", "text": "请在能力页面填写钉钉应用凭据"})
        return
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    run(DingTalk(client_id, client_secret), emit)


if __name__ == "__main__":
    main()
