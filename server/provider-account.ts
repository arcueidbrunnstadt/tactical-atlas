export type BillingCurrency = "USD" | "CNY";
export type ProviderAccountCode =
  | "READY" | "MISSING_KEY" | "INVALID_KEY_FORMAT" | "INVALID_CONFIGURATION"
  | "PROVIDER_ACCESS_DENIED" | "PROVIDER_QUOTA_EXHAUSTED" | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_REDIRECT" | "PROVIDER_UNAVAILABLE" | "INVALID_ACCOUNT_RESPONSE"
  | "BILLING_CURRENCY_MISSING" | "BILLING_CURRENCY_AMBIGUOUS"
  | "BILLING_CURRENCY_MISMATCH" | "UNSUPPORTED_BILLING_CURRENCY";

export type ProviderAccountStatus = {
  ready: boolean;
  code: ProviderAccountCode;
  currency?: BillingCurrency;
};

type AccountFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Clock = () => number;
type CachedStatus = { expiresAt: number; value: Readonly<ProviderAccountStatus> };
const metadataCache = new Map<string, CachedStatus>();
const CACHE_TTL_MS = 60_000;
const CACHE_ENTRIES = 4;
const MAX_RESPONSE_BYTES = 8 * 1024;
const ACCOUNT_ENDPOINT = "https://api.deepseek.com/user/balance";

/** Test isolation only; no key, response or in-flight promise is held in cache. */
export function resetProviderAccountCache(): void { metadataCache.clear(); }

const fail = (code: ProviderAccountCode, currency?: BillingCurrency): ProviderAccountStatus =>
  ({ ready: false, code, ...(currency ? { currency } : {}) });

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function cacheKey(apiKey: string, currency: BillingCurrency): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([apiKey, currency]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function boundedJson(response: Response): Promise<unknown> {
  const size = Number(response.headers.get("content-length"));
  if (Number.isFinite(size) && size > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("Account response exceeds limit");
  }
  if (!response.body) throw new Error("Missing account response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Account response exceeds limit");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function sanitizeAccount(value: unknown, expectedCurrency: BillingCurrency): ProviderAccountStatus {
  if (!object(value) || typeof value.is_available !== "boolean") return fail("INVALID_ACCOUNT_RESPONSE");
  if (!Array.isArray(value.balance_infos) || value.balance_infos.length === 0) return fail("BILLING_CURRENCY_MISSING");
  if (value.balance_infos.length > 16) return fail("INVALID_ACCOUNT_RESPONSE");
  const currencies = new Set<BillingCurrency>();
  for (const balance of value.balance_infos) {
    if (!object(balance) || typeof balance.currency !== "string" || !balance.currency) return fail("BILLING_CURRENCY_MISSING");
    if (balance.currency !== "USD" && balance.currency !== "CNY") return fail("UNSUPPORTED_BILLING_CURRENCY");
    currencies.add(balance.currency);
  }
  if (currencies.size !== 1) return fail("BILLING_CURRENCY_AMBIGUOUS");
  const currency = [...currencies][0];
  if (currency !== expectedCurrency) return fail("BILLING_CURRENCY_MISMATCH", currency);
  if (!value.is_available) return fail("PROVIDER_QUOTA_EXHAUSTED", currency);
  return { ready: true, code: "READY", currency };
}

/**
 * A free account-metadata check. It accepts no visitor text and requests no model
 * generation. Only availability/error/currency metadata leaves this function;
 * balances, credentials, response objects and exception details never do.
 *
 * Cross-request cache entries contain completed plain metadata only. Keeping a
 * response or pending promise here would cross Workers request I/O contexts.
 */
export async function checkProviderAccount(
  apiKey: string,
  expectedCurrency: BillingCurrency,
  fetchFn: AccountFetch = (input, init) => globalThis.fetch(input, init),
  now: Clock = Date.now,
): Promise<ProviderAccountStatus> {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!key) return fail("MISSING_KEY");
  if (key.length > 1024 || /[^\x21-\x7e]/.test(key)) return fail("INVALID_KEY_FORMAT");
  if ((expectedCurrency !== "USD" && expectedCurrency !== "CNY") || !Number.isFinite(now())) return fail("INVALID_CONFIGURATION");

  let identity: string;
  try { identity = await cacheKey(key, expectedCurrency); }
  catch { return fail("PROVIDER_UNAVAILABLE"); }
  const cached = metadataCache.get(identity);
  if (cached && cached.expiresAt > now()) return { ...cached.value };
  metadataCache.delete(identity);

  let result: ProviderAccountStatus;
  try {
    const response = await fetchFn(ACCOUNT_ENDPOINT, {
      method: "GET", redirect: "manual", signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      result = fail(response.status >= 300 && response.status < 400 ? "PROVIDER_REDIRECT"
        : response.status === 401 || response.status === 403 ? "PROVIDER_ACCESS_DENIED"
          : response.status === 402 ? "PROVIDER_QUOTA_EXHAUSTED"
            : response.status === 429 ? "PROVIDER_RATE_LIMIT" : "PROVIDER_UNAVAILABLE");
    } else {
      try { result = sanitizeAccount(await boundedJson(response), expectedCurrency); }
      catch { result = fail("INVALID_ACCOUNT_RESPONSE"); }
    }
  } catch { result = fail("PROVIDER_UNAVAILABLE"); }

  const completedAt = now();
  if (Number.isFinite(completedAt)) {
    for (const [id, entry] of metadataCache) if (entry.expiresAt <= completedAt) metadataCache.delete(id);
    metadataCache.delete(identity);
    while (metadataCache.size >= CACHE_ENTRIES) metadataCache.delete(metadataCache.keys().next().value!);
    metadataCache.set(identity, { expiresAt: completedAt + CACHE_TTL_MS, value: Object.freeze({ ...result }) });
  }
  return { ...result };
}
