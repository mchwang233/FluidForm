// Which capabilities FluidForm has now (docs/design/chat-and-pricing-packages.md,
// docs/design/task-capabilities.md): provided by an active service package, or still by FluidForm
// itself (``builtIn``). Kept apart from services.ts, which runs the packages, so that any part of
// FluidForm can ask without importing that.
import * as capabilities from "./capabilities.js";
import type { Capability } from "./models.js";

// What FluidForm still does itself, until a package takes it over.
export const builtIn = new Set<string>(["planning", "team", "lead", "review", "diagnosis", "engineer", "learning", "preflight", "skills"]);

let kept: { key: string; library: Capability[] } | null = null;
/** The capabilities on disk, read again only after they change (asked on every model call). */
export function current(): Capability[] {
  const key = `${capabilities.root()}\0${capabilities.changes}`;
  if (kept?.key !== key) kept = { key, library: capabilities.library() };
  return kept.library;
}

/** The active service package that provides ``name``, or null. */
export function packageFor(name: string, library: Capability[] = current()): Capability | null {
  return library.find((item) => item.kind === "service" && item.status === "active" && item.provides.includes(name)) ?? null;
}

/** Whether ``name`` is there: from an active package, or still from FluidForm itself. */
export function available(name: string, library: Capability[] = current()): boolean {
  return Boolean(packageFor(name, library)) || builtIn.has(name);
}
