// Background work that can be cancelled (Python's asyncio tasks): a promise, the controller that
// cancels it, and whether it is done. Code inside a task can find its own task (currentTask).
import { ContextVar } from "./py.js";

/** What a cancelled task's work is stopped with (Python's CancelledError). */
export class Cancelled extends Error {
  override name = "AbortError";

  constructor(message = "cancelled") {
    super(message);
  }
}

export const isCancelled = (error: unknown) => (error as Error)?.name === "AbortError";

const running = new ContextVar<Task<unknown> | null>("current_task", null);

/** The task the caller runs in, if any. */
export const currentTask = () => running.get();

export class Task<T> {
  readonly controller = new AbortController();
  readonly promise: Promise<T>;
  done = false;
  result: T | undefined;
  error: unknown;

  constructor(work: (signal: AbortSignal) => Promise<T>) {
    this.promise = running.run(this as Task<unknown>, () => Promise.resolve().then(() => work(this.controller.signal))).then((value) => {
      this.result = value;
      return value;
    }, (error) => {
      this.error = error;
      throw error;
    }).finally(() => {
      this.done = true;
    });
    // A task nobody awaits must not end the process with an unhandled rejection.
    this.promise.catch(() => undefined);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  cancel(message = "cancelled"): void {
    if (!this.done) this.controller.abort(new Cancelled(message));
  }

  /** Waits for the task, whatever its outcome (asyncio.gather(..., return_exceptions=True)). */
  async settled(): Promise<void> {
    await this.promise.catch(() => undefined);
  }
}

/** Throws the abort reason when ``signal`` was aborted. */
export function check(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Cancelled();
}

/** asyncio.Lock: one holder at a time, the others waiting in turn. Not reentrant. */
export class Mutex {
  private held = false;
  private waiting: (() => void)[] = [];

  get locked(): boolean {
    return this.held;
  }

  async run<T>(work: () => T | Promise<T>): Promise<T> {
    while (this.held) await new Promise<void>((done) => this.waiting.push(done));
    this.held = true;
    try {
      return await work();
    } finally {
      this.held = false;
      this.waiting.shift()?.();
    }
  }
}

/** Waits for the first of ``tasks`` to end (asyncio.wait FIRST_COMPLETED); none: returns at once. */
export async function first(tasks: Iterable<Task<unknown>>): Promise<void> {
  const all = [...tasks];
  if (!all.length) return;
  await Promise.race(all.map((task) => task.settled()));
}

/** Sleeps ``seconds``, or stops with the abort reason of ``signal``. */
export function sleep(seconds: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((done, fail) => {
    if (signal?.aborted) return fail(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      done();
    }, seconds * 1000);
    const stop = () => {
      clearTimeout(timer);
      fail(signal!.reason);
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
}
