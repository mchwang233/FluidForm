// The files a task made, as its result names them (docs/design/chat-context.md): sent to the chat app it
// came from when it ends, and kept in its chat's folder so the chat can send them again.
import { constants, copyFileSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, sep } from "node:path";
import * as files from "./attachments.js";
import { settings } from "./config.js";
import { type ExecutionRun, folderId } from "./models.js";

export const MAX_TASK_FILES = 5;
// What people asked for first: documents, sheets, slides, pictures, archives; the scripts that made them last.
const WANTED = new Set(["pptx", "ppt", "key", "docx", "doc", "xlsx", "xls", "csv", "pdf", "md", "txt", "html", "png", "jpg", "jpeg", "gif",
  "webp", "svg", "zip", "tar", "gz", "tgz", "7z", "mp4", "mp3", "wav", "json"]);
const CODE = new Set(["py", "js", "mjs", "ts", "sh", "bat", "ps1", "rb", "go", "rs", "java", "c", "cpp", "h", "sv", "v"]);

// A file named in a result: a link's target, a path written out, a name in `backticks`, or a name with
// an extension standing on its own (in a table, a list, a sentence).
const LINKED = /\]\(([^)\s]+)\)/g;
const QUOTED = /`([^`\n]{1,200})`/g;
const NAMED = /(?:^|[\s|（(：:，,"“'])((?:\/)?(?:[\w一-鿿.@+-]+\/)*[\w一-鿿@+-][\w一-鿿.@+-]*\.[A-Za-z0-9]{1,6})(?=$|[\s|）)，,。；;:："”'])/gmu;

const extension = (path: string) => (path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "");
const rank = (path: string) => (WANTED.has(extension(path)) ? 0 : CODE.has(extension(path)) ? 2 : 1);

/** The task's own folder. */
export const folderOf = (run: ExecutionRun) => join(settings.workspace_root, folderId(run));

/** The files of ``run``'s own folder its result names: what it made, the most wanted first. */
export function named(run: ExecutionRun, limit = MAX_TASK_FILES): string[] {
  const text = run.final_result || "";
  let root: string;
  try {
    root = realpathSync(folderOf(run));
  } catch {
    return [];
  }
  const found = new Set<string>();
  for (const pattern of [LINKED, QUOTED, NAMED]) {
    for (const match of text.matchAll(pattern)) {
      const given = match[1].trim().replace(/^\.\//, "");
      const path = isAbsolute(given) ? given : join(root, given);
      try {
        if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) continue;
        const real = realpathSync(path);
        if (!real.startsWith(root + sep) || statSync(real).size > files.MAX_ATTACHMENT_BYTES) continue;
        found.add(real);
      } catch {
        // not one of its files
      }
    }
  }
  return [...found].map((path, index) => [path, index] as const).sort(([a, i], [b, j]) => rank(a) - rank(b) || i - j).map(([path]) => path).slice(0, limit);
}

/** ``paths`` copied into ``folder``, each by its own name; what is there already is left as it is. */
export function copyInto(folder: string, paths: string[]): string[] {
  const copied: string[] = [];
  mkdirSync(folder, { recursive: true });
  for (const path of paths) {
    const target = join(folder, files.safeName(basename(path)));
    try {
      copyFileSync(path, target, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") continue;
    }
    copied.push(target);
  }
  return copied;
}

/** Where a chat keeps what the tasks it asked for made, in its folder. */
export const IN_CHAT = "tasks";

/** What a chat keeps of its tasks' files (``IN_CHAT`` in its ``folder``): their paths there, at most ``most``. */
export function kept(folder: string, most = 20): string[] {
  const root = join(folder, IN_CHAT);
  try {
    return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      .flatMap((task) => readdirSync(join(root, task.name), { withFileTypes: true }).filter((entry) => entry.isFile())
        .map((file) => [IN_CHAT, task.name, file.name].join("/")))
      .slice(0, most);
  } catch {
    return [];
  }
}

/** A result as a chat app shows it: its opening words, before any heading or table. */
export function opening(result: string, most = 400): string {
  const lines: string[] = [];
  for (const line of result.split("\n")) {
    if (/^\s*(#|\||[-*]\s+\S.*\|)/.test(line) && lines.some((item) => item.trim())) break;
    lines.push(line);
  }
  const text = lines.join("\n").trim();
  return [...text].length > most ? [...text].slice(0, most).join("").trimEnd() + "…" : text;
}
