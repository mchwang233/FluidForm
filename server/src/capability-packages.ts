// Capability packages: uploaded, installed and uninstalled on their own
// (docs/design/capability-packages.md).
//
// A package is a zip of one folder with a ``capability.json`` (its manifest), its code, optionally a
// ``SKILL.md`` and a ``requirements.txt``. Installing unpacks it into ``<tools_dir>/capabilities/<id>/``,
// builds its Python environment there and runs its check, both in the capabilities' sandbox
// (capability-sandbox.ts); uninstalling removes it with its data, state and secrets. Super Partner's
// source knows nothing of any one package.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as capabilities from "./capabilities.js";
import { root } from "./capabilities.js";
import * as sandbox from "./capability-sandbox.js";
import { settings } from "./config.js";
import { type Capability, CapabilitySchema } from "./models.js";
import { head, shlexQuote, tail } from "./py.js";
import * as secretStore from "./secrets.js";
import { BadZipFile, type ZipEntry, ZipFile } from "./zip.js";

export const MANIFEST = "capability.json";
export const REQUIREMENTS = "requirements.txt";
// How to talk where an automation brings people's messages (an IM's manners): given to the model
// answering in its chats (supervisor.chatGuide). Optional.
export const CHAT_GUIDE = "CHAT.md";
export const MAX_CHAT_GUIDE_CHARS = 6000;
export const VENV = ".venv";
export const MAX_PACKAGE_FILES = 2000;
export const ENV_SECONDS = 900;
export const ID = /^[a-z0-9][a-z0-9-]{1,40}$/;
export const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,80}$/;
// Variables the sandbox sets itself; a package cannot ask for them as secrets.
export const RESERVED = new Set(["PATH", "HOME", "TMPDIR", "LANG", "PYTHONUNBUFFERED", "PYTHONPATH", "PYTHONHOME"]);
export const IGNORED = ["__MACOSX/", ".DS_Store"];

/** A package that cannot be installed, and why (shown to the user). */
export class PackageError extends Error {
  override name = "ValueError";
}

/** Its CHAT.md, if it has one (bounded); "" otherwise. */
export function chatGuide(capabilityId: string | null | undefined): string {
  if (!ID.test(capabilityId || "")) return "";
  const path = join(root(), capabilityId!, CHAT_GUIDE);
  try {
    return statSync(path).isFile() ? head(readFileSync(path).toString("utf8"), MAX_CHAT_GUIDE_CHARS).trim() : "";
  } catch {
    return "";
  }
}

/** The only folder a capability writes, kept out of the steps' sight with Super Partner's data. */
export function dataFolder(capabilityId: string): string {
  return join(settings.data_dir, "capability-data", capabilityId);
}

export function secretName(capabilityId: string, variable: string): string {
  return `capability/${capabilityId}/${variable}`;
}

/** The folder prefix holding the manifest, and each file under it with its path inside. */
function members(archive: ZipFile): [string, [ZipEntry, string[]][]] {
  const files = archive.infolist().filter((item) => !item.isDir && !IGNORED.some((part) => item.filename.includes(part)));
  const names = new Set(files.map((item) => item.filename));
  const prefix = names.has(MANIFEST) ? "" : [...names].sort().filter((name) => name.endsWith("/" + MANIFEST) && name.split("/").length === 2)
    .map((name) => name.slice(0, -MANIFEST.length))[0];
  if (prefix === undefined) throw new PackageError(`包里没有 ${MANIFEST}（放在包的最外层，或唯一的文件夹里）。`);
  if (files.length > MAX_PACKAGE_FILES) throw new PackageError(`文件太多：超过 ${MAX_PACKAGE_FILES} 个。`);
  const found: [ZipEntry, string[]][] = [];
  let size = 0;
  for (const item of files) {
    if (!item.filename.startsWith(prefix)) throw new PackageError(`${item.filename} 不在能力的文件夹里。`);
    const inside = item.filename.slice(prefix.length);
    // PurePosixPath's parts: empty and "." parts dropped.
    const parts = inside.split("/").filter((part) => part && part !== ".");
    if (item.filename.includes("\\") || inside.startsWith("/") || parts.includes("..") || !parts.length) throw new PackageError(`不安全的路径：${item.filename}`);
    if (((item.external_attr >>> 16) & 0o170000) === 0o120000) throw new PackageError(`包里不能有链接：${item.filename}`);
    if (parts[0] === VENV) throw new PackageError(`包里不能带 ${VENV}：环境在安装时建。`);
    size += item.file_size;
    if (size > capabilities.MAX_CAPABILITY_BYTES) throw new PackageError(`解开后超过 ${Math.floor(capabilities.MAX_CAPABILITY_BYTES / 1024 / 1024)} MB。`);
    found.push([item, parts]);
  }
  return [prefix, found];
}

const text = (value: unknown) => (value === null || value === undefined || value === false || value === "" || value === 0 ? "" : String(value));

function manifest(raw: Buffer, files: string[]): Capability {
  let data: unknown;
  try {
    data = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new PackageError(`${MANIFEST} 不是有效的 JSON：${(error as Error).message}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new PackageError(`${MANIFEST} 应该是一个对象。`);
  const given = data as Record<string, unknown>;
  const id = text(given.id);
  if (!ID.test(id)) throw new PackageError("id 只能用小写字母、数字和 -，2 到 41 个字符。");
  const kind = text(given.kind) || "tool";
  if (!capabilities.KINDS.has(kind)) throw new PackageError("kind 只能是 tool 或 automation。");
  const entry = text(given.entry).trim();
  if (kind === "automation" && !entry) throw new PackageError("自动化要写 entry：运行它的命令。");
  const list = (value: unknown) => (Array.isArray(value) ? value : value ? [...String(value)] : []).map((item) => String(item).trim());
  const secrets = list(given.secrets);
  const bad = secrets.filter((item) => !VARIABLE.test(item) || RESERVED.has(item) || item.startsWith("SP_") || item.startsWith("LD_") || item.toUpperCase().includes("PROXY"));
  if (bad.length) throw new PackageError(`这些密钥名不能用：${bad.join("、")}`);
  const domains = list(given.domains).map((item) => item.toLowerCase()).filter(Boolean);
  if (domains.some((item) => !/^(\*\.)?[a-z0-9.-]+$/.test(item))) throw new PackageError("domains 只能写主机名，或 *.example.com。");
  return CapabilitySchema.parse({
    id, name: head(text(given.name) || id, 60), kind, summary: head(text(given.summary), 500), usage: head(text(given.usage), 2000),
    guide: head(text(given.guide), capabilities.MAX_GUIDE), check: head(text(given.check), 500), secrets: secrets.slice(0, 20),
    domains: domains.slice(0, 20), files: files.slice(0, 50), entry: head(entry, 500), version: head(text(given.version), 40), source: "upload", status: "disabled",
  });
}

function open(data: Buffer): ZipFile {
  try {
    return new ZipFile(data);
  } catch (error) {
    if (error instanceof BadZipFile || error instanceof RangeError) throw new PackageError("不是 zip 文件。");
    throw error;
  }
}

/** The package's manifest, after checking the whole package. */
export function read(data: Buffer): Capability {
  const archive = open(data);
  const [prefix, found] = members(archive);
  return manifest(archive.read(prefix + MANIFEST), [...new Set(found.map(([, parts]) => parts[0]))].sort());
}

/** Unpack ``data`` as a capability, replacing an older version (its secrets, data and state stay),
 *  build its environment and check it. It is installed switched off; the caller stops an older version
 *  that runs. */
export async function install(data: Buffer): Promise<Capability> {
  let capability = read(data);
  const folder = join(root(), capability.id);
  const old = capabilities.load(capability.id);
  if (old && old.source !== "upload") throw new PackageError(`已经有一个叫 ${capability.id} 的能力是任务固化的，先删掉它。`);
  // Secrets the new version no longer asks for are forgotten.
  for (const name of new Set((old?.secrets ?? []).filter((item) => !capability.secrets.includes(item)))) await secretStore.deleteSecret(secretName(capability.id, name));
  const staging = join(root(), `.${capability.id}.${randomBytes(4).toString("hex")}`);
  mkdirSync(staging, { recursive: true });
  try {
    const archive = open(data);
    const [, found] = members(archive);
    for (const [item, parts] of found) {
      const target = join(staging, ...parts);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, archive.read(item));
    }
    if (existsSync(folder)) rmSync(folder, { recursive: true, force: true });
    renameSync(staging, folder);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  const manualPath = join(folder, capabilities.MANUAL);
  if (!existsSync(manualPath) || !statSync(manualPath).isFile()) writeFileSync(manualPath, capabilities.manual(capability));
  capability.guide = capability.guide || head(readFileSync(manualPath, "utf8"), capabilities.MAX_GUIDE);
  // Saved before anything in the package runs, and again after: what it may do is decided here.
  capabilities.save(capability);
  const [output, ok] = await build(capability);
  if (ok) capability = await check(capability);
  else {
    capability.check_ok = false;
    capability.check_output = tail(output, capabilities.MAX_CHECK_OUTPUT);
  }
  capability.status = capability.check_ok === false ? "failed" : "disabled";
  capabilities.save(capability);
  return capability;
}

/** Its Python environment, from its requirements.txt, built in the sandbox reaching only the package
 *  index. Nothing to build without one. */
export async function build(capability: Capability): Promise<[string, boolean]> {
  const folder = join(root(), capability.id);
  const requirements = join(folder, REQUIREMENTS);
  if (!existsSync(requirements) || !statSync(requirements).isFile()) return ["", true];
  const reason = sandbox.deps.missing();
  if (reason) return [reason, false];
  const python = sandbox.python();
  if (!python) return ["这台机器没有 python3，建不了能力的 Python 环境。", false];
  const command = `${shlexQuote(python)} -m venv ${VENV} && ${VENV}/bin/python -m pip install --disable-pip-version-check `
    + `--no-input -q -r ${REQUIREMENTS}`;
  const [output, ok] = await sandbox.deps.run(folder, dataFolder(capability.id), command, ENV_SECONDS, { domains: sandbox.indexHosts(), writable: true });
  return [ok ? output : "装依赖失败：\n" + output, ok];
}

/** Its check, in its folder, without network. */
export async function check(capability: Capability): Promise<Capability> {
  if (!capability.check) {
    capability.check_ok = null;
    capability.check_output = "没有检查命令。";
    return capability;
  }
  const reason = sandbox.deps.missing();
  if (reason) {
    capability.check_ok = false;
    capability.check_output = reason;
    return capability;
  }
  const [output, ok] = await sandbox.deps.run(join(root(), capability.id), dataFolder(capability.id), capability.check, capabilities.CHECK_SECONDS);
  capability.check_ok = ok;
  capability.check_output = tail(output, capabilities.MAX_CHECK_OUTPUT);
  return capability;
}

/** Which of its secrets are stored. */
export async function secretsSet(capability: Capability): Promise<Record<string, boolean>> {
  const found: Record<string, boolean> = {};
  for (const name of capability.secrets) found[name] = Boolean(await secretStore.getSecret(secretName(capability.id, name)));
  return found;
}

export async function secretsFor(capability: Capability): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const name of capability.secrets) {
    const value = await secretStore.getSecret(secretName(capability.id, name));
    if (value) found[name] = value;
  }
  return found;
}

/** Remove it, its data and its secrets; the caller stops it first and forgets its state. */
export async function uninstall(capability: Capability): Promise<void> {
  for (const name of capability.secrets) await secretStore.deleteSecret(secretName(capability.id, name));
  rmSync(dataFolder(capability.id), { recursive: true, force: true });
  capabilities.remove(capability.id);
}
