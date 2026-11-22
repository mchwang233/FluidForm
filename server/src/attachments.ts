// Files the user attaches to a task: stored locally, then handed to every node's model
//. Uploads land in <data_dir>/attachments/<id>/<name> before the task exists, so
// the composer can show them while the user types. CLI agents get the file paths (and Codex the
// images as --image); API models get images as image inputs and text files inline.
import { randomUUID } from "node:crypto";
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { settings } from "./config.js";
import { type Attachment, AttachmentSchema, type ExecutionRun } from "./models.js";
import { head } from "./py.js";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
// Inline at most this much of a text file into an API model's prompt.
export const MAX_INLINE_TEXT = 200_000;
// Image types every vision API accepts. SVG is deliberately not an image here: it can carry script.
const IMAGE_SIGNATURES: [Buffer, string][] = [
  [Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), "image/png"],
  [Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg"],
  [Buffer.from("GIF87a"), "image/gif"],
  [Buffer.from("GIF89a"), "image/gif"],
];

export class AttachmentError extends Error {
  override name = "AttachmentError";
}

export function root(): string {
  return join(settings.data_dir, "attachments");
}

export function imageType(data: Buffer): string | null {
  for (const [signature, mediaType] of IMAGE_SIGNATURES) {
    if (data.subarray(0, signature.length).equals(signature)) return mediaType;
  }
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

function isText(data: Buffer): boolean {
  if (data.subarray(0, 8192).includes(0)) return false;
  try {
    strictUtf8.decode(data);
    return true;
  } catch {
    return false;
  }
}

export function safeName(name: string): string {
  const last = basename(name.replace(/\\/g, "/").replace(/\/+$/, "")).trim();
  const cleaned = head(last.replace(/[\x00-\x1f/]/g, "_"), 120);
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "attachment";
}

export function save(name: string, data: Buffer): Attachment {
  if (!data.length) throw new AttachmentError("文件是空的。");
  if (data.length > MAX_ATTACHMENT_BYTES) throw new AttachmentError(`单个附件不能超过 ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB。`);
  // The type comes from the content, never from the browser's claim or the file name.
  const image = imageType(data);
  const kind = image ? "image" : isText(data) ? "text" : "file";
  const attachment = AttachmentSchema.parse({ id: randomUUID().replaceAll("-", ""), name: safeName(name), size: data.length,
    kind, media_type: image ?? (kind === "text" ? "text/plain" : "application/octet-stream") });
  const folder = join(root(), attachment.id);
  mkdirSync(join(folder, "content"), { recursive: true });
  writeFileSync(join(folder, "content", attachment.name), data);
  writeFileSync(join(folder, "meta.json"), JSON.stringify(attachment));
  return attachment;
}

export function get(attachmentId: string): Attachment | null {
  if (!/^[0-9a-f]{32}$/.test(attachmentId)) return null;
  try {
    return AttachmentSchema.parse(JSON.parse(readFileSync(join(root(), attachmentId, "meta.json"), "utf8")));
  } catch {
    return null;
  }
}

export function path(attachment: Attachment): string {
  const folder = join(root(), attachment.id);
  // Existing uploads retain their old path; new uploads cannot collide with metadata.
  const content = join(folder, "content");
  return existsSync(content) && statSync(content).isDirectory() ? join(content, attachment.name) : join(folder, attachment.name);
}

export function remove(attachmentId: string): boolean {
  if (!get(attachmentId)) return false;
  rmSync(join(root(), attachmentId), { recursive: true, force: true });
  return true;
}

export function resolve(ids: string[]): Attachment[] {
  if (ids.length > MAX_ATTACHMENTS) throw new AttachmentError(`一个任务最多附加 ${MAX_ATTACHMENTS} 个文件。`);
  return [...new Set(ids)].map((id) => {
    const attachment = get(id);
    if (!attachment) throw new AttachmentError("附件已失效，请重新添加。");
    return attachment;
  });
}

/** Those of ``ids`` still stored, in order; the gone are left out. */
export function resolveExisting(ids: string[]): Attachment[] {
  return [...new Set(ids)].map(get).filter((item): item is Attachment => item !== null);
}

// A task gathers files as the user sends them along the way (attach); at most this many in all.
export const MAX_TASK_ATTACHMENTS = 50;

/** Files the user sent with a message join the task's own attachments, so its lead and its later
 *  steps see them as they see the files it was started with. */
export function attach(run: Pick<ExecutionRun, "attachments">, attachments: Attachment[]): void {
  const known = new Set(run.attachments.map((item) => item.id));
  const fresh = attachments.filter((item) => !known.has(item.id));
  if (run.attachments.length + fresh.length > MAX_TASK_ATTACHMENTS) {
    throw new AttachmentError(`一个任务最多附加 ${MAX_TASK_ATTACHMENTS} 个文件。`);
  }
  run.attachments.push(...fresh);
}

/** The prompt section naming the attachments, with local paths for CLI agents. */
export function describe(attachments: Attachment[], withPaths: boolean): string {
  if (!attachments.length) return "";
  const kinds: Record<string, string> = { image: "image", text: "text file", file: "file" };
  const lines = attachments.map((item) => `- ${item.name} (${kinds[item.kind]}, ${item.size} bytes)` + (withPaths ? `: ${path(item)}` : ""));
  return "\n\nThe user attached these files" + (withPaths ? "; read them from the paths given:\n" : ":\n") + lines.join("\n");
}

/** Text files' contents for API models, which cannot open local paths. */
export function inlineText(attachments: Attachment[]): string {
  const parts: string[] = [];
  for (const item of attachments) {
    if (item.kind === "text") {
      const text = readFileSync(path(item)).toString("utf8");
      const clipped = head(text, MAX_INLINE_TEXT);
      const note = text.length > clipped.length ? "\n[truncated]" : "";
      parts.push(`\n\n--- ${item.name} ---\n${clipped}${note}\n--- end of ${item.name} ---`);
    } else if (item.kind === "file") {
      parts.push(`\n\n[${item.name} is a binary file that this model cannot read.]`);
    }
  }
  return parts.join("");
}

export function imageData(item: Attachment): string {
  return readFileSync(path(item)).toString("base64");
}

/** Copies of ``items`` in a chat's ``folder`` (attachments/), where its tools can read them again:
 *  their paths there, by id. The folder is the model's to write, so nothing is followed or
 *  overwritten. */
export function copiesIn(folder: string, items: Attachment[]): Record<string, string> {
  const found: Record<string, string> = {};
  if (!items.length) return found;
  const inside = join(folder, "attachments");
  try {
    mkdirSync(inside, { recursive: true });
    if (!lstatSync(inside).isDirectory()) return found;
  } catch {
    return found;
  }
  for (const item of items) {
    const name = `${safeName(item.id).slice(0, 12)}-${safeName(item.name)}`;
    try {
      copyFileSync(path(item), join(inside, name), constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") continue; // gone: named only
    }
    found[item.id] = `attachments/${name}`;
  }
  return found;
}

/** A picture past this is not sent again with each turn. */
export const MAX_SHOWN_AGAIN_BYTES = 5 * 1024 * 1024;

/** Whether a picture is still there to be shown again. */
export function showable(item: Attachment): boolean {
  try {
    const found = statSync(path(item));
    return found.isFile() && found.size <= MAX_SHOWN_AGAIN_BYTES;
  } catch {
    return false;
  }
}
