// Interface packages (interfaces.ts): a web page FluidForm serves itself at /<id>/; the web console
// is one, shipped and enabled; without any, FluidForm is its API and the command line.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import * as bundled from "../src/bundled.js";
import * as capabilities from "../src/capabilities.js";
import * as packages from "../src/capability-packages.js";
import * as sandbox from "../src/capability-sandbox.js";
import { settings } from "../src/config.js";
import { conftest } from "./helpers/conftest.js";
import { type Client, taskApi } from "./helpers/task-api.js";
import { zipOf } from "./helpers/zip-writer.js";

const { folder } = conftest();
const saved = { sandbox: { ...sandbox.deps }, bundled: { ...bundled.deps } };
afterEach(() => {
  Object.assign(sandbox.deps, saved.sandbox);
  Object.assign(bundled.deps, saved.bundled);
});

const page = (id: string, fields: Record<string, unknown> = {}, extra: { name: string; data: string }[] = []) => zipOf([
  { name: "p/capability.json", data: JSON.stringify({ id, name: id, kind: "interface", version: "1.0", summary: "页面", ...fields }) },
  { name: "p/site/index.html", data: "<!doctype html><title>面板</title><script src=\"./assets/app.js\"></script>" },
  { name: "p/site/assets/app.js", data: "console.log('hi')" }, ...extra]);

const enable = (client: Client, id: string, enabled = true) => client.patch(`/api/capabilities/${id}`, { json: { enabled, confirmed: true } });

test("an interface package is a site FluidForm serves, and only that", () => {
  assert.equal(packages.read(page("board")).site, "site");
  assert.throws(() => packages.read(page("board", { site: "web" })), /网页文件夹 web/);
  assert.throws(() => packages.read(page("api")), /id 不能用 api/);
});

test("an enabled interface is served at its address; FluidForm's own address leads to the web console", async () => {
  const { client } = taskApi(folder());
  settings.capability_packages = true;
  // Without one, FluidForm's address says how to use it without a page.
  assert.match((await client.get("/")).text, /没有启用网页界面.*super-partner --help/s);
  for (const id of ["board", "web"]) assert.equal((await client.post("/api/capabilities/upload", { content: page(id) })).status_code, 201);
  assert.equal((await client.get("/board/")).status_code, 404); // installed switched off
  // Enabling an interface needs no sandbox: it runs nothing here.
  sandbox.deps.missing = () => "没有 bwrap";
  for (const id of ["board", "web"]) assert.equal((await enable(client, id)).status_code, 200);
  const home = await client.get("/");
  assert.equal(home.status_code, 302);
  assert.equal(home.headers.location, "/web/");
  const index = await client.get("/web/");
  assert.ok(index.status_code === 200 && index.headers["content-type"].startsWith("text/html") && index.text.includes("面板"));
  assert.equal((await client.get("/web/assets/app.js")).headers["content-type"], "text/javascript; charset=utf-8");
  // A path the page routes itself is the page; nothing leaves the site.
  assert.ok((await client.get("/web/some/where")).text.includes("面板"));
  assert.ok(!(await client.get("/web/../../capability.json")).text.includes("interface"));
  assert.equal((await client.get("/web")).headers.location, "/web/");
  // Switched off, it is gone.
  await enable(client, "web", false);
  assert.equal((await client.get("/web/")).status_code, 404);
  assert.equal((await client.get("/")).headers.location, "/board/");
});

test("the page writes to FluidForm from FluidForm's own address", async () => {
  const { client } = taskApi(folder());
  const own = await client.patch("/api/models", { json: { model_id: "mock:local", enabled: true }, headers: { origin: "http://127.0.0.1" } });
  assert.notEqual(own.status_code, 403, own.text);
  const other = await client.patch("/api/models", { json: { model_id: "mock:local", enabled: true }, headers: { origin: "http://evil.example" } });
  assert.equal(other.status_code, 403);
});

test("the shipped web console is installed and enabled even without a sandbox, and again when its build changes", async () => {
  taskApi(folder());
  const shipped = join(folder(), "shipped", "web");
  mkdirSync(join(shipped, "site"), { recursive: true });
  writeFileSync(join(shipped, "capability.json"), JSON.stringify({ id: "web", name: "网页界面", kind: "interface", site: "site", version: "1.0.0" }));
  writeFileSync(join(shipped, "site", "index.html"), "<title>一</title>");
  bundled.deps.folder = () => join(folder(), "shipped");
  sandbox.deps.missing = () => "没有 bwrap";
  settings.capability_packages = false;
  assert.deepEqual((await bundled.offer()).map((item) => item.id), ["web"]);
  assert.equal(capabilities.load("web")!.status, "active");
  assert.deepEqual(await bundled.offer(), []); // nothing changed
  writeFileSync(join(shipped, "site", "index.html"), "<title>二</title>");
  assert.deepEqual((await bundled.offer()).map((item) => item.id), ["web"]);
  assert.equal(capabilities.load("web")!.status, "active");
});
