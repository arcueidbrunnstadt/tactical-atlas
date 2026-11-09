import type { NumericComparisonOperator } from "./numeric-comparison.ts";

/** Public catalogue records. Evidence support describes the recorded source scope. */
export type FacetValue = string | boolean | string[] | null;
export type FacetStatus = "source_supported" | "provisional" | "unknown";
export type CriterionValue = string | boolean | number;
export type CriterionOperator = "eq" | "neq" | NumericComparisonOperator;
export type ReasonStatus = "match" | "partial" | "mismatch" | "unknown";

export interface GameFacet {
  value: FacetValue;
  status: FacetStatus;
  evidenceIds: string[];
  /** Evidence for each categorical value known to be absent in the recorded scope. */
  absentValues?: { value: string; evidenceIds: string[] }[];
}

export interface EvidenceRecord {
  id: string;
  statement: string;
  basis: "source_report" | "recorded_observation" | "provisional_assessment";
  url: string;
  locator: string;
  checkedDate: string;
  limitations: string[];
}

export interface EvidenceNote {
  text: string;
  evidenceIds: string[];
}

/** Published base campaign estimates for reaching a story ending, in hours. */
export interface CampaignDuration {
  kind: "approximate" | "range" | "lower_bound";
  lowerHours: number;
  upperHours: number | null;
  evidenceIds: string[];
}

export interface GameRecord {
  id: string;
  title: string;
  aliases: string[];
  storeUrl: string;
  editionScope: string;
  summary: string;
  facets: Record<string, GameFacet>;
  campaignDuration?: CampaignDuration;
  notes: EvidenceNote[];
  tradeoffs: EvidenceNote[];
  evidence: EvidenceRecord[];
}

export interface Criterion {
  id: string;
  featureId: string;
  value: CriterionValue;
  operator?: CriterionOperator;
  importance: "must" | "preferred";
  weight: 1 | 3;
}

export type Criteria = Criterion;

export interface AlternativeOption {
  featureId: string;
  value: string | boolean;
  operator: "eq" | "neq";
}

/** Any one option satisfies this condition. Other conditions still apply separately. */
export interface AlternativeGroup {
  id: string;
  sourceText?: string;
  options: AlternativeOption[];
  importance: Criterion["importance"];
  weight: Criterion["weight"];
}

export interface UnresolvedRequirement {
  id: string;
  sourceText: string;
  importance: Criterion["importance"] | "unknown";
}

export interface SearchQuery {
  criteria: Criterion[];
  excludedGameIds: string[];
  unhandledRequirements: string[];
  unresolvedRequirements?: UnresolvedRequirement[];
  alternatives?: AlternativeGroup[];
}

export type Query = SearchQuery;

export interface MatchReason {
  criterionId: string;
  label: string;
  status: ReasonStatus;
  text: string;
  evidenceIds: string[];
  preferenceFit?: number;
}

export interface MatchResult {
  game: GameRecord;
  score: number;
  reasons: MatchReason[];
}

export interface MatchGroups {
  matches: MatchResult[];
  possible: MatchResult[];
  excluded: MatchResult[];
}

export interface TaxonomyOption {
  value: CriterionValue;
  label: string;
}

export interface FeatureDefinition {
  id: string;
  label: string;
  options: readonly TaxonomyOption[];
  /** Evidence for a recorded value does not settle other values in this category. */
  categoricalCoverage?: "partial";
  numericTarget?: { min: number; max: number; defaultValue: number };
  subjective?: boolean;
}
