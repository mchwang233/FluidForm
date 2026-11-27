// benchmarks.ts: tests/test_benchmarks.py, ported.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { gzipSync } from "node:zlib";
import { AA_KEY_ENV, AA_PUBLIC_URL, AA_URL, addAaDetails, BenchmarkCatalog, matchResults, parseAa, parseAaPublic, resultFor,
  SOURCE_NAMES } from "../packages/research/src/benchmarks.js";
import { settings } from "../src/config.js";
import { Database } from "../src/db.js";
import { get } from "../src/fetching.js";
import { ModelProfileSchema } from "../src/models.js";
import { conftest } from "./helpers/conftest.js";

const { folder } = conftest();

// A leaderboard row as model research keeps it (Artificial Analysis), for the matching rules.
const row = (name: string, published: string | null = "2026-09-15") => resultFor("artificial_analysis", name, "OpenAI", "AA Intelligence Index v4.3",
  { source_url: AA_PUBLIC_URL, data_url: AA_URL, published_at: published, collection_method: "public_page",
    metrics: [{ key: "artificial_analysis_intelligence_index", label: "综合智能指数", value: 52.3, unit: "index", note: null, benchmark: null }] });

const aaBody = (page = 1, more = false, version = 4.3, name = "Sample-1 (high)") => ({
  intelligence_index_version: version, pagination: { page, has_more: more, total_pages: more ? 2 : page },
  data: [{ name, slug: "sample-1", model_creator: { name: "OpenAI" },
    evaluations: { artificial_analysis_intelligence_index: 52.3, artificial_analysis_coding_index: 0, artificial_analysis_agentic_index: null } }],
});

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

function aaPublicHtml(rows: [string, string, string, string][] = [["Sample-1 (high)", "OpenAI", "52", "sample-1-high"]]): string {
  const body = rows.map(([name, creator, score, slug]) => `<tr><td>${escape(creator)}</td><td>${escape(score)}</td>`
    + `<td><div>${escape(name)}</div></td><td><a href="/models/${escape(slug)}">Model</a><a href="/models/${escape(slug)}/providers">Providers</a></td></tr>`).join("");
  return '<table><thead><tr><th colspan="4">Features</th></tr><tr><th>Creator</th><th>Artificial Analysis Intelligence Index</th><th>Model</th>'
    + "<th>Further Analysis</th></tr></thead><tbody>" + body + "</tbody></table>";
}

const aaDetailRow = (updates: Record<string, unknown> = {}) => ({ slug: "sample-1-high", shortName: "Sample-1 (high)", name: "Sample-1 (High)", modelCreatorName: "OpenAI",
  intelligenceIndex: 52.3, scicode: 0.625, terminalBench40: 0.5, hle: 0.3, critpt: 0.1, lcr: 0.8, omniscienceAccuracy: 0.7, omniscienceNonHallucination: 0.6, ...updates });

function aaChartScripts(rows: unknown[]): string {
  const stream = 'f:I["module"]\na:' + JSON.stringify(["$", "$L36", null, { models: rows }]) + "\n";
  const midpoint = Math.floor(stream.length / 2);
  return [stream.slice(0, midpoint), stream.slice(midpoint)].map((part) => "<script>self.__next_f.push(" + JSON.stringify([1, part]) + ")</script>").join("");
}

const model = (identifier = "openai:sample-1", fields: Record<string, unknown> = {}) => ModelProfileSchema.parse({ id: identifier, provider: identifier.split(":")[0],
  display_name: identifier.split(":")[1], ...fields });

test("only Artificial Analysis is looked up", () => {
  assert.deepEqual(Object.keys(SOURCE_NAMES), ["artificial_analysis"]);
});

test("the parser keeps original scores, dates, variants and missing values", () => {
  const aa = parseAa(aaBody())[0];
  assert.equal(aa.published_at, null);
  assert.ok(aa.variant === "high" && aa.metrics[0].unit === "index");
  assert.deepEqual(aa.metrics.map((metric) => metric.value), [52.3, 0]);
});

test("matching keeps snapshots, the provider, the configuration and ambiguity", () => {
  let rows = [row("Sample-1-20260101 (high)"), row("Sample-1-20260101 (low)")];
  const correct = model("openai:sample-1-20260101");
  const candidates = [correct, model(), model("openai:sample-1-mini"), model("google:sample-1-20260101")];
  let matched = matchResults(candidates, rows);
  assert.deepEqual([...matched.keys()], [correct.id]);
  assert.deepEqual(new Set(matched.get(correct.id)!.map((row) => row.variant)), new Set(["high", "low"]));
  assert.ok(correct.scores === null && !correct.routing_ready);
  rows = [row("Friendly Name (high)")];
  candidates[0].display_name = "Friendly Name";
  candidates[1].display_name = "Friendly Name";
  assert.equal(matchResults(candidates, rows).size, 0);
  candidates[0].display_name = "Other Name";
  matched = matchResults(candidates, rows);
  assert.equal(matched.get(candidates[1].id)![0].matched_by, "display_name");
});

test("scores older than a model's release do not pass to a new snapshot", () => {
  const rows = [row("Sample-1 (high)")];
  assert.equal(matchResults([model(undefined, { release_date: "2026-09-16" })], rows).size, 0);
  assert.ok(matchResults([model(undefined, { release_date: "2026-09-14" })], rows).has(model().id));
});

test("public AA keeps visible precision, variants, notes and zero", () => {
  const rows = parseAaPublic(aaPublicHtml([["Sample-1 (high)", "OpenAI", "52", "sample-1-high"], ["Sample-1 (low)", "OpenAI", "0", "sample-1-low"],
    ["Sample-2 (max with fallback)", "Anthropic", "33 *", "sample-2"], ["Sample-3 (max)", "OpenAI", "--", "sample-3"]]));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.metrics[0].value), [52, 0, 33]);
  assert.deepEqual(rows.map((row) => row.variant), ["high", "low", "max with fallback"]);
  assert.ok(rows[2].metrics[0].note?.includes("*"));
  assert.ok(rows.every((row) => row.metrics[0].unit === "index" && row.collection_method === "public_page"));
  assert.ok(rows.every((row) => row.published_at === null && row.version.includes("网页未标版本")));
  assert.equal(rows[0].data_url, AA_PUBLIC_URL);
  assert.equal(rows[0].source_url, "https://artificialanalysis.ai/models/sample-1-high");
});

test("public AA reads split chart JSON and scales the real subscores", () => {
  const row = parseAaPublic(aaPublicHtml() + aaChartScripts([aaDetailRow({ critpt: 0, lcr: null })]))[0];
  const scores = Object.fromEntries(row.metrics.map((metric) => [metric.key, metric]));
  assert.ok(scores.artificial_analysis_intelligence_index.value === 52 && scores.artificial_analysis_intelligence_index.unit === "index");
  assert.ok(scores.aa_scicode.value === 62.5 && scores.aa_scicode.benchmark === "SciCode" && scores.aa_scicode.unit === "percent");
  assert.equal(scores.aa_critpt.value, 0);
  assert.ok(!("aa_lcr" in scores));
  assert.equal(row.metrics.length, 7); // Headline plus six reported dimensions; missing is not zero.
});

test("AA subscores must match the slug, the provider, the setting and the headline", () => {
  for (const updates of [{ slug: "sample-1-low" }, { shortName: "Sample-1 (low)", name: "Sample-1 (Low)" }, { modelCreatorName: "Anthropic" }, { intelligenceIndex: 59 }]) {
    assert.equal(parseAaPublic(aaPublicHtml() + aaChartScripts([aaDetailRow(updates)]))[0].metrics.length, 1, JSON.stringify(updates));
  }
});

test("ambiguous chart records are not attached, and scripts are not run", () => {
  assert.equal(parseAaPublic(aaPublicHtml() + aaChartScripts([aaDetailRow(), aaDetailRow()]))[0].metrics.length, 1);
  assert.equal(parseAaPublic(aaPublicHtml() + '<script>self.__next_f.push([1, eval("untrusted")])</script>')[0].metrics.length, 1);
});

test("AA subscores refuse invalid ratio units", () => {
  for (const value of [-0.1, 1.1, true, "75%"]) assert.throws(() => parseAaPublic(aaPublicHtml() + aaChartScripts([aaDetailRow({ scicode: value })])), String(value));
  // NaN is not JSON: Python's json reads it (and refuses the ratio); JSON.parse refuses the record, so
  // nothing from it is attached.
  const page = aaPublicHtml() + aaChartScripts([aaDetailRow({ scicode: "__NAN__" })]).replace('\\"__NAN__\\"', "NaN");
  assert.ok(page.includes("NaN"));
  assert.equal(parseAaPublic(page)[0].metrics.length, 1);
});

test("a snapshot or edition in parentheses is not an inference setting", () => {
  const rows = parseAaPublic(aaPublicHtml([["Sample-1 (0902)", "OpenAI", "45", "sample-1-0902"], ["Sample-1 (June 2026)", "OpenAI", "26", "sample-1-june"]]));
  assert.equal(matchResults([model()], rows).size, 0);
  assert.ok(rows.every((row) => row.variant === "来源未注明配置" && row.model_key.includes("(")));
});

test("duplicate public labels need distinct model identities", () => {
  const rows = parseAaPublic(aaPublicHtml([["Sample-1", "OpenAI", "11", "sample-1-reasoning"], ["Sample-1", "OpenAI", "10 *", "sample-1-instruct"]]));
  assert.equal(new Set(rows.map((row) => row.id)).size, 2);
  assert.equal(matchResults([model()], rows).size, 0);
  assert.ok(matchResults([model("openai:sample-1-instruct")], rows).size);
});

test("public AA refuses schema changes and incomplete pages", () => {
  for (const page of ["<html>Access unavailable</html>", aaPublicHtml().replace("Artificial Analysis Intelligence Index", "New metric"),
    aaPublicHtml().replace("52", "not a number"), aaPublicHtml().replace('/models/sample-1-high"', 'https://example.com/model"'),
    aaPublicHtml().replace("</table>", ""), aaPublicHtml([])]) {
    assert.throws(() => parseAaPublic(page), page.slice(0, 60));
  }
});

// --- the catalog over (fake) HTTP -------------------------------------------------------------
let catalog: BenchmarkCatalog;
beforeEach(() => {
  delete process.env[AA_KEY_ENV];
  settings.artificial_analysis_api_key = null;
  catalog = new BenchmarkCatalog(new Database(join(folder(), "benchmarks.db")));
});

type Request = { url: URL; headers: Headers };
const text = (body: string, status = 200) => new Response(body, { status });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const fake = (respond: (request: Request) => Response) => (async (input: string | URL, init: RequestInit = {}) => {
  assert.equal(init.redirect, "manual");
  return respond({ url: new URL(String(input)), headers: new Headers(init.headers) });
}) as typeof fetch;

function publicResponse(request: Request): Response {
  assert.ok(!request.headers.has("authorization") && !request.headers.has("x-api-key"));
  const url = request.url.toString();
  if (url === AA_PUBLIC_URL) return text(aaPublicHtml());
  throw new Error(`Unexpected public request ${url}`);
}

const aaApi = (request: Request) => request.url.host === "artificialanalysis.ai" && request.url.toString() !== AA_PUBLIC_URL;

test("live sources are found, cached and matched to models", async () => {
  await catalog.refresh(fake(publicResponse));
  const status = catalog.status([model()]) as Record<string, any>;
  assert.equal(status.matched_models, 1);
  assert.deepEqual(Object.keys(status.sources), ["artificial_analysis"]);
  assert.equal(status.sources.artificial_analysis.status, "ok");
  assert.equal(status.sources.artificial_analysis.configured, false);
  assert.equal(status.sources.artificial_analysis.collection_method, "public_page");
  const restarted = new BenchmarkCatalog(catalog.db);
  assert.deepEqual(JSON.parse(JSON.stringify([...restarted.matchModels([model()])])), JSON.parse(JSON.stringify([...catalog.matchModels([model()])])));
});

test("a source's failure keeps its previous scores without leaking the error's body", async () => {
  await catalog.refresh(fake(publicResponse));
  const previous = JSON.stringify([...catalog.matchModels([model()])]);
  const previousAa = catalog.cache.artificial_analysis.results;
  await catalog.refresh(fake(() => text("secret-key", 503)), undefined, { force: true }); // read again now, as 立即更新 does
  assert.equal(JSON.stringify([...catalog.matchModels([model()])]), previous);
  assert.ok(catalog.cache.artificial_analysis.last_success_at);
  assert.ok(!JSON.stringify(catalog.status([model()])).includes("secret-key"));
  assert.equal(catalog.cache.artificial_analysis.status, "error");
  assert.deepEqual(catalog.cache.artificial_analysis.results, previousAa);
});

test("AA's pages keep the key on its official host", async () => {
  process.env[AA_KEY_ENV] = "test-secret-key";
  const pages: number[] = [];
  await catalog.refresh(fake((request) => {
    if (!aaApi(request)) return publicResponse(request);
    assert.equal(request.headers.get("x-api-key"), "test-secret-key");
    assert.ok(request.url.toString().startsWith(AA_URL));
    const page = Number(request.url.searchParams.get("page"));
    pages.push(page);
    return json(aaBody(page, page === 1, 4.3, `Sample-${page} (high)`));
  }));
  assert.deepEqual(pages, [1, 2]);
  assert.equal(catalog.cache.artificial_analysis.status, "ok");
  assert.equal(catalog.cache.artificial_analysis.count, 2);
  assert.ok(!JSON.stringify(catalog.cache).includes("test-secret-key"));
  assert.equal(catalog.cache.artificial_analysis.collection_method, "api");
});

test("the API's indices get the public subscores without showing the API key", async () => {
  process.env[AA_KEY_ENV] = "test-secret-key";
  await catalog.refresh(fake((request) => {
    if (request.url.toString() === AA_PUBLIC_URL) {
      assert.ok(!request.headers.has("x-api-key"));
      return text(aaPublicHtml() + aaChartScripts([aaDetailRow({ slug: "sample-1" })]));
    }
    return aaApi(request) ? json(aaBody()) : publicResponse(request);
  }));
  assert.equal(catalog.cache.artificial_analysis.status, "ok");
  assert.equal(catalog.cache.artificial_analysis.with_details, 1);
  const result = catalog.cache.artificial_analysis.results[0];
  assert.equal(result.metrics.length, 9);
  assert.equal(result.metrics[0].value, 52.3);
});

test("a missing public chart page keeps the API's indices", async () => {
  process.env[AA_KEY_ENV] = "test-secret-key";
  await catalog.refresh(fake((request) => (request.url.toString() === AA_PUBLIC_URL ? text("", 503) : aaApi(request) ? json(aaBody()) : publicResponse(request))));
  assert.equal(catalog.cache.artificial_analysis.status, "ok");
  assert.equal(catalog.cache.artificial_analysis.with_details, 0);
  assert.equal(catalog.cache.artificial_analysis.results[0].metrics.length, 2);
});

test("incomplete or mixed-version AA pages do not replace the cache", async () => {
  process.env[AA_KEY_ENV] = "test-secret-key";
  const previous = JSON.parse(JSON.stringify(parseAa(aaBody())[0]));
  catalog.cache.artificial_analysis = { results: [previous] };
  await catalog.refresh(fake((request) => {
    if (!aaApi(request)) return publicResponse(request);
    const page = Number(request.url.searchParams.get("page"));
    return json(aaBody(page, page === 1, page === 1 ? 4.3 : 5));
  }));
  assert.equal(catalog.cache.artificial_analysis.status, "error");
  assert.deepEqual(catalog.cache.artificial_analysis.results, [previous]);
});

test("redirects do not pass on AA's credentials", async () => {
  process.env[AA_KEY_ENV] = "test-secret-key";
  const seen: string[] = [];
  await catalog.refresh(fake((request) => {
    seen.push(request.url.toString());
    if (request.url.host === "artificialanalysis.ai") return new Response(null, { status: 302, headers: { location: "https://example.com/untrusted" } });
    return publicResponse(request);
  }));
  assert.equal(catalog.cache.artificial_analysis.status, "error");
  assert.ok(!seen.some((url) => url.includes("example.com")));
});

test("compressed replies are decoded once", async () => {
  // A real server and the real fetch: fetch decodes the body itself.
  const body = "公开评测数据";
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-encoding": "gzip", "content-type": "text/plain; charset=utf-8" });
    response.end(gzipSync(Buffer.from(body)));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  try {
    const { port } = server.address() as { port: number };
    const got = await get(fetch, `http://127.0.0.1:${port}/`);
    assert.equal(got.text(), body);
  } finally {
    server.close();
  }
});

test("an undated alias takes the newest snapshot the catalog does not list", () => {
  const rows = [row("Sample-1 0601 (high)", null), row("Sample-1 0813 (high)", null)];
  const alias = model();
  let matched = matchResults([alias], rows);
  assert.deepEqual(matched.get(alias.id)!.map((row) => row.model_name), ["Sample-1 0813 (high)"]);
  assert.equal(matched.get(alias.id)![0].matched_by, "latest_snapshot");
  // The newest snapshot listed in the catalog keeps its results; an older one is not the alias.
  const dated = model("openai:sample-1-0813");
  matched = matchResults([alias, dated], rows);
  assert.deepEqual(matched.get(dated.id)!.map((row) => row.model_name), ["Sample-1 0813 (high)"]);
  assert.ok(!matched.has(alias.id));
});

test("results kept from the dropped leaderboards are not shown or matched", () => {
  const db = catalog.db;
  db.saveBenchmarkCache("bfcl", { status: "ok", results: [{ ...row("Sample-1 (high)"), id: "old", source: "bfcl", source_name: "BFCL" }] });
  const restarted = new BenchmarkCatalog(db);
  assert.ok(restarted.results().every((result) => result.source === "artificial_analysis"));
  assert.equal(restarted.matchModels([model()]).size, 0);
  assert.deepEqual(Object.keys((restarted.status([model()]) as Record<string, any>).sources), ["artificial_analysis"]);
});

// The page as it is since 2026-11: its table has no creator column, its model records name the release.
const newRecord = (updates: Record<string, unknown> = {}) => ({ id: "rec-high", release: { slug: "claude-fable-5-2", name: "Claude Fable 5.2" },
  name: "Claude Fable 5.2 (High, Default Fallback)", shortName: "Claude Fable 5.2 (high)", modelCreatorName: "Anthropic", intelligenceIndex: 61.8723,
  scores: { scicode: 0.595, "terminalbench-4-0": 0.596, "humanitys-last-exam": 0.662, critpt: 0.329, "artificial-analysis-long-context-reasoning": 0.833,
    "omniscience-accuracy": 0.772, "omniscience-non-hallucination": 0.42, "aa-briefcase": 1623 }, ...updates });
const newTable = '<table><thead><tr><th>Model</th><th>Artificial Analysis Intelligence Index</th><th>Context Window</th><th>Further Analysis</th></tr></thead>'
  + '<tbody><tr><td>Claude Fable 5.2 High, Default Fallback</td><td>62</td><td>1M</td><td><a href="/models/claude-fable-5-2">Model</a></td></tr></tbody></table>';

test("the page without a creator column is read from its model records", () => {
  const rows = parseAaPublic(newTable + aaChartScripts([newRecord(), newRecord(),
    newRecord({ id: "rec-low", shortName: "Claude Fable 5.2 (low)", name: "Claude Fable 5.2 (Low)", intelligenceIndex: 53.89, scores: {} }),
    newRecord({ id: "unscored", shortName: "Granite 4.2 3B", modelCreatorName: "IBM", intelligenceIndex: null, release: { slug: "granite-4-2-3b" } })]))
    .sort((a, b) => a.model_name.localeCompare(b.model_name));
  assert.deepEqual(rows.map((row) => [row.model_name, row.provider, row.variant]), [["Claude Fable 5.2 (high)", "anthropic", "high"], ["Claude Fable 5.2 (low)", "anthropic", "low"]],
    "each scored record once, unscored ones left out");
  const scores = Object.fromEntries(rows[0].metrics.map((metric) => [metric.key, metric.value]));
  assert.equal(scores.artificial_analysis_intelligence_index, 61.9);
  assert.equal(Math.round(scores.aa_terminalbench_4 * 10) / 10, 59.6);
  assert.equal(Math.round(scores.aa_non_hallucination), 42);
  assert.equal(rows[0].metrics.length, 8, "the index and the seven subscores scoring uses; others left out");
  assert.equal(rows[0].source_url, "https://artificialanalysis.ai/models/claude-fable-5-2");
  // Matched to the catalog's model as before.
  assert.ok(matchResults([model("anthropic:claude-fable-5-2", { display_name: "Claude Fable 5.2" })], rows).has("anthropic:claude-fable-5-2"));
  // A ratio outside 0–1 is refused, as in the older records.
  assert.throws(() => parseAaPublic(newTable + aaChartScripts([newRecord({ scores: { scicode: 1.5 } })])), /ratio/);
  // Neither a creator column nor records: the page changed beyond reading.
  assert.throws(() => parseAaPublic(newTable), /columns changed/);
});

test("the API's indices get the subscores from records that name their release", () => {
  const [given] = parseAa({ intelligence_index_version: 4.3, pagination: { page: 1, has_more: false, total_pages: 1 },
    data: [{ name: "Claude Fable 5.2 (high)", slug: "claude-fable-5-2", model_creator: { name: "Anthropic" },
      evaluations: { artificial_analysis_intelligence_index: 61.9 } }] });
  const [joined] = addAaDetails([given], [newRecord()]);
  assert.ok(joined.metrics.some((metric) => metric.key === "aa_scicode"));
});
