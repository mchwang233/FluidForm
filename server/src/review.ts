// Accepting or rejecting a step's result: a verification's own verdict, or a reviewer model
// against the acceptance criteria (both the lead extension's, packages/lead/src); and the checks on an attempt that runs long. Python mixes this into
// the executor; here its functions take the executor (ReviewHost).
import { uses } from "./features.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import * as agent from "./agent.js";
import { BudgetExceeded, StepLimitExceeded, StepReservationBusy } from "./budget.js";
import { settings } from "./config.js";
import * as contracts from "./contracts.js";
import type { Database } from "./db.js";
import { type ArtifactEvidence, ArtifactEvidenceSchema, type ExecutionRun, folderId, type ModelProfile, type TaskNode } from "./models.js";
import * as progress from "./progress.js";
import { trace, type ProviderResult } from "./providers.js";
import { pyRound } from "./py.js";
import * as quality from "./quality.js";
import { pickReviewer } from "./routing.js";
import { lead, review } from "./ports/lead.js";
import { isCancelled } from "./tasks.js";

// Reasoning effort for the check on a long attempt (a short yes or no).
export const PROGRESS_EFFORT = "low";

type Json = Record<string, any>;

/** What reviewing needs of the executor. */
export type ReviewHost = {
  db: Database;
  modelLookup: Record<string, ModelProfile>;
  toolLogs: Map<string, Json[]>;
  toolTraces: Map<string, string>;
  configured(run: ExecutionRun): Set<string>;
  complete(run: ExecutionRun, node: TaskNode | null, modelId: string, prompt: string, workspace: string, options: Json): Promise<ProviderResult>;
  emit(runId: string, kind: string, data?: Json): void;
  canLead(): boolean;
  thinking<T>(runId: string, kind: string, nodeId: string | null, work: () => Promise<T>): Promise<T>;
  askLead(runId: string, message: string): Promise<string>;
};

/** The key of a step's tool log and trace (Python's (run_id, node_id)). */
export const stepKey = (runId: string, nodeId: string) => `${runId}\0${nodeId}`;

function logAcceptance(host: ReviewHost, run: ExecutionRun, node: TaskNode, entry: Json): void {
  const key = stepKey(run.id, node.id);
  if (!host.toolLogs.has(key)) host.toolLogs.set(key, []);
  host.toolLogs.get(key)!.push(entry);
  const path = host.toolTraces.get(key);
  if (path) trace(path, entry);
}

const sameSnapshot = (a: Record<string, string>, b: Record<string, string>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value);

export async function check(host: ReviewHost, run: ExecutionRun, node: TaskNode, given: string, changed: string[], workspace: string | null): Promise<quality.Verdict> {
  let text = given;
  const blocked = quality.blockedClaim(text);
  if (blocked) return quality.verdict({ passed: false, reason: blocked, blocked });
  const ownCheck = uses.ownCheckOnly();
  if (!uses.review() && !(ownCheck && (node.artifact_contract || (node.check && workspace)))) {
    // Nothing is accepted or rejected: a step that finished has passed, unless it says itself that part
    // of its work cannot be done here.
    const claim = quality.unableClaim(text);
    if (claim) return quality.verdict({ passed: false, reason: `无法完成：${claim}`, fix: claim, unable: claim });
    return quality.verdict({ passed: true, reason: "平台未开启验收。" });
  }
  let evidence: ArtifactEvidence | null = null;
  if (node.artifact_contract) {
    let problem: string | null;
    [evidence, problem] = await artifactCheck(host, run, node);
    // A missing audit deliverable says nothing against its already accepted inputs.
    if (problem) return quality.verdict({ passed: false, reason: problem, verified: false, artifact_evidence: evidence });
  } else if (node.check && workspace) {
    // A declared runnable check is evidence, not a suggestion the worker may claim it ran.
    const latest = host.db.getRun(run.id);
    const ws = new agent.Workspace(workspace, { network: Boolean(latest?.allow_network) });
    let output: string;
    let ok: boolean;
    try {
      [output, ok] = await ws.run("Bash", { command: node.check });
    } finally {
      ws.close();
    }
    logAcceptance(host, run, node, { turn: 0, tool: "Acceptance", detail: node.check, ok, output });
    if (!ok) return quality.verdict({ passed: false, reason: `声明的验收命令失败：${node.check}\n${output}`, verified: false });
    text += `\n\nPlatform acceptance evidence: ${node.check}\n${output}`;
  }
  let result: quality.Verdict;
  // Asked again: it may have been switched off while the check ran.
  if (ownCheck || uses.ownCheckOnly()) {
    // Without the review capability its own check, passed above, is all of the acceptance.
    const claim = quality.unableClaim(given);
    result = claim ? quality.verdict({ passed: false, reason: `无法完成：${claim}`, fix: claim, unable: claim })
      : quality.verdict({ passed: true, reason: "步骤自带的检查通过。" });
  } else result = await (await review()).reviewResult(host, run, node, text, changed, workspace, evidence);
  if (evidence) {
    evidence.accepted = result.passed;
    result.artifact_evidence = evidence;
  }
  return result;
}

/** Execute declared acceptance commands in the ordinary task sandbox, keeping evidence. */
export async function artifactCheck(host: ReviewHost, run: ExecutionRun, node: TaskNode): Promise<[ArtifactEvidence, string | null]> {
  const evidence = ArtifactEvidenceSchema.parse({ generation: node.generation, inputs: node.artifact_inputs });
  let outputs: Record<string, string>;
  try {
    outputs = contracts.deliverySnapshot(run, node);
  } catch (error) {
    if (error instanceof contracts.ArtifactBlocked) return [evidence, error.message];
    throw error;
  }
  const latest = host.db.getRun(run.id);
  const ws = new agent.Workspace(contracts.workspace(run, node), { network: Boolean(latest?.allow_network) });
  try {
    for (const command of node.artifact_contract!.acceptance_commands) {
      const [output, ok] = await ws.run("Bash", { command });
      evidence.checks.push({ command, ok, output });
      logAcceptance(host, run, node, { turn: 0, tool: "Acceptance", detail: command, ok, output });
      if (!ok) return [evidence, `产物验收命令失败：${command}\n${output}`];
    }
    if (!sameSnapshot(contracts.deliverySnapshot(run, node), outputs)) return [evidence, "验收期间产物变化，验收证据失效。"];
    evidence.outputs = outputs;
    return [evidence, null];
  } catch (error) {
    if (error instanceof contracts.ArtifactBlocked) return [evidence, error.message];
    throw error;
  } finally {
    ws.close();
  }
}

/** Checks on an attempt of ``node`` by ``modelId`` that runs long: another model says whether it is
 *  stuck. A check that cannot be made lets the attempt go on. */
export function progressWatch(host: ReviewHost, run: ExecutionRun, node: TaskNode, modelId: string): progress.Watch {
  const started = performance.now();
  const asked = [0]; // how many times the lead was asked about this attempt's time
  let missed = 0;
  return async (evidence) => {
    const minutes = (performance.now() - started) / 60_000;
    const prompt = progress.checkPrompt(node, minutes, evidence);
    const checker = await pickReviewer(Object.values(host.modelLookup), host.configured(run), modelId, Math.floor([...prompt].length / 3) + 1000);
    let reason: string | null = null;
    const checked = checker !== null;
    if (checker) {
      const folder = join(settings.workspace_root, folderId(run), ".review");
      mkdirSync(folder, { recursive: true });
      try {
        // Whether an attempt is stuck is a quick call: little thinking needed.
        const reply = await host.complete(run, node, checker.id, prompt, folder, { cli_timeout: 300, allow_api_fallback: false, effort: PROGRESS_EFFORT });
        reason = progress.parse(reply.text);
        missed = 0;
      } catch (error) {
        if (isCancelled(error) || error instanceof BudgetExceeded || error instanceof StepLimitExceeded) throw error;
        // Never deadlock a worker waiting for this progress check.
        if (!(error instanceof StepReservationBusy)) {
          missed += 1;
          if (missed >= 2) reason = "连续两次无法完成进度检查，停止本次尝试并保留记录。";
        }
      }
    }
    // Without a model able to judge this attempt the check cannot be made, which lets it go on: the
    // task's budget and the lead's checks still bound it. Never stop a long attempt that is still
    // producing evidence only because no peer model is available.
    host.emit(run.id, "node.progress_check", { node_id: node.id, model_id: modelId, checker_model_id: checker ? checker.id : null,
      minutes: pyRound(minutes), checked, stop: Boolean(reason), reason });
    return reason || (host.canLead() ? (await lead()).criticalCheck(host, run.id, node, modelId, minutes, evidence, asked) : null);
  };
}

/** For a work package with a lead: [expected turns, a check that asks the lead whether an attempt far
 *  past them should go on]. null for other steps. */
export function overrunCheck(host: ReviewHost, run: ExecutionRun, node: TaskNode, modelId: string): [number, progress.Watch] | null {
  const expected = progress.expectedTurns(node);
  if (!expected || !run.supervisor?.model_id || !host.canLead()) return null;
  const watch: progress.Watch = async (evidence) => {
    const turns = /^\d/.test(evidence) ? Number.parseInt(evidence.split(" ", 1)[0], 10) : 0;
    return (await lead()).overrun(host, run, node, modelId, expected, evidence, turns);
  };
  return [expected, watch];
}
