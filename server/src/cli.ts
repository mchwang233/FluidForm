#!/usr/bin/env node
// The `super-partner` command: models, plan, run, status and eval, through the running
// service's API.
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

async function call(method: "GET" | "POST", path: string, body?: unknown, timeout = 5): Promise<Response> {
  return fetch(new URL(path, settings.api_base_url), { method, signal: AbortSignal.timeout(timeout * 1000),
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
}

async function checked(response: Response): Promise<Json> {
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response.json() as Promise<Json>;
}

const money = (value: number, digits: number) => `$${value.toFixed(digits)}`;

export async function models(out: Out = console_): Promise<void> {
  for (const model of (await checked(await call("GET", "/api/models"))) as unknown as Json[]) {
    let ready = model.configured && model.enabled ? "ready" : "not active";
    if (!(model.routing_ready ?? true)) ready = "pending metadata / unavailable";
    const prices = ["input_per_million", "output_per_million"].map((key) => (model[key] !== null && model[key] !== undefined ? `$${model[key]}` : "unknown")).join("/");
    out.echo(`${String(model.id).padEnd(40)} ${ready.padEnd(30)} ${prices}`);
  }
}

export async function plan(prompt: string, { budget = 2.0, useCli = true, project = null as string | null, asJson = false } = {}, out: Out = console_): Promise<void> {
  const where = project ? realpathOr(resolve(project.replace(/^~(?=$|\/)/, homedir()))) : null;
  const response = await call("POST", "/api/tasks", { prompt, budget_usd: budget, use_cli: useCli, project_dir: where }, 180);
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
  out.echo(`CLI routing: ${data.use_cli ? "enabled" : "disabled"}`);
  if (data.project_dir) out.echo(`Project: ${data.project_dir}`);
  for (const node of data.plan.nodes) out.echo(`  ${node.title}: ${node.model_id}${node.needs_workspace ? " [project]" : ""} (${money(node.estimated_cost_usd, 6)})`);
  const estimate = data.plan.estimate;
  out.echo(`Estimated ${money(estimate.low_usd, 4)}–${money(estimate.high_usd, 4)}; limit ${money(estimate.hard_limit_usd, 2)}`);
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

const HELP = `Usage: super-partner COMMAND [ARGS]

FluidForm multi-model task orchestrator

Commands:
  models                         the models and whether they are ready
  plan PROMPT [--budget N] [--use-cli|--no-use-cli] [--project DIR] [--as-json]
  run TASK_ID [--budget N] [--no-wait]
  status TASK_ID [--as-json]
  eval [SUITE] [--out FILE] [--against FILE] [--only NAME ...]`;

/** Run the command ``argv`` names; its exit code. */
export async function main(argv: string[], out: Out = console_): Promise<number> {
  const [command, ...rest] = argv;
  const parsed = (options: ParseArgsConfig["options"]) => parseArgs({ args: rest, options, allowPositionals: true }) as { values: Record<string, string | boolean | string[] | undefined>; positionals: string[] };
  try {
    if (command === "models") await models(out);
    else if (command === "plan") {
      const { values, positionals } = parsed({ budget: { type: "string" }, "use-cli": { type: "boolean" }, "no-use-cli": { type: "boolean" },
        project: { type: "string" }, "as-json": { type: "boolean" } });
      if (positionals.length !== 1) throw new TypeError("plan takes one PROMPT");
      await plan(positionals[0], { budget: values.budget ? Number(values.budget) : 2.0, useCli: !values["no-use-cli"], project: (values.project as string) ?? null,
        asJson: Boolean(values["as-json"]) }, out);
    } else if (command === "run") {
      const { values, positionals } = parsed({ budget: { type: "string" }, wait: { type: "boolean" }, "no-wait": { type: "boolean" } });
      if (positionals.length !== 1) throw new TypeError("run takes one TASK_ID");
      await run(positionals[0], { budget: values.budget ? Number(values.budget) : null, wait: !values["no-wait"] }, out);
    } else if (command === "status") {
      const { values, positionals } = parsed({ "as-json": { type: "boolean" } });
      if (positionals.length !== 1) throw new TypeError("status takes one TASK_ID");
      await status(positionals[0], Boolean(values["as-json"]), out);
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
