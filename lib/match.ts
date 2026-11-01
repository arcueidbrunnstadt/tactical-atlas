import { getCriterionLabel, getFeatureLabel, getValueLabel, isAllowedValue } from "./taxonomy.ts";
import type { Criterion, GameFacet, GameRecord, MatchGroups, MatchReason, MatchResult, SearchQuery } from "./types.ts";
import { translate, type Locale } from "./i18n.ts";

const normalizedIdentity = (value: string): string => value.normalize("NFKC").trim().toLocaleLowerCase("en");

function unknownReason(criterion: Criterion, text: string, locale: Locale): MatchReason {
  return { criterionId: criterion.id, label: getCriterionLabel(criterion, locale), status: "unknown", text: translate(locale, text), evidenceIds: [] };
}

function usableEvidenceIds(game: GameRecord, facet: GameFacet): string[] {
  const available = new Set(game.evidence.filter((item) => item.id && item.statement.trim()).map((item) => item.id));
  return [...new Set(facet.evidenceIds)].filter((id) => available.has(id));
}

/** Missing, unsupported and provisional hard constraints are never factual passes. */
export function evaluateCriterion(game: GameRecord, criterion: Criterion, locale: Locale = "en"): MatchReason {
  if (criterion.operator !== undefined && criterion.operator !== "eq" && criterion.operator !== "neq") {
    return unknownReason(criterion, "This requirement uses an unsupported matching operator.", locale);
  }
  if (!isAllowedValue(criterion.featureId, criterion.value)) {
    return unknownReason(criterion, "This requirement is outside the current matching vocabulary.", locale);
  }

  const facet = game.facets[criterion.featureId];
  if (!facet || facet.status === "unknown" || facet.value === null) {
    return unknownReason(criterion, "The available profile does not establish this requirement.", locale);
  }
  if (facet.status !== "source_supported" && facet.status !== "provisional") {
    return unknownReason(criterion, "The profile does not contain a recognized support status.", locale);
  }

  const values = Array.isArray(facet.value) ? facet.value : [facet.value];
  if (!values.length || !values.every((value) => isAllowedValue(criterion.featureId, value))) {
    return unknownReason(criterion, "The profile does not contain a usable value for this requirement.", locale);
  }

  const evidenceIds = usableEvidenceIds(game, facet);
  if (!evidenceIds.length || evidenceIds.length !== new Set(facet.evidenceIds).size) {
    return unknownReason(criterion, "The profile's supporting evidence is missing or cannot be resolved.", locale);
  }
  if (criterion.importance === "must" && facet.status === "provisional") {
    return {
      ...unknownReason(criterion, "This is a provisional profile assessment, so the required feature still needs checking.", locale),
      evidenceIds,
    };
  }

  const equal = values.some((value) => value === criterion.value);
  const matches = criterion.operator === "neq" ? !equal : equal;
  const recorded = values.map((value) => getValueLabel(criterion.featureId, value, locale)).join(locale === "zh" ? "、" : ", ");
  const basis = translate(locale, facet.status === "provisional" ? "Provisional profile assessment" : "Source-supported profile");
  return {
    criterionId: criterion.id,
    label: getCriterionLabel(criterion, locale),
    status: matches ? "match" : "mismatch",
    text: translate(locale, "{basis}: {feature} — {value}.", {
      basis, feature: getFeatureLabel(criterion.featureId, locale).toLocaleLowerCase("en"), value: recorded,
    }),
    evidenceIds,
  };
}

function uniqueCriteria(criteria: readonly Criterion[]): Criterion[] {
  const entries = new Map<string, Criterion>();
  for (const criterion of criteria) {
    // Equivalent repeated criteria cannot amplify a preference's weight.
    const key = JSON.stringify([criterion.featureId, criterion.value, criterion.operator ?? "eq", criterion.importance]);
    const existing = entries.get(key);
    if (!existing) entries.set(key, { ...criterion });
    else if (criterion.weight > existing.weight) entries.set(key, { ...existing, weight: criterion.weight });
  }
  return [...entries.values()];
}

function supportedCriterionCount(result: MatchResult): number {
  return result.reasons.filter((reason) => reason.status !== "unknown").length;
}

function compareResults(a: MatchResult, b: MatchResult): number {
  return b.score - a.score
    || supportedCriterionCount(b) - supportedCriterionCount(a)
    || a.game.title.localeCompare(b.game.title, "en", { sensitivity: "base" })
    || a.game.id.localeCompare(b.game.id, "en");
}

/**
 * Search only the criteria actually represented in the query.
 * The caller must also display query.unhandledRequirements; this matcher never
 * treats those strings as assessed game facts or silently converts them to flags.
 */
export function matchGames(games: readonly GameRecord[], query: SearchQuery, locale: Locale = "en"): MatchGroups {
  const groups: MatchGroups = { matches: [], possible: [], excluded: [] };
  const criteria = uniqueCriteria(query.criteria);
  const excludedIdentities = new Set(query.excludedGameIds.map(normalizedIdentity));
  const seenIds = new Set<string>();

  for (const game of games) {
    if (!game.id.trim() || seenIds.has(game.id)) {
      throw new TypeError("Every catalogue game must have a unique nonblank ID.");
    }
    seenIds.add(game.id);
    const explicitlyExcluded = [game.id, game.title, ...game.aliases]
      .some((identity) => excludedIdentities.has(normalizedIdentity(identity)));
    if (explicitlyExcluded) {
      groups.excluded.push({
        game,
        score: 0,
        reasons: [{ criterionId: "excluded-game", label: translate(locale, "Excluded by you"), status: "mismatch", text: translate(locale, "You excluded this title from the shortlist."), evidenceIds: [] }],
      });
      continue;
    }

    const reasons = criteria.map((criterion) => evaluateCriterion(game, criterion, locale));
    const score = criteria.reduce((total, criterion, index) => {
      if (criterion.importance !== "preferred") return total;
      const outcome = reasons[index].status;
      return total + (outcome === "match" ? 2 : outcome === "mismatch" ? -2 : 0) * criterion.weight;
    }, 0);
    const result: MatchResult = { game, score, reasons };
    const hardReasons = reasons.filter((_, index) => criteria[index].importance === "must");
    if (hardReasons.some((reason) => reason.status === "mismatch")) groups.excluded.push(result);
    else if (hardReasons.some((reason) => reason.status === "unknown")) groups.possible.push(result);
    else groups.matches.push(result);
  }

  groups.matches.sort(compareResults);
  groups.possible.sort(compareResults);
  groups.excluded.sort(compareResults);
  return groups;
}
