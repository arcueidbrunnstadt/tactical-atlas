import { nodeBindings } from "../server/node-env";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb() {
  const env = nodeBindings();
  if (!env.DB) {
    throw new Error(
      "Persistent SQLite storage is unavailable. Check DATABASE_PATH and migrations."
    );
  }

  return drizzle(env.DB as D1Database, { schema });
}
