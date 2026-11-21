// Folder names a person can read: the date and time, then a few English words, never a random id
// (``20261021-1441-async-fifo-uvm``), and folders the CLIs work in that lie outside any project
//.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { settings } from "./config.js";

export const MAX_WORDS = 6;
export const MAX_CHARS = 48;

/** Lowercase ASCII words joined by hyphens; ``fallback`` when ``text`` has none (Chinese only, say). */
export function slug(text: string | null | undefined, fallback = "task"): string {
  const words = ((text || "").toLowerCase().match(/[a-z0-9]+/g) ?? []).slice(0, MAX_WORDS);
  return words.join("-").slice(0, MAX_CHARS).replace(/^-+|-+$/g, "") || fallback;
}

/** Create ``root/name``, or ``name-2``, ``name-3``... if taken, and return it. */
export function reserve(root: string, name: string): string {
  mkdirSync(root, { recursive: true });
  for (let index = 1; index < 1000; index += 1) {
    const path = join(root, index === 1 ? name : `${name}-${index}`);
    try {
      mkdirSync(path);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`no free folder name for ${name} under ${root}`);
}

const two = (value: number) => String(value).padStart(2, "0");

/** A local time as strftime's %Y%m%d-%H%M (with seconds: %Y%m%d-%H%M%S). */
export function stamp(when: Date, seconds = false): string {
  return `${when.getFullYear()}${two(when.getMonth() + 1)}${two(when.getDate())}-${two(when.getHours())}${two(when.getMinutes())}`
    + (seconds ? two(when.getSeconds()) : "");
}

/** A new task's scratch folder under workspace_root, created now; returns its name. */
export function taskFolder(label: string | null | undefined, when: Date = new Date()): string {
  const path = reserve(settings.workspace_root, `${stamp(when)}-${slug(label)}`);
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Where leads' conversations keep their folders: the setting, else the user's cache. Never
 *  inside the platform's own folder, so a CLI lead does not read its AGENTS.md or CLAUDE.md. */
export function leadRoot(): string {
  if (settings.lead_root) return settings.lead_root;
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(cache, "super-partner", "leads");
}

/** A new folder for one lead conversation: when it started and on which model. */
export function leadFolder(modelId: string): string {
  const model = modelId.includes(":") ? modelId.slice(modelId.indexOf(":") + 1) : modelId;
  return reserve(leadRoot(), `${stamp(new Date(), true)}-lead-${slug(model, "model")}`);
}
