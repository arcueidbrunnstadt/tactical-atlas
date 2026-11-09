import { CAMPAIGN_HOURS_FEATURE, CAMPAIGN_HOUR_TARGET, getAlternativeOptionKey, isAllowedOperator, isAllowedValue, MAX_ALTERNATIVE_GROUPS, MAX_ALTERNATIVE_OPTIONS, MIN_ALTERNATIVE_OPTIONS, TAXONOMY, TAXONOMY_VERSION } from "./taxonomy.ts";
import { hasDirectMechanicCue, managementScopeClauses, overlappingQuoteOffset, quoteIsWithin } from "./interpretation-grounding.ts";
import { NUMERIC_COMPARISONS } from "./numeric-comparison.ts";
import { quotesWholeHourTarget, readQuotedHourComparison } from "./quoted-comparison.ts";
import type { AlternativeGroup, AlternativeOption, Criterion, CriterionOperator, GameRecord, SearchQuery, UnresolvedRequirement } from "./types.ts";

export const INTERPRETATION_VERSION = "1.6";
export const MAX_QUERY_CHARACTERS = 1_000;
export const MAX_QUERY_BYTES = 4 * 1024;
const MAX_CONDITIONS_PER_PRIORITY = 8;
const MAX_REPRESENTED_CONDITIONS = 2 * MAX_CONDITIONS_PER_PRIORITY;
const MAX_MODEL_UNHANDLED = 8;
// A safe reply can retain all model-provided notes plus any represented condition set aside here.
export const MAX_RETURNED_UNRESOLVED_REQUIREMENTS = MAX_MODEL_UNHANDLED + MAX_REPRESENTED_CONDITIONS;

export class QueryValidationError extends Error {
  code: "INVALID_REQUEST" | "QUERY_TOO_LARGE" | "TAXONOMY_MISMATCH" | "INVALID_INTERPRETATION";

  constructor(code: QueryValidationError["code"]) {
    super(code === "TAXONOMY_MISMATCH" ? "The search vocabulary changed. Reload and try again."
      : code === "QUERY_TOO_LARGE" ? "Please shorten the search request."
        : code === "INVALID_INTERPRETATION" ? "The AI response could not be validated."
          : "The search request is invalid.");
    this.name = "QueryValidationError";
    this.code = code;
  }
}

export interface InterpretRequestBody {
  query: string;
  taxonomyVersion: string;
  requestId: string;
}

export interface Clarification {
  question: string;
  choices: string[];
}

export interface InterpretedCriterion extends Criterion {
  operator: CriterionOperator;
  sourceText: string;
}

export interface ValidatedInterpretation extends SearchQuery {
  status: "ready" | "clarification" | "unsupported";
  criteria: InterpretedCriterion[];
  alternatives: AlternativeGroup[];
  unresolvedRequirements: UnresolvedRequirement[];
  clarification: Clarification | null;
  taxonomyVersion: string;
  interpretationVersion: string;
  requestId: string;
}

export type CatalogueIdentity = Pick<GameRecord, "id" | "title" | "aliases">;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

/** Safe client request validation, before a quota reservation or provider call. */
export function validateInterpretRequest(value: unknown): InterpretRequestBody {
  if (!record(value) || !exactKeys(value, ["query", "taxonomyVersion", "requestId"])
      || typeof value.query !== "string" || !value.query.trim()
      || typeof value.taxonomyVersion !== "string" || typeof value.requestId !== "string") {
    throw new QueryValidationError("INVALID_REQUEST");
  }
  if (value.query.length > MAX_QUERY_CHARACTERS || new TextEncoder().encode(value.query).length > MAX_QUERY_BYTES) {
    throw new QueryValidationError("QUERY_TOO_LARGE");
  }
  if (value.taxonomyVersion !== TAXONOMY_VERSION) throw new QueryValidationError("TAXONOMY_MISMATCH");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.requestId)) {
    throw new QueryValidationError("INVALID_REQUEST");
  }
  return { query: value.query.trim(), taxonomyVersion: value.taxonomyVersion, requestId: value.requestId };
}

const modelRootKeys = ["status", "criteria", "excludedGameIds", "unhandledRequirements", "clarification"] as const;
const currentModelRootKeys = [...modelRootKeys, "alternatives"] as const;
const criterionKeys = ["featureId", "value", "operator", "importance", "weight", "sourceText"] as const;
const alternativeKeys = ["options", "importance", "weight", "sourceText"] as const;
const optionKeys = ["featureId", "value", "operator"] as const;
const unresolvedKeys = ["sourceText", "importance"] as const;
const unresolvedPriorities = ["must", "preferred", "unknown"] as const;

function isUnresolvedPriority(value: unknown): value is UnresolvedRequirement["importance"] {
  return unresolvedPriorities.some((priority) => priority === value);
}

const priorityRank = { preferred: 0, unknown: 1, must: 2 } as const;

/** Cross-field checks remain necessary even when the provider follows JSON Schema. */
export function validateModelInterpretation(
  value: unknown,
  context: InterpretRequestBody & { catalogue: readonly CatalogueIdentity[] },
): ValidatedInterpretation {
  const invalid = (): never => { throw new QueryValidationError("INVALID_INTERPRETATION"); };
  if (!record(value) || (!exactKeys(value, currentModelRootKeys) && !exactKeys(value, modelRootKeys))
      || !["ready", "clarification", "unsupported"].includes(String(value.status))
      || !Array.isArray(value.criteria) || value.criteria.length > MAX_REPRESENTED_CONDITIONS
      || !Array.isArray(value.excludedGameIds) || value.excludedGameIds.length > context.catalogue.length
      || !Array.isArray(value.unhandledRequirements) || value.unhandledRequirements.length > MAX_MODEL_UNHANDLED) return invalid();

  const criteria: InterpretedCriterion[] = [];
  for (const [index, candidate] of value.criteria.entries()) {
    if (!record(candidate) || !exactKeys(candidate, criterionKeys)
        || typeof candidate.featureId !== "string" || !isAllowedValue(candidate.featureId, candidate.value)
        || !isAllowedOperator(candidate.featureId, candidate.operator)
        || (candidate.importance !== "must" && candidate.importance !== "preferred")
        || (candidate.weight !== 1 && candidate.weight !== 3)
        || !boundedText(candidate.sourceText, MAX_QUERY_CHARACTERS)
        || !context.query.includes(candidate.sourceText)) return invalid();
    if (candidate.featureId === CAMPAIGN_HOURS_FEATURE
        && (typeof candidate.value !== "number" || !quotesWholeHourTarget(candidate.sourceText, candidate.value))) return invalid();
    criteria.push({
      id: `${context.requestId}:${index + 1}`,
      featureId: candidate.featureId,
      value: candidate.value,
      operator: candidate.operator,
      importance: candidate.importance,
      weight: candidate.weight,
      sourceText: candidate.sourceText,
    });
  }
  const rawAlternatives = Object.hasOwn(value, "alternatives") ? value.alternatives : [];
  if (!Array.isArray(rawAlternatives) || rawAlternatives.length > MAX_ALTERNATIVE_GROUPS) return invalid();
  const alternatives: (AlternativeGroup & { sourceText: string })[] = [];
  for (const [index, group] of rawAlternatives.entries()) {
    if (!record(group) || !exactKeys(group, alternativeKeys)
        || (group.importance !== "must" && group.importance !== "preferred")
        || (group.weight !== 1 && group.weight !== 3)
        || !boundedText(group.sourceText, MAX_QUERY_CHARACTERS) || !context.query.includes(group.sourceText)
        || criteria.some(({ sourceText }) => sourceText === group.sourceText)
        || !Array.isArray(group.options) || group.options.length < MIN_ALTERNATIVE_OPTIONS || group.options.length > MAX_ALTERNATIVE_OPTIONS) return invalid();

    const options: AlternativeOption[] = [];
    for (const option of group.options) {
      if (!record(option) || !exactKeys(option, optionKeys) || typeof option.featureId !== "string"
          || (typeof option.value !== "string" && typeof option.value !== "boolean")
          || !isAllowedValue(option.featureId, option.value)
          || (option.operator !== "eq" && option.operator !== "neq")
          || !isAllowedOperator(option.featureId, option.operator)) return invalid();
      const validated = { featureId: option.featureId, value: option.value, operator: option.operator } satisfies AlternativeOption;
      if (options.some((item) => getAlternativeOptionKey(item) === getAlternativeOptionKey(validated))) return invalid();
      options.push(validated);
    }
    alternatives.push({
      id: `${context.requestId}:alternatives:${index + 1}`, sourceText: group.sourceText,
      options, importance: group.importance, weight: group.weight,
    });
  }

  const conditions = [...criteria, ...alternatives];
  if (conditions.filter((item) => item.importance === "must").length > MAX_CONDITIONS_PER_PRIORITY
      || conditions.filter((item) => item.importance === "preferred").length > MAX_CONDITIONS_PER_PRIORITY) return invalid();

  // Distinct required values for the same feature need distinct atomic quotes.
  // Reusing the entire quote can turn a single choice into simultaneous musts.
  if (criteria.some((item, index) => item.importance === "must" && item.operator === "eq"
      && criteria.slice(index + 1).some((other) => other.importance === "must" && other.operator === "eq"
        && item.featureId === other.featureId && item.value !== other.value && item.sourceText === other.sourceText))) return invalid();

  const allowedIds = new Set(context.catalogue.map((game) => game.id));
  if (!value.excludedGameIds.every((id) => typeof id === "string" && allowedIds.has(id))) return invalid();

  const unresolved = new Map<string, UnresolvedRequirement>();
  const structuredQuotes = new Set<string>();
  for (const item of value.unhandledRequirements) {
    let sourceText: string;
    let importance: UnresolvedRequirement["importance"];
    if (boundedText(item, 240)) {
      // Earlier responses carried only a note. Its priority cannot be recovered.
      sourceText = item;
      importance = "unknown";
    } else if (record(item) && exactKeys(item, unresolvedKeys)
        && boundedText(item.sourceText, MAX_QUERY_CHARACTERS) && context.query.includes(item.sourceText)
        && isUnresolvedPriority(item.importance)) {
      sourceText = item.sourceText;
      importance = item.importance;
      structuredQuotes.add(sourceText);
    } else {
      return invalid();
    }
    const previous = unresolved.get(sourceText);
    if (previous && previous.importance !== importance) return invalid();
    if (!previous) unresolved.set(sourceText, {
      id: `${context.requestId}:unresolved:${unresolved.size + 1}`, sourceText, importance,
    });
  }

  let clarification: Clarification | null = null;
  if (value.clarification !== null) {
    if (!record(value.clarification) || !exactKeys(value.clarification, ["question", "choices"])
        || !boundedText(value.clarification.question, 300)
        || !Array.isArray(value.clarification.choices)
        || value.clarification.choices.length < 2 || value.clarification.choices.length > 4
        || !value.clarification.choices.every((choice) => boundedText(choice, 160))) return invalid();
    clarification = { question: value.clarification.question, choices: [...value.clarification.choices] };
  }
  if ((value.status === "clarification") !== (clarification !== null)) return invalid();
  if (value.status === "unsupported" && value.unhandledRequirements.length === 0) return invalid();

  // A model must ask for clarification rather than pretending contradictory musts are ready.
  if (value.status === "ready") {
    const musts = criteria.filter((item) => item.importance === "must");
    if (musts.some((item) => item.operator === "eq" && musts.some((other) => other.operator === "neq"
        && item.featureId === other.featureId && item.value === other.value))) return invalid();
  }

  // Retain a condition whose mapping cannot be justified. Keep the rest of the
  // reply usable, with no retry or second model call.
  const keepRepresented = (condition: Pick<InterpretedCriterion, "sourceText" | "importance">, grounded: boolean,
    fallbackWording = condition.sourceText) => {
    const { sourceText, importance } = condition;
    const coveringQuote = [...structuredQuotes]
      .filter((quote) => quoteIsWithin(context.query, sourceText, quote))
      .sort((a, b) => b.length - a.length)[0];
    if (coveringQuote === undefined && grounded) return true;

    const wording = coveringQuote ?? fallbackWording;
    const previous = unresolved.get(wording);
    if (!previous) unresolved.set(wording, {
      id: `${context.requestId}:unresolved:${unresolved.size + 1}`, sourceText: wording, importance,
    });
    else if (priorityRank[importance] > priorityRank[previous.importance]) unresolved.set(wording, { ...previous, importance });
    return false;
  };
  const managementScopes = managementScopeClauses(context.query);
  const retainedScopes = new Set<string>();
  const guardManagementScope = (item: Pick<InterpretedCriterion, "sourceText" | "importance">,
    includesStructure: boolean, grouped = false) => {
    for (const scope of managementScopes) {
      if (!includesStructure && !scope.conditional) continue;
      const offset = overlappingQuoteOffset(context.query, item.sourceText, scope.start, scope.end);
      if (offset < 0) continue;
      const wording = grouped ? context.query.slice(Math.min(offset, scope.start), Math.max(offset + item.sourceText.length, scope.end))
        : scope.sourceText;
      keepRepresented({ sourceText: wording, importance: scope.required ? "must" : item.importance }, false);
      retainedScopes.add(scope.sourceText);
      return false;
    }
    return true;
  };
  const representedCriteria = criteria.filter((item) => {
    if (!guardManagementScope(item, item.featureId === "structure")) return false;
    if (item.featureId === CAMPAIGN_HOURS_FEATURE) {
      const comparison = readQuotedHourComparison(context.query, item.sourceText);
      return keepRepresented(item, comparison.operator === item.operator, comparison.wording);
    }
    return keepRepresented(item, hasDirectMechanicCue(item.featureId, item.sourceText));
  });
  const representedAlternatives = alternatives.filter((item) => guardManagementScope(item, item.options.some(({ featureId }) => featureId === "structure"), true)
    && keepRepresented(item, item.options.every(({ featureId }) => hasDirectMechanicCue(featureId, item.sourceText))));
  // Recognized explicit requirements also survive a reply that silently omits them.
  const requiredScopes = managementScopes.filter(({ required }) => required);
  for (const { sourceText } of requiredScopes) {
    if (!retainedScopes.has(sourceText)) keepRepresented({ sourceText, importance: "must" }, false);
  }
  if (unresolved.size > MAX_RETURNED_UNRESOLVED_REQUIREMENTS) return invalid();
  const status = value.status === "ready" && (conditions.length > 0 || requiredScopes.length > 0) && !representedCriteria.length
    && !representedAlternatives.length && !value.excludedGameIds.length ? "unsupported" : value.status as ValidatedInterpretation["status"];

  return {
    status,
    criteria: representedCriteria,
    alternatives: representedAlternatives,
    excludedGameIds: [...new Set(value.excludedGameIds as string[])],
    unhandledRequirements: [...unresolved.keys()],
    unresolvedRequirements: [...unresolved.values()],
    clarification,
    taxonomyVersion: context.taxonomyVersion,
    interpretationVersion: INTERPRETATION_VERSION,
    requestId: context.requestId,
  };
}

/** A provider-compatible strict schema. Feature/value compatibility is checked above. */
export function createInterpretationJsonSchema(catalogue: readonly CatalogueIdentity[]): Record<string, unknown> {
  const stringValues = [...new Set(TAXONOMY.flatMap((feature) => feature.options
    .map((option) => option.value).filter((item): item is string => typeof item === "string")))];
  const categoricalValues = [{ type: "string", enum: stringValues }, { type: "boolean" }];
  return {
    type: "object", additionalProperties: false, required: [...currentModelRootKeys],
    properties: {
      status: { type: "string", enum: ["ready", "clarification", "unsupported"] },
      criteria: {
        type: "array", maxItems: MAX_REPRESENTED_CONDITIONS,
        items: {
          type: "object", additionalProperties: false, required: [...criterionKeys],
          properties: {
            featureId: { type: "string", enum: TAXONOMY.map((feature) => feature.id) },
            value: { anyOf: [
              ...categoricalValues,
              { type: "integer", minimum: CAMPAIGN_HOUR_TARGET.min, maximum: CAMPAIGN_HOUR_TARGET.max },
            ] },
            operator: { type: "string", enum: ["eq", "neq", ...NUMERIC_COMPARISONS] },
            importance: { type: "string", enum: ["must", "preferred"] },
            weight: { type: "integer", enum: [1, 3] },
            sourceText: { type: "string" },
          },
        },
      },
      alternatives: {
        type: "array", maxItems: MAX_ALTERNATIVE_GROUPS,
        items: {
          type: "object", additionalProperties: false, required: [...alternativeKeys],
          properties: {
            sourceText: { type: "string" },
            importance: { type: "string", enum: ["must", "preferred"] },
            weight: { type: "integer", enum: [1, 3] },
            options: {
              type: "array", minItems: MIN_ALTERNATIVE_OPTIONS, maxItems: MAX_ALTERNATIVE_OPTIONS,
              items: {
                type: "object", additionalProperties: false, required: [...optionKeys],
                properties: {
                  featureId: { type: "string", enum: TAXONOMY.filter((feature) => feature.options.length).map((feature) => feature.id) },
                  value: { anyOf: categoricalValues },
                  operator: { type: "string", enum: ["eq", "neq"] },
                },
              },
            },
          },
        },
      },
      excludedGameIds: { type: "array", maxItems: catalogue.length, items: { type: "string", enum: catalogue.map((game) => game.id) } },
      unhandledRequirements: {
        type: "array", maxItems: MAX_MODEL_UNHANDLED,
        items: {
          type: "object", additionalProperties: false, required: [...unresolvedKeys],
          properties: {
            sourceText: { type: "string" },
            importance: { type: "string", enum: [...unresolvedPriorities] },
          },
        },
      },
      clarification: {
        anyOf: [
          { type: "null" },
          {
            type: "object", additionalProperties: false, required: ["question", "choices"],
            properties: {
              question: { type: "string" },
              choices: { type: "array", minItems: 2, maxItems: 4, items: { type: "string" } },
            },
          },
        ],
      },
    },
  };
}
