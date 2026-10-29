import { maximumRequestChargeMicroUsd, PROVIDER_CONFIG } from "./provider.ts";
import { RESERVATION_CENTS } from "./quota.ts";

export type BillingCurrency = "USD" | "CNY";
export type BillingEnvelopeReason = "ready" | "billing_currency_unconfirmed" | "clock_invalid"
  | "reference_invalid" | "reference_future" | "reference_stale"
  | "reservation_mismatch" | "charge_not_covered";
export interface BillingEnvelope {
  currency: BillingCurrency | null;
  covered: boolean;
  maxChargeMicroUsd: number | null;
  reason: BillingEnvelopeReason;
}

export const BILLING_CONFIG = Object.freeze({
  // Peak cache-miss input/output: CNY 2 / 8 per million tokens, plus 10%.
  // https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
  cnyPricingCheckedDate: "2026-10-29",
  inputFenPerMillion: 220,
  outputFenPerMillion: 880,
  // SAFE's 2026-10-29 reference: USD 100 = CNY 671.47 (6.7147 per USD).
  // https://www.safe.gov.cn/AppStructured/hlw/RMBQuery.do?COLLCC=546877760
  // Use a lower 6.0 floor rather than presenting a spot rate as an invoice.
  fxCheckedDate: "2026-10-29",
  cnyPerUsdFloor: 6,
  maxReferenceAgeMs: 7 * 86_400_000,
});

/**
 * Checks the declared account currency against a conservative application-usage
 * envelope. It does not inspect a balance, fetch a rate, or establish actual
 * payment conversion/fees. The caller must confirm the account currency itself.
 * Expired references require an explicit review; there is no automatic refresh.
 */
export function billingEnvelope(currency: string | undefined, now: number = Date.now()): BillingEnvelope {
  const confirmed = currency === "USD" || currency === "CNY" ? currency : null;
  const denied = (reason: BillingEnvelopeReason, maxChargeMicroUsd: number | null = null): BillingEnvelope => ({
    currency: confirmed, covered: false, maxChargeMicroUsd, reason,
  });
  if (!confirmed) return denied("billing_currency_unconfirmed");
  if (!Number.isFinite(now)) return denied("clock_invalid");

  const references = confirmed === "USD"
    ? [PROVIDER_CONFIG.pricingCheckedDate]
    : [PROVIDER_CONFIG.pricingCheckedDate, BILLING_CONFIG.cnyPricingCheckedDate, BILLING_CONFIG.fxCheckedDate];
  const ages = references.map((date) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
    const checked = Date.parse(`${date}T00:00:00+08:00`);
    if (!Number.isFinite(checked) || new Date(checked + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) !== date) return NaN;
    return now - checked;
  });
  if (ages.some((age) => !Number.isFinite(age))) return denied("reference_invalid");
  if (ages.some((age) => age < 0)) return denied("reference_future");
  if (ages.some((age) => age > BILLING_CONFIG.maxReferenceAgeMs)) return denied("reference_stale");

  const reservationMicroUsd = RESERVATION_CENTS * 10_000;
  if (!Number.isSafeInteger(reservationMicroUsd) || reservationMicroUsd <= 0
      || reservationMicroUsd !== PROVIDER_CONFIG.reservationMicroUsd) return denied("reservation_mismatch");

  let maxChargeMicroUsd: number;
  if (confirmed === "USD") {
    maxChargeMicroUsd = maximumRequestChargeMicroUsd();
  } else {
    const totalFenPerMillion = PROVIDER_CONFIG.inputTokenUpperBound * BILLING_CONFIG.inputFenPerMillion
      + PROVIDER_CONFIG.maxOutputTokens * BILLING_CONFIG.outputFenPerMillion;
    if (!Number.isSafeInteger(totalFenPerMillion) || totalFenPerMillion <= 0
        || !Number.isFinite(BILLING_CONFIG.cnyPerUsdFloor) || BILLING_CONFIG.cnyPerUsdFloor <= 0) return denied("charge_not_covered");
    // First round up the CNY envelope to a whole fen. Convert that already
    // rounded value through the conservative FX floor and round up again.
    const maxFen = Math.ceil(totalFenPerMillion / 1_000_000);
    maxChargeMicroUsd = Math.ceil(maxFen * 10_000 / BILLING_CONFIG.cnyPerUsdFloor);
  }
  if (!Number.isSafeInteger(maxChargeMicroUsd) || maxChargeMicroUsd <= 0) return denied("charge_not_covered");
  if (maxChargeMicroUsd > reservationMicroUsd) return denied("charge_not_covered", maxChargeMicroUsd);
  return { currency: confirmed, covered: true, maxChargeMicroUsd, reason: "ready" };
}
