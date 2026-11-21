// The server's log: lines to stderr, or to a sink a test sets to read them.
type Level = "debug" | "info" | "warning" | "error";
type Sink = (level: Level, message: string) => void;

const toStderr: Sink = (level, message) => process.stderr.write(`${level.toUpperCase()}: ${message}\n`);
let sink: Sink = toStderr;

export const log = {
  debug: (message: string) => sink("debug", message),
  info: (message: string) => sink("info", message),
  warning: (message: string) => sink("warning", message),
  error: (message: string) => sink("error", message),
  /** Send log lines to ``to`` (null: back to stderr). */
  capture(to: Sink | null): void {
    sink = to ?? toStderr;
  },
};
