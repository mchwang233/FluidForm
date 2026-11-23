"""Offline install check. All network and host output are replaced with local doubles."""
import base64
import hashlib
import io
import json
import os
import struct
import unittest
from unittest.mock import patch

from bot import API, TOPIC, MAX_PENDING, Bridge, DingTalk, acknowledge, chunks
import transport


def message(**fields):
    return {"conversationId": "conversation", "conversationType": "1", "msgId": "message",
            "senderStaffId": "person", "senderId": "encrypted-person", "senderNick": "小林",
            "chatbotCorpId": "corp", "msgtype": "text", "text": {"content": " 你好 "},
            "sessionWebhook": "https://oapi.dingtalk.com/robot/sendBySession?session=test-only-secret",
            "sessionWebhookExpiredTime": 9000000, **fields}


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.messages, self.sent = [], []
        self.bridge = Bridge(self.messages.append, lambda route, text: self.sent.append((route, text)), clock=lambda: 100)

    def test_callback_ack_deduplication_and_secret_free_origin(self):
        frame = {"type": "CALLBACK", "headers": {"topic": TOPIC, "messageId": "callback"}, "data": json.dumps(message())}
        for _ in range(2):
            response = acknowledge(frame, self.bridge)
            self.assertEqual(response["code"], 200)
            self.assertEqual(response["headers"]["messageId"], "callback")
        self.assertEqual(len(self.messages), 1)
        asked = self.messages[0]
        self.assertEqual(asked["text"], "你好")
        self.assertEqual(asked["sender_id"], "person")
        self.assertTrue(asked["addressed"])
        self.assertEqual(asked["origin"]["chat_type"], "p2p")
        self.assertNotIn("secret", json.dumps(asked))
        self.bridge.reply({"progress": asked["id"], "text": "draft"})
        self.assertFalse(self.sent)
        self.bridge.reply({"re": asked["id"], "reply": "你好！"})
        self.assertEqual(self.sent[0][1], "你好！")
        self.assertIn("webhook", self.sent[0][0])
        self.bridge.reply({"re": asked["id"], "reply": "重复回复"})
        self.assertEqual(len(self.sent), 1)
        self.assertFalse(self.bridge.pending)

    def test_group_identity_conversation_isolation_and_commands(self):
        for n, command in enumerate(["问题", "/new", "/stop", "/status", "开始", "取消"]):
            self.bridge.receive(message(msgId=str(n), conversationType="2", isInAtList=True, text={"content": command}))
        self.assertEqual([m["text"] for m in self.messages], ["问题", "/new", "/stop", "/status", "开始", "取消"])
        self.assertEqual(len({m["conversation"] for m in self.messages}), 1)
        self.assertTrue(all(m["origin"]["chat_type"] == "group" and m["sender_id"] == "person" for m in self.messages))
        self.bridge.receive(message(msgId="0", conversationType="2", conversationId="other", isInAtList=False))
        self.assertFalse(self.messages[-1]["addressed"])
        self.assertNotEqual(self.messages[-1]["conversation"], self.messages[0]["conversation"])
        self.bridge.receive(message(msgId="same", senderStaffId="", senderId="encrypted"))
        self.assertEqual(self.messages[-1]["sender_id"], "encrypted")
        for suffix in ["a", "b"]:
            self.bridge.receive(message(msgId="same", conversationId="long" * 200 + suffix))
        self.assertNotEqual(self.messages[-2]["conversation"], self.messages[-1]["conversation"])
        self.assertLess(len(self.messages[-1]["conversation"]), 200)

    def test_superseded_null_and_nontext_messages(self):
        self.bridge.receive(message())
        self.bridge.reply({"re": self.messages[0]["id"], "reply": None, "superseded": True})
        self.assertFalse(self.sent)
        self.assertFalse(self.bridge.pending)
        self.bridge.receive(message(msgId="image", msgtype="picture"))
        self.assertEqual(len(self.messages), 1, "an unsupported attachment must not become a model prompt")
        self.assertIn("只支持文字", self.sent[0][1])
        self.bridge.receive(message(msgId="big", text={"content": "字" * 20001}))
        self.assertIn("过长", self.sent[-1][1])

    def test_notification_after_restart_uses_only_nonsecret_route(self):
        self.bridge.receive(message())
        origin = self.messages[0]["origin"]
        restarted = Bridge(lambda _: None, lambda route, text: self.sent.append((route, text)))
        restarted.reply({"event": "task_ended", "origin": origin, "text": "完成了", "files": ["unused-file"]})
        self.assertEqual(self.sent[0][0], {"chat_type": "p2p", "conversation_id": "conversation", "user_id": "person"})
        self.assertIn("完成了", self.sent[0][1])
        self.assertIn("网页", self.sent[0][1])
        self.assertNotIn("unused-file", self.sent[0][1])

    def test_invalid_data_is_bounded_and_failures_are_not_acknowledged(self):
        for bad in [None, [], {}, message(msgId=""), message(senderStaffId="", senderId="")]:
            self.bridge.receive(bad)
        self.assertFalse(self.messages)
        for url in ["http://oapi.dingtalk.com/robot/sendBySession", "https://example.com/", "https://oapi.dingtalk.com/other"]:
            with self.assertRaises(transport.TransportError):
                self.bridge.receive(message(sessionWebhook=url))
        for n in range(MAX_PENDING):
            self.bridge.receive(message(msgId=str(n)))
        with self.assertRaises(transport.TransportError):
            acknowledge({"type": "CALLBACK", "headers": {"topic": TOPIC}, "data": json.dumps(message(msgId="overflow"))}, self.bridge)
        self.assertEqual(len(self.bridge.pending), MAX_PENDING)
        failing = Bridge(lambda _: (_ for _ in ()).throw(OSError()), lambda *_: None)
        with self.assertRaises(OSError):
            failing.receive(message())
        self.assertFalse(failing.seen)

    def test_system_ping_and_disconnect(self):
        ack = acknowledge({"type": "SYSTEM", "headers": {"topic": "ping", "messageId": "p"},
                           "data": '{"opaque":"alive"}'}, self.bridge)
        self.assertEqual(json.loads(ack["data"]), {"opaque": "alive"})
        with self.assertRaises(transport.TransportError):
            acknowledge({"type": "SYSTEM", "headers": {"topic": "disconnect"}}, self.bridge)
        self.assertIsNone(acknowledge({"type": "EVENT", "headers": {"topic": "other"}}, self.bridge))

    def test_official_open_reply_and_delayed_send_shapes(self):
        calls = []
        now = [100]

        def request(url, body, headers=None):
            calls.append((url, body, headers))
            if url.endswith("/open"):
                return {"endpoint": "wss://wss-open-connection.dingtalk.com/connect", "ticket": "a+b&c"}
            if url.endswith("/accessToken"):
                return {"accessToken": "test-token", "expireIn": 7200}
            if "sendBySession" in url:
                return {"errcode": 0}
            return {"processQueryKey": "accepted"}

        client = DingTalk("client", "test-secret", request, clock=lambda: now[0])
        self.assertTrue(client.open().endswith("ticket=a%2Bb%26c"))
        self.assertEqual(calls[-1][1]["subscriptions"], [{"type": "CALLBACK", "topic": TOPIC}])
        self.bridge.receive(message())
        route = next(iter(self.bridge.pending.values()))
        client.send(route, "hi")
        self.assertEqual(calls[-1][1], {"msgtype": "text", "text": {"content": "hi"}})
        now[0] = 10000
        client.send(route, "long task result")
        self.assertTrue(calls[-1][0].endswith("/robot/oToMessages/batchSend"))
        self.assertEqual(calls[-1][1]["userIds"], ["person"])
        self.assertEqual(calls[-1][2], {"x-acs-dingtalk-access-token": "test-token"})
        client.send({"chat_type": "group", "conversation_id": "group"}, "完成")
        self.assertTrue(calls[-1][0].endswith("/robot/groupMessages/send"))
        self.assertEqual(calls[-1][1]["openConversationId"], "group")
        self.assertEqual(calls[-1][1]["msgKey"], "sampleText")
        self.assertEqual(json.loads(calls[-1][1]["msgParam"]), {"content": "完成"})
        self.assertEqual(sum(url.endswith("/accessToken") for url, _, _ in calls), 1)
        now[0] += 7200
        client.send({"chat_type": "group", "conversation_id": "group"}, "again")
        self.assertEqual(sum(url.endswith("/accessToken") for url, _, _ in calls), 2)

    def test_rejected_sends_and_multibyte_chunks(self):
        client = DingTalk("id", "secret", lambda *_: {"errcode": 400, "errmsg": "private"})
        with self.assertRaises(transport.TransportError) as raised:
            client.send({"chat_type": "group", "conversation_id": "group"}, "hi")
        self.assertNotIn("private", str(raised.exception))
        text = "中文🙂" * 2000
        parts = list(chunks(text))
        self.assertEqual("".join(parts), text)
        self.assertTrue(all(len(part.encode()) <= 3000 for part in parts))

    def test_refused_webhook_falls_back_but_uncertain_network_send_is_not_repeated(self):
        calls = []

        def request(url, *args):
            calls.append(url)
            if "sendBySession" in url:
                return {"errcode": 400, "errmsg": "do not log"}
            if url.endswith("/accessToken"):
                return {"accessToken": "fake", "expireIn": 7200}
            return {"processQueryKey": "sent"}

        self.bridge.receive(message())
        route = next(iter(self.bridge.pending.values()))
        client = DingTalk("id", "secret", request, clock=lambda: 100)
        client.send(route, "result")
        self.assertEqual(len(calls), 3)
        self.assertTrue(calls[-1].endswith("/robot/oToMessages/batchSend"))
        with patch.object(client, "request", side_effect=TimeoutError("secret")) as request:
            with self.assertRaises(TimeoutError):
                client.send(route, "result")
            self.assertEqual(request.call_count, 1)
        client.token, client.expires = "cached", 1000
        with patch.object(client, "request", return_value={"processQueryKey": "partial", "invalidStaffIdList": ["person"]}):
            with self.assertRaises(transport.TransportError):
                client.send({"chat_type": "p2p", "user_id": "person"}, "result")


class FakeSocket:
    def __init__(self, data=b""):
        self.data, self.sent = data, []

    def sendall(self, data):
        self.sent.append(data)

    def makefile(self, *_):
        key = self.sent[0].split(b"Sec-WebSocket-Key: ")[1].split(b"\r\n")[0]
        accept = base64.b64encode(hashlib.sha1(key + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
        return io.BytesIO(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "
                          + accept + b"\r\n\r\n" + self.data)

    def shutdown(self, *_):
        pass


def frame(data, opcode=1, final=True):
    size = len(data)
    length = bytes([size]) if size < 126 else b"\x7e" + struct.pack("!H", size)
    return bytes([(128 if final else 0) | opcode]) + length + data


class TransportTests(unittest.TestCase):
    def test_connect_proxy_for_https_and_websocket_and_no_redirects(self):
        sock = FakeSocket(frame(b'{"ok":true}'))
        with patch.dict(os.environ, {"HTTPS_PROXY": "http://proxy.invalid:8765"}, clear=True), \
                patch("transport.http.client.HTTPSConnection") as make:
            conn = make.return_value
            conn.sock = sock
            ws = transport.WebSocket("wss://wss-open-connection.dingtalk.com/connect?ticket=fake")
            make.assert_called_with("proxy.invalid", 8765, timeout=60)
            conn.set_tunnel.assert_called_with("wss-open-connection.dingtalk.com", 443, {})
            self.assertEqual(ws.receive(), {"ok": True})
            ws.close()
            conn.getresponse.return_value.status = 200
            conn.getresponse.return_value.read.return_value = b'{"errcode":0}'
            self.assertEqual(transport.post("https://api.dingtalk.com/path", {"x": 1}), {"errcode": 0})
            conn.set_tunnel.assert_called_with("api.dingtalk.com", 443, {})
            conn.getresponse.return_value.status = 302
            with self.assertRaises(transport.TransportError):
                transport.post("https://api.dingtalk.com/path", {})
            conn.getresponse.return_value.status = 200
            conn.getresponse.return_value.read.return_value = b" " * (transport.MAX_BYTES + 1)
            with self.assertRaises(transport.TransportError):
                transport.post("https://api.dingtalk.com/path", {})

    def test_fragmented_utf8_ping_pong_and_masked_client_frames(self):
        payload = json.dumps({"text": "你好"}, ensure_ascii=False).encode()
        ws = object.__new__(transport.WebSocket)
        ws.sock = FakeSocket()
        ws.reader = io.BytesIO(frame(payload[:11], final=False) + frame(b"ping", opcode=9) + frame(payload[11:], opcode=0))
        self.assertEqual(ws.receive(), {"text": "你好"})
        pong = ws.sock.sent[0]
        self.assertEqual(pong[0], 0x8a)
        self.assertTrue(pong[1] & 128)
        self.assertEqual(bytes(value ^ pong[2 + i % 4] for i, value in enumerate(pong[6:])), b"ping")
        ws.send({"ok": True})
        self.assertEqual(ws.sock.sent[-1][0], 0x81)

    def test_invalid_hosts_frames_and_oversize(self):
        for url in ["https://example.com/", "https://api.dingtalk.com.evil.invalid/", "https://user@api.dingtalk.com/",
                    "https://api.dingtalk.com:444/", "http://api.dingtalk.com/", "https://api.dingtalk.com/\r\nX:"]:
            with self.assertRaises(transport.TransportError):
                transport.address(url)
        for data in [b"\x81\x7f" + struct.pack("!Q", transport.MAX_BYTES + 1), frame(b"{}", opcode=0),
                     b"\x81\x80", frame(b"ping", opcode=9, final=False), frame(b"{}", opcode=2), b""]:
            ws = object.__new__(transport.WebSocket)
            ws.reader, ws.sock = io.BytesIO(data), FakeSocket()
            with self.assertRaises(transport.TransportError):
                ws.receive()


if __name__ == "__main__":
    # An accidental unmocked network operation fails this check, even on a connected machine.
    with patch("socket.create_connection", side_effect=AssertionError("offline check attempted network")):
        result = unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.loadTestsFromModule(__import__(__name__)))
    if not result.wasSuccessful():
        raise SystemExit(1)
    print("DingTalk checks passed")
