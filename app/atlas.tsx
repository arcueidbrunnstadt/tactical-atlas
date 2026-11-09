"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { describeCampaignDuration, evaluateAlternativeGroup, evaluateCriterion, matchGames } from "../lib/match";
import { NUMERIC_COMPARISONS, NUMERIC_COMPARISON_LABELS, isNumericComparisonOperator } from "../lib/numeric-comparison";
import { CAMPAIGN_HOURS_FEATURE, MAX_ALTERNATIVE_GROUPS, MAX_ALTERNATIVE_OPTIONS, MIN_ALTERNATIVE_OPTIONS, getAlternativeOptionKey, getCriterionLabel, getFeature, getValueLabel, isAllowedOperator, isAllowedValue, getTaxonomy, TAXONOMY_VERSION } from "../lib/taxonomy";
import type { AlternativeGroup, AlternativeOption, Criterion, GameRecord, MatchResult, SearchQuery, UnresolvedRequirement } from "../lib/types";
import FeedbackForm from "./feedback-form";
import GameArtwork, { type ArtworkMap } from "./game-artwork";
import { translate, searchErrorKey, type Locale } from "../lib/i18n";
import { localizeGame, type GameTranslations } from "../lib/catalogue-localization";
import { pathLocale, localeMetadata } from "../lib/locale-routing";
import { MAX_RETURNED_UNRESOLVED_REQUIREMENTS } from "../lib/query-schema";
const EMPTY_QUERY: SearchQuery = { criteria: [], excludedGameIds: [], unhandledRequirements: [] };
const EXAMPLES = [
    { label: "Fantasy & character building", text: "I want fantasy turn-based combat with plenty of character-building choices. A story is a bonus." },
    { label: "Positioning over progression", text: "I prefer compact tactical encounters built around positioning and interacting abilities." },
    { label: "A military campaign", text: "I want a military or science-fiction squad campaign. Exclude XCOM 2; I have already played it." },
];
const REPOSITORY = "https://github.com/arcueidbrunnstadt/tactical-atlas";
class SearchSubmissionError extends Error {}
function Arrow({ diagonal = false }: {
    diagonal?: boolean;
}) {
    return <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d={diagonal ? "M5 15 15 5M5 5h10v10" : "M3 10h13M11 5l5 5-5 5"} stroke="currentColor" strokeWidth="1.4"/></svg>;
}
function Brand() {
    return <span className="brand"><svg width="34" height="34" viewBox="0 0 36 36" fill="none" aria-hidden="true"><path d="M5 5h10v10H5zM21 5h10v10H21zM5 21h10v10H5z" stroke="currentColor" strokeWidth="1.5"/><path d="m26 19 7 7-7 7-7-7 7-7Z" fill="currentColor"/><path d="M10 8v4M8 10h4" stroke="currentColor" strokeWidth="1.3"/></svg><span>Tactical Atlas</span></span>;
}
function safeUrl(url: string) { return /^https?:\/\//i.test(url) ? url : "#"; }
function asObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("The search response could not be read.");
    return value as Record<string, unknown>;
}
function facetLabel(game: GameRecord, feature: string, locale: Locale) {
    if (feature === CAMPAIGN_HOURS_FEATURE) return describeCampaignDuration(game, locale);
    const facet = game.facets[feature];
    if (!facet || facet.status === "unknown" || facet.value === null)
        return translate(locale, "Not assessed");
    const values = Array.isArray(facet.value) ? facet.value : [facet.value];
    return values.map((value) => getValueLabel(feature, value, locale)).join(" · ");
}
function isAlternativeOption(value: unknown): value is AlternativeOption {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const { featureId, operator, value: target } = value as Record<string, unknown>;
    return typeof featureId === "string" && (typeof target === "string" || typeof target === "boolean")
        && (operator === "eq" || operator === "neq") && isAllowedOperator(featureId, operator) && isAllowedValue(featureId, target);
}
function decodeInterpretation(payload: Record<string, unknown>, submission: number): SearchQuery {
    const legacy = Array.isArray(payload.unhandledRequirements) ? payload.unhandledRequirements.slice(0, MAX_RETURNED_UNRESOLVED_REQUIREMENTS) : [];
    const unresolvedRequirements: UnresolvedRequirement[] = [];
    const unresolvedIds = new Set<string>();
    const representedWording = new Set<string>();
    if (Array.isArray(payload.unresolvedRequirements)) {
        for (const item of payload.unresolvedRequirements.slice(0, MAX_RETURNED_UNRESOLVED_REQUIREMENTS)) {
            if (!item || typeof item !== "object" || Array.isArray(item)) continue;
            const { id, sourceText, importance } = item as Record<string, unknown>;
            if (typeof id !== "string" || !id.trim() || id.length > 100 || unresolvedIds.has(id)
                || typeof sourceText !== "string" || !sourceText.trim() || sourceText.length > 1000) continue;
            unresolvedIds.add(id);
            representedWording.add(sourceText);
            unresolvedRequirements.push({ id, sourceText, importance: importance === "must" || importance === "preferred" ? importance : "unknown" });
        }
    }
    const raw = Array.isArray(payload.criteria) ? payload.criteria : [];
    const criteria: Criterion[] = [];
    for (const [index, item] of raw.slice(0, 16).entries()) {
        if (!item || typeof item !== "object") {
            legacy.push("An interpreted requirement could not be read.");
            continue;
        }
        const value = item as Record<string, unknown>;
        const chosenValue = value.value ?? value.desiredValue;
        const operator = value.operator === undefined ? "eq" : value.operator;
        if (typeof value.featureId !== "string" || !isAllowedValue(value.featureId, chosenValue)
            || !isAllowedOperator(value.featureId, operator)
            || (value.importance !== "must" && value.importance !== "preferred")) {
            legacy.push(typeof value.sourceText === "string" ? value.sourceText : "A requirement is outside this catalogue's vocabulary.");
            continue;
        }
        criteria.push({ id: typeof value.id === "string" ? value.id : `ai-${index}`, featureId: value.featureId,
            value: chosenValue, operator,
            importance: value.importance === "must" ? "must" : "preferred", weight: value.weight === 3 ? 3 : 1 });
    }
    if (raw.length > 16) legacy.push("Additional requirements exceed the preview's editable limit.");
    const alternatives: AlternativeGroup[] = [];
    const rawAlternatives = Array.isArray(payload.alternatives) ? payload.alternatives : [];
    const usedIds = new Set([...unresolvedIds, ...criteria.map((criterion) => criterion.id)]);
    for (const item of rawAlternatives.slice(0, MAX_ALTERNATIVE_GROUPS)) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            legacy.push("An interpreted requirement could not be read.");
            continue;
        }
        const { id, sourceText, importance, weight, options } = item as Record<string, unknown>;
        const wording = typeof sourceText === "string" && sourceText.trim() && sourceText.length <= 1000 ? sourceText : undefined;
        if (typeof id !== "string" || !id.trim() || id.length > 100 || usedIds.has(id)
            || (importance !== "must" && importance !== "preferred") || (weight !== 1 && weight !== 3)
            || !Array.isArray(options) || options.length < MIN_ALTERNATIVE_OPTIONS || options.length > MAX_ALTERNATIVE_OPTIONS
            || !options.every(isAlternativeOption) || new Set(options.map(getAlternativeOptionKey)).size !== options.length) {
            legacy.push(wording ?? "An interpreted requirement could not be read.");
            continue;
        }
        usedIds.add(id);
        alternatives.push({ id, sourceText: wording, importance, weight, options });
    }
    if (rawAlternatives.length > MAX_ALTERNATIVE_GROUPS) legacy.push("Additional requirements exceed the preview's editable limit.");
    let legacyIndex = 0;
    for (const sourceText of legacy) {
        if (typeof sourceText !== "string" || !sourceText.trim() || sourceText.length > 1000 || representedWording.has(sourceText)) continue;
        let id: string;
        do { id = `legacy-unresolved-${submission}-${legacyIndex++}`; } while (usedIds.has(id));
        representedWording.add(sourceText);
        unresolvedRequirements.push({ id, sourceText, importance: "unknown" });
    }
    return { criteria, alternatives, unresolvedRequirements, unhandledRequirements: [],
        excludedGameIds: Array.isArray(payload.excludedGameIds) ? payload.excludedGameIds.filter((id): id is string => typeof id === "string") : [] };
}
const UNRESOLVED_PRIORITY_LABELS = { must: "Must have", preferred: "Preference", unknown: "Priority unclear" } as const;
function UnresolvedEditor({ requirement, locale, onEdit, onRemove }: {
    requirement: UnresolvedRequirement;
    locale: Locale;
    onEdit: (patch: Partial<Pick<UnresolvedRequirement, "sourceText" | "importance">>) => void;
    onRemove: () => void;
}) {
    const t = (english: string) => translate(locale, english);
    const [wording, setWording] = useState(requirement.sourceText);
    const edited = wording.trim();
    return <form className="unresolved-editor" onSubmit={(event) => {
        event.preventDefault();
        if (edited && edited !== requirement.sourceText) onEdit({ sourceText: edited });
    }}>
      <label>{t("Requirement wording")}
        <textarea rows={2} maxLength={1000} value={wording} onChange={(event) => setWording(event.target.value)}/>
      </label>
      <label>{t("Requirement priority")}
        <select value={requirement.importance} onChange={(event) => onEdit({ importance: event.target.value as UnresolvedRequirement["importance"] })}>
          {Object.entries(UNRESOLVED_PRIORITY_LABELS).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
        </select>
      </label>
      {requirement.importance === "unknown" && <p>{t("Choose whether this is required before confirming a match.")}</p>}
      <div className="unresolved-actions">
        <button className="text-button" type="submit" disabled={!edited || edited === requirement.sourceText}>{t("Save wording")}</button>
        <button className="text-button" type="button" onClick={onRemove}>{t("Remove requirement")}</button>
      </div>
    </form>;
}
function AlternativeEditor({ group, index, locale, onEdit, onRemove }: {
    group: AlternativeGroup;
    index: number;
    locale: Locale;
    onEdit: (patch: Partial<Pick<AlternativeGroup, "options" | "importance" | "weight">>) => void;
    onRemove: () => void;
}) {
    const t = (english: string, values?: Record<string, string | number>) => translate(locale, english, values);
    const groups = getTaxonomy(locale).filter((feature) => !feature.numericTarget).map((feature) => ({
        feature,
        choices: feature.options.flatMap(({ value }): AlternativeOption[] => {
            if (typeof value === "number") return [];
            const include: AlternativeOption = { featureId: feature.id, value, operator: "eq" };
            return typeof value === "boolean" ? [include] : [include, { ...include, operator: "neq" }];
        }),
    }));
    const choices = groups.flatMap((entry) => entry.choices);
    const keys = group.options.map(getAlternativeOptionKey);
    const next = choices.find((choice) => choice.operator === "eq" && !keys.includes(getAlternativeOptionKey(choice)));
    return <fieldset className="criterion alternative-group">
      <legend>{t("Either/or group {count}", { count: index + 1 })}</legend>
      {group.sourceText && <p className="alternative-source">{t("From your request")} <q className="unresolved-wording">{group.sourceText}</q></p>}
      <div className="alternative-options">{group.options.map((option, optionIndex) => <div className="alternative-option" key={optionIndex}>
        {optionIndex > 0 && <span className="alternative-or">{t("or")}</span>}
        <div className="alternative-option-control">
          <select aria-label={t("Alternative option {count}", { count: optionIndex + 1 })} value={getAlternativeOptionKey(option)} onChange={(event) => {
              const choice = choices.find((candidate) => getAlternativeOptionKey(candidate) === event.target.value);
              if (choice) onEdit({ options: group.options.map((item, position) => position === optionIndex ? choice : item) });
          }}>{groups.map(({ feature, choices }) => <optgroup key={feature.id} label={feature.label}>
            {choices.map((choice) => {
                const key = getAlternativeOptionKey(choice);
                return <option key={key} value={key} disabled={keys.some((item, position) => position !== optionIndex && item === key)}>
                  {getCriterionLabel(choice, locale)}
                </option>;
            })}
          </optgroup>)}</select>
          {group.options.length > MIN_ALTERNATIVE_OPTIONS && <button className="remove-button" type="button"
            aria-label={t("Remove alternative option {count}", { count: optionIndex + 1 })}
            onClick={() => onEdit({ options: group.options.filter((_, position) => position !== optionIndex) })}>×</button>}
        </div>
      </div>)}</div>
      <div className="alternative-actions">
        {next && group.options.length < MAX_ALTERNATIVE_OPTIONS && <button className="text-button" type="button"
          onClick={() => onEdit({ options: [...group.options, next] })}>{t("Add option")}</button>}
        <button className="text-button" type="button" onClick={onRemove}>{t("Remove group")}</button>
      </div>
      <select aria-label={t("Either/or group priority")} value={group.importance} onChange={(event) => onEdit({ importance: event.target.value === "must" ? "must" : "preferred" })}>
        <option value="preferred">{t("Prefer one option")}</option>
        <option value="must">{t("Require one option")}</option>
      </select>
      {group.importance === "preferred" && <button className={`prioritize-button ${group.weight === 3 ? "is-prioritized" : ""}`} type="button"
        aria-pressed={group.weight === 3} onClick={() => onEdit({ weight: group.weight === 3 ? 1 : 3 })}>
        {t(group.weight === 3 ? "★ Prioritized" : "☆ Prioritize this")}
      </button>}
    </fieldset>;
}
function ActiveCriteriaRows({ criteria, games, locale }: {
    criteria: Criterion[];
    games: GameRecord[];
    locale: Locale;
}) {
    const t = (english: string) => translate(locale, english);
    return <>{criteria.map((criterion) => <tr key={`active-${criterion.id}`}>
    <th scope="row">{getCriterionLabel(criterion, locale)}<small className="table-caveat">{criterion.importance === "must" ? t("Must have") : criterion.weight === 3 ? t("Prioritized preference") : t("Preference")}</small></th>
    {games.map((game) => {
                const reason = evaluateCriterion(game, criterion, locale);
                return <td key={game.id}><strong className={`comparison-outcome ${reason.status}`}>{
                    t({ match: "Matches this criterion", partial: "Partly fits this preference", mismatch: "Does not match", unknown: "Needs checking" }[reason.status])
                }</strong>{reason.text}</td>;
            })}
  </tr>)}</>;
}
function AlternativeCriteriaRows({ alternatives, games, locale }: {
    alternatives: AlternativeGroup[];
    games: GameRecord[];
    locale: Locale;
}) {
    const t = (english: string) => translate(locale, english);
    return <>{alternatives.map((group) => <tr key={`alternative-${group.id}`}>
      <th scope="row">{group.options.map((option) => getCriterionLabel(option, locale)).join(` ${t("or")} `)}
        <small className="table-caveat">{t(group.importance === "must" ? "Require one option" : group.weight === 3 ? "Prioritized preference" : "Prefer one option")}</small>
        {group.sourceText && <q className="unresolved-wording">{group.sourceText}</q>}
      </th>
      {games.map((game) => {
          const reason = evaluateAlternativeGroup(game, group, locale);
          return <td key={game.id}><strong className={`comparison-outcome ${reason.status}`}>{
              t({ match: "Matches this criterion", partial: "Partly fits this preference", mismatch: "Does not match", unknown: "Needs checking" }[reason.status])
          }</strong>{reason.text}</td>;
      })}
    </tr>)}</>;
}
function UnresolvedCriteriaRows({ requirements, games, results, locale }: {
    requirements: UnresolvedRequirement[];
    games: GameRecord[];
    results: ReadonlyMap<string, MatchResult>;
    locale: Locale;
}) {
    return <>{requirements.map((requirement) => <tr key={requirement.id}>
      <th scope="row"><q className="unresolved-wording">{requirement.sourceText}</q>
        <small className="table-caveat">{translate(locale, UNRESOLVED_PRIORITY_LABELS[requirement.importance])}</small>
      </th>
      {games.map((game) => {
          const reason = results.get(game.id)?.reasons.find((entry) => entry.criterionId === requirement.id);
          return <td key={game.id}>{reason ? <>
            <strong className="comparison-outcome unknown">{translate(locale, "Outside the current assessment")}</strong>{reason.text}
          </> : "—"}</td>;
      })}
    </tr>)}</>;
}
export default function Atlas({ initialLocale = "en" }: { initialLocale?: Locale }) {
    const [locale, setLocale] = useState<Locale>(initialLocale);
    const t = (english: string, values?: Record<string, string | number>) => translate(locale, english, values);
    const taxonomy = getTaxonomy(locale);
    const [games, setGames] = useState<GameRecord[]>([]);
    const [translations, setTranslations] = useState<GameTranslations>({});
    const [artwork, setArtwork] = useState<ArtworkMap>({});
    const [loadError, setLoadError] = useState("");
    const [query, setQuery] = useState<SearchQuery>(EMPTY_QUERY);
    const [request, setRequest] = useState("");
    const [titleFilter, setTitleFilter] = useState("");
    const [aiEnabled, setAiEnabled] = useState(false);
    const [aiChecked, setAiChecked] = useState(false);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState("");
    const [clarification, setClarification] = useState("");
    const [interpretationLabel, setInterpretationLabel] = useState("");
    const [compared, setCompared] = useState<string[]>([]);
    const [trayHeight, setTrayHeight] = useState(0);
    const [detailGame, setDetail] = useState<GameRecord | null>(null);
    const detail = useMemo(() => detailGame ? localizeGame(detailGame, locale, translations) : null, [detailGame, locale, translations]);
    const displayGame = (game: GameRecord) => localizeGame(game, locale, translations);
    const trayRef = useRef<HTMLElement>(null);
    const detailDialog = useRef<HTMLDialogElement>(null);
    const compareDialog = useRef<HTMLDialogElement>(null);
    const detailOpener = useRef<HTMLElement | null>(null);
    const controller = useRef<AbortController | null>(null);
    const latestSubmission = useRef(0);
    function changeLocale(next: Locale) {
        if (next === locale) return;
        setLocale(next);
        window.history.pushState(null, "", "/" + next + window.location.search + window.location.hash);
    }
    useEffect(() => {
        if (window.location.pathname === "/") window.history.replaceState(null, "", "/" + initialLocale + window.location.search + window.location.hash);
        const back = () => setLocale(pathLocale(window.location.pathname) ?? initialLocale);
        window.addEventListener("popstate", back);
        return () => window.removeEventListener("popstate", back);
    }, [initialLocale]);
    useEffect(() => {
        document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
        const metadata = localeMetadata(locale);
        document.title = metadata.title;
        document.querySelector('meta[name="description"]')?.setAttribute("content", metadata.description);
        document.querySelector('link[rel="canonical"]')?.setAttribute("href", new URL("/" + locale, window.location.origin).href);
        document.cookie = "atlas-locale=" + locale + "; Path=/; Max-Age=15552000; SameSite=Lax" + (window.location.protocol === "https:" ? "; Secure" : "");
    }, [locale]);
    useEffect(() => {
        const abort = new AbortController();
        const readPublic = async (url: string) => {
            const response = await fetch(url, { signal: abort.signal });
            if (!response.ok) throw new Error("The catalogue could not be loaded.");
            return response.json();
        };
        Promise.all([readPublic("/catalogue.json"), readPublic("/catalogue.zh.json").catch(() => ({})), readPublic("/artwork-manifest.json").catch(() => ({}))])
          .then(([data, copy, images]) => {
            const records = Array.isArray(data) ? data : asObject(data).games;
            if (!Array.isArray(records)) throw new Error("The catalogue format is unavailable.");
            setTranslations(copy as GameTranslations); setArtwork(images as ArtworkMap);
            setGames(records as GameRecord[]);
          }).catch((error) => { if (error.name !== "AbortError") setLoadError("The catalogue could not be loaded. Please refresh to try again."); });
        fetch("/api/status", { signal: abort.signal }).then((response) => response.json()).then((data) => {
            setAiEnabled(asObject(data).enabled === true);
            setAiChecked(true);
        }).catch(() => setAiChecked(true));
        return () => { abort.abort(); controller.current?.abort(); };
    }, []);
    useEffect(() => {
        if (detail && detailDialog.current && !detailDialog.current.open)
            detailDialog.current.showModal();
    }, [detail]);
    useEffect(() => {
        if (!compared.length || !trayRef.current) {
            setTrayHeight(0);
            return;
        }
        const tray = trayRef.current;
        const measure = () => setTrayHeight(Math.ceil(tray.getBoundingClientRect().height) + 12);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(tray);
        return () => observer.disconnect();
    }, [compared.length]);
    const groups = useMemo(() => matchGames(games, query, locale), [games, query, locale]);
    const resultsByGameId = useMemo(() => new Map([...groups.matches, ...groups.possible, ...groups.excluded]
        .map((result) => [result.game.id, result])), [groups]);
    const normalizeTitle = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase("en");
    const filtered = (items: MatchResult[]) => items.filter(({ game }) => !titleFilter.trim() || normalizeTitle([game.title, displayGame(game).title, ...game.aliases].join(" ")).includes(normalizeTitle(titleFilter)));
    const visibleMatches = filtered(groups.matches);
    const visiblePossible = filtered(groups.possible);
    const selectedGames = compared.map((id) => games.find((game) => game.id === id)).filter((game): game is GameRecord => !!game).map(displayGame);
    const alternatives = query.alternatives ?? [];
    const conditionCount = query.criteria.length + alternatives.length;
    const hasCriteria = conditionCount > 0 || query.excludedGameIds.length > 0;
    const unresolvedRequirements = query.unresolvedRequirements ?? [];
    const blockingUnresolvedIds = new Set(unresolvedRequirements.filter((requirement) => requirement.importance !== "preferred").map((requirement) => requirement.id));
    const onlyUnresolvedCriteria = conditionCount === 0 && unresolvedRequirements.length > 0;
    const detailReasons = detail ? resultsByGameId.get(detail.id)?.reasons ?? [] : [];
    function cancelSubmission() {
        latestSubmission.current += 1;
        controller.current?.abort();
        setBusy(false);
    }
    function editQuery(next: SearchQuery) {
        cancelSubmission();
        setQuery(next);
        setInterpretationLabel("Edited by you");
        setClarification("");
    }
    function patchCriterion(id: string, patch: Partial<Criterion>) {
        editQuery({ ...query, criteria: query.criteria.map((criterion) => criterion.id === id ? { ...criterion, ...patch } : criterion) });
    }
    function patchAlternative(id: string, patch: Partial<Pick<AlternativeGroup, "options" | "importance" | "weight">>) {
        editQuery({ ...query, alternatives: alternatives.map((group) => group.id === id ? { ...group, ...patch } : group) });
    }
    function addAlternative() {
        editQuery({ ...query, alternatives: [...alternatives, { id: crypto.randomUUID(), importance: "preferred", weight: 1,
            options: [{ featureId: "setting", value: "fantasy", operator: "eq" }, { featureId: "setting", value: "scifi", operator: "eq" }],
        }] });
    }
    function patchUnresolved(id: string, patch: Partial<Pick<UnresolvedRequirement, "sourceText" | "importance">>) {
        editQuery({ ...query, unresolvedRequirements: unresolvedRequirements.map((requirement) =>
            requirement.id === id ? { ...requirement, ...patch } : requirement) });
    }
    async function submit(event: FormEvent) {
        event.preventDefault();
        if (!request.trim()) {
            setNotice("Describe a preference or add a criterion below to start your shortlist.");
            return;
        }
        cancelSubmission();
        const submission = ++latestSubmission.current;
        const abort = new AbortController();
        controller.current = abort;
        setBusy(true);
        setNotice("");
        setClarification("");
        try {
            const response = await fetch("/api/interpret", { method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query: request.trim(), taxonomyVersion: TAXONOMY_VERSION, requestId: crypto.randomUUID() }), signal: abort.signal });
            const data = asObject(await response.json());
            if (submission !== latestSubmission.current)
                return;
            if (!response.ok)
                throw new SearchSubmissionError(searchErrorKey(data.code));
            setQuery(decodeInterpretation(data, submission));
            setInterpretationLabel("Interpreted from your request — editable");
            const question = data.clarification && typeof data.clarification === "object"
                ? (data.clarification as Record<string, unknown>).question : null;
            if (typeof question === "string" && question)
                setClarification(question);
            else if (data.status === "unsupported")
                setNotice("This request reaches beyond the current catalogue. The unmatched requirements remain visible below.");
            setAiEnabled(true);
        }
        catch (error) {
            if (submission !== latestSubmission.current || (error instanceof Error && error.name === "AbortError"))
                return;
            setNotice(error instanceof SearchSubmissionError ? error.message : "AI search is unavailable. Use the criteria below to keep exploring.");
        }
        finally {
            if (submission === latestSubmission.current)
                setBusy(false);
        }
    }
    function openDetail(game: GameRecord, button: HTMLElement) { detailOpener.current = button; setDetail(games.find((item) => item.id === game.id) ?? game); }
    function closeDetail() { detailDialog.current?.close(); }
    function toggleCompare(id: string) {
        if (compared.includes(id))
            setCompared(compared.filter((item) => item !== id));
        else if (compared.length < 3) {
            setCompared([...compared, id]);
            setNotice("");
        }
        else
            setNotice("Your comparison already has three games. Remove one to add another.");
    }
    function reset() {
        cancelSubmission();
        setQuery(EMPTY_QUERY);
        setRequest("");
        setTitleFilter("");
        setNotice("");
        setClarification("");
        setInterpretationLabel("");
    }
    function renderCard(result: MatchResult, needsChecking: boolean) {
        const { game: canonicalGame, reasons } = result;
        const game = displayGame(canonicalGame);
        const index = games.findIndex((record) => record.id === game.id);
        const positive = reasons.find((reason) => reason.status === "match");
        const duration = reasons.find((reason) => query.criteria.some((criterion) =>
            criterion.id === reason.criterionId && criterion.featureId === CAMPAIGN_HOURS_FEATURE));
         const unresolvedMust = reasons.find((reason) => reason.status === "unknown" && [...query.criteria, ...alternatives].some((condition) =>
             condition.id === reason.criterionId && condition.importance === "must"));
        const unresolvedClauses = needsChecking ? reasons.filter((reason) => blockingUnresolvedIds.has(reason.criterionId)) : [];
        const explanation = (needsChecking ? unresolvedMust : undefined) ?? duration ?? positive;
        const showExplanationLabel = explanation && (explanation === duration || explanation === unresolvedMust);
        return <article className="game-card" key={game.id}>
      <GameArtwork game={game} index={index} locale={locale} asset={artwork[game.id]}/>
      <div className="card-body">
        <div className="card-kicker"><span>{facetLabel(game, "setting", locale)}</span><span>{String(index + 1).padStart(2, "0")}</span></div>
        <h3><button className="title-button" onClick={(event) => openDetail(game, event.currentTarget)}>{game.title}</button></h3>
        <p className="game-summary">{game.summary}</p>
        <div className="game-tags"><span>{facetLabel(game, "structure", locale)}</span><span>{facetLabel(game, "campaign", locale)}</span></div>
        {(hasCriteria || unresolvedClauses.length > 0) && <div className={`match-note ${needsChecking ? "needs-checking" : ""}`}>
          <span className="small-label">{t(needsChecking ? "STILL TO CHECK" : "WHY IT'S HERE")}</span>
          {(explanation || unresolvedClauses.length === 0) && <p>
            {showExplanationLabel && <><strong>{explanation.label}</strong><br /></>}
            {explanation?.text ?? t("No documented hard conflict in your current criteria. Open the profile for the remaining details.")}
          </p>}
          {unresolvedClauses.length > 0 && <ul className="unresolved-card-list">{unresolvedClauses.map((reason) => <li key={reason.criterionId}>
            <q className="unresolved-wording">{reason.label}</q><p>{reason.text}</p>
          </li>)}</ul>}
        </div>}
        <div className="card-actions"><button className="detail-link" onClick={(event) => openDetail(game, event.currentTarget)}>{t("Read the profile") + " "}<Arrow /></button><label className="compare-check"><input type="checkbox" checked={compared.includes(game.id)} onChange={() => toggleCompare(game.id)}/><span>{t("Compare")}</span></label></div>
      </div>
    </article>;
    }
    return <>
    <a className="skip-link" href="#collection">{t("Skip to the game collection")}</a>
    <header className="site-header"><div className="page-width header-inner"><a href="#top" className="brand-link" aria-label={t("Tactical Atlas home")}><Brand /></a><nav aria-label={t("Main navigation")}><a href="#collection">{t("Explore games")}</a><a href="#about">{t("The idea")}</a><a href="#contribute">{t("Help build it") + " "}<span aria-hidden="true">↗</span></a></nav><span className="edition-label"><i />{" " + t("Experimental preview")}</span><div className="language-toggle" role="group" aria-label={t("Language")}><button type="button" lang="zh-CN" aria-pressed={locale === "zh"} onClick={() => changeLocale("zh")}>简体中文</button><button type="button" lang="en" aria-pressed={locale === "en"} onClick={() => changeLocale("en")}>English</button></div></div></header>
    <main id="top">
      <section className="hero page-width" aria-labelledby="hero-title">
        <div className="hero-heading"><div><p className="eyebrow">{t("A FIELD GUIDE TO YOUR NEXT GAME")}</p><h1 id="hero-title">{t("Find your next")}<br /><em>{t("way to play.")}</em></h1><p className="hero-description">{t("Describe the choices you enjoy. Explore games through")}<br className="desktop-break"/>{" " + t("their mechanics, tradeoffs and the evidence behind them.")}</p></div><div className="hero-aside"><div className="compass-art" aria-hidden="true"><svg viewBox="0 0 170 170" fill="none"><circle cx="85" cy="85" r="67" stroke="currentColor" strokeOpacity=".18"/><circle cx="85" cy="85" r="43" stroke="currentColor" strokeOpacity=".2" strokeDasharray="2 5"/><path d="M85 6v158M6 85h158M29 29l112 112M29 141 141 29" stroke="currentColor" strokeOpacity=".15"/><path d="m85 34 19 51-19 51-19-51 19-51Z" fill="currentColor" opacity=".12"/><path d="m85 34 19 51H85V34Z" fill="currentColor"/><path d="M85 136 66 85h19v51Z" stroke="currentColor" strokeWidth="1.5"/><circle cx="85" cy="85" r="5" fill="var(--paper)" stroke="currentColor"/></svg></div><p><strong>{t("Less guessing.")}<br />{t("More understanding.")}</strong><span>{t("A small collection.")}<br />{t("A closer look at what matters.")}</span></p></div></div>
        <form className="request-box" onSubmit={submit}>
          <div className="request-topline"><label htmlFor="game-request" className="small-label">{t("WHAT WOULD YOU LIKE TO PLAY?")}</label><span className={`ai-status ${aiEnabled ? "connected" : ""}`}><i />{aiEnabled ? t("AI search connected") : aiChecked ? t("AI connection pending \u00B7 filters work now") : t("Checking search connection")}</span></div>
          <textarea id="game-request" maxLength={1000} value={request} onChange={(event) => { cancelSubmission(); setRequest(event.target.value); }} placeholder={t("Fantasy tactics with character-building choices, room to experiment, and a story worth following\u2026")} rows={2}/>
          <div className="request-bottom"><p>{t("Describe your preferences in English or Chinese.")}<br className="mobile-break"/>{" " + t("We search this collection, with its limits in view.")}</p><div className="request-submit">{busy && <button className="text-button" type="button" onClick={cancelSubmission}>{t("Cancel")}</button>}<button className="button-primary" type="submit" disabled={busy || !games.length}>{busy ? <><span className="spinner"/>{" " + t("Reading your request")}</> : <>{t("Find games") + " "}<Arrow /></>}</button></div></div>
          <div className="request-examples"><span>{t("Try a starting point")}</span>{EXAMPLES.map((example) => <button key={example.label} type="button" onClick={() => { cancelSubmission(); setRequest(t(example.text)); document.getElementById("game-request")?.focus(); }}>{t(example.label)}<span aria-hidden="true">↗</span></button>)}</div>
        </form>
        {notice && <p className="notice" role="alert">{t(notice)}</p>}
        {clarification && <p className="notice clarification" role="status"><strong>{t("A quick clarification:")}</strong> {clarification}{" " + t("Update your description or edit the criteria below.")}</p>}
      </section>

      <section className="collection page-width" id="collection" aria-labelledby="collection-title">
        <aside className="filter-panel" aria-labelledby="shortlist-title">
          <div className="filter-heading"><h2 id="shortlist-title">{t("Your shortlist")}</h2><button className="text-button" onClick={reset}>{t("Reset")}</button></div>
          <p className="filter-intro">{t("Make the interpretation your own.")}<br />{t("Changes update results immediately.")}</p>
          <label className="control-label" htmlFor="title-filter">{t("Find a title")}</label><input id="title-filter" className="text-input" type="search" value={titleFilter} placeholder={t("Search this collection")} onChange={(event) => setTitleFilter(event.target.value)}/>
           <div className="criteria-heading"><span className="small-label">{t("YOUR CRITERIA")}</span>{conditionCount > 0 && <span>{conditionCount}</span>}</div>
          {interpretationLabel && <p className="interpretation-label">{t(interpretationLabel)}</p>}
           {conditionCount === 0 && <div className="empty-criteria"><svg width="23" height="23" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 5h16v14H4zM9 5v14M4 10h16M15 10v9" stroke="currentColor" strokeWidth="1.2"/></svg><p>{t("Start with a request above,")}<br />{t("or add a preference here.")}</p></div>}
          <div className="criteria-list">{query.criteria.map((criterion, index) => {
            const feature = getFeature(criterion.featureId, locale) || taxonomy[0];
            const numeric = feature.numericTarget;
            return <fieldset className="criterion" key={criterion.id}>
              <legend className="sr-only">{t("Criterion") + " "}{index + 1}</legend>
              <div className="criterion-top">
                <select aria-label={t("Criterion {count} feature", { count: index + 1 })} value={criterion.featureId} onChange={(event) => {
                    const next = getFeature(event.target.value, locale)!;
                    patchCriterion(criterion.id, {
                        featureId: next.id,
                        value: next.numericTarget?.defaultValue ?? next.options[0].value,
                        operator: next.numericTarget ? "gte" : numeric ? "eq" : criterion.operator,
                    });
                }}>{taxonomy.map((entry) => <option value={entry.id} key={entry.id}>{entry.label}</option>)}</select>
                <button className="remove-button" aria-label={t("Remove criterion {count}", { count: index + 1 })} onClick={() => editQuery({ ...query, criteria: query.criteria.filter((entry) => entry.id !== criterion.id) })}>×</button>
              </div>
              {numeric ? <div className="duration-control">
                <div className="duration-inputs">
                  <label>{t("Duration comparison")}
                    <select value={criterion.operator ?? "gte"} aria-describedby={`duration-help-${criterion.id}`} onChange={(event) => {
                        const operator = event.currentTarget.value;
                        if (isNumericComparisonOperator(operator)) patchCriterion(criterion.id, { operator });
                    }}>{NUMERIC_COMPARISONS.map((operator) => <option key={operator} value={operator}>{t(NUMERIC_COMPARISON_LABELS[operator])}</option>)}</select>
                  </label>
                  <label>{t("Target hours")}
                    <input aria-describedby={`duration-help-${criterion.id}`} className="text-input criterion-value"
                      type="number" inputMode="numeric" min={numeric.min} max={numeric.max}
                      defaultValue={String(criterion.value)} onChange={(event) => {
                          const value = event.currentTarget.valueAsNumber;
                          if (isAllowedValue(feature.id, value)) patchCriterion(criterion.id, { value });
                      }} onBlur={(event) => { event.currentTarget.value = String(criterion.value); }} />
                  </label>
                </div>
                <small id={`duration-help-${criterion.id}`}>{t("Developer estimates help rank preferences. A mandatory duration still needs checking.")}</small>
              </div> : <select className="criterion-value" aria-label={t("Criterion {count} value", { count: index + 1 })} value={String(criterion.value)} onChange={(event) => {
                  const next = feature.options.find((option) => String(option.value) === event.target.value);
                  if (next) patchCriterion(criterion.id, { value: next.value });
              }}>{feature.options.map((option) => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}</select>}
              <div className="criterion-options">
                <select aria-label={t("Criterion {count} importance", { count: index + 1 })} value={criterion.importance} onChange={(event) => patchCriterion(criterion.id, { importance: event.target.value as "must" | "preferred" })}><option value="preferred">{t("Prefer")}</option><option value="must">{t("Must have")}</option></select>
                {!numeric && <select aria-label={t("Criterion {count} inclusion", { count: index + 1 })} value={criterion.operator || "eq"} onChange={(event) => patchCriterion(criterion.id, { operator: event.target.value as "eq" | "neq" })}><option value="eq">{t("Include")}</option><option value="neq">{t("Exclude")}</option></select>}
              </div>
              {criterion.importance === "preferred" && <button className={`prioritize-button ${criterion.weight === 3 ? "is-prioritized" : ""}`} aria-pressed={criterion.weight === 3} onClick={() => patchCriterion(criterion.id, { weight: criterion.weight === 3 ? 1 : 3 })}>{criterion.weight === 3 ? t("\u2605 Prioritized") : t("\u2606 Prioritize this")}</button>}
            </fieldset>;
        })}{alternatives.map((group, index) => <AlternativeEditor key={group.id} group={group} index={index} locale={locale}
              onEdit={(patch) => patchAlternative(group.id, patch)}
              onRemove={() => editQuery({ ...query, alternatives: alternatives.filter((entry) => entry.id !== group.id) })}/>)}</div>
          <button className="add-criterion" disabled={query.criteria.length >= 16} onClick={() => editQuery({ ...query, criteria: [...query.criteria, { id: crypto.randomUUID(), featureId: "setting", value: "fantasy", importance: "preferred", weight: 1 }] })}><span aria-hidden="true">+</span>{" " + t("Add a preference")}</button>
          <button className="add-criterion" type="button" disabled={alternatives.length >= MAX_ALTERNATIVE_GROUPS} onClick={addAlternative}><span aria-hidden="true">+</span>{t("Add an either/or group")}</button>
          <div className="exclusions"><label className="control-label" htmlFor="excluded-game">{t("Already played it?")}</label><select id="excluded-game" value="" onChange={(event) => { if (event.target.value)
        editQuery({ ...query, excludedGameIds: [...new Set([...query.excludedGameIds, event.target.value])] }); }}><option value="">{t("Exclude a game\u2026")}</option>{games.filter((game) => !query.excludedGameIds.includes(game.id)).map((game) => <option key={game.id} value={game.id}>{displayGame(game).title}</option>)}</select>{query.excludedGameIds.map((id) => <button className="exclusion-chip" key={id} onClick={() => editQuery({ ...query, excludedGameIds: query.excludedGameIds.filter((entry) => entry !== id) })}>{(games.find((game) => game.id === id) ? displayGame(games.find((game) => game.id === id)!).title : id)}<span aria-label={t("Remove exclusion")}>×</span></button>)}</div>
          {unresolvedRequirements.length > 0 && <section className="unhandled" aria-labelledby="unresolved-title">
            <h3 id="unresolved-title">{t("Outside the current assessment")}</h3>
            <p>{t("Editing the wording changes the note only. Changing the priority updates the shortlist.")}</p>
            <div className="unresolved-editors">{unresolvedRequirements.map((requirement) => <UnresolvedEditor
              key={requirement.id} requirement={requirement} locale={locale}
              onEdit={(patch) => patchUnresolved(requirement.id, patch)}
              onRemove={() => editQuery({ ...query, unresolvedRequirements: unresolvedRequirements.filter((item) => item.id !== requirement.id) })}/>)}</div>
          </section>}
          <p className="filter-footnote">{t("A required feature without enough evidence stays in") + " "}<strong>{t("Needs checking")}</strong>{t(". Preferences shape the order; they are not quality scores.")}</p>
        </aside>

        <div className="catalogue-results"><div className="collection-heading"><div><p className="eyebrow">{t("01 \u2014 THE COLLECTION")}</p><h2 id="collection-title">{t("Different games.")}<br className="mobile-break"/>{" " + t("Different possibilities")}<span>.</span></h2></div><span className="collection-count">{games.length || "—"}<small>{t("curated games")}</small></span></div>
          <div className="results-toolbar"><p role="status" aria-live="polite">{games.length ? onlyUnresolvedCriteria
            ? t(blockingUnresolvedIds.size ? "No supported criteria · {count} profiles need checking" : "No supported criteria · {count} profiles to explore",
                { count: blockingUnresolvedIds.size ? visiblePossible.length : visibleMatches.length })
            : hasCriteria ? t("{count} ranked profiles · {possible} need checking", { count: visibleMatches.length, possible: visiblePossible.length })
            : t("{count} profiles to explore", { count: visibleMatches.length })
            : t(loadError || "Loading the collection…")}</p><span>{hasCriteria && !onlyUnresolvedCriteria ? t("Ordered by your preferences") : t("A\u2013Z \u00B7 no popularity ranking")}</span></div>
          {loadError && <p className="notice" role="alert">{t(loadError)}</p>}
          {visibleMatches.length > 0 && <div className="game-grid">{visibleMatches.map((result) => renderCard(result, false))}</div>}
          {visiblePossible.length > 0 && <><div className="possible-heading"><span className="small-label">{t("NEEDS CHECKING")}</span><p>{t(blockingUnresolvedIds.size
            ? "Some parts of your request still need assessment or a priority."
            : "Potentially relevant, with unanswered must-haves.")}</p></div><div className="game-grid">{visiblePossible.map((result) => renderCard(result, true))}</div></>}
          {!!games.length && !visibleMatches.length && !visiblePossible.length && <div className="empty-results"><svg width="50" height="50" viewBox="0 0 50 50" fill="none" aria-hidden="true"><path d="M8 8h34v34H8zM8 25h34M25 8v34" stroke="currentColor" strokeWidth="1.2"/><circle cx="25" cy="25" r="6" fill="var(--paper)" stroke="currentColor"/></svg><h3>{t("No supported match in this view.")}</h3><p>{t("Try editing a requirement or removing a title filter.")}<br />{t("The collection is small; an empty result is useful information, too.")}</p><button className="text-button" onClick={reset}>{t("Reset the shortlist")}</button></div>}
          {!!groups.excluded.length && <details className="excluded-summary"><summary>{groups.excluded.length}{" " + t("games outside your current requirements")}</summary><ul>{groups.excluded.map(({ game, reasons }) => <li key={game.id}><strong>{displayGame(game).title}</strong><span>{reasons.find((reason) => reason.status === "mismatch")?.label || t("Excluded by you")}</span></li>)}</ul></details>}
          <p className="collection-note">{t("A focused sample of turn-based tactical combat, including party RPGs. Profiles describe sourced mechanics and provisional interpretations, with room for questions.")}</p>
        </div>
      </section>

      <section className="about-section" id="about"><div className="page-width"><div className="section-heading"><div><p className="eyebrow">{t("02 \u2014 THE IDEA BEHIND THE ATLAS")}</p><h2>{t("Good recommendations")}<br />{t("should show their working.")}</h2></div><p>{t("We are exploring a more useful way to find games:")}<br className="desktop-break"/>{" " + t("start with what matters to you, then make the reasons visible.")}</p></div><div className="method-grid"><article><span>{t("01 / DESCRIBE")}</span><h3>{t("Begin with your preferences.")}</h3><p>{t("Tell us what you enjoy, what you need, and what you would rather avoid. Review the interpretation and change it whenever you like.")}</p></article><article><span>{t("02 / UNDERSTAND")}</span><h3>{t("See more than a score.")}</h3><p>{t("Explore concrete mechanics, progression choices and tradeoffs. Follow the sources behind a profile and keep its unanswered questions in view.")}</p></article><article><span>{t("03 / DISCOVER")}</span><h3>{t("Find a different possibility.")}</h3><p>{t("Compare games through the same criteria. Popularity does not decide the order, and a tentative match is always labelled.")}</p></article></div><details className="scope-details"><summary>{t("What this experimental preview does today")}</summary><p>{t("The catalogue is curated with AI assistance. Live AI, when connected, interprets the visitor's request; application rules match the recorded profiles. Source descriptions and provisional assessments are not comprehensive current-build tests or overall judgments of balance, depth or authenticity. Historical military simulation has limited coverage. Broader research, independent review and player testing remain open work.")}</p><p>{t("Manual filters run in your browser. When AI search is used, the request is sent to DeepSeek; the app does not keep a search history. Rate limiting stores a pseudonymous identifier and timestamps, without request text; records older than 24 hours are removed on subsequent submissions. Provider and hosting logs may have their own retention.") + " "}<a href="https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html" target="_blank" rel="noreferrer noopener">{t("Read the provider's data policy") + " "}<span aria-hidden="true">↗</span></a></p></details></div></section>

      <section className="contribute-section page-width" id="contribute"><div><p className="eyebrow">{t("03 \u2014 AN OPEN EXPERIMENT")}</p><h2>{t("Help shape what")}<br />{t("comes next")}<span>.</span></h2><p>{t("For players with a better question.")}<br />{t("For researchers, designers and developers with an idea to try.")}</p></div><div className="contribute-content"><p>{t("This project is a working invitation. Tell us where a result misses the mark, help explain a game's mechanics, or improve the way preferences become a shortlist.")}</p><div className="contribute-tasks"><span>{t("Add one useful game profile")}</span><span>{t("Improve a search interpretation")}</span><span>{t("Make uncertainty easier to understand")}</span></div>{REPOSITORY ? <a className="button-primary" href={safeUrl(REPOSITORY)} target="_blank" rel="noreferrer noopener">{t("Explore the project") + " "}<Arrow diagonal/></a> : <><button className="button-outline" disabled>{t("Public repository being prepared")}</button><p className="publishing-note">{t("Contribution and feedback links will appear with publication.")}</p></>}</div></section>
      <section className="page-width" aria-label={t("Project feedback")}><FeedbackForm locale={locale}/></section>
    </main>

    <footer className="site-footer"><div className="page-width footer-inner"><a href="#top" className="brand-link"><Brand /></a><span>{t("An experiment in finding games through better questions.")}</span><a href="#about">{t("Scope & privacy")}</a></div></footer>

    {selectedGames.length > 0 && <aside className="compare-tray" ref={trayRef} aria-label={t("Selected games for comparison")}><div className="compare-tray-inner"><div className="compare-picked"><span className="small-label">{t("YOUR COMPARISON")}</span><div>{selectedGames.map((game) => <button key={game.id} onClick={() => setCompared(compared.filter((id) => id !== game.id))} aria-label={t("Remove {name} from comparison", { name: game.title })}>{game.title}<span aria-hidden="true">×</span></button>)}</div></div><div className="compare-tray-actions"><button className="text-button" onClick={() => setCompared([])}>{t("Clear")}</button><button className="button-primary" disabled={selectedGames.length < 2} onClick={() => compareDialog.current?.showModal()}>{t("Compare {count}/3", { count: selectedGames.length })} <Arrow /></button></div></div></aside>}

    <dialog className="atlas-dialog detail-dialog" ref={detailDialog} aria-labelledby="detail-title" onClose={() => { setDetail(null); if (detailOpener.current?.isConnected)
        detailOpener.current.focus(); }} onClick={(event) => { if (event.target === event.currentTarget)
        closeDetail(); }}>{detail && <><div className="dialog-topline"><span className="small-label">{t("GAME FIELD NOTES")}</span><button className="dialog-close" onClick={closeDetail} aria-label={t("Close game profile")}>{t("Close") + " "}<span aria-hidden="true">×</span></button></div><div className="detail-heading"><p className="eyebrow">{facetLabel(detail, "setting", locale)}</p><h2 id="detail-title">{detail.title}</h2><p>{detail.summary}</p><div className="profile-artwork"><GameArtwork game={detail} locale={locale} asset={artwork[detail.id]}/></div>{artwork[detail.id] && <p className="artwork-credit">{t("Artwork")}: <a href={safeUrl(artwork[detail.id].sourceUrl)} target="_blank" rel="noreferrer noopener">{artwork[detail.id].credit}</a>{artwork[detail.id].licenseUrl && <> · <a href={safeUrl(artwork[detail.id].licenseUrl!)} target="_blank" rel="noreferrer noopener">{t("Image license")}</a></>}</p>}<a href={safeUrl(detail.storeUrl)} target="_blank" rel="noreferrer noopener">{t("Open the store page") + " "}<span aria-hidden="true">↗</span></a></div><div className="detail-body"><div className="detail-section"><h3>{t("What shapes the experience")}</h3><ul className="profile-notes">{detail.notes.map((note, index) => <li key={index}><span>{note.text}</span><small>{note.evidenceIds.join(" · ")}</small></li>)}</ul></div><div className="detail-section"><h3>{t("Tradeoffs & open questions")}</h3><ul className="profile-notes">{detail.tradeoffs.map((note, index) => <li key={index}><span>{note.text}</span><small>{note.evidenceIds.join(" · ")}</small></li>)}</ul><p className="edition-scope"><strong>{t("Content scope:")}</strong> {detail.editionScope}</p></div>{(conditionCount > 0 || unresolvedRequirements.length > 0) && detailReasons.length > 0 && <div className="detail-section">
          <h3>{t("Your criteria, one by one")}</h3>
          <ul className="criterion-outcomes">{detailReasons.map((reason) => {
            const requirement = unresolvedRequirements.find((item) => item.id === reason.criterionId);
            const alternative = alternatives.find((group) => group.id === reason.criterionId);
            return <li key={reason.criterionId}><span className={`outcome-dot ${reason.status}`}/><div>
              <strong>{requirement ? <q className="unresolved-wording">{reason.label}</q> : reason.label}</strong>
              {requirement && <small className="table-caveat">{t(UNRESOLVED_PRIORITY_LABELS[requirement.importance])}</small>}
              {alternative?.sourceText && <p className="alternative-source">{t("From your request")} <q className="unresolved-wording">{alternative.sourceText}</q></p>}
              <p>{reason.text}</p>
            </div></li>;
          })}</ul>
        </div>}
        <div className="detail-section"><h3>{t("Follow the sources")}</h3><div className="evidence-list">{detail.evidence.map((evidence) => <article key={evidence.id}><div><span className="evidence-id">{evidence.id}</span><span className="evidence-basis">{t(evidence.basis.replaceAll("_", " "))}</span></div><p>{evidence.statement}</p><a href={safeUrl(evidence.url)} target="_blank" rel="noreferrer noopener">{t("Open source") + " "}<span aria-hidden="true">↗</span></a><small>{evidence.locator}{" " + t("\u00B7 Checked") + " "}{evidence.checkedDate}</small>{evidence.limitations.length > 0 && <p className="evidence-limit">{evidence.limitations.join(" ")}</p>}</article>)}</div></div></div></>}</dialog>

    <dialog className="atlas-dialog comparison-dialog" ref={compareDialog} aria-labelledby="comparison-title" onClick={(event) => { if (event.target === event.currentTarget)
        compareDialog.current?.close(); }}><div className="dialog-topline"><span className="small-label">{t("SIDE BY SIDE")}</span><button className="dialog-close" onClick={() => compareDialog.current?.close()} aria-label={t("Close comparison")}>{t("Close") + " "}<span aria-hidden="true">×</span></button></div><div className="detail-heading"><p className="eyebrow">{t("THE SAME QUESTIONS. DIFFERENT POSSIBILITIES.")}</p><h2 id="comparison-title">{t("A closer comparison.")}</h2><p>{t("Recorded features and tentative assessments keep their scope.")}</p></div><p className="comparison-hint">{t("Scroll to compare")}</p><div className="comparison-scroll" role="region" aria-label={t("A closer comparison.")} tabIndex={0}><table><thead><tr><th scope="col">{t("What matters")}</th>{selectedGames.map((game) => <th key={game.id} scope="col">{game.title}</th>)}</tr></thead><tbody><ActiveCriteriaRows criteria={query.criteria} games={selectedGames} locale={locale}/>
      <AlternativeCriteriaRows alternatives={alternatives} games={selectedGames} locale={locale}/>
      <UnresolvedCriteriaRows requirements={unresolvedRequirements} games={selectedGames} results={resultsByGameId} locale={locale}/>
      <tr><th scope="row">{t("At a glance")}</th>{selectedGames.map((game) => <td key={game.id}>{game.summary}</td>)}</tr>{taxonomy.map((feature) => <tr key={feature.id}><th scope="row">{feature.label}</th>{selectedGames.map((game) => <td key={game.id}>{facetLabel(game, feature.id, locale)}{game.facets[feature.id]?.status === "provisional" && <small className="table-caveat">{t("Provisional assessment")}</small>}</td>)}</tr>)}<tr><th scope="row">{t("A tradeoff to consider")}</th>{selectedGames.map((game) => <td key={game.id}>{game.tradeoffs[0]?.text || t("Not assessed")}</td>)}</tr><tr><th scope="row">{t("Edition / content scope")}</th>{selectedGames.map((game) => <td key={game.id}>{game.editionScope}</td>)}</tr><tr><th scope="row">{t("Source")}</th>{selectedGames.map((game) => <td key={game.id}><a href={safeUrl(game.storeUrl)} target="_blank" rel="noreferrer noopener">{t("Store description") + " "}<span aria-hidden="true">↗</span></a></td>)}</tr></tbody></table></div></dialog>
    <style>{`:root{--tray-space:${`${trayHeight}px`}}`}</style>
  </>;
}
