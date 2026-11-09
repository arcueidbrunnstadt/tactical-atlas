import assert from "node:assert/strict";
import test from "node:test";
import { validateModelInterpretation } from "../lib/query-schema.ts";
import { TAXONOMY_VERSION } from "../lib/taxonomy.ts";

const context = {
  catalogue: [{ id: "sample", title: "Sample Tactics", aliases: [] }],
  requestId: "123e4567-e89b-42d3-a456-426614174000",
  taxonomyVersion: TAXONOMY_VERSION,
};
const ready = {
  status: "ready", criteria: [], alternatives: [], excludedGameIds: [], unhandledRequirements: [], clarification: null,
};

function criterion(featureId: string, value: string, operator: "eq" | "neq", sourceText: string, importance: "must" | "preferred" = "must") {
  return { featureId, value, operator, sourceText, importance, weight: 1 };
}

function assertOnlyUnresolved(result: ReturnType<typeof validateModelInterpretation>, query: string, clause: string) {
  assert.equal(result.unresolvedRequirements.length, 1, query);
  const [note] = result.unresolvedRequirements;
  assert.ok(query.includes(note.sourceText), "The note remains an exact quote from the request.");
  assert.equal(note.sourceText.replace(/[.;。；]$/u, ""), clause.replace(/[.;。；]$/u, ""), query);
  assert.equal(note.importance, "must", query);
  assert.deepEqual(result.unhandledRequirements, [note.sourceText]);
}

test("an underquoted obligation preserves the full clause and leaves an independent comma-delimited must intact", () => {
  for (const [clause, quote, separator, history] of [
    ["I won't play anything that makes me manage a whole company across the campaign", "manage a whole company", ", and ", "I also need a historical setting"],
    ["如果整个战役都得管理一整支佣兵团，我就不考虑", "管理一整支佣兵团", "，另外", "必须是历史题材"],
  ]) {
    const query = `${clause}${separator}${history}.`;
    const criteria = [criterion("structure", "company", "neq", quote), criterion("setting", "historical", "eq", history)];
    const result = validateModelInterpretation({ ...ready, criteria }, { ...context, query });

    assert.equal(result.status, "ready", query);
    assert.deepEqual(result.criteria.map(({ featureId, sourceText }) => [featureId, sourceText]), [["setting", history]]);
    assertOnlyUnresolved(result, query, clause);
  }
});

test("both an either-or proxy and flattened filters leave a scoped conditional requirement unresolved", () => {
  for (const [clause, antecedent, consequent, equipment, separator] of [
    ["If it's science fiction, I must be able to stick to one small squad", "science fiction", "one small squad", "I'd prefer to customize equipment either way", ". "],
    ["如果是科幻题材，我必须能只带一支小队", "科幻题材", "一支小队", "不管什么题材，最好都能改装装备", "；"],
  ]) {
    const query = `${clause}${separator}${equipment}.`;
    const gear = criterion("progression", "equipment", "eq", equipment, "preferred");
    const options = [
      { featureId: "setting", value: "scifi", operator: "neq" },
      { featureId: "structure", value: "squad", operator: "eq" },
    ];
    for (const body of [
      { ...ready, criteria: [gear], alternatives: [{ sourceText: clause, options, importance: "must", weight: 1 }] },
      { ...ready, criteria: [criterion("setting", "scifi", "eq", antecedent), criterion("structure", "squad", "eq", consequent), gear] },
    ]) {
      const result = validateModelInterpretation(body, { ...context, query });

      assert.equal(result.status, "ready", query);
      assert.deepEqual(result.alternatives, []);
      assert.deepEqual(result.criteria.map(({ featureId, sourceText, importance }) => [featureId, sourceText, importance]), [["progression", equipment, "preferred"]]);
      assertOnlyUnresolved(result, query, clause);
    }
  }
});

test("optional management and finishing with only one squad are not broad structure filters", () => {
  for (const [clause, quote, value, operator] of [
    ["A company layer is fine, but only if I can skip it", "A company layer", "company", "neq"],
    ["有佣兵团经营也可以，但前提是能完全跳过", "佣兵团经营", "company", "eq"],
    ["I must be able to finish every story mission with just one squad", "one squad", "squad", "eq"],
    ["必须能从头到尾只靠一支小队打完主线任务", "一支小队", "squad", "eq"],
  ] as const) {
    const query = `${clause}.`;
    const criteria = [criterion("structure", value, operator, quote)];
    const result = validateModelInterpretation({ ...ready, criteria }, { ...context, query });

    assert.equal(result.status, "unsupported", query);
    assert.deepEqual(result.criteria, [], query);
    assertOnlyUnresolved(result, query, clause);
  }
});

test("a broader unresolved quote absorbs a contradictory broad filter without losing its stronger priority", () => {
  const clause = "I won't play a game that forces me to manage an entire company between missions";
  const query = `${clause}.`;
  const result = validateModelInterpretation({
    ...ready, criteria: [criterion("structure", "company", "neq", "manage an entire company")],
    unhandledRequirements: [{ sourceText: clause, importance: "preferred" }],
  }, { ...context, query });

  assert.equal(result.status, "unsupported");
  assert.deepEqual(result.criteria, []);
  assertOnlyUnresolved(result, query, clause);
});

test("ordinary player priority and direct company exclusion stay representable in both languages", () => {
  for (const [query, value, operator] of [
    ["My only requirement is to command a squad.", "squad", "eq"],
    ["我唯一的硬性要求是能指挥一支小队。", "squad", "eq"],
    ["我必须指挥一支小队。", "squad", "eq"],
    ["Please exclude games with company management.", "company", "neq"],
    ["请排除有佣兵团管理的游戏。", "company", "neq"],
  ] as const) {
    const criteria = [criterion("structure", value, operator, query)];
    const result = validateModelInterpretation({ ...ready, criteria }, { ...context, query });

    assert.equal(result.status, "ready", query);
    assert.deepEqual(result.criteria, [{ ...criteria[0], id: `${context.requestId}:1` }]);
    assert.deepEqual(result.unresolvedRequirements, []);
  }
});

test("a quote that crosses an unsupported scope boundary cannot confirm a broad squad filter", () => {
  for (const [scope, crossingQuote, history, query] of [
    ["I must be able to finish with only one squad", "only one squad, and I also need a historical setting", "I also need a historical setting", "I must be able to finish with only one squad, and I also need a historical setting."],
    ["我必须能只带一支小队", "只带一支小队，另外必须是历史题材", "必须是历史题材", "我必须能只带一支小队，另外必须是历史题材。"],
  ]) {
    const criteria = [criterion("structure", "squad", "eq", crossingQuote), criterion("setting", "historical", "eq", history)];
    const result = validateModelInterpretation({ ...ready, criteria }, { ...context, query });
    assert.deepEqual(result.criteria.map(({ sourceText }) => sourceText), [history]);
    assertOnlyUnresolved(result, query, scope);
  }
});

test("required management stays unresolved whether the provider broadens or drops the condition", () => {
  for (const [scope, management, story] of [
    ["I will not play a game where roster management is required", "roster management", "I prefer an open campaign"],
    ["如果阵容管理是强制的，我就不玩", "阵容管理", "我更喜欢开放式战役"],
  ]) {
    const query = `${scope}. ${story}.`;
    const preferred = criterion("campaign", "open", "eq", story, "preferred");
    for (const criteria of [[preferred], [criterion("structure", "company", "neq", management), preferred]]) {
      const result = validateModelInterpretation({ ...ready, criteria }, { ...context, query });
      assert.deepEqual(result.criteria.map(({ sourceText }) => sourceText), [story]);
      assertOnlyUnresolved(result, query, scope);
    }
  }
});
