// Public benchmark results, kept separate from the application's routing presets.
import * as apiProviders from "../../../src/api-providers.js";
import { createHash } from "node:crypto";
import { settings } from "../../../src/config.js";
import type { Database } from "../../../src/db.js";
import { type Fetcher, get, HttpStatusError, RequestTimeout, TransportError, within } from "../../../src/fetching.js";
import { PublicTableParser } from "./html-tables.js";
import { pythonIso } from "../../../src/lax.js";
import { type ModelProfile, utcnow } from "../../../src/models.js";
import { compareKeys, pyStr, splitlines, pyQuote } from "../../../src/py.js";
import { Workbook } from "./xlsx.js";
import { ZipFile } from "../../../src/zip.js";

export const BFCL_URL = "https://gorilla.cs.berkeley.edu/leaderboard.html";
export const BFCL_DATA_URL = "https://gorilla.cs.berkeley.edu/data_overall.csv";
export const SUPERCLUE_URL = "https://www.superclueai.com/";
export const AA_URL = "https://artificialanalysis.ai/api/v2/language/models/free";
export const AA_PUBLIC_URL = "https://artificialanalysis.ai/leaderboards/models";
export const AA_KEY_ENV = "ARTIFICIAL_ANALYSIS_API_KEY";
export const SOURCE_NAMES: Record<string, string> = { superclue: "SuperCLUE", bfcl: "BFCL", artificial_analysis: "Artificial Analysis" };
export const MAX_RESPONSE_BYTES = 8_000_000;

export function aaKey(): string | null {
  return process.env[AA_KEY_ENV] || settings.artificial_analysis_api_key || null;
}

export type BenchmarkMetric = { key: string; label: string; value: number; unit: "percent" | "index"; note: string | null; benchmark: string | null };

export type BenchmarkResult = {
  id: string;
  source: string;
  source_name: string;
  source_url: string;
  data_url: string;
  version: string;
  model_name: string;
  provider: string | null;
  model_key: string;
  variant: string;
  published_at: string | null;
  fetched_at: string;
  metrics: BenchmarkMetric[];
  collection_method: "dataset" | "api" | "public_page";
};

/** A matched result as it is told: the result and how it was matched to the model. */
export type MatchedRow = BenchmarkResult & { matched_by: string };

const metric = (fields: Omit<BenchmarkMetric, "note" | "benchmark"> & Partial<BenchmarkMetric>): BenchmarkMetric => {
  if (!Number.isFinite(fields.value)) throw new Error("Invalid benchmark score");
  return { note: null, benchmark: null, ...fields };
};

/** BenchmarkResult.model_validate: a stored row, checked. */
export function validated(row: Record<string, any>): BenchmarkResult {
  for (const key of ["id", "source", "source_name", "source_url", "data_url", "version", "model_name", "model_key"]) {
    if (typeof row[key] !== "string") throw new Error(`Invalid benchmark result: ${key}`);
  }
  if (!Array.isArray(row.metrics)) throw new Error("Invalid benchmark result: metrics");
  return { provider: null, variant: "来源未注明配置", published_at: null, fetched_at: utcnow(), collection_method: "dataset", ...row,
    metrics: row.metrics.map((item: Record<string, any>) => metric({ key: item.key, label: item.label, value: item.value, unit: item.unit, note: item.note ?? null,
      benchmark: item.benchmark ?? null })) } as BenchmarkResult;
}

// A leaderboard name ending in a snapshot date: "DeepSeek V4 Pro 0813", "... 20250813".
export const SNAPSHOT = /^(.*?)[\s_-]+(\d{4}|\d{8})$/;

/** Formatting differences only: never drop snapshot dates, model tiers, or version digits. */
export function normalized(value: string): string {
  return value.normalize("NFKC").toLowerCase().replaceAll("ß", "ss").replace(/[\s._-]+/g, "");
}

// What leaderboards call each provider's maker (api-providers.ts aliases), formatting differences removed.
export const PROVIDERS: Record<string, string> = Object.fromEntries(apiProviders.declared
  .flatMap((item) => (item.aliases ?? []).map((alias) => [normalized(alias), item.id])));

const SETTINGS = /^(?:FC(?: thinking)?|Prompt(?: \+ Thinking)?|(?:minimal|low|medium|high|xhigh|max)(?: with fallback)?|non[- ]reasoning|reasoning|thinking)$/i;

export function parseIdentity(given: string): [string, string] {
  const name = given.normalize("NFKC").trim();
  // Only known inference settings can be removed; dates and editions in parentheses are identity.
  const match = /^(.+?)\s*\(([^()]+)\)$/s.exec(name);
  if (match && SETTINGS.test(match[2])) return [match[1].trim(), match[2].trim()];
  return [name, "来源未注明配置"];
}

const FLOAT = /^[+-]?(?:(?:\d+(?:_\d+)*)?\.?\d+(?:_\d+)*(?:[eE][+-]?\d+)?|\d+(?:_\d+)*\.(?:[eE][+-]?\d+)?|inf(?:inity)?|nan)$/i;

/** Python's float() of text. */
function pyFloat(text: string): number {
  const value = text.trim();
  if (!FLOAT.test(value)) throw new Error(`could not convert string to float: '${text}'`);
  if (/^[+-]?inf/i.test(value)) return value.startsWith("-") ? -Infinity : Infinity;
  if (/nan$/i.test(value)) return NaN;
  return Number(value.replaceAll("_", ""));
}

export function metricValue(value: unknown, unit: string): number | null {
  if (value === null || value === undefined || typeof value === "boolean" || ["", "N/A", "—", "-"].includes(pyStr(value).trim())) return null;
  const result = typeof value === "number" ? value : pyFloat(pyStr(value).trim().replace(/%+$/, ""));
  if (!Number.isFinite(result) || (unit === "percent" && !(result >= 0 && result <= 100))) throw new Error("Invalid benchmark score");
  return result;
}

export function metrics(row: Record<string, unknown>, fields: Record<string, string>, unit: "percent" | "index" = "percent"): BenchmarkMetric[] {
  const result: BenchmarkMetric[] = [];
  for (const [key, label] of Object.entries(fields)) {
    const value = metricValue(row[key], unit);
    if (value !== null) result.push(metric({ key, label, value, unit }));
  }
  return result;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 20);

export function resultFor(source: string, name: string, organization: string, version: string,
  fields: { source_url: string; data_url: string; metrics: BenchmarkMetric[]; published_at?: string | null; collection_method?: BenchmarkResult["collection_method"] }): BenchmarkResult {
  const [key, variant] = parseIdentity(name);
  return { id: sha(`${source}|${version}|${name}`), source, source_name: SOURCE_NAMES[source], source_url: fields.source_url, data_url: fields.data_url,
    version, model_name: name, provider: PROVIDERS[normalized(organization)] ?? null, model_key: key, variant, published_at: fields.published_at ?? null,
    fetched_at: utcnow(), metrics: fields.metrics, collection_method: fields.collection_method ?? "dataset" };
}

export const BFCL_FIELDS: Record<string, string> = { "Overall Acc": "工具调用综合", "Non-Live AST Acc": "单轮标准任务", "Live Acc": "单轮真实任务",
  "Multi Turn Acc": "多轮工具调用", "Web Search Acc": "网页搜索任务", "Memory Acc": "记忆任务" };
export const SUPERCLUE_FIELDS: Record<string, string> = Object.fromEntries(["总分", "数学推理", "幻觉控制", "科学推理", "精确指令遵循", "智能体编程", "智能体任务规划"]
  .map((key) => [key, key]));
export const AA_FIELDS: Record<string, string> = { artificial_analysis_intelligence_index: "综合智能指数", artificial_analysis_coding_index: "编程指数",
  artificial_analysis_agentic_index: "智能体指数" };
export const AA_DETAIL_FIELDS: Record<string, [string, string, string]> = {
  scicode: ["aa_scicode", "科学编程", "SciCode"], terminalBench40: ["aa_terminalbench_4", "终端智能体", "Terminal-Bench 4.0"], hle: ["aa_hle", "复杂推理", "HLE"],
  critpt: ["aa_critpt", "物理推理", "CritPt"], lcr: ["aa_lcr", "长文本推理", "AA-LCR"], omniscienceAccuracy: ["aa_knowledge_accuracy", "知识准确率", "AA-Omniscience Accuracy"],
  omniscienceNonHallucination: ["aa_non_hallucination", "非幻觉率", "AA-Omniscience Non-Hallucination"],
};

/** csv.reader: rows of fields, quoted fields and newlines in them kept. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"' && field === "") {
      quoted = true;
      started = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
      started = true;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      if (started || field) row.push(field);
      if (row.length) rows.push(row);
      row = [];
      field = "";
      started = false;
    } else {
      field += char;
      started = true;
    }
  }
  if (started || field) row.push(field);
  if (row.length) rows.push(row);
  return rows;
}

/** csv.DictReader: the header row's names, and each row as a record (missing fields absent). */
function csvRecords(text: string): [string[], Record<string, string>[]] {
  const [headers = [], ...rows] = csvRows(text);
  return [headers, rows.map((values) => Object.fromEntries(headers.map((name, index) => [name, values[index]]).filter(([, value]) => value !== undefined)))];
}

const isoDate = (year: number, month: number, day: number): string => {
  const when = new Date(Date.UTC(year, month - 1, day));
  if (when.getUTCFullYear() !== year || when.getUTCMonth() !== month - 1 || when.getUTCDate() !== day || year < 1) throw new Error("Invalid evaluation date");
  return when.toISOString().slice(0, 10);
};

export function parseBfcl(text: string, page: string): BenchmarkResult[] {
  const [headers, rows] = csvRecords(text.replace(/^﻿+/, ""));
  if (!["Model", "Organization", ...Object.keys(BFCL_FIELDS)].every((name) => headers.includes(name))) throw new Error("BFCL schema changed");
  const version = /BFCL\)?\s*(V\d+)/.exec(page);
  const stamp = /Last Updated:\s*(\d{4}-\d{2}-\d{2})/.exec(page);
  if (!version || !stamp) throw new Error("Missing BFCL version/date");
  const [year, month, day] = stamp[1].split("-").map(Number);
  const published = isoDate(year, month, day);
  const result: BenchmarkResult[] = [];
  for (const row of rows) {
    const name = (row.Model ?? "").trim();
    if (!name) continue;
    const scores = metrics(row, BFCL_FIELDS);
    if (scores.length) result.push(resultFor("bfcl", name, row.Organization ?? "", `BFCL ${version[1]}`, { source_url: BFCL_URL, data_url: BFCL_DATA_URL, published_at: published, metrics: scores }));
  }
  if (!result.length) throw new Error("Empty BFCL results");
  return result;
}

export function parseSuperclue(content: Buffer, edition: string, dataUrl: string): BenchmarkResult[] {
  // Bound workbook expansion; read cached values without executing formulas or external links.
  const archive = new ZipFile(content);
  if (archive.infolist().reduce((sum, item) => sum + item.file_size, 0) > 32_000_000) throw new Error("Workbook exceeds size limit");
  const workbook = new Workbook(archive);
  if (!workbook.sheetnames.includes("总排行榜")) throw new Error("SuperCLUE schema changed");
  const [first = [], ...rows] = workbook.rows("总排行榜");
  const headers = first.map((cell) => (cell === null || cell === "" || cell === 0 || cell === false ? "" : cell instanceof Date ? cell.toISOString() : pyStr(cell)).trim());
  if (!["模型名称", "机构", ...Object.keys(SUPERCLUE_FIELDS)].every((name) => headers.includes(name))) throw new Error("SuperCLUE columns changed");
  const result: BenchmarkResult[] = [];
  rows.forEach((values, index) => {
    if (index > 10000) throw new Error("Too many benchmark rows");
    const row: Record<string, unknown> = {};
    headers.forEach((name, column) => (row[name] = values[column] ?? null));
    if (!row["模型名称"]) return;
    const scores = metrics(row, SUPERCLUE_FIELDS);
    const stamp = row["发布日期"] || row["测评发布日期"];
    let published: string | null = null;
    if (stamp instanceof Date) published = stamp.toISOString().slice(0, 10);
    else if (stamp) {
      const parts = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/.exec(pyStr(stamp).trim());
      if (!parts) throw new Error("Invalid evaluation date");
      published = isoDate(Number(parts[1]), Number(parts[2]), Number(parts[3]));
    }
    if (scores.length) result.push(resultFor("superclue", pyStr(row["模型名称"]), pyStr(row["机构"]), `SuperCLUE ${edition}`,
      { source_url: SUPERCLUE_URL, data_url: dataUrl, published_at: published, metrics: scores }));
  });
  if (!result.length) throw new Error("Empty SuperCLUE results");
  return result;
}

/** urllib.parse.quote: everything but letters, digits, _.-~ and ``safe`` percent-encoded. */

/** Python's subscript: the key's value, or a KeyError (here an Error). */
function need(value: unknown, key: string): any {
  if (!value || typeof value !== "object" || !(key in (value as object))) throw new Error(`KeyError: ${key}`);
  return (value as Record<string, unknown>)[key];
}

export function parseAa(payload: Record<string, any>): BenchmarkResult[] {
  if (!Array.isArray(payload.data) || payload.intelligence_index_version === null || payload.intelligence_index_version === undefined) throw new Error("AA schema changed");
  const version = `AA Intelligence Index v${pyStr(payload.intelligence_index_version)}`;
  const result: BenchmarkResult[] = [];
  for (const row of payload.data) {
    const scores = metrics(need(row, "evaluations"), AA_FIELDS, "index");
    if (scores.length) {
      result.push(resultFor("artificial_analysis", need(row, "name"), need(need(row, "model_creator"), "name"), version, {
        source_url: `https://artificialanalysis.ai/models/${pyQuote(String(need(row, "slug")), "")}`, data_url: AA_URL, metrics: scores, collection_method: "api" }));
    }
  }
  return result;
}

/** Decode only JSON in the public page's Next.js stream, never eval script text. */
export function aaPublicDetails(scripts: string[]): Record<string, any>[] {
  const fragments: string[] = [];
  for (const script of scripts) {
    const match = /^self\.__next_f\.push\((\[.*\])\);?$/s.exec(script.trim());
    if (!match) continue;
    let frame: unknown;
    try {
      frame = JSON.parse(match[1]);
    } catch {
      continue;
    }
    if (Array.isArray(frame) && frame.length === 2 && frame[0] === 1 && typeof frame[1] === "string") fragments.push(frame[1]);
  }
  const rows: Record<string, any>[] = [];
  for (const line of splitlines(fragments.join(""))) {
    const record = /^[0-9a-f]+:(.*)$/.exec(line);
    if (!record) continue;
    let pending: unknown[];
    try {
      pending = [JSON.parse(record[1])];
    } catch {
      continue; // Other stream records include module identifiers and plain text.
    }
    while (pending.length) {
      const value = pending.pop();
      if (Array.isArray(value)) pending.push(...value);
      else if (value && typeof value === "object") {
        const item = value as Record<string, unknown>;
        if (["slug", "shortName", "modelCreatorName", "intelligenceIndex"].every((key) => key in item)) rows.push(item);
        else pending.push(...Object.values(item));
      }
    }
  }
  return rows;
}

const finiteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function addAaDetails(given: BenchmarkResult[], details: Record<string, any>[]): BenchmarkResult[] {
  const results: BenchmarkResult[] = structuredClone(given);
  const bySlug = new Map<string, Record<string, any>[]>();
  for (const row of details) {
    if (!["slug", "shortName", "modelCreatorName"].every((key) => typeof row[key] === "string")) continue;
    bySlug.set(row.slug, [...(bySlug.get(row.slug) ?? []), row]);
  }
  for (const result of results) {
    const candidates = bySlug.get(result.source_url.split("/").at(-1)!) ?? [];
    if (candidates.length !== 1) continue;
    const [row] = candidates;
    if ((PROVIDERS[normalized(row.modelCreatorName)] ?? null) !== result.provider
      || ![normalized(row.shortName), normalized(row.name || "")].includes(normalized(result.model_name))) continue;
    const index = row.intelligenceIndex;
    const headline = result.metrics.find((m) => m.key === "artificial_analysis_intelligence_index")?.value ?? null;
    // Reject mismatched snapshots; the public table rounds the index.
    if (headline === null || !finiteNumber(index) || Math.abs(index - headline) > 0.500001) continue;
    for (const [field, [key, label, benchmark]] of Object.entries(AA_DETAIL_FIELDS)) {
      const value = row[field];
      if (value === null || value === undefined) continue;
      if (!finiteNumber(value) || !(value >= 0 && value <= 1)) throw new Error("Invalid AA benchmark ratio");
      result.metrics.push(metric({ key, label, value: value * 100, unit: "percent", benchmark }));
    }
  }
  return results;
}

export function parseAaPublic(page: string): BenchmarkResult[] {
  const parser = new PublicTableParser();
  parser.feed(page);
  parser.close();
  if (parser.table !== null) throw new Error("Incomplete AA leaderboard");
  const required = ["Model", "Creator", "Artificial Analysis Intelligence Index", "Further Analysis"];
  const candidates: [string[], typeof parser.tables[number]][] = [];
  for (const table of parser.tables) {
    table.forEach((row, index) => {
      const headers = row.map((cell) => cell.text);
      if (required.every((name) => headers.includes(name))) candidates.push([headers, table.slice(index + 1)]);
    });
  }
  if (candidates.length !== 1) throw new Error("AA public leaderboard columns changed");
  const [headers, rows] = candidates[0];
  const results: BenchmarkResult[] = [];
  for (const cells of rows) {
    if (cells.length !== headers.length) throw new Error("Incomplete AA leaderboard row");
    const row = Object.fromEntries(headers.map((name, index) => [name, cells[index]]));
    const name = row.Model.text;
    const organization = row.Creator.text;
    const raw = row["Artificial Analysis Intelligence Index"].text;
    if (["", "--", "—", "N/A"].includes(raw)) continue; // Listed without a score is not a zero or an evaluated model.
    const number = /^(\d+(?:\.\d+)?)\s*(\*)?$/.exec(raw);
    const links = row["Further Analysis"].links.filter((link) => /^\/models\/[a-z0-9_-]+$/.test(link));
    if (!number || !name || !organization || links.length !== 1) throw new Error("Invalid AA public leaderboard row");
    const sourceUrl = "https://artificialanalysis.ai" + links[0];
    const result = resultFor("artificial_analysis", name, organization, "AA Intelligence Index（网页未标版本）", { source_url: sourceUrl, data_url: AA_PUBLIC_URL,
      collection_method: "public_page", metrics: [metric({ key: "artificial_analysis_intelligence_index", label: "综合智能指数", value: Number(number[1]), unit: "index",
        note: number[2] ? "来源带 * 标记，请参阅原榜单说明" : null })] });
    // Distinct source model pages can share a display label; keep their identities separate.
    result.id = sha(`${result.id}|${sourceUrl}`);
    results.push(result);
  }
  if (!results.length) throw new Error("Empty AA public leaderboard");
  const identities = new Map<string, Set<string>>();
  const identity = (result: BenchmarkResult) => JSON.stringify([result.provider, result.model_name]);
  for (const result of results) identities.set(identity(result), (identities.get(identity(result)) ?? new Set()).add(result.source_url));
  for (const result of results) if (identities.get(identity(result))!.size > 1) result.model_key = result.source_url.split("/").at(-1)!;
  return addAaDetails(results, aaPublicDetails(parser.scripts));
}

export function matchResults(models: ModelProfile[], results: BenchmarkResult[]): Map<string, MatchedRow[]> {
  const ids = new Map<string, Set<string>>();
  const names = new Map<string, Set<string>>();
  const byId = new Map(models.map((model) => [model.id, model]));
  const add = (map: Map<string, Set<string>>, key: string, id: string) => map.set(key, (map.get(key) ?? new Set()).add(id));
  const keyOf = (provider: string | null, name: string) => JSON.stringify([provider, normalized(name)]);
  for (const model of models) {
    if (model.channel !== "api" || model.provider === "mock") continue;
    add(ids, keyOf(model.provider, model.id.split(":").slice(1).join(":")), model.id);
    add(names, keyOf(model.provider, model.display_name), model.id);
  }
  const candidatesOf = (key: string) => (ids.get(key)?.size ? ids.get(key)! : names.get(key) ?? new Set<string>());
  const matched = new Map<string, MatchedRow[]>();
  for (const result of results) {
    const key = keyOf(result.provider, result.model_key);
    const candidates = candidatesOf(key);
    // Ambiguous display names do not justify copying scores to multiple model snapshots.
    if (candidates.size !== 1) continue;
    const [identifier] = candidates;
    const model = byId.get(identifier)!;
    if (model.release_date && result.published_at && result.published_at < model.release_date) continue;
    matched.set(identifier, [...(matched.get(identifier) ?? []), { ...result, matched_by: ids.get(key)?.size ? "model_id" : "display_name" }]);
  }
  // An undated alias (deepseek-v4-pro) serves the provider's newest snapshot, which a leaderboard may
  // list with its date ("DeepSeek V4 Pro 0813"). Unless the catalog lists that newest snapshot itself,
  // the alias takes its results.
  const taken = new Set([...matched.values()].flatMap((rows) => rows.map((row) => row.id)));
  const latest = new Map<string, [string, number, BenchmarkResult[]]>();
  for (const result of results) {
    const dated = SNAPSHOT.exec(result.model_key.trim());
    if (!dated) continue;
    const candidates = candidatesOf(keyOf(result.provider, dated[1]));
    const identifier = candidates.size === 1 ? [...candidates][0] : null;
    // An exact match from the same source wins over a snapshot.
    if (identifier === null || (matched.get(identifier) ?? []).some((row) => row.source === result.source)) continue;
    const slot = JSON.stringify([identifier, result.source]);
    let newest = latest.get(slot);
    if (!newest || Number(dated[2]) > newest[1]) {
      newest = [identifier, Number(dated[2]), []];
      latest.set(slot, newest);
    }
    if (Number(dated[2]) === newest[1]) newest[2].push(result);
  }
  for (const [identifier, , rows] of latest.values()) {
    if (rows.some((result) => taken.has(result.id))) continue;
    matched.set(identifier, [...(matched.get(identifier) ?? []), ...rows.map((result) => ({ ...result, matched_by: "latest_snapshot" }))]);
  }
  for (const rows of matched.values()) rows.sort((a, b) => compareKeys([a.source, a.version, a.model_name], [b.source, b.version, b.model_name]));
  return matched;
}

type Entry = Record<string, any>;

function failure(error: unknown): string {
  if (error instanceof HttpStatusError) return `HTTP ${error.status}`;
  if (error instanceof RequestTimeout) return "请求超时";
  if (error instanceof TransportError) return "网络连接失败";
  return "来源格式变化或评分数据无效";
}

export class BenchmarkCatalog {
  cache: Record<string, Entry>;

  constructor(readonly db: Database) {
    this.cache = db.loadBenchmarkCache() as Record<string, Entry>;
  }

  results(): BenchmarkResult[] {
    return Object.values(this.cache).flatMap((entry) => ((entry.results ?? []) as Record<string, any>[]).map(validated));
  }

  matchModels(models: ModelProfile[]): Map<string, MatchedRow[]> {
    return matchResults(models, this.results());
  }

  status(models: ModelProfile[]): Record<string, unknown> {
    const matched = this.matchModels(models);
    return {
      matched_models: matched.size,
      sources: Object.fromEntries(Object.entries(SOURCE_NAMES).map(([source, name]) => [source, {
        ...Object.fromEntries(Object.entries(this.cache[source] ?? {}).filter(([key]) => key !== "results")), name,
        matched_models: [...matched.values()].filter((rows) => rows.some((row) => row.source === source)).length,
        configured: source === "artificial_analysis" ? Boolean(aaKey()) : true,
      }])),
    };
  }

  private get(fetcher: Fetcher, url: string, signal: AbortSignal, options: { headers?: Record<string, string>; params?: Record<string, string | number> } = {}) {
    return get(fetcher, url, { ...options, limit: MAX_RESPONSE_BYTES, signal });
  }

  async superclue(fetcher: Fetcher, signal: AbortSignal): Promise<BenchmarkResult[]> {
    const page = (await this.get(fetcher, SUPERCLUE_URL, signal)).text();
    const entry = /src="(\/assets\/index-[\w-]+\.js)"/.exec(page);
    if (!entry) throw new Error("SuperCLUE entry script changed");
    const entryText = (await this.get(fetcher, SUPERCLUE_URL.replace(/\/+$/, "") + entry[1], signal)).text();
    const home = /\.\/(HomePage-[\w-]+\.js)/.exec(entryText);
    if (!home) throw new Error("SuperCLUE home script changed");
    const homeText = (await this.get(fetcher, SUPERCLUE_URL + "assets/" + home[1], signal)).text();
    const chart = /\.\/(charts-main-[\w-]+\.js)/.exec(homeText);
    if (!chart) throw new Error("SuperCLUE chart script changed");
    const chartText = (await this.get(fetcher, SUPERCLUE_URL + "assets/" + chart[1], signal)).text();
    const editions = [...chartText.matchAll(/loadExcelData\("(\d{4}年\d{1,2}月)"/g)].map((match) => match[1]);
    if (new Set(editions).size !== 1) throw new Error("Ambiguous current SuperCLUE edition");
    const edition = editions[0];
    const url = SUPERCLUE_URL + "data/generalboard/" + pyQuote(edition) + ".xlsx";
    return parseSuperclue((await this.get(fetcher, url, signal)).body, edition, url);
  }

  async bfcl(fetcher: Fetcher, signal: AbortSignal): Promise<BenchmarkResult[]> {
    const [page, data] = await Promise.all([this.get(fetcher, BFCL_URL, signal), this.get(fetcher, BFCL_DATA_URL, signal)]);
    return parseBfcl(data.text(), page.text());
  }

  async aa(fetcher: Fetcher, signal: AbortSignal): Promise<BenchmarkResult[]> {
    const key = aaKey();
    if (!key) return parseAaPublic((await this.get(fetcher, AA_PUBLIC_URL, signal)).text());
    const results: BenchmarkResult[] = [];
    let version: unknown = null;
    for (let page = 1; page <= 20; page += 1) {
      const body = (await this.get(fetcher, AA_URL, signal, { headers: { "x-api-key": key }, params: { page } })).json() as Record<string, any>;
      if (version !== null && body.intelligence_index_version !== version) throw new Error("Benchmark version changed during pagination");
      version = body.intelligence_index_version ?? null;
      results.push(...parseAa(body));
      const pagination = need(body, "pagination");
      if (need(pagination, "page") !== page || typeof need(pagination, "has_more") !== "boolean") throw new Error("Invalid pagination");
      if (!pagination.has_more) {
        // Public per-benchmark measurements also complement the API's headline indices.
        try {
          const parser = new PublicTableParser();
          parser.feed((await this.get(fetcher, AA_PUBLIC_URL, signal)).text());
          parser.close();
          return addAaDetails(results, aaPublicDetails(parser.scripts));
        } catch (error) {
          if ((error as Error)?.name === "AbortError" || error instanceof RequestTimeout) throw error;
          return results;
        }
      }
    }
    throw new Error("Too many benchmark pages");
  }

  async refresh(fetcher: Fetcher, outer?: AbortSignal): Promise<void> {
    const sync = async (source: string, fetchRows: (fetcher: Fetcher, signal: AbortSignal) => Promise<BenchmarkResult[]>) => {
      const previous = this.cache[source] ?? {};
      const entry: Entry = { ...previous, checked_at: pythonNow() };
      try {
        const rows = await within(60, (signal) => fetchRows.call(this, fetcher, signal), outer);
        if (!rows.length || new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error("Empty or duplicate results");
        const published = rows.map((row) => row.published_at).filter((value): value is string => Boolean(value)).sort();
        Object.assign(entry, { status: "ok", error: null, last_success_at: pythonNow(), results: rows, count: rows.length,
          with_details: rows.filter((row) => row.metrics.some((m) => m.benchmark)).length, collection_method: rows[0].collection_method,
          latest_published_at: published.at(-1) ?? null });
      } catch (error) {
        if (outer?.aborted) return;
        Object.assign(entry, { status: "error", error: `${failure(error)}，保留上次评分` });
      }
      this.db.saveBenchmarkCache(source, entry);
      this.cache[source] = entry;
    };
    await Promise.all([sync("superclue", this.superclue), sync("bfcl", this.bfcl), sync("artificial_analysis", this.aa)]);
  }
}

/** utcnow().isoformat(), as Python writes it. */
export const pythonNow = () => pythonIso(new Date());

export { pyQuote };
