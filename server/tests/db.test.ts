// The database layer: records round-trip, deletion rules, nothing resurrects a deleted
// task, and the Python backend and this server read each other's writes.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { columnTime, Database } from "../src/db.js";
import { type ExecutionRun, ExecutionRunSchema, EventSchema, EngineerJobSchema, ModelProfileSchema } from "../src/models.js";

const fresh = () => new Database(join(mkdtempSync(join(tmpdir(), "db-")), "nested", "test.db"));
const run = (id: string, status = "succeeded", extra: Record<string, unknown> = {}): ExecutionRun =>
  ExecutionRunSchema.parse({ id, prompt: "p", status, budget_usd: 1, plan: { summary: "s", nodes: [] }, ...extra });

test("a run, its events and its conversations are saved and read back", () => {
  const db = fresh();
  const saved = run("r1");
  db.saveRun(saved);
  assert.deepEqual(db.getRun("r1"), saved);
  assert.equal(db.getRun("missing"), null);
  const first = db.addEvent(EventSchema.parse({ run_id: "r1", kind: "started", data: { n: 1 } }));
  db.addEvent(EventSchema.parse({ run_id: "r1", kind: "done", data: { text: "好" } }));
  assert.ok(first.id! > 0);
  assert.deepEqual(db.events("r1").map((event) => event.kind), ["started", "done"]);
  assert.deepEqual(db.events("r1", first.id!).map((event) => event.data), [{ text: "好" }]);
  db.saveConversation("r1", "a", { messages: ["hi"] });
  assert.deepEqual(db.conversation("r1", "a"), { messages: ["hi"] });
  const archived = db.archiveConversation("r1", "a", { messages: ["old"] });
  assert.deepEqual(db.conversationArchive("r1", "a", archived), { messages: ["old"] });
  db.close();
});

test("runs are listed newest first; times in the sort columns as Python writes them", () => {
  const db = fresh();
  db.saveRun(run("old", "succeeded", { created_at: "2026-01-01T00:00:00Z" }));
  db.saveRun(run("new", "succeeded", { created_at: "2026-02-01T00:00:00.5Z" }));
  assert.deepEqual(db.listRuns().map((item) => item.id), ["new", "old"]);
  const row = db.connection.prepare("SELECT created_at FROM runs WHERE id = 'new'").get() as { created_at: string };
  assert.equal(row.created_at, "2026-02-01T00:00:00.500000+00:00");
  assert.equal(columnTime("2026-02-01T00:00:00+08:00"), "2026-02-01T00:00:00+08:00");
  db.close();
});

test("only finished runs (and chats) are deleted, with everything private to them", () => {
  const db = fresh();
  db.saveRun(run("done"));
  db.addEvent(EventSchema.parse({ run_id: "done", kind: "x", data: {} }));
  db.saveConversation("done", "a", { m: 1 });
  db.saveModelCall({ id: "c1", run_id: "done", started_at: "2026-01-01T00:00:00Z", status: "ok" });
  db.saveRetrospective("done", { started_at: "2026-01-01", lesson: "kept" });
  assert.equal(db.deleteRun("done"), true);
  assert.equal(db.getRun("done"), null);
  assert.deepEqual([db.events("done").length, db.conversation("done", "a"), db.modelCalls("done").length], [0, null, 0]);
  assert.deepEqual(db.retrospective("done"), { started_at: "2026-01-01", lesson: "kept" }); // what was learned stays
  assert.equal(db.deleteRun("done"), false);
  db.saveRun(run("running", "running"));
  assert.throws(() => db.deleteRun("running"), /只能删除/);
  db.saveRun(run("chat", "draft"));
  assert.throws(() => db.deleteRun("chat"));
  assert.equal(db.deleteRun("chat", true), true);
  db.close();
});

test("a late checkpoint does not resurrect a deleted task's history", () => {
  const db = fresh();
  db.saveConversation("gone", "a", { m: 1 });
  assert.equal(db.archiveConversation("gone", "a", { m: 1 }), 0);
  db.saveModelCall({ id: "c", run_id: "gone", started_at: "2026-01-01T00:00:00Z" });
  assert.deepEqual([db.conversation("gone", "a"), db.modelCalls().length], [null, 0]);
  db.saveModelCall({ id: "free", started_at: "2026-01-01T00:00:00Z" });
  assert.equal(db.modelCalls().length, 1);
  db.close();
});

test("a run and its events are deleted together or not at all", () => {
  // tests/test_task_deletion.py: test_run_and_events_deletion_rolls_back_together
  const db = fresh();
  const saved = run("r");
  db.saveRun(saved);
  db.addEvent(EventSchema.parse({ run_id: "r", kind: "a", data: {} }));
  db.addEvent(EventSchema.parse({ run_id: "r", kind: "b", data: {} }));
  db.connection.exec("CREATE TRIGGER prevent_event_delete BEFORE DELETE ON events "
    + "BEGIN SELECT RAISE(ABORT, 'event deletion failed'); END");
  assert.throws(() => db.deleteRun("r"), /event deletion failed/);
  assert.deepEqual(db.getRun("r"), saved);
  assert.equal(db.events("r").length, 2);
  db.close();
});

test("model calls cut off by a restart are marked, not counted as free", () => {
  const db = fresh();
  db.saveModelCall({ id: "a", started_at: "2026-01-01T00:00:00Z", status: "running" });
  db.saveModelCall({ id: "b", started_at: "2026-01-02T00:00:00Z", status: "ok" });
  db.interruptModelCalls();
  const [b, a] = db.modelCalls();
  assert.deepEqual([a.status, a.usage_known, (a.warnings as string[]).length, b.status], ["interrupted", false, 1, "ok"]);
  assert.equal(db.modelCallsSince("2026-01-02").length, 1);
  db.close();
});

test("models, jobs, settings and state round-trip", () => {
  const db = fresh();
  const model = ModelProfileSchema.parse({ id: "deepseek:flash", provider: "deepseek", display_name: "Flash" });
  db.saveModels([model]);
  assert.deepEqual(db.listModels(), [model]);
  const job = EngineerJobSchema.parse({ id: "j", title: "修", request: "修一下" });
  db.saveEngineerJob(job);
  assert.deepEqual([db.getEngineerJob("j"), db.engineerJobs().length], [job, 1]);
  db.saveCatalogState({ synced: "today" });
  db.saveRecoveryState({ resumed: ["r"] });
  db.saveLearningSettings({ enabled: true });
  db.saveBenchmarkCache("aa", { rows: 1 });
  assert.deepEqual([db.loadCatalogState(), db.loadRecoveryState(), db.learningSettings(), db.loadBenchmarkCache()],
    [{ synced: "today" }, { resumed: ["r"] }, { enabled: true }, { aa: { rows: 1 } }]);
  db.close();
});

test("a step's conversation survives a restart and goes with its task", () => {
  // tests/test_call_runtime.py: test_conversation_checkpoint_survives_restart_and_deletion
  const path = join(mkdtempSync(join(tmpdir(), "db-")), "state.db");
  const db = new Database(path);
  db.saveRun(run("r", "cancelled"));
  db.saveConversation("r", "n", { model_id: "api:x", state: { history: [{ role: "user", content: "constraint" }] } });
  db.close();
  const reopened = new Database(path);
  assert.equal((reopened.conversation("r", "n") as any).state.history[0].content, "constraint");
  reopened.deleteRun("r");
  assert.equal(reopened.conversation("r", "n"), null);
  reopened.close();
});

test("a write waits while another process holds the database, as Python's sqlite3 does", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "db-")), "t.db");
  const db = new Database(path);
  const { spawn } = await import("node:child_process");
  // Another process takes the write lock and keeps it for half a second.
  const holder = spawn(process.execPath, ["-e", `const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(${JSON.stringify(path)}); db.exec("BEGIN IMMEDIATE"); console.log("locked");
setTimeout(() => { db.exec("COMMIT"); db.close(); }, 500);`], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise<void>((done) => holder.stdout.once("data", () => done()));
  db.saveRun(ExecutionRunSchema.parse({ id: "r", prompt: "p", status: "draft", budget_usd: 1, plan: { summary: "s", nodes: [] } }));
  assert.equal(db.getRun("r")!.id, "r");
  await new Promise((done) => holder.once("close", done));
  db.close();
});
