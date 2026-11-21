// A fixed set of tasks run on the live service, to see whether a change made FluidForm better or
// worse: how many pass, how long they take, what they cost (`super-partner eval`).
//
// A suite is a JSON file (evals/basic.json): {"cases": [{"name", "prompt", "budget_usd",
// "allow_network", "timeout_seconds", "expect": {"status", "contains_any", "max_seconds",
// "max_cost_usd"}}]}. Each case is planned, confirmed and followed through the service's own API, as a
// user would; the report lists every case and a summary, and can be compared with an earlier one.
import { readFileSync } from "node:fs";
import { head } from "./py.js";

export const FINAL = new Set(["succeeded", "failed", "cancelled", "incomplete", "paused"]);
export const POLL_SECONDS = 2.0;

type Json = Record<string, any>;
export type Reply = { ok: boolean; status: number; text: string; json(): any };
/** The service's API, as httpx.AsyncClient(base_url=...) is used here. */
export type Client = { request(method: "GET" | "POST", path: string, body?: unknown, timeoutSeconds?: number): Promise<Reply> };

/** A client of the service at ``base`` (``fetcher``: fetch, or a test's). */
export function client(base: string, fetcher: typeof fetch = fetch, timeoutSeconds = 60): Client {
  return {
    async request(method, path, body, timeout = timeoutSeconds) {
      const response = await fetcher(new URL(path, base), { method, signal: AbortSignal.timeout(timeout * 1000),
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
      const text = await response.text();
      return { ok: response.status < 400, status: response.status, text, json: () => JSON.parse(text) };
    },
  };
}

export function load(path: string): Json[] {
  const cases = (JSON.parse(readFileSync(path, "utf8")).cases || []) as Json[];
  for (const item of cases) if (typeof item.name !== "string" || typeof item.prompt !== "string") throw new TypeError("every case needs a name and a prompt");
  return cases;
}

const round = (value: number, digits: number) => Number(value.toFixed(digits));

/** What a finished task fails of the case's expectations (empty: it passed). */
export function judge(item: Json, run: Json, seconds: number): string[] {
  const expect = item.expect || {};
  const problems: string[] = [];
  if (run.status !== (expect.status ?? "succeeded")) problems.push(`状态 ${run.status ?? "None"}` + (run.error ? `：${head(String(run.error), 200)}` : ""));
  const text = `${run.final_result || ""}`;
  const wanted: string[] = expect.contains_any || [];
  if (wanted.length && !wanted.some((entry) => text.toLowerCase().includes(entry.toLowerCase()))) problems.push("结果里没有：" + wanted.join(" / "));
  if (expect.max_seconds && seconds > expect.max_seconds) problems.push(`用了 ${seconds.toFixed(0)} 秒，超过 ${expect.max_seconds} 秒`);
  if (expect.max_cost_usd !== undefined && expect.max_cost_usd !== null && (run.actual_cost_usd || 0) > expect.max_cost_usd) {
    problems.push(`花了 $${Number(run.actual_cost_usd).toFixed(4)}，超过 $${expect.max_cost_usd}`);
  }
  return problems;
}

const seconds = () => performance.now() / 1000;

/** Plan, confirm and follow one case to its end; what happened. */
export async function runCase(service: Client, item: Json, poll = POLL_SECONDS): Promise<Json> {
  const began = seconds();
  const row: Json = { name: item.name, passed: false };
  const created = await service.request("POST", "/api/tasks", { prompt: item.prompt, budget_usd: item.budget_usd ?? 1.0, allow_network: Boolean(item.allow_network),
    use_cli: item.use_cli ?? true }, 600);
  row.plan_seconds = round(seconds() - began, 1);
  if (!created.ok) return { ...row, problems: [`排计划失败：HTTP ${created.status} ${head(created.text, 200)}`] };
  const task = created.json();
  Object.assign(row, { task_id: task.id, steps: task.plan.nodes.length, planning_note: task.plan.planning_note || "" });
  const confirmed = await service.request("POST", `/api/tasks/${task.id}/confirm`, { budget_usd: item.budget_usd ?? 1.0 });
  if (!confirmed.ok) return { ...row, problems: [`确认失败：HTTP ${confirmed.status} ${head(confirmed.text, 200)}`] };
  const started = seconds();
  const deadline = started + (item.timeout_seconds ?? 900);
  let run: Json = confirmed.json();
  while (!FINAL.has(run.status) && seconds() < deadline) {
    await new Promise((done) => setTimeout(done, poll * 1000));
    run = (await service.request("GET", `/api/tasks/${task.id}`)).json();
  }
  const took = seconds() - started;
  if (!FINAL.has(run.status)) {
    await service.request("POST", `/api/tasks/${task.id}/cancel`);
    run.status = "timed out";
  }
  const nodes: Json[] = run.plan?.nodes ?? [];
  const problems = judge(item, run, took);
  return { ...row, status: run.status, passed: !problems.length, problems, run_seconds: round(took, 1), cost_usd: round(run.actual_cost_usd || 0, 6),
    attempts: nodes.reduce((sum, node) => sum + (node.attempts || []).length, 0), decisions: (run.decisions || []).length };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summary(rows: Json[]): Json {
  const timed = rows.map((row) => row.plan_seconds + (row.run_seconds ?? 0));
  return { cases: rows.length, passed: rows.filter((row) => row.passed).length, median_seconds: timed.length ? round(median(timed), 1) : 0,
    total_cost_usd: round(rows.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0), 6), decisions: rows.reduce((sum, row) => sum + (row.decisions ?? 0), 0) };
}

/** Every case, one after another (so their times do not disturb each other). */
export async function runSuite(service: Client, cases: Json[], only: string[] | null = null, poll = POLL_SECONDS): Promise<Json> {
  const rows: Json[] = [];
  for (const item of cases) if (!only?.length || only.includes(item.name)) rows.push(await runCase(service, item, poll));
  return { summary: summary(rows), cases: rows };
}

/** Lines saying what changed since an earlier report, case by case and overall. */
export function compare(report: Json, before: Json): string[] {
  const lines: string[] = [];
  const old = new Map(((before.cases || []) as Json[]).map((row) => [row.name, row]));
  for (const row of report.cases as Json[]) {
    const earlier = old.get(row.name);
    if (!earlier) continue;
    if (earlier.passed !== row.passed) lines.push(`${row.name}：${row.passed ? "现在通过" : "现在没通过"}`);
    const then = earlier.plan_seconds + (earlier.run_seconds ?? 0);
    const now = row.plan_seconds + (row.run_seconds ?? 0);
    if (then && Math.abs(now - then) / then > 0.25) lines.push(`${row.name}：${then.toFixed(0)} 秒 → ${now.toFixed(0)} 秒`);
  }
  const a = before.summary || {};
  const b = report.summary;
  if (Object.keys(a).length) {
    lines.push(`通过 ${a.passed}/${a.cases} → ${b.passed}/${b.cases}；中位耗时 ${a.median_seconds} → ${b.median_seconds} 秒；总花费 $${a.total_cost_usd} → $${b.total_cost_usd}`);
  }
  return lines;
}
