// The learning port (docs/design/capability-ports.md). The learning extension (packages/learning/src)
// looks back on finished tasks and names their problems; for the check before a task's first step it
// knows what to check, how the results read and which skill each tool gets. Running the check,
// repairing the environment, writing what it found into the task and asking a model to write a skill
// are FluidForm's (preflighting.ts).
import type { CliChannelRegistry } from "../cli-channels.js";
import * as extensions from "../extensions.js";
import type { LearningHost } from "../learning.js";
import type { ExecutionRun, ModelProfile, PreflightCheck } from "../models.js";
import { available } from "../provided.js";
import type { CompleteOptions, ProviderResult } from "../providers.js";
import type { Completion, Db, Review } from "../retrospect.js";
import type { Skill } from "../skills.js";

/** What preparing a task's skills may ask of FluidForm. */
export interface SkillHost {
  /** Note the task's progress (an event of the task). */
  emit(kind: string, data?: Record<string, unknown>): void;
  /** Whether the task allows the internet now: the user may allow it during the check. */
  allowsNetwork(): boolean;
  /** The tools of ``tools`` the steps' sandbox can run. */
  available(tools: string[]): Promise<string[]>;
  /** A SKILL.md for ``tools``, written by a model trying them in the steps' sandbox; ``general``: a
   *  public skill to start from. */
  writeSkill(name: string, tools: string[], general: Skill | null, signal: AbortSignal): Promise<string>;
}

export interface LearningPort {
  /** Look back on the finished task ``runId`` and keep what it teaches. */
  learn(host: LearningHost, runId: string, signal: AbortSignal): Promise<void>;
  /** Name the problems of the task ``runId`` so that recurring ones are found. */
  nameProblems(db: Db, complete: (modelId: string, prompt: string) => Promise<Completion>, models: ModelProfile[], configured: Set<string>,
    runId: string): Promise<Review | null>;
  /** What a task's checks depend on: checks that passed for the same key a moment ago are not run again. */
  cacheKey(run: ExecutionRun): string;
  /** The checks that passed for ``key`` a moment ago, or null. */
  passedBefore(key: string): PreflightCheck[] | null;
  /** Keep that ``checks`` passed for ``key``. */
  remember(key: string, checks: PreflightCheck[]): void;
  /** The steps' sandbox and the membership CLIs' own sandboxes, with the tools the plan needs. */
  environmentChecks(run: ExecutionRun, workspace: string, cli: Pick<CliChannelRegistry, "sandboxRun"> | null, configured: Set<string>): Promise<PreflightCheck[]>;
  /** A tiny request to each API model the task uses, through ``complete`` (a warning when one does not answer). */
  modelChecks(run: ExecutionRun, complete: (modelId: string, prompt: string, options: CompleteOptions) => Promise<ProviderResult>): Promise<PreflightCheck[]>;
  /** The failed checks that block the task, or with ``blocking`` false the warnings. */
  failures(checks: PreflightCheck[], blocking?: boolean): PreflightCheck[];
  /** Failed checks, as the user and a repair are told them. */
  describe(checks: PreflightCheck[]): string;
  /** What an environment repair is asked for the failed checks; ``tools``: the shared tools folder. */
  repairPrompt(run: ExecutionRun, failed: PreflightCheck[], workspace: string, tools: string): string;
  /** The tools of ``tools`` the steps' sandbox can run. */
  available(run: ExecutionRun, workspace: string, tools: string[]): Promise<string[]>;
  /** This machine's skills for the tools the task needs: the names of those kept or written now. */
  prepareSkills(run: ExecutionRun, workspace: string, checks: PreflightCheck[], host: SkillHost): Promise<string[]>;
  /** What a model writing a skill for ``tools`` is asked. */
  skillPrompt(run: ExecutionRun, name: string, tools: string[], general: Skill | null, checks: PreflightCheck[]): string;
}

const unlearned = (): never => {
  throw new Error("没有启用经验能力。");
};

/** Without the learning capability nothing is looked back on and nothing is checked before a task
 *  starts: FluidForm asks neither (features.ts), so each of these only says why. */
export const base: LearningPort = {
  learn: async () => unlearned(),
  nameProblems: async () => unlearned(),
  cacheKey: unlearned,
  passedBefore: unlearned,
  remember: unlearned,
  environmentChecks: async () => unlearned(),
  modelChecks: async () => unlearned(),
  failures: unlearned,
  describe: unlearned,
  repairPrompt: unlearned,
  available: async () => unlearned(),
  prepareSkills: async () => unlearned(),
  skillPrompt: unlearned,
};

/** Learning as FluidForm asks it now: the learning extension's code while ``name`` is on, else base. */
export async function learning(name: "learning" | "preflight" = "learning"): Promise<LearningPort> {
  return available(name) ? extensions.load<LearningPort>("learning") : base;
}

/** The learning extension's code for a check already under way: switching it off lets that end as it
 *  would have. */
export function begun(): Promise<LearningPort> {
  return extensions.load<LearningPort>("learning");
}
