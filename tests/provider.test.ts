import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createInterpretationJsonSchema, QueryValidationError, validateInterpretRequest, validateModelInterpretation } from "../lib/query-schema.ts";
import { interpretRequest, maximumRequestChargeMicroUsd, ProviderError, PROVIDER_CONFIG } from "../server/provider.ts";
import type { InterpretRequestOptions, ProviderFetch } from "../server/provider.ts";

const requestId = "123e4567-e89b-42d3-a456-426614174000";
const catalogue = [{ id: "sample", title: "Sample Tactics", aliases: ["ST"] }];
const base: InterpretRequestOptions = { apiKey: "unit-test-placeholder-never-live", query: "avoid fantasy; prefer skill choices", catalogue, taxonomyVersion: "1.0", requestId };
const model = {
  status: "ready", criteria: [
    { featureId: "setting", value: "fantasy", operator: "neq", importance: "must", weight: 1, sourceText: "avoid fantasy" },
    { featureId: "progression", value: "skill_based", operator: "eq", importance: "preferred", weight: 1, sourceText: "prefer skill choices" },
  ], excludedGameIds: [], unhandledRequirements: [], clarification: null,
};
function payload(value: unknown = model): object {
  return { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }], usage: { input_tokens: 300, output_tokens: 100 } };
}
function fake(body: unknown, inspect?: (input: string | URL | Request, init?: RequestInit) => void): { fetch: ProviderFetch; calls: () => number } {
  let calls = 0;
  return {
    fetch: async (input, init) => { calls += 1; inspect?.(input, init); return Response.json(body); },
    calls: () => calls,
  };
}
function rejectsWith(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ProviderError && error.code === code && !error.message.includes(base.apiKey);
}

test("valid interpretation preserves eq/neq, generates IDs and returns safe usage", async () => {
  const upstream = fake(payload(), (url, init) => {
    assert.equal(url, "https://api.deepseek.com/responses");
    assert.equal(init?.redirect, "manual");
    assert.ok(init?.signal instanceof AbortSignal);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "deepseek-flash");
    assert.equal(body.reasoning.effort, "none");
    assert.equal(body.stream, false);
    assert.equal(body.tool_choice, "none");
    assert.equal(body.store, undefined);
    assert.equal(body.service_tier, undefined);
    assert.equal(body.max_output_tokens, 1_000);
    assert.equal(body.text.format.type, "json_schema");
    assert.equal(body.text.format.strict, undefined);
    assert.equal(body.text.format.name, "game_search_interpretation");
    assert.deepEqual(body.text.format.schema, createInterpretationJsonSchema(catalogue));
    assert.equal(body.tools, undefined);
    assert.equal(String(init?.body).includes(base.apiKey), false);
  });
  const result = await interpretRequest(base, upstream.fetch);
  assert.equal(upstream.calls(), 1);
  assert.equal(result.criteria[0].operator, "neq");
  assert.equal(result.criteria[1].operator, "eq");
  assert.equal(result.criteria[0].id, `${requestId}:1`);
  assert.equal(result.criteria[0].sourceText, "avoid fantasy");
  assert.deepEqual(result.usage, { inputTokens: 300, outputTokens: 100 });
  assert.equal(JSON.stringify(result).includes(base.apiKey), false);
});

test("structured schema requires every model field and bounds boolean-or-string values", () => {
  const schema = createInterpretationJsonSchema(catalogue) as { required: string[]; additionalProperties: boolean; properties: Record<string, any> };
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["status", "criteria", "excludedGameIds", "unhandledRequirements", "clarification"]);
  const criterion = schema.properties.criteria.items;
  assert.equal(criterion.additionalProperties, false);
  assert.equal(criterion.required.includes("id"), false);
  assert.deepEqual(criterion.properties.value.anyOf.map((entry: { type: string }) => entry.type), ["string", "boolean"]);
});

test("the full public catalogue fits the fixed provider envelope", async () => {
  const records = JSON.parse(readFileSync(new URL("../public/catalogue.json", import.meta.url), "utf8"));
  let bytes = 0;
  const upstream = fake(payload(), (_url, init) => { bytes = new TextEncoder().encode(String(init?.body)).length; });
  await interpretRequest({ ...base, catalogue: records }, upstream.fetch);
  assert.ok(bytes > 0 && bytes <= PROVIDER_CONFIG.maxRequestBytes);
  assert.equal(upstream.calls(), 1);
});

test("DeepSeek peak-price envelope exceeds one cent and fits the three-cent reservation", () => {
  // The documented peak cache-miss/output rates are $0.30/$1.20 per million.
  // Reserve against the whole bounded envelope with 10% headroom, not a typical
  // short request or a cheaper off-peak/cache-hit observation.
  const expected = Math.ceil((65_536 * 0.30 + 1_000 * 1.20) * 1.10);
  assert.equal(expected, 22_947);
  assert.equal(maximumRequestChargeMicroUsd(), expected);
  assert.ok(maximumRequestChargeMicroUsd() > 10_000);
  assert.equal(PROVIDER_CONFIG.reservationMicroUsd, 30_000);
  assert.ok(maximumRequestChargeMicroUsd() <= PROVIDER_CONFIG.reservationMicroUsd);
});

test("cross-field validation rejects a value valid for a different feature", async () => {
  const wrong = structuredClone(model);
  wrong.criteria[0].value = "class_based";
  const upstream = fake(payload(wrong));
  await assert.rejects(interpretRequest(base, upstream.fetch), rejectsWith("INVALID_RESPONSE"));
  assert.equal(upstream.calls(), 1);
});

test("unknown operators, hallucinated exclusion IDs and extra fields are rejected", async () => {
  for (const bad of [
    { ...model, criteria: [{ ...model.criteria[0], operator: "like" }] },
    { ...model, excludedGameIds: ["not-in-catalogue"] },
    { ...model, unsolicitedFacts: "This game is objectively balanced." },
    { ...model, criteria: [{ ...model.criteria[0], sourceText: "invented words" }] },
  ]) {
    const upstream = fake(payload(bad));
    await assert.rejects(interpretRequest(base, upstream.fetch), rejectsWith("INVALID_RESPONSE"));
    assert.equal(upstream.calls(), 1);
  }
});

test("provider refusal and incomplete output are handled without retry", async () => {
  const refused = fake({ status: "completed", output: [{ content: [{ type: "refusal", refusal: "Private provider details" }] }] });
  await assert.rejects(interpretRequest(base, refused.fetch), rejectsWith("MODEL_REFUSAL"));
  assert.equal(refused.calls(), 1);
  const incomplete = fake({ status: "incomplete", output: [] });
  await assert.rejects(interpretRequest(base, incomplete.fetch), rejectsWith("INCOMPLETE_RESPONSE"));
  assert.equal(incomplete.calls(), 1);
});

test("malformed or multiple output texts fail safely instead of accepting a partial object", async () => {
  for (const body of [
    { status: "completed", output: [{ content: [{ type: "output_text", text: "not JSON" }] }] },
    { status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(model) }, { type: "output_text", text: JSON.stringify(model) }] }] },
  ]) {
    const upstream = fake(body);
    await assert.rejects(interpretRequest(base, upstream.fetch), rejectsWith("INVALID_RESPONSE"));
    assert.equal(upstream.calls(), 1);
  }
});

test("HTTP errors are mapped without returning provider bodies or retrying", async () => {
  for (const [status, code] of [[401, "PROVIDER_ACCESS_DENIED"], [429, "PROVIDER_RATE_LIMIT"], [500, "PROVIDER_UNAVAILABLE"]] as const) {
    let calls = 0;
    const upstream: ProviderFetch = async () => { calls += 1; return new Response(`provider-body-${base.apiKey}`, { status }); };
    await assert.rejects(interpretRequest(base, upstream), rejectsWith(code));
    assert.equal(calls, 1);
  }
});

test("redirects are rejected without following or reading Location and provider text", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    for (const status of [300, 301, 302, 303, 307, 308, 399]) {
      let calls = 0;
      const upstream: ProviderFetch = async (url, init) => {
        calls += 1;
        assert.equal(url, PROVIDER_CONFIG.endpoint);
        assert.equal(init?.redirect, "manual");
        const response = new Response(null, { status });
        Object.defineProperty(response, "headers", { get() { throw new Error("Location must not be read"); } });
        Object.defineProperty(response, "body", { get() { throw new Error("Redirect body must not be read"); } });
        return response;
      };
      await assert.rejects(interpretRequest(base, upstream), rejectsWith("PROVIDER_REDIRECT"));
      assert.equal(calls, 1);
    }
  } finally { console.error = originalError; }
});

test("network and timeout errors are redacted and never automatically retried", async () => {
  for (const timeout of [false, true]) {
    let calls = 0;
    const upstream: ProviderFetch = async () => {
      calls += 1;
      const error = new Error(`Sensitive transport value ${base.apiKey}`);
      if (timeout) error.name = "TimeoutError";
      throw error;
    };
    await assert.rejects(interpretRequest(base, upstream), rejectsWith(timeout ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE"));
    assert.equal(calls, 1);
  }
});

test("oversized visitor queries and serialized provider envelopes never dispatch", async () => {
  const upstream = fake(payload());
  await assert.rejects(interpretRequest({ ...base, query: "x".repeat(1_001) }, upstream.fetch), rejectsWith("QUERY_TOO_LARGE"));
  const largeCatalogue = [{ id: "sample", title: "x".repeat(20_000), aliases: [] }];
  await assert.rejects(interpretRequest({ ...base, catalogue: largeCatalogue }, upstream.fetch), rejectsWith("REQUEST_TOO_LARGE"));
  assert.equal(upstream.calls(), 0);
});

test("unsupported model/configuration, empty key and taxonomy drift never dispatch", async () => {
  const upstream = fake(payload());
  await assert.rejects(interpretRequest({ ...base, model: "a-more-expensive-model" }, upstream.fetch), rejectsWith("UNSUPPORTED_CONFIGURATION"));
  await assert.rejects(interpretRequest({ ...base, apiKey: " " }, upstream.fetch), rejectsWith("MISSING_KEY"));
  await assert.rejects(interpretRequest({ ...base, taxonomyVersion: "old" }, upstream.fetch), rejectsWith("TAXONOMY_MISMATCH"));
  assert.equal(upstream.calls(), 0);
  assert.ok(maximumRequestChargeMicroUsd() < PROVIDER_CONFIG.reservationMicroUsd);
});

test("Chinese source phrases survive validation without an invented English source span", async () => {
  const chinese = { ...model, criteria: [{ ...model.criteria[0], sourceText: "不要奇幻" }] };
  const upstream = fake(payload(chinese));
  const result = await interpretRequest({ ...base, query: "不要奇幻，想玩科幻战术游戏" }, upstream.fetch);
  assert.equal(result.criteria[0].sourceText, "不要奇幻");
  assert.equal(result.criteria[0].operator, "neq");
});

test("focused clarification and unsupported requirements are preserved for the interface", () => {
  const context = { query: "no randomness", taxonomyVersion: "1.0", requestId, catalogue };
  const result = validateModelInterpretation({ status: "clarification", criteria: [], excludedGameIds: [], unhandledRequirements: ["All randomness"], clarification: { question: "Which randomness do you want to avoid?", choices: ["Combat rolls", "All randomness"] } }, context);
  assert.equal(result.status, "clarification");
  assert.equal(result.unhandledRequirements[0], "All randomness");
  assert.equal(result.clarification?.choices.length, 2);
});

test("request validation rejects unexpected fields and unsupported UUIDs", () => {
  assert.throws(() => validateInterpretRequest({ query: "fantasy", taxonomyVersion: "1.0", requestId, apiKey: "not-a-client-field" }), QueryValidationError);
  assert.throws(() => validateInterpretRequest({ query: "fantasy", taxonomyVersion: "1.0", requestId: "anything" }), QueryValidationError);
});

test("too many hard requirements and contradictory ready requirements fail validation", () => {
  const context = { query: base.query, taxonomyVersion: "1.0", requestId, catalogue };
  const must = model.criteria[0];
  assert.throws(() => validateModelInterpretation({ ...model, criteria: Array.from({ length: 9 }, () => must) }, context), QueryValidationError);
  assert.throws(() => validateModelInterpretation({ ...model, criteria: [must, { ...must, operator: "eq" }] }, context), QueryValidationError);
});

test("an oversized response is bounded without parsing or echoing provider text", async () => {
  let calls = 0;
  const upstream: ProviderFetch = async () => { calls += 1; return new Response("x".repeat(70_000)); };
  await assert.rejects(interpretRequest(base, upstream), rejectsWith("INVALID_RESPONSE"));
  assert.equal(calls, 1);
});

test("surrounding credential whitespace is normalized before constructing Authorization", async () => {
  const upstream = fake(payload(), (_url, init) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${base.apiKey}`);
  });
  await interpretRequest({ ...base, apiKey: `\r\n\t ${base.apiKey} \t\r\n` }, upstream.fetch);
  assert.equal(upstream.calls(), 1);
});

test("internal credential whitespace, control and non-ASCII characters never dispatch", async () => {
  const upstream = fake(payload());
  const logs: unknown[][] = [];
  const originalError = console.error;
  console.error = (...items: unknown[]) => { logs.push(items); };
  try {
    for (const apiKey of ["bad\ninternal", "bad value", "bad\u0000value", "bad\u007fvalue", "bad\u00e9value"]) {
      await assert.rejects(interpretRequest({ ...base, apiKey }, upstream.fetch), rejectsWith("INVALID_KEY_FORMAT"));
      assert.equal(JSON.stringify(logs).includes(apiKey), false);
    }
  } finally { console.error = originalError; }
  assert.equal(upstream.calls(), 0);
  assert.equal(logs.length, 5);
  assert.deepEqual(logs[0], ["PROVIDER_DIAGNOSTIC", { stage: "credentials", category: "invalid_key_format" }]);
});

test("the default transport preserves the global fetch receiver", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async function (this: typeof globalThis, input, init) {
    calls += 1;
    assert.equal(this, globalThis);
    assert.equal(input, PROVIDER_CONFIG.endpoint);
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${base.apiKey}`);
    return Response.json(payload());
  };
  try { await interpretRequest(base); }
  finally { globalThis.fetch = originalFetch; }
  assert.equal(calls, 1);
});

test("DeepSeek 402 balance exhaustion is distinct from 429 limits and does not echo either error body", async () => {
  const logs: unknown[][] = [];
  const originalError = console.error;
  console.error = (...items: unknown[]) => { logs.push(items); };
  try {
    for (const [status, providerCode, expectedCode] of [
      [402, "insufficient_balance", "PROVIDER_QUOTA_EXHAUSTED"],
      [429, "rate_limit_exceeded", "PROVIDER_RATE_LIMIT"],
      [429, "insufficient_quota", "PROVIDER_RATE_LIMIT"],
      [402, `untrusted-${base.apiKey}`, "PROVIDER_QUOTA_EXHAUSTED"],
    ] as const) {
      let calls = 0;
      const upstream: ProviderFetch = async () => {
        calls += 1;
        return Response.json({ error: { code: providerCode, message: `private-${base.apiKey}` } }, { status });
      };
      await assert.rejects(interpretRequest(base, upstream), rejectsWith(expectedCode));
      assert.equal(calls, 1);
    }
    let calls = 0;
    const oversized: ProviderFetch = async () => {
      calls += 1;
      return new Response("x".repeat(70_000), { status: 429 });
    };
    await assert.rejects(interpretRequest(base, oversized), rejectsWith("PROVIDER_RATE_LIMIT"));
    assert.equal(calls, 1);
  } finally { console.error = originalError; }
  assert.equal(JSON.stringify(logs).includes(base.apiKey), false);
  assert.deepEqual(logs[0], ["PROVIDER_DIAGNOSTIC", { stage: "http_response", category: "quota_exhausted", status: 402 }]);
});

test("bad-request and model-not-found failures use static classifications without body echo", async () => {
  const logs: unknown[][] = [];
  const originalError = console.error;
  console.error = (...items: unknown[]) => { logs.push(items); };
  try {
    for (const [status, providerCode, expectedCode] of [
      [400, "invalid_json_schema", "PROVIDER_BAD_REQUEST"],
      [422, "invalid_parameters", "PROVIDER_BAD_REQUEST"],
      [404, "model_not_found", "PROVIDER_MODEL_UNAVAILABLE"],
      [404, "untrusted_code", "PROVIDER_UNAVAILABLE"],
    ] as const) {
      let calls = 0;
      const upstream: ProviderFetch = async () => {
        calls += 1;
        return Response.json({ error: { code: providerCode, message: `private-${base.apiKey}` } }, { status });
      };
      await assert.rejects(interpretRequest(base, upstream), rejectsWith(expectedCode));
      assert.equal(calls, 1);
    }
  } finally { console.error = originalError; }
  assert.equal(JSON.stringify(logs).includes(base.apiKey), false);
  assert.deepEqual(logs.map((entry) => entry[1]), [
    { stage: "http_response", category: "request_configuration", status: 400 },
    { stage: "http_response", category: "request_configuration", status: 422 },
    { stage: "http_response", category: "model_unavailable", status: 404 },
    { stage: "http_response", category: "http_error", status: 404 },
  ]);
});

test("transport diagnostics expose only fixed categories and distinguish dispatch from stream failure", async () => {
  const logs: unknown[][] = [];
  const originalError = console.error;
  console.error = (...items: unknown[]) => { logs.push(items); };
  try {
    const invocation: ProviderFetch = async () => { throw new TypeError(`Illegal invocation: ${base.apiKey}`); };
    await assert.rejects(interpretRequest(base, invocation), rejectsWith("PROVIDER_UNAVAILABLE"));
    const dns: ProviderFetch = async () => { throw new Error(`private-${base.apiKey}`, { cause: { code: "ENOTFOUND", private: base.apiKey } }); };
    await assert.rejects(interpretRequest(base, dns), rejectsWith("PROVIDER_UNAVAILABLE"));
    const unknown: ProviderFetch = async () => {
      const error = new Error(`private-${base.apiKey}`, { cause: { code: base.apiKey } });
      error.name = base.apiKey;
      throw error;
    };
    await assert.rejects(interpretRequest(base, unknown), rejectsWith("PROVIDER_UNAVAILABLE"));
    const brokenStream: ProviderFetch = async () => new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError(`Network connection lost: ${base.apiKey}`)); },
    }));
    await assert.rejects(interpretRequest(base, brokenStream), rejectsWith("PROVIDER_UNAVAILABLE"));
  } finally { console.error = originalError; }
  assert.equal(JSON.stringify(logs).includes(base.apiKey), false);
  assert.deepEqual(logs, [
    ["PROVIDER_DIAGNOSTIC", { stage: "dispatch", category: "illegal_invocation" }],
    ["PROVIDER_DIAGNOSTIC", { stage: "dispatch", category: "network_dns" }],
    ["PROVIDER_DIAGNOSTIC", { stage: "dispatch", category: "unknown" }],
    ["PROVIDER_DIAGNOSTIC", { stage: "response_read", category: "network" }],
  ]);
});
