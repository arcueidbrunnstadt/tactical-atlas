import assert from "node:assert/strict";
import test from "node:test";
import { billingEnvelope, BILLING_CONFIG } from "../server/billing.ts";
import { maximumRequestChargeMicroUsd, PROVIDER_CONFIG } from "../server/provider.ts";
import { RESERVATION_CENTS } from "../server/quota.ts";

const CHECKED = Date.parse("2026-10-29T00:00:00+08:00");
const CURRENT = CHECKED + 12 * 60 * 60 * 1000;

test("confirmed USD uses the current provider envelope and matching three-cent unit", () => {
  assert.equal(RESERVATION_CENTS * 10_000, PROVIDER_CONFIG.reservationMicroUsd);
  assert.equal(maximumRequestChargeMicroUsd(), 22_947);
  assert.deepEqual(billingEnvelope("USD", CURRENT), {
    currency: "USD", covered: true, maxChargeMicroUsd: 22_947, reason: "ready",
  });
});

test("CNY rounds to a whole fen before conservative USD conversion", () => {
  const rawFen = (PROVIDER_CONFIG.inputTokenUpperBound * BILLING_CONFIG.inputFenPerMillion
    + PROVIDER_CONFIG.maxOutputTokens * BILLING_CONFIG.outputFenPerMillion) / 1_000_000;
  assert.equal(rawFen, 15.29792);
  assert.equal(Math.ceil(rawFen), 16);
  assert.equal(Math.ceil(16 * 10_000 / BILLING_CONFIG.cnyPerUsdFloor), 26_667);
  assert.deepEqual(billingEnvelope("CNY", CURRENT), {
    currency: "CNY", covered: true, maxChargeMicroUsd: 26_667, reason: "ready",
  });
  assert.ok(26_667 < RESERVATION_CENTS * 10_000);
});

test("missing, unsupported or loosely formatted currency never enables billing", () => {
  for (const currency of [undefined, "", "usd", "cny", "USD ", " CNY", "EUR", "RMB", "USD\nCNY"]) {
    assert.deepEqual(billingEnvelope(currency, CURRENT), {
      currency: null, covered: false, maxChargeMicroUsd: null, reason: "billing_currency_unconfirmed",
    });
  }
});

test("future-dated price or FX references fail closed before the Shanghai checked-date boundary", () => {
  for (const currency of ["USD", "CNY"] as const) {
    assert.deepEqual(billingEnvelope(currency, CHECKED - 1), {
      currency, covered: false, maxChargeMicroUsd: null, reason: "reference_future",
    });
    assert.equal(billingEnvelope(currency, CHECKED).covered, true);
  }
  assert.equal(PROVIDER_CONFIG.pricingCheckedDate, "2026-10-29");
  assert.equal(BILLING_CONFIG.cnyPricingCheckedDate, "2026-10-29");
  assert.equal(BILLING_CONFIG.fxCheckedDate, "2026-10-29");
});

test("the seven-day window matches the provider gate exactly and then expires", () => {
  const expiry = CHECKED + BILLING_CONFIG.maxReferenceAgeMs;
  for (const currency of ["USD", "CNY"] as const) {
    assert.equal(billingEnvelope(currency, expiry).covered, true);
    assert.deepEqual(billingEnvelope(currency, expiry + 1), {
      currency, covered: false, maxChargeMicroUsd: null, reason: "reference_stale",
    });
  }
});

test("invalid clocks fail closed without pretending to establish a currency charge", () => {
  for (const now of [NaN, Infinity, -Infinity]) {
    assert.deepEqual(billingEnvelope("CNY", now), {
      currency: "CNY", covered: false, maxChargeMicroUsd: null, reason: "clock_invalid",
    });
  }
});
