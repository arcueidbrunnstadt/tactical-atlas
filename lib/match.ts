import { CAMPAIGN_HOURS_FEATURE, getAlternativeOptionKey, getCriterionLabel, getFeature, getFeatureLabel, getValueLabel, isAllowedOperator, isAllowedValue } from "./taxonomy.ts";
import type { AlternativeGroup, CampaignDuration, Criterion, GameFacet, GameRecord, MatchGroups, MatchReason, MatchResult, SearchQuery, UnresolvedRequirement } from "./types.ts";
import { translate, type Locale } from "./i18n.ts";
import { isNumericComparisonOperator, numericPreferenceFit, type NumericComparisonOperator } from "./numeric-comparison.ts";

const normalizedIdentity = (value: string): string => value.normalize("NFKC").trim().toLocaleLowerCase("en");

function unknownReason(criterion: Criterion, text: string, locale: Locale): MatchReason {
  return { criterionId: criterion.id, label: getCriterionLabel(criterion, locale), status: "unknown", text: translate(locale, text), evidenceIds: [] };
}

function usableEvidenceIds(game: GameRecord, claim: { evidenceIds: string[] }, requireSource = false): string[] {
  const available = new Set(game.evidence.filter((item) => item.id && item.statement.trim()
    && (!requireSource || item.basis === "source_report" || item.basis === "recorded_observation")).map((item) => item.id));
  return [...new Set(claim.evidenceIds)].filter((id) => available.has(id));
}

function evaluateRecordedAbsence(game: GameRecord, facet: GameFacet, criterion: Criterion, locale: Locale): MatchReason | undefined {
  if (typeof criterion.value !== "string") return;
  const absence = facet.absentValues?.find(({ value }) => value === criterion.value);
  if (!absence) return;

  const evidenceIds = usableEvidenceIds(game, absence, true);
  if (!evidenceIds.length || evidenceIds.length !== new Set(absence.evidenceIds).size) return;

  const reportedValues = Array.isArray(facet.value) ? facet.value : [facet.value];
  if ((facet.status === "source_supported" || facet.status === "provisional") && reportedValues.includes(criterion.value)) {
    const presenceIds = usableEvidenceIds(game, facet);
    if (presenceIds.length) {
      return {
        ...unknownReason(criterion, "The profile contains conflicting evidence about this requirement.", locale),
        evidenceIds: [...new Set([...presenceIds, ...evidenceIds])],
      };
    }
  }

  return {
    criterionId: criterion.id,
    label: getCriterionLabel(criterion, locale),
    status: criterion.operator === "neq" ? "match" : "mismatch",
    text: translate(locale, "The available sources establish that this title has no {value} in the recorded scope.", {
      value: getValueLabel(criterion.featureId, criterion.value, locale).toLocaleLowerCase("en"),
    }),
    evidenceIds,
  };
}

function formatCampaignDuration(duration: CampaignDuration, locale: Locale): string {
  const { lowerHours, upperHours } = duration;
  if (duration.kind === "range") {
    return translate(locale, "{lower}–{upper} hours", { lower: lowerHours, upper: upperHours! });
  }
  return translate(locale, duration.kind === "lower_bound" ? "At least {hours} hours" : "About {hours} hours", { hours: lowerHours });
}

function usableCampaignDuration(game: GameRecord): CampaignDuration | null {
  const estimate = game.campaignDuration;
  if (!estimate) return null;

  const { kind, lowerHours, upperHours } = estimate;
  const validHours = Number.isFinite(lowerHours) && lowerHours > 0 && (
    (kind === "approximate" && upperHours === lowerHours)
    || (kind === "lower_bound" && upperHours === null)
    || (kind === "range" && typeof upperHours === "number" && Number.isFinite(upperHours) && upperHours > lowerHours)
  );
  const evidenceIds = usableEvidenceIds(game, estimate);
  return validHours && evidenceIds.length && evidenceIds.length === new Set(estimate.evidenceIds).size
    ? { ...estimate, evidenceIds } : null;
}

export function describeCampaignDuration(game: GameRecord, locale: Locale): string {
  const estimate = usableCampaignDuration(game);
  return estimate ? translate(locale, "Developer estimate: {estimate}", { estimate: formatCampaignDuration(estimate, locale) })
    : translate(locale, "This profile has no sourced campaign-length estimate.");
}

function evaluateDuration(game: GameRecord, criterion: Criterion, operator: NumericComparisonOperator, target: number, locale: Locale): MatchReason {
  const estimate = usableCampaignDuration(game);
  if (!estimate) return unknownReason(criterion, "This profile has no sourced campaign-length estimate.", locale);
  const description = formatCampaignDuration(estimate, locale);
  const reason = {
    criterionId: criterion.id,
    label: getCriterionLabel(criterion, locale),
    evidenceIds: estimate.evidenceIds,
  };
  if (criterion.importance === "must") {
    return { ...reason, status: "unknown", text: translate(locale,
      "Developer estimate: {estimate}. Playtime varies, so this requirement still needs checking.", { estimate: description }) };
  }

  const comparison = numericPreferenceFit(operator, target, estimate.lowerHours, estimate.upperHours);
  const values = { estimate: description, target };
  if (!comparison) {
    const text = operator === "near"
      ? "Developer estimate: {estimate}. There is no upper estimate to judge closeness to {target} hours."
      : estimate.lowerHours > target
        ? "Developer estimate: {estimate}. Even the reported minimum exceeds your {target}-hour limit."
        : "Developer estimate: {estimate}. There is no upper estimate to check your {target}-hour limit.";
    return { ...reason, status: "unknown", text: translate(locale, text, values) };
  }

  const { fit: preferenceFit, comparedValue } = comparison;
  const fullFit = preferenceFit === 1;
  const text = operator === "near"
    ? fullFit ? "Developer estimate: {estimate}. Close to your {target}-hour target."
      : estimate.kind === "range"
        ? "Developer estimate: {estimate}. The farther end is {distance} hours from your {target}-hour target."
        : "Developer estimate: {estimate}. This is {distance} hours from your {target}-hour target."
    : operator === "lte"
      ? fullFit ? "Developer estimate: {estimate}. Within your {target}-hour limit."
        : "Developer estimate: {estimate}. Partial fit for your {target}-hour limit, using the upper estimate."
      : fullFit ? "Developer estimate: {estimate}. Reaches your {target}-hour target."
        : "Developer estimate: {estimate}. Partial fit for your {target}-hour target, using the lower estimate.";
  return { ...reason, preferenceFit, status: fullFit ? "match" : preferenceFit > 0 ? "partial" : "mismatch",
    text: translate(locale, text, { ...values, distance: Math.round(Math.abs(comparedValue - target) * 100) / 100 }) };
}

/** Missing, unsupported and provisional hard constraints are never factual passes. */
export function evaluateCriterion(game: GameRecord, criterion: Criterion, locale: Locale = "en"): MatchReason {
  if (!isAllowedOperator(criterion.featureId, criterion.operator === undefined ? "eq" : criterion.operator)) {
    return unknownReason(criterion, "This requirement uses an unsupported matching operator.", locale);
  }
  if (!isAllowedValue(criterion.featureId, criterion.value)) {
    return unknownReason(criterion, "This requirement is outside the current matching vocabulary.", locale);
  }
  if (criterion.featureId === CAMPAIGN_HOURS_FEATURE && typeof criterion.value === "number" && isNumericComparisonOperator(criterion.operator)) {
    return evaluateDuration(game, criterion, criterion.operator, criterion.value, locale);
  }

  const facet = game.facets[criterion.featureId];
  const absence = facet && evaluateRecordedAbsence(game, facet, criterion, locale);
  if (absence) return absence;
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
  if (!equal && typeof criterion.value === "string"
      && (criterion.operator === "neq" || getFeature(criterion.featureId)?.categoricalCoverage === "partial")) {
    return {
      ...unknownReason(criterion, "The sources describe some features in this category. They leave this condition unresolved.", locale),
      evidenceIds,
    };
  }
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

export function evaluateAlternativeGroup(game: GameRecord, group: AlternativeGroup, locale: Locale = "en"): MatchReason {
  const options = group.options.map((option) => evaluateCriterion(game, {
    ...option, id: group.id, importance: group.importance, weight: group.weight,
  }, locale));
  const label = translate(locale, "Any of {options}", {
    options: options.map((reason) => reason.label).join(locale === "zh" ? " 或 " : " or "),
  });
  const match = options.find((reason) => reason.status === "match");
  if (match) return { ...match, label, text: translate(locale, "One alternative is supported. {detail}", { detail: match.text }) };

  const unresolved = !options.length || options.some((reason) => reason.status === "unknown");
  return {
    criterionId: group.id, label, status: unresolved ? "unknown" : "mismatch",
    text: translate(locale, unresolved ? "At least one alternative still needs checking." : "None of the recorded options match this group."),
    evidenceIds: [...new Set(options.flatMap((reason) => reason.evidenceIds))],
  };
}

function uniqueConditions(query: SearchQuery): (Criterion | AlternativeGroup)[] {
  const entries = new Map<string, Criterion | AlternativeGroup>();
  for (const condition of [...query.criteria, ...(query.alternatives ?? [])]) {
    // Equivalent conditions, including reordered alternatives, score once.
    const key = JSON.stringify("options" in condition
      ? ["alternatives", [...new Set(condition.options.map(getAlternativeOptionKey))].sort(), condition.importance]
      : ["criterion", condition.featureId, condition.value, condition.operator ?? "eq", condition.importance]);
    const existing = entries.get(key);
    if (!existing) entries.set(key, condition);
    else if (condition.weight > existing.weight) entries.set(key, { ...existing, weight: condition.weight });
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

/** Rank the represented criteria and keep unresolved eligibility visible. */
export function matchGames(games: readonly GameRecord[], query: SearchQuery, locale: Locale = "en"): MatchGroups {
  const groups: MatchGroups = { matches: [], possible: [], excluded: [] };
  const conditions = uniqueConditions(query);
  const catalogueIds = new Set(games.map(({ id }) => id));
  const exactExclusions = new Set(query.excludedGameIds.filter((id) => catalogueIds.has(id)));
  const excludedIdentities = new Set(query.excludedGameIds.filter((id) => !catalogueIds.has(id)).map(normalizedIdentity));
  const seenIds = new Set<string>();
  const unresolved: UnresolvedRequirement[] = [...(query.unresolvedRequirements ?? [])];
  const representedText = new Set(unresolved.map((item) => item.sourceText));
  for (const sourceText of new Set(query.unhandledRequirements)) {
    if (sourceText.trim() && !representedText.has(sourceText)) {
      unresolved.push({ id: `legacy-unresolved:${unresolved.length + 1}`, sourceText, importance: "unknown" });
    }
  }
  const unresolvedEligibility = unresolved.some((item) => item.importance !== "preferred");

  for (const game of games) {
    if (!game.id.trim() || seenIds.has(game.id)) {
      throw new TypeError("Every catalogue game must have a unique nonblank ID.");
    }
    seenIds.add(game.id);
    const explicitlyExcluded = exactExclusions.has(game.id) || [game.id, game.title, ...game.aliases]
      .some((identity) => excludedIdentities.has(normalizedIdentity(identity)));
    if (explicitlyExcluded) {
      groups.excluded.push({
        game,
        score: 0,
        reasons: [{ criterionId: "excluded-game", label: translate(locale, "Excluded by you"), status: "mismatch", text: translate(locale, "You excluded this title from the shortlist."), evidenceIds: [] }],
      });
      continue;
    }

    const assessed = conditions.map((condition) => "options" in condition
      ? evaluateAlternativeGroup(game, condition, locale) : evaluateCriterion(game, condition, locale));
    const score = conditions.reduce((total, condition, index) => {
      if (condition.importance !== "preferred") return total;
      const { status, preferenceFit } = assessed[index];
      const fit = preferenceFit ?? (status === "match" ? 1 : status === "mismatch" ? -1 : 0);
      return total + 2 * fit * condition.weight;
    }, 0);
    const unresolvedReasons: MatchReason[] = unresolved.map((item) => ({
      criterionId: item.id,
      label: item.sourceText,
      status: "unknown",
      text: translate(locale, item.importance === "unknown"
        ? "Choose whether this is required before confirming a match."
        : "The catalogue cannot assess this part of your request yet."),
      evidenceIds: [],
    }));
    const result: MatchResult = { game, score, reasons: [...assessed, ...unresolvedReasons] };
    const hardReasons = assessed.filter((_, index) => conditions[index].importance === "must");
    if (hardReasons.some((reason) => reason.status === "mismatch")) groups.excluded.push(result);
    else if (unresolvedEligibility || hardReasons.some((reason) => reason.status === "unknown")) groups.possible.push(result);
    else groups.matches.push(result);
  }

  groups.matches.sort(compareResults);
  groups.possible.sort(compareResults);
  groups.excluded.sort(compareResults);
  return groups;
}
