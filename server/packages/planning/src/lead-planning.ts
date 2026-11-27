// What the lead's planning conversations share (task-planning.ts, team.ts): asking once
// more when a reply is not the plan asked for, the plan's short name, and the limits on a plan.
import { ZodError } from "zod";
import { extractJson, type Say } from "./planner.js";
import { head, pySplit, pyStr } from "../../../src/extension-api.js";

// Most tasks one plan has, with what replanning adds (replan.ts, team.ts).
export const MAX_TASKS = 60;
// Said to the lead whenever it plans for a task that allows the internet (planner.WORK_RULES).
// Commands a plan may name to check the task's tools before it runs (TaskPlan.requires).
export const MAX_REQUIRES = 12;
export const MAX_REQUIRE_CHARS = 4000;
// Characters of a plan's short name (TaskPlan.title); a longer one is cut here.
export const MAX_TITLE_CHARS = 24;

/** Python's (ValueError, TypeError, KeyError): a reply that is not what was asked for, asked again. */
export function readProblem(error: unknown): boolean {
  const name = (error as Error)?.name;
  return error instanceof ZodError || error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError
    || name === "ValueError" || name === "ContractError" || name === "KeyError";
}

const why = (error: unknown) => (error instanceof ZodError ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
  : (error as Error).message);

/** Ask, and once more in the same conversation if the reply is not what was asked for. */
export async function ask<T>(say: Say, message: string, read: (payload: any) => T): Promise<T> {
  const reply = await say(message);
  try {
    return read(extractJson(reply));
  } catch (error) {
    if (!readProblem(error)) throw error;
    const again = await say(`That reply was not a valid plan (${why(error)}). Reply with the JSON object described, and nothing else.`);
    return read(extractJson(again));
  }
}

/** The plan's short name as the lead gave it, on one line and bounded; "" if none. */
export function planTitle(payload: Record<string, unknown>): string {
  const text = pySplit(pyStr(payload.title || "")).join(" ");
  return head(text.replace(/[。.!！?？]+$/, ""), MAX_TITLE_CHARS);
}
