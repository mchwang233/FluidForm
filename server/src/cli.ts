#!/usr/bin/env node
// The `fluidform` command: FluidForm's base, a task asked for and run from the command line, its
// models chosen between membership CLIs and API models; and what the web page would otherwise be
// needed for (tasks, keys, models, capability packages), through the running service's API.
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { settings } from "./config.js";
import * as evals from "./evals.js";

type Json = Record<string, any>;
type Out = { echo(line: string): void; error(line: string): void; write(text: string): void };
const console_: Out = { echo: (line) => process.stdout.write(line + "\n"), error: (line) => process.stderr.write(line + "\n"), write: (text) => process.stdout.write(text) };

/** Exit with ``code`` (typer.Exit). */
export class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

async function call(method: Method, path: string, body?: unknown, timeout = 5): Promise<Response> {
  const raw = body instanceof Uint8Array;
  return fetch(new URL(path, settings.api_base_url), { method, signal: AbortSignal.timeout(timeout * 1000),
    ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body), headers: { "content-type": raw ? "application/zip" : "application/json" } }) });
}

/** What the service said went wrong: its ``detail``, or the body. */
async function refusal(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const detail = JSON.parse(text).detail ?? text;
    return typeof detail === "string" ? detail : JSON.stringify(detail);
  } catch {
    return text || `HTTP ${response.status}`;
  }
}

async function checked(response: Response): Promise<Json> {
  if (!response.ok) throw new Error(await refusal(response));
  return response.status === 204 ? {} : (response.json() as Promise<Json>);
}

/** A secret typed at the terminal, not shown (or read from a pipe): never an argument, which other
 *  people on this machine could read in its process list. */
export const deps = {
  secret: (prompt: string): Promise<string> => new Promise((done, fail) => {
    const input = process.stdin;
    if (!input.isTTY) {
      let text = "";
      input.setEncoding("utf8");
      input.on("data", (chunk) => (text += chunk));
      input.on("end", () => done(text.trim()));
      input.on("error", fail);
      return;
    }
    process.stderr.write(prompt);
    let text = "";
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    const typed = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n" || char === "\u0004") {
          input.setRawMode(false);
          input.pause();
          input.off("data", typed);
          process.stderr.write("\n");
          done(text);
          return;
        }
        if (char === "\u0003") {
          input.setRawMode(false);
          process.stderr.write("\n");
          fail(new Exit(130));
          return;
        }
        if (char === "\u007f") text = text.slice(0, -1);
        else text += char;
      }
    };
    input.on("data", typed);
  }),
  // Whether to go on, asked at the terminal (y/N); --yes answers it.
  confirm: (question: string): Promise<boolean> => new Promise((done) => {
    process.stderr.write(`${question} [y/N] `);
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (answer) => {
      process.stdin.pause();
      done(/^y(es)?$/i.test(String(answer).trim()));
    });
    process.stdin.resume();
  }),
};

const money = (value: number, digits: number) => `$${value.toFixed(digits)}`;

export async function models(out: Out = console_): Promise<void> {
  for (const model of (await checked(await call("GET", "/api/models"))) as unknown as Json[]) {
    let ready = model.configured && model.enabled ? "ready" : "not active";
    if (!(model.routing_ready ?? true)) ready = "pending metadata / unavailable";
    const prices = ["input_per_million", "output_per_million"].map((key) => (model[key] !== null && model[key] !== undefined ? `$${model[key]}` : "unknown")).join("/");
    out.echo(`${String(model.id).padEnd(40)} ${ready.padEnd(30)} ${prices}`);
  }
}

export async function plan(prompt: string, { budget = 2.0, useCli = true, project = null as string | null, asJson = false, models = [] as string[],
  onlyCli = false } = {}, out: Out = console_): Promise<void> {
  const where = project ? realpathOr(resolve(project.replace(/^~(?=$|\/)/, homedir()))) : null;
  // Which models it may use: any (CLIs too unless --no-use-cli / --only-api), only CLIs, or only those named.
  const choice = { ...(models.length ? { only_models: models } : {}), ...(onlyCli ? { cli_only: true } : {}) };
  const response = await call("POST", "/api/tasks", { prompt, budget_usd: budget, use_cli: useCli, project_dir: where, ...choice }, 180);
  if (!response.ok) {
    const text = await response.text();
    let detail = text;
    try {
      detail = JSON.parse(text).detail ?? text;
    } catch {
      // not JSON
    }
    out.error(typeof detail === "string" ? detail : JSON.stringify(detail));
    throw new Exit(1);
  }
  const data = (await response.json()) as Json;
  if (asJson) {
    out.echo(JSON.stringify(data, null, 2));
    return;
  }
  out.echo(`Task ${data.id} — ${data.plan.summary}`);
  out.echo(`CLI routing: ${data.cli_only ? "only CLIs" : data.use_cli ? "enabled" : "disabled"}${data.only_models?.length ? `; models: ${data.only_models.join(", ")}` : ""}`);
  if (data.project_dir) out.echo(`Project: ${data.project_dir}`);
  // Without the pricing capability nothing is estimated: the steps and their models only.
  const estimate = data.plan.estimate;
  for (const node of data.plan.nodes) {
    out.echo(`  ${node.title}: ${node.model_id}${node.needs_workspace ? " [project]" : ""}${estimate ? ` (${money(node.estimated_cost_usd, 6)})` : ""}`);
  }
  if (estimate) out.echo(`Estimated ${money(estimate.low_usd, 4)}–${money(estimate.high_usd, 4)}; limit ${money(estimate.hard_limit_usd, 2)}`);
  else out.echo("Not estimated (no pricing capability)");
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export async function run(taskId: string, { budget = null as number | null, wait = true } = {}, out: Out = console_): Promise<void> {
  const confirmed = await checked(await call("POST", `/api/tasks/${taskId}/confirm`, { budget_usd: budget }));
  if (!wait) {
    out.echo(confirmed.status);
    return;
  }
  for (;;) {
    const data = await checked(await call("GET", `/api/tasks/${taskId}`));
    out.write(`\r${data.status}  ${money(data.actual_cost_usd, 6)}`);
    if (evals.FINAL.has(data.status)) {
      out.echo("");
      out.echo(data.final_result || data.error || "Paused");
      return;
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
}

export async function status(taskId: string, asJson = false, out: Out = console_): Promise<void> {
  const data = await checked(await call("GET", `/api/tasks/${taskId}`));
  out.echo(asJson ? JSON.stringify(data, null, 2) : `${data.status} ${money(data.actual_cost_usd, 6)}`);
}

/** Every task, newest first: its id, status, what it costs so far and its title. */
export async function list(out: Out = console_): Promise<void> {
  for (const run of (await checked(await call("GET", "/api/tasks?brief=true"))) as unknown as Json[]) {
    const title = run.plan?.title || run.plan?.summary || run.prompt || "";
    out.echo(`${String(run.id).slice(0, 8)}  ${String(run.kind === "chat" ? "chat" : run.status).padEnd(22)} ${money(run.actual_cost_usd ?? 0, 4).padStart(9)}  ${[...title].slice(0, 60).join("")}`);
  }
}

/** The full id of a task, from the first characters ``list`` shows. */
async function taskId(given: string): Promise<string> {
  if ((await call("GET", `/api/tasks/${encodeURIComponent(given)}`)).ok) return given;
  const found = ((await checked(await call("GET", "/api/tasks?brief=true"))) as unknown as Json[]).filter((run) => String(run.id).startsWith(given));
  if (found.length !== 1) throw new Error(found.length ? `${given} 对应不止一个任务，多写几位` : `没有以 ${given} 开头的任务`);
  return found[0].id;
}

/** Pause, continue or cancel a task. Continuing a paused task (or one waiting for confirmation)
 *  confirms it again; one that failed or was cancelled resumes from where it stopped. */
export async function act(action: "pause" | "resume" | "cancel", given: string, { budget = null as number | null } = {}, out: Out = console_): Promise<void> {
  const id = await taskId(given);
  let path = `/api/tasks/${id}/${action}`;
  if (action === "resume") {
    const current = await checked(await call("GET", `/api/tasks/${id}`));
    if (["paused", "awaiting_confirmation", "queued"].includes(current.status)) path = `/api/tasks/${id}/confirm`;
  }
  const data = await checked(await call("POST", path, action === "resume" ? { budget_usd: budget } : {}, 30));
  out.echo(data.status ?? action);
}

/** The model providers and whether each has a key. */
export async function keys(out: Out = console_): Promise<void> {
  for (const provider of (await checked(await call("GET", "/api/providers"))) as unknown as Json[]) {
    out.echo(`${String(provider.id).padEnd(16)} ${provider.configured ? "有 key" : provider.keyring_locked ? "钥匙串锁着" : "没有 key"}  ${provider.name ?? ""}`);
  }
}

/** Store a provider's key in the system keyring: typed at the terminal, not shown. */
export async function setKey(provider: string, out: Out = console_): Promise<void> {
  const key = (await deps.secret(`${provider} 的 API key（输入时不显示）：`)).trim();
  if (!key) throw new Error("没有输入 key");
  const data = await checked(await call("PUT", `/api/providers/${encodeURIComponent(provider)}/key`, { api_key: key }, 30));
  out.echo(`已存好（${data.stored}）`);
}

export async function removeKey(provider: string, out: Out = console_): Promise<void> {
  const data = await checked(await call("DELETE", `/api/providers/${encodeURIComponent(provider)}/key`, undefined, 30));
  out.echo(data.removed ? "已删除" : "本来就没有");
}

export async function testKey(provider: string, out: Out = console_): Promise<void> {
  const data = await checked(await call("POST", `/api/providers/${encodeURIComponent(provider)}/test`, {}, 120));
  out.echo(data.message ?? "ok");
}

/** Switch a model on or off for routing. */
export async function switchModel(modelId: string, enabled: boolean, out: Out = console_): Promise<void> {
  const data = await checked(await call("PATCH", "/api/models", { model_id: modelId, enabled }));
  out.echo(`${data.id} ${data.enabled ? "已启用" : "已停用"}`);
}

const KIND: Record<string, string> = { tool: "工具", automation: "自动化", service: "服务", interface: "界面" };

/** The capabilities: what each is, whether it is on, and what it provides and needs. */
export async function capabilityList(out: Out = console_): Promise<void> {
  const runtime = await checked(await call("GET", "/api/capabilities/runtime"));
  for (const item of (await checked(await call("GET", "/api/capabilities"))) as unknown as Json[]) {
    const running = runtime.capabilities?.[item.id]?.status;
    const extra = [item.provides?.length ? `提供 ${item.provides.join("、")}` : "", item.requires?.length ? `需要 ${item.requires.join("、")}` : "",
      running ? `进程 ${running}` : ""].filter(Boolean).join("；");
    out.echo(`${String(item.id).padEnd(20)} ${(KIND[item.kind] ?? item.kind).padEnd(4)} ${String(item.status).padEnd(9)} ${item.version ? `v${item.version} ` : ""}${extra}`);
  }
}

/** Install (or upgrade) a capability package from its zip; it starts switched off. */
export async function capabilityInstall(zip: string, out: Out = console_): Promise<void> {
  const data = await checked(await call("POST", "/api/capabilities/upload", new Uint8Array(readFileSync(zip)), 900));
  out.echo(`${data.id} v${data.version || "?"} 已安装（${data.status === "failed" ? "检查没通过" : "未启用"}）`);
  if (data.status === "failed") out.echo(data.check_output || "");
}

/** Switch a capability on (after saying what it may reach and get, and asking) or off. */
export async function capabilitySwitch(id: string, enabled: boolean, { yes = false } = {}, out: Out = console_): Promise<void> {
  if (enabled) {
    const item = ((await checked(await call("GET", "/api/capabilities"))) as unknown as Json[]).find((entry) => entry.id === id);
    if (!item) throw new Error(`没有这个能力：${id}`);
    if (item.source === "upload") {
      out.echo(`「${item.name}」是上传的代码，会在沙箱里运行：能访问 ${item.domains?.length ? item.domains.join("、") : "（不联网）"}；`
        + `拿到 ${item.secrets?.length ? item.secrets.join("、") : "（没有密钥）"}${item.kind === "interface" ? "；它的网页能用 FluidForm 的全部接口" : ""}。`);
      if (!yes && !(await deps.confirm("启用？"))) throw new Exit(1);
    }
  }
  const data = await checked(await call("PATCH", `/api/capabilities/${encodeURIComponent(id)}`, { enabled, confirmed: true }, 60));
  out.echo(`${data.id} ${data.status === "active" ? "已启用" : "已停用"}`);
}

/** Store a package's secrets, each typed at the terminal and not shown. */
export async function capabilitySecrets(id: string, out: Out = console_): Promise<void> {
  const item = ((await checked(await call("GET", "/api/capabilities"))) as unknown as Json[]).find((entry) => entry.id === id);
  if (!item) throw new Error(`没有这个能力：${id}`);
  if (!item.secrets?.length) {
    out.echo("它不需要密钥");
    return;
  }
  const values: Record<string, string> = {};
  for (const name of item.secrets) {
    const value = (await deps.secret(`${name}（输入时不显示，留空不改）：`)).trim();
    if (value) values[name] = value;
  }
  await checked(await call("PUT", `/api/capabilities/${encodeURIComponent(id)}/secrets`, { values }, 60));
  out.echo(`已存好：${Object.keys(values).join("、") || "没有改动"}`);
}

export async function capabilityRemove(id: string, out: Out = console_): Promise<void> {
  await checked(await call("DELETE", `/api/capabilities/${encodeURIComponent(id)}`, undefined, 60));
  out.echo(`${id} 已卸载`);
}

/** Run a fixed set of tasks on the running service and report passes, time and cost. */
export async function runEval(suite = "evals/basic.json", { out = null as string | null, against = null as string | null, only = [] as string[] } = {},
  console: Out = console_): Promise<void> {
  const report = await evals.runSuite(evals.client(settings.api_base_url), evals.load(suite), only);
  for (const row of report.cases as Json[]) {
    const mark = row.passed ? "通过" : "没通过";
    console.echo(`${String(row.name).padEnd(16)} ${mark.padEnd(4)} 排计划 ${row.plan_seconds.toFixed(0).padStart(5)}s  执行 ${(row.run_seconds ?? 0).toFixed(0).padStart(5)}s  `
      + `${money(row.cost_usd ?? 0, 4)}  ${(row.problems || []).join("；")}`);
  }
  const total = report.summary;
  console.echo(`通过 ${total.passed}/${total.cases}，中位耗时 ${total.median_seconds} 秒，总花费 $${total.total_cost_usd}`);
  if (against) for (const line of evals.compare(report, JSON.parse(readFileSync(against, "utf8")))) console.echo(line);
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
}

const HELP = `Usage: fluidform COMMAND [ARGS]

FluidForm multi-model task orchestrator

Tasks:
  plan PROMPT [--budget N] [--project DIR] [--as-json]
       [--use-cli|--no-use-cli|--only-api|--only-cli] [--model ID ...]
                                 plan a task; its models: any, no CLIs, only CLIs, or only those named
  run TASK_ID [--budget N] [--no-wait]
  status TASK_ID [--as-json]
  list                           every task, newest first
  pause TASK_ID | resume TASK_ID [--budget N] | cancel TASK_ID
Models:
  models                         the models and whether they are ready
  models enable|disable MODEL_ID
  keys                           the providers and whether each has a key
  keys set|remove|test PROVIDER  the key is typed at the terminal (or piped), kept in the system keyring
Capabilities:
  capabilities                   list them
  capabilities install ZIP | enable ID [--yes] | disable ID | secrets ID | remove ID
Other:
  eval [SUITE] [--out FILE] [--against FILE] [--only NAME ...]

A TASK_ID may be the first characters list shows.`;

/** Run the command ``argv`` names; its exit code. */
export async function main(argv: string[], out: Out = console_): Promise<number> {
  const [command, ...rest] = argv;
  const parsed = (options: ParseArgsConfig["options"]) => parseArgs({ args: rest, options, allowPositionals: true }) as { values: Record<string, string | boolean | string[] | undefined>; positionals: string[] };
  try {
    if (command === "models") {
      const [action, modelId] = rest;
      if (!action) await models(out);
      else if ((action === "enable" || action === "disable") && modelId) await switchModel(modelId, action === "enable", out);
      else throw new TypeError("models [enable|disable MODEL_ID]");
    } else if (command === "plan") {
      const { values, positionals } = parsed({ budget: { type: "string" }, "use-cli": { type: "boolean" }, "no-use-cli": { type: "boolean" },
        "only-api": { type: "boolean" }, "only-cli": { type: "boolean" }, model: { type: "string", multiple: true },
        project: { type: "string" }, "as-json": { type: "boolean" } });
      if (positionals.length !== 1) throw new TypeError("plan takes one PROMPT");
      if (values["only-cli"] && (values["only-api"] || values["no-use-cli"])) throw new TypeError("--only-cli and --only-api / --no-use-cli exclude each other");
      await plan(positionals[0], { budget: values.budget ? Number(values.budget) : 2.0, useCli: !values["no-use-cli"] && !values["only-api"],
        project: (values.project as string) ?? null, asJson: Boolean(values["as-json"]), models: (values.model as string[]) ?? [], onlyCli: Boolean(values["only-cli"]) }, out);
    } else if (command === "run") {
      const { values, positionals } = parsed({ budget: { type: "string" }, wait: { type: "boolean" }, "no-wait": { type: "boolean" } });
      if (positionals.length !== 1) throw new TypeError("run takes one TASK_ID");
      await run(await taskId(positionals[0]), { budget: values.budget ? Number(values.budget) : null, wait: !values["no-wait"] }, out);
    } else if (command === "status") {
      const { values, positionals } = parsed({ "as-json": { type: "boolean" } });
      if (positionals.length !== 1) throw new TypeError("status takes one TASK_ID");
      await status(await taskId(positionals[0]), Boolean(values["as-json"]), out);
    } else if (command === "list") await list(out);
    else if (command === "pause" || command === "resume" || command === "cancel") {
      const { values, positionals } = parsed({ budget: { type: "string" } });
      if (positionals.length !== 1) throw new TypeError(`${command} takes one TASK_ID`);
      await act(command, positionals[0], { budget: values.budget ? Number(values.budget) : null }, out);
    } else if (command === "keys") {
      const [action, provider] = rest;
      if (!action) await keys(out);
      else if (action === "set" && provider) await setKey(provider, out);
      else if (action === "remove" && provider) await removeKey(provider, out);
      else if (action === "test" && provider) await testKey(provider, out);
      else throw new TypeError("keys [set|remove|test PROVIDER]");
    } else if (command === "capabilities") {
      const { values, positionals } = parsed({ yes: { type: "boolean" } });
      const [action, target] = positionals;
      if (!action) await capabilityList(out);
      else if (action === "install" && target) await capabilityInstall(target, out);
      else if ((action === "enable" || action === "disable") && target) await capabilitySwitch(target, action === "enable", { yes: Boolean(values.yes) }, out);
      else if (action === "secrets" && target) await capabilitySecrets(target, out);
      else if (action === "remove" && target) await capabilityRemove(target, out);
      else throw new TypeError("capabilities [install ZIP | enable ID | disable ID | secrets ID | remove ID]");
    } else if (command === "eval") {
      const { values, positionals } = parsed({ out: { type: "string" }, against: { type: "string" }, only: { type: "string", multiple: true } });
      await runEval(positionals[0] ?? "evals/basic.json", { out: (values.out as string) ?? null, against: (values.against as string) ?? null,
        only: (values.only as string[]) ?? [] }, out);
    } else {
      out.echo(HELP);
      return command && command !== "--help" && command !== "-h" ? 2 : 0;
    }
    return 0;
  } catch (error) {
    if (error instanceof Exit) return error.code;
    out.error((error as Error).message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${realpathOr(process.argv[1])}`).href) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
