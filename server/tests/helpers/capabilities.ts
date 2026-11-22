// For a test of FluidForm without some of its capabilities: they are taken away for the calling
// test only (provided.deps), whatever is switched on.
import * as provided from "../../src/provided.js";

export function without(...names: string[]): () => void {
  const before = provided.deps.extensionOn;
  provided.deps.extensionOn = (extension, library, name) => !names.includes(name) && before(extension, library, name);
  return () => {
    provided.deps.extensionOn = before;
  };
}

export const TASK_CAPABILITIES = ["planning", "team", "lead", "review", "diagnosis", "engineer", "learning", "preflight", "skills"];
