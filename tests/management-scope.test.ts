import assert from "node:assert/strict";
import test from "node:test";
import { QueryValidationError, validateModelInterpretation } from "../lib/query-schema.ts";
import { originalQuote } from "../lib/interpretation-grounding.ts";
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

test("quote recovery is exact or uniquely equivalent in presentation", () => {
  const query = "我想要科幻题材，装备定制更好";
  assert.equal(originalQuote(query, '「科幻题材,装备定制更好」'), "科幻题材，装备定制更好");
  assert.equal(originalQuote(`${query}。${query}`, "科幻题材,装备定制更好"), undefined);
  assert.equal(originalQuote(query, "科幻题材,装备定制不好"), undefined);
  assert.equal(originalQuote("上限50小时", "上限５0小时"), undefined);
  assert.equal(originalQuote("A. B", "A。 B"), undefined);
});

test("a paraphrased equipment criterion recovers only a uniquely stated positive preference", () => {
  const hard = "如果是科幻题材，我必须能只靠一支小队打完战役";
  const preference = "无论题材，有装备定制就更好了";
  const gear = criterion("progression", "equipment", "eq", "装备自定义是加分项", "preferred");
  const reply = { ...ready, criteria: [gear] };
  const query = `${hard}。${preference}。`;
  const result = validateModelInterpretation(reply, { ...context, query });
  assert.deepEqual(result.criteria.map(({ sourceText, importance }) => [sourceText, importance]), [[preference, "preferred"]]);
  assertOnlyUnresolved(result, query, hard);

  const invalidQuote = (error: unknown) => error instanceof QueryValidationError && error.validationReason === "criterion_quote";
  for (const other of [
    `${hard}。不想要装备定制。`,
    `${hard}。如果是奇幻，装备定制更好。`,
    `${hard}。我必须要装备定制。`,
    `${hard}。${preference}。${preference}。`,
  ]) {
    assert.throws(() => validateModelInterpretation(reply, { ...context, query: other }), invalidQuote);
  }
  for (const wrong of [{ ...gear, importance: "must" }, { ...gear, operator: "neq" }, { ...gear, weight: 3 }]) {
    assert.throws(() => validateModelInterpretation({ ...ready, criteria: [wrong] }, { ...context, query }), invalidQuote);
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

test("fragments and boundary punctuation coalesce into the exact mandatory conditional", () => {
  for (const [scope, condition, consequence, separator, equipment] of [
    ["If the setting is science fiction, I need to be able to get through the campaign with just one squad",
      "If the setting is science fiction", "I need to be able to get through the campaign with just one squad", ". ",
      "Equipment customization would be nice either way"],
    ["如果是科幻题材，我必须能只靠一支小队打完战役", "如果是科幻题材", "我必须能只靠一支小队打完战役", "。",
      "无论题材，有装备定制就更好了"],
  ]) {
    const query = `${scope}${separator}${equipment}`;
    const criteria = [criterion("progression", "equipment", "eq", equipment, "preferred")];
    for (const unhandledRequirements of [
      [{ sourceText: condition, importance: "unknown" }, { sourceText: consequence, importance: "must" }],
      [{ sourceText: scope + separator, importance: "preferred" }],
      [{ sourceText: `${scope}${separator}${equipment.slice(0, 4)}`, importance: "must" }],
      [{ sourceText: `${consequence}${separator}${equipment.slice(0, 4)}`, importance: "unknown" }],
      [consequence, { sourceText: scope, importance: "must" }],
    ]) {
      const result = validateModelInterpretation({ ...ready, criteria, unhandledRequirements }, { ...context, query });

      assert.equal(result.status, "ready");
      assert.deepEqual(result.criteria.map(({ sourceText, importance }) => [sourceText, importance]), [[equipment, "preferred"]]);
      assertOnlyUnresolved(result, query, scope);
      assert.deepEqual(result.unhandledRequirements, [scope]);
    }
  }
});

test("scope coalescing keeps independent notes and wording that could refer outside the recognized clause", () => {
  const scope = "I must be able to finish with just one squad";
  const gear = "Equipment customization is a bonus";
  const sideMissions = "I prefer just one squad in side missions";
  const forecast = "I must see enemy intent before I move";
  const query = `${scope}. ${forecast}. ${gear}. ${sideMissions}.`;
  const partialOverlap = "finish with just one squad. I must see";
  const repeated = "just one squad";
  const independentNotes = [
    { sourceText: partialOverlap, importance: "unknown" },
    { sourceText: repeated, importance: "preferred" },
    { sourceText: forecast, importance: "must" },
  ];
  const unhandledRequirements = [...independentNotes, { sourceText: "I must be able to finish", importance: "must" }];
  const criteria = [criterion("progression", "equipment", "eq", gear, "preferred")];
  const result = validateModelInterpretation({ ...ready, criteria, unhandledRequirements }, { ...context, query });

  assert.deepEqual(result.criteria.map(({ sourceText }) => sourceText), [gear]);
  assert.deepEqual(result.unresolvedRequirements.map(({ sourceText, importance }) => ({ sourceText, importance })),
    [...independentNotes, { sourceText: scope, importance: "must" }]);
  assert.deepEqual(result.unhandledRequirements, [...independentNotes.map(({ sourceText }) => sourceText), scope]);
  assert.equal(new Set(result.unresolvedRequirements.map(({ id }) => id)).size, result.unresolvedRequirements.length);
});

test("group wording beyond a mandatory management clause stays only when an independent condition does not cover it", () => {
  const scope = "If the setting is science fiction, I need to be able to get through the campaign with just one squad";
  const otherBranch = "In other settings I don't mind a bigger roster";
  const equipment = "Equipment customization would be nice either way";
  const criteria = [criterion("progression", "equipment", "eq", equipment, "preferred")];
  const options = [
    { featureId: "setting", value: "scifi", operator: "neq" },
    { featureId: "structure", value: "squad", operator: "eq" },
  ];
  for (const [query, groupQuote, expected] of [
    [`${scope}. ${equipment}.`, `${scope}. `, scope],
    [`${scope}. ${equipment}.`, `${scope}. ${equipment}.`, scope],
    [`${scope}. ${otherBranch}. ${equipment}.`, `${scope}. ${otherBranch}.`, `${scope}. ${otherBranch}.`],
  ]) {
    const alternatives = [{ sourceText: groupQuote, options, importance: "must", weight: 1 }];
    const result = validateModelInterpretation({ ...ready, criteria, alternatives }, { ...context, query });

    assert.equal(result.status, "ready");
    assert.deepEqual(result.alternatives, []);
    assert.deepEqual(result.criteria.map(({ sourceText }) => sourceText), [equipment]);
    assert.deepEqual(result.unhandledRequirements, [expected]);
    assertOnlyUnresolved(result, query, expected);
  }
});
