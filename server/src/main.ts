// Starts FluidForm's API: node dist/src/main.js [--host 127.0.0.1] [--port 8000]
import { parseArgs } from "node:util";
import { Api } from "./api.js";
import { buildApp } from "./app.js";
import { settings } from "./config.js";
import { log } from "./log.js";
import * as extensions from "./extensions.js";
import { current } from "./provided.js";
import { migrate } from "./rename.js";
import { hydrateProviderKeys } from "./secrets.js";
import { stopOn } from "./shutdown.js";

const { values } = parseArgs({ options: { host: { type: "string", default: "127.0.0.1" }, port: { type: "string", default: "8000" } } });

// NODE_USE_ENV_PROXY (scripts/service.sh) is read once, as Node starts: its fetch now goes through the
// user's proxy. The commands FluidForm runs must not inherit it: each Node among them would print an
// "EnvHttpProxyAgent is experimental" warning, which broke a sandbox check whose output is compared.
delete process.env.NODE_USE_ENV_PROXY;

// What it kept as FluidForm, moved to FluidForm's names first.
migrate();
settings.prepare();
settings.loadSavedProfile();
await hydrateProviderKeys();
await extensions.preload(current());
const api = new Api();
const app = buildApp(api);
app.addHook("onClose", async () => {
  await api.close();
  api.db.close();
});
api.start();
await api.ready;
await app.listen({ host: values.host, port: Number(values.port) });
log.info(`FluidForm API on http://${values.host}:${values.port}`);
stopOn(async () => {
  api.stopping.abort();
  await app.close();
});
