import { isAllowedValue, TAXONOMY, TAXONOMY_VERSION } from "./taxonomy.ts";
import type { Criterion, GameRecord, SearchQuery } from "./types.ts";

export const INTERPRETATION_VERSION = "1.0";
export const MAX_QUERY_CHARACTERS = 1_000;
export const MAX_QUERY_BYTES = 4 * 1024;

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
  operator: "eq" | "neq";
  sourceText: string;
}

export interface ValidatedInterpretation extends SearchQuery {
  status: "ready" | "clarification" | "unsupported";
  criteria: InterpretedCriterion[];
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
const criterionKeys = ["featureId", "value", "operator", "importance", "weight", "sourceText"] as const;

/** Cross-field checks remain necessary even when the provider follows JSON Schema. */
export function validateModelInterpretation(
  value: unknown,
  context: InterpretRequestBody & { catalogue: readonly CatalogueIdentity[] },
): ValidatedInterpretation {
  const invalid = (): never => { throw new QueryValidationError("INVALID_INTERPRETATION"); };
  if (!record(value) || !exactKeys(value, modelRootKeys)
      || !["ready", "clarification", "unsupported"].includes(String(value.status))
      || !Array.isArray(value.criteria) || value.criteria.length > 16
      || !Array.isArray(value.excludedGameIds) || value.excludedGameIds.length > context.catalogue.length
      || !Array.isArray(value.unhandledRequirements) || value.unhandledRequirements.length > 8) return invalid();

  const criteria: InterpretedCriterion[] = [];
  for (const [index, candidate] of value.criteria.entries()) {
    if (!record(candidate) || !exactKeys(candidate, criterionKeys)
        || typeof candidate.featureId !== "string" || !isAllowedValue(candidate.featureId, candidate.value)
        || (candidate.operator !== "eq" && candidate.operator !== "neq")
        || (candidate.importance !== "must" && candidate.importance !== "preferred")
        || (candidate.weight !== 1 && candidate.weight !== 3)
        || !boundedText(candidate.sourceText, MAX_QUERY_CHARACTERS)
        || !context.query.includes(candidate.sourceText)) return invalid();
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
  if (criteria.filter((item) => item.importance === "must").length > 8
      || criteria.filter((item) => item.importance === "preferred").length > 8) return invalid();

  const allowedIds = new Set(context.catalogue.map((game) => game.id));
  if (!value.excludedGameIds.every((id) => typeof id === "string" && allowedIds.has(id))
      || !value.unhandledRequirements.every((item) => boundedText(item, 240))) return invalid();

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
    if (musts.some((item) => musts.some((other) => item.featureId === other.featureId
        && item.value === other.value && item.operator !== other.operator))) return invalid();
  }

  return {
    status: value.status as ValidatedInterpretation["status"],
    criteria,
    excludedGameIds: [...new Set(value.excludedGameIds as string[])],
    unhandledRequirements: [...new Set(value.unhandledRequirements as string[])],
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
  return {
    type: "object", additionalProperties: false, required: [...modelRootKeys],
    properties: {
      status: { type: "string", enum: ["ready", "clarification", "unsupported"] },
      criteria: {
        type: "array", maxItems: 16,
        items: {
          type: "object", additionalProperties: false, required: [...criterionKeys],
          properties: {
            featureId: { type: "string", enum: TAXONOMY.map((feature) => feature.id) },
            value: { anyOf: [{ type: "string", enum: stringValues }, { type: "boolean" }] },
            operator: { type: "string", enum: ["eq", "neq"] },
            importance: { type: "string", enum: ["must", "preferred"] },
            weight: { type: "integer", enum: [1, 3] },
            sourceText: { type: "string" },
          },
        },
      },
      excludedGameIds: { type: "array", maxItems: catalogue.length, items: { type: "string", enum: catalogue.map((game) => game.id) } },
      unhandledRequirements: { type: "array", maxItems: 8, items: { type: "string" } },
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
