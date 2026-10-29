/** Public catalogue records. Evidence support describes the recorded source scope. */
export type FacetValue = string | boolean | string[] | null;
export type FacetStatus = "source_supported" | "provisional" | "unknown";
export type CriterionValue = string | boolean;
export type ReasonStatus = "match" | "mismatch" | "unknown";

export interface GameFacet {
  value: FacetValue;
  status: FacetStatus;
  evidenceIds: string[];
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

export interface GameRecord {
  id: string;
  title: string;
  aliases: string[];
  storeUrl: string;
  editionScope: string;
  summary: string;
  facets: Record<string, GameFacet>;
  notes: EvidenceNote[];
  tradeoffs: EvidenceNote[];
  evidence: EvidenceRecord[];
}

export interface Criterion {
  id: string;
  featureId: string;
  value: CriterionValue;
  operator?: "eq" | "neq";
  importance: "must" | "preferred";
  weight: 1 | 3;
}

export type Criteria = Criterion;

export interface SearchQuery {
  criteria: Criterion[];
  excludedGameIds: string[];
  unhandledRequirements: string[];
}

export type Query = SearchQuery;

export interface MatchReason {
  criterionId: string;
  label: string;
  status: ReasonStatus;
  text: string;
  evidenceIds: string[];
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
  subjective?: boolean;
}
