// Python's behaviour where FluidForm still depends on it exactly. The backend was Python until it was
// ported: records it saved (json.dumps's text, its rounding and float format), the regexes and shell
// quoting it wrote, and the cases in tests/golden/ need the same results here. So these stay rather than
// being swapped for nearer JS equivalents: context variables, json.dumps's exact text, round() (half to
// even), str(), shlex, fnmatch, sorting by keys, and string cuts that never split a character.
import { AsyncLocalStorage } from "node:async_hooks";

/** A contextvars.ContextVar: a value seen by the code run with it, and by what that code starts
 *  (async calls, timers), and not by anything else running meanwhile. */
export class ContextVar<T> {
  private readonly storage = new AsyncLocalStorage<{ value: T }>();

  constructor(readonly name: string, private readonly fallback: T) {}

  get(): T {
    const box = this.storage.getStore();
    return box ? box.value : this.fallback;
  }

  /** ``work`` (and what it starts) sees ``value``; afterwards the value is what it was. */
  run<R>(value: T, work: () => R): R {
    return this.storage.run({ value }, work);
  }
}

/** asyncio.Event */
export class AsyncEvent {
  private flag = false;
  private waiters: (() => void)[] = [];

  isSet(): boolean {
    return this.flag;
  }

  set(): void {
    this.flag = true;
    const waiting = this.waiters;
    this.waiters = [];
    for (const wake of waiting) wake();
  }

  clear(): void {
    this.flag = false;
  }

  wait(): Promise<void> {
    return this.flag ? Promise.resolve() : new Promise((resolve) => this.waiters.push(resolve));
  }
}

function pyFloat(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
  return JSON.stringify(value);
}

const ESCAPES: Record<string, string> = { '"': '\\"', "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };

function pyString(text: string, ascii: boolean): string {
  let out = '"';
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (ESCAPES[char]) out += ESCAPES[char];
    else if (code < 0x20 || (ascii && code > 0x7e)) {
      if (code > 0xffff) {
        // Python writes a character beyond the BMP as its surrogate pair.
        const high = Math.floor((code - 0x10000) / 0x400) + 0xd800;
        const low = ((code - 0x10000) % 0x400) + 0xdc00;
        out += `\\u${high.toString(16).padStart(4, "0")}\\u${low.toString(16).padStart(4, "0")}`;
      } else out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else out += char;
  }
  return `${out}"`;
}

/** json.dumps(value) as Python writes it: ", " and ": " between items, non-ASCII escaped unless
 *  ``ensureAscii`` is false (ensure_ascii=False). Numbers JS cannot tell apart (1 and 1.0) are
 *  written as JS has them. */
export function pyDumps(value: unknown, ensureAscii = true, sortKeys = false): string {
  const dumps = (item: unknown) => pyDumps(item, ensureAscii, sortKeys);
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return pyFloat(value);
  if (typeof value === "string") return pyString(value, ensureAscii);
  if (Array.isArray(value)) return `[${value.map(dumps).join(", ")}]`;
  if (value instanceof Map) {
    return `{${[...value].map(([key, item]) => `${pyString(String(key), ensureAscii)}: ${dumps(item)}`).join(", ")}}`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
    if (sortKeys) entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${pyString(key, ensureAscii)}: ${dumps(item)}`).join(", ")}}`;
  }
  return pyString(String(value), ensureAscii);
}

/** json.JSONDecoder().raw_decode(text): the JSON value at the very start of ``text`` and where it
 *  ends (what follows is left alone); throws when no value starts there. */
export function rawDecode(text: string): [unknown, number] {
  const first = text[0];
  let end = -1;
  if (first === "{" || first === "[") {
    let depth = 0;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === '"') {
        for (index += 1; index < text.length && text[index] !== '"'; index += 1) if (text[index] === "\\") index += 1;
      } else if (char === "{" || char === "[") depth += 1;
      else if (char === "}" || char === "]") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
  } else if (first === '"') {
    for (let index = 1; index < text.length; index += 1) {
      if (text[index] === "\\") index += 1;
      else if (text[index] === '"') {
        end = index + 1;
        break;
      }
    }
  } else {
    const found = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text);
    if (found) end = found[0].length;
  }
  if (end < 0) throw new SyntaxError("Expecting value");
  return [JSON.parse(text.slice(0, end)), end];
}

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;

/** text[:count] without splitting a character in two. */
export function head(text: string, count: number): string {
  if (count <= 0) return "";
  if (text.length <= count) return text;
  return isHigh(text.charCodeAt(count - 1)) ? text.slice(0, count - 1) : text.slice(0, count);
}

/** text[-count:] without splitting a character in two. */
export function tail(text: string, count: number): string {
  if (count <= 0) return "";
  if (text.length <= count) return text;
  const start = text.length - count;
  return isHigh(text.charCodeAt(start - 1)) ? text.slice(start + 1) : text.slice(start);
}

/** Python's truthiness: "", 0, null, [], {} are false. */
export function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function pyRepr(value: unknown): string {
  if (typeof value === "string") {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    const body = value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
    return quote + (quote === "'" ? body.replace(/'/g, "\\'") : body) + quote;
  }
  return pyStr(value);
}

/** str(value) as Python writes it: True, None, ['a', 1], {'k': 'v'}. */
export function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nan";
    if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (isObject(value)) return `{${Object.entries(value).map(([key, item]) => `${pyRepr(key)}: ${pyRepr(item)}`).join(", ")}}`;
  return String(value);
}

/** shlex.quote: a word the shell reads back as it is. */
export function shlexQuote(word: string): string {
  if (!word) return "''";
  if (/^[\w@%+=:,./-]+$/.test(word) && /^[\x00-\x7f]*$/.test(word)) return word;
  return `'${word.replace(/'/g, `'"'"'`)}'`;
}

/** shlex.join */
export function shlexJoin(words: string[]): string {
  return words.map(shlexQuote).join(" ");
}

/** shlex.split (POSIX): words as the shell would split them; throws on an unclosed quote. With
 *  ``comments``, an unquoted # ends the word and drops the rest of its line (shlex's commenters). */
export function shlexSplit(text: string, comments = false): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && index + 1 < text.length && '\\"$`\n'.includes(text[index + 1])) {
        word += text[index + 1];
        index += 1;
      } else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (char === "\\") {
      if (index + 1 < text.length) {
        word += text[index + 1];
        index += 1;
      }
      inWord = true;
    } else if (/\s/.test(char)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else if (comments && char === "#") {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
      const end = text.indexOf("\n", index);
      index = end < 0 ? text.length : end;
    } else {
      word += char;
      inWord = true;
    }
  }
  if (quote) throw new Error("No closing quotation");
  if (inWord) words.push(word);
  return words;
}

/** round(value, digits) as Python rounds: on the exact binary value (85.35 is 85.3499...), an
 *  exact half going to the even neighbour. */
export function pyRound(value: number, digits = 0): number {
  if (!Number.isFinite(value)) return value;
  // toFixed works on the exact value and breaks exact ties upwards; only ties need fixing.
  const exact = Math.abs(value).toFixed(Math.min(100, digits + 60));
  const point = exact.indexOf(".");
  const rest = exact.slice(point + 1 + digits);
  if (/^50*$/.test(rest)) {
    const kept = exact.slice(0, point + 1 + digits).replace(/\.$/, "");
    const last = Number(kept[kept.length - 1]);
    const down = Number(kept);
    const step = 10 ** -digits;
    const result = last % 2 === 0 ? down : Number((down + step).toFixed(Math.max(digits, 0)));
    return value < 0 ? -result : result;
  }
  return Number(value.toFixed(digits));
}

/** format(value, "g"): six significant digits, no trailing zeros, exponent past 1e16 or below 1e-4. */
export function formatG(value: number, precision = 6): string {
  if (value === 0) return "0";
  if (!Number.isFinite(value)) return Number.isNaN(value) ? "nan" : value > 0 ? "inf" : "-inf";
  const exponent = Math.floor(Math.log10(Math.abs(Number(value.toPrecision(precision)))));
  if (exponent < -4 || exponent >= precision) {
    const [mantissa, power] = value.toExponential(precision - 1).split("e");
    const trimmed = mantissa.includes(".") ? mantissa.replace(/0+$/, "").replace(/\.$/, "") : mantissa;
    const sign = power.startsWith("-") ? "-" : "+";
    return `${trimmed}e${sign}${power.replace(/^[+-]/, "").padStart(2, "0")}`;
  }
  const fixed = value.toFixed(Math.max(0, precision - 1 - exponent));
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

const WORD = "[\\p{L}\\p{N}_]";
// Python's \s on str: what str.isspace() is (JS's \s differs: no \x1c-\x1f or \x85, has \ufeff).
const SPACE = "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
/** A character as itself in a u-mode pattern (where needless escapes are errors). */
const literal = (char: string) => (/[\w\s]/.test(char) ? char : `\\u{${char.codePointAt(0)!.toString(16)}}`);
const NOT_WORD = "[^\\p{L}\\p{N}_]";

/** A Python regular expression (re module, str pattern) as a JS RegExp that matches the same:
 *  ^ $ . with Python's line rules (only \n ends a line), \w \d \b \s on Unicode as Python's, \A \Z,
 *  (?P<name>...) and (?P=name). ``flags``: "m" MULTILINE, "s" DOTALL, "i" IGNORECASE, "g" to find all. */
export function pyRegex(source: string, given = ""): RegExp {
  // Flags written at the start of the pattern, (?i) (?ms) ...
  let pattern = source;
  let flags = given;
  for (let inline = /^\(\?([aimsux]+)\)/.exec(pattern); inline; inline = /^\(\?([aimsux]+)\)/.exec(pattern)) {
    flags += inline[1];
    pattern = pattern.slice(inline[0].length);
  }
  const multiline = flags.includes("m");
  const dotall = flags.includes("s");
  let out = "";
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\") {
      const next = pattern[index + 1];
      index += 1;
      if (inClass) {
        out += next === "w" ? "\\p{L}\\p{N}_" : next === "d" ? "\\p{Nd}" : next === "s" ? SPACE
          : /[A-Za-z0-9]/.test(next) || "\\]^-[".includes(next) ? `\\${next}` : literal(next);
        continue;
      }
      if (next === "w") out += WORD;
      else if (next === "W") out += NOT_WORD;
      else if (next === "d") out += "\\p{Nd}";
      else if (next === "D") out += "\\P{Nd}";
      else if (next === "b") out += `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;
      else if (next === "B") throw new Error("pyRegex: \\B is not translated (FluidForm does not use it)");
      else if (next === "A") out += "(?<![\\s\\S])";
      else if (next === "Z") out += "(?![\\s\\S])";
      else if (next === "s") out += `[${SPACE}]`;
      else if (next === "S") out += `[^${SPACE}]`;
      else if (/[A-Za-z0-9]/.test(next) || "^$\\.*+?()[]{}|/".includes(next)) out += `\\${next}`;
      else out += literal(next);
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      out += char;
      continue;
    }
    if (char === "[") {
      inClass = true;
      out += char;
      if (pattern[index + 1] === "^") {
        out += "^";
        index += 1;
      }
      if (pattern[index + 1] === "]") {
        out += "\\]";
        index += 1;
      }
      continue;
    }
    if (char === "(" && pattern.startsWith("(?P<", index)) {
      out += "(?<";
      index += 3;
      continue;
    }
    if (char === "(" && pattern.startsWith("(?P=", index)) {
      const end = pattern.indexOf(")", index);
      out += `\\k<${pattern.slice(index + 4, end)}>`;
      index = end;
      continue;
    }
    if (char === "^") out += multiline ? "(?<![^\\n])" : "(?<![\\s\\S])";
    else if (char === "$") out += multiline ? "(?![^\\n])" : "(?=\\n?(?![\\s\\S]))";
    else if (char === ".") out += dotall ? "[\\s\\S]" : "[^\\n]";
    else out += char;
  }
  const jsFlags = `u${flags.includes("i") ? "i" : ""}${flags.includes("g") ? "g" : ""}`;
  return new RegExp(out, jsFlags);
}

/** f"{value:.{digits}f}" as Python writes it (an exact half to the even neighbour). */
export function fixed(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? "nan" : value > 0 ? "inf" : "-inf";
  const magnitude = Math.abs(pyRound(value, digits));
  // toFixed switches to an exponent at 1e21; Python writes every digit.
  const text = magnitude >= 1e21 ? BigInt(magnitude).toString() + (digits ? `.${"0".repeat(digits)}` : "") : magnitude.toFixed(digits);
  // Python keeps the sign of a negative value that rounds to zero ("-0").
  return value < 0 || Object.is(value, -0) ? `-${text}` : text;
}

type Key = number | string | boolean | null | undefined | Key[];

/** Python's comparison of sort keys: tuples item by item, False < True, numbers, then strings. */
export function compareKeys(a: Key, b: Key): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
      const order = compareKeys(a[index], b[index]);
      if (order) return order;
    }
    return a.length - b.length;
  }
  const value = (item: Key) => (typeof item === "boolean" ? Number(item) : item);
  const x = value(a);
  const y = value(b);
  if (x === y) return 0;
  if (x === null || x === undefined || y === null || y === undefined) throw new TypeError("None is not comparable");
  return x < y ? -1 : 1;
}

/** min(items, key=key): the first of the smallest; ``fallback`` (or an error) when there are none. */
export function minBy<T>(items: Iterable<T>, key: (item: T) => Key, ...fallback: [T?]): T {
  let best: T | undefined;
  let bestKey: Key = null;
  let found = false;
  for (const item of items) {
    const itemKey = key(item);
    if (!found || compareKeys(itemKey, bestKey) < 0) {
      best = item;
      bestKey = itemKey;
      found = true;
    }
  }
  if (!found) {
    if (fallback.length) return fallback[0] as T;
    throw new Error("min() arg is an empty sequence");
  }
  return best as T;
}

/** max(items, key=key): the first of the largest. */
export function maxBy<T>(items: Iterable<T>, key: (item: T) => Key, ...fallback: [T?]): T {
  let best: T | undefined;
  let bestKey: Key = null;
  let found = false;
  for (const item of items) {
    const itemKey = key(item);
    if (!found || compareKeys(itemKey, bestKey) > 0) {
      best = item;
      bestKey = itemKey;
      found = true;
    }
  }
  if (!found) {
    if (fallback.length) return fallback[0] as T;
    throw new Error("max() arg is an empty sequence");
  }
  return best as T;
}

/** sorted(items, key=key): a stable sort by Python's key order. */
export function sortedBy<T>(items: Iterable<T>, key: (item: T) => Key, reverse = false): T[] {
  const keyed = [...items].map((item, index) => ({ item, key: key(item), index }));
  keyed.sort((a, b) => (reverse ? compareKeys(b.key, a.key) : compareKeys(a.key, b.key)) || a.index - b.index);
  return keyed.map((entry) => entry.item);
}

/** str.splitlines(): lines split at \n, \r\n, \r, \v, \f, \x1c-\x1e, \x85, \u2028, \u2029; no
 *  empty last line for a trailing line break. */
const LINE_BREAK = "\\r\\n|[\\n\\r\\v\\f\\x1c-\\x1e\\x85\\u2028\\u2029]";
export function splitlines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(new RegExp(LINE_BREAK));
  if (new RegExp(`(?:${LINE_BREAK})$`).test(text)) lines.pop();
  return lines;
}

/** re.escape: the characters Python's re treats as special, escaped. */
export function reEscape(text: string): string {
  return text.replace(/[()[\]{}?*+\-|^$\\.&~# \t\n\r\v\f]/g, (char) => ({ "\t": "\\t", "\n": "\\n", "\r": "\\r", "\v": "\\v", "\f": "\\f" }[char] ?? `\\${char}`));
}

/** PurePosixPath(name): its parts ("." and empty ones dropped, as Python drops them), whether it is
 *  absolute, and as_posix(). */
export function posixPath(name: string): { parts: string[]; absolute: boolean; posix: string } {
  const absolute = name.startsWith("/");
  // Python keeps exactly two leading slashes ("//x"), and treats three or more as one.
  const root = absolute ? (name.startsWith("//") && !name.startsWith("///") ? "//" : "/") : "";
  const rest = name.split("/").filter((part) => part && part !== ".");
  return { parts: root ? [root, ...rest] : rest, absolute, posix: root + rest.join("/") || "." };
}

/** Path(name).suffix: the last ".ext" of the final part, "" for ".env" or "name.". */
export function suffix(name: string): string {
  const last = name.split("/").filter(Boolean).pop() ?? "";
  const at = last.lastIndexOf(".");
  return at > 0 && at < last.length - 1 ? last.slice(at) : "";
}

/** Path(name).stem: the final part without its suffix. */
export function stem(name: string): string {
  const last = name.split("/").filter(Boolean).pop() ?? "";
  const ext = suffix(last);
  return ext ? last.slice(0, -ext.length) : last;
}

/** int(value) as Python converts a tool argument: an int, a float cut toward zero, a bool, or an
 *  integer string; throws otherwise. */
export function pyInt(value: unknown): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("cannot convert float infinity or NaN to integer");
    return Math.trunc(value);
  }
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "string" && /^\s*[+-]?\d+(_\d+)*\s*$/.test(value)) return Number(value.trim().replaceAll("_", ""));
  throw new TypeError(`invalid literal for int(): ${String(value)}`);
}

/** float(value) for a tool argument: numbers, bools and numeric strings; throws otherwise. */
export function pyFloat2(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value.trim()))) return Number(value.trim());
  if (typeof value === "string" && /^\s*[+-]?(inf|infinity|nan)\s*$/i.test(value)) return Number(value.trim().replace(/inf(inity)?/i, "Infinity"));
  throw new TypeError(`could not convert to float: ${String(value)}`);
}

/** fnmatch.fnmatchcase: * ? [seq] [!seq], the whole name. */
export function fnmatch(name: string, pattern: string): boolean {
  let out = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") out += "[\\s\\S]*";
    else if (char === "?") out += "[\\s\\S]";
    else if (char === "[") {
      let end = index + 1;
      if (pattern[end] === "!") end += 1;
      if (pattern[end] === "]") end += 1;
      while (end < pattern.length && pattern[end] !== "]") end += 1;
      if (end >= pattern.length) out += "\\[";
      else {
        let body = pattern.slice(index + 1, end).replace(/\\/g, "\\\\");
        index = end;
        if (body.startsWith("!")) body = "^" + body.slice(1);
        else if (body.startsWith("^")) body = "\\" + body;
        out += `[${body}]`;
      }
    } else out += char.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
  }
  try {
    return new RegExp(`^(?:${out})$`, "u").test(name);
  } catch {
    return false;
  }
}

/** A file's text as Python's text mode reads it: UTF-8 with bad bytes replaced, every line break
 *  (\r\n, \r) a \n. */
export function universalNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** str.split() with no separator: the words between runs of whitespace. */
export function pySplit(text: string): string[] {
  return text.split(new RegExp(`[${SPACE}]+`)).filter(Boolean);
}

/** datetime.isoformat() of a stored time ("…Z" or "…+00:00", any fraction): "+00:00" for UTC, six
 *  fraction digits unless there are none. */
export function pyIsoformat(text: string): string {
  const found = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})?$/.exec(text);
  if (!found) return text;
  const [, base, fraction = "", zone = ""] = found;
  const micro = fraction.padEnd(6, "0");
  return `${base}${/^0+$/.test(micro) ? "" : `.${micro}`}${zone === "Z" ? "+00:00" : zone}`;
}

/** repr() of a Python float: "1.0" for one, "1e-05" past the fixed range (Python writes exponents
 *  below 1e-4 and from 1e16), the shortest digits that read back the same. */
function pyFloatRepr(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const [mantissa, power] = Math.abs(value).toExponential().split("e");
  const exponent = Number(power);
  const digits = mantissa.replace(".", "");
  const sign = value < 0 ? "-" : "";
  if (exponent < -4 || exponent >= 16) {
    const shown = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${shown}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  let text: string;
  if (exponent < 0) text = `0.${"0".repeat(-exponent - 1)}${digits}`;
  else if (digits.length > exponent + 1) text = `${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}`;
  else text = `${digits}${"0".repeat(exponent + 1 - digits.length)}.0`;
  return sign + text;
}

/** json.dumps(value, sort_keys=sortKeys) of a model dumped by Pydantic in JSON mode: the fields named
 *  in ``floats`` are Python floats (written "1.0", "1e-05"), everything else as pyDumps writes it. */
export function pyModelDumps(value: unknown, floats: ReadonlySet<string>, sortKeys = true, ensureAscii = true): string {
  const marked = new Map<string, number>();
  let next = 0;
  const mark = (item: unknown, key: string | null): unknown => {
    if (Array.isArray(item)) return item.map((entry) => mark(entry, null));
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, mark(entry, name)]));
    if (key !== null && floats.has(key) && typeof item === "number") {
      const token = `\u0000float${next++}\u0000`;
      marked.set(token, item);
      return token;
    }
    return item;
  };
  const text = pyDumps(mark(value, null), ensureAscii, sortKeys);
  return text.replace(/"\\u0000float\d+\\u0000"/g, (token) => pyFloatRepr(marked.get(JSON.parse(token))!));
}

/** urllib.parse.quote: UTF-8 percent-encoding, keeping letters, digits, ``_.~-`` and ``safe``. */
export function pyQuote(text: string, safe = "/"): string {
  return [...Buffer.from(text, "utf8")].map((byte) => {
    const char = String.fromCharCode(byte);
    return /[A-Za-z0-9_.~-]/.test(char) || (byte < 128 && safe.includes(char)) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}
