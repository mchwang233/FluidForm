// Loaded into every test process (package.json): its temporary files go under one folder of its own,
// removed when it ends, as pytest's tmp_path keeps them under one folder. A /tmp full of test folders
// would otherwise change what the tests see (a Codex step's profile denies /tmp entry by entry).
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const folder = mkdtempSync(join(process.env.TMPDIR || "/tmp", "sp-tests-"));
process.env.TMPDIR = folder;
process.on("exit", () => rmSync(folder, { recursive: true, force: true }));
