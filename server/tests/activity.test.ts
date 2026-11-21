// tests/test_activity.py (the parts about activity.ts and stored tool calls), ported.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as activity from "../src/activity.js";
import { Database } from "../src/db.js";
import { ExecutionRunSchema, NodeAttemptSchema } from "../src/models.js";

const codex = (type: string, item: Record<string, unknown>) => JSON.stringify({ type, item });

test("codex events become tool log entries and a finished command replaces its start", () => {
  const log: activity.LogEntry[] = [];
  activity.recording(log, () => {
    activity.noteLine(Buffer.from('{"type":"turn.started"}'));
    activity.noteLine(Buffer.from("not json"));
    activity.noteLine(codex("item.completed", { id: "m", type: "agent_message", text: "先写 RTL" }));
    activity.noteLine(codex("item.started", { id: "c", type: "command_execution", command: "vcs -full64",
      aggregated_output: "", exit_code: null, status: "in_progress" }));
    assert.ok(log[log.length - 1].running && log[log.length - 1].ok === null);
    activity.noteLine(codex("item.completed", { id: "c", type: "command_execution", command: "vcs -full64",
      aggregated_output: "Error-[SE]", exit_code: 1, status: "completed" }));
    activity.noteLine(codex("item.completed", { id: "f", type: "file_change",
      changes: [{ path: "rtl/fifo.sv", kind: "add" }], status: "completed" }));
  });
  assert.deepEqual(log.map((entry) => [entry.tool, entry.detail]),
    [["message", "先写 RTL"], ["command", "vcs -full64"], ["file_change", "add rtl/fifo.sv"]]);
  assert.ok(log[1].ok === false && !log[1].running && log[1].output === "Error-[SE]");
  assert.ok(log.every((entry) => entry.turn === 0));
});

test("nothing is recorded outside a step or while paused", () => {
  activity.noteLine(codex("item.completed", { id: "m", type: "agent_message", text: "x" }));
  const log: activity.LogEntry[] = [];
  activity.recording(log, () => activity.paused(() =>
    activity.noteLine(codex("item.completed", { id: "m", type: "agent_message", text: "x" }))));
  assert.deepEqual(log, []);
});

test("what a step records follows it into the async work it starts, and nowhere else", async () => {
  const mine: activity.LogEntry[] = [];
  const other: activity.LogEntry[] = [];
  const say = (text: string) => activity.noteLine(codex("item.completed", { id: text, type: "agent_message", text }));
  await Promise.all([
    activity.recording(mine, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      say("mine");
    }),
    activity.recording(other, async () => say("other")),
  ]);
  assert.deepEqual([mine.map((entry) => entry.detail), other.map((entry) => entry.detail)], [["mine"], ["other"]]);
});

test("completion matches the entire log even beyond the display limit", () => {
  const log: activity.LogEntry[] = [];
  activity.recording(log, () => {
    for (let index = 0; index < 420; index += 1) {
      activity.noteLine(codex("item.started", { id: String(index), type: "command_execution", command: "check" }));
    }
    for (let index = 0; index < 420; index += 1) {
      activity.noteLine(codex("item.completed", { id: String(index), type: "command_execution", command: "check",
        exit_code: 0, status: "completed" }));
    }
  });
  assert.equal(log.length, 420);
  assert.ok(log.every((entry) => entry.ok === true && !entry.running));
});

test("a command completed without an exit code is unknown, not failed", () => {
  const entry = activity.codexEntry(JSON.parse(codex("item.completed", { id: "c", type: "command_execution",
    command: "check", status: "completed" })))!;
  assert.equal(entry.ok, null);
  assert.equal(entry.status, "unknown");
  const failed = activity.codexEntry(JSON.parse(codex("item.completed", { id: "c", type: "command_execution",
    command: "check", status: "failed", exit_code: 0 })))!;
  assert.equal(failed.ok, false);
  assert.equal(failed.exit_code, 0);
});

test("a plan and long output are cut for the page", () => {
  const plan = activity.codexEntry({ type: "item.updated", item: { id: "p", type: "todo_list",
    items: [{ text: "写 RTL", completed: true }, { text: "仿真" }] } })!;
  assert.equal(plan.detail, "✓ 写 RTL；仿真");
  const long = activity.codexEntry({ type: "item.completed", item: { id: "c", type: "command_execution",
    command: "x".repeat(1000), aggregated_output: "a".repeat(10) + "y".repeat(3000), exit_code: 0 } })!;
  assert.equal((long.detail as string).length, activity.MAX_DETAIL);
  assert.equal(long.output, "y".repeat(activity.MAX_OUTPUT));
  assert.equal(activity.codexEntry({ type: "item.completed", item: { type: "reasoning" } }), null);
});

test("historical unknown tool calls round-trip without inventing success", () => {
  const database = new Database(join(mkdtempSync(join(tmpdir(), "history-")), "history.db"));
  const body = JSON.parse(JSON.stringify(ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "failed", budget_usd: 1,
    plan: { summary: "s", nodes: [{ id: "n", title: "t", instructions: "i", capability: "coding" }] } })));
  database.saveRun(ExecutionRunSchema.parse(body));
  body.plan.nodes[0].attempts = [{ outcome: "error", tool_calls: [
    { turn: 0, tool: "command", ok: null, id: "pending", running: true },
    { turn: 0, tool: "command" },
    { turn: 0, tool: "command", ok: false, exit_code: 2 },
    { turn: 0, tool: "command", ok: true, exit_code: 0 },
  ] }];
  // Store the legacy JSON directly, so reads must handle null and absent fields themselves.
  database.connection.prepare("UPDATE runs SET body = ? WHERE id = ?").run(JSON.stringify(body), "r");
  for (const run of [database.getRun("r")!, ...database.listRuns()]) {
    const attempt = run.plan.nodes[0].attempts[0];
    assert.deepEqual(attempt.tool_calls.map((call) => call.ok), [null, null, false, true]);
    assert.equal(attempt.tool_calls[0].id, "pending");
    assert.equal(attempt.tool_calls[0].status, "incomplete");
    assert.equal(attempt.tool_calls[1].status, "unknown");
    assert.equal(attempt.tool_calls[2].exit_code, 2);
    assert.equal(attempt.result, null);
    assert.deepEqual(NodeAttemptSchema.parse(JSON.parse(JSON.stringify(attempt))), attempt);
    database.saveRun(run);
  }
  database.close();
});
