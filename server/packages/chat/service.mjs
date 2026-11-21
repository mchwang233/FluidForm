// The chat package as a FluidForm service: JSON-RPC 2.0 over stdin and stdout, one message a line
// (server/src/services.ts). It answers FluidForm's requests with chat.mjs, and keeps what it remembers
// about people in its own data folder ($SP_DATA_DIR/memory.json). It needs no key and no network.
import { createInterface } from "node:readline";
import { methods } from "./chat.mjs";

const METHODS = methods(process.env.SP_DATA_DIR || ".");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    console.error(`not JSON: ${line.slice(0, 200)}`);
    return;
  }
  if (typeof message?.method !== "string" || message.id === undefined) return;
  const method = METHODS[message.method];
  if (!method) {
    send({ id: message.id, error: { code: -32601, message: `聊天包没有 ${message.method}` } });
    return;
  }
  try {
    send({ id: message.id, result: method(message.params ?? {}) });
  } catch (error) {
    send({ id: message.id, error: { code: -32000, message: String(error?.message ?? error) } });
  }
});
send({ method: "status", params: { text: "可以聊天" } });
