import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
process.umask(0o077);
process.env.DATABASE_PATH = path.resolve(root, process.env.DATABASE_PATH || "data/atlas.sqlite");
process.env.NEXT_TELEMETRY_DISABLED ??= "1";
const migrate = spawnSync(process.execPath, ["--experimental-strip-types", path.join(root, "scripts/node-migrate.mjs")], {
  env: process.env, stdio: "inherit", windowsHide: true,
});
if (migrate.error || migrate.status !== 0) throw new Error("Schema migration failed; development server was not started.");
const run = spawnSync(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "dev", "--webpack", "--hostname", "127.0.0.1", ...process.argv.slice(2)], {
  env: process.env, stdio: "inherit", windowsHide: true,
});
if (run.error) throw new Error("Development server could not start.");
process.exitCode = run.status ?? 1;
