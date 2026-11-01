"use client";

import { useEffect, useState } from "react";
import type { GameRecord } from "../lib/types";
import type { Locale } from "../lib/i18n";

export interface ArtworkEntry {
  src: string;
  width: number;
  height: number;
  alt: { en: string; zh: string };
  sourceUrl: string;
  credit: string;
  permissionBasis: string;
  licenseUrl?: string;
  checkedDate: string;
}
export type ArtworkMap = Record<string, ArtworkEntry>;
const PALETTES = ["sage", "clay", "ochre", "slate", "moss", "ink"];

export default function GameArtwork({ game, index = 0, locale, asset }: {
  game: GameRecord; index?: number; locale: Locale; asset?: ArtworkEntry;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [asset?.src]);
  const usable = asset && /^\/game-images\/[a-zA-Z0-9/_-]+\.(?:avif|webp|png|jpe?g)$/.test(asset.src)
    && Number.isInteger(asset.width) && asset.width > 0 && Number.isInteger(asset.height) && asset.height > 0;
  if (usable && !failed) return <figure className="game-art game-thumbnail">
    <img src={asset.src} width={asset.width} height={asset.height} alt={asset.alt[locale] || asset.alt.en}
      loading="lazy" decoding="async" onError={() => setFailed(true)} />
  </figure>;
  return <div className={`game-art game-art-fallback palette-${PALETTES[index % PALETTES.length]}`} aria-hidden="true">
    <svg viewBox="0 0 480 260" fill="none"><g stroke="currentColor" opacity=".15">
      <path d="M0 65h480M0 130h480M0 195h480M80 0v260M160 0v260M240 0v260M320 0v260M400 0v260" />
      <path d="m290 25 80 45v90l-80 45-80-45V70l80-45Zm-50 60 50-28 50 28v60l-50 28-50-28V85Z" strokeWidth="2" />
      <circle cx="290" cy="115" r="15" fill="currentColor" /><path d="m290 130-25 40h50l-25-40Z" fill="currentColor" />
    </g></svg>
    <span className="art-code">TACTICAL ATLAS / {String(index + 1).padStart(2, "0")}</span>
    <strong className="art-title">{game.title}</strong>
  </div>;
}
