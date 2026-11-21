// The pricing package as a FluidForm service: JSON-RPC 2.0 over stdin and stdout, one message a line
// (server/src/services.ts). It answers FluidForm's requests with pricing.mjs; it needs no key and
// no network.
import { createInterface } from "node:readline";
import { METHODS } from "./pricing.mjs";

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    console.error(`not JSON: ${line.slice(0, 200)}`);
    return;
  }
  if (typeof message?.method !== "string") return; // an answer: this package asks FluidForm nothing
  const method = METHODS[message.method];
  if (message.id === undefined) return;
  if (!method) {
    send({ id: message.id, error: { code: -32601, message: `计价包没有 ${message.method}` } });
    return;
  }
  try {
    send({ id: message.id, result: method(message.params ?? {}) });
  } catch (error) {
    send({ id: message.id, error: { code: -32000, message: String(error?.message ?? error) } });
  }
});
send({ method: "status", params: { text: "在计价" } });
