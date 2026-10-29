import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCriterion, matchGames } from "../lib/match.ts";
import { getCriterionLabel, getFeature, isAllowedValue, TAXONOMY_VERSION } from "../lib/taxonomy.ts";
import type { Criterion, GameFacet, GameRecord, SearchQuery } from "../lib/types.ts";

const evidence = {
  id: "source-1", statement: "A bounded description from the source.", basis: "source_report" as const,
  url: "https://example.com/game", locator: "Features", checkedDate: "2026-10-29", limitations: ["Not a gameplay test."],
};
function facet(value: GameFacet["value"], status: GameFacet["status"] = "source_supported"): GameFacet {
  return { value, status, evidenceIds: status === "unknown" ? [] : [evidence.id] };
}
function game(id: string, facets: Record<string, GameFacet> = {}, title = id): GameRecord {
  return { id, title, aliases: [], storeUrl: evidence.url, editionScope: "Base game", summary: "Test profile", facets, notes: [], tradeoffs: [], evidence: [evidence] };
}
function criterion(featureId: string, value: Criterion["value"], importance: Criterion["importance"] = "must", weight: 1 | 3 = 1): Criterion {
  return { id: `${featureId}-${String(value)}-${importance}`, featureId, value, importance, weight };
}
function query(criteria: Criterion[] = [], excludedGameIds: string[] = []): SearchQuery {
  return { criteria, excludedGameIds, unhandledRequirements: [] };
}

test("blank criteria browse alphabetically without mutating the catalogue", () => {
  const games = [game("z", {}, "Zebra"), game("a", {}, "Alpha")];
  const before = structuredClone(games);
  const result = matchGames(games, query());
  assert.deepEqual(result.matches.map((item) => item.game.id), ["a", "z"]);
  assert.equal(result.possible.length, 0);
  assert.equal(result.excluded.length, 0);
  assert.deepEqual(games, before);
});

test("a hard constraint separates supported match, mismatch and missing evidence", () => {
  const games = [game("fantasy", { setting: facet("fantasy") }), game("scifi", { setting: facet("scifi") }), game("unknown")];
  const result = matchGames(games, query([criterion("setting", "fantasy")]));
  assert.deepEqual(result.matches.map((item) => item.game.id), ["fantasy"]);
  assert.deepEqual(result.excluded.map((item) => item.game.id), ["scifi"]);
  assert.deepEqual(result.possible.map((item) => item.game.id), ["unknown"]);
});

test("negative boolean preference matches explicit false, never mere absence", () => {
  const result = matchGames([
    game("absent"), game("explicit-no", { narrative: facet(false) }), game("yes", { narrative: facet(true) }),
  ], query([criterion("narrative", false)]));
  assert.deepEqual(result.matches.map((item) => item.game.id), ["explicit-no"]);
  assert.deepEqual(result.possible.map((item) => item.game.id), ["absent"]);
  assert.deepEqual(result.excluded.map((item) => item.game.id), ["yes"]);
});

test("avoid fantasy preserves categorical negation across supported and unknown records", () => {
  const avoidFantasy: Criterion = { ...criterion("setting", "fantasy"), operator: "neq" };
  const result = matchGames([
    game("fantasy", { setting: facet("fantasy") }),
    game("scifi", { setting: facet("scifi") }),
    game("unknown", { setting: facet(null, "unknown") }),
  ], query([avoidFantasy]));
  assert.deepEqual(result.matches.map((item) => item.game.id), ["scifi"]);
  assert.deepEqual(result.excluded.map((item) => item.game.id), ["fantasy"]);
  assert.deepEqual(result.possible.map((item) => item.game.id), ["unknown"]);
  assert.equal(result.matches[0].reasons[0].label, "Setting: Exclude Fantasy");
});

test("soft categorical negation changes ordering without creating an exclusion", () => {
  const avoidFantasy: Criterion = { ...criterion("setting", "fantasy", "preferred"), operator: "neq" };
  const result = matchGames([
    game("fantasy", { setting: facet("fantasy") }),
    game("scifi", { setting: facet("scifi") }),
    game("unknown"),
  ], query([avoidFantasy]));
  assert.deepEqual(result.matches.map((item) => item.game.id), ["scifi", "unknown", "fantasy"]);
  assert.deepEqual(result.matches.map((item) => item.score), [2, 0, -2]);
  assert.equal(result.excluded.length, 0);
});

test("negation cannot turn missing evidence or provisional hard support into certainty", () => {
  const avoidPositioning: Criterion = { ...criterion("positioning", true), operator: "neq" };
  for (const record of [
    game("missing"),
    game("unknown-value", { positioning: facet(true, "unknown") }),
    game("provisional-yes", { positioning: facet(true, "provisional") }),
    game("provisional-no", { positioning: facet(false, "provisional") }),
  ]) {
    assert.equal(evaluateCriterion(record, avoidPositioning).status, "unknown");
  }
  assert.equal(evaluateCriterion(game("known-no", { positioning: facet(false) }), avoidPositioning).status, "match");
  assert.equal(evaluateCriterion(game("known-yes", { positioning: facet(true) }), avoidPositioning).status, "mismatch");
});

test("an unknown status stays unknown even if a legacy value is present", () => {
  const record = game("legacy", { offline: facet(true, "unknown") });
  assert.equal(evaluateCriterion(record, criterion("offline", true)).status, "unknown");
  assert.equal(evaluateCriterion(record, criterion("offline", false)).status, "unknown");
});

test("provisional assessments cannot satisfy or disprove a hard requirement", () => {
  const records = [game("provisional-yes", { combos: facet(true, "provisional") }), game("provisional-no", { combos: facet(false, "provisional") })];
  const result = matchGames(records, query([criterion("combos", true)]));
  assert.equal(result.matches.length, 0);
  assert.equal(result.excluded.length, 0);
  assert.equal(result.possible.length, 2);
  assert.ok(result.possible.every((item) => item.reasons[0].text.includes("provisional")));
});

test("a documented mismatch excludes even when another hard requirement is unknown", () => {
  const result = matchGames([game("scifi", { setting: facet("scifi") })], query([criterion("setting", "fantasy"), criterion("offline", true)]));
  assert.equal(result.excluded.length, 1);
  assert.equal(result.possible.length, 0);
});

test("soft preferences change ordering without excluding games", () => {
  const games = [game("alpha", { campaign: facet("open"), narrative: facet(false) }), game("zeta", { campaign: facet("compact"), narrative: facet(true) })];
  const first = matchGames(games, query([criterion("campaign", "open", "preferred")]));
  const second = matchGames(games, query([criterion("narrative", true, "preferred")]));
  assert.deepEqual(first.matches.map((item) => item.game.id), ["alpha", "zeta"]);
  assert.deepEqual(second.matches.map((item) => item.game.id), ["zeta", "alpha"]);
  assert.equal(first.excluded.length + second.excluded.length, 0);
});

test("a visible priority weight wins a conflict between preferences", () => {
  const games = [game("a", { narrative: facet(true), positioning: facet(false) }), game("z", { narrative: facet(false), positioning: facet(true) })];
  const result = matchGames(games, query([criterion("narrative", true, "preferred"), criterion("positioning", true, "preferred", 3)]));
  assert.equal(result.matches[0].game.id, "z");
  assert.equal(result.matches[0].score, 4);
});

test("provisional soft support is labelled and does not invent a hard pass", () => {
  const result = matchGames([game("noted", { narrative: facet(true, "provisional") }), game("unassessed")], query([criterion("narrative", true, "preferred")]));
  assert.equal(result.matches[0].score, 2);
  assert.match(result.matches[0].reasons[0].text, /^Provisional profile assessment/);
  assert.equal(result.matches[1].score, 0);
});

test("exact title and alias exclusions do not remove a sequel by prefix", () => {
  const original = game("original", {}, "Example Tactics");
  original.aliases = ["ET Original"];
  const sequel = game("sequel", {}, "Example Tactics 2");
  const result = matchGames([original, sequel], query([], ["  et original  "]));
  assert.deepEqual(result.matches.map((item) => item.game.id), ["sequel"]);
  assert.deepEqual(result.excluded.map((item) => item.game.id), ["original"]);
  assert.equal(matchGames([original, sequel], query([], ["Example"])).matches.length, 2);
});

test("multiple recorded facet values can each match without modifying them", () => {
  const record = game("hybrid", { progression: facet(["class_based", "equipment"]) });
  assert.equal(evaluateCriterion(record, criterion("progression", "class_based")).status, "match");
  assert.equal(evaluateCriterion(record, criterion("progression", "equipment")).status, "match");
  assert.deepEqual(record.facets.progression.value, ["class_based", "equipment"]);
});

test("missing and dangling evidence are unresolved, not factual matches", () => {
  const record = game("broken", { positioning: { value: true, status: "source_supported", evidenceIds: ["missing"] } });
  assert.equal(evaluateCriterion(record, criterion("positioning", true)).status, "unknown");
  record.facets.positioning.evidenceIds = [];
  assert.equal(evaluateCriterion(record, criterion("positioning", true)).status, "unknown");
});

test("unsupported criteria and values remain unknown instead of filtering out the catalogue", () => {
  const record = game("example", { setting: facet("fantasy") });
  assert.equal(evaluateCriterion(record, criterion("setting", "balanced")).status, "unknown");
  assert.equal(evaluateCriterion(record, criterion("global_quality", true)).status, "unknown");
  assert.equal(isAllowedValue("setting", "fantasy"), true);
  assert.equal(isAllowedValue("offline", "true"), false);
});

test("duplicate equivalent preferences cannot amplify their score", () => {
  const record = game("example", { narrative: facet(true) });
  const wanted = criterion("narrative", true, "preferred");
  const result = matchGames([record], query([wanted, { ...wanted, id: "duplicate", operator: "eq" }]));
  assert.equal(result.matches[0].score, 2);
  assert.equal(result.matches[0].reasons.length, 1);
});

test("opposite operators remain distinct when equivalent preferences are deduplicated", () => {
  const wanted = criterion("setting", "fantasy", "preferred");
  const avoided: Criterion = { ...wanted, id: "avoid-fantasy", operator: "neq" };
  const result = matchGames([game("fantasy", { setting: facet("fantasy") })], query([wanted, avoided]));
  assert.equal(result.matches[0].score, 0);
  assert.deepEqual(result.matches[0].reasons.map((reason) => reason.status), ["match", "mismatch"]);
});

test("relevant criterion coverage breaks score ties without counting source volume", () => {
  const unknown = game("a", {}, "Alpha");
  const known = game("z", { narrative: facet(true), positioning: facet(false) }, "Zeta");
  known.evidence.push({ ...evidence, id: "extra" });
  const result = matchGames([unknown, known], query([criterion("narrative", true, "preferred"), criterion("positioning", true, "preferred")]));
  assert.equal(result.matches[0].score, 0);
  assert.equal(result.matches[0].game.id, "z");
});

test("game and query records remain unchanged by preference matching and exclusions", () => {
  const games = [game("one", { narrative: facet(true) }), game("two", { narrative: facet(false) })];
  const request = query([criterion("narrative", true, "preferred")], ["two"]);
  const before = structuredClone({ games, request });
  matchGames(games, request);
  assert.deepEqual({ games, request }, before);
});

test("duplicate game IDs fail visibly instead of returning duplicated recommendations", () => {
  assert.throws(() => matchGames([game("same"), game("same")], query()), /unique nonblank ID/);
});

test("shared taxonomy exposes user-facing labels without unsupported quality guarantees", () => {
  assert.equal(TAXONOMY_VERSION, "1.0");
  assert.equal(getFeature("offline")?.label, "Offline play");
  assert.match(getCriterionLabel(criterion("progression", "class_based")), /Class and ability choices/);
  assert.equal(isAllowedValue("progression", "skill_based"), true);
  assert.equal(evaluateCriterion(game("skill-schools", { progression: facet(["skill_based"]) }), criterion("progression", "skill_based")).status, "match");
  assert.equal(getFeature("balanced"), undefined);
});
