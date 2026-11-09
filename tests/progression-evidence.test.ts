import assert from "node:assert/strict";
import test from "node:test";
import { matchGames } from "../lib/match.ts";
import type { AlternativeGroup, Criterion, EvidenceRecord, GameFacet, GameRecord, SearchQuery } from "../lib/types.ts";

function source(id: string, statement: string): EvidenceRecord {
  return { id, statement, basis: "source_report", url: `https://example.com/${id}`, locator: "Base game rules", checkedDate: "2026-11-08", limitations: [] };
}

const loadout = source("loadout", "The base game offers adjustable equipment and distinct named characters.");
const skills = source("skills", "In the base game, players choose equipment and which skills or perks their characters learn.");
const noSkills = source("no-skills", "Character skills and perks are fixed in the base game. Players make no skill or perk choices.");
const noClasses = source("no-classes", "The base game offers no classes or class choices.");
const needSkills: Criterion = { id: "need-skills", featureId: "progression", value: "skill_based", operator: "eq", importance: "must", weight: 1 };

function profile(id: string, value: GameFacet["value"], evidence: EvidenceRecord,
  absences: NonNullable<GameFacet["absentValues"]> = [], absenceSources: EvidenceRecord[] = []): GameRecord {
  return {
    id, title: id, aliases: [], storeUrl: "https://example.com/games", editionScope: "Base game", summary: "Synthetic matcher fixture.",
    facets: { progression: { value, status: "source_supported", evidenceIds: [evidence.id], absentValues: absences } },
    notes: [], tradeoffs: [], evidence: [evidence, ...absenceSources],
  };
}

const scalar = profile("scalar", "equipment", loadout);
const list = profile("list", ["equipment", "unique_characters"], loadout);
const present = profile("present", ["equipment", "skill_based"], skills);
const absent = profile("absent", "equipment", loadout, [{ value: "skill_based", evidenceIds: [noSkills.id] }], [noSkills]);

function query(criteria: Criterion[], alternatives?: AlternativeGroup[]): SearchQuery {
  return { criteria, alternatives, excludedGameIds: [], unhandledRequirements: [] };
}

test("a positive progression must distinguishes presence, partial evidence and explicit absence", () => {
  for (const locale of ["en", "zh"] as const) {
    const result = matchGames([scalar, list, present, absent], query([needSkills]), locale);

    assert.deepEqual(result.matches.map(({ game }) => game.id), [present.id], locale);
    assert.deepEqual(result.possible.map(({ game }) => game.id), [list.id, scalar.id], locale);
    assert.deepEqual(result.excluded.map(({ game }) => game.id), [absent.id], locale);
    assert.equal(result.matches[0].reasons[0].status, "match");
    assert.ok(result.possible.every(({ reasons }) => reasons[0].status === "unknown"));
    assert.equal(result.excluded[0].reasons[0].status, "mismatch");
    assert.deepEqual(result.excluded[0].reasons[0].evidenceIds, [noSkills.id]);
  }
});

test("a positive progression preference scores missing membership neutrally and documented absence negatively", () => {
  const result = matchGames([scalar, list, present, absent], query([{ ...needSkills, importance: "preferred", weight: 3 }]));

  assert.deepEqual(result.matches.map(({ game, score, reasons }) => [game.id, score, reasons[0].status]), [
    [present.id, 6, "match"], [list.id, 0, "unknown"], [scalar.id, 0, "unknown"], [absent.id, -6, "mismatch"],
  ]);
  assert.deepEqual(result.possible, []);
  assert.deepEqual(result.excluded, []);
});

test("a documented conflict on another must still excludes a title with unknown progression", () => {
  const setting = source("setting", "The base game has a science fiction setting.");
  const game: GameRecord = {
    ...scalar,
    facets: { ...scalar.facets, setting: { value: "scifi", status: "source_supported", evidenceIds: [setting.id] } },
    evidence: [...scalar.evidence, setting],
  };
  const fantasy: Criterion = { id: "need-fantasy", featureId: "setting", value: "fantasy", operator: "eq", importance: "must", weight: 1 };
  const result = matchGames([game], query([needSkills, fantasy]));

  assert.deepEqual(result.excluded.map(({ game }) => game.id), [game.id]);
  assert.deepEqual(result.excluded[0].reasons.map(({ criterionId, status }) => [criterionId, status]), [
    [needSkills.id, "unknown"], [fantasy.id, "mismatch"],
  ]);
});

test("progression alternatives stay possible when one category is absent and the other is unassessed", () => {
  const neither = profile("neither", "equipment", loadout, [
    { value: "skill_based", evidenceIds: [noSkills.id] }, { value: "class_based", evidenceIds: [noClasses.id] },
  ], [noSkills, noClasses]);
  const options: AlternativeGroup = {
    id: "classes-or-skills", importance: "must", weight: 1,
    options: [
      { featureId: "progression", value: "skill_based", operator: "eq" },
      { featureId: "progression", value: "class_based", operator: "eq" },
    ],
  };
  const result = matchGames([present, absent, neither], query([], [options]));

  assert.deepEqual(result.matches.map(({ game }) => game.id), [present.id]);
  assert.deepEqual(result.possible.map(({ game }) => game.id), [absent.id]);
  assert.deepEqual(result.excluded.map(({ game }) => game.id), [neither.id]);
});
