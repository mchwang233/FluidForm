// The executor's reviewing (Python's review.Reviewing mixin): accepting a step's result and checking
// on long attempts, as review.ts does it, with the executor as its host.
import { ExecutorBase } from "./executor-base.js";
import type { ExecutionRun, TaskNode } from "./models.js";
import type * as progress from "./progress.js";
import type * as quality from "./quality.js";
import * as review from "./review.js";

export abstract class Reviewing extends ExecutorBase {
  checkResult(run: ExecutionRun, node: TaskNode, text: string, changed: string[], workspace: string | null): Promise<quality.Verdict> {
    return review.check(this, run, node, text, changed, workspace);
  }

  progressWatch(run: ExecutionRun, node: TaskNode, modelId: string): progress.Watch {
    return review.progressWatch(this, run, node, modelId);
  }

  overrunCheck(run: ExecutionRun, node: TaskNode, modelId: string): [number, progress.Watch] | null {
    return review.overrunCheck(this, run, node, modelId);
  }
}
