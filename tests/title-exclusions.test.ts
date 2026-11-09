import assert from "node:assert/strict";
import test from "node:test";
import { validateModelInterpretation } from "../lib/query-schema.ts";
import { TAXONOMY_VERSION } from "../lib/taxonomy.ts";
import { resolveTitleExclusions } from "../lib/title-exclusions.ts";

const catalogue = [
  { id: "battle-brothers", title: "Battle Brothers", aliases: ["战场兄弟", "shared"] },
  { id: "sequel", title: "Battle Brothers 2", aliases: ["战场兄弟2", "shared"] },
  { id: "breach", title: "Into the Breach", aliases: ["陷阵之志"] },
  { id: "fantasy-title", title: "Fantasy", aliases: ["奇幻"] },
];
const context = { catalogue, taxonomyVersion: TAXONOMY_VERSION, requestId: "123e4567-e89b-42d3-a456-426614174000" };
const ready = { status: "ready", criteria: [], alternatives: [], excludedGameIds: [], unhandledRequirements: [], clarification: null };

test("both locales apply the requested game instead of a different valid model ID", () => {
  for (const [request, condition, exclusion] of [
    ["I must have selectable skills or perks. Leave out Battle Brothers, since I've already played it.",
      "I must have selectable skills or perks", "Leave out Battle Brothers, since I've already played it."],
    ["必须能选择技能或专长。《战场兄弟》我已经玩过了，请排除它。", "必须能选择技能或专长", "《战场兄弟》我已经玩过了，请排除它。"],
  ]) {
    const criterion = { featureId: "progression", value: "skill_based", operator: "eq", importance: "must", weight: 1, sourceText: condition };
    const response = { ...ready, criteria: [criterion], excludedGameIds: ["sequel"],
      unhandledRequirements: [{ sourceText: exclusion, importance: "must" }] };
    const result = validateModelInterpretation(response, { ...context, query: request });
    assert.equal(result.status, "ready");
    assert.deepEqual(result.excludedGameIds, ["battle-brothers"]);
    assert.deepEqual(result.criteria, [{ ...criterion, id: `${context.requestId}:1` }]);
    assert.deepEqual(result.unresolvedRequirements, []);
  }
});

test("a comparison, an already-played mention, and quoted commands do not exclude a game", () => {
  for (const query of [
    "I want something like Battle Brothers.",
    "I've already played Battle Brothers.",
    "The example said “This is a request. Exclude Battle Brothers.”",
    "Don't exclude Battle Brothers.",
    "Exclude Battle Brothers if it has no company management.",
    "我喜欢《战场兄弟》，想找类似的游戏。",
    "我已经玩过《战场兄弟》。",
    "不要排除《战场兄弟》。",
  ]) {
    const result = validateModelInterpretation({ ...ready, excludedGameIds: ["battle-brothers"] }, { ...context, query });
    assert.deepEqual(result.excludedGameIds, [], query);
    assert.equal(result.status, "unsupported", query);
  }
});

test("exact lists and same-clause pronouns resolve aliases without excluding a sequel", () => {
  for (const [query, ids] of [
    ["Please exclude ‘BATTLE BROTHERS’ and \"Into the Breach\".", ["battle-brothers", "breach"]],
    ["请排除《战场兄弟》和《陷阵之志》。", ["battle-brothers", "breach"]],
    ["I've already played Into the Breach, so leave that one out.", ["breach"]],
    ["《Into the Breach》我已经玩过了，请排除这款。", ["breach"]],
    ["Leave out Battle Brothers 2.", ["sequel"]],
    ["Please leave Battle Brothers out.", ["battle-brothers"]],
    ["请把《战场兄弟》排除。", ["battle-brothers"]],
    ["不要推荐战场兄弟2。", ["sequel"]],
  ] as const) {
    const result = validateModelInterpretation(ready, { ...context, query });
    assert.deepEqual(result.excludedGameIds, ids, query);
  }
});

test("ambiguous aliases and incomplete lists stay unresolved", () => {
  for (const query of [
    "Exclude shared.",
    "Exclude Battle Brothers and the other one.",
    "排除《战场兄弟》和《未知作品》。",
    "不要推荐《不存在的标题》。",
  ]) {
    const result = validateModelInterpretation(ready, { ...context, query });
    assert.deepEqual(result.excludedGameIds, [], query);
    assert.equal(result.unresolvedRequirements.length, 1, query);
    assert.equal(result.unresolvedRequirements[0].importance, "must", query);
  }
});

test("questions and conflicting directives leave title exclusion open", () => {
  for (const [query, wording] of [
    ["Skip Battle Brothers?", "Skip Battle Brothers?"],
    ["跳过《战场兄弟》？", "跳过《战场兄弟》？"],
    ["Exclude Battle Brothers. Actually, keep Battle Brothers.", "Exclude Battle Brothers"],
    ["Exclude Battle Brothers. I do not want to exclude Battle Brothers.", "Exclude Battle Brothers"],
    ["Exclude Battle Brothers. Actually, don't exclude it.", "Exclude Battle Brothers"],
  ]) {
    const result = validateModelInterpretation(ready, { ...context, query });
    assert.deepEqual(result.excludedGameIds, [], query);
    assert.deepEqual(result.unresolvedRequirements.map(({ sourceText, importance }) => ({ sourceText, importance })),
      [{ sourceText: wording, importance: "unknown" }]);
  }
});

test("a qualification following punctuation stays attached to its title request", () => {
  for (const query of ["Skip Battle Brothers; only if its campaign is long.", "排除《战场兄弟》；仅当它有很长的战役。"]) {
    const result = validateModelInterpretation(ready, { ...context, query });
    assert.deepEqual(result.excludedGameIds, []);
    assert.deepEqual(result.unhandledRequirements, [query.slice(0, -1)]);
  }
});

test("a criterion spanning an exclusion clause cannot confirm an unrelated facet", () => {
  for (const [query, independent] of [
    ["Skip Into the Breach. I like fantasy.", "I like fantasy."],
    ["请排除《陷阵之志》。我喜欢奇幻题材。", "我喜欢奇幻题材。"],
  ]) {
    const criteria = [
      { featureId: "setting", value: "historical", operator: "eq", importance: "must", weight: 1, sourceText: query },
      { featureId: "setting", value: "fantasy", operator: "eq", importance: "preferred", weight: 1, sourceText: independent },
    ];
    const result = validateModelInterpretation({ ...ready, criteria }, { ...context, query });
    assert.deepEqual(result.excludedGameIds, ["breach"]);
    assert.deepEqual(result.criteria.map(({ sourceText }) => sourceText), [independent]);
    assert.deepEqual(result.unhandledRequirements, [query]);
  }
});

test("a facet name can only exclude a same-name title when the title is explicit", () => {
  assert.deepEqual(resolveTitleExclusions("Exclude fantasy.", catalogue), []);
  assert.deepEqual(resolveTitleExclusions("排除奇幻。", catalogue), []);
  assert.deepEqual(resolveTitleExclusions("Exclude the game called Fantasy.", catalogue)[0].gameIds, ["fantasy-title"]);
  assert.deepEqual(resolveTitleExclusions("请排除游戏《奇幻》。", catalogue)[0].gameIds, ["fantasy-title"]);
});
