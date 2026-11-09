import assert from "node:assert/strict";
import test from "node:test";
import { QueryValidationError, validateModelInterpretation } from "../lib/query-schema.ts";
import { TAXONOMY_VERSION } from "../lib/taxonomy.ts";

const context = {
  catalogue: [{ id: "sample", title: "Sample Tactics", aliases: [] }],
  requestId: "123e4567-e89b-42d3-a456-426614174000",
  taxonomyVersion: TAXONOMY_VERSION,
};
const ready = {
  status: "ready", criteria: [], alternatives: [], excludedGameIds: [], unhandledRequirements: [], clarification: null,
};

function requirement(featureId: string, sourceText: string, importance: "must" | "preferred" = "must") {
  return { featureId, value: true, operator: "eq", importance, weight: 1, sourceText };
}

function unresolved(result: ReturnType<typeof validateModelInterpretation>) {
  return result.unresolvedRequirements.map(({ sourceText, importance }) => ({ sourceText, importance }));
}

test("the original S08 wording and mandatory priority survive without a positioning substitute", () => {
  for (const query of [
    "I must be able to see what enemies intend to do before I commit to my move.",
    "在确认我的行动之前，必须能看到敌人的行动意图。",
  ]) {
    const result = validateModelInterpretation({ ...ready, criteria: [requirement("positioning", query)] }, { ...context, query });

    assert.equal(result.status, "unsupported", query);
    assert.deepEqual(result.criteria, []);
    assert.deepEqual(unresolved(result), [{ sourceText: query, importance: "must" }]);
    assert.deepEqual(result.unhandledRequirements, [query]);
  }
});

test("a balance preference does not become an ability-interaction criterion", () => {
  for (const query of ["I prefer well-balanced encounters.", "我更喜欢平衡的战斗。"]) {
    const result = validateModelInterpretation({ ...ready, criteria: [requirement("combos", query, "preferred")] }, { ...context, query });

    assert.equal(result.status, "unsupported", query);
    assert.deepEqual(result.criteria, []);
    assert.deepEqual(unresolved(result), [{ sourceText: query, importance: "preferred" }]);
  }
});

test("independently quoted direct mechanics stay usable beside an unresolved forecast", () => {
  for (const [positioning, combos, forecast] of [
    ["Unit placement must affect combat.", "I prefer interacting abilities.", "I must see each enemy's next action before committing."],
    ["战斗必须有走位机制。", "我更喜欢技能联动。", "确认行动前必须能看到敌人的下一步行动。"],
  ]) {
    const criteria = [requirement("positioning", positioning), requirement("combos", combos, "preferred"), requirement("positioning", forecast)];
    const query = [positioning, combos, forecast].join(" ");
    const result = validateModelInterpretation({ ...ready, criteria }, { ...context, query });

    assert.equal(result.status, "ready");
    assert.deepEqual(result.criteria.map(({ featureId, sourceText, importance }) => ({ featureId, sourceText, importance })), [
      { featureId: "positioning", sourceText: positioning, importance: "must" },
      { featureId: "combos", sourceText: combos, importance: "preferred" },
    ]);
    assert.deepEqual(unresolved(result), [{ sourceText: forecast, importance: "must" }]);
  }
});

test("an ungrounded option moves the whole choice to unresolved", () => {
  for (const query of [
    "I need either a fantasy setting or the ability to see enemy plans before acting.",
    "我需要奇幻题材，或者在行动前能看到敌人的计划。",
  ]) {
    const alternatives = [{
      sourceText: query, importance: "must", weight: 1,
      options: [{ featureId: "setting", value: "fantasy", operator: "eq" }, { featureId: "positioning", value: true, operator: "eq" }],
    }];
    const result = validateModelInterpretation({ ...ready, alternatives }, { ...context, query });

    assert.equal(result.status, "unsupported", query);
    assert.deepEqual(result.criteria, []);
    assert.deepEqual(result.alternatives, []);
    assert.deepEqual(unresolved(result), [{ sourceText: query, importance: "must" }]);
  }
});

test("a structured unresolved quote wins over the same or a contained represented quote at the stronger priority", () => {
  for (const { sourceText, represented, representedPriority, unresolvedPriority, expectedPriority } of [
    { sourceText: "Positioning must matter.", represented: "Positioning must matter.", representedPriority: "must", unresolvedPriority: "unknown", expectedPriority: "must" },
    { sourceText: "Can I see the enemy's unit placement before I commit?", represented: "unit placement", representedPriority: "preferred", unresolvedPriority: "unknown", expectedPriority: "unknown" },
    { sourceText: "我更喜欢能预览敌人的站位变化。", represented: "站位", representedPriority: "must", unresolvedPriority: "preferred", expectedPriority: "must" },
  ] as const) {
    const response = {
      ...ready, criteria: [requirement("positioning", represented, representedPriority)],
      unhandledRequirements: [{ sourceText, importance: unresolvedPriority }],
    };
    const result = validateModelInterpretation(response, { ...context, query: sourceText });

    assert.equal(result.status, "unsupported", sourceText);
    assert.deepEqual(result.criteria, []);
    assert.deepEqual(unresolved(result), [{ sourceText, importance: expectedPriority }]);
    assert.deepEqual(result.unhandledRequirements, [sourceText]);
  }
});

test("structurally invalid comparisons still fail validation instead of becoming unresolved notes", () => {
  const query = "I must see enemy plans before acting.";
  const criteria = [{ ...requirement("positioning", query), value: "fantasy" }];

  assert.throws(() => validateModelInterpretation({ ...ready, criteria }, { ...context, query }), QueryValidationError);
});

test("repeating a mechanic word inside an unresolved clause does not ground a separate criterion", () => {
  const forecast = "I must know whether positioning changes before I commit, including enemy positioning.";
  const response = {
    ...ready, criteria: [requirement("positioning", "positioning")],
    unhandledRequirements: [{ sourceText: forecast, importance: "preferred" }],
  };
  const contained = validateModelInterpretation(response, { ...context, query: forecast });
  assert.deepEqual(contained.criteria, []);
  assert.deepEqual(unresolved(contained), [{ sourceText: forecast, importance: "must" }]);

  const independent = validateModelInterpretation(response, { ...context, query: `Unit positioning must matter. ${forecast}` });
  assert.equal(independent.criteria.length, 1);
  assert.deepEqual(unresolved(independent), [{ sourceText: forecast, importance: "preferred" }]);
});
