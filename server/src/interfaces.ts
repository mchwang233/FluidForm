// Interface packages (docs/design/capability-packages.md): a web page FluidForm serves itself, at
// /<its id>/, from the package's site folder; nothing of it runs on this machine. The web console is
// one (server/packages/web), shipped and enabled like the chat and pricing packages; without any,
// FluidForm is its API and the command line (fluidform).
import { existsSync, realpathSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";
import * as capabilities from "./capabilities.js";
import type { Capability } from "./models.js";

export const NO_INTERFACE = "FluidForm 在运行，但没有启用网页界面。\n"
  + "用命令行：fluidform --help；或启用网页界面：fluidform capabilities enable web\n";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".map": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json",
};

/** The active interface package ``id``, or null. */
export function active(id: string): Capability | null {
  const item = capabilities.load(id);
  return item && item.kind === "interface" && item.status === "active" && item.site ? item : null;
}

/** Where FluidForm's own address leads: the web console ("web"), else the first active interface. */
export function home(): Capability | null {
  const found = capabilities.library().filter((item) => item.kind === "interface" && item.status === "active" && item.site);
  return found.find((item) => item.id === "web") ?? found[0] ?? null;
}

/** The file ``path`` asks for in interface ``id``'s site, with its type; a path that is no file there
 *  is the page itself (index.html: the page routes it). null when there is no such page, or the
 *  path leaves the site. */
export function file(id: string, path: string): { path: string; type: string; index: boolean } | null {
  const item = active(id);
  if (!item) return null;
  const site = join(capabilities.root(), item.id, item.site);
  if (!existsSync(site)) return null;
  const root = realpathSync(site);
  const index = join(root, "index.html");
  let wanted = join(root, ...(path.split("?")[0] || "").split("/").filter((part) => part && part !== "." && part !== ".."));
  try {
    wanted = realpathSync(wanted);
  } catch {
    wanted = index;
  }
  if (wanted !== root && !wanted.startsWith(root + sep)) return null;
  if (!existsSync(wanted) || !statSync(wanted).isFile()) wanted = index;
  if (!existsSync(wanted)) return null;
  return { path: wanted, type: TYPES[extname(wanted).toLowerCase()] ?? "application/octet-stream", index: wanted === index };
}
