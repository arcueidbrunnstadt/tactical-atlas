import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { evaluateCriterion, matchGames } from "../lib/match.ts";
import type { CampaignDuration, Criterion, CriterionOperator, GameRecord } from "../lib/types.ts";

const catalogue = JSON.parse(readFileSync(new URL("../public/catalogue.json", import.meta.url), "utf8")) as GameRecord[];
const template = catalogue.find(({ id }) => id === "steam_1043810")!;
function measured(title: string, lowerHours: number, upperHours: number | null): GameRecord {
  const kind: CampaignDuration["kind"] = upperHours === null ? "lower_bound" : lowerHours === upperHours ? "approximate" : "range";
  return { ...template, id: title, title, campaignDuration: { kind, lowerHours, upperHours, evidenceIds: template.campaignDuration!.evidenceIds } };
}
const criterion = (operator: CriterionOperator, value = 35, importance: Criterion["importance"] = "preferred"): Criterion =>
  ({ id: "duration", featureId: "campaign_hours", operator, value, importance, weight: 1 });
const ranked = (games: GameRecord[], condition: Criterion, locale: "en" | "zh" = "en") =>
  matchGames(games, { criteria: [condition], excludedGameIds: [], unhandledRequirements: [] }, locale);

test("near is centered and grades the same distance above or below, unlike a minimum", () => {
  const games = [measured("Far", 80, 80), measured("Lower", 30, 30), measured("Target", 35, 35), measured("Upper", 40, 40)];
  const near = ranked(games, criterion("near")).matches;
  assert.deepEqual(near.map(({ game }) => game.id), ["Target", "Lower", "Upper", "Far"]);
  assert.equal(near[0].score, 2);
  assert.equal(near[1].score, near[2].score);
  assert.ok(near[1].score > 0 && near[1].score < near[0].score);
  assert.equal(near[3].score, 0);
  assert.equal(ranked(games, criterion("gte")).matches[0].game.id, "Far");
});

test("a finite estimate uses its upper end for a cap and its farther end for proximity", () => {
  const bounded = measured("Bounded", 30, 50);
  const upper = evaluateCriterion(bounded, criterion("lte"));
  const near = evaluateCriterion(bounded, criterion("near"));
  assert.equal(upper.status, "partial");
  assert.equal(upper.preferenceFit, 35 / 50);
  assert.equal(near.status, "partial");
  assert.equal(near.preferenceFit, 1 - 15 / 35);
  assert.match(near.text, /30–50 hours/);
  assert.equal(evaluateCriterion(measured("Fits", 14, 14), criterion("lte")).status, "match");
});

test("an open lower bound can support a minimum preference but cannot establish closeness or an upper estimate", () => {
  const floor = measured("Floor", 80, null);
  for (const operator of ["near", "lte"] as const) {
    const reason = evaluateCriterion(floor, criterion(operator, 100));
    assert.equal(reason.status, "unknown");
    assert.equal(reason.preferenceFit, undefined);
    assert.deepEqual(reason.evidenceIds, floor.campaignDuration!.evidenceIds);
    assert.match(reason.text, /At least 80 hours/);
  }
  assert.equal(evaluateCriterion(floor, criterion("gte")).status, "match");
});

test("current estimates rank preferences in both languages and leave hard duration open", () => {
  for (const locale of ["en", "zh"] as const) {
    const near = ranked(catalogue, criterion("near"), locale);
    assert.equal(near.matches.length, catalogue.length);
    assert.deepEqual(new Set(near.matches.slice(0, 2).map(({ game }) => game.id)), new Set(["steam_1850510", "steam_1096530"]));
    assert.equal(near.matches[0].score, near.matches[1].score);
    assert.equal(near.matches[2].game.id, template.id);
    assert.equal(near.matches.find(({ game }) => game.id === "steam_1086940")!.score, 0);
    for (const operator of ["near", "gte", "lte"] as const) {
      const hard = ranked(catalogue, criterion(operator, 35, "must"), locale);
      assert.equal(hard.possible.length, catalogue.length);
      assert.equal(hard.excluded.length + hard.matches.length, 0);
      assert.deepEqual(hard.possible.find(({ game }) => game.id === template.id)!.reasons[0].evidenceIds, template.campaignDuration!.evidenceIds);
    }
  }
});
