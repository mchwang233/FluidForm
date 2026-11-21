// The pricing package (server/packages/pricing) answering in the test process: every test prices with
// the package's own code, as FluidForm does over JSON-RPC (services.ts), without starting a process
// for each. Requests and answers go through JSON, as they would on the wire. tests/pricing.test.ts
// runs it as a real service; a test of FluidForm without pricing switches it off (``withoutPricing``).
import * as pricing from "../../src/pricing.js";
// @ts-expect-error: the package is plain JavaScript, with no types
import { METHODS } from "../../packages/pricing/pricing.mjs";

const wire = (value: unknown) => JSON.parse(JSON.stringify(value ?? {}));

export function inProcess(): void {
  pricing.deps.enabled = () => true;
  pricing.deps.ask = async (method, params) => {
    const answer = (METHODS as Record<string, (params: unknown) => unknown>)[method];
    if (!answer) throw new Error(`计价包没有 ${method}`);
    return wire(answer(wire(params)));
  };
}

/** For the calling test only: FluidForm with no pricing package. */
export function withoutPricing(): () => void {
  const saved = { ...pricing.deps };
  pricing.deps.enabled = () => false;
  return () => Object.assign(pricing.deps, saved);
}
