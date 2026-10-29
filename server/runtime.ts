import { nodeBindings } from "./node-env.ts";
import { PROVIDER_CONFIG } from "./provider.ts";
import { billingEnvelope } from "./billing.ts";
import type { QuotaDatabase } from "./quota.ts";

type RuntimeBindings = {
  DEEPSEEK_API_KEY?: string;
  AI_ENABLED?: string;
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  AI_BILLING_CURRENCY?: string;
  AI_THROTTLE_SECRET?: string;
  AI_CLIENT_IDENTITY_MODE?: string;
  DB?: QuotaDatabase;
  ledgerHandoffReady?: boolean;
};

/** Server-only configuration; never serialize this object into a response. */
export function aiRuntime(now = Date.now()) {
  const bindings = nodeBindings() as RuntimeBindings;
  const key = typeof bindings.DEEPSEEK_API_KEY === "string" ? bindings.DEEPSEEK_API_KEY : "";
  const provider = bindings.AI_PROVIDER || PROVIDER_CONFIG.provider;
  const model = bindings.AI_MODEL || PROVIDER_CONFIG.model;
  const billing = billingEnvelope(bindings.AI_BILLING_CURRENCY, now);
  const throttleSecret = bindings.AI_THROTTLE_SECRET;
  const identityMode = bindings.AI_CLIENT_IDENTITY_MODE || "browser-session";
  const throttleConfigured = typeof throttleSecret === "string" && throttleSecret.length >= 32
    && identityMode === "browser-session";
  const accountCheckConfigured = key.trim().length > 24 && !!bindings.DB
    && provider === PROVIDER_CONFIG.provider && model === PROVIDER_CONFIG.model
    && throttleConfigured;
  const configured = accountCheckConfigured && billing.covered && billing.currency !== null && bindings.ledgerHandoffReady === true;
  const enabled = bindings.AI_ENABLED === "true" && configured;
  return { enabled, configured, accountCheckConfigured, key, provider, model, billingCurrency: billing.currency,
    configurationCode: !billing.covered ? billing.reason : !bindings.ledgerHandoffReady ? "LEDGER_HANDOFF_REQUIRED" : "CONFIGURATION_PENDING",
    throttleSecret, identityMode, db: bindings.DB,
    reason: enabled ? "ready" : "Live AI connection pending" };
}
