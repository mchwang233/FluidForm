// Getting public data over HTTP (what benchmarks.ts and catalog-sync.ts need of httpx): no redirects
// followed (a redirect is an error, so credentials never go to another host), a size limit, a time
// limit, and errors told apart as httpx tells them: a status, a timeout, the network.

export type Fetcher = typeof fetch;

/** httpx.HTTPStatusError: the server answered with a status that is not 2xx (redirects included). */
export class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/** httpx.TimeoutException / asyncio.TimeoutError. */
export class RequestTimeout extends Error {
  override name = "TimeoutError";
}

/** httpx.TransportError: no answer at all (connection refused, DNS, TLS). */
export class TransportError extends Error {}

export type Got = { status: number; headers: Headers; body: Buffer; text(): string; json(): unknown };

/** Run ``work`` with a signal that aborts after ``seconds``; a RequestTimeout then. */
export async function within<T>(seconds: number, work: (signal: AbortSignal) => Promise<T>, outer?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const stop = () => controller.abort(outer!.reason);
  outer?.addEventListener("abort", stop, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(() => {
      controller.abort(new RequestTimeout("timed out"));
      fail(new RequestTimeout("timed out"));
    }, seconds * 1000);
  });
  try {
    return await Promise.race([work(controller.signal), late]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", stop);
  }
}

/** GET ``url``: its whole body, at most ``limit`` bytes (decompressed). */
export async function get(fetcher: Fetcher, url: string, { headers = {}, params = {}, limit = Infinity, signal }:
  { headers?: Record<string, string>; params?: Record<string, string | number>; limit?: number; signal?: AbortSignal } = {}): Promise<Got> {
  const target = new URL(url);
  for (const [name, value] of Object.entries(params)) target.searchParams.set(name, String(value));
  let response: Response;
  try {
    response = await fetcher(target, { headers, redirect: "manual", signal });
  } catch (error) {
    if (error instanceof RequestTimeout || (error as Error)?.name === "TimeoutError") throw new RequestTimeout("timed out");
    if ((error as Error)?.name === "AbortError") throw signal?.reason instanceof Error ? signal.reason : error;
    throw new TransportError((error as Error)?.message ?? String(error));
  }
  if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel().catch(() => undefined);
    throw new HttpStatusError(response.status);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (error instanceof RequestTimeout || (error as Error)?.name === "TimeoutError") throw new RequestTimeout("timed out");
        if ((error as Error)?.name === "AbortError") throw signal?.reason instanceof Error ? signal.reason : error;
        throw new TransportError((error as Error)?.message ?? String(error));
      }
      const { done, value } = chunk;
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Response exceeds size limit");
      }
      chunks.push(Buffer.from(value));
    }
  }
  const body = Buffer.concat(chunks);
  return { status: response.status, headers: response.headers, body, text: () => body.toString("utf8"), json: () => JSON.parse(body.toString("utf8")) };
}
