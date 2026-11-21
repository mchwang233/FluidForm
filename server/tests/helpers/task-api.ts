// conftest.py's task_api fixture: the whole API on a temporary database, asked as the console asks
// (Fastify's inject, the Host 127.0.0.1). Nothing starts by itself (no lifespan): no catalog sync,
// no automations, no tasks resumed.
import { join } from "node:path";
import { after } from "node:test";
import { Api } from "../../src/api.js";
import { buildApp } from "../../src/app.js";
import { settings } from "../../src/config.js";

export type Answer = { status_code: number; headers: Record<string, any>; text: string; content: Buffer; json(): any };
type Options = { json?: unknown; params?: Record<string, unknown>; content?: Buffer | string; headers?: Record<string, string> };

export type Client = {
  get(url: string, options?: Options): Promise<Answer>;
  post(url: string, options?: Options): Promise<Answer>;
  put(url: string, options?: Options): Promise<Answer>;
  patch(url: string, options?: Options): Promise<Answer>;
  delete(url: string, options?: Options): Promise<Answer>;
};

/** The API of a test, and a client for it; closed when the test file's tests end. */
export function taskApi(folder: string): { api: Api; client: Client } {
  Object.assign(settings, { data_dir: join(folder, "data"), database_path: join(folder, "tasks.db"), workspace_root: join(folder, "workspaces") });
  const api = new Api();
  const app = buildApp(api);
  const ask = (method: string) => async (url: string, options: Options = {}): Promise<Answer> => {
    const query = options.params ? "?" + new URLSearchParams(Object.entries(options.params).map(([key, value]) => [key, String(value)])).toString() : "";
    const headers: Record<string, string> = { host: "127.0.0.1", ...(options.headers ?? {}) };
    let payload: Buffer | string | undefined;
    if (options.json !== undefined) {
      payload = JSON.stringify(options.json);
      headers["content-type"] ??= "application/json";
    } else if (options.content !== undefined) payload = options.content;
    const answer = await app.inject({ method: method as any, url: url + query, headers, payload });
    return { status_code: answer.statusCode, headers: answer.headers, text: answer.body, content: answer.rawPayload, json: () => JSON.parse(answer.body) };
  };
  after(async () => {
    await api.catalogSync.close();
    await app.close();
    api.db.close();
  });
  return { api, client: { get: ask("GET"), post: ask("POST"), put: ask("PUT"), patch: ask("PATCH"), delete: ask("DELETE") } };
}
