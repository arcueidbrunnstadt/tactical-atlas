import { NUMERIC_COMPARISONS, type NumericComparisonOperator } from "./numeric-comparison.ts";

// The first capture is the lower endpoint when a range shares one hour unit.
const hourQuantity = /(?<![\d.,+\-−])(?:(\d+)\s*(?:[-–—~]|to\b|至|到)\s*)?(\d+)\s*(?:-?\s*(?:hours?|hrs?|h)\b|[个個]?\s*(?:小时|小時))/giu;
const comparisonCues: Record<NumericComparisonOperator, { prefix: RegExp; suffix: RegExp }> = {
  gte: {
    prefix: /(?:\b(?:at least|no less than|not less than|minimum(?: of)?)(?:\s+an?)?|至少(?:需要|要|有)?|不少于|不少於|不低于|不低於|>=|≥)\s*$/iu,
    suffix: /^\s*(?:or (?:more|longer)\b|at least\b|minimum\b|以上)/iu,
  },
  near: {
    prefix: /(?:\b(?:around|about|approximately|roughly|close to)(?:\s+an?)?|大[约約]|[约約]|大概|差不多)\s*$/iu,
    suffix: /^\s*(?:or so\b|give or take\b|approximately\b|左右|上下)/iu,
  },
  lte: {
    prefix: /(?:\b(?:at most|no more than|not more than|up to|maximum(?: of)?)(?:\s+an?)?|最多(?:需要|要|有)?|至多|不超[过過]|不高于|不高於|<=|≤)\s*$/iu,
    suffix: /^\s*(?:or (?:less|fewer|shorter)\b|at most\b|max(?:imum)?\b|以[内內]|以下)/iu,
  },
};
const unsupportedScope = /\b(?:dlc|downloadable content|expansions?|add[- ]ons?|completionist|(?:full|total) completion|all (?:content|side quests?|endings?)|every (?:side quest|ending)|sessions?|(?:per|each) (?:battle|mission))\b|\b100\s*(?:%|percent\b)|全收集|全成就|全[结結]局|全[内內]容|(?:全部|所有)(?:[内內]容|支[线線])|[资資]料片|[扩擴]展包|每(?:次游玩|局|[场場])|[单單](?:次游玩|局|[场場])/iu;
const clauseBreak = /[.!?;。！？；\r\n]|[,，]\s*(?:(?:and|but|or)\b|另外|但是|而且|同时|同時)/giu;
const negatedCue = /(?:\b(?:not|never|cannot|can't)(?:\s+(?:be|want|need|require))?|并非|並非|不是|不必|无需|無需|不需要|不)\s*$/iu;

export function quotesWholeHourTarget(quote: string, target: number): boolean {
  for (const [, rangeStart, hours] of quote.normalize("NFKC").matchAll(hourQuantity)) {
    if (Number(hours) === target || Number(rangeStart) === target) return true;
  }
  return false;
}

function enclosingClause(query: string, quote: string): string {
  const start = query.indexOf(quote);
  if (start !== query.lastIndexOf(quote)) return quote;

  const end = start + quote.length;
  let left = 0;
  let right = query.length;
  for (const { 0: separator, index = 0 } of query.matchAll(clauseBreak)) {
    const after = index + separator.length;
    if (after <= start) left = after;
    else if (index >= end || after === end) {
      right = Math.max(index, end);
      break;
    }
  }
  return query.slice(left, right).trim();
}

export function readQuotedHourComparison(query: string, quote: string): { operator?: NumericComparisonOperator; wording: string } {
  const normalized = quote.normalize("NFKC");
  const clause = enclosingClause(query, quote);
  if (unsupportedScope.test(clause.normalize("NFKC"))) return { wording: clause };
  // A single quantity belongs to a single quoted comparison. Leave ranges,
  // conflicting modifiers, and multi-quantity quotes open rather than guessing.
  if ([...normalized.matchAll(/\d+/g)].length !== 1) return { wording: clause };
  const quantity = normalized.matchAll(hourQuantity).next().value;
  if (!quantity) return { wording: clause };

  const start = quantity.index ?? 0;
  const before = normalized.slice(0, start);
  const after = normalized.slice(start + quantity[0].length);
  const operators = NUMERIC_COMPARISONS.filter((operator) => {
    const { prefix, suffix } = comparisonCues[operator];
    return prefix.test(before) || suffix.test(after);
  });
  if (operators.length !== 1) return { wording: clause };

  const operator = operators[0];
  const { prefix, suffix } = comparisonCues[operator];
  const trimmedQuote = quote.trim();
  const quoteStart = clause.indexOf(trimmedQuote);
  const preceding = quoteStart < 0 ? "" : clause.slice(0, quoteStart).normalize("NFKC");
  const following = quoteStart < 0 ? "" : clause.slice(quoteStart + trimmedQuote.length).normalize("NFKC");
  const beforeCue = preceding + before.slice(0, before.match(prefix)?.index ?? before.length);
  const afterCue = after.slice(after.match(suffix)?.[0].length ?? after.length) + following;
  if (negatedCue.test(beforeCue)
      || NUMERIC_COMPARISONS.some((item) => comparisonCues[item].prefix.test(beforeCue) || comparisonCues[item].suffix.test(afterCue))) {
    return { wording: clause };
  }
  return { operator, wording: clause };
}
