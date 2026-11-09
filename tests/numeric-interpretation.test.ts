import assert from "node:assert/strict";
import test from "node:test";
import { createInterpretationJsonSchema, INTERPRETATION_VERSION, QueryValidationError, validateModelInterpretation } from "../lib/query-schema.ts";
import { TAXONOMY_VERSION } from "../lib/taxonomy.ts";
import { interpretRequest, type ProviderFetch } from "../server/provider.ts";

const context = {
  catalogue: [{ id: "sample", title: "Sample Tactics", aliases: [] }],
  requestId: "123e4567-e89b-42d3-a456-426614174000",
  taxonomyVersion: TAXONOMY_VERSION,
};
const ready = {
  status: "ready", criteria: [], alternatives: [], excludedGameIds: [], unhandledRequirements: [], clarification: null,
};

function hours(sourceText: string, operator: string, value = 35, importance: "must" | "preferred" = "preferred") {
  return { featureId: "campaign_hours", sourceText, operator, value, importance, weight: 1 };
}

function unresolved(result: ReturnType<typeof validateModelInterpretation>) {
  return result.unresolvedRequirements.map(({ sourceText, importance }) => ({ sourceText, importance }));
}

test("provider replies preserve explicit lower, approximate and upper comparisons in both languages", async () => {
  const schema = createInterpretationJsonSchema() as {
    properties: { criteria: { items: { properties: { operator: { enum: string[] } } } } };
  };
  assert.deepEqual(schema.properties.criteria.items.properties.operator.enum, ["eq", "neq", "gte", "near", "lte"]);

  for (const [query, operator] of [
    ["I prefer at least 35 hours to the story ending.", "gte"],
    ["I prefer around 35 hours to reach one story ending.", "near"],
    ["The base campaign should take 35 hours or less.", "lte"],
    ["主线至少有３５个小时。", "gte"],
    ["我希望主线３５小时左右。", "near"],
    ["我希望主线不超过３５个小时。", "lte"],
  ]) {
    const criteria = [hours(query, operator)];
    let calls = 0;
    const fake: ProviderFetch = async () => {
      calls += 1;
      return Response.json({ status: "completed", output: [{ type: "message", content: [{
        type: "output_text", text: JSON.stringify({ ...ready, criteria }),
      }] }] });
    };
    const result = await interpretRequest({ ...context, query, apiKey: "unit-test-placeholder-never-live" }, fake);

    assert.equal(calls, 1);
    assert.equal(result.status, "ready", query);
    assert.equal(result.interpretationVersion, INTERPRETATION_VERSION);
    assert.deepEqual(result.criteria, [{ ...criteria[0], id: `${context.requestId}:1` }]);
    assert.deepEqual(unresolved(result), []);
  }
});

test("the frozen S10 minimum mapping preserves the approximate wording as unresolved", () => {
  for (const query of [
    "I prefer around 35 hours to reach one story ending.",
    "我希望大约35小时能到达一个剧情结局。",
  ]) {
    const result = validateModelInterpretation({ ...ready, criteria: [hours(query, "gte")] }, { ...context, query });

    assert.equal(result.status, "unsupported", query);
    assert.deepEqual(result.criteria, []);
    assert.deepEqual(unresolved(result), [{ sourceText: query, importance: "preferred" }]);
    assert.deepEqual(result.unhandledRequirements, [query]);
  }
});

test("wrong directions, strict limits, ranges and multi-quantity quotes stay unresolved", () => {
  for (const [query, operator, value] of [
    ["The main story must take at most 35 hours.", "gte", 35],
    ["主线必须在35小时以内。", "gte", 35],
    ["The main story must take less than 35 hours.", "lte", 35],
    ["I need exactly 35 hours to the ending.", "near", 35],
    ["The main story should take 30–35 hours.", "gte", 30],
    ["主线需要30到35小时。", "lte", 35],
    ["I want around 35 hours or at least 50 hours to an ending.", "gte", 35],
    ["主线最多35小时，或者至少50小时。", "gte", 35],
    ["The main story should take at least 35 hours or less.", "gte", 35],
    ["I need the main story to take not at least 35 hours.", "gte", 35],
    ["I want the main story to take at most about 35 hours.", "near", 35],
    ["主线不超过约35小时。", "near", 35],
  ] as const) {
    const criteria = [hours(query, operator, value, "must")];
    const result = validateModelInterpretation({ ...ready, criteria }, { ...context, query });

    assert.equal(result.status, "unsupported", query);
    assert.deepEqual(result.criteria, [], query);
    assert.deepEqual(unresolved(result), [{ sourceText: query, importance: "must" }]);
  }
});

test("an underquoted comparison retains its enclosing wording in an unresolved note", () => {
  for (const [clause, quote, operator] of [
    ["I prefer around 35 hours to the ending", "35 hours", "gte"],
    ["主线希望最多35小时", "35小时", "gte"],
    ["I want the main story to take at most about 35 hours", "about 35 hours", "near"],
    ["The main story should take not at least 35 hours", "at least 35 hours", "gte"],
    ["The main story should take at least 35 hours or less", "at least 35 hours", "gte"],
    ["主线不超过约35小时", "约35小时", "near"],
  ]) {
    const query = `${clause}; fantasy is a bonus.`;
    const result = validateModelInterpretation({ ...ready, criteria: [hours(quote, operator)] }, { ...context, query });

    assert.equal(result.status, "unsupported");
    assert.deepEqual(unresolved(result), [{ sourceText: clause, importance: "preferred" }]);
  }
});

test("scope checks retain a session or completion clause without affecting a separate campaign comparison", () => {
  for (const [campaign, unsupported, excerpt] of [
    ["The main story should take at most 35 hours.", "I need at most 2 hours per session", "at most 2 hours"],
    ["主线最多35小时。", "每次游玩不超过2小时", "不超过2小时"],
    ["The main story should take at most 35 hours.", "I need at most 2 hours for 100% completion", "at most 2 hours"],
    ["主线最多35小时。", "资料片不超过2小时", "不超过2小时"],
  ]) {
    const query = `${campaign} ${unsupported}.`;
    const criteria = [hours(campaign, "lte"), hours(excerpt, "lte", 2, "must")];
    const result = validateModelInterpretation({ ...ready, criteria }, { ...context, query });

    assert.equal(result.status, "ready", query);
    assert.deepEqual(result.criteria, [{ ...criteria[0], id: `${context.requestId}:1` }]);
    assert.deepEqual(unresolved(result), [{ sourceText: unsupported, importance: "must" }]);
  }
});

test("an explicit minimum and maximum at the same numeric bound can coexist", () => {
  const query = "The main story must take at least 35 hours and no more than 35 hours.";
  const criteria = [hours("at least 35 hours", "gte", 35, "must"), hours("no more than 35 hours", "lte", 35, "must")];
  const result = validateModelInterpretation({ ...ready, criteria }, { ...context, query });

  assert.deepEqual(result.criteria.map(({ operator }) => operator), ["gte", "lte"]);
  assert.deepEqual(unresolved(result), []);
});

test("invented whole-hour values and invalid numeric operators remain structural errors", () => {
  const query = "At least 35 hours to an ending.";
  for (const invalid of [hours(query, "gte", 50), hours(query, "gte", 35.5), hours(query, "eq"), hours("35", "gte")]) {
    assert.throws(() => validateModelInterpretation({ ...ready, criteria: [invalid] }, { ...context, query }), QueryValidationError);
  }
});
