import path from "node:path";
import { SqliteStore } from "../server/sqlite-store.ts";

let store;
try {
  if (!process.env.DATABASE_PATH || !path.isAbsolute(process.env.DATABASE_PATH)) throw new Error("DATABASE_PATH must be absolute");
  store = new SqliteStore(process.env.DATABASE_PATH);
  store.migrate(path.resolve("drizzle"));
  console.log(JSON.stringify({ schemaReady: true, ledgerHandoffReady: store.handoffReady() }));
} catch { console.error("Database initialization failed. Check the persistent path, permissions and migration files."); process.exitCode = 1; }
finally { store?.close(); }
