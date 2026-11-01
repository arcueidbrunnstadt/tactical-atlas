import type { Locale } from "./i18n.ts";

export function pathLocale(pathname: string): Locale | null {
  return /^\/zh\/?$/.test(pathname) ? "zh" : /^\/en\/?$/.test(pathname) ? "en" : null;
}

/** Explicit links win, then a saved preference, then the browser's supported language. */
export function preferredLocale(pathname: string, saved?: string | null, acceptLanguage = ""): Locale {
  const explicit = pathLocale(pathname);
  if (explicit) return explicit;
  if (saved === "zh" || saved === "en") return saved;
  const choices = acceptLanguage.split(",").map((item, index) => {
    const [tag, quality] = item.trim().split(";q=");
    return { tag: tag.toLowerCase(), quality: quality === undefined ? 1 : Number(quality), index };
  }).filter(({ quality }) => Number.isFinite(quality) && quality > 0 && quality <= 1)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  for (const { tag } of choices) {
    if (/^zh(?:-|$)/.test(tag)) return "zh";
    if (/^en(?:-|$)/.test(tag)) return "en";
  }
  return "en";
}

export const localeMetadata = (locale: Locale) => ({
  title: locale === "zh" ? "Tactical Atlas — 寻找你的下一种玩法" : "Tactical Atlas — Find your next way to play",
  description: locale === "zh"
    ? "从你的偏好出发，探索回合制战术游戏的机制、取舍与信息来源。一个开放的实验性游戏发现项目。"
    : "Explore turn-based tactical games through your preferences, source-linked mechanics and visible tradeoffs. An experimental, open game-discovery project.",
  alternates: { canonical: `/${locale}`, languages: { en: "/en", "zh-CN": "/zh" } },
});
