// The `fluidform` command (cli.ts), against a stand-in service.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { test } from "node:test";
import { deps, main } from "../src/cli.js";
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

test("without the pricing capability a plan is shown without an estimate", async () => {
  await serving(() => [201, { id: "t2", use_cli: true, plan: { summary: "换算", nodes: [{ title: "算", model_id: "cli:codex", estimated_cost_usd: 0 }], estimate: null } }],
    async () => {
      const { lines, out } = capture();
      assert.equal(await main(["plan", "37 摄氏度是多少华氏度"], out), 0);
      assert.deepEqual(lines, ["Task t2 — 换算", "CLI routing: enabled", "  算: cli:codex", "Not estimated (no pricing capability)"]);
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
  assert.ok(lines[0].startsWith("Usage: fluidform"));
});

test("a plan may keep to named models or to membership CLIs, and tasks are listed and acted on by a short id", async () => {
  const seen: [string, string, unknown][] = [];
  const statuses: Record<string, string> = { "aaaa1111": "paused", "bbbb2222": "failed" };
  await serving((request, body) => {
    seen.push([request.method!, request.url!, body ? JSON.parse(body) : null]);
    if (request.url === "/api/tasks" && request.method === "POST") {
      const given = JSON.parse(body);
      return [201, { id: "t3", use_cli: given.use_cli, cli_only: given.cli_only ?? false, only_models: given.only_models ?? [],
        plan: { summary: "s", nodes: [], estimate: null } }];
    }
    if (request.url === "/api/tasks?brief=true") {
      return [200, Object.entries(statuses).map(([id, status]) => ({ id: `${id}-full-id-0000-0000-000000000000`, status, actual_cost_usd: 0.01, plan: { title: id } }))];
    }
    const id = request.url!.split("/")[3] ?? "";
    if (request.method === "GET") return id.includes("-full-id") ? [200, { status: statuses[id.slice(0, 8)] }] : [404, { detail: "Task not found" }];
    return [200, { status: "queued" }];
  }, async () => {
    const planned = capture();
    assert.equal(await main(["plan", "做个网站", "--model", "x:a", "--model", "cli:codex"], planned.out), 0);
    assert.deepEqual((seen.at(-1)![2] as any).only_models, ["x:a", "cli:codex"]);
    assert.equal(planned.lines[1], "CLI routing: enabled; models: x:a, cli:codex");
    assert.equal(await main(["plan", "做个网站", "--only-cli"], capture().out), 0);
    assert.deepEqual([(seen.at(-1)![2] as any).cli_only, (seen.at(-1)![2] as any).use_cli], [true, true]);
    assert.equal(await main(["plan", "做个网站", "--only-api"], capture().out), 0);
    assert.equal((seen.at(-1)![2] as any).use_cli, false);
    const clash = capture();
    assert.equal(await main(["plan", "x", "--only-cli", "--only-api"], clash.out), 1);
    // Listed newest first; a short id is enough; continuing a paused task confirms it, a failed one resumes.
    const listed = capture();
    assert.equal(await main(["list"], listed.out), 0);
    assert.match(listed.lines[0], /^aaaa1111  paused .*\$0\.0100  aaaa1111$/);
    await main(["resume", "aaaa"], capture().out);
    assert.match(seen.at(-1)![1], /^\/api\/tasks\/aaaa1111-full-id.*\/confirm$/);
    await main(["resume", "bbbb", "--budget", "3"], capture().out);
    assert.deepEqual([seen.at(-1)![1].endsWith("/resume"), seen.at(-1)![2]], [true, { budget_usd: 3 }]);
    await main(["cancel", "bbbb"], capture().out);
    assert.ok(seen.at(-1)![1].endsWith("/cancel"));
    const unknown = capture();
    assert.equal(await main(["pause", "zzzz"], unknown.out), 1);
    assert.match(unknown.errors[0], /没有以 zzzz 开头的任务/);
  });
});

test("keys are typed, never passed as arguments; capabilities are listed, enabled after asking, and removed", async () => {
  const seen: [string, string, unknown][] = [];
  const saved = { ...deps };
  const asked: string[] = [];
  deps.secret = async (prompt) => (asked.push(prompt), "sk-typed-secret");
  deps.confirm = async (question) => (asked.push(question), true);
  try {
    await serving((request, body) => {
      seen.push([request.method!, request.url!, body ? JSON.parse(body) : null]);
      if (request.url === "/api/providers/deepseek/key") return [200, { stored: "keyring" }];
      if (request.url === "/api/capabilities/runtime") return [200, { capabilities: { chat: { status: "running" } } }];
      if (request.url === "/api/capabilities" && request.method === "GET") {
        return [200, [{ id: "chat", kind: "service", status: "active", version: "1.0.0", provides: ["chat"], source: "upload", domains: [], secrets: [] },
          { id: "feishu-bot", name: "飞书机器人", kind: "automation", status: "disabled", requires: ["chat"], source: "upload", domains: ["*.feishu.cn"], secrets: ["FEISHU_APP_ID"] }]];
      }
      if (request.url === "/api/capabilities/feishu-bot" && request.method === "PATCH") return [200, { id: "feishu-bot", status: "active" }];
      if (request.method === "DELETE") return [204, null];
      return [200, {}];
    }, async () => {
      const typed = capture();
      assert.equal(await main(["keys", "set", "deepseek"], typed.out), 0);
      assert.deepEqual(seen.at(-1), ["PUT", "/api/providers/deepseek/key", { api_key: "sk-typed-secret" }]);
      assert.ok(!typed.lines.join("").includes("sk-typed"));
      const listed = capture();
      assert.equal(await main(["capabilities"], listed.out), 0);
      assert.match(listed.lines[0], /^chat\s+服务\s+active\s+v1\.0\.0 提供 chat；进程 running$/);
      assert.match(listed.lines[1], /需要 chat/);
      const enabled = capture();
      assert.equal(await main(["capabilities", "enable", "feishu-bot"], enabled.out), 0);
      assert.match(enabled.lines[0], /能访问 \*\.feishu\.cn；拿到 FEISHU_APP_ID/);
      assert.deepEqual(seen.at(-1), ["PATCH", "/api/capabilities/feishu-bot", { enabled: true, confirmed: true }]);
      assert.equal(asked.at(-1), "启用？");
      assert.equal(await main(["capabilities", "remove", "feishu-bot"], capture().out), 0);
      assert.deepEqual(seen.at(-1).slice(0, 2), ["DELETE", "/api/capabilities/feishu-bot"]);
      assert.equal(await main(["models", "disable", "x:a"], capture().out), 0);
      assert.deepEqual(seen.at(-1), ["PATCH", "/api/models", { model_id: "x:a", enabled: false }]);
    });
  } finally {
    Object.assign(deps, saved);
  }
});
