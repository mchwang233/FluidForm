// Accepting or rejecting a step's result: a verification's own verdict, or a reviewer model
// against the acceptance criteria; and the checks on an attempt that runs long. Python mixes this into
// the executor; here its functions take the executor (ReviewHost).
import { uses } from "./features.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import * as activity from "./activity.js";
import * as agent from "./agent.js";
import { BudgetExceeded, StepLimitExceeded, StepReservationBusy } from "./budget.js";
import { settings } from "./config.js";
import * as contracts from "./contracts.js";
import type { Database } from "./db.js";
import { type ArtifactEvidence, ArtifactEvidenceSchema, type ExecutionRun, folderId, type ModelProfile, type TaskNode } from "./models.js";
import * as progress from "./progress.js";
import { trace, type ProviderResult } from "./providers.js";
import { head, pyRound } from "./py.js";
import * as quality from "./quality.js";
import { ModelUnavailable } from "./quota.js";
import { canAct, loopTurns, pickReviewer } from "./routing.js";
import * as supervisor from "./supervisor.js";
import { isCancelled } from "./tasks.js";

// Reviewers tried in turn when one is out of quota.
export const MAX_BACKUPS = 3;
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
  if (!uses.review()) {
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
  const result = await reviewResult(host, run, node, text, changed, workspace, evidence);
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

const withCost = (error: unknown, cost: number) => {
  if (error && typeof error === "object") (error as Json).accounted_cost_usd = ((error as Json).accounted_cost_usd ?? 0) + cost;
};

/** Accept or reject a result: verification nodes give their own verdict; others are reviewed by another
 *  model against the node's acceptance criteria. A result whose model says part of the task cannot be
 *  done here is not accepted, whatever else it did. */
export async function reviewResult(host: ReviewHost, run: ExecutionRun, node: TaskNode, text: string, changed: string[], workspace: string | null,
  artifactEvidence: ArtifactEvidence | null = null): Promise<quality.Verdict> {
  const claim = quality.unableClaim(text);
  if (claim) return quality.verdict({ passed: false, reason: `无法完成：${claim}`, fix: claim, unable: claim });
  if (node.verifies.length) {
    const found = quality.verificationVerdict(text);
    if (found === null) {
      return quality.verdict({ passed: false, reason: "验证结果没有给出 VERDICT 结论，尚未验证。", fix: "实际执行验证并以 VERDICT: PASS 或 VERDICT: FAIL: 原因结束。", verified: false });
    }
    const [passed, problems] = found;
    return quality.verdict({ passed, reason: passed ? "验证通过。" : `验证发现问题：${problems || "未说明"}`, fix: problems });
  }
  if (!settings.review_nodes) return quality.verdict({ passed: true, reason: "未开启验收。" });
  // An easy step stands on its own result; another model's review costs more time than it saves.
  if (node.difficulty === "easy" && !settings.review_easy_steps) return quality.verdict({ passed: true, reason: "简单步骤，按它自己的结果验收，不另请模型审。" });
  const summarize = [...text].length > settings.handoff_max_chars;
  // Even an attempt with fresh edits can depend on code from earlier attempts. Keep it and the task's
  // explicit references in view, including cited verification logs.
  const references = workspace ? quality.mentionedFiles(workspace, [text, node.result, node.instructions, node.acceptance_criteria, node.feedback]
    .filter(Boolean).join("\n")) : [];
  const evidenceFiles = [...new Set([...changed, ...node.changed_files, ...references])];
  let prompt = quality.reviewPrompt(node, text, changed, workspace ? quality.changeEvidence(workspace, evidenceFiles, { referenced: references }) : "", summarize);
  if (artifactEvidence) prompt += "\nPlatform artifact checks (executed in the task sandbox):\n" + JSON.stringify(artifactEvidence);
  const folder = join(settings.workspace_root, folderId(run), ".review");
  mkdirSync(folder, { recursive: true });
  // A reviewer out of quota leaves routing, so the next pick is a backup.
  const attempted = new Set<string>();
  let reviewCost = 0;
  let payload: Json | null = null;
  let reviewer: ModelProfile | null = null;
  let problem = "没有可用的验收模型，尚未验收。";
  let finished = false;
  for (let round = 0; round < MAX_BACKUPS; round += 1) {
    const configured = new Set([...host.configured(run)].filter((id) => !attempted.has(id)));
    reviewer = await pickReviewer(Object.values(host.modelLookup), configured, node.model_id, Math.floor([...prompt].length / 3) + 1000);
    if (reviewer === null) {
      finished = true;
      break;
    }
    attempted.add(reviewer.id);
    try {
      const reply = await host.complete(run, node, reviewer.id, prompt, folder, { cli_timeout: 300, allow_api_fallback: false,
        review_workspace: canAct(reviewer) ? workspace : null, review_files: references,
        // A harder step's result deserves a harder look.
        effort: settings.reasoning_by_difficulty[node.difficulty] ?? null });
      reviewCost += reply.accounted_cost_usd;
      payload = quality.parseReview(reply.text);
      if (payload !== null) {
        finished = true;
        break;
      }
      problem = "验收回复无法解析，尚未验收。";
    } catch (error) {
      if (isCancelled(error) || error instanceof BudgetExceeded || error instanceof StepLimitExceeded) {
        withCost(error, reviewCost);
        throw error;
      }
      reviewCost += (error as Json)?.accounted_cost_usd ?? 0;
      if (error instanceof ModelUnavailable) continue;
      problem = `验收模型调用失败（${head(String((error as Error)?.message ?? error), 200)}），尚未验收。`;
    }
  }
  // Python's for/else: every backup tried without a parsed reply.
  if (!finished) payload = null;
  if (!attempted.size || reviewer === null || payload === null) {
    return quality.verdict({ passed: false, reason: problem, fix: "重新验收，取得明确的验收结论。", cost_usd: reviewCost, accounted_cost_usd: reviewCost, verified: false });
  }
  const summary = summarize && typeof payload.summary === "string" ? payload.summary : null;
  const unable = typeof payload.unable === "string" && payload.unable.trim() ? payload.unable : null;
  const blocked = typeof payload.blocked === "string" && payload.blocked.trim() ? payload.blocked : null;
  const passed = Boolean(payload.passed) && !unable && !blocked;
  const reason = String(payload.reason || (passed ? "验收通过。" : "验收未通过。"));
  return quality.verdict({ passed, reason: unable ? `无法完成：${unable.trim()}` : reason, fix: String(payload.fix || unable || ""), summary,
    unable: unable ? head(unable.trim(), 1000) : null, reviewer_model_id: reviewer.id, cost_usd: reviewCost, accounted_cost_usd: reviewCost, blocked });
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
    return reason || criticalCheck(host, run.id, node, modelId, minutes, evidence, asked);
  };
}

/** A step others wait for that runs far past its expected time is not stuck, but holds the whole task:
 *  the lead says whether it goes on or stops for a faster model. Asked again after each further stretch
 *  of that length. */
export async function criticalCheck(host: ReviewHost, runId: string, node: TaskNode, modelId: string, minutes: number, evidence: string,
  asked: number[]): Promise<string | null> {
  const expected = loopTurns(node) * settings.minutes_per_turn;
  const due = expected * settings.critical_overrun_factor * (asked[0] + 1);
  const run = host.db.getRun(runId);
  if (!run || minutes < due || !run.supervisor?.model_id || !host.canLead()) return null;
  const below = quality.descendants(run, new Set([node.id]));
  const waiting = run.plan.nodes.filter((item) => below.has(item.id) && item.status === "pending").map((item) => item.title);
  if (!waiting.length) return null;
  asked[0] += 1;
  let reason: string | null;
  try {
    const reply = await host.thinking(runId, "critical_overrun", node.id, () => host.askLead(runId,
      supervisor.criticalOverrunMessage(node, modelId, minutes, expected, waiting, evidence)));
    reason = progress.parse(reply);
  } catch (error) {
    if (isCancelled(error) || error instanceof BudgetExceeded || error instanceof StepLimitExceeded) throw error;
    reason = null; // without an answer the attempt goes on
  }
  host.emit(runId, "node.critical_overrun_check", { node_id: node.id, model_id: modelId, minutes: pyRound(minutes), expected_minutes: pyRound(expected),
    waiting: waiting.length, stop: Boolean(reason), reason });
  return reason ? `${progress.CRITICAL_OVERRUN}${reason}` : null;
}

/** For a work package with a lead: [expected turns, a check that asks the lead whether an attempt far
 *  past them should go on]. null for other steps. */
export function overrunCheck(host: ReviewHost, run: ExecutionRun, node: TaskNode, modelId: string): [number, progress.Watch] | null {
  const expected = progress.expectedTurns(node);
  if (!expected || !run.supervisor?.model_id || !host.canLead()) return null;
  const watch: progress.Watch = async (evidence) => {
    const turns = /^\d/.test(evidence) ? Number.parseInt(evidence.split(" ", 1)[0], 10) : 0;
    let reason: string | null;
    try {
      // The lead's call is not the step's work.
      const reply = await host.thinking(run.id, "overrun", node.id, () => activity.paused(() => host.askLead(run.id,
        supervisor.overrunMessage(node, turns, expected, evidence))));
      reason = progress.parse(reply);
    } catch (error) {
      if (isCancelled(error) || error instanceof BudgetExceeded || error instanceof StepLimitExceeded) throw error;
      reason = null; // without an answer the attempt goes on
    }
    host.emit(run.id, "node.overrun_check", { node_id: node.id, model_id: modelId, turns, expected, stop: Boolean(reason), reason });
    return reason;
  };
  return [expected, watch];
}
