// The validators of models.ts: what a record becomes when it is read.
// ``before`` sees the raw value (Pydantic's mode="before"); ``after`` the parsed record.
import type { z } from "zod";

type Record_ = Record<string, unknown>;
export type Hook = {
  before?: (value: unknown) => unknown;
  after?: (value: Record_, context: z.RefinementCtx) => Record_;
};

/** Scores and thresholds are 0-100; records saved before that used 0-1. */
export function toPercentScale(value: number): number {
  return value > 0 && value <= 1 ? Math.round(value * 1000) / 10 : value;
}

/** Difficulty implied by a bare threshold, for plans saved before difficulty existed. */
export function difficultyFor(threshold: number): string {
  return threshold >= 88 ? "hard" : threshold >= 78 ? "normal" : "easy";
}

const isObject = (value: unknown): value is Record_ =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SCORES = ["coding", "planning", "research", "chinese", "tool_use", "structured_output", "reliability"];

export const hooks: Record<string, Hook> = {
  CapabilityScore: {
    after: (value) => {
      const out = { ...value };
      for (const name of SCORES) out[name] = toPercentScale(out[name] as number);
      return out;
    },
  },
  ToolCall: {
    before: (value) => {
      if (!isObject(value) || "status" in value) return value;
      const status = value.running ? "running" : value.ok === true ? "succeeded" : value.ok === false ? "failed" : "unknown";
      return { ...value, status };
    },
  },
  NodeAttempt: {
    // A persisted attempt has ended even when its last CLI event said "running".
    after: (value) => ({
      ...value,
      tool_calls: (value.tool_calls as Record_[]).map((call) =>
        call.running || call.status === "running"
          ? { ...call, ok: null, running: false, status: "incomplete",
              diagnostic: call.diagnostic || "No completion event was recorded; exit status is unknown." }
          : call),
    }),
  },
  ArtifactContract: {
    after: (value, context) => {
      for (const name of ["acceptance_commands", "blocked_when"]) {
        if ((value[name] as string[]).some((line) => !line.trim())) {
          context.addIssue({ code: "custom", path: [name], message: "contract declarations must not be blank" });
        }
      }
      return value;
    },
  },
  TaskNode: {
    before: (value) => {
      if (isObject(value) && !("difficulty" in value) && "quality_threshold" in value) {
        return { ...value, difficulty: difficultyFor(toPercentScale(Number(value.quality_threshold))) };
      }
      return value;
    },
    after: (value) => ({ ...value, quality_threshold: toPercentScale(value.quality_threshold as number) }),
  },
};
