// tests/artifact_helpers.py: temporary artifacts and fake models for the contract regressions; never
// runs URG.
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Workspace } from "../../src/agent.js";
import { CliChannelRegistry } from "../../src/cli-channels.js";
import { settings } from "../../src/config.js";
import { Database } from "../../src/db.js";
import { Executor } from "../../src/executor.js";
import { ExecutionRunSchema, ModelProfileSchema, type TaskNode, TaskNodeSchema } from "../../src/models.js";
import { type CompleteOptions, ProviderResult, TOOL_LIMIT_REQUIREMENTS } from "../../src/providers.js";

type Json = Record<string, any>;

export function contractNode(key = "vdb", stage = "coverage_vdb", inputs: Json[] = [], output = "coverage.vdb", overrides: Json = {}): TaskNode {
  const { contract: extra = {}, ...rest } = overrides;
  const contract = { stage, inputs, outputs: [{ path: output, kind: output.endsWith(".vdb") ? "directory" : "file" }], acceptance_commands: [`validate ${output}`],
    blocked_when: ["required evidence or simulator unavailable"], max_turns: 3, max_cost_usd: 1, ...extra };
  return TaskNodeSchema.parse({ id: key, title: key, instructions: `Produce ${key}`, capability: "coding", files: [output], reads: inputs.map((item) => item.path),
    model_id: "test:worker", acceptance_criteria: "Real evidence satisfies the original requirements.", artifact_contract: contract, ...rest });
}

export function coverageNodes(): TaskNode[] {
  return [contractNode(), contractNode("report", "urg_report", [{ path: "coverage.vdb", kind: "directory", source: "dependency" }], "report.txt", { dependencies: ["vdb"] }),
    contractNode("audit", "delivery_audit", [{ path: "report.txt", kind: "file", source: "dependency" }], "audit.txt", { dependencies: ["report"], verifies: ["report"] })];
}

export type Work = (node: TaskNode, workspace: string, options: CompleteOptions) => Promise<ProviderResult | null | undefined>;

export class ArtifactProviders {
  readonly nodes: Map<string, TaskNode>;
  readonly calls: string[] = [];
  readonly authorized: Set<string>;
  readonly capabilities: Record<string, Json> = {};
  readonly actualCalls: [string, string][] = [];

  constructor(nodes: TaskNode[], readonly work: Work | null = null) {
    this.nodes = new Map(nodes.map((node) => [node.id, node]));
    this.authorized = new Set(nodes.map((node) => node.model_id!).filter(Boolean));
  }

  configuredModels(ids: Iterable<string>): Set<string> {
    return new Set([...ids].filter((id) => this.authorized.has(id)));
  }

  toolLimitCapabilities(modelId: string): Json {
    return this.capabilities[modelId] ?? (modelId.startsWith("cli:") ? CliChannelRegistry.toolLimitCapabilities(modelId) : { ...TOOL_LIMIT_REQUIREMENTS });
  }

  async complete(modelId: string, _prompt: string, options: CompleteOptions = {}): Promise<ProviderResult> {
    const trace = options.tool_trace;
    if (!trace) return new ProviderResult('{"passed": true, "reason": "criteria checked"}', 1, 1, modelId);
    const name = basename(trace).replace(/\.jsonl$/, "");
    const node = this.nodes.get(name.slice(0, name.lastIndexOf("-")))!;
    this.calls.push(node.id);
    const budget = options.spend_ok!;
    await budget.beginTurn!();
    await budget.record!(modelId, 1000, 1000, 0);
    // API channels count tool calls; a CLI's are not counted.
    if (budget.beginTool) await budget.beginTool();
    this.actualCalls.push([node.id, modelId]);
    if (this.work) {
      const result = await this.work(node, options.workspace!, options);
      if (result) return result;
    } else {
      for (const item of node.artifact_contract!.outputs) {
        let file = join(options.workspace!, item.path);
        if (item.kind === "directory") file = join(file, "coverage.db");
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `evidence ${node.id}\n`);
      }
    }
    options.tool_log!.push({ turn: 1, tool: "Write", detail: node.files[0], ok: true });
    return new ProviderResult("Delivered\nVERDICT: PASS", 1000, 1000, modelId, { turns: 1 });
  }
}

export function setupExecutor(folder: string, nodes: TaskNode[] | null = null, work: Work | null = null): [Executor, Database, ArtifactProviders] {
  const given = nodes ?? coverageNodes();
  Object.assign(settings, { review_nodes: false, workspace_root: join(folder, "workspaces") });
  const db = new Database(join(folder, "artifacts.db"));
  db.saveRun(ExecutionRunSchema.parse({ id: "artifacts", prompt: "Produce coverage evidence", status: "queued", budget_usd: 5, plan: { summary: "coverage", nodes: given } }));
  const model = ModelProfileSchema.parse({ id: "test:worker", provider: "test", display_name: "test", supports_tools: true, input_per_million: 1, output_per_million: 1,
    context_window: 64000, scores: { coding: 90 } });
  const providers = new ArtifactProviders(given, work);
  return [new Executor(db, providers, { [model.id]: model }), db, providers];
}

const realRun = Workspace.prototype.run;

/** Acceptance commands pass (or fail, with ``ok`` false) without running; ``seen`` collects them.
 *  restoreAcceptance puts the real commands back. */
export function mockAcceptance(seen: [string, boolean, boolean][] | null = null, ok = true): void {
  Workspace.prototype.run = async function (this: Workspace, name: string, args: Json): Promise<[string, boolean]> {
    if (name !== "Bash" || this.host) throw new Error("only sandboxed acceptance commands are expected here");
    seen?.push([args.command, this.network, this.host]);
    return [ok ? "artifact check passed" : "artifact check failed", ok];
  };
}

export function restoreAcceptance(): void {
  Workspace.prototype.run = realRun;
}
