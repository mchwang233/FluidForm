// The API's guard (api.ts local_only and CORS) and the routes moved so far.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { Api } from "../src/api.js";
import { buildApp, hostName } from "../src/app.js";
import { settings } from "../src/config.js";
import { conftest } from "./helpers/conftest.js";
import { taskApi } from "./helpers/task-api.js";

const { folder } = conftest();
const app = (extra: Record<string, unknown> = {}, pending = false) => {
  // Given on their own, as in .env (Settings.given).
  Object.assign(settings, extra);
  const given = settings.given;
  Object.defineProperty(settings, "given", { value: new Set(Object.keys(extra)), configurable: true });
  after(() => Object.defineProperty(settings, "given", { value: given, configurable: true }));
  const { api } = taskApi(folder());
  if (pending) api.executor.platformPending = { id: "repair" } as any;
  return { settings, app: buildApp(api as Api) };
};
const local = { host: "127.0.0.1:8000" };

test("only local host names are answered (DNS rebinding)", async () => {
  const { app: server } = app();
  assert.equal((await server.inject({ url: "/api/settings/profile", headers: local })).statusCode, 200);
  assert.equal((await server.inject({ url: "/api/settings/profile", headers: { host: "[::1]:8000" } })).statusCode, 200);
  const evil = await server.inject({ url: "/api/settings/profile", headers: { host: "evil.example:8000" } });
  assert.deepEqual([evil.statusCode, evil.json()], [403, { detail: "Host not allowed" }]);
  assert.deepEqual([hostName("localhost"), hostName("a:1"), hostName("[::1]:80"), hostName("::1")], ["localhost", "a", "::1", "::1"]);
});

test("other sites cannot change anything; the page's origin can", async () => {
  const { app: server } = app();
  const put = (origin: string) => server.inject({ method: "PUT", url: "/api/settings/profile",
    headers: { ...local, origin }, payload: { profile: "" } });
  const refused = await put("https://evil.example");
  assert.deepEqual([refused.statusCode, refused.json()], [403, { detail: "Origin not allowed" }]);
  const allowed = await put("http://localhost:5173");
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.headers["access-control-allow-origin"], "http://localhost:5173");
  const read = await server.inject({ url: "/api/settings/profile", headers: { ...local, origin: "https://evil.example" } });
  assert.equal(read.statusCode, 200);
  assert.equal(read.headers["access-control-allow-origin"], undefined);
});

test("while a verified repair is applied, changes wait but cancel and pause go through", async () => {
  const { app: server } = app({}, true);
  const changed = await server.inject({ method: "PUT", url: "/api/settings/profile", headers: local, payload: { profile: "" } });
  assert.deepEqual([changed.statusCode, changed.headers["retry-after"]], [503, "2"]);
  const cancel = await server.inject({ method: "POST", url: "/api/tasks/r/cancel", headers: local });
  assert.equal(cancel.statusCode, 404); // let through: there is no such task
  assert.equal((await server.inject({ url: "/api/settings/profile", headers: local })).statusCode, 200);
});

test("the profile is shown, changed now and kept for after a restart", async () => {
  const { app: server, settings } = app({ quick_tasks: true });
  assert.deepEqual((await server.inject({ url: "/api/settings/profile", headers: local })).json(),
    { profile: "", given_alone: { careful: ["quick_tasks"] } });
  const careful = await server.inject({ method: "PUT", url: "/api/settings/profile", headers: local, payload: { profile: "careful" } });
  assert.equal(careful.json().profile, "careful");
  assert.ok(settings.acceptance && settings.quick_tasks);
  assert.deepEqual(JSON.parse(readFileSync(settings.profilePath, "utf8")), { profile: "careful" });
  const wrong = await server.inject({ method: "PUT", url: "/api/settings/profile", headers: local, payload: { profile: "turbo" } });
  assert.equal(wrong.statusCode, 422);
  assert.deepEqual(wrong.json().detail[0].loc, ["body", "profile"]);
});
