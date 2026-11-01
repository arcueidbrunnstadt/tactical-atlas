import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluateCriterion, matchGames } from "../lib/match.ts";
import { getFeature, isAllowedValue, TAXONOMY, TAXONOMY_VERSION } from "../lib/taxonomy.ts";
import type { Criterion, GameRecord } from "../lib/types.ts";
import { interpretRequest, PROVIDER_CONFIG } from "../server/provider.ts";
import type { ProviderFetch } from "../server/provider.ts";

type ChineseOverlay = {
  title?: string;
  summary: string;
  editionScope: string;
  notes: string[];
  tradeoffs: string[];
  evidence: Record<string, { statement: string; locator?: string; limitations: string[] }>;
};
const catalogue: GameRecord[] = JSON.parse(readFileSync(new URL("../public/catalogue.json", import.meta.url), "utf8"));
const chinese: Record<string, ChineseOverlay> = JSON.parse(readFileSync(new URL("../public/catalogue.zh.json", import.meta.url), "utf8"));
const hasChinese = (value: unknown): value is string => typeof value === "string" && /[\u3400-\u9fff]/u.test(value);
const supportedStatuses = new Set(["source_supported", "provisional", "unknown"]);

function https(value: string, description: string) {
  assert.equal(new URL(value).protocol, "https:", description);
}
function hard(featureId: string, value: Criterion["value"], operator: "eq" | "neq"): Criterion {
  return { id: "actual-catalogue-requirement", featureId, value, operator, importance: "must", weight: 1 };
}

test("the expanded collection has at least 24 unique, source-linked profiles in the current vocabulary", () => {
  assert.ok(catalogue.length >= 24, "the approved first expansion must remain available");
  assert.equal(new Set(catalogue.map(game => game.id)).size, catalogue.length);
  const featureIds = TAXONOMY.map(feature => feature.id).sort();
  for (const game of catalogue) {
    assert.match(game.id, /^steam_\d+$/);
    assert.ok(game.title.trim() && game.summary.trim() && game.editionScope.trim(), game.id);
    assert.ok(game.aliases.some(hasChinese), game.id + " needs Chinese name lookup");
    https(game.storeUrl, game.id + " store URL");
    assert.deepEqual(Object.keys(game.facets).sort(), featureIds, game.id + " facets");
    assert.ok(game.evidence.length > 0, game.id + " needs evidence");
    const evidenceIds = new Set(game.evidence.map(item => item.id));
    assert.equal(evidenceIds.size, game.evidence.length, game.id + " evidence IDs");
    for (const item of game.evidence) {
      assert.ok(item.id.trim() && item.statement.trim() && item.locator.trim(), game.id + " evidence content");
      https(item.url, item.id + " source URL");
      assert.ok(["source_report", "recorded_observation", "provisional_assessment"].includes(item.basis));
      assert.match(item.checkedDate, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(new Date(item.checkedDate).toISOString().slice(0, 10), item.checkedDate);
      assert.ok(item.limitations.length > 0 && item.limitations.every(text => text.trim()), item.id + " scope");
    }
    for (const [featureId, facet] of Object.entries(game.facets)) {
      assert.ok(supportedStatuses.has(facet.status), game.id + "/" + featureId);
      assert.ok(facet.evidenceIds.every(id => evidenceIds.has(id)), game.id + "/" + featureId + " dangling evidence");
      if (facet.status === "unknown") {
        assert.equal(facet.value, null, game.id + "/" + featureId + " unknown value");
        assert.deepEqual(facet.evidenceIds, [], game.id + "/" + featureId + " unknown evidence");
      } else {
        const values = Array.isArray(facet.value) ? facet.value : [facet.value];
        assert.ok(values.length > 0 && values.every(value => isAllowedValue(featureId, value)), game.id + "/" + featureId + " value");
        assert.ok(facet.evidenceIds.length > 0, game.id + "/" + featureId + " unsupported assertion");
      }
    }
    for (const note of [...game.notes, ...game.tradeoffs]) {
      assert.ok(note.text.trim() && note.evidenceIds.length > 0, game.id + " note");
      assert.ok(note.evidenceIds.every(id => evidenceIds.has(id)), game.id + " note evidence");
    }
  }
});

test("Chinese overlays cover every profile and align translated notes and evidence without replacing provenance", () => {
  assert.deepEqual(Object.keys(chinese).sort(), catalogue.map(game => game.id).sort());
  for (const game of catalogue) {
    const overlay = chinese[game.id];
    assert.ok(hasChinese(overlay.summary) && hasChinese(overlay.editionScope), game.id + " Chinese profile");
    assert.equal(overlay.notes.length, game.notes.length, game.id + " note alignment");
    assert.equal(overlay.tradeoffs.length, game.tradeoffs.length, game.id + " tradeoff alignment");
    assert.ok([...overlay.notes, ...overlay.tradeoffs].every(hasChinese), game.id + " translated notes");
    assert.deepEqual(Object.keys(overlay.evidence).sort(), game.evidence.map(item => item.id).sort());
    for (const item of game.evidence) {
      const translated = overlay.evidence[item.id];
      assert.ok(hasChinese(translated.statement), item.id + " translated statement");
      assert.equal(translated.limitations.length, item.limitations.length, item.id + " limitation alignment");
      assert.ok(translated.limitations.every(hasChinese), item.id + " translated limitations");
      // Localized prose must not introduce a different URL/date/support basis.
      assert.ok(Object.keys(translated).every(key => ["statement", "locator", "limitations"].includes(key)), item.id + " provenance override");
    }
    if (overlay.title) assert.ok(game.aliases.includes(overlay.title), game.id + " displayed Chinese title should be searchable");
  }
});

test("the expanded collection provides supported historical and class-development search coverage", () => {
  const historical = matchGames(catalogue, {
    criteria: [hard("setting", "historical", "eq")], excludedGameIds: [], unhandledRequirements: [],
  });
  const historicalIds = new Set(historical.matches.map(result => result.game.id));
  assert.ok(historicalIds.has("steam_660160"), "Field of Glory II should support a historical-setting search");
  assert.ok(historicalIds.has("steam_1148490"), "Second Front should support a historical-setting search");
  const classes = matchGames(catalogue, {
    criteria: [hard("progression", "class_based", "eq")], excludedGameIds: [], unhandledRequirements: [],
  });
  const classIds = new Set(classes.matches.map(result => result.game.id));
  assert.ok(classIds.has("steam_1451090"), "Tactics Ogre's sourced classes should be searchable");
  assert.ok(classIds.has("steam_470310"), "Troubleshooter's sourced classes should be searchable");
});

test("actual unknown and provisional facets remain unresolved hard constraints for both operators", () => {
  let unknown = 0;
  let provisional = 0;
  for (const game of catalogue) for (const [featureId, facet] of Object.entries(game.facets)) {
    if (facet.status !== "unknown" && facet.status !== "provisional") continue;
    if (facet.status === "unknown") unknown += 1;
    else provisional += 1;
    const value = facet.value === null ? getFeature(featureId)!.options[0].value
      : Array.isArray(facet.value) ? facet.value[0] : facet.value;
    for (const operator of ["eq", "neq"] as const) {
      const criterion = hard(featureId, value, operator);
      assert.equal(evaluateCriterion(game, criterion).status, "unknown", game.id + "/" + featureId + "/" + operator);
      const groups = matchGames([game], { criteria: [criterion], excludedGameIds: [], unhandledRequirements: [] });
      assert.equal(groups.matches.length, 0);
      assert.equal(groups.excluded.length, 0);
      assert.deepEqual(groups.possible.map(result => result.game.id), [game.id]);
    }
  }
  assert.ok(unknown > 0 && provisional > 0, "exercise the actual collection's uncertainty");
});

test("the actual bilingual catalogue and maximum Chinese request fit the unchanged provider envelope", async () => {
  const query = "中".repeat(1_000);
  let calls = 0;
  let bytes = 0;
  const response = {
    status: "ready",
    criteria: [{ featureId: "setting", value: "fantasy", operator: "eq", importance: "preferred", weight: 1, sourceText: "中" }],
    excludedGameIds: [], unhandledRequirements: [], clarification: null,
  };
  const fakeFetch: ProviderFetch = async (_input, init) => {
    calls += 1;
    const serialized = String(init?.body);
    bytes = new TextEncoder().encode(serialized).length;
    for (const game of catalogue) assert.equal(serialized.includes(game.summary), false, "full profiles do not belong in the identity prompt");
    return Response.json({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(response) }] }],
      usage: { input_tokens: 300, output_tokens: 100 },
    });
  };
  const result = await interpretRequest({
    apiKey: "unit-test-placeholder-never-live", query, catalogue, taxonomyVersion: TAXONOMY_VERSION,
    requestId: "123e4567-e89b-42d3-a456-426614174000",
  }, fakeFetch);
  assert.equal(result.status, "ready");
  assert.equal(calls, 1, "only the injected mock is invoked");
  assert.ok(bytes > 0 && bytes <= PROVIDER_CONFIG.maxRequestBytes);
  assert.equal(PROVIDER_CONFIG.maxRequestBytes, 16 * 1024, "expansion must not silently widen the spending envelope");
});
