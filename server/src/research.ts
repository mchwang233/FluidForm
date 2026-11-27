// Model research (docs/design/model-packages.md, 模型调研): the providers' catalogs, prices and the
// leaderboards' results, and the routing scores from them, are the research package's
// (server/packages/research). FluidForm asks it here; without it the catalog, the prices and the
// scores stay as they last were, and a model never scored is not routed.
import type { Database } from "./db.js";
import * as extensions from "./extensions.js";
import { log } from "./log.js";
import type { ModelProfile } from "./models.js";
import { providerOf } from "./provided.js";

/** What the research package runs while it is on. */
export type Research = {
  /** How the last and next look-ups went (GET /api/models/sync). */
  status(): Record<string, unknown>;
  /** Look everything up now. */
  trigger(): void;
  close(): Promise<void>;
  /** Each model's leaderboard results, for the models page. */
  matchModels(models: ModelProfile[]): Map<string, unknown[]>;
};

type Code = { start(db: Database, models: Record<string, ModelProfile>): Research };

let running: Research | null = null;
let runningFor: Database | null = null;
let starting: Promise<void> | null = null;

/** The research running now, or null (its package off, or not started yet). */
export const current = (): Research | null => running;

/** Start it if its package is on and it is not running: once FluidForm has started, and when it is switched on. */
export async function begin(db: Database, models: Record<string, ModelProfile>): Promise<void> {
  const id = providerOf("research");
  // Another FluidForm in this process (a test's) had it: that one's research stops first.
  if (running && runningFor !== db) await end();
  if (!id || running) return starting ?? undefined;
  starting = extensions.load<Code>(id).then((code) => {
    running = code.start(db, models);
    runningFor = db;
  }).catch((error) => {
    log.error(`model research did not start: ${(error as Error)?.stack ?? error}`);
  }).finally(() => {
    starting = null;
  });
  return starting;
}

/** Stop it: when it is switched off, and when FluidForm stops. */
export async function end(): Promise<void> {
  await starting;
  const stopping = running;
  running = null;
  runningFor = null;
  await stopping?.close();
}
