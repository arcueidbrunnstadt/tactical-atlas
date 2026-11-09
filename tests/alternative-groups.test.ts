import assert from "node:assert/strict";
import test from "node:test";
import { matchGames } from "../lib/match.ts";
import type { AlternativeGroup, Criterion, GameFacet, GameRecord, MatchResult, SearchQuery } from "../lib/types.ts";

function profile(id: string, values: Record<string, string | string[] | boolean>, aliases: string[] = []): GameRecord {
  const evidenceId = `${id}-rules`;
  const url = `https://example.com/${id}`;
  const facets: Record<string, GameFacet> = {};
  for (const [featureId, value] of Object.entries(values)) {
    facets[featureId] = { value, status: "source_supported", evidenceIds: [evidenceId] };
  }
  return {
    id, title: id, aliases, storeUrl: url, editionScope: "Base edition", summary: "Synthetic profile for matcher tests.",
    facets, notes: [], tradeoffs: [], evidence: [{
      id: evidenceId, statement: `Base game features: ${JSON.stringify(values)}.`, basis: "source_report",
      url, locator: "Rules summary", checkedDate: "2026-11-08", limitations: [],
    }],
  };
}

const eitherSetting: AlternativeGroup = {
  id: "settings", sourceText: "The setting must be either fantasy or science fiction.", importance: "must", weight: 1,
  options: [
    { featureId: "setting", value: "fantasy", operator: "eq" },
    { featureId: "setting", value: "scifi", operator: "eq" },
  ],
};

const fantasyOrPositioning: AlternativeGroup = {
  id: "fantasy-or-positioning", importance: "must", weight: 1,
  options: [
    { featureId: "setting", value: "fantasy", operator: "eq" },
    { featureId: "positioning", value: true, operator: "eq" },
  ],
};

function query(alternatives: AlternativeGroup[], criteria: Criterion[] = [], excludedGameIds: string[] = []): SearchQuery {
  return { criteria, excludedGameIds, unhandledRequirements: [], alternatives };
}

function ids(results: MatchResult[]): string[] {
  return results.map(({ game }) => game.id).sort();
}

test("either documented setting satisfies the same required alternative in English and Chinese", () => {
  const games = [
    profile("fantasy", { setting: "fantasy" }),
    profile("sci-fi", { setting: "scifi" }),
    profile("both", { setting: ["fantasy", "scifi"] }),
    profile("historical", { setting: "historical" }),
  ];

  for (const [locale, sourceText] of [
    ["en", eitherSetting.sourceText], ["zh", "题材必须是奇幻或科幻，满足其一即可。"],
  ] as const) {
    const result = matchGames(games, query([{ ...eitherSetting, sourceText }]), locale);
    assert.deepEqual(ids(result.matches), ["both", "fantasy", "sci-fi"], locale);
    assert.deepEqual(ids(result.excluded), ["historical"], locale);
    assert.equal(result.possible.length, 0, locale);
  }
});

test("an unanswered option keeps a required alternative possible unless another option already passes", () => {
  const games = [
    profile("one passes", { setting: "fantasy" }),
    profile("one conflicts", { setting: "historical" }),
    profile("both conflict", { setting: "historical", positioning: false }),
    profile("both unknown", {}),
  ];
  const result = matchGames(games, query([fantasyOrPositioning]));

  assert.deepEqual(ids(result.matches), ["one passes"]);
  assert.deepEqual(ids(result.possible), ["both unknown", "one conflicts"]);
  assert.deepEqual(ids(result.excluded), ["both conflict"]);
});

test("an independent must-have and exact title exclusion still apply to grouped alternatives", () => {
  const games = [
    profile("game", { setting: "fantasy", combos: true }, ["银塔"]),
    profile("sequel", { setting: "scifi", combos: true }, ["银塔2"]),
    profile("known conflict", { setting: "scifi", combos: false }),
    profile("known conflict with open group", { combos: false }),
    profile("independent unknown", { setting: "fantasy" }),
    profile("group unknown", { combos: true }),
  ];
  const needsCombos: Criterion = { id: "combos", featureId: "combos", value: true, importance: "must", weight: 1 };
  const result = matchGames(games, query([eitherSetting], [needsCombos], ["银塔"]), "zh");

  assert.deepEqual(ids(result.matches), ["sequel"]);
  assert.deepEqual(ids(result.possible), ["group unknown", "independent unknown"]);
  assert.deepEqual(ids(result.excluded), ["game", "known conflict", "known conflict with open group"]);
  assert.equal(result.excluded.find(({ game }) => game.id === "game")?.reasons[0].criterionId, "excluded-game");
});

test("a preferred alternative contributes the best fit once and never excludes", () => {
  const games = [
    profile("one match", { setting: "fantasy", positioning: false }),
    profile("two matches", { setting: "fantasy", positioning: true }),
    profile("one unknown", { setting: "historical" }),
    profile("both mismatch", { setting: "historical", positioning: false }),
  ];
  const result = matchGames(games, query([{ ...fantasyOrPositioning, importance: "preferred", weight: 3 }]));

  assert.deepEqual(Object.fromEntries(result.matches.map(({ game, score }) => [game.id, score])), {
    "one match": 6, "two matches": 6, "one unknown": 0, "both mismatch": -6,
  });
  assert.equal(result.possible.length, 0);
  assert.equal(result.excluded.length, 0);
});
