import { configuredSqliteStore } from "./sqlite-store.ts";

/** Server-only bindings. Do not return this object from an API. */
export function nodeBindings() {
  const store = configuredSqliteStore();
  return {
    DB: store?.database,
    ledgerHandoffReady: store?.handoffReady() ?? false,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    AI_ENABLED: process.env.AI_ENABLED,
    AI_PROVIDER: process.env.AI_PROVIDER,
    AI_MODEL: process.env.AI_MODEL,
    AI_BILLING_CURRENCY: process.env.AI_BILLING_CURRENCY,
    AI_THROTTLE_SECRET: process.env.AI_THROTTLE_SECRET,
    AI_CLIENT_IDENTITY_MODE: process.env.AI_CLIENT_IDENTITY_MODE,
    APP_ORIGIN: process.env.APP_ORIGIN,
  };
}
