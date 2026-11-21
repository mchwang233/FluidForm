// The `super-partner` command (cli.ts), against a stand-in service.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { test } from "node:test";
import { main } from "../src/cli.js";
import { settings } from "../src/config.js";
import { conftest } from "./helpers/conftest.js";

conftest();

async function serving(answer: (request: IncomingMessage, body: string) => [number, unknown], work: () => Promise<void>): Promise<void> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const [status, reply] = answer(request, body);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  settings.api_base_url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await work();
  } finally {
    server.close();
  }
}

const capture = () => {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: { echo: (line: string) => lines.push(line), error: (line: string) => errors.push(line), write: (text: string) => lines.push(text) } };
};

test("plan shows the steps and the estimate, and run follows the task to its end", async () => {
  const seen: unknown[] = [];
  let looks = 0;
  await serving((request, body) => {
    seen.push([request.method, request.url, body ? JSON.parse(body) : null]);
    if (request.url === "/api/tasks") return [201, { id: "t1", use_cli: false, plan: { summary: "换算", nodes: [{ title: "算", model_id: "x:api", estimated_cost_usd: 0.0012 }],
      estimate: { low_usd: 0.001, high_usd: 0.002, hard_limit_usd: 1 } } }];
    if (request.url === "/api/tasks/t1/confirm") return [200, { status: "queued" }];
    looks += 1;
    return [200, { status: looks > 1 ? "succeeded" : "running", actual_cost_usd: 0.0015, final_result: "98.6°F" }];
  }, async () => {
    const { lines, out } = capture();
    assert.equal(await main(["plan", "37 摄氏度是多少华氏度", "--budget", "0.5", "--no-use-cli"], out), 0);
    assert.deepEqual(seen[0], ["POST", "/api/tasks", { prompt: "37 摄氏度是多少华氏度", budget_usd: 0.5, use_cli: false, project_dir: null }]);
    assert.deepEqual(lines, ["Task t1 — 换算", "CLI routing: disabled", "  算: x:api ($0.001200)", "Estimated $0.0010–$0.0020; limit $1.00"]);
    const ran = capture();
    assert.equal(await main(["run", "t1"], ran.out), 0);
    assert.equal(ran.lines.at(-1), "98.6°F");
  });
});

test("a plan the service refuses says why and exits 1; an unknown command shows the help", async () => {
  await serving(() => [400, { detail: "预算太低" }], async () => {
    const { errors, out } = capture();
    assert.equal(await main(["plan", "x"], out), 1);
    assert.deepEqual(errors, ["预算太低"]);
  });
  const { lines, out } = capture();
  assert.equal(await main(["nope"], out), 2);
  assert.ok(lines[0].startsWith("Usage: super-partner"));
});
