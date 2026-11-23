// Stopping the server (main.ts): it closes what it can, but never takes longer than ``SHUTDOWN_SECONDS``.
// Closing waits for background work (a retrospective on a membership CLI can take a minute) and open
// connections; a stop that hangs on them keeps the service down and makes a platform repair's restart
// time out (systemd waits 90 s before killing it).
import { log } from "./log.js";

export const SHUTDOWN_SECONDS = 10;

type Deps = { seconds?: number; exit?: (code: number) => void; on?: (signal: NodeJS.Signals, listener: () => void) => void };

/** On SIGTERM or SIGINT: ``close``, then exit; exits anyway after ``seconds``. */
export function stopOn(close: () => Promise<unknown>, { seconds = SHUTDOWN_SECONDS, exit = (code) => process.exit(code), on = (signal, listener) => process.once(signal, listener) }: Deps = {}): void {
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`FluidForm stopping (${signal})`);
    const late = setTimeout(() => {
      log.warning(`FluidForm did not finish stopping in ${seconds} s: exiting with work still open`);
      exit(0);
    }, seconds * 1000);
    void close()
      .catch((error) => log.warning(`FluidForm stopping: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        clearTimeout(late);
        exit(0);
      });
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) on(signal, () => stop(signal));
}
