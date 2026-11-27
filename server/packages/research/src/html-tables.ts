// Reading public HTML without running it:
// its tables (each cell's text and links) and the text of its scripts.
import { unescapeXml } from "./xlsx.js";

export type HtmlCell = { text: string; links: string[] };

// The named references these pages use, beyond XML's; others are left as written.
const NAMED: Record<string, string> = { nbsp: " ", copy: "©", reg: "®", mdash: "—", ndash: "–", hellip: "…", middot: "·", times: "×",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", trade: "™", deg: "°", plusmn: "±", le: "≤", ge: "≥" };

/** Text with its character references decoded, as html.parser's convert_charrefs does. */
export function unescapeHtml(text: string): string {
  return unescapeXml(text.replace(/&#39;/g, "'")).replace(/&([a-z]+);/gi, (whole, name: string) => NAMED[name] ?? whole);
}

function attributes(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of text.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = match[1].toLowerCase();
    if (!(name in found)) found[name] = unescapeHtml(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return found;
}

export class PublicTableParser {
  readonly tables: HtmlCell[][][] = [];
  table: HtmlCell[][] | null = null;
  readonly scripts: string[] = [];
  private row: HtmlCell[] | null = null;
  private cell: { text: string[]; links: string[] } | null = null;

  feed(page: string): void {
    let at = 0;
    while (at < page.length) {
      const open = page.indexOf("<", at);
      if (open < 0) {
        this.data(page.slice(at));
        break;
      }
      if (open > at) this.data(page.slice(at, open));
      if (page.startsWith("<!--", open)) {
        const end = page.indexOf("-->", open + 4);
        at = end < 0 ? page.length : end + 3;
        continue;
      }
      const match = /^<(\/?)([a-zA-Z][\w:-]*)([^>]*)>/.exec(page.slice(open));
      if (!match) {
        if (/^<[!?]/.test(page.slice(open, open + 2))) {
          const end = page.indexOf(">", open);
          at = end < 0 ? page.length : end + 1;
          continue;
        }
        this.data("<");
        at = open + 1;
        continue;
      }
      const [whole, closing, rawName, rest] = match;
      const name = rawName.toLowerCase();
      at = open + whole.length;
      if (closing) {
        this.end(name);
        continue;
      }
      this.start(name, attributes(rest.replace(/\/$/, "")));
      if (name === "script" || name === "style") {
        // Their content is text until the closing tag, never markup.
        const close = new RegExp(`</${name}\\s*>`, "i").exec(page.slice(at));
        const end = close ? at + close.index : page.length;
        if (name === "script") this.scripts.push(page.slice(at, end));
        at = close ? end + close[0].length : page.length;
      }
    }
  }

  close(): void {
    // Everything is read as it comes; an unclosed table stays in ``table``.
  }

  private start(tag: string, attrs: Record<string, string>): void {
    if (tag === "table") {
      if (this.table !== null) throw new Error("Nested leaderboard table");
      this.table = [];
    } else if (this.table !== null) {
      if (tag === "tr") this.row = [];
      else if (tag === "td" || tag === "th") this.cell = { text: [], links: [] };
      else if (tag === "a" && this.cell !== null) this.cell.links.push(attrs.href ?? "");
    }
  }

  private data(text: string): void {
    if (this.cell !== null) this.cell.text.push(unescapeHtml(text));
  }

  private end(tag: string): void {
    if ((tag === "td" || tag === "th") && this.cell !== null) {
      if (this.row === null) throw new Error("Leaderboard cell outside row");
      this.row.push({ text: this.cell.text.join(" ").split(/\s+/).filter(Boolean).join(" "), links: this.cell.links });
      this.cell = null;
    } else if (tag === "tr" && this.row !== null) {
      this.table!.push(this.row);
      this.row = null;
    } else if (tag === "table" && this.table !== null) {
      this.tables.push(this.table);
      this.table = null;
    }
  }
}
