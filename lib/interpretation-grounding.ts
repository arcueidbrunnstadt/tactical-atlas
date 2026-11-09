// These broad mechanics are easy to use as substitutes for more specific requests.
// Require a direct cue for the actual feature, even when its quote is verbatim.
// This is a conservative admission check; a cue alone cannot establish intent.
const directMechanicCues: ReadonlyMap<string, RegExp> = new Map([
  ["positioning", /\b(?:positioning|unit placement|where (?:your|my|the) units (?:stand|are placed))\b|走位|站位|单位(?:的)?摆放|單位(?:的)?擺放/iu],
  ["combos", /\b(?:(?:interacting|combining) (?:abilities|skills|spells)|(?:abilit(?:y|ies)|skills?|spells?) (?:interactions?|combinations?|combos?|synerg(?:y|ies)|that (?:interact|work together)))\b|(?:技能|能力|法术|法術)(?:间|間|之间|之間)?(?:联动|聯動|互动|互動|配合|组合|組合)/iu],
]);

export function hasDirectMechanicCue(featureId: string, quote: string): boolean {
  const pattern = directMechanicCues.get(featureId);
  return !pattern || pattern.test(quote.normalize("NFKC"));
}

const punctuationWidth: Readonly<Record<string, string>> = {
  "，": ",", "；": ";", "！": "!", "？": "?", "：": ":",
};
const closingQuote: Readonly<Record<string, string>> = { '"': '"', "“": "”", "「": "」", "『": "』" };

/** Rebind presentation-only changes to a unique span in the original request. */
export function originalQuote(query: string, supplied: string): string | undefined {
  if (query.includes(supplied)) return supplied;
  const trimmed = supplied.trim();
  const quote = trimmed.length > 1 && closingQuote[trimmed[0]] === trimmed.at(-1)
    ? trimmed.slice(1, -1).trim() : trimmed;
  if (!quote) return;
  const narrow = (text: string) => text.replace(/[，；！？：]/gu, (character) => punctuationWidth[character]);
  const request = narrow(query);
  const normalizedQuote = narrow(quote);
  const start = request.indexOf(normalizedQuote);
  if (start >= 0 && request.indexOf(normalizedQuote, start + 1) < 0) return query.slice(start, start + quote.length);
}

// This is independent evidence for a positive preference. A topic mention,
// conditional, negated statement or mandatory request does not qualify.
const equipmentPreference = /^(?:I(?:['’]d| would)? prefer (?:equipment customization|to customize (?:my )?equipment)|equipment customization (?:would be nice(?: either way)?|would be a bonus)|(?:(?:无论|無論|不论|不論|不管)(?:什么|什麼|哪种|哪種)?(?:题材|題材)[,，]\s*)?有?(?:装备|裝備)(?:定制|订制|訂製|自定义|自定義|客製化)(?:功能)?就?(?:更好了?|会更好|會更好|是加分[项項]))$/iu;

export function explicitEquipmentPreference(query: string): string | undefined {
  const clauses = query.split(/[.!?;。！？；\r\n]+/u).map((clause) => clause.trim());
  const matches = clauses.filter((clause) => equipmentPreference.test(clause));
  return matches.length === 1 ? matches[0] : undefined;
}

// Structure records management types. They do not establish whether a role can
// be avoided, must be performed, or suffices for a whole campaign.
const managementRole = /\b(?:compan(?:y|ies)|rosters?|squads?|fireteams?|parties|party)\b|佣兵[团團]|兵[团團]|小[队隊]|分[队隊]|[队隊]伍|[阵陣]容|名[册冊]/iu;
const roleScope = [
  /\b(?:makes?|forces?|requires?)\s+(?:me|you|us|(?:the\s+)?players?)\b|\b(?:management|upkeep|administration)\s+(?:is|are|would be)\s+(?:required|mandatory|compulsory|optional|unavoidable|skippable)\b/iu,
  /\b(?:required|mandatory|compulsory|optional|unavoidable|skippable)\s+(?:(?:company|roster|squad|campaign)\s+)?(?:management|upkeep|administration)\b|\b(?:can|could|able to)\s+(?:skip|avoid|ignore|bypass|opt out)\b/iu,
  /\b(?:stick to|(?:only|just)\s+(?:manage|command|control|lead|run|deploy)|(?:only|just)\s+one)\b|\b(?:single|one small)\s+(?:squad|fireteam)\b|\bone\s+(?:squad|fireteam)\s+(?:only|throughout|from start to finish)\b/iu,
  /强制|強制|强迫|強迫|被迫|不得不|(?:都得|非得)(?:要)?(?:管理|经营|經營|指[挥揮])|(?:战役|戰役|游戏|遊戲)(?:里|中)?(?:必须|必須)(?:要)?(?:管理|经营|經營)|可[选選]|可跳[过過]|能(?:完全)?跳[过過]|[只僅仅](?:[带帶]|靠|管理|指[挥揮]|控制)/u,
];
const conditionalRole = /^(?:if|unless|when)\b|\b(?:only if|unless|provided that)\b|^(?:如果|假如|若|除非|只有|只要)|前提是/iu;
const userRequirement = /\b(?:I|we)\s+(?:must|need|won['’]t\s+(?:play|consider)|will not\s+(?:play|consider))\b|\b(?:skip games|non-negotiable|hard requirement)\b|(?:我|玩家)必须|(?:我|玩家)必須|必须能|必須能|我就不(?:玩|考[虑慮])|硬性要求/iu;

export function managementScopeClauses(query: string) {
  // Keep conditional commas and dependent qualifications together. Split only
  // at sentence boundaries or an explicit start of an independent request.
  const boundaries = /[.!?;。！？；\r\n]+|[,，]\s*(?:and\s+(?=(?:I|we)\s+(?:also|separately)\b)|(?=另外|此外))/giu;
  const clauses: { sourceText: string; start: number; end: number; conditional: boolean; required: boolean }[] = [];
  function addClause(from: number, to: number) {
    const raw = query.slice(from, to);
    const sourceText = raw.trim();
    const normalized = sourceText.normalize("NFKC");
    const conditional = conditionalRole.test(normalized);
    if (!managementRole.test(normalized) || !(conditional || roleScope.some((cue) => cue.test(normalized)))) return;
    const start = from + raw.length - raw.trimStart().length;
    clauses.push({ sourceText, start, end: start + sourceText.length, conditional, required: userRequirement.test(normalized) });
  }
  let from = 0;
  for (const match of query.matchAll(boundaries)) {
    addClause(from, match.index);
    from = match.index + match[0].length;
  }
  addClause(from, query.length);
  return clauses;
}

export function overlappingQuoteOffset(query: string, quote: string, start: number, end: number): number {
  for (let offset = query.indexOf(quote); offset >= 0 && offset < end; offset = query.indexOf(quote, offset + 1)) {
    if (offset + quote.length > start) return offset;
  }
  return -1;
}

/** Does this unresolved wording cover every occurrence of the represented quote? */
export function quoteIsWithin(query: string, quote: string, unresolved: string): boolean {
  if (quote === unresolved) return true;
  if (!unresolved.includes(quote)) return false;
  let start = query.indexOf(unresolved);
  for (let offset = query.indexOf(quote); offset >= 0; offset = query.indexOf(quote, offset + 1)) {
    while (start >= 0 && start + unresolved.length < offset + quote.length) {
      start = query.indexOf(unresolved, start + 1);
    }
    if (start < 0 || start > offset) return false;
  }
  return true;
}
