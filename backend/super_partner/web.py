"""Searching the web and reading a page, for API models whose step or chat may use the internet
(the WebSearch and WebFetch tools, agent.py).

- WebSearch: ``settings.web_search_models`` lists the search services to use, first choice first
  (e.g. ``["glm:search_std"]``); empty: no such tool. Each provider's key is the one its chat
  models use (secrets.PROVIDER_ENV). Charged by the search.
- WebFetch (``settings.web_fetch``): a public http(s) page as text. Only public addresses: an
  address of this machine or its network is refused, after every redirect.

FluidForm itself makes these requests, so both are offered only to a step or chat that is allowed
the internet anyway (Workspace.network)."""
from __future__ import annotations

import asyncio
import ipaddress
import os
import re
import socket
from html.parser import HTMLParser
from typing import Optional
from urllib.parse import urljoin, urlsplit

import httpx

from .config import settings
from .secrets import PROVIDER_ENV

# What one search costs, in US dollars, by service; a service not listed costs DEFAULT_PRICE.
PRICES = {"glm:search_std": 0.005, "glm:search_pro": 0.01, "glm:search_pro_sogou": 0.01, "glm:search_pro_quark": 0.01}
DEFAULT_PRICE = 0.01
TIMEOUT_SECONDS = 30
MAX_RESULTS = 10
MAX_PAGE_BYTES = 3 * 1024 * 1024
MAX_PAGE_CHARS = 40_000
MAX_REDIRECTS = 5

SEARCH_TOOL = {
    "name": "WebSearch",
    "description": (
        "Searches the web and returns the top results: title, address, date and an excerpt.\n"
        "- Use it for anything current or that you do not know for sure: news, prices, weather, "
        "versions, documentation. Then WebFetch a result to read it in full, if you need to.\n"
        "- It costs money per search: search for what you need, not again for the same thing.\n"
        "- Say where what you found comes from (its address)."
    ),
    "parameters": {"type": "object", "properties": {
        "query": {"type": "string", "description": "What to search for, in the language of what you want to find"},
        "count": {"type": "integer", "description": f"How many results, 1 to {MAX_RESULTS} (default 5)"},
    }, "required": ["query"]},
}
FETCH_TOOL = {
    "name": "WebFetch",
    "description": (
        "Reads a public web page and returns its text (an HTML page without its markup; JSON or text "
        "as it is). Long pages are cut. Pages that need a login or JavaScript may come back empty."
    ),
    "parameters": {"type": "object", "properties": {
        "url": {"type": "string", "description": "The page's full address, http or https"},
    }, "required": ["url"]},
}


class WebError(RuntimeError):
    pass


def search_services() -> list[str]:
    """The search services that can be used now: listed, of a known provider, with its key."""
    return [service for service in settings.web_search_models
            if (provider := service.split(":", 1)[0]) in SEARCH and os.environ.get(PROVIDER_ENV.get(provider, ""))]


def price(service: str) -> float:
    return PRICES.get(service, DEFAULT_PRICE)


def tools_for(workspace) -> list[dict]:
    """The web tools for a workspace: one that may act and may use the internet."""
    if workspace.read_only or workspace.host or not workspace.network:
        return []
    return [*([SEARCH_TOOL] if search_services() else []), *([FETCH_TOOL] if settings.web_fetch else [])]


async def _glm(client: httpx.AsyncClient, engine: str, query: str, count: int, key: str) -> list[dict]:
    response = await client.post("https://open.bigmodel.cn/api/paas/v4/web_search",
                                 headers={"Authorization": f"Bearer {key}"},
                                 json={"search_engine": engine, "search_query": query, "count": count})
    try:
        body = response.json()
    except ValueError:
        body = {}
    if response.is_error or not isinstance(body, dict):
        raise WebError(f"HTTP {response.status_code}：{str(body or response.text)[:200]}")
    return [{"title": item.get("title"), "url": item.get("link"), "date": item.get("publish_date"),
             "excerpt": item.get("content"), "site": item.get("media")}
            for item in body.get("search_result") or [] if isinstance(item, dict)]


SEARCH = {"glm": _glm}


async def search(query: str, count: int = 5, client: Optional[httpx.AsyncClient] = None) -> tuple[list[dict], str]:
    """Results from the first service that answers, and which one did."""
    services = search_services()
    if not services:
        raise WebError("no search service is set up on this machine")
    query = query.strip()[:500]
    if not query:
        raise WebError("query is required")
    count = max(1, min(int(count or 5), MAX_RESULTS))
    errors = []
    own = client is None
    client = client or httpx.AsyncClient(timeout=TIMEOUT_SECONDS)
    try:
        for service in services:
            provider, engine = service.split(":", 1)
            try:
                return (await SEARCH[provider](client, engine, query, count, os.environ[PROVIDER_ENV[provider]]))[:count], service
            except (WebError, httpx.HTTPError, KeyError) as exc:
                errors.append(f"{service}: {exc}")
    finally:
        if own:
            await client.aclose()
    raise WebError("; ".join(errors))


def format_results(results: list[dict]) -> str:
    if not results:
        return "No results."
    return "\n\n".join(
        f"{index}. {item.get('title') or '(no title)'}\n{item.get('url') or ''}"
        + (f"\n{item['date']}" if item.get("date") else "")
        + (f"\n{str(item.get('excerpt') or '').strip()[:800]}" if item.get("excerpt") else "")
        for index, item in enumerate(results, 1))


def _public(host: str) -> bool:
    """Whether every address the host has is public (not this machine, its network or reserved)."""
    try:
        addresses = {info[4][0] for info in socket.getaddrinfo(host, None)}
    except (socket.gaierror, UnicodeError):
        raise WebError(f"cannot find {host}") from None
    for address in addresses:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
        if not ip.is_global or ip.is_multicast:
            return False
    return bool(addresses)


async def _checked(url: str) -> str:
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"} or not parts.hostname:
        raise WebError("only http and https addresses can be read")
    if parts.username or parts.password:
        raise WebError("addresses with a user or password are not read")
    if not await asyncio.to_thread(_public, parts.hostname):
        raise WebError(f"{parts.hostname} is not a public address")
    return url


class _Text(HTMLParser):
    SKIP = frozenset({"script", "style", "noscript", "svg", "template", "head"})
    BLOCK = frozenset({"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "pre", "table"})

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.skipping, self.title = [], 0, ""
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skipping += 1
        if tag == "title":
            self.in_title = True
        if tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skipping:
            self.skipping -= 1
        if tag == "title":
            self.in_title = False

    def handle_data(self, data):
        if self.in_title:
            self.title += data
        elif not self.skipping:
            self.parts.append(data)


def page_text(html: str) -> str:
    parser = _Text()
    parser.feed(html)
    text = re.sub(r"[ \t\r\f\v]+", " ", "".join(parser.parts))
    text = re.sub(r"\n\s*\n+", "\n\n", text).strip()
    return (f"# {parser.title.strip()}\n\n" if parser.title.strip() else "") + text


async def fetch(url: str, client: Optional[httpx.AsyncClient] = None) -> str:
    """A public page as text, cut to MAX_PAGE_CHARS."""
    if not isinstance(url, str) or not url.strip():
        raise WebError("url is required")
    own = client is None
    client = client or httpx.AsyncClient(timeout=TIMEOUT_SECONDS, follow_redirects=False,
                                         headers={"User-Agent": "FluidForm/1 (web reader)"})
    try:
        current = url.strip()
        for _ in range(MAX_REDIRECTS + 1):
            await _checked(current)
            async with client.stream("GET", current) as response:
                if response.is_redirect and response.headers.get("location"):
                    current = urljoin(current, response.headers["location"])
                    continue
                if response.is_error:
                    raise WebError(f"HTTP {response.status_code}")
                body = b""
                async for chunk in response.aiter_bytes():
                    body += chunk
                    if len(body) > MAX_PAGE_BYTES:
                        break
                kind = response.headers.get("content-type", "")
                charset = response.charset_encoding or "utf-8"
                break
        else:
            raise WebError("too many redirects")
    except httpx.HTTPError as exc:
        raise WebError(f"cannot read the page: {exc}") from exc
    finally:
        if own:
            await client.aclose()
    if not any(word in kind for word in ("text", "json", "xml", "javascript")) and kind:
        raise WebError(f"not a page of text ({kind.split(';')[0]})")
    try:
        text = body.decode(charset, errors="replace")
    except LookupError:
        text = body.decode("utf-8", errors="replace")
    if "html" in kind or text.lstrip()[:15].lower().startswith(("<!doctype", "<html")):
        text = page_text(text)
    if len(text) > MAX_PAGE_CHARS:
        text = text[:MAX_PAGE_CHARS] + "\n...(the rest of the page is cut)"
    return f"{current}\n\n{text or '(the page has no text)'}"
