// Pictures made from a description by an image model, for API models in steps and chats (the
// GenerateImage tool). settings.image_models lists the models to use, first choice
// first (e.g. ["glm:cogview-4", "minimax:image-01"]); not set, every one in AUTO whose provider has
// a key here; empty: no such tool. Each provider's key is the one its chat models use.
import { imageType } from "./attachments.js";
import { settings } from "./config.js";
import { head, pyStr } from "./py.js";
import { PROVIDER_ENV } from "./secret-names.js";

// What one picture costs, in US dollars, by model; a model not listed costs DEFAULT_PRICE.
export const PRICES: Record<string, number> = { "glm:cogview-4": 0.01, "glm:cogview-3-flash": 0.0, "minimax:image-01": 0.004 };
export const DEFAULT_PRICE = 0.02;
// Shapes a picture can have, as each provider names them.
export const SHAPES: Record<string, [string, string]> = {
  square: ["1024x1024", "1:1"], portrait: ["768x1344", "9:16"], landscape: ["1344x768", "16:9"],
};
export const MAX_PROMPT_CHARS = 1500;
export const TIMEOUT_SECONDS = 120;
export const MAX_PICTURE_BYTES = 20 * 1024 * 1024;

export class ImageError extends Error {
  override name = "ImageError";
}

// The image models used when settings.image_models is not set, first choice first: MiniMax puts no
// watermark on its pictures, Zhipu's carry "AI生成".
export const AUTO = ["minimax:image-01", "glm:cogview-4"];

/** The image models that can be used now: listed (or, not set, AUTO), of a known provider, with its key. */
export function available(): string[] {
  const listed = settings.image_models ?? AUTO;
  return listed.filter((modelId) => {
    const provider = modelId.split(":", 1)[0];
    return provider in API && Boolean(process.env[PROVIDER_ENV[provider] ?? ""]);
  });
}

export function price(modelId: string): number {
  return PRICES[modelId] ?? DEFAULT_PRICE;
}

export type Fetch = typeof fetch;

async function json(response: Response): Promise<Record<string, any>> {
  const text = await response.text();
  let body: unknown = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }
  if (!response.ok) {
    const shown = body && typeof body === "object" && Object.keys(body).length ? pyStr(body) : text;
    throw new ImageError(`HTTP ${response.status}：${head(shown, 200)}`);
  }
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, any>) : {};
}

async function glm(fetcher: Fetch, model: string, prompt: string, shape: string, key: string): Promise<Buffer> {
  const response = await fetcher("https://open.bigmodel.cn/api/paas/v4/images/generations", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, size: SHAPES[shape][0] }),
  });
  const body = await json(response);
  const url = ((body.data || [{}])[0] || {}).url;
  if (!url) throw new ImageError(`智谱没有给出图片：${head(pyStr(body), 200)}`);
  const picture = await fetcher(url);
  if (!picture.ok) throw new ImageError(`HTTP ${picture.status}`);
  return Buffer.from(await picture.arrayBuffer());
}

async function minimax(fetcher: Fetch, model: string, prompt: string, shape: string, key: string): Promise<Buffer> {
  const response = await fetcher("https://api.minimax.io/v1/image_generation", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, aspect_ratio: SHAPES[shape][1], response_format: "base64", n: 1 }),
  });
  const body = await json(response);
  const status = (body.base_resp || {}).status_code ?? 0;
  const found = ((body.data || {}).image_base64 || [null])[0];
  if (status || !found) throw new ImageError(`MiniMax 没有给出图片：${head(pyStr(body.base_resp || body), 200)}`);
  return Buffer.from(found, "base64");
}

const API: Record<string, typeof glm> = { glm, minimax };

// What tests replace: making the picture.
export const deps = { generate: (description: string, shape = "square") => generate(description, shape) };

/** A picture of ``prompt`` (PNG, JPEG or WebP bytes) and the model that made it: the first of the
 *  available models that does; ImageError when none does. */
export async function generate(description: string, shape = "square", fetcher: Fetch = fetch): Promise<[Buffer, string]> {
  const prompt = head((description || "").trim(), MAX_PROMPT_CHARS);
  if (!prompt) throw new ImageError("要画什么？描述是空的。");
  if (!(shape in SHAPES)) throw new ImageError(`形状只能是 ${Object.keys(SHAPES).join("、")}`);
  const models = available();
  if (!models.length) throw new ImageError("这台机器没有可用的画图模型（settings.image_models）。");
  const timed: Fetch = (input, init) => fetcher(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_SECONDS * 1000) });
  const problems: string[] = [];
  for (const modelId of models) {
    const provider = modelId.slice(0, modelId.indexOf(":"));
    const model = modelId.slice(modelId.indexOf(":") + 1);
    let data: Buffer;
    try {
      data = await API[provider](timed, model, prompt, shape, process.env[PROVIDER_ENV[provider]]!);
    } catch (error) {
      problems.push(`${modelId}：${head(String((error as Error).message ?? error), 200)}`);
      continue;
    }
    if (data.length > MAX_PICTURE_BYTES || !imageType(data)) {
      problems.push(`${modelId}：给回来的不是图片`);
      continue;
    }
    return [data, modelId];
  }
  throw new ImageError("画图没成功：" + problems.join("；"));
}
