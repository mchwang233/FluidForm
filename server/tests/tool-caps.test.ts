// A contract step's tool-call cap on the real model channels: the executor tests of
// tests/test_providers.py, ported.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Workspace } from "../src/agent.js";
import { StepLimitExceeded } from "../src/budget.js";
import { ArtifactBlocked } from "../src/contracts.js";
import { Conversation } from "../src/conversation.js";
import type { Executor } from "../src/executor.js";
import { ModelProfileSchema } from "../src/models.js";
import { ProviderRegistry } from "../src/providers.js";
import { PROVIDER_ENV } from "../src/secret-names.js";
import { sleep } from "../src/tasks.js";
import { contractNode, setupExecutor } from "./helpers/artifacts.js";
import { conftest } from "./helpers/conftest.js";
import { anthropicReply, deepseek, registryWith } from "./helpers/providers.js";

const { folder } = conftest();
const realRun = Workspace.prototype.run;
afterEach(() => {
  Workspace.prototype.run = realRun;
});
/** Python sets these on the executor; here they are read-only fields. */
const use = (executor: Executor, fields: Record<string, unknown>) => Object.assign(executor as unknown as Record<string, unknown>, fields);

test("a hard tool cap counts each item of a batch before it has effects", async () => {
  for (const provider of ["deepseek", "anthropic", "google"]) {
    for (const tool of ["Write", "Read"]) {
      for (const requested of [3, 4]) {
        const label = `${provider} ${tool} ${requested}`;
        const root = join(folder(), label.replaceAll(" ", "-"));
        process.env[PROVIDER_ENV[provider]] = "local-test";
        const [executor, db] = setupExecutor(root, [contractNode("vdb", undefined, [], undefined, { contract: { max_turns: 3 } })]);
        const calls = Array.from({ length: requested }, (_, i) => [String(i), tool, { file_path: `tool-${i}.txt`, content: `written ${i}` }] as const);
        if (tool === "Read") for (const [, , args] of calls.slice(1)) writeFileSync(join(root, args.file_path), "input"); // a failed first read still uses one call
        let response: Record<string, unknown>;
        let done: Record<string, unknown>;
        if (provider === "anthropic") {
          response = anthropicReply(calls.map(([key, name, args]) => ({ type: "tool_use", id: key, name, input: args })), "tool_use");
          done = anthropicReply([{ type: "text", text: "done" }]);
        } else if (provider === "google") {
          response = { candidates: [{ content: { parts: calls.map(([, name, args]) => ({ functionCall: { name, args } })) } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } };
          done = { candidates: [{ content: { parts: [{ text: "done" }] } }] };
        } else {
          response = deepseek({ tool_calls: calls.map(([key, name, args]) => ({ id: key, type: "function", function: { name, arguments: JSON.stringify(args) } })) }, "tool_calls");
          done = deepseek({ content: "done" }, "stop");
        }
        const sent: unknown[] = [];
        const registry = registryWith([response, done], sent);
        const api = ModelProfileSchema.parse({ ...executor.modelLookup["test:worker"], id: `${provider}:worker`, provider });
        use(executor, { modelLookup: { [api.id]: api }, providers: registry });
        const run = db.getRun("artifacts")!;
        const node = run.plan.nodes[0];
        node.model_id = api.id;
        db.saveRun(run);
        const invoked: string[] = [];
        const finished: string[] = [];
        Workspace.prototype.run = async function (name: string, args: Record<string, unknown>) {
          invoked.push(args.file_path as string);
          await sleep(0.01); // read calls let in alongside must settle before a refusal returns
          const result = await realRun.call(this, name, args);
          finished.push(args.file_path as string);
          return result;
        };
        const conversation = new Conversation();
        const log: Record<string, any>[] = [];
        const call = executor.complete(run, node, api.id, "work", root, { act: true, tool_log: log, tool_trace: join(root, "trace.jsonl"), conversation });
        if (requested > 3) {
          await assert.rejects(call, (error: Error) => error instanceof StepLimitExceeded && error.message.includes("工具调用上限"), label);
          assert.ok((conversation.state as any).results.some((item: unknown[]) => String(item[2]).includes("工具未执行")), label);
        } else assert.ok((await call).turn_limit, label);
        Workspace.prototype.run = realRun;
        assert.ok(invoked.length === 3 && finished.length === 3 && log.length === 3, `${label}: ${invoked.length} ${finished.length} ${log.length}`);
        assert.ok(!invoked.includes("tool-3.txt"));
        if (tool === "Read") assert.ok(log.some((item) => !item.ok), label);
        if (tool === "Write") {
          for (let i = 0; i < 3; i += 1) assert.equal(readFileSync(join(root, `tool-${i}.txt`), "utf8"), `written ${i}`);
          assert.ok(!existsSync(join(root, "tool-3.txt")));
        }
        const saved = db.getRun(run.id)!.plan.nodes[0];
        assert.ok(saved.contract_tool_calls === 3 && saved.contract_turns === 1, label);
        assert.equal(sent.length, 1, label); // no extra paid summary at either cap
      }
    }
  }
});

test("a direct call held to a contract cannot get past the channel's admission", async () => {
  for (const [modelId, act] of [["mock:local", true], ["deepseek:worker", false]] as const) {
    const [executor, db] = setupExecutor(join(folder(), modelId.replace(":", "-")), [contractNode()]);
    const registry = new ProviderRegistry();
    use(executor, { providers: registry });
    const run = db.getRun("artifacts")!;
    const started: boolean[] = [];
    registry.cli.complete = async () => {
      started.push(true);
      assert.fail("the CLI should not start");
    };
    await assert.rejects(executor.complete(run, run.plan.nodes[0], modelId, "work", folder(), { act, tool_trace: join(folder(), "trace.jsonl") }),
      (error: Error) => error instanceof ArtifactBlocked && error.message.includes("通道"), modelId);
    assert.deepEqual(started, []);
    const node = db.getRun(run.id)!.plan.nodes[0];
    assert.ok(node.contract_turns === 0 && node.contract_tool_calls === 0);
  }
});

test("a membership CLI may take a contract step", async () => {
  // It cannot count tool calls; time and progress checks bound it instead (Executor.timedWatch).
  const [executor, db] = setupExecutor(folder(), [contractNode()]);
  const registry = new ProviderRegistry();
  use(executor, { providers: registry });
  const run = db.getRun("artifacts")!;
  const started: boolean[] = [];
  registry.cli.complete = async () => {
    started.push(true);
    return { text: "done", usage: {} };
  };
  await executor.complete(run, run.plan.nodes[0], "cli:codex", "work", folder(), { act: true, tool_trace: join(folder(), "trace.jsonl") });
  assert.deepEqual(started, [true]);
});
