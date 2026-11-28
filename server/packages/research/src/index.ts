// The model research package's entry: what FluidForm asks of it (server/src/research.ts). It looks
// up the providers' model catalogs (new models, context windows, prices), the public leaderboards'
// results, and scores the models for routing from them.
import { type ResearchStore, type ModelProfile, type Research, settings } from "../../../src/extension-api.js";
import { BenchmarkCatalog } from "./benchmarks.js";
import { CatalogSync } from "./catalog-sync.js";
import type { Reader } from "./model-read.js";
import { rescore } from "./scoring.js";

/** Start researching ``models`` (FluidForm's catalog, changed in place and saved): score them from the
 *  leaderboard's last results now, and keep the catalog and the results up to date. ``reader``: the
 *  model that reads the leaderboard's page (a week apart, while its switch is on). */
export function start(db: ResearchStore, models: Record<string, ModelProfile>, reader: Reader | null = null): Research {
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

// What FluidForm calls this package through (server/src/research.ts): compiling fails when the two part.
import type { Implements, ResearchPackage } from "../../../src/extension-api.js";
export type Contract = Implements<ResearchPackage, typeof import("./index.js")>;
