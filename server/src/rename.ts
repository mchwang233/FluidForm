// FluidForm was called Super Partner: what it kept under that name is moved to the new one when it
// starts, before anything opens it. A moved folder leaves a link under its old name, since records
// keep paths into it (a lead conversation's folder, a tool installed for the steps).
import { existsSync, lstatSync, renameSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DATABASE, FORMER_DATABASE, settings } from "./config.js";
import { log } from "./log.js";

const FORMER_DATA = ".super-partner";
const FORMER_CACHE = "super-partner";

/** ``from`` moved to ``to``, linked from where it was; nothing when there is nothing to move, or
 *  ``to`` is there already. Whether it moved. */
export function moveFolder(from: string, to: string): boolean {
  if (!existsSync(from) || lstatSync(from).isSymbolicLink() || existsSync(to)) return false;
  renameSync(from, to);
  try {
    symlinkSync(to, from);
  } catch (error) {
    log.warning(`moved ${from} to ${to}, but could not link the old name: ${(error as Error).message}`);
  }
  log.info(`moved ${from} to ${to}`);
  return true;
}

/** The data folder, its database and the leads' folders, from their former names. */
export function migrate(): void {
  const data = resolve(settings.data_dir);
  if (basename(data) === ".fluidform") moveFolder(join(dirname(data), FORMER_DATA), data);
  // The database with its write-ahead log, together.
  if (!settings.database_path && !existsSync(join(data, DATABASE)) && existsSync(join(data, FORMER_DATABASE))) {
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(join(data, FORMER_DATABASE + suffix))) renameSync(join(data, FORMER_DATABASE + suffix), join(data, DATABASE + suffix));
    }
    log.info(`moved ${FORMER_DATABASE} to ${DATABASE}`);
  }
  if (!settings.lead_root) {
    const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
    moveFolder(join(cache, FORMER_CACHE), join(cache, "fluidform"));
  }
}
