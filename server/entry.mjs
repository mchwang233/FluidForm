// Writes dist/main.js, where the server started before its extensions were built with it: a service
// set up to run that path goes on starting after an update rebuilds and restarts it.
import { writeFileSync } from "node:fs";

writeFileSync(new URL("./dist/main.js", import.meta.url), 'import "./src/main.js";\n');
