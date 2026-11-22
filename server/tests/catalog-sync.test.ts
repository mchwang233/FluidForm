// catalog-sync.ts: tests/test_catalog_sync.py, ported.
import assert from "node:assert/strict";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { CatalogSync, OFFICIAL_URLS, PUBLIC_CATALOG_URL, PUBLIC_PROVIDERS, publicModels, seedCatalog } from "../src/catalog-sync.js";
import { Database } from "../src/db.js";
import { pythonIso } from "../src/lax.js";
import { ModelProfileSchema, TaskNodeSchema } from "../src/models.js";
import { selectPlannerModel } from "../packages/planning/src/planner.js";
import { costsFor, NoEligibleModelError, routeNode } from "../src/routing.js";
import { PROVIDER_ENV } from "../src/secret-names.js";
import { conftest } from "./helpers/conftest.js";

const { folder } = conftest();

type Json = Record<string, any>;
type Request = { url: URL; headers: Headers };
let catalog: Json;
let sync: CatalogSync;

beforeEach(() => {
  catalog = Object.fromEntries(Object.values(PUBLIC_PROVIDERS).map((source) => [source, { models: { "new-model": { id: "new-model", name: "New Model",
    release_date: "2026-10-01", modalities: { input: ["text", "image"], output: ["text"] }, limit: { context: 100000, output: 64000 }, cost: { input: 1.25, output: 5 },
    tool_call: true, reasoning: true } } }]));
  for (const env of Object.values(PROVIDER_ENV)) delete process.env[env];
  const db = new Database(join(folder(), "catalog.db"));
  sync = new CatalogSync(db, seedCatalog(db));
  answer(() => new Response(null, { status: 500 }));
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** The sync's HTTP answered by ``respond``, which may wait (it is told the request's signal). */
function answer(respond: (request: Request, signal?: AbortSignal) => Response | Promise<Response>): void {
  sync.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    assert.equal(init.redirect, "manual");
    return respond({ url: new URL(String(input)), headers: new Headers(init.headers) }, init.signal ?? undefined);
  }) as typeof fetch;
}
const comparable = (value: unknown) => JSON.parse(JSON.stringify(value));

test("a public sync keeps all providers without keys", async () => {
  answer((request) => {
    assert.equal(request.url.toString(), PUBLIC_CATALOG_URL);
    assert.ok(!request.headers.has("authorization") && !request.headers.has("x-api-key"));
    return json(catalog);
  });
  try {
    const status = await sync.refresh();
    assert.equal(status.added, 9);
    assert.ok(Object.values(status.providers as Json).every((s: Json) => s.public_status === "ok"));
    const fresh = sync.models["openai:new-model"];
    assert.ok(fresh.input_per_million === 1.25 && fresh.supports_vision === true);
    assert.ok(fresh.scores === null && !fresh.enabled && !fresh.routing_ready);
    assert.equal(fresh.release_date, "2026-10-01");
    assert.ok(fresh.catalog_source === "models.dev" && !fresh.pricing_verified);
    assert.equal(fresh.available_via_api, null);
    assert.equal((await sync.refresh()).added, 0);
    assert.deepEqual(comparable(seedCatalog(sync.db)[fresh.id]), comparable({ ...fresh, catalog_checked_at: sync.models[fresh.id].catalog_checked_at }));
    assert.ok((sync.db.loadCatalogState() as Json).last_success_at);
  } finally {
    await sync.close();
  }
});

test("a sync keeps what is turned on, scores, verified prices and history", async () => {
  const original = { ...sync.models["openai:gpt-5.6-sol"], enabled: false, pricing_verified: true, input_per_million: 42 };
  sync.models[original.id] = original;
  catalog.openai.models["gpt-5.6-sol"] = { ...catalog.openai.models["new-model"], id: "gpt-5.6-sol" };
  answer(() => json(catalog));
  try {
    await sync.refresh();
    const updated = sync.models[original.id];
    assert.ok(!updated.enabled);
    assert.deepEqual(updated.scores, original.scores);
    assert.ok(updated.input_per_million === 42 && updated.pricing_verified);
    assert.ok(updated.context_window === 100000 && updated.max_output_tokens === 64000);
    assert.deepEqual(comparable(seedCatalog(sync.db)[original.id]), comparable(updated));
    delete catalog.openai.models["new-model"];
    await sync.refresh();
    assert.equal(sync.models["openai:new-model"].catalog_status, "unlisted");
    assert.ok(("cli:codex" in sync.models) && ("mock:local" in sync.models));
  } finally {
    await sync.close();
  }
});

test("failures keep the cache, keep providers apart and hide secrets", async () => {
  process.env.OPENAI_API_KEY = "secret-test-key";
  catalog.google = { models: {} };
  answer((request) => {
    if (request.url.host === "api.openai.com") return new Response("secret-test-key", { status: 401 });
    assert.ok(!request.headers.has("authorization"));
    return json(catalog);
  });
  try {
    let status = await sync.refresh();
    assert.equal(status.providers.google.public_status, "error");
    assert.equal(status.providers.openai.official_status, "error");
    assert.equal(status.providers.anthropic.public_status, "ok");
    assert.ok(!JSON.stringify(status).includes("secret-test-key"));
    const cached = comparable(Object.entries(sync.models));
    answer(() => new Response(null, { status: 503 }));
    status = await sync.refresh();
    assert.ok(Object.values(status.providers as Json).every((s: Json) => s.public_status === "error"));
    assert.deepEqual(comparable(Object.entries(sync.models)), cached);
    assert.ok(status.providers.anthropic.last_success_at);
  } finally {
    await sync.close();
  }
});

test("official catalogs are read page by page, with their auth", async () => {
  for (const provider of ["anthropic", "google"]) {
    const db = new Database(join(folder(), `${provider}.db`));
    sync = new CatalogSync(db, seedCatalog(db));
    for (const env of Object.values(PROVIDER_ENV)) delete process.env[env];
    process.env[PROVIDER_ENV[provider]] = "private-key";
    const pages: Request[] = [];
    answer((request) => {
      if (request.url.toString() === PUBLIC_CATALOG_URL) {
        assert.ok(!request.headers.has("authorization") && !request.headers.has("x-api-key"));
        return json(catalog);
      }
      assert.ok(request.url.toString().startsWith(OFFICIAL_URLS[provider]));
      pages.push(request);
      const second = pages.length === 2;
      if (provider === "google") {
        assert.equal(request.headers.get("x-goog-api-key"), "private-key");
        if (second) assert.equal(request.url.searchParams.get("pageToken"), "page-two");
        return json({ models: [{ name: `models/official-${pages.length}`, displayName: "Fresh", inputTokenLimit: 120000, supportedGenerationMethods: ["generateContent"] }],
          ...(second ? {} : { nextPageToken: "page-two" }) });
      }
      assert.equal(request.headers.get("x-api-key"), "private-key");
      assert.equal(request.headers.get("anthropic-version"), "2023-06-01");
      if (second) assert.equal(request.url.searchParams.get("after_id"), "page-two");
      return json({ data: [{ id: `official-${pages.length}`, display_name: "Fresh", max_input_tokens: 120000 }], has_more: !second, last_id: "page-two" });
    });
    try {
      const status = await sync.refresh();
      assert.ok(pages.length === 2 && status.providers[provider].official_count === 2, provider);
      for (const index of [1, 2]) {
        const model = sync.models[`${provider}:official-${index}`];
        assert.ok(model.catalog_source === "official" && model.available_via_api === true);
        assert.ok(model.context_window === 120000 && model.scores === null);
        assert.ok(model.input_per_million === null && model.release_date === null);
      }
      assert.equal(sync.models[`${provider}:new-model`].available_via_api, false);
    } finally {
      await sync.close();
    }
  }
});

test("failed paging never keeps part of an official catalog", async () => {
  process.env.ANTHROPIC_API_KEY = "private-key";
  answer((request) => {
    if (request.url.host === "models.dev") return json(catalog);
    if (request.url.searchParams.has("after_id")) return new Response(null, { status: 429 });
    return json({ data: [{ id: "partial" }], has_more: true, last_id: "partial" });
  });
  try {
    const status = await sync.refresh();
    assert.equal(status.providers.anthropic.official_status, "error");
    assert.ok(!("anthropic:partial" in sync.models));
    assert.equal(sync.models["anthropic:new-model"].available_via_api, null);
  } finally {
    await sync.close();
  }
});

test("official bearer auth, and metadata a catalog leaves out", async () => {
  for (const provider of ["openai", "deepseek"]) {
    const db = new Database(join(folder(), `${provider}.db`));
    sync = new CatalogSync(db, seedCatalog(db));
    for (const env of Object.values(PROVIDER_ENV)) delete process.env[env];
    process.env[PROVIDER_ENV[provider]] = "private-key";
    answer((request) => {
      if (request.url.host === "models.dev") return json(catalog);
      assert.equal(request.url.toString(), OFFICIAL_URLS[provider]);
      assert.equal(request.headers.get("authorization"), "Bearer private-key");
      return json({ data: [{ id: "new-model" }, { id: "fresh-model", created: 1788000000 }, { id: "retired-model", shutdown_date: "2020-01-01" }] });
    });
    try {
      const result = await sync.refresh();
      assert.equal(result.providers[provider].official_status, "ok", provider);
      assert.equal(sync.models[`${provider}:new-model`].input_per_million, 1.25);
      const fresh = sync.models[`${provider}:fresh-model`];
      assert.ok(fresh.release_date === null && fresh.input_per_million === null);
      assert.ok(fresh.available_via_api === true && !fresh.routing_ready);
      assert.equal(sync.models[`${provider}:retired-model`].catalog_status, "retired");
    } finally {
      await sync.close();
    }
  }
});

test("a retired model is not brought back by missing or stale public data", async () => {
  const original = sync.models["openai:gpt-5.6-sol"];
  const entry = { ...catalog.openai.models["new-model"], id: "gpt-5.6-sol", status: "retired" };
  catalog.openai.models["gpt-5.6-sol"] = entry;
  answer(() => json(catalog));
  try {
    await sync.refresh();
    assert.ok(!sync.models[original.id].routing_ready);
    delete (entry as Json).status;
    await sync.refresh();
    assert.equal(sync.models[original.id].catalog_status, "retired");
    delete catalog.openai.models["gpt-5.6-sol"];
    await sync.refresh();
    assert.equal(sync.models[original.id].catalog_status, "retired");
    assert.ok(!sync.models[original.id].routing_ready);
  } finally {
    await sync.close();
  }
});

test("unknown metadata is neither free nor a candidate for routing", async () => {
  const entry = catalog.openai.models["new-model"];
  delete entry.cost;
  entry.limit.context = -1;
  const metadata = publicModels(catalog, "openai")["openai:new-model"];
  const model = ModelProfileSchema.parse({ id: "openai:new-model", provider: "openai", enabled: true, ...metadata });
  assert.ok(model.context_window === null && model.input_per_million === null);
  const node = TaskNodeSchema.parse({ id: "n", title: "task", instructions: "work", capability: "coding", quality_threshold: 0 });
  assert.equal(await selectPlannerModel([model], new Set([model.id])), null);
  await assert.rejects(routeNode(node, [model], new Set([model.id])), NoEligibleModelError);
  // Pricing has nothing to say about it: no cost, rather than free.
  assert.deepEqual(await costsFor(node, [model]), { [model.id]: null });
});

test("refreshes at the same time run once, and closing cancels", async () => {
  let started!: () => void;
  const begun = new Promise<void>((done) => (started = done));
  const calls: Request[] = [];
  answer((request, signal) => {
    calls.push(request);
    started();
    // Held until the request is cancelled.
    return new Promise<Response>((_, fail) => signal?.addEventListener("abort", () => fail(signal.reason)));
  });
  sync.trigger();
  await begun;
  sync.trigger();
  assert.ok((await sync.refresh()).running);
  assert.equal(calls.length, 1);
  await sync.close();
  assert.ok(sync.task!.done && (sync.task!.error as Error)?.name === "AbortError");
});

test("starting uses the saved schedule, and runs when it is due", async () => {
  const calls: Request[] = [];
  answer((request) => {
    calls.push(request);
    return json(catalog);
  });
  sync.state.next_sync_at = pythonIso(new Date(Date.now() + 12 * 3_600_000));
  sync.start();
  await new Promise((done) => setImmediate(done));
  assert.equal(calls.length, 0);
  sync.scheduler!.cancel();
  await assert.rejects(sync.scheduler!.promise, { name: "AbortError" });
  sync.state.next_sync_at = pythonIso(new Date(Date.now() - 3_600_000));
  sync.start();
  await new Promise((done) => setImmediate(done));
  await sync.task!.promise;
  assert.equal(calls.length, 1);
  assert.ok(pythonIso(new Date(Date.now() + 23 * 3_600_000)) < sync.status().next_sync_at);
  await sync.close();
});
