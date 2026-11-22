// For a test of FluidForm without some of its capabilities: they are taken away for the calling
// test only (provided.builtIn; none of them comes from a package in tests).
import * as provided from "../../src/provided.js";

export function without(...names: string[]): () => void {
  const before = new Set(provided.builtIn);
  for (const name of names) provided.builtIn.delete(name);
  return () => {
    provided.builtIn.clear();
    for (const name of before) provided.builtIn.add(name);
  };
}

export const TASK_CAPABILITIES = ["planning", "team", "lead", "review", "diagnosis", "engineer", "learning", "preflight", "skills"];
