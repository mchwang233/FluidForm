// Loaded into every test process (package.json): its temporary files go under one folder of its own,
// removed when it ends, as pytest's tmp_path keeps them under one folder. A /tmp full of test folders
// would otherwise change what the tests see (a Codex step's profile denies /tmp entry by entry).
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const folder = mkdtempSync(join(process.env.TMPDIR || "/tmp", "sp-tests-"));
process.env.TMPDIR = folder;
process.env.FLUIDFORM_DATA_DIR ??= join(folder, "data");
process.env.FLUIDFORM_WORKSPACE_ROOT ??= join(folder, "workspaces");
process.on("exit", () => rmSync(folder, { recursive: true, force: true }));

// Every test prices with the pricing package's own code (helpers/pricing.ts).
import { inProcess } from "./pricing.js";
inProcess();
// And chats with the chat package's own code (helpers/chat.ts).
import { inProcess as chatInProcess } from "./chat.js";
chatInProcess();
