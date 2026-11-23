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

// What it kept as FluidForm, moved to FluidForm's names first.
migrate();
settings.prepare();
settings.loadSavedProfile();
await hydrateProviderKeys();
await extensions.preload(current());
const api = new Api();
const app = buildApp(api);
app.addHook("onClose", () => api.close());
api.start();
await app.listen({ host: values.host, port: Number(values.port) });
log.info(`FluidForm API on http://${values.host}:${values.port}`);
stopOn(() => app.close());
