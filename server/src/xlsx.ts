// Reading a sheet of an .xlsx workbook (what benchmarks.ts needs of openpyxl, read_only and data_only):
// each row's cached values, by column, without evaluating formulas or following external links.
// Numbers styled as dates become Dates, as openpyxl reads them.
import { ZipFile } from "./zip.js";

export type Cell = string | number | boolean | Date | null;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** XML text with its entities and character references decoded. */
export function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name] ?? whole;
  });
}

function attributes(tag: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) found[match[1].replace(/^\w+:/, "")] = unescapeXml(match[2] ?? match[3]);
  return found;
}

/** The text of every <t> in ``xml`` joined (a shared string or an inline string's runs). */
function texts(xml: string): string {
  return [...xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>|<(?:\w+:)?t(?:\s[^>]*)?\/>/g)].map((match) => unescapeXml(match[1] ?? "")).join("");
}

function sharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  // Phonetic runs (<rPh>) are not part of the text.
  return [...xml.matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>|<(?:\w+:)?si\/>/g)].map((match) => texts((match[1] ?? "").replace(/<(?:\w+:)?rPh[\s\S]*?<\/(?:\w+:)?rPh>/g, "")));
}

// The built-in number formats that are dates or times (ECMA-376 18.8.30).
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

/** For each cell style (the ``s`` of a cell), whether it shows a date. */
function dateStyles(xml: string | null): boolean[] {
  if (!xml) return [];
  const custom = new Map<number, string>();
  for (const match of xml.matchAll(/<(?:\w+:)?numFmt\b[^>]*>/g)) {
    const found = attributes(match[0]);
    custom.set(Number(found.numFmtId), found.formatCode ?? "");
  }
  const cells = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(xml)?.[1] ?? "";
  return [...cells.matchAll(/<(?:\w+:)?xf\b[^>]*>/g)].map((match) => {
    const id = Number(attributes(match[0]).numFmtId ?? 0);
    if (DATE_FORMATS.has(id)) return true;
    const code = custom.get(id);
    // A format is a date's when it has d, m, y, h or s outside quotes, brackets and escapes.
    return code !== undefined && /[dmyhs]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ""));
  });
}

/** An Excel serial day (1900 system) as a Date, at UTC. */
export function fromSerial(value: number): Date {
  // Day 60 is 1900-02-29, which never was; Excel counts it, so later days are one off.
  const days = value < 60 ? value : value - 1;
  return new Date(Date.UTC(1899, 11, 31) + Math.round(days * 86_400_000));
}

function column(reference: string): number {
  let index = 0;
  for (const letter of reference.replace(/\d+$/, "").toUpperCase()) index = index * 26 + letter.charCodeAt(0) - 64;
  return index - 1;
}

function resolve(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

export class Workbook {
  readonly sheetnames: string[];
  private readonly paths = new Map<string, string>();
  private readonly strings: string[];
  private readonly dates: boolean[];

  constructor(private readonly archive: ZipFile) {
    const file = (name: string) => (archive.entries.some((entry) => entry.filename === name) ? archive.read(name).toString("utf8") : null);
    const workbook = file("xl/workbook.xml");
    if (!workbook) throw new Error("Not a workbook");
    const relations = new Map<string, string>();
    for (const match of (file("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
      const found = attributes(match[0]);
      relations.set(found.Id, resolve("xl/workbook.xml", found.Target));
    }
    this.sheetnames = [];
    for (const match of workbook.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
      const found = attributes(match[0]);
      this.sheetnames.push(found.name);
      const path = relations.get(found.id);
      if (path) this.paths.set(found.name, path);
    }
    this.strings = sharedStrings(file("xl/sharedStrings.xml"));
    this.dates = dateStyles(file("xl/styles.xml"));
  }

  static load(data: Buffer): Workbook {
    return new Workbook(new ZipFile(data));
  }

  /** The sheet's rows, each padded to the widest row, empty cells as null. */
  rows(name: string): Cell[][] {
    const path = this.paths.get(name);
    if (!path) throw new Error(`Worksheet ${name} does not exist.`);
    const xml = this.archive.read(path).toString("utf8");
    const rows: Cell[][] = [];
    let width = 0;
    for (const row of xml.matchAll(/<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>|<(?:\w+:)?row\b([^>]*)\/>/g)) {
      const number = Number(attributes(row[1] ?? row[3] ?? "").r ?? rows.length + 1);
      while (rows.length < number - 1) rows.push([]);
      const cells: Cell[] = [];
      let next = 0;
      for (const cell of (row[2] ?? "").matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        const found = attributes(cell[1]);
        const index = found.r ? column(found.r) : next;
        next = index + 1;
        cells[index] = this.value(found, cell[2] ?? "");
      }
      rows.push(Array.from(cells, (value) => value ?? null));
      width = Math.max(width, cells.length);
    }
    return rows.map((cells) => [...cells, ...Array(Math.max(0, width - cells.length)).fill(null)]);
  }

  private value(found: Record<string, string>, body: string): Cell {
    const raw = /<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1];
    const type = found.t ?? "n";
    if (type === "inlineStr") return texts(/<(?:\w+:)?is>([\s\S]*?)<\/(?:\w+:)?is>/.exec(body)?.[1] ?? "");
    if (raw === undefined) return null;
    const text = unescapeXml(raw);
    if (type === "s") return this.strings[Number(text)] ?? null;
    if (type === "str" || type === "e") return text;
    if (type === "b") return text === "1";
    if (type === "d") return new Date(text);
    const value = Number(text);
    if (!Number.isFinite(value)) return text;
    return this.dates[Number(found.s ?? 0)] ? fromSerial(value) : value;
  }
}
