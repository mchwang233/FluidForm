// conftest.py's database fixture and test_leading's models: a one-step task with a lead.
import { join } from "node:path";
import { settings } from "../../src/config.js";
import { Database } from "../../src/db.js";
import { Executor } from "../../src/executor.js";
import { ExecutionRunSchema, type ModelProfile, ModelProfileSchema, type SupervisorSession } from "../../src/models.js";
import { type CompleteOptions, ProviderResult } from "../../src/providers.js";
import * as quality from "../../src/quality.js";

/** test_turns' model: ranked by coding. */
export const model = (id: string, coding: number, channel = "api"): ModelProfile => ModelProfileSchema.parse({ id, provider: id.split(":")[0], display_name: id, channel,
  context_window: 1_000_000, input_per_million: 1, output_per_million: 1, execution_priority: channel === "cli" ? 0 : 100, scores: { coding, planning: 80, reliability: 90 } });

export const MODELS = Object.fromEntries([model("x:api", 90), model("cli:claude", 96, "cli")].map((m) => [m.id, m]));

/** A one-step task with a lead (failures go to the lead). */
export function leadDatabase(folder: string): Database {
  Object.assign(settings, { workspace_root: join(folder, "workspaces"), data_dir: join(folder, "data"), review_nodes: false, auto_diagnose: true, lead_decisions: true });
  const db = new Database(join(folder, "test.db"));
  db.saveRun(ExecutionRunSchema.parse({ id: "r", prompt: "写一个工具", status: "queued", budget_usd: 1,
    supervisor: { model_id: "cli:claude", session_id: "lead-1", cwd: join(folder, "lead") },
    plan: { summary: "s", nodes: [{ id: "a", title: "实现", instructions: "写代码", capability: "coding", model_id: "x:api" }] } }));
  return db;
}

export const decision = (action: string, fields: Record<string, unknown> = {}) => JSON.stringify({ action, reason: `理由：${action}`, ...fields });

/** Workers fail while ``fails`` lasts; the lead answers from ``decisions`` in order. */
export class Team {
  work: [string, string][] = [];
  lead: string[] = [];
  diagnoses: string[] = [];
  decisions: string[];

  constructor(decisions: string[], readonly fails = 1, readonly review: unknown = null) {
    this.decisions = [...decisions];
  }

  configuredModels(ids: Iterable<string>) {
    return new Set(ids);
  }

  async converse(session: SupervisorSession, prompt: string): Promise<ProviderResult> {
    this.lead.push(prompt);
    session.session_id = session.session_id || "lead-1";
    return new ProviderResult(this.decisions.length ? this.decisions.shift()! : "不知道", 0, 0, session.model_id);
  }

  async complete(modelId: string, prompt: string, options: CompleteOptions = {}): Promise<ProviderResult> {
    if (options.repair) {
      this.diagnoses.push(prompt);
      return new ProviderResult("## 修复内容\n装好了缺的工具\nSTATUS: FIXED", 0, 0, modelId);
    }
    if (prompt.startsWith(quality.REVIEW_MARKER)) return new ProviderResult(JSON.stringify(this.review), 0, 0, modelId);
    this.work.push([modelId, prompt]);
    if (this.work.length <= this.fails) throw new Error("tests failed: 3 errors");
    return new ProviderResult("做完了", 0, 0, modelId);
  }
}

export async function run(db: Database, team: Team): Promise<[Executor, import("../../src/models.js").ExecutionRun]> {
  const executor = new Executor(db, team, MODELS);
  await executor.execute("r");
  return [executor, db.getRun("r")!];
}
