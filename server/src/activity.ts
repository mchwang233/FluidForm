// What a step is doing while it runs, for its page. An API model's tool calls
// already go into the executor's tool log as it makes them; a CLI's commands, file changes and
// messages are added to the same log as it prints them (only Codex prints them as it goes). The
// log becomes the attempt's tool calls when it ends, so a CLI attempt keeps them too.
import { ContextVar, head, isObject, pyStr, tail } from "./py.js";

export type LogEntry = Record<string, unknown>;

// The tool log of the step whose model runs in this context; null outside a step's own work.
export const current = new ContextVar<LogEntry[] | null>("step_activity", null);
export const MAX_OUTPUT = 2000;
export const MAX_DETAIL = 400;

export function recording<R>(log: LogEntry[], work: () => R): R {
  return current.run(log, work);
}

/** Calls made on the step's behalf (a progress check) are not the step's own work. */
export function paused<R>(work: () => R): R {
  return current.run(null, work);
}

const text = (value: unknown) => pyStr(value || "");

/** A tool log entry for one Codex JSON event; null for events that show no work. */
export function codexEntry(event: Record<string, unknown>): LogEntry | null {
  const item = isObject(event.item) ? event.item : null;
  if (!item || !["item.started", "item.updated", "item.completed"].includes(event.type as string)) return null;
  const kind = item.type;
  const done = event.type === "item.completed";
  const entry: LogEntry = { turn: 0, id: item.id ?? null };
  if (kind === "command_execution") {
    const code = item.exit_code ?? null;
    const status = item.status;
    const ok = status === "failed" || (code !== null && code !== 0) ? false : done && code === 0 ? true : null;
    const state = ok === false ? "failed" : ok === true ? "succeeded"
      : status === "cancelled" || status === "interrupted" ? "incomplete" : done ? "unknown" : "running";
    Object.assign(entry, { tool: "command", detail: head(text(item.command), MAX_DETAIL), ok, running: state === "running",
      status: state, exit_code: code, output: tail(text(item.aggregated_output), MAX_OUTPUT) });
  } else if (kind === "file_change" && done) {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const ok = ({ completed: true, failed: false } as Record<string, boolean>)[item.status as string] ?? null;
    Object.assign(entry, { tool: "file_change", ok, detail: head(changes.filter(isObject)
      .map((change) => `${pyStr(change.kind ?? "")} ${pyStr(change.path ?? "")}`.trim()).join("、"), MAX_DETAIL) });
  } else if (kind === "agent_message" && done) {
    Object.assign(entry, { tool: "message", detail: head(text(item.text), MAX_DETAIL), ok: true });
  } else if (kind === "todo_list") {
    const todos = (Array.isArray(item.items) ? item.items : []).filter(isObject);
    Object.assign(entry, { tool: "plan", ok: true, detail: head(todos
      .map((todo) => (todo.completed ? "✓ " : "") + text(todo.text)).join("；"), MAX_DETAIL) });
  } else return null;
  return entry;
}

/** One line a CLI printed, for the step running in this context (if any). */
export function noteLine(line: string | Buffer): void {
  const log = current.get();
  const textLine = typeof line === "string" ? line : line.toString("utf8");
  if (log === null || !textLine.trim()) return;
  let event: unknown;
  try {
    event = JSON.parse(textLine);
  } catch {
    return;
  }
  const entry = isObject(event) ? codexEntry(event) : null;
  if (!entry) return;
  if (entry.id) {
    for (let index = log.length - 1; index >= 0; index -= 1) {
      if (log[index].id === entry.id) {
        log[index] = entry; // a command that started now has its result
        return;
      }
    }
  }
  // Presentation limits must not discard starts or prevent later completion events merging.
  log.push(entry);
}
