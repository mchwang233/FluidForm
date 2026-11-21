// Searching the web and reading a page, for API models whose step or chat may use the internet (the
// WebSearch and WebFetch tools).
// - WebSearch: settings.web_search_models lists the search services to use, first choice first
//   (e.g. ["glm:search_std"]); not set, every one in AUTO whose provider has a key here; empty: no
//   such tool. Each provider's key is the one its chat models use. Charged by the search.
// - WebFetch (settings.web_fetch): a public http(s) page as text. Only public addresses: an address
//   of this machine or its network is refused, after every redirect.
// FluidForm itself makes these requests, so both are offered only to a step or chat that is allowed
// the internet anyway (Workspace.network).
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { settings } from "./config.js";
import { HTML5, INVALID_CHARREFS, INVALID_CODEPOINTS } from "./html-entities.generated.js";
import { head, pyRegex, pyStr } from "./py.js";
import { PROVIDER_ENV } from "./secret-names.js";

// What one search costs, in US dollars, by service; a service not listed costs DEFAULT_PRICE.
export const PRICES: Record<string, number> = { "glm:search_std": 0.005, "glm:search_pro": 0.01, "glm:search_pro_sogou": 0.01, "glm:search_pro_quark": 0.01 };
export const DEFAULT_PRICE = 0.01;
export const TIMEOUT_SECONDS = 30;
export const MAX_RESULTS = 10;
export const MAX_PAGE_BYTES = 3 * 1024 * 1024;
export const MAX_PAGE_CHARS = 40_000;
export const MAX_REDIRECTS = 5;

export const SEARCH_TOOL = {
  name: "WebSearch",
  description: "Searches the web and returns the top results: title, address, date and an excerpt.\n"
    + "- Use it for anything current or that you do not know for sure: news, prices, weather, "
    + "versions, documentation. Then WebFetch a result to read it in full, if you need to.\n"
    + "- It costs money per search: search for what you need, not again for the same thing.\n"
    + "- Say where what you found comes from (its address).",
  parameters: { type: "object", properties: {
    query: { type: "string", description: "What to search for, in the language of what you want to find" },
    count: { type: "integer", description: `How many results, 1 to ${MAX_RESULTS} (default 5)` },
  }, required: ["query"] },
};
export const FETCH_TOOL = {
  name: "WebFetch",
  description: "Reads a public web page and returns its text (an HTML page without its markup; JSON or text "
    + "as it is). Long pages are cut. Pages that need a login or JavaScript may come back empty.",
  parameters: { type: "object", properties: {
    url: { type: "string", description: "The page's full address, http or https" },
  }, required: ["url"] },
};

export class WebError extends Error {
  override name = "WebError";
}

// The search services used when settings.web_search_models is not set, first choice first.
export const AUTO = ["glm:search_std"];

export type Result = { title: unknown; url: unknown; date: unknown; excerpt: unknown; site: unknown };
type Search = (fetcher: typeof fetch, engine: string, query: string, count: number, key: string) => Promise<Result[]>;

async function glm(fetcher: typeof fetch, engine: string, query: string, count: number, key: string): Promise<Result[]> {
  const response = await fetcher("https://open.bigmodel.cn/api/paas/v4/web_search", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ search_engine: engine, search_query: query, count }),
  });
  const text = await response.text();
  let body: unknown = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }
  if (!response.ok || !body || typeof body !== "object" || Array.isArray(body)) {
    const shown = body && typeof body === "object" && Object.keys(body).length ? pyStr(body) : text;
    throw new WebError(`HTTP ${response.status}：${head(shown, 200)}`);
  }
  const items = (body as Record<string, unknown>).search_result;
  return (Array.isArray(items) ? items : []).filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({ title: item.title ?? null, url: item.link ?? null, date: item.publish_date ?? null, excerpt: item.content ?? null, site: item.media ?? null }));
}

const SEARCH: Record<string, Search> = { glm };

/** The search services that can be used now: listed (or, not set, AUTO), of a known provider, with its key. */
export function searchServices(): string[] {
  const listed = settings.web_search_models ?? AUTO;
  return listed.filter((service) => {
    const provider = service.split(":", 1)[0];
    return provider in SEARCH && Boolean(process.env[PROVIDER_ENV[provider] ?? ""]);
  });
}

export function price(service: string): number {
  return PRICES[service] ?? DEFAULT_PRICE;
}

/** The web tools for a workspace: one that may act and may use the internet. */
export function toolsFor(workspace: { readOnly: boolean; host: boolean; network: boolean }) {
  if (workspace.readOnly || workspace.host || !workspace.network) return [];
  return [...(searchServices().length ? [SEARCH_TOOL] : []), ...(settings.web_fetch ? [FETCH_TOOL] : [])];
}

const withTimeout = (fetcher: typeof fetch): typeof fetch => (input, init) =>
  fetcher(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(TIMEOUT_SECONDS * 1000) });

/** Python's int(): an int, a float cut toward zero, or an integer string. */
function pyInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value)) return Number(value.trim());
  throw new TypeError(`invalid literal for int(): ${String(value)}`);
}

/** Results from the first service that answers, and which one did. */
export async function search(text: string, count: unknown = 5, fetcher: typeof fetch = fetch): Promise<[Result[], string]> {
  const services = searchServices();
  if (!services.length) throw new WebError("no search service is set up on this machine");
  const query = head(text.trim(), 500);
  if (!query) throw new WebError("query is required");
  const wanted = Math.max(1, Math.min(pyInt(count || 5), MAX_RESULTS));
  const errors: string[] = [];
  for (const service of services) {
    const provider = service.slice(0, service.indexOf(":"));
    const engine = service.slice(service.indexOf(":") + 1);
    try {
      return [(await SEARCH[provider](withTimeout(fetcher), engine, query, wanted, process.env[PROVIDER_ENV[provider]]!)).slice(0, wanted), service];
    } catch (error) {
      errors.push(`${service}: ${(error as Error).message ?? error}`);
    }
  }
  throw new WebError(errors.join("; "));
}

export function formatResults(results: Result[]): string {
  if (!results.length) return "No results.";
  return results.map((item, index) => `${index + 1}. ${pyStr(item.title || "(no title)")}\n${pyStr(item.url || "")}`
    + (item.date ? `\n${pyStr(item.date)}` : "")
    + (item.excerpt ? `\n${head(pyStr(item.excerpt || "").trim(), 800)}` : "")).join("\n\n");
}

// Python's ipaddress (3.9): an address is private in these networks unless it is in an exception;
// global when not private (and, for IPv4, not in 100.64.0.0/10). An IPv4-mapped IPv6 address
// follows its IPv4 address.
const PRIVATE_V4 = ["0.0.0.0/8", "10.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.0.170/31",
  "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "255.255.255.255/32"];
const PRIVATE_V4_EXCEPTIONS = ["192.0.0.9/32", "192.0.0.10/32"];
const PUBLIC_V4_NOT_GLOBAL = "100.64.0.0/10";
const PRIVATE_V6 = ["::1/128", "::/128", "::ffff:0.0.0.0/96", "64:ff9b:1::/48", "100::/64", "2001::/23", "2001:db8::/32", "2002::/16",
  "3fff::/20", "fc00::/7", "fe80::/10"];
const PRIVATE_V6_EXCEPTIONS = ["2001:1::1/128", "2001:1::2/128", "2001:3::/32", "2001:4:112::/48", "2001:20::/28", "2001:30::/28"];

const v4 = (address: string) => address.split(".").reduce((value, part) => value * 256n + BigInt(Number(part)), 0n);

function v6(address: string): bigint {
  let text = address.toLowerCase().split("%")[0];
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const value = Number(v4(tail[1]));
    text = text.slice(0, -tail[1].length) + `${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const [left, right] = text.split("::");
  const a = left ? left.split(":") : [];
  const b = right !== undefined ? (right ? right.split(":") : []) : [];
  const groups = right !== undefined ? [...a, ...Array(8 - a.length - b.length).fill("0"), ...b] : a;
  return groups.reduce((value, group) => value * 65536n + BigInt(parseInt(group || "0", 16)), 0n);
}

function within(value: bigint, network: string, bits: number, parse: (text: string) => bigint): boolean {
  const [base, length] = network.split("/");
  const shift = BigInt(bits - Number(length));
  return value >> shift === parse(base) >> shift;
}

function globalV4(value: bigint): boolean {
  const privateOne = PRIVATE_V4.some((net) => within(value, net, 32, v4)) && !PRIVATE_V4_EXCEPTIONS.some((net) => within(value, net, 32, v4));
  return !within(value, PUBLIC_V4_NOT_GLOBAL, 32, v4) && !privateOne;
}

/** Whether an address is public (Python's ip.is_global and not ip.is_multicast). */
export function isPublicAddress(address: string): boolean {
  const kind = isIP(address.split("%")[0]);
  if (kind === 4) {
    const value = v4(address);
    return globalV4(value) && !within(value, "224.0.0.0/4", 32, v4);
  }
  if (kind === 6) {
    const value = v6(address);
    if (value >> 32n === 0xffffn) return globalV4(value & 0xffffffffn) && !within(value & 0xffffffffn, "224.0.0.0/4", 32, v4);
    const privateOne = PRIVATE_V6.some((net) => within(value, net, 128, v6)) && !PRIVATE_V6_EXCEPTIONS.some((net) => within(value, net, 128, v6));
    return !privateOne && value >> 120n !== 0xffn;
  }
  return false;
}

/** Whether every address the host has is public (not this machine, its network or reserved). */
export const deps = {
  isPublic: (host: string) => isPublic(host),
  search: (text: string, count: unknown = 5) => search(text, count),
};

async function isPublic(host: string): Promise<boolean> {
  let addresses: string[];
  try {
    addresses = [...new Set((await lookup(host.replace(/^\[|\]$/g, ""), { all: true })).map((item) => item.address))];
  } catch {
    throw new WebError(`cannot find ${host}`);
  }
  return addresses.length > 0 && addresses.every(isPublicAddress);
}

async function checked(url: string): Promise<string> {
  let parts: URL;
  try {
    parts = new URL(url);
  } catch {
    throw new WebError("only http and https addresses can be read");
  }
  if (!["http:", "https:"].includes(parts.protocol) || !parts.hostname) throw new WebError("only http and https addresses can be read");
  if (parts.username || parts.password) throw new WebError("addresses with a user or password are not read");
  if (!await deps.isPublic(parts.hostname.replace(/^\[|\]$/g, ""))) throw new WebError(`${parts.hostname.replace(/^\[|\]$/g, "")} is not a public address`);
  return url;
}

const CHARREF = pyRegex(String.raw`&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)`, "g");

/** html.unescape */
export function unescape(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(CHARREF, (_, name: string) => {
    if (name[0] === "#") {
      const number = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2).replace(/;$/, ""), 16) : parseInt(name.slice(1).replace(/;$/, ""), 10);
      if (number in INVALID_CHARREFS) return INVALID_CHARREFS[number];
      if ((number >= 0xd800 && number <= 0xdfff) || number > 0x10ffff) return "�";
      if (INVALID_CODEPOINTS.has(number)) return "";
      return String.fromCodePoint(number);
    }
    if (name in HTML5) return HTML5[name];
    // the longest matching name (as defined by the standard)
    for (let length = name.length - 1; length > 1; length -= 1) {
      if (name.slice(0, length) in HTML5) return HTML5[name.slice(0, length)] + name.slice(length);
    }
    return "&" + name;
  });
}

const SKIP = new Set(["script", "style", "noscript", "svg", "template", "head"]);
const BLOCK = new Set(["p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "pre", "table"]);
// Elements whose content html.parser reads as plain text up to their end tag.
const RAW = new Set(["script", "style"]);

/** An HTML page as its text and title, as web.ts's html.parser reader makes them. */
export function pageText(html: string): string {
  const parts: string[] = [];
  let title = "";
  let skipping = 0;
  let inTitle = false;
  const data = (text: string) => {
    const decoded = unescape(text);
    if (inTitle) title += decoded;
    else if (!skipping) parts.push(decoded);
  };
  const start = (tag: string) => {
    if (SKIP.has(tag)) skipping += 1;
    if (tag === "title") inTitle = true;
    if (BLOCK.has(tag)) parts.push("\n");
  };
  const end = (tag: string) => {
    if (SKIP.has(tag) && skipping) skipping -= 1;
    if (tag === "title") inTitle = false;
  };
  let at = 0;
  const tagPattern = /<(\/)?([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/y;
  while (at < html.length) {
    const next = html.indexOf("<", at);
    if (next < 0) {
      data(html.slice(at));
      break;
    }
    if (next > at) data(html.slice(at, next));
    at = next;
    if (html.startsWith("<!--", at)) {
      const close = html.indexOf("-->", at + 4);
      at = close < 0 ? html.length : close + 3;
      continue;
    }
    if (html.startsWith("<!", at) || html.startsWith("<?", at)) {
      const close = html.indexOf(">", at);
      at = close < 0 ? html.length : close + 1;
      continue;
    }
    tagPattern.lastIndex = at;
    const found = tagPattern.exec(html);
    if (!found) {
      data("<");
      at += 1;
      continue;
    }
    const tag = found[2].toLowerCase();
    at = tagPattern.lastIndex;
    if (found[1]) {
      end(tag);
      continue;
    }
    start(tag);
    if (found[3].trimEnd().endsWith("/")) end(tag); // <br/>: html.parser calls both
    else if (RAW.has(tag)) {
      // Its content is text up to its end tag, never markup.
      const close = html.slice(at).search(new RegExp(`</${tag}\\s*>`, "i"));
      const content = close < 0 ? html.slice(at) : html.slice(at, at + close);
      if (inTitle) title += content;
      else if (!skipping) parts.push(content);
      at = close < 0 ? html.length : at + close;
    }
  }
  const text = parts.join("").replace(/[ \t\r\f\v]+/g, " ").replace(pyRegex(String.raw`\n\s*\n+`, "g"), "\n\n").trim();
  return (title.trim() ? `# ${title.trim()}\n\n` : "") + text;
}

/** A public page as text, cut to MAX_PAGE_CHARS. */
export async function fetchPage(url: unknown, fetcher: typeof fetch = fetch): Promise<string> {
  if (typeof url !== "string" || !url.trim()) throw new WebError("url is required");
  let current = url.trim();
  let body = Buffer.alloc(0);
  let kind = "";
  let charset = "utf-8";
  let done = false;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      await checked(current);
      const response = await fetcher(current, { redirect: "manual", headers: { "User-Agent": "FluidForm/1 (web reader)" },
        signal: AbortSignal.timeout(TIMEOUT_SECONDS * 1000) });
      const location = response.headers.get("location");
      if ([301, 302, 303, 307, 308].includes(response.status) && location) {
        await response.body?.cancel();
        current = new URL(location, current).toString();
        continue;
      }
      if (response.status >= 400) {
        await response.body?.cancel();
        throw new WebError(`HTTP ${response.status}`);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      while (reader) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        chunks.push(Buffer.from(value));
        size += value.length;
        if (size > MAX_PAGE_BYTES) {
          await reader.cancel();
          break;
        }
      }
      body = Buffer.concat(chunks);
      kind = response.headers.get("content-type") ?? "";
      charset = /charset=["']?([^;"'\s]+)/i.exec(kind)?.[1] ?? "utf-8";
      done = true;
      break;
    }
  } catch (error) {
    if (error instanceof WebError) throw error;
    throw new WebError(`cannot read the page: ${(error as Error).message ?? error}`);
  }
  if (!done) throw new WebError("too many redirects");
  if (kind && !["text", "json", "xml", "javascript"].some((word) => kind.includes(word))) throw new WebError(`not a page of text (${kind.split(";")[0]})`);
  let text: string;
  try {
    text = new TextDecoder(charset).decode(body);
  } catch {
    text = new TextDecoder("utf-8").decode(body);
  }
  if (kind.includes("html") || ["<!doctype", "<html"].some((start) => text.trimStart().slice(0, 15).toLowerCase().startsWith(start))) text = pageText(text);
  if (text.length > MAX_PAGE_CHARS) text = head(text, MAX_PAGE_CHARS) + "\n...(the rest of the page is cut)";
  return `${current}\n\n${text || "(the page has no text)"}`;
}
