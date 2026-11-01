import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathLocale, preferredLocale, localeMetadata } from "../lib/locale-routing.ts";
import { localizeGame, type GameTranslations } from "../lib/catalogue-localization.ts";
import { matchGames } from "../lib/match.ts";
import type { GameRecord, SearchQuery } from "../lib/types.ts";

test("explicit language links override saved and browser preferences", () => {
  assert.equal(preferredLocale("/zh", "en", "en-US"), "zh");
  assert.equal(preferredLocale("/en/", "zh", "zh-CN"), "en");
  assert.equal(pathLocale("/zh/not-a-page"), null);
  assert.equal(pathLocale("/api/interpret"), null);
});

test("root honors a supported saved preference and weighted browser choices", () => {
  assert.equal(preferredLocale("/", "zh", "en-US"), "zh");
  assert.equal(preferredLocale("/", "bogus", "fr;q=1,en;q=0.5,zh-CN;q=0.9"), "zh");
  assert.equal(preferredLocale("/", null, "zh;q=0,en;q=0.8"), "en");
  assert.equal(preferredLocale("/", null, "fr,de"), "en");
});

test("metadata identifies each shareable language page", () => {
  assert.equal(localeMetadata("zh").alternates.canonical, "/zh");
  assert.equal(localeMetadata("en").alternates.canonical, "/en");
  assert.match(localeMetadata("zh").title, /寻找/);
});

test("translated profiles preserve matching facts, identities and evidence URLs", () => {
  const data = JSON.parse(readFileSync(new URL("../public/catalogue.json", import.meta.url), "utf8"));
  const games = (Array.isArray(data) ? data : data.games) as GameRecord[];
  const translations = JSON.parse(readFileSync(new URL("../public/catalogue.zh.json", import.meta.url), "utf8")) as GameTranslations;
  const query: SearchQuery = { criteria: [{ id: "fantasy", featureId: "setting", value: "fantasy", importance: "preferred", weight: 3 }], excludedGameIds: [], unhandledRequirements: [] };
  const english = matchGames(games, query, "en");
  const chinese = matchGames(games, query, "zh");
  for (const group of ["matches", "possible", "excluded"] as const) {
    assert.deepEqual(chinese[group].map(({ game, score }) => [game.id, score]), english[group].map(({ game, score }) => [game.id, score]));
  }
  for (const game of games) {
    const translated = localizeGame(game, "zh", translations);
    assert.equal(translated.id, game.id);
    assert.equal(translated.facets, game.facets);
    assert.equal(translated.storeUrl, game.storeUrl);
    assert.deepEqual(translated.evidence.map(({ id, url }) => [id, url]), game.evidence.map(({ id, url }) => [id, url]));
    assert.equal(localizeGame(game, "en", translations), game);
  }
});
