import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCriterion, matchGames } from "../lib/match.ts";
import type { Criterion, EvidenceRecord, GameFacet, GameRecord } from "../lib/types.ts";

function source(id: string, statement: string, basis: EvidenceRecord["basis"] = "source_report"): EvidenceRecord {
  return { id, statement, basis, url: `https://example.com/${id}`, locator: "Base edition rules", checkedDate: "2026-11-08", limitations: [] };
}

const equipment = source("equipment", "The base edition has equipment choices and distinct named characters.");
const skillChoices = source("skills-present", "Players choose skills and perks when characters advance in the base edition.");
const noSkillChoices = source("skills-absent", "The base edition has no skill or perk choices. Character skills are fixed.");
const skillAbsence = { value: "skill_based", evidenceIds: [noSkillChoices.id] };
const needsSkills: Criterion = { id: "skill-choices", featureId: "progression", value: "skill_based", importance: "must", weight: 1 };
const avoidsSkills: Criterion = { ...needsSkills, operator: "neq" };
const locales = ["en", "zh"] as const;

function profile(id: string, featureId: string, facet: GameFacet, evidence: EvidenceRecord[]): GameRecord {
  return {
    id, title: id, aliases: [], storeUrl: "https://example.com/games", editionScope: "Base edition",
    summary: "Synthetic profile for matcher tests.", facets: { [featureId]: facet }, evidence, notes: [], tradeoffs: [],
  };
}

test("unlisted progression is unresolved for hard negation whether a partial report uses a scalar or a list", () => {
  const games = [
    profile("scalar", "progression", { value: "equipment", status: "source_supported", evidenceIds: [equipment.id] }, [equipment]),
    profile("one item", "progression", { value: ["equipment"], status: "source_supported", evidenceIds: [equipment.id] }, [equipment]),
    profile("two items", "progression", { value: ["equipment", "unique_characters"], status: "source_supported", evidenceIds: [equipment.id] }, [equipment]),
  ];

  for (const locale of locales) {
    const result = matchGames(games, { criteria: [avoidsSkills], excludedGameIds: [], unhandledRequirements: [] }, locale);
    assert.equal(result.matches.length, 0, locale);
    assert.equal(result.excluded.length, 0, locale);
    assert.equal(result.possible.length, games.length, locale);
    assert.ok(result.possible.every(({ reasons }) => reasons[0].status === "unknown"));
  }
});

test("categorical negation of a setting needs evidence of absence even if another setting is supported", () => {
  const futuristic = source("futuristic", "The base game has a science fiction setting.");
  const game = profile("space station", "setting", { value: "scifi", status: "source_supported", evidenceIds: [futuristic.id] }, [futuristic]);
  const avoidFantasy: Criterion = { ...avoidsSkills, featureId: "setting", value: "fantasy" };

  assert.equal(evaluateCriterion(game, avoidFantasy).status, "unknown");
});

test("documented categorical presence conflicts with negation", () => {
  const game = profile("skill choices", "progression", {
    value: ["equipment", "skill_based"], status: "source_supported", evidenceIds: [equipment.id, skillChoices.id],
  }, [equipment, skillChoices]);

  assert.equal(evaluateCriterion(game, needsSkills).status, "match");
  assert.equal(evaluateCriterion(game, avoidsSkills).status, "mismatch");
});

test("explicit reviewed absence supports either operator even when positive progression is unknown", () => {
  const game = profile("fixed progression", "progression", {
    value: null, status: "unknown", evidenceIds: [], absentValues: [skillAbsence],
  }, [noSkillChoices]);

  for (const locale of locales) {
    const included = evaluateCriterion(game, needsSkills, locale);
    const excluded = evaluateCriterion(game, avoidsSkills, locale);
    assert.equal(included.status, "mismatch", locale);
    assert.equal(excluded.status, "match", locale);
    assert.deepEqual(included.evidenceIds, [noSkillChoices.id]);
    assert.deepEqual(excluded.evidenceIds, [noSkillChoices.id]);
  }
});

test("reviewed absence cites its own evidence alongside documented positive values", () => {
  const game = profile("equipment only", "progression", {
    value: "equipment", status: "source_supported", evidenceIds: [equipment.id], absentValues: [skillAbsence],
  }, [equipment, noSkillChoices]);
  const absent = evaluateCriterion(game, avoidsSkills);
  const equipmentMatch = evaluateCriterion(game, { ...needsSkills, value: "equipment" });

  assert.equal(absent.status, "match");
  assert.deepEqual(absent.evidenceIds, [noSkillChoices.id]);
  assert.equal(equipmentMatch.status, "match");
  assert.deepEqual(equipmentMatch.evidenceIds, [equipment.id]);
});

test("a missing evidence reference or a provisional-only assessment cannot establish absence", () => {
  const provisional = source("provisional", "We infer that skill choices are absent from an incomplete description.", "provisional_assessment");
  const cases = [
    { id: "dangling absence", evidenceId: "missing", evidence: [equipment] },
    { id: "provisional absence", evidenceId: provisional.id, evidence: [equipment, provisional] },
  ];

  for (const { id, evidenceId, evidence } of cases) {
    const game = profile(id, "progression", {
      value: "equipment", status: "source_supported", evidenceIds: [equipment.id],
      absentValues: [{ value: "skill_based", evidenceIds: [evidenceId] }],
    }, evidence);
    assert.equal(evaluateCriterion(game, avoidsSkills).status, "unknown", id);
  }
});

test("contradictory reviewed presence and absence leave both operators unresolved", () => {
  const game = profile("contradictory records", "progression", {
    value: "skill_based", status: "source_supported", evidenceIds: [skillChoices.id], absentValues: [skillAbsence],
  }, [skillChoices, noSkillChoices]);

  assert.equal(evaluateCriterion(game, needsSkills).status, "unknown");
  assert.equal(evaluateCriterion(game, avoidsSkills).status, "unknown");
});

test("explicit boolean false still supplies negative evidence", () => {
  const noPositioning = source("fixed-positions", "Positions are fixed and the base edition has no positioning mechanics.");
  const game = profile("fixed positions", "positioning", {
    value: false, status: "source_supported", evidenceIds: [noPositioning.id],
  }, [noPositioning]);
  const avoidPositioning: Criterion = { ...avoidsSkills, featureId: "positioning", value: true };

  assert.equal(evaluateCriterion(game, avoidPositioning).status, "match");
  assert.equal(evaluateCriterion(game, { ...avoidPositioning, operator: "eq", value: false }).status, "match");
  assert.equal(evaluateCriterion(game, { ...avoidPositioning, operator: "eq" }).status, "mismatch");
});
