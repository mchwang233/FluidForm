// Starts FluidForm's API: node dist/main.js [--host 127.0.0.1] [--port 8000]
import { parseArgs } from "node:util";
import { Api } from "./api.js";
import { buildApp } from "./app.js";
import { settings } from "./config.js";
import { log } from "./log.js";
import { hydrateProviderKeys } from "./secrets.js";

const { values } = parseArgs({ options: { host: { type: "string", default: "127.0.0.1" }, port: { type: "string", default: "8000" } } });

settings.prepare();
settings.loadSavedProfile();
await hydrateProviderKeys();
const api = new Api();
const app = buildApp(api);
app.addHook("onClose", () => api.close());
api.start();
await app.listen({ host: values.host, port: Number(values.port) });
log.info(`FluidForm API on http://${values.host}:${values.port}`);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void app.close().finally(() => process.exit(0));
  });
}
