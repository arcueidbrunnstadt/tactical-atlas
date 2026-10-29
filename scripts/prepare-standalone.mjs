import { cp, mkdir, access, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, ".next", "standalone");
await access(path.join(output, "server.js"));
const files = [
  ["package.json", "package.json"],
  ["public", "public"],
  [".next/static", ".next/static"],
  ["drizzle", "drizzle"],
  ["scripts/start-node.mjs", "scripts/start-node.mjs"],
  ["scripts/node-migrate.mjs", "scripts/node-migrate.mjs"],
  ["scripts/node-import-ledger.mjs", "scripts/node-import-ledger.mjs"],
  ["server/sqlite-store.ts", "server/sqlite-store.ts"],
  ["server/ledger-handoff.ts", "server/ledger-handoff.ts"],
  ["server/node-env.ts", "server/node-env.ts"],
  ["server/quota.ts", "server/quota.ts"],
];
for (const [source, target] of files) {
  const destination = path.join(output, target);
  const relative = path.relative(output, destination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Invalid standalone copy target");
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(root, source), destination, { recursive: true, force: true });
}
console.log("Standalone assets, migrations and startup helpers prepared.");
if ((await lstat(path.join(output, "node_modules"))).isSymbolicLink()) {
  console.warn("This local standalone output retains a dependency link. Use a fresh in-container npm install for a portable Linux image; this directory is not a self-contained export.");
}
