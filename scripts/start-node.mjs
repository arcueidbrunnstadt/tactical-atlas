import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
process.umask(0o077);
// The generated server changes cwd. Resolve storage first so migrations and
// requests always use the same persistent file.
process.env.DATABASE_PATH = path.resolve(root, process.env.DATABASE_PATH || "data/atlas.sqlite");
process.env.NEXT_TELEMETRY_DISABLED ??= "1";
const migrated = spawnSync(process.execPath, ["--experimental-strip-types", path.join(root, "scripts/node-migrate.mjs")], {
  env: process.env, stdio: "inherit", windowsHide: true,
});
if (migrated.error || migrated.status !== 0) throw new Error("Schema migration failed; server was not started.");
let entry = path.join(root, "server.js");
try { await access(entry); }
catch { entry = path.join(root, ".next", "standalone", "server.js"); await access(entry); }
await import(pathToFileURL(entry).href);
