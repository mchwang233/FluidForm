"""Bounded HTTPS and RFC 6455 text frames through the capability's CONNECT proxy.

No redirects, compression or third-party dependencies. Addresses and credentials never
appear in an exception that is written to the host. See the package's design note.
"""
import base64
import hashlib
import http.client
import json
import os
import socket
import struct
from urllib.parse import unquote, urlsplit

MAX_BYTES = 1 << 20
API_HOSTS = {"api.dingtalk.com", "oapi.dingtalk.com"}
STREAM_HOST = "wss-open-connection.dingtalk.com"


class TransportError(Exception):
    pass


def address(url, stream=False):
    if not isinstance(url, str) or len(url) > 8192 or any(ord(c) < 33 for c in url):
        raise TransportError("无效的钉钉地址")
    try:
        parsed = urlsplit(url)
        hosts = {STREAM_HOST} if stream else API_HOSTS
        if (parsed.scheme != ("wss" if stream else "https") or parsed.hostname not in hosts
                or parsed.port not in (None, 443) or parsed.username is not None
                or parsed.password is not None or parsed.fragment):
            raise ValueError()
        return parsed
    except ValueError:
        raise TransportError("无效的钉钉地址") from None


def connection(host):
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    if not proxy:
        return http.client.HTTPSConnection(host, timeout=60)
    try:
        parsed = urlsplit(proxy)
        if parsed.scheme != "http" or not parsed.hostname or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
            raise ValueError()
        conn = http.client.HTTPSConnection(parsed.hostname, parsed.port or 80, timeout=60)
        headers = {}
        if parsed.username is not None:
            value = unquote(parsed.username) + ":" + unquote(parsed.password or "")
            headers["Proxy-Authorization"] = "Basic " + base64.b64encode(value.encode()).decode()
        # HTTPSConnection validates TLS against the tunnel destination, not the proxy.
        conn.set_tunnel(host, 443, headers)
        return conn
    except ValueError:
        raise TransportError("能力代理地址无效") from None


def path(parsed):
    return (parsed.path or "/") + ("?" + parsed.query if parsed.query else "")


def post(url, body, headers=None):
    parsed = address(url)
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    if len(data) > MAX_BYTES:
        raise TransportError("消息过长")
    conn = connection(parsed.hostname)
    try:
        conn.request("POST", path(parsed), data, {"Content-Type": "application/json", **(headers or {})})
        response = conn.getresponse()
        if not 200 <= response.status < 300:
            raise TransportError("钉钉请求未成功")
        raw = response.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise TransportError("钉钉响应过长")
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise TransportError("钉钉响应格式无效")
        return result
    finally:
        conn.close()


class WebSocket:
    def __init__(self, url):
        parsed = address(url, stream=True)
        self.conn = connection(parsed.hostname)
        self.reader = None
        try:
            self.conn.connect()
            self.sock = self.conn.sock
            key = base64.b64encode(os.urandom(16)).decode()
            request = ("GET " + path(parsed) + " HTTP/1.1\r\nHost: " + parsed.hostname
                       + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13"
                       + "\r\nSec-WebSocket-Key: " + key + "\r\n\r\n")
            self.sock.sendall(request.encode("ascii"))
            response = http.client.HTTPResponse(self.sock)
            self.response = response  # Own the buffered reader until the connection closes.
            response.begin()
            expected = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            if (response.status != 101 or response.getheader("Sec-WebSocket-Accept") != expected
                    or response.getheader("Upgrade", "").lower() != "websocket"
                    or "upgrade" not in [part.strip().lower() for part in response.getheader("Connection", "").split(",")]
                    or response.getheader("Sec-WebSocket-Extensions")):
                response.close()
                raise TransportError("钉钉连接握手失败")
            self.reader = response.fp
        except Exception:
            self.conn.close()
            raise

    def close(self):
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        if self.reader:
            self.reader.close()
        self.conn.close()

    def exact(self, count):
        data = self.reader.read(count)
        if len(data) != count:
            raise TransportError("钉钉连接已断开")
        return data

    def frame(self, opcode, payload):
        size = len(payload)
        if size > MAX_BYTES:
            raise TransportError("消息过长")
        length = bytes([0x80 | size]) if size < 126 else (
            bytes([0x80 | 126]) + struct.pack("!H", size) if size < 65536
            else bytes([0x80 | 127]) + struct.pack("!Q", size))
        mask = os.urandom(4)
        masked = bytes(value ^ mask[i % 4] for i, value in enumerate(payload))
        self.sock.sendall(bytes([0x80 | opcode]) + length + mask + masked)

    def send(self, message):
        self.frame(1, json.dumps(message, ensure_ascii=False).encode("utf-8"))

    def receive(self):
        chunks = bytearray()
        fragmented = False
        while True:
            first, second = self.exact(2)
            final, opcode = bool(first & 0x80), first & 15
            if first & 0x70 or second & 0x80:
                raise TransportError("钉钉消息帧无效")
            size = second & 127
            if size == 126:
                size = struct.unpack("!H", self.exact(2))[0]
            elif size == 127:
                size = struct.unpack("!Q", self.exact(8))[0]
            if size > MAX_BYTES or (opcode >= 8 and (not final or size > 125)):
                raise TransportError("钉钉消息帧过长或无效")
            if opcode < 8 and len(chunks) + size > MAX_BYTES:
                raise TransportError("钉钉消息过长")
            payload = self.exact(size)
            if opcode == 8:
                raise TransportError("钉钉连接已关闭")
            if opcode == 9:
                self.frame(10, payload)
                continue
            if opcode == 10:
                continue
            if opcode not in (0, 1) or (opcode == 0) != fragmented:
                raise TransportError("钉钉消息帧顺序无效")
            chunks.extend(payload)
            if final:
                result = json.loads(chunks.decode("utf-8"))
                if not isinstance(result, dict):
                    raise TransportError("钉钉消息格式无效")
                return result
            fragmented = True
