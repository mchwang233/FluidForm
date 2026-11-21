// Which capabilities FluidForm itself has now (server: services.ts, GET /api/capabilities/provided):
// chat and pricing come from packages that can be switched off. Read when a part of the page that
// depends on it appears; null while unknown, so nothing is hidden before it is known.
import { useEffect, useState } from "react";
import { API_BASE } from "./attachments";

export type Provided = Record<string, string | null>;

export function useProvided(): Provided | null {
  const [provided, setProvided] = useState<Provided | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`${API_BASE}/api/capabilities/provided`).then(r => r.ok ? r.json() : null).catch(() => null)
      .then(found => { if (live) setProvided(found); });
    return () => { live = false; };
  }, []);
  return provided;
}

/** Whether chats can be held: known not to be only once FluidForm said so. */
export const canChat = (provided: Provided | null) => !provided || provided.chat !== null;
