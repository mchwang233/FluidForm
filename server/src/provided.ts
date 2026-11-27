// Which capabilities FluidForm has now (docs/design/chat-and-pricing-packages.md,
// docs/design/task-capabilities.md): provided by an active service package, or by an extension
// shipped with FluidForm that is on (extensions.ts). Kept apart from services.ts, which runs the
// packages, so that any part of FluidForm can ask without importing that.
import * as apiProviders from "./api-providers.js";
import * as capabilities from "./capabilities.js";
import * as extensions from "./extensions.js";
import type { Capability } from "./models.js";

export const deps = {
  extensionOn: (extension: extensions.Extension, library: Capability[], _name: string) => extensions.on(extension, library),
};

let kept: { key: string; library: Capability[] } | null = null;
/** The capabilities on disk, read again only after they change (asked on every model call). */
export function current(): Capability[] {
  const key = `${capabilities.root()}\0${capabilities.changes}`;
  if (kept?.key !== key) kept = { key, library: capabilities.library() };
  return kept.library;
}

apiProviders.readSwitchesWith(() => current());

/** The active service package that provides ``name``, or null. */
export function packageFor(name: string, library: Capability[] = current()): Capability | null {
  return library.find((item) => item.kind === "service" && item.status === "active" && item.provides.includes(name)) ?? null;
}

/** The id of the package that provides ``name`` now, or null. What an extension provides comes from
 *  nowhere else. */
export function providerOf(name: string, library: Capability[] = current()): string | null {
  const extension = extensions.providing(name);
  if (extension) return deps.extensionOn(extension, library, name) ? extension.id : null;
  return packageFor(name, library)?.id ?? null;
}

/** Whether ``name`` is there. */
export function available(name: string, library: Capability[] = current()): boolean {
  return providerOf(name, library) !== null;
}
