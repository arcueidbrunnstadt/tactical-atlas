import test from "node:test";
import assert from "node:assert/strict";
import { feedbackErrorKey, normalizeLocale, searchErrorKey, translate } from "../lib/i18n.ts";
import { getCriterionLabel, getFeature, getTaxonomy, getValueLabel, TAXONOMY } from "../lib/taxonomy.ts";
import { evaluateCriterion, matchGames } from "../lib/match.ts";
import type { Criterion, GameFacet, GameRecord, SearchQuery } from "../lib/types.ts";

const evidence = { id: "S1", statement: "Source statement", basis: "source_report" as const,
  url: "https://example.com/game", locator: "Description", checkedDate: "2026-11-01", limitations: [] };
const facet = (value: GameFacet["value"], status: GameFacet["status"] = "source_supported"): GameFacet =>
  ({ value, status, evidenceIds: status === "unknown" ? [] : ["S1"] });
function game(id: string, title: string, facets: GameRecord["facets"]): GameRecord {
  return { id, title, aliases: ["中文" + id], storeUrl: "https://example.com/game", editionScope: "Base",
    summary: "Profile", facets, notes: [], tradeoffs: [], evidence: [evidence] };
}

test("locale normalization and authored interpolation have safe readable fallbacks", () => {
  for (const value of ["zh", "zh-CN", "ZH_hans", " zh-TW "]) assert.equal(normalizeLocale(value), "zh");
  for (const value of ["en", "fr", "", undefined, null, {}, ["zh"]]) assert.equal(normalizeLocale(value), "en");
  assert.equal(translate("zh", "Find games"), "寻找游戏");
  assert.equal(translate("en", "Find games"), "Find games");
  assert.equal(translate("zh", "{count} matches · {possible} need checking", { count: 0, possible: 2 }), "0 款符合条件 · 2 款待确认");
  assert.equal(translate("zh", "Unknown text {name}", { name: "value" }), "Unknown text value");
  assert.equal(translate("zh", "__proto__"), "__proto__");
});

test("localized taxonomy preserves all feature IDs, values and constraint semantics", () => {
  const before = structuredClone(TAXONOMY);
  const idsAndValues = (locale: "en" | "zh") => getTaxonomy(locale).map(f => ({ id: f.id, subjective: f.subjective, values: f.options.map(o => o.value) }));
  assert.deepEqual(idsAndValues("zh"), idsAndValues("en"));
  assert.equal(getFeature("setting", "zh")?.label, "题材");
  assert.equal(getValueLabel("setting", "fantasy", "zh"), "奇幻");
  assert.equal(getCriterionLabel({ featureId: "setting", value: "fantasy", operator: "neq" }, "zh"), "题材：排除奇幻");
  assert.equal(getCriterionLabel({ featureId: "positioning", value: true, operator: "neq" }, "zh"), "走位机制：不含走位机制");
  assert.deepEqual(TAXONOMY, before);
});

test("changing language changes explanations but not shortlist membership, order, scores or evidence", () => {
  const games = [
    game("good-b", "Bravo", { setting: facet("fantasy"), progression: facet("class_based") }),
    game("good-a", "Alpha", { setting: facet("fantasy"), progression: facet("class_based") }),
    game("provisional", "Charlie", { setting: facet("fantasy", "provisional") }),
    game("unknown", "Delta", { setting: facet(null, "unknown") }),
    game("wrong", "Echo", { setting: facet("scifi") }),
    game("exclude", "Foxtrot", { setting: facet("fantasy") }),
  ];
  const query: SearchQuery = { criteria: [
    { id: "setting", featureId: "setting", value: "fantasy", importance: "must", weight: 1 },
    { id: "build", featureId: "progression", value: "class_based", importance: "preferred", weight: 3 },
  ], excludedGameIds: ["中文exclude"], unhandledRequirements: ["Balance"] };
  const before = structuredClone({ games, query });
  const en = matchGames(games, query, "en"), zh = matchGames(games, query, "zh");
  const outcomes = (groups: typeof en) => (["matches", "possible", "excluded"] as const).map(group => [group,
    groups[group].map(({ game, score, reasons }) => ({ id: game.id, score, reasons: reasons.map(r => ({ criterionId: r.criterionId, status: r.status, evidenceIds: r.evidenceIds })) }))]);
  assert.deepEqual(outcomes(zh), outcomes(en));
  assert.deepEqual(zh.matches.map(r => r.game.id), ["good-a", "good-b"]);
  assert.match(en.matches[0].reasons[0].text, /Source-supported profile/);
  assert.match(zh.matches[0].reasons[0].text, /有来源支持/);
  assert.match(zh.possible[0].reasons[0].text, /暂定/);
  assert.equal(zh.excluded.find(r => r.game.id === "exclude")?.reasons[0].label, "已被你排除");
  assert.deepEqual({ games, query }, before);
});

test("unresolved and invalid requirements stay unknown in Chinese", () => {
  const criterion: Criterion = { id: "c", featureId: "setting", value: "fantasy", importance: "must", weight: 1 };
  const unknown = evaluateCriterion(game("g", "Game", {}), criterion, "zh");
  assert.equal(unknown.status, "unknown");
  assert.match(unknown.text, /尚不能确认/);
  const missing = evaluateCriterion(game("g", "Game", { setting: { value: "fantasy", status: "source_supported", evidenceIds: ["missing"] } }), criterion, "zh");
  assert.equal(missing.status, "unknown");
  assert.match(missing.text, /支持依据缺失/);
});

test("search and feedback failures use authored localized keys, never arbitrary server copy", () => {
  assert.equal(translate("zh", searchErrorKey("duplicate_request")), "这次请求已经提交过。你可以手动修改条件，或明确发起一次新搜索。");
  assert.match(translate("zh", feedbackErrorKey("FEEDBACK_LIMIT")), /反馈额度/);
  assert.match(translate("zh", feedbackErrorKey("FEEDBACK_ORIGIN_REJECTED")), /本站表单/);
  const arbitrary = "<script>private server detail</script>";
  assert.doesNotMatch(searchErrorKey(arbitrary), /script|private/);
  assert.doesNotMatch(feedbackErrorKey(arbitrary), /script|private/);
  assert.notEqual(translate("zh", feedbackErrorKey(arbitrary)), feedbackErrorKey(arbitrary));
});
