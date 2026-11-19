"""Pictures made by an image model (images.py) through the GenerateImage tool, charged by the
picture, and steps that must make pictures go to the API models given that tool (routing)."""
import base64
import json

import httpx
import pytest
from super_partner import agent, images, routing
from super_partner.config import settings
from super_partner.models import CapabilityScore, ModelProfile, TaskNode
from super_partner.planner import task_node

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 32
JPEG = b"\xff\xd8\xff" + b"\0" * 32


@pytest.fixture
def keys(monkeypatch):
    monkeypatch.setenv("GLM_API_KEY", "g")
    monkeypatch.setenv("MINIMAX_API_KEY", "m")
    monkeypatch.setattr(images, "PROVIDER_ENV", {"glm": "GLM_API_KEY", "minimax": "MINIMAX_API_KEY"})
    monkeypatch.setattr(settings, "image_models", ["minimax:image-01", "glm:cogview-4"])


def client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_a_picture_comes_from_the_first_model_and_the_next_when_it_fails(keys):
    seen = []

    def handler(request):
        seen.append((request.url.host, request.url.path, request.headers.get("authorization")))
        if request.url.host == "api.minimax.io":
            return httpx.Response(200, json={"base_resp": {"status_code": 1026, "status_msg": "sensitive"}})
        if request.url.path.endswith("/images/generations"):
            body = json.loads(request.content)
            assert body["size"] == "768x1344" and body["prompt"] == "海边的女孩"
            return httpx.Response(200, json={"data": [{"url": "https://files.example/p.jpg"}]})
        return httpx.Response(200, content=JPEG)

    async with client(handler) as http:
        data, model_id = await images.generate("海边的女孩", "portrait", http)
    assert (data, model_id) == (JPEG, "glm:cogview-4")
    assert seen[0] == ("api.minimax.io", "/v1/image_generation", "Bearer m")
    assert seen[1][2] == "Bearer g"


async def test_minimax_gives_its_picture_inline(keys):
    def handler(request):
        assert json.loads(request.content)["aspect_ratio"] == "1:1"
        return httpx.Response(200, json={"base_resp": {"status_code": 0}, "data": {"image_base64": [base64.b64encode(PNG).decode()]}})

    async with client(handler) as http:
        assert await images.generate("猫", client=http) == (PNG, "minimax:image-01")


async def test_no_picture_without_a_model_a_key_or_a_real_picture(keys, monkeypatch):
    async with client(lambda request: httpx.Response(200, json={"data": {"image_base64": [base64.b64encode(b"not a picture").decode()]}})) as http:
        monkeypatch.setattr(settings, "image_models", ["minimax:image-01"])
        with pytest.raises(images.ImageError, match="不是图片"):
            await images.generate("猫", client=http)
    monkeypatch.delenv("MINIMAX_API_KEY")
    assert images.available() == []
    with pytest.raises(images.ImageError, match="没有可用的画图模型"):
        await images.generate("猫")
    monkeypatch.setattr(settings, "image_models", ["nobody:x"])
    assert images.available() == []


class Budget:
    def __init__(self, left):
        self.left, self.charged = left, []

    def can_spend(self, cost):
        return self.left >= cost

    async def record_usd(self, cost):
        self.charged.append(cost)
        self.left -= cost


async def test_the_tool_saves_the_picture_with_its_own_format_and_charges_it(keys, monkeypatch, tmp_path):
    async def generate(prompt, shape="square", client=None):
        assert (prompt, shape) == ("头像", "square")
        return JPEG, "minimax:image-01"

    monkeypatch.setattr(images, "generate", generate)
    workspace = agent.Workspace(tmp_path)
    workspace.budget = Budget(1.0)
    output, ok = await workspace.run("GenerateImage", {"prompt": "头像", "file_path": "out/avatar.png"})
    assert ok and "avatar.jpg" in output and (tmp_path / "out" / "avatar.jpg").read_bytes() == JPEG
    assert workspace.budget.charged == [images.price("minimax:image-01")]
    # Not when the budget cannot pay for it, nor for a reviewer.
    workspace.budget = Budget(0.0)
    output, ok = await workspace.run("GenerateImage", {"prompt": "头像", "file_path": "b.png"})
    assert not ok and "budget" in output and not (tmp_path / "b.png").exists()
    output, ok = await agent.Workspace(tmp_path, read_only=True).run("GenerateImage", {"prompt": "x", "file_path": "c.png"})
    assert not ok and not (tmp_path / "c.png").exists()


def model(model_id, channel):
    return ModelProfile(id=model_id, provider="x", display_name=model_id, channel=channel, context_window=1_000_000,
                        input_per_million=1, output_per_million=1, scores=CapabilityScore(coding=90, planning=90, reliability=90))


def test_a_step_that_makes_pictures_goes_to_an_api_model_when_there_is_an_image_model(keys, monkeypatch):
    models = [model("cli:codex", "cli"), model("x:api", "api")]
    node = TaskNode(id="n", title="头像", instructions="画", capability="coding", needs_images=True)
    assert [m.id for m in routing.eligible_for_node(node, models, {"cli:codex", "x:api"})] == ["x:api"]
    # Other steps, or a machine without an image model, keep every model.
    other = TaskNode(id="o", title="写", instructions="写", capability="coding")
    assert len(routing.eligible_for_node(other, models, {"cli:codex", "x:api"})) == 2
    monkeypatch.setattr(settings, "image_models", [])
    assert len(routing.eligible_for_node(node, models, {"cli:codex", "x:api"})) == 2


def test_the_plan_says_which_steps_make_pictures():
    raw = {"title": "头像", "instructions": "画一张", "capability": "coding", "needs_images": True}
    assert task_node(raw, "t1", [], []).needs_images is True
    assert task_node({**raw, "needs_images": "yes"}, "t1", [], []).needs_images is False
    # Old plans load.
    assert TaskNode.model_validate({"id": "n", "title": "t", "instructions": "i", "capability": "coding"}).needs_images is False
