import type { Criterion, CriterionValue, FeatureDefinition } from "./types.ts";
import { translate, type Locale } from "./i18n.ts";

export const TAXONOMY_VERSION = "1.0";

export const TAXONOMY: readonly FeatureDefinition[] = [
  {
    id: "setting",
    label: "Setting",
    options: [
      { value: "fantasy", label: "Fantasy" },
      { value: "scifi", label: "Science fiction" },
      { value: "contemporary", label: "Contemporary" },
      { value: "historical", label: "Historical" },
    ],
  },
  {
    id: "structure",
    label: "You manage",
    options: [
      { value: "party", label: "An adventuring party" },
      { value: "squad", label: "A tactical squad" },
      { value: "company", label: "A company or roster" },
    ],
  },
  {
    id: "campaign",
    label: "Campaign structure",
    options: [
      { value: "compact", label: "Compact encounters" },
      { value: "mission", label: "Mission-based campaign" },
      { value: "open", label: "Open campaign" },
    ],
  },
  {
    id: "progression",
    label: "Character and unit development",
    options: [
      { value: "class_based", label: "Class and ability choices" },
      { value: "skill_based", label: "Skill and perk choices" },
      { value: "equipment", label: "Equipment customization" },
      { value: "unique_characters", label: "Distinct named characters" },
    ],
  },
  {
    id: "positioning",
    label: "Positioning mechanics",
    options: [
      { value: true, label: "Include positioning mechanics" },
      { value: false, label: "No positioning mechanics" },
    ],
  },
  {
    id: "combos",
    label: "Ability interactions",
    options: [
      { value: true, label: "Include interacting abilities" },
      { value: false, label: "No interacting abilities" },
    ],
  },
  {
    id: "narrative",
    label: "Narrative emphasis",
    subjective: true,
    options: [
      { value: true, label: "Prefer a story emphasis" },
      { value: false, label: "Prefer less story emphasis" },
    ],
  },
  {
    id: "offline",
    label: "Offline play",
    options: [
      { value: true, label: "Require offline play" },
      { value: false, label: "Offline play is not supported" },
    ],
  },
];

const CHINESE_TAXONOMY: readonly FeatureDefinition[] = TAXONOMY.map((feature) => ({
  ...feature,
  label: translate("zh", feature.label),
  options: feature.options.map((option) => ({ ...option, label: translate("zh", option.label) })),
}));

export function getTaxonomy(locale: Locale = "en"): readonly FeatureDefinition[] {
  return locale === "zh" ? CHINESE_TAXONOMY : TAXONOMY;
}

export function getFeature(featureId: string, locale: Locale = "en"): FeatureDefinition | undefined {
  return getTaxonomy(locale).find((feature) => feature.id === featureId);
}

export function getFeatureLabel(featureId: string, locale: Locale = "en"): string {
  return getFeature(featureId, locale)?.label ?? translate(locale, "Unassessed requirement");
}

export function getValueLabel(featureId: string, value: CriterionValue, locale: Locale = "en"): string {
  return getFeature(featureId, locale)?.options.find((option) => option.value === value)?.label
    ?? String(value);
}

export function getCriterionLabel(criterion: Pick<Criterion, "featureId" | "value" | "operator">, locale: Locale = "en"): string {
  const feature = getFeature(criterion.featureId, locale);
  if (!feature) return translate(locale, "Unassessed requirement");
  if (criterion.operator === "neq") {
    const label = typeof criterion.value === "boolean"
      ? getValueLabel(criterion.featureId, !criterion.value, locale)
      : translate(locale, "Exclude {value}", { value: getValueLabel(criterion.featureId, criterion.value, locale) });
    return translate(locale, "{feature}: {value}", { feature: feature.label, value: label });
  }
  return translate(locale, "{feature}: {value}", { feature: feature.label, value: getValueLabel(criterion.featureId, criterion.value, locale) });
}

export function isAllowedValue(featureId: string, value: unknown): value is CriterionValue {
  return getFeature(featureId)?.options.some((option) => option.value === value) ?? false;
}
