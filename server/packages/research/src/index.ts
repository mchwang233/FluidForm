// The model research package's entry: what FluidForm asks of it (server/src/research.ts). It looks
// up the providers' model catalogs (new models, context windows, prices), the public leaderboards'
// results, and scores the models for routing from them.
import { settings } from "../../../src/config.js";
import type { Database } from "../../../src/db.js";
import type { ModelProfile } from "../../../src/models.js";
import type { Research } from "../../../src/research.js";
import { BenchmarkCatalog } from "./benchmarks.js";
import { CatalogSync } from "./catalog-sync.js";
import type { Reader } from "./model-read.js";
import { rescore } from "./scoring.js";

/** Start researching ``models`` (FluidForm's catalog, changed in place and saved): score them from the
 *  leaderboard's last results now, and keep the catalog and the results up to date. ``reader``: the
 *  model that reads the leaderboard's page (a week apart, while its switch is on). */
export function start(db: Database, models: Record<string, ModelProfile>, reader: Reader | null = null): Research {
  const benchmarks = new BenchmarkCatalog(db, reader);
  rescore(models, benchmarks, db);
  const sync = new CatalogSync(db, models, { autoSync: settings.catalog_auto_sync, intervalHours: settings.catalog_sync_interval_hours, benchmarks });
  sync.start();
  return {
    status: () => sync.status(),
    trigger: () => sync.trigger(true),
    setAuto: (on) => benchmarks.setAuto(on),
    close: () => sync.close(),
    matchModels: (given) => benchmarks.matchModels(given),
  };
}
