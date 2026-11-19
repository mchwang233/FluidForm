"""Pictures made from a description by an image model, for API models in steps and chats (the
GenerateImage tool, agent.py). ``settings.image_models`` lists the models to use, first choice
first (e.g. ``["glm:cogview-4", "minimax:image-01"]``); empty: no such tool. Each provider's key is
the one its chat models use (secrets.PROVIDER_ENV)."""
from __future__ import annotations

import base64
import os
from typing import Optional

import httpx

from .attachments import _image_type
from .config import settings
from .secrets import PROVIDER_ENV

# What one picture costs, in US dollars, by model; a model not listed costs DEFAULT_PRICE.
PRICES = {"glm:cogview-4": 0.01, "glm:cogview-3-flash": 0.0, "minimax:image-01": 0.004}
DEFAULT_PRICE = 0.02
# Shapes a picture can have, as each provider names them.
SHAPES = {"square": ("1024x1024", "1:1"), "portrait": ("768x1344", "9:16"), "landscape": ("1344x768", "16:9")}
MAX_PROMPT_CHARS = 1500
TIMEOUT_SECONDS = 120
MAX_PICTURE_BYTES = 20 * 1024 * 1024


class ImageError(RuntimeError):
    pass


def available() -> list[str]:
    """The image models that can be used now: listed, of a known provider, with its key."""
    return [model_id for model_id in settings.image_models
            if (provider := model_id.split(":", 1)[0]) in API and os.environ.get(PROVIDER_ENV.get(provider, ""))]


def price(model_id: str) -> float:
    return PRICES.get(model_id, DEFAULT_PRICE)


async def _glm(client: httpx.AsyncClient, model: str, prompt: str, shape: str, key: str) -> bytes:
    response = await client.post("https://open.bigmodel.cn/api/paas/v4/images/generations",
                                 headers={"Authorization": f"Bearer {key}"},
                                 json={"model": model, "prompt": prompt, "size": SHAPES[shape][0]})
    body = _json(response)
    url = ((body.get("data") or [{}])[0] or {}).get("url")
    if not url:
        raise ImageError(f"智谱没有给出图片：{str(body)[:200]}")
    picture = await client.get(url)
    picture.raise_for_status()
    return picture.content


async def _minimax(client: httpx.AsyncClient, model: str, prompt: str, shape: str, key: str) -> bytes:
    response = await client.post("https://api.minimax.io/v1/image_generation",
                                 headers={"Authorization": f"Bearer {key}"},
                                 json={"model": model, "prompt": prompt, "aspect_ratio": SHAPES[shape][1],
                                       "response_format": "base64", "n": 1})
    body = _json(response)
    status = (body.get("base_resp") or {}).get("status_code", 0)
    found = ((body.get("data") or {}).get("image_base64") or [None])[0]
    if status or not found:
        raise ImageError(f"MiniMax 没有给出图片：{str(body.get('base_resp') or body)[:200]}")
    return base64.b64decode(found)


def _json(response: httpx.Response) -> dict:
    try:
        body = response.json()
    except ValueError:
        body = {}
    if response.is_error:
        raise ImageError(f"HTTP {response.status_code}：{str(body or response.text)[:200]}")
    return body if isinstance(body, dict) else {}


API = {"glm": _glm, "minimax": _minimax}


async def generate(prompt: str, shape: str = "square", client: Optional[httpx.AsyncClient] = None) -> tuple[bytes, str]:
    """A picture of ``prompt`` (PNG, JPEG or WebP bytes) and the model that made it: the first of
    the available models that does; ImageError when none does."""
    prompt = (prompt or "").strip()[:MAX_PROMPT_CHARS]
    if not prompt:
        raise ImageError("要画什么？描述是空的。")
    if shape not in SHAPES:
        raise ImageError(f"形状只能是 {'、'.join(SHAPES)}")
    models = available()
    if not models:
        raise ImageError("这台机器没有可用的画图模型（settings.image_models）。")
    own = client is None
    client = client or httpx.AsyncClient(timeout=TIMEOUT_SECONDS, follow_redirects=True)
    problems = []
    try:
        for model_id in models:
            provider, model = model_id.split(":", 1)
            try:
                data = await API[provider](client, model, prompt, shape, os.environ[PROVIDER_ENV[provider]])
            except (ImageError, httpx.HTTPError, ValueError) as exc:
                problems.append(f"{model_id}：{str(exc)[:200]}")
                continue
            if len(data) > MAX_PICTURE_BYTES or not _image_type(data):
                problems.append(f"{model_id}：给回来的不是图片")
                continue
            return data, model_id
    finally:
        if own:
            await client.aclose()
    raise ImageError("画图没成功：" + "；".join(problems))
