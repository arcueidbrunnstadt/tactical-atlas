import type { GameRecord } from "./types.ts";
import type { Locale } from "./i18n.ts";

export interface GameTranslation {
  title?: string;
  summary: string;
  editionScope?: string;
  notes?: string[];
  tradeoffs?: string[];
  evidence?: Record<string, { statement: string; locator?: string; limitations?: string[] }>;
}
export type GameTranslations = Record<string, GameTranslation>;

/** Display copy only: identities, facets and evidence links keep their original meaning. */
export function localizeGame(game: GameRecord, locale: Locale, translations: GameTranslations): GameRecord {
  const copy = locale === "zh" ? translations[game.id] : undefined;
  if (!copy) return game;
  return {
    ...game,
    title: copy.title || game.title,
    summary: copy.summary || game.summary,
    editionScope: copy.editionScope || game.editionScope,
    notes: game.notes.map((note, index) => ({ ...note, text: copy.notes?.[index] || note.text })),
    tradeoffs: game.tradeoffs.map((note, index) => ({ ...note, text: copy.tradeoffs?.[index] || note.text })),
    evidence: game.evidence.map((evidence) => {
      const translated = copy.evidence?.[evidence.id];
      return translated ? { ...evidence, statement: translated.statement || evidence.statement,
        locator: translated.locator || evidence.locator, limitations: translated.limitations ?? evidence.limitations } : evidence;
    }),
  };
}
