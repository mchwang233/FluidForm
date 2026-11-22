// Artifact handoffs and bounded work packages. No model assertion substitutes for
// evidence.
import { uses } from "./features.js";
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { settings } from "./config.js";
import {
  type Artifact, ArtifactContractSchema, type ExecutionRun, folderId, NodeStatus, type TaskNode, type TaskPlan,
} from "./models.js";
import { fixed, posixPath, pyRegex, pyRound, shlexSplit, stem, suffix } from "./py.js";
import { PRIVATE_DIRS, PRIVATE_NAMES } from "./quality.js";

/** A plan cannot be executed without weakening an artifact contract. */
export class ContractError extends Error {
  override name = "ContractError";
}

/** Required evidence is missing, unsafe, stale, or has not been accepted. */
export class ArtifactBlocked extends Error {
  override name = "ArtifactBlocked";
}

// The fewest tool calls a contract step gets, by its difficulty: a lead's tighter guess stopped
// hard work before it had written its outputs.
export const MIN_TOOL_CALLS: Record<string, number> = { easy: 20, normal: 40, hard: 80 };

export const RULES = `
Artifact handoffs: separate VDB collection (coverage_vdb), URG text-report generation
(urg_report), and delivery audit (delivery_audit) when the request needs these distinct jobs.
Do not force every coverage task into three nodes: an existing external VDB can feed a report
directly; a request for collection alone needs no report or audit. Never combine production
with its independent delivery audit. Do not invent extra stages or weaken acceptance criteria.
Each such executable step declares artifact_contract:
{"stage": "coverage_vdb|urg_report|delivery_audit", "inputs":
 [{"path": "relative/path", "kind": "file|directory", "source": "external|dependency"}],
 "outputs": [{"path": "relative/path", "kind": "file|directory"}],
 "acceptance_commands": ["commands that actually validate the deliverables"],
 "blocked_when": ["specific missing evidence or environment conditions"],
 "max_turns": 20, "max_cost_usd": 0.5}.
Choose explicit limits appropriate for the work and available budget, not these example values.
Inputs are evidence that MUST already exist, not files this step is responsible for generating.
Use inputs: [] when there are none. A dependency input must be an output of an ancestor step;
declare that dependency (after_parts across major parts). External evidence needs no producer.
Declare VDBs as directory artifacts with a path ending in .vdb (for example artifacts/run.vdb);
use that exact path and kind in the consumer's inputs. Text reports and audit records are file artifacts. List outputs
in files and inputs in reads. Audit consumes accepted reports, never an unfinished report or a
worker's verbal completion claim. New output files are expected to be absent at startup.
Writing a generator/parser script, its unit tests or documentation is preparation, not report
production: do not label it urg_report or make real VDBs prerequisites for fixture-based tests.
Only the step that actually produces reports uses urg_report. Helper code/docs or intermediate
verification can use stage: null when they need bounded artifact contracts. A verification step
of contracted artifact work must also declare its inputs, output evidence and limits.
max_turns counts tool calls; give real work room (at least {floors}
by difficulty; lower values are raised to these). Limits accumulate across automatic
retries/model switches; at a limit the step stops with its logs and the task's lead decides
whether to grant more calls, split the work or give up. Missing upstream evidence returns
BLOCKED: <reason>. Membership CLIs cannot count tool calls; a contract step they run is bounded
by time instead (about 1.5 minutes per declared tool call) and by progress checks.
`.replace("{floors}", Object.entries(MIN_TOOL_CALLS).map(([difficulty, count]) => `${count} for ${difficulty}`).join(", "));

export function declarations(raw: Record<string, unknown>): Record<string, unknown> {
  if (!("artifact_contract" in raw)) return {};
  const parsed = ArtifactContractSchema.safeParse(raw.artifact_contract);
  if (!parsed.success) {
    throw new ContractError(`artifact_contract: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "contract"}: ${issue.message}`).join("; ")}`);
  }
  const contract = parsed.data;
  const floor = MIN_TOOL_CALLS[String(raw.difficulty || "normal")] ?? MIN_TOOL_CALLS.normal;
  if (settings.contract_call_floors && contract.max_turns < floor) {
    // The cost limit grows with the calls, so the raised limit is not cut short by it.
    contract.max_cost_usd = pyRound(contract.max_cost_usd * floor / contract.max_turns, 6);
    contract.max_turns = floor;
  }
  return { artifact_contract: contract };
}

/** What the lead grants a contract step at its limit by running it again: one more difficulty's
 *  worth of tool calls past what it has used, and cost in proportion. */
export function extension(node: TaskNode): { max_turns: number; max_cost_usd: number } {
  const contract = node.artifact_contract!;
  const more = MIN_TOOL_CALLS[node.difficulty] ?? MIN_TOOL_CALLS.normal;
  const used = Math.max(node.contract_turns, node.contract_tool_calls);
  const perCall = contract.max_cost_usd / contract.max_turns;
  return { max_turns: used + more, max_cost_usd: pyRound(Math.max(contract.max_cost_usd, node.contract_cost_usd) + perCall * more, 6) };
}

export function extend(node: TaskNode): { max_turns: number; max_cost_usd: number } {
  const granted = extension(node);
  node.artifact_contract!.max_turns = granted.max_turns;
  node.artifact_contract!.max_cost_usd = granted.max_cost_usd;
  return granted;
}

export function safeName(name: string): boolean {
  // Database files inside VDBs are data, so do not use the review policy's .db exclusion.
  const path = posixPath(name);
  return Boolean(name.trim() && !path.absolute && path.parts.length && name === path.posix
    && !path.parts.some((part) => ["..", ".", ".git", ".fluidform", ".super-partner"].includes(part)
      || PRIVATE_DIRS.has(part.toLowerCase()) || PRIVATE_NAMES.has(part.toLowerCase())
      || part.toLowerCase().startsWith(".env")
      || PRIVATE_NAMES.has(stem(part).toLowerCase())
      || [".pem", ".p12", ".pfx"].includes(suffix(part).toLowerCase()))
    && ![..."*?[]\\\n\r\0"].some((char) => name.includes(char)));
}

const PRODUCTION = String.raw`采集|生成|收集|collect|generat|capture|simulat`;
const VDB_INPUT = pyRegex(String.raw`(?:\bfrom\b|\busing\b|从|基于|使用|读取|消费)([^,;。；\n]{0,40}?)vdb`, "g");

/** Recognize explicit jobs, not arbitrary mentions of coverage in a software request. */
export function stages(node: TaskNode): Set<string> {
  const text = node.title.toLowerCase();
  const found = new Set<string>();
  const production = pyRegex(PRODUCTION);
  // "Generate a report from VDB" names an input, not another production stage. Keep phrases that
  // actually produce it ("from RTL generate VDB") and always respect declared VDB writes below.
  const vdbWork = text.replace(VDB_INPUT, (whole, between: string) => (production.test(between) ? whole : ""));
  if (node.files.some((path) => path.replace(/\/+$/, "").endsWith(".vdb")) || (vdbWork.includes("vdb") && production.test(vdbWork))) {
    found.add("coverage_vdb");
  }
  // Tool names in helper/document titles do not make those tasks artifact production.
  const suffixes = new Set(node.files.map((path) => suffix(path).toLowerCase()));
  const within = (allowed: string[]) => [...suffixes].every((item) => allowed.includes(item));
  const preparation = suffixes.size > 0 && (
    (within([".py", ".sh", ".js", ".ts", ".tcl", ".pl"]) && pyRegex(String.raw`脚本|解析|验收器|验证器|生成器|parser|script|validator|generator`).test(text))
    || (within([".md", ".rst"]) && pyRegex(String.raw`说明|文档|documentation|guide|instructions`).test(text)));
  if (text.includes("urg") && pyRegex(String.raw`报告|文本|report|text`).test(text) && !preparation) found.add("urg_report");
  if (pyRegex(String.raw`交付审计|delivery audit|independent audit|独立审计`).test(text)) found.add("delivery_audit");
  if (node.artifact_contract?.stage) found.add(node.artifact_contract.stage);
  return found;
}

export function nodeProblems(node: TaskNode, { coverage = false }: { coverage?: boolean } = {}): string[] {
  const contract = node.artifact_contract;
  const jobs = stages(node);
  if (!coverage && jobs.size === 1 && jobs.has("delivery_audit") && !contract) return [];
  if (jobs.size > 1) return [`${node.title}: separate artifact stages: ${[...jobs].sort().join(", ")}`];
  if (!contract) return jobs.size ? [`${node.title}: artifact_contract is required`] : [];
  const errors: string[] = [];
  if (jobs.size && !jobs.has(contract.stage as string)) errors.push("declare the artifact stage");
  const paths = [...contract.inputs, ...contract.outputs].map((item) => item.path);
  if (paths.some((path) => !safeName(path))) errors.push("artifact paths must be safe, relative, concrete paths");
  if (new Set(paths).size !== paths.length) errors.push("inputs and outputs must be distinct; own outputs are not prerequisites");
  if (contract.outputs.some((item) => !node.files.includes(item.path))) errors.push("list every output in files");
  if (contract.inputs.some((item) => !node.reads.includes(item.path))) errors.push("list every input in reads");
  if (!node.acceptance_criteria.trim()) errors.push("retain concrete acceptance_criteria");
  const vdb = (item: Artifact) => item.kind === "directory" && item.path.endsWith(".vdb");
  if (contract.stage === "coverage_vdb" && !contract.outputs.some(vdb)) {
    errors.push("coverage_vdb must deliver a VDB directory (kind=directory, path ending in .vdb)");
  }
  if (contract.stage === "urg_report") {
    if (!contract.inputs.some(vdb)) errors.push("urg_report must consume a VDB directory (kind=directory, path ending in .vdb)");
    if (!contract.outputs.some((item) => item.kind === "file")) errors.push("urg_report must deliver a text report file");
  }
  if (contract.stage === "delivery_audit" && !contract.inputs.some((item) => item.kind === "file")) {
    errors.push("delivery_audit must consume report evidence");
  }
  return errors.map((error) => `${node.title}: ${error}`);
}

export function ancestors(node: TaskNode, nodes: TaskNode[]): TaskNode[] {
  const byId = new Map(nodes.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const todo = [...node.dependencies];
  while (todo.length) {
    const key = todo.pop()!;
    if (seen.has(key) || !byId.has(key)) continue;
    seen.add(key);
    todo.push(...byId.get(key)!.dependencies);
  }
  return nodes.filter((item) => seen.has(item.id));
}

// Files a check runs or reads by name; a fresh task's folder starts empty, so each must be written
// by the step or one it depends on, or the step does its work and then cannot pass its own check.
export const SCRIPT_SUFFIXES = new Set([".py", ".sh", ".bash", ".tcl", ".pl", ".rb", ".js", ".mjs", ".cjs", ".ts"]);
const WORD = pyRegex(String.raw`^[\w./+-]+$`);

export function scripts(command: string): Set<string> {
  let words: string[];
  try {
    words = shlexSplit(command, true);
  } catch {
    return new Set();
  }
  if (words.includes("cd") || words.includes("pushd")) return new Set(); // paths after a cd are relative to somewhere else
  const found = new Set<string>();
  for (const word of words) {
    const name = word.startsWith("./") ? word.slice(2) : word;
    if (WORD.test(name) && !name.startsWith("-") && safeName(name) && (word.startsWith("./") || SCRIPT_SUFFIXES.has(suffix(name)))) {
      found.add(name);
    }
  }
  return found;
}

/** Steps not yet run whose check runs a file nothing before them writes and that is not there
 *  (``exists``: a changed plan's folder already holds what earlier steps wrote). Only in a fresh
 *  folder: in a project the file may already be there. */
export function unwrittenScripts(plan: TaskPlan, exists: (name: string) => boolean = () => false): string[] {
  if (plan.in_project) return [];
  const problems: string[] = [];
  for (const node of plan.nodes) {
    if (node.status !== NodeStatus.enum.pending) continue;
    const commands = [node.check, ...(node.artifact_contract ? node.artifact_contract.acceptance_commands : [])];
    const written = new Set<string>();
    for (const item of [node, ...ancestors(node, plan.nodes)]) {
      for (const path of item.files) written.add(path.replace(/\/+$/, ""));
      for (const out of item.artifact_contract?.outputs ?? []) written.add(out.path.replace(/\/+$/, ""));
    }
    // Sorted, a name once per command that runs it (as Python lists them).
    const missing = commands.filter(Boolean).flatMap((command) => [...scripts(command)])
      .filter((name) => ![...written].some((path) => name === path || name.startsWith(path + "/")) && !exists(name))
      .sort();
    if (missing.length) {
      problems.push(`${node.title}: its check runs ${missing.join(", ")}, which no step writes (the folder `
        + "starts empty); add it to the files of this step or of a step it depends on, or check without it");
    }
  }
  return problems;
}

export function producers(item: Artifact, nodes: TaskNode[]): TaskNode[] {
  return nodes.filter((node) => node.artifact_contract && node.artifact_contract.outputs.some((out) => out.path === item.path && out.kind === item.kind));
}

export function planProblems(plan: TaskPlan, { partial = false }: { partial?: boolean } = {}): string[] {
  const coverage = plan.nodes.some((node) => [...stages(node)].some((stage) => stage === "coverage_vdb" || stage === "urg_report"));
  const problems: string[] = [];
  const delivered = new Map<string, string>();
  for (const node of plan.nodes) {
    problems.push(...nodeProblems(node, { coverage }));
    const contract = node.artifact_contract;
    if (!contract) {
      if (coverage && node.verifies.length && ancestors(node, plan.nodes).some((item) => item.artifact_contract)) {
        problems.push(`${node.title}: audit of artifact work requires artifact_contract`);
      }
      continue;
    }
    for (const output of contract.outputs) {
      if (delivered.has(output.path)) problems.push(`${node.title}: duplicate artifact producer for ${output.path}; retain the original limits`);
      delivered.set(output.path, node.id);
    }
    const before = ancestors(node, plan.nodes);
    for (const item of contract.inputs) {
      const owners = producers(item, plan.nodes);
      if (owners.some((owner) => owner.id === node.id)) continue; // the local distinct-input/output check explains this
      if (item.source === "external" && owners.length) problems.push(`${node.title}: ${item.path} is produced in this plan, not external evidence`);
      if (item.source === "dependency" && producers(item, before).length !== 1 && !(partial && node.after_parts.length && !owners.length)) {
        problems.push(`${node.title}: ${item.path} needs exactly one declared producer dependency`);
      }
    }
    if (contract.stage === "delivery_audit") {
      const reports = before.filter((item) => item.artifact_contract && item.artifact_contract.stage === "urg_report");
      for (const report of reports) {
        if (!contract.inputs.some((item) => producers(item, [report]).length)) {
          problems.push(`${node.title}: audit must consume accepted report from ${report.title}`);
        }
      }
    }
  }
  return problems;
}

export function validate(plan: TaskPlan, { partial = false }: { partial?: boolean } = {}): void {
  const problems = planProblems(plan, { partial });
  if (problems.length) throw new ContractError(problems.join("; "));
}

export function workspace(run: ExecutionRun, node: TaskNode): string {
  return run.project_dir && node.needs_workspace ? run.project_dir : join(settings.workspace_root, folderId(run));
}

/** Path.resolve(): absolute, links followed as far as the path exists. */
function realResolve(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(realResolve(parent), absolute.slice(parent.length + 1));
  }
}

const isLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};
/** Whether ``path`` lies below ``folder`` (Python: folder in path.parents). */
const below = (path: string, folder: string) => path !== folder && path.startsWith(folder.endsWith(sep) ? folder : folder + sep);

export function artifactPath(root: string, name: string): string {
  if (!safeName(name)) throw new ArtifactBlocked(`不安全的产物路径：${name}`);
  const base = realResolve(root);
  const path = join(base, name);
  // Every part of the path below the base, the path itself included.
  for (let part = path; below(part, base); part = dirname(part)) {
    if (isLink(part)) throw new ArtifactBlocked(`产物不能通过符号链接读取：${name}`);
  }
  if (!below(realResolve(path), base)) throw new ArtifactBlocked(`产物超出工作目录：${name}`);
  // Match the sandbox's hidden platform data, including configurable names. A task's own workspace
  // may be inside data_dir/workspace_root; the sandbox exposes that workspace only.
  for (const folder of [realResolve(settings.data_dir), realResolve(settings.workspace_root)]) {
    if (folder !== base && below(folder, base) && (path === folder || below(path, folder))) {
      throw new ArtifactBlocked(`产物位于受保护的平台数据目录：${name}`);
    }
  }
  const database = realResolve(settings.dbPath);
  if (["", "-wal", "-shm", "-journal"].some((end) => path === `${database}${end}`)) throw new ArtifactBlocked(`产物不能读取平台数据库：${name}`);
  return path;
}

// Tools write .key files that are not keys (VCS's ucli.key logs simulator commands): a .key file
// is refused for what it holds, not for its name.
const KEY_MARKS = ["PRIVATE KEY", "BEGIN OPENSSH", "BEGIN PGP PRIVATE"].map((mark) => Buffer.from(mark));

function readHead(file: string, length: number): Buffer {
  const handle = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    return buffer.subarray(0, readSync(handle, buffer, 0, length, 0));
  } finally {
    closeSync(handle);
  }
}

function notAKey(file: string, name: string): void {
  if (suffix(file).toLowerCase() === ".key" && KEY_MARKS.some((mark) => readHead(file, 65536).includes(mark))) {
    throw new ArtifactBlocked(`产物像是私钥，不能读取：${name}`);
  }
}

/** Python sorts paths by their parts: "a/b" before "a-b/c". */
const byParts = (a: string, b: string) => {
  const x = a.split("/");
  const y = b.split("/");
  for (let index = 0; index < Math.min(x.length, y.length); index += 1) {
    if (x[index] !== y[index]) return x[index] < y[index] ? -1 : 1;
  }
  return x.length - y.length;
};
const posixRelative = (from: string, to: string) => relative(from, to).split(sep).join("/");

/** Hash bytes and freshness metadata; an empty/missing artifact is never evidence. Hashed exactly
 *  as the Python backend did, so evidence it accepted still holds. */
export function fingerprint(root: string, item: Artifact): string {
  try {
    const path = artifactPath(root, item.path);
    let files: string[];
    const links: string[] = [];
    if (item.kind === "directory") {
      if (!existsSync(path) || !statSync(path).isDirectory()) throw new ArtifactBlocked(`缺少目录产物：${item.path}`);
      files = [];
      const realPath = realResolve(path);
      const walk = (folder: string) => {
        const entries = readdirSync(folder, { withFileTypes: true });
        const subfolders: string[] = [];
        for (const entry of entries) {
          const full = join(folder, entry.name);
          if (entry.isSymbolicLink() && below(realResolve(full), realPath)) {
            // Tools link within their own outputs (a VCS database shares files across tests): such a
            // link is recorded as a link, never followed.
            links.push(full);
            continue;
          }
          artifactPath(root, posixRelative(realResolve(root), full));
          const isFolder = entry.isDirectory() || (entry.isSymbolicLink() && existsSync(full) && statSync(full).isDirectory());
          if (isFolder) {
            if (entry.isDirectory()) subfolders.push(full);
          } else files.push(full);
        }
        if (files.length > 20_000) throw new ArtifactBlocked(`目录产物过大，无法完整核验：${item.path}`);
        for (const sub of subfolders) walk(sub);
      };
      walk(path);
    } else {
      files = [path];
    }
    const digest = createHash("sha256");
    let size = 0;
    for (const link of links.sort((a, b) => byParts(posixRelative(path, a), posixRelative(path, b)))) {
      digest.update(`${posixRelative(path, link)}->${readlinkSync(link)}`, "utf8");
    }
    for (const file of files.sort((a, b) => byParts(posixRelative(path, a), posixRelative(path, b)))) {
      if (!existsSync(file) || !statSync(file).isFile()) throw new ArtifactBlocked(`不是普通文件：${item.path}`);
      notAKey(file, item.path);
      const info = statSync(file, { bigint: true });
      const label = file !== path ? posixRelative(path, file) : file.slice(file.lastIndexOf("/") + 1);
      digest.update(`${label}:${info.size}:${info.mtimeNs}`, "utf8");
      const handle = openSync(file, "r");
      try {
        const chunk = Buffer.alloc(1024 * 1024);
        for (let read = readSync(handle, chunk); read > 0; read = readSync(handle, chunk)) {
          size += read;
          digest.update(chunk.subarray(0, read));
        }
      } finally {
        closeSync(handle);
      }
    }
    if (!size) throw new ArtifactBlocked(`产物为空：${item.path}`);
    return digest.digest("hex");
  } catch (error) {
    if (error instanceof ArtifactBlocked) throw error;
    throw new ArtifactBlocked(`无法核验产物 ${item.path}：${(error as Error).message}`);
  }
}

export function outputSnapshot(root: string, node: TaskNode): Record<string, string> {
  return Object.fromEntries(node.artifact_contract!.outputs.map((item) => [item.path, fingerprint(root, item)]));
}

const sameRecord = (a: Record<string, string>, b: Record<string, string>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value);

/** Revalidate a saved acceptance before a consumer or lead can rely on it; nothing to revalidate
 *  when the platform does not accept steps (settings.acceptance off). */
export function accepted(run: ExecutionRun, node: TaskNode, seen: Set<string> | null = null): void {
  const evidence = node.artifact_evidence;
  const contract = node.artifact_contract;
  if (!contract || !uses.review()) return;
  if (!evidence || !evidence.accepted || evidence.generation !== node.generation
    || JSON.stringify(evidence.checks.map((check) => (check as Record<string, unknown>).command ?? null)) !== JSON.stringify(contract.acceptance_commands)
    || !evidence.checks.every((check) => (check as Record<string, unknown>).ok)) {
    throw new ArtifactBlocked(`${node.title} 尚无有效产物验收证据`);
  }
  if (!sameRecord(outputSnapshot(workspace(run, node), node), evidence.outputs)) throw new ArtifactBlocked(`${node.title} 的已验收产物已变化或过期`);
  const visited = seen ?? new Set<string>();
  if (visited.has(node.id)) throw new ArtifactBlocked("产物依赖形成循环");
  visited.add(node.id);
  if (!sameRecord(inputSnapshot(run, node, visited), evidence.inputs)) throw new ArtifactBlocked(`${node.title} 的输入证据已变化，报告过期`);
  visited.delete(node.id);
}

/** Each input's fingerprint; a dependency's must match what its producer had accepted. With
 *  acceptance off nothing was accepted: a finished producer is enough. */
export function inputSnapshot(run: ExecutionRun, node: TaskNode, seen: Set<string> | null = null): Record<string, string> {
  const before = ancestors(node, run.plan.nodes);
  const found: Record<string, string> = {};
  for (const item of node.artifact_contract!.inputs) {
    const value = fingerprint(workspace(run, node), item);
    if (item.source === "dependency") {
      const owners = producers(item, before);
      if (owners.length !== 1 || owners[0].status !== "succeeded") throw new ArtifactBlocked(`${item.path} 缺少已完成且已验收的上游步骤`);
      const producer = owners[0];
      accepted(run, producer, seen);
      if (uses.review() && producer.artifact_evidence!.outputs[item.path] !== value) throw new ArtifactBlocked(`${item.path} 与上游验收的产物不一致`);
    }
    found[item.path] = value;
  }
  return found;
}

/** Only inputs are prerequisites; outputs form a baseline for this generation's work. */
export function prepare(run: ExecutionRun, node: TaskNode): void {
  if (!node.artifact_contract) return;
  const problems = nodeProblems(node);
  if (problems.length) throw new ArtifactBlocked(problems.join("; "));
  const inputs = inputSnapshot(run, node);
  if (node.contract_generation === node.generation) {
    if (!sameRecord(inputs, node.artifact_inputs)) throw new ArtifactBlocked("输入证据在本轮工作后变化，必须重新规划或返工");
    return;
  }
  const baseline: Record<string, string> = {};
  for (const item of node.artifact_contract.outputs) {
    try {
      baseline[item.path] = fingerprint(workspace(run, node), item);
    } catch (error) {
      if (!(error instanceof ArtifactBlocked)) throw error;
      baseline[item.path] = "";
    }
  }
  node.contract_generation = node.generation;
  node.artifact_inputs = inputs;
  node.artifact_baseline = baseline;
  node.artifact_evidence = null;
}

export function deliverySnapshot(run: ExecutionRun, node: TaskNode): Record<string, string> {
  if (node.contract_generation !== node.generation) throw new ArtifactBlocked("尚未记录本次产物工作的输入和基线");
  if (!sameRecord(inputSnapshot(run, node), node.artifact_inputs)) throw new ArtifactBlocked("输入证据变化，当前报告不能交付");
  const outputs = outputSnapshot(workspace(run, node), node);
  for (const [path, value] of Object.entries(outputs)) {
    if (node.artifact_baseline[path] === value) throw new ArtifactBlocked(`产物未更新，不能交付旧报告：${path}`);
  }
  return outputs;
}

/** model_dump_json(indent=2): floats keep their ".0" as Pydantic writes them. */
function pydanticJson(contract: TaskNode["artifact_contract"]): string {
  return JSON.stringify(contract, null, 2).replace(/("max_cost_usd": )(\d+)(,?)$/m, "$1$2.0$3");
}

export function prompt(node: TaskNode): string {
  if (!node.artifact_contract) return "";
  const contract = node.artifact_contract;
  const outputs = contract.outputs.map((item) => item.path).join(", ");
  const used = Math.max(node.contract_turns, node.contract_tool_calls);
  return "Artifact contract (additional to the original acceptance criteria):\n"
    + pydanticJson(contract)
    + `\nAlready used: ${used} of ${contract.max_turns} tool calls, $${fixed(node.contract_cost_usd, 6)}.`
    + `\nWrite every declared output first (${outputs}), then check them with the acceptance `
    + "commands. Check only your own outputs: work that other steps own (their testbenches, "
    + "simulations, synthesis, reports) is not yours, however useful it looks. "
    + "Create your own outputs; they need not exist before you start. Do not expand scope. "
    + "Missing prerequisite evidence: preserve logs and end with BLOCKED: <why>. "
    + "At a declared limit stop with diagnostic evidence. Audit only accepted artifacts.";
}
