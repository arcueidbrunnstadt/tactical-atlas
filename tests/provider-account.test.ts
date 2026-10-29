import assert from "node:assert/strict";
import test from "node:test";
import { checkProviderAccount, resetProviderAccountCache } from "../server/provider-account.ts";

const KEY = "unit-test-account-key-never-live";
const account = (currency: string = "USD", available = true) => ({
  is_available: available,
  balance_infos: [{ currency, total_balance: available ? "17.52" : "0.00", granted_balance: "0.00", topped_up_balance: available ? "17.52" : "0.00" }],
});

test("account metadata uses only authenticated GET and returns no credentials or balances", async () => {
  resetProviderAccountCache();
  let calls = 0;
  const result = await checkProviderAccount(` \n${KEY}\r\n `, "USD", async (url, init) => {
    calls += 1;
    assert.equal(url, "https://api.deepseek.com/user/balance");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.body, undefined);
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${KEY}`);
    return Response.json({ ...account(), unexpected_secret: KEY });
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { ready: true, code: "READY", currency: "USD" });
  assert.equal(JSON.stringify(result).includes(KEY), false);
  assert.equal(JSON.stringify(result).includes("17.52"), false);
});

test("invalid credentials or currency configuration never dispatch", async () => {
  resetProviderAccountCache();
  let calls = 0;
  const upstream = async () => { calls += 1; return Response.json(account()); };
  for (const apiKey of ["", " \t\n"]) assert.equal((await checkProviderAccount(apiKey, "USD", upstream)).code, "MISSING_KEY");
  for (const apiKey of ["bad value", "bad\nvalue", "bad\u0000value", "bad\u00e9value", "x".repeat(1025)]) {
    assert.equal((await checkProviderAccount(apiKey, "USD", upstream)).code, "INVALID_KEY_FORMAT");
  }
  assert.equal((await checkProviderAccount(KEY, "EUR" as "USD", upstream)).code, "INVALID_CONFIGURATION");
  assert.equal(calls, 0);
});

test("HTTP failures are static, bounded and never followed or retried", async () => {
  for (const [status, code] of [[301, "PROVIDER_REDIRECT"], [307, "PROVIDER_REDIRECT"], [401, "PROVIDER_ACCESS_DENIED"], [403, "PROVIDER_ACCESS_DENIED"], [402, "PROVIDER_QUOTA_EXHAUSTED"], [429, "PROVIDER_RATE_LIMIT"], [400, "PROVIDER_UNAVAILABLE"]] as const) {
    resetProviderAccountCache();
    let calls = 0;
    const result = await checkProviderAccount(KEY, "USD", async (_url, init) => {
      calls += 1;
      assert.equal(init?.redirect, "manual");
      return new Response(`private-${KEY}`, { status, headers: { Location: "https://unrelated.invalid/" } });
    });
    assert.deepEqual(result, { ready: false, code });
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes(KEY), false);
  }
});

test("currency mismatch, dual wallets and missing or unsupported currencies fail closed", async () => {
  const cases = [
    { body: account("CNY"), code: "BILLING_CURRENCY_MISMATCH", currency: "CNY" },
    { body: { is_available: true, balance_infos: [{ currency: "USD" }, { currency: "CNY" }] }, code: "BILLING_CURRENCY_AMBIGUOUS" },
    { body: { is_available: true, balance_infos: [] }, code: "BILLING_CURRENCY_MISSING" },
    { body: { is_available: true, balance_infos: [{}] }, code: "BILLING_CURRENCY_MISSING" },
    { body: account("EUR"), code: "UNSUPPORTED_BILLING_CURRENCY" },
    { body: { is_available: "true", balance_infos: [{ currency: "USD" }] }, code: "INVALID_ACCOUNT_RESPONSE" },
  ];
  for (const item of cases) {
    resetProviderAccountCache();
    const result = await checkProviderAccount(KEY, "USD", async () => Response.json(item.body));
    assert.equal(result.ready, false);
    assert.equal(result.code, item.code);
    assert.equal(result.currency, item.currency);
  }
  resetProviderAccountCache();
  const repeated = await checkProviderAccount(KEY, "USD", async () => Response.json({ is_available: true, balance_infos: [{ currency: "USD" }, { currency: "USD" }] }));
  assert.equal(repeated.ready, true);
});

test("the availability flag rejects an exhausted account without returning monetary values", async () => {
  resetProviderAccountCache();
  const result = await checkProviderAccount(KEY, "CNY", async () => Response.json(account("CNY", false)));
  assert.deepEqual(result, { ready: false, code: "PROVIDER_QUOTA_EXHAUSTED", currency: "CNY" });
});

test("non-JSON and advertised or streamed oversized metadata never escapes as raw text", async () => {
  for (const response of [
    new Response(`private-${KEY}`),
    new Response("short", { headers: { "Content-Length": "8193" } }),
    new Response("x".repeat(8193)),
  ]) {
    resetProviderAccountCache();
    const result = await checkProviderAccount(KEY, "USD", async () => response);
    assert.deepEqual(result, { ready: false, code: "INVALID_ACCOUNT_RESPONSE" });
    assert.equal(JSON.stringify(result).includes(KEY), false);
  }
});

test("completed metadata cache is credential/currency isolated and expires from completion", async () => {
  resetProviderAccountCache();
  let clock = 1000;
  let calls = 0;
  const upstream = async () => { calls += 1; clock += 5000; return Response.json(account()); };
  const first = await checkProviderAccount(KEY, "USD", upstream, () => clock);
  first.ready = false;
  clock = 65_999;
  assert.equal((await checkProviderAccount(KEY, "USD", upstream, () => clock)).ready, true);
  assert.equal(calls, 1);
  clock = 66_000;
  assert.equal((await checkProviderAccount(KEY, "USD", upstream, () => clock)).ready, true);
  assert.equal(calls, 2);
  await checkProviderAccount(`${KEY}-other`, "USD", upstream, () => clock);
  assert.equal(calls, 3);
  assert.equal((await checkProviderAccount(KEY, "CNY", upstream, () => clock)).code, "BILLING_CURRENCY_MISMATCH");
  assert.equal(calls, 4);
});

test("transport failures reveal neither exception details nor key and have no automatic retry", async () => {
  resetProviderAccountCache();
  let calls = 0;
  const result = await checkProviderAccount(KEY, "USD", async () => { calls += 1; throw new Error(`Private transport ${KEY}`); });
  assert.deepEqual(result, { ready: false, code: "PROVIDER_UNAVAILABLE" });
  assert.equal(calls, 1);
});

test("metadata dispatch is given an eight-second deadline", async () => {
  resetProviderAccountCache();
  const originalTimeout = AbortSignal.timeout;
  let deadline;
  AbortSignal.timeout = (milliseconds: number) => { deadline = milliseconds; return originalTimeout(milliseconds); };
  try {
    await checkProviderAccount(KEY, "USD", async () => Response.json(account()));
    assert.equal(deadline, 8000);
  } finally { AbortSignal.timeout = originalTimeout; }
});

test("concurrent request contexts do not share an in-flight account promise", async () => {
  resetProviderAccountCache();
  let firstEntered!: () => void;
  let secondEntered!: () => void;
  let release!: () => void;
  const firstStarted = new Promise<void>((resolve) => { firstEntered = resolve; });
  const secondStarted = new Promise<void>((resolve) => { secondEntered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const upstream = async () => {
    calls += 1;
    if (calls === 1) firstEntered();
    else secondEntered();
    await gate;
    return Response.json(account());
  };
  const first = checkProviderAccount(KEY, "USD", upstream);
  await firstStarted;
  const second = checkProviderAccount(KEY, "USD", upstream);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([secondStarted, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Second request reused pending I/O")), 1000);
    })]);
    assert.equal(calls, 2);
  } finally {
    clearTimeout(timer);
    release();
    await Promise.all([first, second]);
  }
});
