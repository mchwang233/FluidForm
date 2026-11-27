// FluidForm's SQLite database: the same file, tables and JSON bodies,
// so the records the Python backend wrote still load.
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  type EngineerJob, EngineerJobSchema, type Event, EventSchema, type ExecutionRun, ExecutionRunSchema,
  type Improvement, ImprovementSchema, type LearningReview, LearningReviewSchema, type ModelProfile,
  ModelProfileSchema,
} from "./models.js";

type Row = Record<string, SQLInputValue>;
type Json = Record<string, unknown>;

/** A time as Python's datetime.isoformat() writes it in the sort columns: "+00:00", not "Z". */
export function columnTime(iso: string): string {
  return iso.endsWith("Z") ? `${iso.slice(0, -1)}+00:00` : iso;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, body TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
    kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, id);
CREATE TABLE IF NOT EXISTS catalog_state (
    id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS benchmark_cache (
    source TEXT PRIMARY KEY, body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recovery_state (
    id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shared_repairs (
    id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS engineer_jobs (
    id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS retrospectives (
    run_id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS learning_reviews (
    run_id TEXT PRIMARY KEY, body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS improvements (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS improvement_effects (
    improvement_id TEXT NOT NULL, run_id TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY(improvement_id, run_id)
);
CREATE TABLE IF NOT EXISTS learning_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
    run_id TEXT NOT NULL, node_id TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY(run_id, node_id)
);
CREATE TABLE IF NOT EXISTS conversation_archives (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
    node_id TEXT NOT NULL, body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_archives_scope ON conversation_archives(run_id, node_id, id);
CREATE TABLE IF NOT EXISTS model_calls (
    id TEXT PRIMARY KEY, run_id TEXT, node_id TEXT, started_at TEXT NOT NULL, body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calls_run ON model_calls(run_id, started_at);
`;

export class Database {
  readonly connection: DatabaseSync;
  /** Where the file is (PRAGMA database_list's path). */
  readonly path: string;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.path = resolve(path);
    // Wait for another writer (a repair's backup, a tool reading a copy) as Python's sqlite3 does,
    // 5 seconds, instead of failing at once.
    this.connection = new DatabaseSync(path, { timeout: 5000 });
    this.connection.exec(SCHEMA);
  }

  close(): void {
    this.connection.close();
  }

  private run(sql: string, ...values: SQLInputValue[]) {
    return this.connection.prepare(sql).run(...values);
  }

  private one(sql: string, ...values: SQLInputValue[]): Row | undefined {
    return this.connection.prepare(sql).get(...values) as Row | undefined;
  }

  private all(sql: string, ...values: SQLInputValue[]): Row[] {
    return this.connection.prepare(sql).all(...values) as Row[];
  }

  /** ``work`` in one transaction: all of it or none. */
  transaction<T>(work: () => T): T {
    this.connection.exec("BEGIN");
    try {
      const result = work();
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }

  private body<T>(row: Row | undefined, schema: { parse: (value: unknown) => T }): T | null {
    return row ? schema.parse(JSON.parse(row.body as string)) : null;
  }

  private json(row: Row | undefined): Json | null {
    return row ? JSON.parse(row.body as string) : null;
  }

  saveModels(models: Iterable<ModelProfile>): void {
    this.transaction(() => {
      for (const model of models) {
        this.run("INSERT OR REPLACE INTO models(id, body, updated_at) VALUES (?, ?, ?)",
          model.id, JSON.stringify(model), columnTime(model.effective_at));
      }
    });
  }

  saveCatalogState(state: Json): void {
    this.run("INSERT OR REPLACE INTO catalog_state(id, body) VALUES (1, ?)", JSON.stringify(state));
  }

  loadCatalogState(): Json {
    return this.json(this.one("SELECT body FROM catalog_state WHERE id = 1")) ?? {};
  }

  saveBenchmarkCache(source: string, body: Json): void {
    this.run("INSERT OR REPLACE INTO benchmark_cache(source, body) VALUES (?, ?)", source, JSON.stringify(body));
  }

  loadBenchmarkCache(): Record<string, Json> {
    return Object.fromEntries(this.all("SELECT source, body FROM benchmark_cache")
      .map((row) => [row.source as string, JSON.parse(row.body as string)]));
  }

  listModels(): ModelProfile[] {
    return this.all("SELECT body FROM models ORDER BY id").map((row) => this.body(row, ModelProfileSchema)!);
  }

  loadRecoveryState(): Json {
    return this.json(this.one("SELECT body FROM recovery_state WHERE id = 1")) ?? {};
  }

  saveRecoveryState(state: Json): void {
    this.run("INSERT OR REPLACE INTO recovery_state(id, body) VALUES (1, ?)", JSON.stringify(state));
  }

  saveSharedRepair(repair: Json & { id: string; created_at: string }): void {
    this.run("INSERT OR REPLACE INTO shared_repairs(id, body, created_at) VALUES (?, ?, ?)",
      repair.id, JSON.stringify(repair), repair.created_at);
  }

  /** Removes these shared repair records (by the diagnosis or repair id they were kept under); how many. */
  deleteSharedRepairs(ids: string[]): number {
    return this.transaction(() => ids.reduce((count, id) => count + Number(this.run("DELETE FROM shared_repairs WHERE id = ?", id).changes), 0));
  }

  sharedRepairs(limit = 10): Json[] {
    return this.all("SELECT body FROM shared_repairs ORDER BY created_at DESC LIMIT ?", limit).map((row) => this.json(row)!);
  }

  /** A finished task's look back, replacing an earlier one. */
  saveRetrospective(runId: string, body: Json): void {
    this.run("INSERT OR REPLACE INTO retrospectives(run_id, body, created_at) VALUES (?, ?, ?)",
      runId, JSON.stringify(body), (body.started_at as string) || "");
  }

  retrospective(runId: string): Json | null {
    return this.json(this.one("SELECT body FROM retrospectives WHERE run_id = ?", runId));
  }

  /** Removes these tasks' looks back; how many there were. */
  deleteRetrospectives(runIds: string[]): number {
    return this.transaction(() => runIds.reduce((count, id) => count + Number(this.run("DELETE FROM retrospectives WHERE run_id = ?", id).changes), 0));
  }

  retrospectives(): Json[] {
    return this.all("SELECT body FROM retrospectives ORDER BY created_at").map((row) => this.json(row)!);
  }

  saveEngineerJob(job: EngineerJob): void {
    this.run("INSERT OR REPLACE INTO engineer_jobs(id, body, created_at) VALUES (?, ?, ?)",
      job.id, JSON.stringify(job), columnTime(job.created_at));
  }

  learningSettings(): Json {
    return this.json(this.one("SELECT body FROM learning_settings WHERE id = 1")) ?? {};
  }

  saveLearningSettings(value: Json): void {
    this.run("INSERT OR REPLACE INTO learning_settings VALUES (1, ?)", JSON.stringify(value));
  }

  saveLearningReview(review: LearningReview): void {
    this.run("INSERT OR REPLACE INTO learning_reviews VALUES (?, ?)", review.run_id, JSON.stringify(review));
  }

  learningReview(runId: string): LearningReview | null {
    return this.body(this.one("SELECT body FROM learning_reviews WHERE run_id = ?", runId), LearningReviewSchema);
  }

  learningReviews(): LearningReview[] {
    return this.all("SELECT body FROM learning_reviews").map((row) => this.body(row, LearningReviewSchema)!);
  }

  saveImprovement(item: Improvement): void {
    this.run("INSERT OR REPLACE INTO improvements VALUES (?, ?, ?)", item.id, item.run_id, JSON.stringify(item));
  }

  improvement(itemId: string): Improvement | null {
    return this.body(this.one("SELECT body FROM improvements WHERE id = ?", itemId), ImprovementSchema);
  }

  improvements(runId: string | null = null): Improvement[] {
    const rows = runId ? this.all("SELECT body FROM improvements WHERE run_id = ?", runId)
      : this.all("SELECT body FROM improvements");
    return rows.map((row) => this.body(row, ImprovementSchema)!);
  }

  /** Removes a lesson and what was observed of it; whether there was one. */
  deleteImprovement(itemId: string): boolean {
    return this.transaction(() => {
      this.run("DELETE FROM improvement_effects WHERE improvement_id = ?", itemId);
      return Boolean(this.run("DELETE FROM improvements WHERE id = ?", itemId).changes);
    });
  }

  saveImprovementEffect(itemId: string, runId: string, body: Json): void {
    this.run("INSERT OR REPLACE INTO improvement_effects VALUES (?, ?, ?)", itemId, runId, JSON.stringify(body));
  }

  improvementEffects(itemId: string): Json[] {
    return this.all("SELECT body FROM improvement_effects WHERE improvement_id = ?", itemId).map((row) => this.json(row)!);
  }

  /** Removes these platform engineer jobs' records; how many there were. */
  deleteEngineerJobs(jobIds: string[]): number {
    return this.transaction(() => jobIds.reduce((count, id) => count + Number(this.run("DELETE FROM engineer_jobs WHERE id = ?", id).changes), 0));
  }

  getEngineerJob(jobId: string): EngineerJob | null {
    return this.body(this.one("SELECT body FROM engineer_jobs WHERE id = ?", jobId), EngineerJobSchema);
  }

  /** Newest first. */
  engineerJobs(limit = 50): EngineerJob[] {
    return this.all("SELECT body FROM engineer_jobs ORDER BY created_at DESC LIMIT ?", limit)
      .map((row) => this.body(row, EngineerJobSchema)!);
  }

  saveRun(run: ExecutionRun): void {
    this.run("INSERT OR REPLACE INTO runs(id, status, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      run.id, run.status, JSON.stringify(run), columnTime(run.created_at), columnTime(run.updated_at));
  }

  getRun(runId: string): ExecutionRun | null {
    return this.body(this.one("SELECT body FROM runs WHERE id = ?", runId), ExecutionRunSchema);
  }

  listRuns(): ExecutionRun[] {
    return this.all("SELECT body FROM runs ORDER BY created_at DESC").map((row) => this.body(row, ExecutionRunSchema)!);
  }

  /** Delete a finished run (with ``chat``, also a chat: a draft that is never run) and its events
   *  atomically, leaving workspace files alone. What was learned from it stays: its retrospective,
   *  learning review, improvements and their effects are what later tasks are planned with. */
  deleteRun(runId: string, chat = false): boolean {
    return this.transaction(() => {
      const deleted = this.run("DELETE FROM runs WHERE id = ? AND status IN (?, ?, ?, ?, ?)",
        runId, "succeeded", "failed", "cancelled", "incomplete", chat ? "draft" : "succeeded");
      if (!deleted.changes) {
        if (this.one("SELECT 1 FROM runs WHERE id = ?", runId)) {
          throw new Error("只能删除已完成、失败或已取消的任务记录，以及对话。");
        }
        return false;
      }
      this.run("DELETE FROM events WHERE run_id = ?", runId);
      for (const table of ["conversations", "conversation_archives", "model_calls"]) {
        this.run(`DELETE FROM ${table} WHERE run_id = ?`, runId);
      }
      return true;
    });
  }

  saveConversation(runId: string, nodeId: string, body: Json): void {
    // A late checkpoint must not resurrect a deleted task's private history.
    this.run("INSERT OR REPLACE INTO conversations(run_id, node_id, body) "
      + "SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM runs WHERE id = ?)", runId, nodeId, JSON.stringify(body), runId);
  }

  conversation(runId: string, nodeId: string): Json | null {
    return this.json(this.one("SELECT body FROM conversations WHERE run_id = ? AND node_id = ?", runId, nodeId));
  }

  archiveConversation(runId: string, nodeId: string, body: Json): number {
    const result = this.run("INSERT INTO conversation_archives(run_id, node_id, body) "
      + "SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM runs WHERE id = ?)", runId, nodeId, JSON.stringify(body), runId);
    return result.changes ? Number(result.lastInsertRowid) : 0;
  }

  conversationArchive(runId: string, nodeId: string, archiveId: number): Json | null {
    return this.json(this.one("SELECT body FROM conversation_archives WHERE run_id = ? AND node_id = ? AND id = ?",
      runId, nodeId, archiveId));
  }

  saveModelCall(body: Json & { id: string; started_at: string }): void {
    this.transaction(() => {
      if (body.run_id && !this.one("SELECT 1 FROM runs WHERE id = ?", body.run_id as string)) return;
      this.run("INSERT OR REPLACE INTO model_calls VALUES (?, ?, ?, ?, ?)", body.id, (body.run_id as string) ?? null,
        (body.node_id as string) ?? null, body.started_at, JSON.stringify(body));
    });
  }

  modelCalls(runId: string | null = null, limit = 1000): Json[] {
    const cap = Math.max(1, Math.min(limit, 10000));
    const rows = runId
      ? this.all("SELECT body FROM model_calls WHERE run_id = ? ORDER BY started_at DESC LIMIT ?", runId, cap)
      : this.all("SELECT body FROM model_calls ORDER BY started_at DESC LIMIT ?", cap);
    return rows.map((row) => this.json(row)!);
  }

  /** Every model call started at or after ``since`` (ISO time), for totals per model. */
  modelCallsSince(since: string): Json[] {
    return this.all("SELECT body FROM model_calls WHERE started_at >= ? ORDER BY started_at DESC", since)
      .map((row) => this.json(row)!);
  }

  /** Called once at service startup, before admitting new work. */
  interruptModelCalls(): void {
    this.transaction(() => {
      for (const row of this.all("SELECT id, body FROM model_calls")) {
        const body = JSON.parse(row.body as string) as Json;
        if (body.status === "running") {
          body.status = "interrupted";
          body.usage_known = false;
          body.warnings = [...((body.warnings as string[]) ?? []), "服务中断，可能存在未收到的用量；请勿按零消耗处理。"];
          this.run("UPDATE model_calls SET body = ? WHERE id = ?", JSON.stringify(body), row.id);
        }
      }
    });
  }

  addEvent(event: Event): Event {
    const result = this.run("INSERT INTO events(run_id, kind, body, created_at) VALUES (?, ?, ?, ?)",
      event.run_id, event.kind, JSON.stringify(event.data), columnTime(event.created_at));
    event.id = Number(result.lastInsertRowid);
    return event;
  }

  events(runId: string, after = 0): Event[] {
    return this.all("SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id", runId, after)
      .map((row) => EventSchema.parse({ id: row.id, run_id: row.run_id, kind: row.kind,
        data: JSON.parse(row.body as string), created_at: row.created_at }));
  }
}
