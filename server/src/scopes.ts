// Steps working in one folder at the same time: those whose files do not overlap run
// together; a step without a scope (planner.packageOf) has the folder to itself.
import type { TaskNode } from "./models.js";
import { writesFiles } from "./planner.js";

export function within(path: string, scope: Iterable<string>): boolean {
  for (const item of scope) if (path === item || path.startsWith(item.replace(/\/+$/, "") + "/")) return true;
  return false;
}

const overlap = (left: Set<string>, right: Set<string>) => {
  for (const a of left) {
    for (const b of right) {
      if (a === b || a.startsWith(b.replace(/\/+$/, "") + "/") || b.startsWith(a.replace(/\/+$/, "") + "/")) return true;
    }
  }
  return false;
};

/** What a step changes and reads; ``everything`` for a step that may touch anything. */
export class Scope {
  readonly everything: boolean;
  readonly writes: Set<string>;
  readonly reads: Set<string>;
  // Files that steps alongside this one own, and those they changed beyond them (told when they leave),
  // so neither is counted as its changes.
  others = new Set<string>();
  left = new Set<string>();
  // Steps that were in the folder at some time while this one was, and the files this one changed (told
  // to the steps still in the folder when it leaves).
  alongside: Scope[] = [];
  changed: string[] = [];

  constructor(files: string[] | null = null, reads: string[] | null = null, readonly title = "") {
    this.everything = files === null && reads === null;
    this.writes = new Set(files ?? []);
    this.reads = new Set(reads ?? []);
  }

  /** Of the files changed in the folder while this step ran, those that are its own. */
  own(changed: string[]): string[] {
    return changed.filter((path) => !within(path, [...this.others, ...this.left]));
  }

  clashes(other: Scope): boolean {
    if (this.everything || other.everything) return true;
    return overlap(this.writes, new Set([...other.writes, ...other.reads])) || overlap(this.reads, other.writes);
  }

  /** Of the files changed in the folder while this step ran, those outside its own that a step alongside
   *  it reads, with that step's title: blamed only when every other step alongside it is such a reader
   *  (one that does not write the file), so no one else can have changed it. What steps that left
   *  reported changing does not clear it: that report may hold this change. */
  intrusions(changed: string[]): [string, string][] {
    if (this.everything) return [];
    const found: [string, string][] = [];
    for (const path of changed) {
      if (within(path, [...this.writes, ...this.others])) continue;
      const readers = this.alongside.filter((other) => within(path, other.reads) && !within(path, other.writes));
      const suspects = this.alongside.filter((other) => !readers.includes(other));
      if (readers.length && !suspects.length) found.push([path, readers[0].title]);
    }
    return found;
  }
}

/** A step's scope: its package's files, else the folders it owns; nothing for a step that writes no
 *  files (a review or summary); everything for one that writes files the planner did not name. */
export function of(node: TaskNode): Scope {
  if (node.artifact_contract) {
    return new Scope([...new Set([...node.files, ...node.artifact_contract.outputs.map((item) => item.path)])],
      [...new Set([...node.reads, ...node.artifact_contract.inputs.map((item) => item.path)])], node.title);
  }
  if (node.files.length || node.reads.length) return new Scope(node.files, node.reads, node.title);
  if (node.folders.length) return new Scope(node.folders, [], node.title);
  return writesFiles(node) ? new Scope(null, null, node.title) : new Scope([], [], node.title);
}

/** Lets steps into one folder while their scopes do not clash with those already in it. */
export class FolderLock {
  readonly held: Scope[] = [];
  private waiters: (() => void)[] = [];

  /** Whether a step with ``scope`` would have to wait for steps already in the folder. */
  busy(scope: Scope): boolean {
    return this.held.some((other) => scope.clashes(other));
  }

  /** ``work`` once ``scope`` may be in the folder; it leaves after. ``signal`` stops the wait. */
  async hold<T>(scope: Scope, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    while (this.busy(scope)) {
      await new Promise<void>((done, fail) => {
        const wake = () => {
          signal?.removeEventListener("abort", stop);
          done();
        };
        const stop = () => {
          this.waiters = this.waiters.filter((item) => item !== wake);
          fail(signal!.reason);
        };
        if (signal?.aborted) return stop();
        signal?.addEventListener("abort", stop, { once: true });
        this.waiters.push(wake);
      });
    }
    for (const other of this.held) {
      for (const path of scope.writes) other.others.add(path);
      for (const path of other.writes) scope.others.add(path);
      other.alongside.push(scope);
      scope.alongside.push(other);
    }
    this.held.push(scope);
    try {
      return await work();
    } finally {
      this.held.splice(this.held.indexOf(scope), 1);
      // What it actually changed, declared or not, is not the changes of those still in.
      for (const other of this.held) for (const path of scope.changed) other.left.add(path);
      const waiting = this.waiters;
      this.waiters = [];
      for (const wake of waiting) wake();
    }
  }
}
