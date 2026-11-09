import assert from "node:assert/strict";
import test from "node:test";
import { matchGames } from "../lib/match.ts";
import type { Criterion, GameRecord, MatchResult, SearchQuery, UnresolvedRequirement } from "../lib/types.ts";

function profile(id: string, title: string, setting: "fantasy" | "scifi", aliases: string[] = []): GameRecord {
  const evidenceId = `${id}-setting`;
  const url = `https://example.com/${id}`;
  return {
    id, title, aliases, storeUrl: url, editionScope: "Base game", summary: "Synthetic profile for matcher tests.",
    facets: { setting: { value: setting, status: "source_supported", evidenceIds: [evidenceId] } },
    evidence: [{ id: evidenceId, statement: `The base game takes place in a ${setting} setting.`, basis: "source_report",
      url, locator: "Setting", checkedDate: "2026-11-08", limitations: [] }],
    notes: [], tradeoffs: [],
  };
}

const fantasy = profile("amber", "Amber Archive", "fantasy", ["琥珀档案"]);
const fantasySequel = profile("amber-2", "Amber Archive II", "fantasy", ["琥珀档案2"]);
const scienceFiction = profile("relay", "Relay Station", "scifi");
const fantasyMust: Criterion = { id: "require-fantasy", featureId: "setting", value: "fantasy", importance: "must", weight: 1 };
const fantasyPreferred: Criterion = { ...fantasyMust, id: "prefer-fantasy", importance: "preferred" };

function query(unresolvedRequirements: UnresolvedRequirement[], criteria: Criterion[] = [], excludedGameIds: string[] = []): SearchQuery {
  return { criteria, excludedGameIds, unhandledRequirements: [], unresolvedRequirements };
}

function assertUnresolvedReason(result: MatchResult, requirement: UnresolvedRequirement) {
  const reason = result.reasons.find(({ criterionId }) => criterionId === requirement.id);
  assert.ok(reason, `Expected a reason for ${requirement.id}`);
  assert.equal(reason.status, "unknown");
  assert.deepEqual(reason.evidenceIds, []);
  assert.ok(`${reason.label} ${reason.text}`.includes(requirement.sourceText), "The reason retains the player's wording.");
}

test("an unresolved English must holds a game whose supported hard criteria all match", () => {
  const must: UnresolvedRequirement = { id: "mandatory", sourceText: "I must be able to export a battle replay.", importance: "must" };
  const preferred: UnresolvedRequirement = { id: "optional", sourceText: "A built-in map editor would be nice.", importance: "preferred" };
  const result = matchGames([fantasy], query([must, preferred], [fantasyMust]), "en");

  assert.deepEqual(result.matches, []);
  assert.deepEqual(result.excluded, []);
  assert.deepEqual(result.possible.map(({ game }) => game.id), [fantasy.id]);
  assert.equal(result.possible[0].reasons.find(({ criterionId }) => criterionId === fantasyMust.id)?.status, "match");
  assertUnresolvedReason(result.possible[0], must);
  assertUnresolvedReason(result.possible[0], preferred);
});

test("an unresolved Chinese must holds even when no structured criteria were extracted", () => {
  const requirement: UnresolvedRequirement = { id: "必须", sourceText: "必须能在战斗中保存并退出。", importance: "must" };
  const result = matchGames([fantasy], query([requirement]), "zh");

  assert.deepEqual(result.matches, []);
  assert.deepEqual(result.excluded, []);
  assert.deepEqual(result.possible.map(({ game }) => game.id), [fantasy.id]);
  assertUnresolvedReason(result.possible[0], requirement);
});

test("an unresolved preference adds an unknown reason without affecting group, score or order", () => {
  const requirement: UnresolvedRequirement = { id: "optional", sourceText: "最好能自己制作关卡。", importance: "preferred" };
  const games = [scienceFiction, fantasy];
  const base = matchGames(games, query([], [fantasyPreferred]), "zh");
  const result = matchGames(games, query([requirement], [fantasyPreferred]), "zh");

  assert.deepEqual(result.matches.map(({ game, score }) => [game.id, score]), base.matches.map(({ game, score }) => [game.id, score]));
  assert.deepEqual(result.possible, []);
  assert.deepEqual(result.excluded, []);
  for (const match of result.matches) assertUnresolvedReason(match, requirement);
});

test("unknown priority holds until the player marks the requirement preferred or removes it", () => {
  const requirement: UnresolvedRequirement = { id: "interruptions", sourceText: "I usually have to stop without warning.", importance: "unknown" };
  const original = query([requirement]);
  const held = matchGames([fantasy], original);
  assert.deepEqual(held.matches, []);
  assert.deepEqual(held.excluded, []);
  assert.deepEqual(held.possible.map(({ game }) => game.id), [fantasy.id]);
  assertUnresolvedReason(held.possible[0], requirement);

  const preferred = { ...requirement, importance: "preferred" as const };
  const reclassified = matchGames([fantasy], { ...original, unresolvedRequirements: [preferred] });
  assert.deepEqual(reclassified.matches.map(({ game }) => game.id), [fantasy.id]);
  assert.deepEqual(reclassified.possible, []);
  assertUnresolvedReason(reclassified.matches[0], preferred);

  const removed = matchGames([fantasy], { ...original, unresolvedRequirements: [] });
  assert.deepEqual(removed.matches.map(({ game }) => game.id), [fantasy.id]);
  assert.deepEqual(removed.matches[0].reasons, []);
  assert.equal(original.unresolvedRequirements?.[0].importance, "unknown");
});

test("a documented hard conflict and exact title exclusion take precedence over an unresolved must", () => {
  const requirement: UnresolvedRequirement = { id: "mandatory", sourceText: "必须能导出战斗回放。", importance: "must" };
  const result = matchGames([fantasy, fantasySequel, scienceFiction], query([requirement], [fantasyMust], ["琥珀档案"]), "zh");

  assert.deepEqual(result.matches, []);
  assert.deepEqual(result.possible.map(({ game }) => game.id), [fantasySequel.id]);
  assertUnresolvedReason(result.possible[0], requirement);
  assert.deepEqual(new Set(result.excluded.map(({ game }) => game.id)), new Set([fantasy.id, scienceFiction.id]));
  assert.equal(result.excluded.find(({ game }) => game.id === fantasy.id)?.reasons[0].criterionId, "excluded-game");
  const conflict = result.excluded.find(({ game }) => game.id === scienceFiction.id);
  assert.equal(conflict?.reasons.find(({ criterionId }) => criterionId === fantasyMust.id)?.status, "mismatch");
});
