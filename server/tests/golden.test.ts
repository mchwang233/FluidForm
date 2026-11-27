// Inputs and what the Python backend gave for them, recorded before it was removed (tests/golden/*.json):
// the TS modules must still give the same. A behaviour changed on purpose is recorded again with
// GOLDEN_UPDATE=1 (the diff of tests/golden/ shows what changed).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join as joinPath, relative as relativePath } from "node:path";
import * as contracts from "../src/contracts.js";
import * as quality from "../src/quality.js";
import * as capabilities from "../src/capabilities.js";
import * as skills from "../src/skills.js";
import * as team from "../src/team.js";
import * as quota from "../src/quota.js";
import * as environment from "../src/environment.js";
import { CapabilitySchema } from "../src/models.js";
import { ArtifactSchema, TaskPlanSchema } from "../src/models.js";
import { test } from "node:test";
import { builtinModels } from "../src/catalog.js";
import * as chatActions from "../src/chat-actions.js";
import * as conversation from "../src/conversation.js";
import { slug } from "../src/folders.js";
import { ModelProfileSchema, TaskNodeSchema } from "../src/models.js";
import { formatG, pyDumps, pyRegex, pyRound, shlexQuote, shlexSplit } from "../src/py.js";
import { remembering } from "./helpers/chat-package.js";
import { expectedCost, feedbackKey, note } from "../src/routing-feedback.js";
import { applyAaScores } from "../src/scoring.js";
import { inputBound, retryAfter } from "../src/call-control.js";
import { settings } from "../src/config.js";
import * as diagnosis from "../src/diagnosis.js";
import * as diagnosisPackage from "../packages/engineer/src/prompts.js";
import { ExecutionRunSchema } from "../src/models.js";
import * as progress from "../src/progress.js";
import * as recovery from "../src/recovery.js";
import * as pricing from "../src/pricing.js";
import * as routing from "../src/routing.js";
import { readKind } from "../src/triage.js";

type Case = { call: string; args: any[]; kwargs: Record<string, unknown>; result?: unknown; error?: string; after: unknown[] };

const load = (name: string): Case[] => JSON.parse(readFileSync(new URL(`./golden/${name}.json`, import.meta.url), "utf8"));
const plain = (value: unknown) => JSON.parse(JSON.stringify(value ?? null));

/** Equal, numbers within a rounding error (Python and JS add up floats in the same order, but a
 *  mean can still differ in its last bit). */
function same(got: unknown, want: unknown, path = ""): string | null {
  if (typeof got === "number" && typeof want === "number") {
    return Math.abs(got - want) <= 1e-9 * Math.max(1, Math.abs(want)) ? null : `${path}: ${got} != ${want}`;
  }
  if (Array.isArray(got) && Array.isArray(want)) {
    if (got.length !== want.length) return `${path}: length ${got.length} != ${want.length}`;
    for (let index = 0; index < got.length; index += 1) {
      const found = same(got[index], want[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (got && want && typeof got === "object" && typeof want === "object") {
    const keys = new Set([...Object.keys(got), ...Object.keys(want)]);
    for (const key of keys) {
      const found = same((got as any)[key], (want as any)[key], `${path}.${key}`);
      if (found) return found;
    }
    return null;
  }
  return got === want ? null : `${path}: ${JSON.stringify(got)?.slice(0, 200)} != ${JSON.stringify(want)?.slice(0, 200)}`;
}

function holder(saved: any, archiveId = 0) {
  return new conversation.Conversation({ modelId: saved.model_id ?? null, state: structuredClone(saved.state ?? null),
    archive: () => archiveId, recall: (id) => (id === 3 ? saved : null) });
}

const existsSyncSafe = (path: string) => {
  try {
    readdirSync(path);
    return true;
  } catch {
    try {
      readFileSync(path);
      return true;
    } catch {
      return false;
    }
  }
};
const readdirSyncSorted = (path: string) => readdirSync(path).sort();

// The workspace the file checks run on, built as the recorded cases had it.
const TREE: [string, string, string, number][] = [
  ["file", "src/a.py", "print('a')\n", 1700000000], ["file", "src/b.v", "module b; endmodule\n", 1700000001],
  ["file", "src/中文.txt", "中文内容\n".repeat(50), 1700000002], ["file", "build/out.log", "PASS all\n".repeat(30), 1700000003],
  ["file", "build/obj.o", "\u0000bin", 1700000004], ["file", ".hidden/h.log", "hidden\n", 1700000005],
  ["file", ".env", "KEY=1", 1700000006], ["file", "credentials.json", "{}", 1700000007], ["file", "notes.md", "# notes\n".repeat(400), 1700000008],
  ["file", "logs/run.log", "line\n".repeat(5000) + "TEST PASSED\n", 1700000009], ["file", "bin.dat", "ab\u0000cd", 1700000010],
  ["file", "empty.txt", "", 1700000011], ["file", "art/run.vdb/snps/data.db", "x".repeat(3000), 1700000012],
  ["file", "art/run.vdb/snps/meta.txt", "meta", 1700000013], ["link", "art/run.vdb/shared", "snps/meta.txt", 0],
  ["file", "art/report.txt", "Coverage 91%\n", 1700000014], ["file", "art/ucli.key", "run 100ns\n", 1700000015],
  ["file", "art/real.key", "-----BEGIN RSA PRIVATE KEY-----\n", 1700000016], ["file", "art/a-b/c.txt", "c", 1700000017],
  ["file", "art/a/b.txt", "b", 1700000018], ["link", "link_in.py", "src/a.py", 0], ["link", "link_out", "/etc/hostname", 0],
  ["file", "node_modules/m/i.js", "x", 1700000019], ["file", "deep/.git/config", "[core]", 1700000020],
  ["file", "deep/token.json", "{}", 1700000021], ["file", "deep/.ssh/id_rsa", "k", 1700000022], ["file", "deep/ok.txt", "ok", 1700000023],
    ["file", "ord/a-b/c.txt", "c", 1700000024], ["file", "ord/a/b.txt", "b", 1700000025], ["file", "ord/a.txt", "t", 1700000026],
];
let treeRoot = "";
function tree(): string {
  if (treeRoot) return treeRoot;
  treeRoot = mkdtempSync(joinPath(tmpdir(), "golden-tree-"));
  for (const [kind, name, content, mtime] of TREE) {
    const path = joinPath(treeRoot, name);
    mkdirSync(dirname(path), { recursive: true });
    if (kind === "link") symlinkSync(content, path);
    else {
      writeFileSync(path, content);
      utimesSync(path, mtime, mtime);
    }
  }
  return treeRoot;
}
/** "<root>" in a case is this run's tree. */
const rooted = (value: unknown): any => JSON.parse(JSON.stringify(value).replaceAll("<root>", tree()));
const unrooted = (value: unknown): any => JSON.parse(JSON.stringify(value ?? null).replaceAll(tree(), "<root>"));

// The data folder of the prompt cases ("<data>"): fresh, so no skill or tool of this machine shows.
let dataFolder = "";
function data(): string {
  if (!dataFolder) {
    dataFolder = mkdtempSync(joinPath(tmpdir(), "golden-data-"));
    settings.data_dir = dataFolder;
  }
  return dataFolder;
}
const withData = (value: unknown): any => JSON.parse(JSON.stringify(value ?? null).replaceAll(data(), "<data>"));
const runOf = (payload: unknown) => ExecutionRunSchema.parse(payload);
const nodeOf = (run: any, id: string) => run.plan.nodes.find((node: any) => node.id === id);
const relativeToData = (path: string) => relativePath(data(), path);

const CALLS: Record<string, (c: Case) => { result: unknown; after: unknown[] } | Promise<{ result: unknown; after: unknown[] }>> = {
  "quality.node_prompt": (c) => {
    data();
    const run = runOf(c.args[0]);
    const [text, inputs] = quality.nodePrompt(nodeOf(run, c.args[1]), run, c.args[2]);
    return { result: withData([text, inputs]), after: [] };
  },
  "quality.continue_prompt": (c) => {
    data();
    const run = runOf(c.args[0]);
    return { result: withData(quality.continuePrompt(nodeOf(run, c.args[1]), run)), after: [] };
  },
  "quality.head_start_prompt": (c) => {
    data();
    const run = runOf(c.args[0]);
    return { result: withData(quality.headStartPrompt(nodeOf(run, c.args[1]), run, 500)), after: [] };
  },
  "quality.review_prompt": (c) => {
    const run = runOf(c.args[0]);
    return { result: quality.reviewPrompt(nodeOf(run, c.args[1]), "做好了", ["a.sv", "b.sv"], c.args[2] ? "diff here" : "", c.args[2]), after: [] };
  },
  "team.context": (c) => {
    const run = runOf(c.args[0]);
    return { result: team.context(nodeOf(run, c.args[1]), run), after: [] };
  },
  "quality.descendants": (c) => ({ result: [...quality.descendants(runOf(c.args[0]), new Set(c.args[1]))].sort(), after: [] }),
  "quality.cli_environment": (c) => ({ result: quality.cliEnvironment(c.args[0], c.args[1]), after: c.args }),
  "quality.parse_review": (c) => ({ result: quality.parseReview(c.args[0]), after: c.args }),
  "quality.unable_claim": (c) => ({ result: quality.unableClaim(c.args[0]), after: c.args }),
  "quality.blocked_claim": (c) => ({ result: quality.blockedClaim(c.args[0]), after: c.args }),
  "quality.verification_verdict": (c) => ({ result: quality.verificationVerdict(c.args[0]), after: c.args }),
  "quality.rework_feedback": (c) => ({ result: quality.reworkFeedback(c.args[0]), after: c.args }),
  "quality.retry_feedback": (c) => ({ result: quality.retryFeedback(c.args[0], c.args[1]), after: c.args }),
  "quality._excerpt": (c) => ({ result: quality.excerpt(c.args[0], c.args[1]), after: c.args }),
  "team.compact_context": (c) => ({ result: team.compactContext(c.args[0], c.args[1]), after: c.args }),
  "team.digest": (c) => ({ result: team.digest(c.args[0]), after: [] }),
  "team.parse_delegation": (c) => ({ result: team.parseDelegation(c.args[0]), after: c.args }),
  "skills.library": () => {
    data();
    return { result: skills.library().map((skill) => [skill.name, skill.tools, skill.machine, skill.body.length]), after: [] };
  },
  "skills.for_step": (c) => ({ result: skills.forStep(c.args[0]).map((skill) => skill.name), after: [] }),
  "skills.section": (c) => ({ result: skills.section(skills.forStep(c.args[0])), after: [] }),
  "skills.parse": (c) => {
    const parsed = skills.parse(c.args[0]);
    return { result: parsed && [parsed.name, parsed.description, parsed.tools, parsed.summary, parsed.body], after: [] };
  },
  "skills.lessons": () => {
    data();
    skills.saveMachine("VCS tool", "---\nname: vcs-here\ndescription: d\ntools: [vcs]\n---\n# vcs-here\n正文\n");
    const actions: unknown[][] = [["add", "l1", "第一课", "---\nname: n\ndescription: d\n---\n先 source 环境", ["vcs"]],
      ["add", "l2", "第二课", "直接正文".repeat(500), ["vcs"]], ["add", "l1", "第一课改", "改过", ["vcs"]],
      ["add", "l3", "新工具", "x", ["urg"]], ["remove", "l1"], ["remove", "l2"], ["remove", "l3"], ["remove", "none"]];
    const steps = actions.map((action) => {
      const paths = action[0] === "add" ? skills.addLesson(action[1] as string, action[2] as string, action[3] as string, action[4] as string[])
        : skills.removeLesson(action[1] as string);
      const root = joinPath(data(), "skills");
      const files = Object.fromEntries((existsSyncSafe(root) ? readdirSyncSorted(root) : []).map((folder) => joinPath(root, folder, "SKILL.md"))
        .filter((path) => existsSyncSafe(path)).map((path) => [relativeToData(path), readFileSync(path, "utf8")]));
      return [action, paths.map(relativeToData).sort(), files];
    });
    return { result: steps, after: [] };
  },
  "capabilities.read_cards": (c) => ({ result: capabilities.readCards(c.args[0]), after: [] }),
  "capabilities.manual": (c) => ({ result: capabilities.manual(CapabilitySchema.parse(c.args[0])), after: [] }),
  "capabilities.section": (c) => {
    data();
    return { result: withData(capabilities.section(c.args[0].map((item: unknown) => CapabilitySchema.parse(item)))), after: [] };
  },
  "quota.reset_time": (c) => ({ result: quota.resetTime(c.args[0], new Date((c as any).now * 1000)).getTime() / 1000, after: [] }),
  "quota.kind": (c) => ({ result: [quota.isQuotaError(c.args[0]), quota.failureKind(c.args[0])], after: [] }),
  "quota.signature": (c) => ({ result: quota.signature(c.args[0]), after: [] }),
  "environment.state": (c) => {
    const folder = mkdtempSync(joinPath(tmpdir(), "golden-env-"));
    const saved = { data_dir: settings.data_dir, sandbox_profiles: settings.sandbox_profiles, sandbox_host_ports: settings.sandbox_host_ports };
    Object.assign(settings, { data_dir: folder, sandbox_profiles: ["/opt/eda/setup.sh", "it's here.sh", " "], sandbox_host_ports: [27000] });
    try {
      mkdirSync(joinPath(folder, "tools"), { recursive: true });
      if (c.args[0] !== null) writeFileSync(joinPath(folder, "tools", "sandbox.json"), c.args[0]);
      const sandbox = c.args[0] && c.args[0].startsWith('{"') ? JSON.parse(c.args[0]) : {};
      const listed = [...new Set([...settings.sandbox_host_ports, ...((sandbox.host_ports ?? []) as unknown[])
        .filter((port): port is number => Number.isInteger(port) && (port as number) > 0 && (port as number) < 65536)])].sort((a, b) => a - b);
      const result = { env: environment.recordedEnv(), profiles: environment.profiles(), setup: environment.shellSetup(),
        command_env: environment.commandEnv({ PATH: "/usr/bin", HOME: "/h" }), command_env_empty: environment.commandEnv({}), listed_ports: listed };
      return { result: JSON.parse(JSON.stringify(result).replaceAll(folder, "<data>")), after: [] };
    } finally {
      Object.assign(settings, saved);
    }
  },
  "quality.review_path": (c) => {
    const [name, allow] = rooted(c.args);
    const found = quality.reviewPath(tree(), name, { allowHiddenLog: allow });
    return { result: found === null ? null : relativePath(tree(), found) || ".", after: [] };
  },
  "quality.file_text": (c) => ({ result: quality.fileText(tree(), c.args[0], c.args[1], { allowHiddenLog: c.args[2] }), after: [] }),
  "quality.mentioned_files": (c) => ({ result: quality.mentionedFiles(tree(), rooted(c.args)[0]), after: [] }),
  "quality.workspace_listing": () => ({ result: quality.workspaceListing(tree()), after: [] }),
  "quality.change_evidence": (c) => ({ result: quality.changeEvidence(tree(), c.args[0], { referenced: c.args[1] }), after: [] }),
  "quality.private_paths": () => {
    const [folders, files] = quality.privatePaths(tree());
    return { result: [folders.map((path) => relativePath(tree(), path)).sort(), files.map((path) => relativePath(tree(), path)).sort()], after: [] };
  },
  "quality.file_state": () => ({ result: [...quality.fileState(tree()).keys()].sort(), after: [] }),
  "quality.private": (c) => ({ result: quality.isPrivate(c.args[0]), after: c.args }),
  "contracts.fingerprint": (c) => {
    try {
      return { result: contracts.fingerprint(tree(), ArtifactSchema.parse({ path: c.args[0], kind: c.args[1] })), after: [] };
    } catch (error) {
      if (!(error instanceof contracts.ArtifactBlocked)) throw error;
      return { result: unrooted({ blocked: error.message }), after: [] };
    }
  },
  "contracts.safe_name": (c) => ({ result: contracts.safeName(c.args[0]), after: c.args }),
  "contracts.scripts": (c) => ({ result: [...contracts.scripts(c.args[0])].sort(), after: [] }),
  "contracts.plan": (c) => {
    const plan = TaskPlanSchema.parse(c.args[0]);
    return { result: {
      stages: plan.nodes.map((node) => [...contracts.stages(node)].sort()),
      node_problems: plan.nodes.map((node) => contracts.nodeProblems(node)),
      plan_problems: contracts.planProblems(plan), partial: contracts.planProblems(plan, { partial: true }),
      unwritten: contracts.unwrittenScripts(plan), unwritten_some: contracts.unwrittenScripts(plan, (name) => name === "run.sh"),
      prompts: plan.nodes.map((node) => contracts.prompt(node)),
    }, after: [] };
  },
  "contracts.declarations": (c) => ({ result: contracts.declarations(c.args[0]), after: [] }),
  "conversation.flush": (c) => {
    const args = structuredClone(c.args);
    return { result: conversation.flush(args[0]) ?? null, after: args };
  },
  "conversation.reopen": (c) => {
    const args = structuredClone(c.args);
    return { result: conversation.reopen(args[0], args[1]) ?? null, after: args };
  },
  "conversation.user_message": (c) => ({ result: conversation.userMessage(c.args[0], c.args[1]), after: c.args }),
  "conversation.parse_summary": (c) => ({ result: conversation.parseSummary(c.args[0]), after: c.args }),
  "conversation.recall": (c) => ({ result: conversation.recall(holder(c.args[0]), c.args[1]), after: [] }),
  "conversation.handoff": (c) => ({ result: conversation.handoff(holder(c.args[0], c.args[1])), after: [] }),
  "conversation.dump": (c) => ({ result: holder(c.args[0]).dump(), after: [] }),
  "conversation.size": (c) => ({ result: holder(c.args[0]).size(), after: [] }),
  "chat_actions.session": (c) => {
    const [tools, calls] = c.args as [string[] | null, [string, Record<string, unknown>][]];
    const lines: string[] = [];
    // The chat package's tools, as FluidForm asks for them.
    return chatActions.pending.run(tools === null ? null : [lines, new Set(tools)], async () => {
      const offered = (await chatActions.offered()).map((tool) => tool.name);
      const results: [string, boolean][] = [];
      for (const [name, args] of calls) results.push(await chatActions.run(name, args));
      return { result: { offered, results, lines }, after: [] };
    });
  },
  "chat_actions.with_actions": (c) => ({ result: chatActions.withActions(c.args[0], c.args[1]), after: c.args }),
  "py.round": (c) => ({ result: pyRound(c.args[0], c.args[1]), after: [] }),
  "py.format_g": (c) => ({ result: formatG(c.args[0]), after: [] }),
  "py.shlex_quote": (c) => ({ result: shlexQuote(c.args[0]), after: [] }),
  "py.shlex_split": (c) => ({ result: shlexSplit(c.args[0], c.args[1]), after: [] }),
  "py.dumps": (c) => ({ result: pyDumps(c.args[0], c.args[1]), after: [] }),
  "py.regex": (c) => {
    const [pattern, flags, text] = c.args;
    const all = pyRegex(pattern, `${flags}g`);
    const found = [...text.matchAll(all)].map((match: RegExpMatchArray) => [...match].map((group) => group ?? null));
    return { result: { found, sub: text.replace(pyRegex(pattern, `${flags}g`), "<>") }, after: [] };
  },
  "remembering.split": (c) => ({ result: remembering.split(c.args[0]), after: c.args }),
  "remembering.apply": (c) => ({ result: remembering.apply(c.args[0], c.args[1], c.args[2]), after: c.args }),
  "remembering.told": (c) => ({ result: remembering.told(c.args[0]), after: c.args }),
  "scoring.apply_aa_scores": (c) => {
    const [before, matches, rows] = c.args;
    const models = Object.fromEntries(Object.entries(before).map(([id, model]) => [id, ModelProfileSchema.parse(model)]));
    const changed = applyAaScores(models, new Map(Object.entries(matches)) as any, rows);
    return { result: { changed: changed.map((model) => model.id), models }, after: [] };
  },
  "routing_feedback.expected": (c) => {
    const [stats, base] = c.args;
    const node = TaskNodeSchema.parse({ id: "n", title: "t", instructions: "i", capability: "coding", difficulty: "hard" });
    const feedback = new Map(stats ? [[feedbackKey("m", "coding", "hard"), stats]] : []);
    return { result: [expectedCost(node, { id: "m" }, base, feedback), note(node, { id: "m" }, feedback)], after: [] };
  },
  "folders.slug": (c) => ({ result: slug(c.args[0], c.args[1]), after: c.args }),
  "routing.scenario": async (c) => {
    const [payload, raw, configuredIds, vision, preferApi] = c.args;
    settings.subtasks_prefer_api = preferApi;
    const models = payload.map((model: unknown) => ModelProfileSchema.parse(model));
    const configured = new Set<string>(configuredIds);
    const node = () => TaskNodeSchema.parse(raw);
    const result: Record<string, unknown> = {};
    const attempt = async (work: () => unknown) => {
      try {
        return await work();
      } catch (error) {
        if (error instanceof routing.NoEligibleModelError) return ["error", error.message];
        throw error;
      }
    };
    result.route = await attempt(async () => {
      const routed = (await routing.routeNode(node(), models, configured, vision));
      return [routed.model_id, routed.estimated_cost_usd, routed.routing_note];
    });
    result.strongest = (await routing.strongestFor(node(), models, configured, vision))?.id ?? null;
    result.stronger = (await routing.strongerThan(node(), models, configured, "deepseek:flash", vision, new Set(["glm:glm-5.3"])))?.id ?? null;
    result.spread = (await routing.spreadTo(TaskNodeSchema.parse({ ...raw, model_id: "deepseek:flash" }), models, configured, new Set(["glm"]), vision))?.id ?? null;
    const fit = node();
    result.fit = await attempt(async () => [(await routing.fitAndRoute(fit, models, configured, vision)), fit.quality_threshold, fit.model_id]);
    result.eligible = routing.eligibleForNode(node(), models, configured, vision).map((model) => model.id);
    result.costs = Object.fromEntries(await Promise.all(models.map(async (model: any) => [model.id, await routing.nodeCost(node(), model)])));
    const failing = TaskNodeSchema.parse({ ...raw, attempts: [{ outcome: "rejected", model_id: "glm:glm-5.3" }, { outcome: "error", model_id: "glm:glm-5.3" }] });
    result.retry = (await recovery.retryModel(failing, models, configured, vision))?.id ?? null;
    settings.subtasks_prefer_api = true;
    return { result, after: [] };
  },
  "routing.pickers": async (c) => {
    const [payload, configuredIds, preferApi] = c.args;
    settings.subtasks_prefer_api = preferApi;
    const models = payload.map((model: unknown) => ModelProfileSchema.parse(model));
    const configured = new Set<string>(configuredIds);
    const result = { reviewer: (await routing.pickReviewer(models, configured, "deepseek:flash", 9000))?.id ?? null,
      writer: (await routing.briefWriter(models, configured))?.id ?? null,
      diagnosers: routing.diagnosers(models, configured).map((model) => model.id),
      engineers: routing.engineers(models, configured).map((model) => model.id) };
    settings.subtasks_prefer_api = true;
    return { result, after: [] };
  },
  // Now the pricing package's (packages/pricing), asked as FluidForm asks it.
  "routing.estimate": async (c) => ({ result: await pricing.estimate(c.args[0].map((node: unknown) => TaskNodeSchema.parse(node)), c.args[1], c.args[2], c.args[3]), after: [] }),
  "recovery.turns_for": (c) => {
    settings.api_agent_max_turns = c.args[0];
    const result = recovery.turnsFor(TaskNodeSchema.parse({ id: "n", title: "t", instructions: "i", capability: "coding", difficulty: c.args[1] }));
    settings.api_agent_max_turns = 0;
    return { result, after: [] };
  },
  "recovery.failures": (c) => {
    const node = TaskNodeSchema.parse(c.args[0]);
    return { result: [recovery.recentFailures(node).map((attempt) => attempt.outcome), [...recovery.failedModels(node)].sort()], after: [] };
  },
  "recovery.after_diagnosis": (c) => ({ result: recovery.afterDiagnosis(c.args[0], c.args[1], { hasModel: c.args[2], environmentFixes: c.args[3] }), after: [] }),
  "progress.parse": (c) => ({ result: progress.parse(c.args[0]), after: c.args }),
  "progress.api_evidence": (c) => ({ result: progress.apiEvidence(c.args[0], c.args[1]), after: c.args }),
  "progress._log_lines": (c) => ({ result: progress.logLines(c.args[0]), after: c.args }),
  "progress._size": (c) => ({ result: progress.size(c.args[0]), after: c.args }),
  "progress._ago": (c) => ({ result: progress.ago(c.args[0]), after: c.args }),
  "progress._clip": (c) => ({ result: progress.clip(c.args[0]), after: c.args }),
  "progress._process_rows": (c) => ({ result: Object.fromEntries([...progress.processRows(c.args[0])].map(([pid, row]) => [String(pid), row])), after: [] }),
  "progress.check_prompt": (c) => ({ result: progress.checkPrompt(TaskNodeSchema.parse(c.args[0]), c.args[1], c.args[2]), after: [] }),
  "progress.expected_turns": (c) => ({ result: progress.expectedTurns(TaskNodeSchema.parse(c.args[0])), after: [] }),
  "progress.limit_reason": (c) => ({ result: progress.limitReason(TaskNodeSchema.parse(c.args[0])), after: [] }),
  "diagnosis.parse": (c) => ({ result: diagnosis.parse(c.args[0]), after: c.args }),
  "diagnosis.user_action": (c) => ({ result: diagnosis.userAction(c.args[0]), after: c.args }),
  "diagnosis.interaction": (c) => ({ result: diagnosis.interaction(c.args[0]), after: c.args }),
  "diagnosis.prompt": (c) => ({ result: diagnosisPackage.prompt(ExecutionRunSchema.parse(c.args[0]), c.args[1], c.args[2], c.args[3], c.args[4]), after: [] }),
  "diagnosis.repair_prompt": (c) => {
    const run = ExecutionRunSchema.parse(c.args[0]);
    const node = run.plan.nodes.find((item) => item.id === c.args[1])!;
    return { result: diagnosisPackage.repairPrompt(run, node, c.args[2], c.args[3], c.args[4], c.args[5], c.args[6], c.args[7], c.args[8], c.args[9]), after: [] };
  },
  "triage.read_kind": (c) => ({ result: readKind(c.args[0]), after: [] }),
  "call_control.retry_after": (c) => ({ result: retryAfter(c.args[0], c.args[1]), after: [] }),
  "call_control.input_bound": (c) => ({ result: inputBound(c.args[0]), after: [] }),
  // The seed is FluidForm's own models and its packages' (builtinModels): the same models, in the order
  // the Python backend listed them, less those it never had.
  "catalog.builtin_models": () => {
    const order = (load("catalog")[0].result as { id: string }[]).map((model) => model.id);
    return { result: builtinModels().filter((model) => order.includes(model.id))
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)).map(({ effective_at, discovered_at, ...rest }) => rest), after: [] };
  },
};

/** The recorded file with each changed result put in place as text, so the rest stays as Python
 *  wrote it (its floats, 65.0, are not rewritten as 65). */
function record(file: string, changes: [unknown, unknown][]): void {
  const path = new URL(`./golden/${file}.json`, import.meta.url);
  let text = readFileSync(path, "utf8");
  for (const [before, after] of changes) {
    const old = JSON.stringify(before, null, 1).replaceAll("\n", "\n  ");
    assert.ok(text.includes(old), `cannot find a recorded result of ${file} to replace; record it by hand`);
    text = text.replace(old, JSON.stringify(after, null, 1).replaceAll("\n", "\n  "));
  }
  writeFileSync(path, text);
}

for (const file of ["conversation", "chat_actions", "py", "remembering", "scoring", "routing_feedback", "folders",
  "catalog", "routing", "recovery", "progress", "diagnosis", "triage", "files", "contracts", "prompts", "quota", "environment"]) {
  test(`${file}: the same as the Python backend`, async () => {
    const cases = load(file);
    const changes: [unknown, unknown][] = [];
    assert.ok(cases.length > 0);
    for (const [index, c] of cases.entries()) {
      const run = CALLS[c.call];
      assert.ok(run, `no TS call for ${c.call}`);
      const label = `${c.call} #${index} ${JSON.stringify(c.args).slice(0, 120)}`;
      if (c.error) {
        await assert.rejects(async () => run(c), undefined, label);
        continue;
      }
      const got = await run(c);
      const wrong = same(plain(got.result), plain(c.result));
      // A behaviour changed on purpose: GOLDEN_UPDATE=1 records what the TS modules give now.
      if (wrong && process.env.GOLDEN_UPDATE === "1") {
        changes.push([plain(c.result), plain(got.result)]);
        continue;
      }
      assert.equal(wrong, null, `${label}: ${wrong}`);
      if (c.after.length) assert.equal(same(plain(got.after), plain(c.after)), null, `${label} (arguments after)`);
    }
    if (changes.length) record(file, changes);
  });
}
