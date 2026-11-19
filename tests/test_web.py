"""Searching the web and reading a page (web.py): WebSearch through a search service with the
provider's key, charged by the search; WebFetch only of public addresses; both only for a step or
chat allowed the internet."""
import json

import httpx
import pytest
from super_partner import agent, web
from super_partner.config import settings


@pytest.fixture
def services(monkeypatch):
    monkeypatch.setenv("GLM_API_KEY", "g")
    monkeypatch.setattr(web, "PROVIDER_ENV", {"glm": "GLM_API_KEY"})
    monkeypatch.setattr(settings, "web_search_models", ["glm:search_std"])
    monkeypatch.setattr(settings, "web_fetch", True)


def client(handler, **kwargs):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), **kwargs)


async def test_a_search_asks_the_service_with_its_key(services):
    def handler(request):
        body = json.loads(request.content)
        assert request.headers["authorization"] == "Bearer g" and request.url.path.endswith("/web_search")
        assert (body["search_engine"], body["search_query"], body["count"]) == ("search_std", "北京天气", 3)
        return httpx.Response(200, json={"search_result": [
            {"title": "北京天气预报", "link": "https://weather.example/bj", "content": "晴，5°C", "publish_date": "2026-11-19"}]})

    async with client(handler) as http:
        results, service = await web.search("北京天气", 3, http)
    assert service == "glm:search_std"
    text = web.format_results(results)
    assert "1. 北京天气预报\nhttps://weather.example/bj\n2026-11-19\n晴，5°C" == text


class Budget:
    def __init__(self, left):
        self.left, self.charged = left, []

    def can_spend(self, cost):
        return self.left >= cost

    async def record_usd(self, cost):
        self.charged.append(cost)


async def test_the_tools_are_for_steps_allowed_the_internet_and_searches_are_charged(services, monkeypatch, tmp_path):
    assert web.tools_for(agent.Workspace(tmp_path)) == []
    assert web.tools_for(agent.Workspace(tmp_path, network=True, read_only=True)) == []
    online = agent.Workspace(tmp_path, network=True)
    assert [tool["name"] for tool in web.tools_for(online)] == ["WebSearch", "WebFetch"]

    async def search(query, count=5, client=None):
        return [{"title": "t", "url": "https://a.example"}], "glm:search_std"

    monkeypatch.setattr(web, "search", search)
    online.budget = Budget(1.0)
    output, ok = await online.run("WebSearch", {"query": "x"})
    assert ok and "https://a.example" in output and online.budget.charged == [web.price("glm:search_std")]
    online.budget = Budget(0.0)
    output, ok = await online.run("WebSearch", {"query": "x"})
    assert not ok and "budget" in output
    # A step without the internet cannot use them, even by name.
    output, ok = await agent.Workspace(tmp_path).run("WebSearch", {"query": "x"})
    assert not ok


async def test_a_page_is_read_as_text(services, monkeypatch):
    monkeypatch.setattr(web, "_public", lambda host: True)
    html = ("<html><head><title>天气</title><script>var x=1</script></head>"
            "<body><h1>北京</h1><p>晴，5°C</p><style>p{}</style></body></html>")

    def handler(request):
        if request.url.path == "/old":
            return httpx.Response(301, headers={"location": "/new"})
        return httpx.Response(200, html=html)

    async with client(handler) as http:
        text = await web.fetch("https://weather.example/old", http)
    assert text.startswith("https://weather.example/new") and "# 天气" in text
    assert "北京" in text and "晴，5°C" in text and "var x" not in text and "p{}" not in text


@pytest.mark.parametrize("url", ["http://127.0.0.1:8000/api/tasks", "http://localhost/", "http://10.0.0.5/",
                                 "http://[::1]/", "file:///etc/passwd", "http://user:pw@example.com/"])
async def test_addresses_of_this_machine_or_its_network_are_refused(services, url):
    with pytest.raises(web.WebError):
        await web.fetch(url, client(lambda request: httpx.Response(200, text="secret")))


async def test_a_redirect_to_this_machine_is_refused(services, monkeypatch):
    monkeypatch.setattr(web, "_public", lambda host: host != "127.0.0.1")

    def handler(request):
        return httpx.Response(302, headers={"location": "http://127.0.0.1:8000/api/tasks"})

    with pytest.raises(web.WebError, match="not a public address"):
        await web.fetch("https://public.example/", client(handler))
