import type { GameRecord } from "./types.ts";
import { translate } from "./i18n.ts";
import { TAXONOMY } from "./taxonomy.ts";

type TitleIdentity = Pick<GameRecord, "id" | "title" | "aliases">;

export interface TitleExclusion {
  sourceText: string;
  gameIds: string[];
  importance: "must" | "unknown";
}

const quotedTitle = /"[^"\n]+"|“[^”\n]+”|‘[^’\n]+’|《[^》\n]+》|「[^」\n]+」/u;
const wholeQuotedTitle = new RegExp(`^(?:${quotedTitle.source}|'[^'\\n]+')$`, "u");
const sentenceBreak = /[。！？!?;；\n]|\.(?=\s|$)/u;
const listBreak = /[,，、]\s*(?:and\s+)?|\s+and\s+|以及|和/iu;
const titleMarker = /^(?:the (?:game|title)(?: called| named)?\s+|(?:游戏|遊戲)(?:\s+|(?=[《「]))|(?:名为|名為|叫作)\s*)/iu;
const followingCondition = /^(?:(?:but\s+)?only\s+if|unless)\b|^(?:但仅当|仅当|只有|除非)/iu;

function splitOutsideTitles(text: string, separator: RegExp, keepQuestion = false): string[] {
  const parts: string[] = [];
  let start = 0;
  for (const match of text.matchAll(new RegExp(`${quotedTitle.source}|(${separator.source})`, `g${separator.flags}`))) {
    if (match[1] === undefined) continue;
    const end = match.index + (keepQuestion && /^[?？]$/u.test(match[0]) ? match[0].length : 0);
    parts.push(text.slice(start, end).trim());
    start = match.index + match[0].length;
  }
  return [...parts, text.slice(start).trim()];
}

function excludedTitle(clause: string): string | undefined {
  const direct = /^(?:(?:please|also)\s+)*(?:exclude|leave\s+out|skip|(?:do\s+not|don['’]t)\s+(?:include|recommend)|I\s+(?:do\s+not|don['’]t)\s+want(?:\s+to\s+(?:play|see))?)\s+(.+)$/iu.exec(clause)
    ?? /^(?:请\s*|我\s*)?(?:排除|不要推荐|不想看到|不想玩|别推荐|跳过)\s*(.+)$/u.exec(clause);
  if (direct) {
    return direct[1].replace(/,\s*(?:since|because)\s+I(?:['’]ve| have) already played (?:it|them)$/iu, "").trim();
  }
  const splitVerb = /^(?:(?:please|also)\s+)*leave\s+(.+)\s+out$/iu.exec(clause)
    ?? /^(?:请\s*)?把\s*(.+?)\s*排除(?:掉)?$/u.exec(clause);
  if (splitVerb) return splitVerb[1];
  // Resolve a pronoun only when the title and explicit exclusion share the same clause.
  return /^I(?:['’]ve| have) already played (.+?),\s*so\s+(?:please\s+)?(?:leave (?:it|that one) out|exclude it|skip it)$/iu.exec(clause)?.[1]
    ?? /^(.+?)\s*我已经玩过了?\s*[,，]\s*(?:请\s*)?(?:排除|跳过)(?:它|这款(?:游戏)?|该游戏)$/u.exec(clause)?.[1];
}

function includedTitle(clause: string): string | undefined {
  return /^(?:actually,?\s*)?(?:please\s+)?(?:include|keep|(?:I\s+)?(?:do\s+not|don['’]t)\s+(?:want\s+to\s+)?(?:exclude|skip|leave\s+out))\s+(.+)$/iu.exec(clause)?.[1]
    ?? /^(?:请\s*|我\s*)?(?:保留|不要排除|不想排除|别排除)\s*(.+)$/u.exec(clause)?.[1];
}

function titleKey(text: string): string {
  const normalized = text.normalize("NFKC").trim();
  return (wholeQuotedTitle.test(normalized) ? normalized.slice(1, -1).trim() : normalized)
    .replace(/\s+/gu, " ").toLocaleLowerCase("en");
}

const facetNames = new Set(TAXONOMY.flatMap(({ label, options }) => [label, ...options.map((item) => item.label)]
  .flatMap((text) => [titleKey(text), titleKey(translate("zh", text))])));

/** Resolve only explicit, whole-title directives. An empty ID list means the title needs checking. */
export function resolveTitleExclusions(query: string, catalogue: readonly TitleIdentity[]): TitleExclusion[] {
  const clauses = splitOutsideTitles(query, sentenceBreak, true);
  let previousEnd = 0;
  const requested = clauses.flatMap((sourceText, index) => {
    const start = query.indexOf(sourceText, previousEnd);
    previousEnd = start + sourceText.length;
    const question = /[?？]$/u.test(sourceText);
    const operand = excludedTitle(question ? sourceText.slice(0, -1).trimEnd() : sourceText);
    if (!operand) return [];
    const next = clauses[index + 1];
    const conditional = next !== undefined && followingCondition.test(next);
    const wording = conditional ? query.slice(start, query.indexOf(next, previousEnd) + next.length) : sourceText;
    return [{ sourceText: wording, operand, question, conditional }];
  });
  if (!requested.length) return [];

  const idsByTitle = new Map<string, Set<string>>();
  for (const game of catalogue) {
    for (const name of [game.title, ...game.aliases]) {
      const key = titleKey(name);
      if (!key) continue;
      const ids = idsByTitle.get(key) ?? new Set<string>();
      ids.add(game.id);
      idsByTitle.set(key, ids);
    }
  }

  const idsFor = (operand: string) => {
    const key = titleKey(operand);
    const hasQuote = wholeQuotedTitle.test(operand.normalize("NFKC"));
    const marker = titleMarker.exec(operand)?.[0];
    if (!marker && !hasQuote && facetNames.has(key)) return undefined;
    const unmarked = marker && operand.slice(marker.length);
    return idsByTitle.get(key) ?? (unmarked ? idsByTitle.get(titleKey(unmarked)) : undefined);
  };
  const partsFor = (operand: string) => idsFor(operand) ? [operand] : splitOutsideTitles(operand, listBreak);
  const inclusions = clauses.map((clause) => includedTitle(clause.replace(/[?？]$/u, "").trimEnd()));
  const hasUnresolvedReversal = inclusions.some((operand) => operand !== undefined
    && /^(?:it|that (?:one|title|game)|它|这款(?:游戏)?)$/iu.test(operand));
  const includedIds = new Set(inclusions.flatMap((operand) => operand
    ? partsFor(operand).flatMap((name) => [...(idsFor(name) ?? [])]) : []));

  return requested.flatMap(({ sourceText, operand, question, conditional }) => {
    const names = partsFor(operand);
    const candidates = names.map((name) => [...(idsFor(name) ?? [])]);
    // A bare phrase such as "exclude fantasy" can refer to a feature. Require
    // a known identity or a quoted title before treating it as a title request.
    if (!candidates.some((ids) => ids.length) && !names.some((name) => wholeQuotedTitle.test(name.normalize("NFKC")) || titleMarker.test(name))) return [];
    const uncertain = question || hasUnresolvedReversal || candidates.some((ids) => ids.some((id) => includedIds.has(id)));
    const verified = !uncertain && !conditional && candidates.every((ids) => ids.length === 1);
    return [{ sourceText, gameIds: verified ? [...new Set(candidates.flat())] : [], importance: uncertain ? "unknown" : "must" }];
  });
}
