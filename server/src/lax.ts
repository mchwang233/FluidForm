// Values read the way Pydantic reads them (lax mode), so records written by the Python backend
// load the same: "true" and 1 are true, "5" is 5, an ISO time keeps its exact text.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hooks } from "./model-hooks.js";

const TRUE = new Set(["1", "on", "t", "true", "y", "yes"]);
const FALSE = new Set(["0", "off", "f", "false", "n", "no"]);

function toBool(value: unknown): unknown {
  if (typeof value === "number" && (value === 0 || value === 1)) return value === 1;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (TRUE.has(text)) return true;
    if (FALSE.has(text)) return false;
  }
  return value;
}

function toNumber(value: unknown): unknown {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const number = Number(value.trim());
    if (Number.isFinite(number)) return number;
  }
  return value;
}

const TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:[.,](\d+))?(Z|z|[+-]\d{2}(?::?\d{2})?)?$/;

function validCalendar(day: string, hours = "00", minutes = "00", seconds = "00"): boolean {
  const [y, m, d] = day.split("-").map(Number);
  const hh = Number(hours);
  const mm = Number(minutes);
  const ss = Number(seconds);
  if (m < 1 || m > 12 || d < 1 || d > 31 || hh > 23 || mm > 59 || ss > 59) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** An ISO date and time as Pydantic writes it back: seconds always, microseconds only when not
 *  zero (six digits), "Z" for UTC, an offset as ±HH:MM, none when the time had none. */
export function normalizeDatetime(value: unknown): unknown {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Unix time: seconds, or milliseconds when it is too large to be seconds (as Pydantic).
    const ms = Math.abs(value) > 2e10 ? value : value * 1000;
    return isoFromMs(ms);
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? value : isoFromMs(value.getTime());
  if (typeof value !== "string") return value;
  const found = TIME.exec(value.trim());
  if (!found) return value;
  const [, day, hours, minutes, seconds = "00", fraction = "", zone = ""] = found;
  if (!validCalendar(day, hours, minutes, seconds)) return value;
  const micro = fraction.slice(0, 6).padEnd(6, "0");
  let offset = "";
  if (zone === "Z" || zone === "z") offset = "Z";
  else if (zone) {
    const digits = zone.replace(":", "");
    const zh = Number(digits.slice(1, 3));
    const zm = Number(digits.slice(3, 5) || "00");
    if (zh > 23 || zm > 59) return value;
    const normal = `${digits.slice(0, 3)}:${digits.slice(3, 5) || "00"}`;
    offset = normal === "+00:00" || normal === "-00:00" ? "Z" : normal;
  }
  return `${day}T${hours}:${minutes}:${seconds}${/^0+$/.test(micro) ? "" : `.${micro}`}${offset}`;
}

function isoFromMs(ms: number): string {
  const text = new Date(ms).toISOString(); // 2026-11-20T01:23:34.647Z
  return normalizeDatetime(text.replace(/\.(\d{3})Z$/, ".$1000Z")) as string;
}

const DATETIME_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{6})?(Z|[+-]\d{2}:\d{2})?$/;

export const lax = {
  bool: () => z.preprocess(toBool, z.boolean()),
  int: (inner = z.number().int()) => z.preprocess(toNumber, inner),
  number: (inner = z.number()) => z.preprocess(toNumber, inner),
  datetime: () => z.preprocess(normalizeDatetime, z.string().regex(DATETIME_TEXT, "not a date and time")
    .refine((text) => validCalendar(text.slice(0, 10), text.slice(11, 13), text.slice(14, 16), text.slice(17, 19)), "not a valid calendar date")),
  date: () => z.preprocess((value) => (typeof value === "string" ? value.trim().slice(0, 10) : value),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "not a date").refine((day) => validCalendar(day), "not a valid calendar date")),
};

/** The current time as Pydantic writes datetime.now(timezone.utc). */
export function nowIso(): string {
  return isoFromMs(Date.now());
}

/** uuid4().hex[:length] */
export function newId(length: number): string {
  return randomUUID().replaceAll("-", "").slice(0, length);
}

/** A record's schema: its fields, with the Python model's validators (model-hooks.ts). */
export function model<Shape extends z.ZodRawShape>(name: string, fields: Shape) {
  const hook = hooks[name] ?? {};
  const object = z.object(fields);
  const before = hook.before;
  const checked = hook.after
    ? object.transform((value, context) => hook.after!(value as Record<string, unknown>, context) as typeof value)
    : object;
  return before ? z.preprocess((value) => before(value), checked) : checked;
}

/** A stored time as text that sorts as the time does: the fraction always six digits, in UTC. */
export function timeKey(iso: string): string {
  const found = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})?$/.exec(iso);
  if (!found) return iso;
  const [, base, fraction = "", zone = ""] = found;
  const micro = fraction.padEnd(6, "0");
  if (!zone || zone === "Z") return `${base}.${micro}`;
  const parsed = Date.parse(`${base}${zone}`);
  if (Number.isNaN(parsed)) return iso;
  const shifted = new Date(parsed).toISOString().slice(0, 19);
  return `${shifted}.${micro}`;
}

/** datetime.isoformat() of an aware UTC time, as Python writes it: "+00:00", microseconds unless
 *  zero. Python 3.9's fromisoformat reads this, not a "Z". */
export function pythonIso(when: Date): string {
  const text = when.toISOString(); // 2026-11-20T01:23:34.647Z
  const millis = text.slice(20, 23);
  return `${text.slice(0, 19)}${millis === "000" ? "" : `.${millis}000`}+00:00`;
}

/** datetime.fromisoformat (Python 3.9 forms): null for text it would not read or a naive time. */
export function fromPythonIso(text: unknown): Date | null {
  if (typeof text !== "string") return null;
  const found = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)([+-]\d{2}:\d{2})$/.exec(text);
  if (!found) return null;
  const when = new Date(`${found[1]}T${found[2].replace(/(\.\d{3})\d*$/, "$1")}${found[3]}`);
  return Number.isNaN(when.getTime()) ? null : when;
}
