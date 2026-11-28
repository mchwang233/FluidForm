// Acceptance of a step's result: a verification's own verdict, or another model's against the criteria.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type ArtifactEvidence, BudgetExceeded, canAct, type ExecutionRun, folderId, head, isCancelled, type ModelProfile, ModelUnavailable,
  pickReviewer, quality, type LeadHost, settings, StepLimitExceeded, type TaskNode
} from "../../../src/extension-api.js";

type Json = Record<string, any>;
// Reviewers tried in turn when one is out of quota.
export const MAX_BACKUPS = 3;

const withCost = (error: unknown, cost: number) => {
  if (error && typeof error === "object") (error as Json).accounted_cost_usd = ((error as Json).accounted_cost_usd ?? 0) + cost;
};

/** Accept or reject a result: verification nodes give their own verdict; others are reviewed by another
 *  model against the node's acceptance criteria. A result whose model says part of the task cannot be
 *  done here is not accepted, whatever else it did. */
export async function reviewResult(host: LeadHost, run: ExecutionRun, node: TaskNode, text: string, changed: string[], workspace: string | null,
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
