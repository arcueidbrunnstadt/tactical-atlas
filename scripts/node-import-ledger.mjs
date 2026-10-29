import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { SqliteStore } from "../server/sqlite-store.ts";
import { importLedgerSnapshot } from "../server/ledger-handoff.ts";

let store;
try {
  if (process.argv.length !== 3 || !process.env.DATABASE_PATH || !path.isAbsolute(process.env.DATABASE_PATH)) throw new Error("Configuration missing");
  const filename = path.resolve(process.argv[2]);
  if (statSync(filename).size > 4 * 1024 * 1024) throw new Error("Snapshot too large");
  const snapshot = JSON.parse(readFileSync(filename, "utf8"));
  store = new SqliteStore(process.env.DATABASE_PATH);
  store.migrate(path.resolve("drizzle"));
  console.log(JSON.stringify(importLedgerSnapshot(store, snapshot)));
} catch { console.error("Ledger handoff rejected; check the snapshot and destination. No existing allowance is overwritten."); process.exitCode = 1; }
finally { store?.close(); }
