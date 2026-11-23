import assert from "node:assert/strict";
import { test } from "node:test";
import { stopOn } from "../src/shutdown.js";

function signalled(close: () => Promise<unknown>, seconds: number) {
  const listeners = new Map<string, () => void>();
  const exits: number[] = [];
  stopOn(close, { seconds, exit: (code) => exits.push(code), on: (signal, listener) => listeners.set(signal, listener) });
  return { exits, send: (signal: string) => listeners.get(signal)!() };
}

test("a stop that hangs on open work still exits, after its time", async () => {
  // Regression: closing waited for background work and connections without end; systemd killed it
  // after 90 s, the service was down all that while and a platform repair's restart failed.
  const started = Date.now();
  const { exits, send } = signalled(() => new Promise(() => undefined), 0.2);
  send("SIGTERM");
  await new Promise((done) => setTimeout(done, 400));
  assert.deepEqual(exits, [0]);
  assert.ok(Date.now() - started < 1000);
});

test("a stop that closes in time exits once, at once; a second signal changes nothing", async () => {
  let closes = 0;
  const { exits, send } = signalled(async () => { closes += 1; }, 5);
  send("SIGTERM");
  send("SIGINT");
  await new Promise((done) => setTimeout(done, 20));
  assert.deepEqual([closes, exits], [1, [0]]);
});
