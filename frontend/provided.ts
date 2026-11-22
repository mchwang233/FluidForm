// Which capabilities FluidForm itself has now (server: services.ts, GET /api/capabilities/provided):
// each comes from a package that can be switched off. Read when a part of the page that depends on it
// appears and again when one is switched; null while unknown, so nothing is hidden before it is known.
import { useEffect, useState } from "react";
import { API_BASE } from "./attachments";

export type Provided = Record<string, string | null>;

const CHANGED = "fluidform:capabilities";
/** Tell the page that a capability was switched, installed or removed. */
export const capabilitiesChanged = () => window.dispatchEvent(new Event(CHANGED));

export function useProvided(): Provided | null {
  const [provided, setProvided] = useState<Provided | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => fetch(`${API_BASE}/api/capabilities/provided`).then(r => r.ok ? r.json() : null).catch(() => null)
      .then(found => { if (live) setProvided(found); });
    void read();
    window.addEventListener(CHANGED, read);
    return () => { live = false; window.removeEventListener(CHANGED, read); };
  }, []);
  return provided;
}

/** Whether ``name`` is there: known not to be only once FluidForm said so. */
export const has = (provided: Provided | null, name: string) => !provided || provided[name] !== null;
/** Whether chats can be held. */
export const canChat = (provided: Provided | null) => has(provided, "chat");
