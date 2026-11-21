// The eval suite: tests/test_evals.py, ported.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as evals from "../src/evals.js";

/** A service whose task ends as ``final`` after one look. */
function service(final: Record<string, unknown>): [evals.Client, [string, string][]] {
  const seen: [string, string][] = [];
  const fetcher = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    seen.push([init.method ?? "GET", url.pathname]);
    if (url.pathname === "/api/tasks") {
      const body = JSON.parse(String(init.body));
      assert.ok(body.allow_network === true && body.budget_usd === 0.5);
      return Response.json({ id: "t1", plan: { nodes: [{}], planning_note: "一步就能做完" } }, { status: 201 });
    }
    if (url.pathname.endsWith("/confirm")) return Response.json({ id: "t1", status: "queued" });
    return Response.json(final);
  }) as typeof fetch;
  return [evals.client("http://svc", fetcher), seen];
}

const CASE = { name: "换算", prompt: "37 摄氏度是多少华氏度", budget_usd: 0.5, allow_network: true, expect: { contains_any: ["98.6"], max_cost_usd: 0.1 } };

test("a case is followed to its end and judged", async () => {
  const [client, seen] = service({ status: "succeeded", final_result: "98.6°F", actual_cost_usd: 0.004, plan: { nodes: [{ attempts: [{}] }] }, decisions: [] });
  const report = await evals.runSuite(client, [CASE], null, 0);
  const [row] = report.cases;
  assert.ok(row.passed && row.problems.length === 0);
  assert.deepEqual([row.steps, row.attempts, row.cost_usd], [1, 1, 0.004]);
  assert.deepEqual(seen, [["POST", "/api/tasks"], ["POST", "/api/tasks/t1/confirm"], ["GET", "/api/tasks/t1"]]);
  assert.equal(report.summary.passed, 1);
});

test("a wrong or costly result does not pass", async () => {
  const [client] = service({ status: "succeeded", final_result: "100°F", actual_cost_usd: 0.5, plan: { nodes: [] } });
  const [row] = (await evals.runSuite(client, [CASE], null, 0)).cases;
  assert.ok(!row.passed && row.problems.length === 2);
});

test("reports are compared case by case", () => {
  const before = { summary: { cases: 1, passed: 0, median_seconds: 200, total_cost_usd: 0.1 }, cases: [{ name: "换算", passed: false, plan_seconds: 150, run_seconds: 50 }] };
  const rows = [{ name: "换算", passed: true, plan_seconds: 2, run_seconds: 40 }];
  const lines = evals.compare({ summary: evals.summary(rows), cases: rows }, before);
  assert.equal(lines[0], "换算：现在通过");
  assert.equal(lines[1], "换算：200 秒 → 42 秒");
  assert.ok(lines[2].startsWith("通过 0/1 → 1/1"));
});

test("the suite in the repository loads", () => {
  const cases = evals.load(join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "evals", "basic.json"));
  assert.ok(cases.length >= 5 && new Set(cases.map((item) => item.name)).size === cases.length);
});
