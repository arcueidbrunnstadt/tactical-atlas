"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { evaluateCriterion, matchGames } from "../lib/match";
import { getCriterionLabel, getFeature, getValueLabel, isAllowedValue, TAXONOMY, TAXONOMY_VERSION } from "../lib/taxonomy";
import type { Criterion, GameRecord, MatchResult, SearchQuery } from "../lib/types";
import FeedbackForm from "./feedback-form";

const EMPTY_QUERY: SearchQuery = { criteria: [], excludedGameIds: [], unhandledRequirements: [] };
const EXAMPLES = [
  { label: "Fantasy & character building", text: "I want fantasy turn-based combat with plenty of character-building choices. A story is a bonus." },
  { label: "Positioning over progression", text: "I prefer compact tactical encounters built around positioning and interacting abilities." },
  { label: "A military campaign", text: "I want a military or science-fiction squad campaign. Exclude XCOM 2; I have already played it." },
];
const PALETTES = ["sage", "clay", "ochre", "slate", "moss", "ink"];
const REPOSITORY = "https://github.com/arcueidbrunnstadt/tactical-atlas";

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d={diagonal ? "M5 15 15 5M5 5h10v10" : "M3 10h13M11 5l5 5-5 5"} stroke="currentColor" strokeWidth="1.4" /></svg>;
}

function Brand() {
  return <span className="brand"><svg width="34" height="34" viewBox="0 0 36 36" fill="none" aria-hidden="true"><path d="M5 5h10v10H5zM21 5h10v10H21zM5 21h10v10H5z" stroke="currentColor" strokeWidth="1.5" /><path d="m26 19 7 7-7 7-7-7 7-7Z" fill="currentColor" /><path d="M10 8v4M8 10h4" stroke="currentColor" strokeWidth="1.3" /></svg><span>Tactical Atlas</span></span>;
}

function Artwork({ game, index = 0 }: { game: GameRecord; index?: number }) {
  const setting = game.facets.setting?.value;
  const fantasy = setting === "fantasy" || (Array.isArray(setting) && setting.includes("fantasy"));
  return <div className={`game-art palette-${PALETTES[index % PALETTES.length]}`} aria-hidden="true">
    <span className="art-code">TA / {String(index + 1).padStart(2, "0")}</span>
    <svg viewBox="0 0 360 170" fill="none">
      <g className="art-grid" stroke="currentColor" strokeWidth=".65" opacity=".18"><path d="M0 35h360M0 70h360M0 105h360M0 140h360M40 0v170M80 0v170M120 0v170M160 0v170M200 0v170M240 0v170M280 0v170M320 0v170" /></g>
      <g transform={`translate(${index % 2 ? 12 : -9},0)`} stroke="currentColor" strokeWidth="1.4">
        <path d="M72 128 182 68l111 59-110 59-111-58Z" fill="currentColor" opacity=".09" />
        <path d="m72 111 110-60 111 59-110 59-111-58Z" strokeDasharray="3 5" opacity=".5" />
        <path d="m109 91 37 20 37-20 37 20 36-20M109 131l37-20M146 151l37-20M220 151l-37-20M256 131l-36-20M146 71l37 20 37-20" opacity=".35" />
        <path d="m109 91 37-20 37 20-37 20-37-20Z" fill="var(--art-surface)" />
        <path d="M109 91v18l37 20v-18M183 91v18l-37 20" fill="var(--art-surface)" />
        {fantasy ? <g><path d="m222 33 10 15-10 15-10-15 10-15Z" fill="currentColor" /><path d="M222 65v29M210 83h24M222 94l-8 13h16l-8-13Z" /><path d="m145 43 16 9v30l-16 10-16-10V52l16-9Z" fill="var(--art-surface)" /><path d="m145 43 5 24-5 25-5-25 5-24Z" fill="currentColor" /></g> : <g><path d="m216 42 17-9 17 9v27l-17 9-17-9V42Z" fill="var(--art-surface)" /><path d="m216 42 17 9 17-9M233 51v27M222 75v21M244 75v21M216 53l-11 7v14M250 53l11 7v14" /><path d="m138 43 14-8 14 8v19l-14 8-14-8V43Z" fill="currentColor" /><path d="M145 68v19M159 68v19" /></g>}
        <path d="m183 131 37-20 36 20-36 20-37-20Z" fill="currentColor" opacity=".17" />
        <path d="M73 56h20M83 46v20M278 56h10M283 51v10" opacity=".45" />
        <circle cx="109" cy="131" r="5" fill="var(--art-surface)" /><circle cx="256" cy="91" r="5" fill="var(--art-surface)" />
      </g>
    </svg>
    <span className="art-caption">A study in choices</span>
  </div>;
}

function safeUrl(url: string) { return /^https?:\/\//i.test(url) ? url : "#"; }

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The search response could not be read.");
  return value as Record<string, unknown>;
}

function facetLabel(game: GameRecord, feature: string) {
  const facet = game.facets[feature];
  if (!facet || facet.status === "unknown" || facet.value === null) return "Not assessed";
  const values = Array.isArray(facet.value) ? facet.value : [facet.value];
  return values.map((value) => getValueLabel(feature, value)).join(" · ");
}

function decodeInterpretation(payload: Record<string, unknown>): SearchQuery {
  const unhandled = Array.isArray(payload.unhandledRequirements)
    ? payload.unhandledRequirements.filter((item): item is string => typeof item === "string").slice(0, 16) : [];
  const raw = Array.isArray(payload.criteria) ? payload.criteria : [];
  const criteria: Criterion[] = [];
  for (const [index, item] of raw.slice(0, 16).entries()) {
    if (!item || typeof item !== "object") { unhandled.push("An interpreted requirement could not be read."); continue; }
    const value = item as Record<string, unknown>;
    const chosenValue = value.value ?? value.desiredValue;
    if (typeof value.featureId !== "string" || !isAllowedValue(value.featureId, chosenValue)
      || (value.operator !== undefined && value.operator !== "eq" && value.operator !== "neq")
      || (value.importance !== "must" && value.importance !== "preferred")) {
      unhandled.push(typeof value.sourceText === "string" ? value.sourceText : "A requirement is outside this catalogue's vocabulary.");
      continue;
    }
    criteria.push({ id: typeof value.id === "string" ? value.id : `ai-${index}`, featureId: value.featureId,
      value: chosenValue, operator: value.operator === "neq" ? "neq" : "eq",
      importance: value.importance === "must" ? "must" : "preferred", weight: value.weight === 3 ? 3 : 1 });
  }
  if (raw.length > 16) unhandled.push("Additional requirements exceed the preview's editable limit.");
  return { criteria, unhandledRequirements: unhandled,
    excludedGameIds: Array.isArray(payload.excludedGameIds) ? payload.excludedGameIds.filter((id): id is string => typeof id === "string") : [] };
}

function ActiveCriteriaRows({ criteria, games }: { criteria: Criterion[]; games: GameRecord[] }) {
  return <>{criteria.map((criterion) => <tr key={`active-${criterion.id}`}>
    <th scope="row">{getCriterionLabel(criterion)}<small className="table-caveat">{criterion.importance === "must" ? "Must have" : criterion.weight === 3 ? "Prioritized preference" : "Preference"}</small></th>
    {games.map((game) => {
      const reason = evaluateCriterion(game, criterion);
      return <td key={game.id}><strong className={`comparison-outcome ${reason.status}`}>{reason.status === "match" ? "Matches this criterion" : reason.status === "mismatch" ? "Does not match" : "Needs checking"}</strong>{reason.text}</td>;
    })}
  </tr>)}</>;
}

export default function Home() {
  const [games, setGames] = useState<GameRecord[]>([]);
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
  const [detail, setDetail] = useState<GameRecord | null>(null);
  const trayRef = useRef<HTMLElement>(null);
  const detailDialog = useRef<HTMLDialogElement>(null);
  const compareDialog = useRef<HTMLDialogElement>(null);
  const detailOpener = useRef<HTMLElement | null>(null);
  const controller = useRef<AbortController | null>(null);
  const latestSubmission = useRef(0);

  useEffect(() => {
    const abort = new AbortController();
    fetch("/catalogue.json", { signal: abort.signal }).then((response) => {
      if (!response.ok) throw new Error("The catalogue could not be loaded.");
      return response.json();
    }).then((data) => {
      const records = Array.isArray(data) ? data : asObject(data).games;
      if (!Array.isArray(records)) throw new Error("The catalogue format is unavailable.");
      setGames(records as GameRecord[]);
    }).catch((error) => { if (error.name !== "AbortError") setLoadError("The catalogue could not be loaded. Please refresh to try again."); });
    fetch("/api/status", { signal: abort.signal }).then((response) => response.json()).then((data) => {
      setAiEnabled(asObject(data).enabled === true); setAiChecked(true);
    }).catch(() => setAiChecked(true));
    return () => { abort.abort(); controller.current?.abort(); };
  }, []);

  useEffect(() => {
    if (detail && detailDialog.current && !detailDialog.current.open) detailDialog.current.showModal();
  }, [detail]);

  useEffect(() => {
    if (!compared.length || !trayRef.current) { setTrayHeight(0); return; }
    const tray = trayRef.current;
    const measure = () => setTrayHeight(Math.ceil(tray.getBoundingClientRect().height) + 12);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(tray);
    return () => observer.disconnect();
  }, [compared.length]);

  const groups = useMemo(() => matchGames(games, query), [games, query]);
  const filtered = (items: MatchResult[]) => items.filter(({ game }) => !titleFilter.trim() || `${game.title} ${game.aliases.join(" ")}`.toLowerCase().includes(titleFilter.trim().toLowerCase()));
  const visibleMatches = filtered(groups.matches);
  const visiblePossible = filtered(groups.possible);
  const selectedGames = compared.map((id) => games.find((game) => game.id === id)).filter((game): game is GameRecord => !!game);
  const hasCriteria = query.criteria.length > 0 || query.excludedGameIds.length > 0;

  function cancelSubmission() {
    latestSubmission.current += 1; controller.current?.abort(); setBusy(false);
  }

  function editQuery(next: SearchQuery) {
    cancelSubmission(); setQuery(next); setInterpretationLabel("Edited by you"); setClarification("");
  }

  function patchCriterion(id: string, patch: Partial<Criterion>) {
    editQuery({ ...query, criteria: query.criteria.map((criterion) => criterion.id === id ? { ...criterion, ...patch } : criterion) });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!request.trim()) { setNotice("Describe a preference or add a criterion below to start your shortlist."); return; }
    cancelSubmission();
    const submission = ++latestSubmission.current;
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setNotice(""); setClarification("");
    try {
      const response = await fetch("/api/interpret", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: request.trim(), taxonomyVersion: TAXONOMY_VERSION, requestId: crypto.randomUUID() }), signal: abort.signal });
      const data = asObject(await response.json());
      if (submission !== latestSubmission.current) return;
      if (!response.ok) throw new Error(typeof data.message === "string" ? data.message : "AI search is unavailable right now. You can still build a shortlist with the editable criteria below.");
      setQuery(decodeInterpretation(data)); setInterpretationLabel("Interpreted from your request — editable");
      const question = data.clarification && typeof data.clarification === "object"
        ? (data.clarification as Record<string, unknown>).question : null;
      if (typeof question === "string" && question) setClarification(question);
      else if (data.status === "unsupported") setNotice("This request reaches beyond the current catalogue. The unmatched requirements remain visible below.");
      setAiEnabled(true);
    } catch (error) {
      if (submission !== latestSubmission.current || (error instanceof Error && error.name === "AbortError")) return;
      setNotice(error instanceof Error ? error.message : "AI search is unavailable. Use the criteria below to keep exploring.");
    } finally { if (submission === latestSubmission.current) setBusy(false); }
  }

  function openDetail(game: GameRecord, button: HTMLElement) { detailOpener.current = button; setDetail(game); }
  function closeDetail() { detailDialog.current?.close(); }
  function toggleCompare(id: string) {
    if (compared.includes(id)) setCompared(compared.filter((item) => item !== id));
    else if (compared.length < 3) { setCompared([...compared, id]); setNotice(""); }
    else setNotice("Your comparison already has three games. Remove one to add another.");
  }

  function reset() {
    cancelSubmission(); setQuery(EMPTY_QUERY); setRequest(""); setTitleFilter(""); setNotice(""); setClarification(""); setInterpretationLabel("");
  }

  function renderCard(result: MatchResult, needsChecking: boolean) {
    const { game, reasons } = result;
    const index = games.findIndex((record) => record.id === game.id);
    const positive = reasons.find((reason) => reason.status === "match");
    const unknown = reasons.find((reason) => reason.status === "unknown");
    return <article className="game-card" key={game.id}>
      <Artwork game={game} index={index} />
      <div className="card-body">
        <div className="card-kicker"><span>{facetLabel(game, "setting")}</span><span>{String(index + 1).padStart(2, "0")}</span></div>
        <h3><button className="title-button" onClick={(event) => openDetail(game, event.currentTarget)}>{game.title}</button></h3>
        <p className="game-summary">{game.summary}</p>
        <div className="game-tags"><span>{facetLabel(game, "structure")}</span><span>{facetLabel(game, "campaign")}</span></div>
        {hasCriteria && <div className={`match-note ${needsChecking ? "needs-checking" : ""}`}><span className="small-label">{needsChecking ? "STILL TO CHECK" : "WHY IT'S HERE"}</span><p>{needsChecking && unknown ? unknown.label + ": " + unknown.text : positive?.text || "No documented hard conflict in your current criteria. Open the profile for the remaining details."}</p></div>}
        <div className="card-actions"><button className="detail-link" onClick={(event) => openDetail(game, event.currentTarget)}>Read the profile <Arrow /></button><label className="compare-check"><input type="checkbox" checked={compared.includes(game.id)} onChange={() => toggleCompare(game.id)} /><span>Compare</span></label></div>
      </div>
    </article>;
  }

  return <>
    <a className="skip-link" href="#collection">Skip to the game collection</a>
    <header className="site-header"><div className="page-width header-inner"><a href="#top" className="brand-link" aria-label="Tactical Atlas home"><Brand /></a><nav aria-label="Main navigation"><a href="#collection">Explore games</a><a href="#about">The idea</a><a href="#contribute">Help build it <span aria-hidden="true">↗</span></a></nav><span className="edition-label"><i /> Experimental preview</span></div></header>
    <main id="top">
      <section className="hero page-width" aria-labelledby="hero-title">
        <div className="hero-heading"><div><p className="eyebrow">A FIELD GUIDE TO YOUR NEXT GAME</p><h1 id="hero-title">Find your next<br /><em>way to play.</em></h1><p className="hero-description">Describe the choices you enjoy. Explore games through<br className="desktop-break" /> their mechanics, tradeoffs and the evidence behind them.</p></div><div className="hero-aside"><div className="compass-art" aria-hidden="true"><svg viewBox="0 0 170 170" fill="none"><circle cx="85" cy="85" r="67" stroke="currentColor" strokeOpacity=".18" /><circle cx="85" cy="85" r="43" stroke="currentColor" strokeOpacity=".2" strokeDasharray="2 5" /><path d="M85 6v158M6 85h158M29 29l112 112M29 141 141 29" stroke="currentColor" strokeOpacity=".15" /><path d="m85 34 19 51-19 51-19-51 19-51Z" fill="currentColor" opacity=".12" /><path d="m85 34 19 51H85V34Z" fill="currentColor" /><path d="M85 136 66 85h19v51Z" stroke="currentColor" strokeWidth="1.5" /><circle cx="85" cy="85" r="5" fill="var(--paper)" stroke="currentColor" /></svg></div><p><strong>Less guessing.<br />More understanding.</strong><span>A small collection.<br />A closer look at what matters.</span></p></div></div>
        <form className="request-box" onSubmit={submit}>
          <div className="request-topline"><label htmlFor="game-request" className="small-label">WHAT WOULD YOU LIKE TO PLAY?</label><span className={`ai-status ${aiEnabled ? "connected" : ""}`}><i />{aiEnabled ? "AI search connected" : aiChecked ? "AI connection pending · filters work now" : "Checking search connection"}</span></div>
          <textarea id="game-request" maxLength={1000} value={request} onChange={(event) => { cancelSubmission(); setRequest(event.target.value); }} placeholder="Fantasy tactics with character-building choices, room to experiment, and a story worth following…" rows={2} />
          <div className="request-bottom"><p>Describe your preferences in English or Chinese.<br className="mobile-break" /> We search this collection, with its limits in view.</p><div className="request-submit">{busy && <button className="text-button" type="button" onClick={cancelSubmission}>Cancel</button>}<button className="button-primary" type="submit" disabled={busy || !games.length}>{busy ? <><span className="spinner" /> Reading your request</> : <>Find games <Arrow /></>}</button></div></div>
          <div className="request-examples"><span>Try a starting point</span>{EXAMPLES.map((example) => <button key={example.label} type="button" onClick={() => { cancelSubmission(); setRequest(example.text); document.getElementById("game-request")?.focus(); }}>{example.label}<span aria-hidden="true">↗</span></button>)}</div>
        </form>
        {notice && <p className="notice" role="alert">{notice}</p>}
        {clarification && <p className="notice clarification" role="status"><strong>A quick clarification:</strong> {clarification} Update your description or edit the criteria below.</p>}
      </section>

      <section className="collection page-width" id="collection" aria-labelledby="collection-title">
        <aside className="filter-panel" aria-labelledby="shortlist-title">
          <div className="filter-heading"><h2 id="shortlist-title">Your shortlist</h2><button className="text-button" onClick={reset}>Reset</button></div>
          <p className="filter-intro">Make the interpretation your own.<br />Changes update results immediately.</p>
          <label className="control-label" htmlFor="title-filter">Find a title</label><input id="title-filter" className="text-input" type="search" value={titleFilter} placeholder="Search this collection" onChange={(event) => setTitleFilter(event.target.value)} />
          <div className="criteria-heading"><span className="small-label">YOUR CRITERIA</span>{query.criteria.length > 0 && <span>{query.criteria.length}</span>}</div>
          {interpretationLabel && <p className="interpretation-label">{interpretationLabel}</p>}
          {!query.criteria.length && <div className="empty-criteria"><svg width="23" height="23" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 5h16v14H4zM9 5v14M4 10h16M15 10v9" stroke="currentColor" strokeWidth="1.2" /></svg><p>Start with a request above,<br />or add a preference here.</p></div>}
          <div className="criteria-list">{query.criteria.map((criterion, index) => {
            const feature = getFeature(criterion.featureId) || TAXONOMY[0];
            return <fieldset className="criterion" key={criterion.id}><legend className="sr-only">Criterion {index + 1}</legend><div className="criterion-top"><select aria-label={`Criterion ${index + 1} feature`} value={criterion.featureId} onChange={(event) => { const next = getFeature(event.target.value)!; patchCriterion(criterion.id, { featureId: next.id, value: next.options[0].value }); }}>{TAXONOMY.map((entry) => <option value={entry.id} key={entry.id}>{entry.label}</option>)}</select><button className="remove-button" aria-label={`Remove criterion ${index + 1}`} onClick={() => editQuery({ ...query, criteria: query.criteria.filter((entry) => entry.id !== criterion.id) })}>×</button></div><select className="criterion-value" aria-label={`Criterion ${index + 1} value`} value={String(criterion.value)} onChange={(event) => { const next = feature.options.find((option) => String(option.value) === event.target.value); if (next) patchCriterion(criterion.id, { value: next.value }); }}>{feature.options.map((option) => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}</select><div className="criterion-options"><select aria-label={`Criterion ${index + 1} importance`} value={criterion.importance} onChange={(event) => patchCriterion(criterion.id, { importance: event.target.value as "must" | "preferred" })}><option value="preferred">Prefer</option><option value="must">Must have</option></select><select aria-label={`Criterion ${index + 1} inclusion`} value={criterion.operator || "eq"} onChange={(event) => patchCriterion(criterion.id, { operator: event.target.value as "eq" | "neq" })}><option value="eq">Include</option><option value="neq">Exclude</option></select></div>{criterion.importance === "preferred" && <button className={`prioritize-button ${criterion.weight === 3 ? "is-prioritized" : ""}`} aria-pressed={criterion.weight === 3} onClick={() => patchCriterion(criterion.id, { weight: criterion.weight === 3 ? 1 : 3 })}>{criterion.weight === 3 ? "★ Prioritized" : "☆ Prioritize this"}</button>}</fieldset>;
          })}</div>
          <button className="add-criterion" disabled={query.criteria.length >= 16} onClick={() => editQuery({ ...query, criteria: [...query.criteria, { id: crypto.randomUUID(), featureId: "setting", value: "fantasy", importance: "preferred", weight: 1 }] })}><span aria-hidden="true">+</span> Add a preference</button>
          <div className="exclusions"><label className="control-label" htmlFor="excluded-game">Already played it?</label><select id="excluded-game" value="" onChange={(event) => { if (event.target.value) editQuery({ ...query, excludedGameIds: [...new Set([...query.excludedGameIds, event.target.value])] }); }}><option value="">Exclude a game…</option>{games.filter((game) => !query.excludedGameIds.includes(game.id)).map((game) => <option key={game.id} value={game.id}>{game.title}</option>)}</select>{query.excludedGameIds.map((id) => <button className="exclusion-chip" key={id} onClick={() => editQuery({ ...query, excludedGameIds: query.excludedGameIds.filter((entry) => entry !== id) })}>{games.find((game) => game.id === id)?.title || id}<span aria-label="Remove exclusion">×</span></button>)}</div>
          {query.unhandledRequirements.length > 0 && <div className="unhandled"><strong>Outside the current assessment</strong><ul>{query.unhandledRequirements.map((item, index) => <li key={index}>{item}</li>)}</ul><p>These requirements have not been counted as satisfied.</p></div>}
          <p className="filter-footnote">A required feature without enough evidence stays in <strong>Needs checking</strong>. Preferences shape the order; they are not quality scores.</p>
        </aside>

        <div className="catalogue-results"><div className="collection-heading"><div><p className="eyebrow">01 — THE COLLECTION</p><h2 id="collection-title">Different games.<br className="mobile-break" /> Different possibilities<span>.</span></h2></div><span className="collection-count">{games.length || "—"}<small>curated games</small></span></div>
          <div className="results-toolbar"><p role="status" aria-live="polite">{games.length ? hasCriteria ? `${visibleMatches.length} matches · ${visiblePossible.length} need checking` : `${visibleMatches.length} profiles to explore` : loadError || "Loading the collection…"}</p><span>{hasCriteria ? "Ordered by your preferences" : "A–Z · no popularity ranking"}</span></div>
          {loadError && <p className="notice" role="alert">{loadError}</p>}
          {visibleMatches.length > 0 && <div className="game-grid">{visibleMatches.map((result) => renderCard(result, false))}</div>}
          {visiblePossible.length > 0 && <><div className="possible-heading"><span className="small-label">NEEDS CHECKING</span><p>Potentially relevant, with unanswered must-haves.</p></div><div className="game-grid">{visiblePossible.map((result) => renderCard(result, true))}</div></>}
          {!!games.length && !visibleMatches.length && !visiblePossible.length && <div className="empty-results"><svg width="50" height="50" viewBox="0 0 50 50" fill="none" aria-hidden="true"><path d="M8 8h34v34H8zM8 25h34M25 8v34" stroke="currentColor" strokeWidth="1.2" /><circle cx="25" cy="25" r="6" fill="var(--paper)" stroke="currentColor" /></svg><h3>No supported match in this view.</h3><p>Try editing a requirement or removing a title filter.<br />The collection is small; an empty result is useful information, too.</p><button className="text-button" onClick={reset}>Reset the shortlist</button></div>}
          {!!groups.excluded.length && <details className="excluded-summary"><summary>{groups.excluded.length} games outside your current requirements</summary><ul>{groups.excluded.map(({ game, reasons }) => <li key={game.id}><strong>{game.title}</strong><span>{reasons.find((reason) => reason.status === "mismatch")?.label || "Excluded by you"}</span></li>)}</ul></details>}
          <p className="collection-note">A focused sample of turn-based tactical combat, including party RPGs. Profiles describe sourced mechanics and provisional interpretations, with room for questions.</p>
        </div>
      </section>

      <section className="about-section" id="about"><div className="page-width"><div className="section-heading"><div><p className="eyebrow">02 — THE IDEA BEHIND THE ATLAS</p><h2>Good recommendations<br />should show their working.</h2></div><p>We are exploring a more useful way to find games:<br className="desktop-break" /> start with what matters to you, then make the reasons visible.</p></div><div className="method-grid"><article><span>01 / DESCRIBE</span><h3>Begin with your preferences.</h3><p>Tell us what you enjoy, what you need, and what you would rather avoid. Review the interpretation and change it whenever you like.</p></article><article><span>02 / UNDERSTAND</span><h3>See more than a score.</h3><p>Explore concrete mechanics, progression choices and tradeoffs. Follow the sources behind a profile and keep its unanswered questions in view.</p></article><article><span>03 / DISCOVER</span><h3>Find a different possibility.</h3><p>Compare games through the same criteria. Popularity does not decide the order, and a tentative match is always labelled.</p></article></div><details className="scope-details"><summary>What this experimental preview does today</summary><p>The catalogue is curated with AI assistance. Live AI, when connected, interprets the visitor's request; application rules match the recorded profiles. Source descriptions and provisional assessments are not comprehensive current-build tests or overall judgments of balance, depth or authenticity. Historical military simulation has limited coverage. Broader research, independent review and player testing remain open work.</p><p>Manual filters run in your browser. When AI search is used, the request is sent to DeepSeek; the app does not keep a search history. Rate limiting stores a pseudonymous identifier and timestamps, without request text; records older than 24 hours are removed on subsequent submissions. Provider and hosting logs may have their own retention. <a href="https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html" target="_blank" rel="noreferrer noopener">Read the provider's data policy <span aria-hidden="true">↗</span></a></p></details></div></section>

      <section className="contribute-section page-width" id="contribute"><div><p className="eyebrow">03 — AN OPEN EXPERIMENT</p><h2>Help shape what<br />comes next<span>.</span></h2><p>For players with a better question.<br />For researchers, designers and developers with an idea to try.</p></div><div className="contribute-content"><p>This project is a working invitation. Tell us where a result misses the mark, help explain a game's mechanics, or improve the way preferences become a shortlist.</p><div className="contribute-tasks"><span>Add one useful game profile</span><span>Improve a search interpretation</span><span>Make uncertainty easier to understand</span></div>{REPOSITORY ? <a className="button-primary" href={safeUrl(REPOSITORY)} target="_blank" rel="noreferrer noopener">Explore the project <Arrow diagonal /></a> : <><button className="button-outline" disabled>Public repository being prepared</button><p className="publishing-note">Contribution and feedback links will appear with publication.</p></>}</div></section>
      <section className="page-width" aria-label="Project feedback"><FeedbackForm /></section>
    </main>

    <footer className="site-footer"><div className="page-width footer-inner"><a href="#top" className="brand-link"><Brand /></a><span>An experiment in finding games through better questions.</span><a href="#about">Scope & privacy</a></div></footer>

    {selectedGames.length > 0 && <aside className="compare-tray" ref={trayRef} aria-label="Selected games for comparison"><div className="compare-tray-inner"><div className="compare-picked"><span className="small-label">YOUR COMPARISON</span><div>{selectedGames.map((game) => <button key={game.id} onClick={() => setCompared(compared.filter((id) => id !== game.id))} aria-label={`Remove ${game.title} from comparison`}>{game.title}<span aria-hidden="true">×</span></button>)}</div></div><div className="compare-tray-actions"><button className="text-button" onClick={() => setCompared([])}>Clear</button><button className="button-primary" disabled={selectedGames.length < 2} onClick={() => compareDialog.current?.showModal()}>Compare {selectedGames.length}/3 <Arrow /></button></div></div></aside>}

    <dialog className="atlas-dialog detail-dialog" ref={detailDialog} aria-labelledby="detail-title" onClose={() => { setDetail(null); if (detailOpener.current?.isConnected) detailOpener.current.focus(); }} onClick={(event) => { if (event.target === event.currentTarget) closeDetail(); }}>{detail && <><div className="dialog-topline"><span className="small-label">GAME FIELD NOTES</span><button className="dialog-close" onClick={closeDetail} aria-label="Close game profile">Close <span aria-hidden="true">×</span></button></div><div className="detail-heading"><p className="eyebrow">{facetLabel(detail, "setting")}</p><h2 id="detail-title">{detail.title}</h2><p>{detail.summary}</p><a href={safeUrl(detail.storeUrl)} target="_blank" rel="noreferrer noopener">Open the store page <span aria-hidden="true">↗</span></a></div><div className="detail-body"><div className="detail-section"><h3>What shapes the experience</h3><ul className="profile-notes">{detail.notes.map((note, index) => <li key={index}><span>{note.text}</span><small>{note.evidenceIds.join(" · ")}</small></li>)}</ul></div><div className="detail-section"><h3>Tradeoffs & open questions</h3><ul className="profile-notes">{detail.tradeoffs.map((note, index) => <li key={index}><span>{note.text}</span><small>{note.evidenceIds.join(" · ")}</small></li>)}</ul><p className="edition-scope"><strong>Content scope:</strong> {detail.editionScope}</p></div>{query.criteria.length > 0 && <div className="detail-section"><h3>Your criteria, one by one</h3><ul className="criterion-outcomes">{[...groups.matches, ...groups.possible, ...groups.excluded].find((result) => result.game.id === detail.id)?.reasons.map((reason) => <li key={reason.criterionId}><span className={`outcome-dot ${reason.status}`} /><div><strong>{reason.label}</strong><p>{reason.text}</p></div></li>)}</ul></div>}<div className="detail-section"><h3>Follow the sources</h3><div className="evidence-list">{detail.evidence.map((evidence) => <article key={evidence.id}><div><span className="evidence-id">{evidence.id}</span><span className="evidence-basis">{evidence.basis.replaceAll("_", " ")}</span></div><p>{evidence.statement}</p><a href={safeUrl(evidence.url)} target="_blank" rel="noreferrer noopener">Open source <span aria-hidden="true">↗</span></a><small>{evidence.locator} · Checked {evidence.checkedDate}</small>{evidence.limitations.length > 0 && <p className="evidence-limit">{evidence.limitations.join(" ")}</p>}</article>)}</div></div></div></>}</dialog>

    <dialog className="atlas-dialog comparison-dialog" ref={compareDialog} aria-labelledby="comparison-title" onClick={(event) => { if (event.target === event.currentTarget) compareDialog.current?.close(); }}><div className="dialog-topline"><span className="small-label">SIDE BY SIDE</span><button className="dialog-close" onClick={() => compareDialog.current?.close()} aria-label="Close comparison">Close <span aria-hidden="true">×</span></button></div><div className="detail-heading"><p className="eyebrow">THE SAME QUESTIONS. DIFFERENT POSSIBILITIES.</p><h2 id="comparison-title">A closer comparison.</h2><p>Recorded features and tentative assessments keep their scope.</p></div><div className="comparison-scroll"><table><thead><tr><th scope="col">What matters</th>{selectedGames.map((game) => <th key={game.id} scope="col">{game.title}</th>)}</tr></thead><tbody><ActiveCriteriaRows criteria={query.criteria} games={selectedGames} /><tr><th scope="row">At a glance</th>{selectedGames.map((game) => <td key={game.id}>{game.summary}</td>)}</tr>{TAXONOMY.map((feature) => <tr key={feature.id}><th scope="row">{feature.label}</th>{selectedGames.map((game) => <td key={game.id}>{facetLabel(game, feature.id)}{game.facets[feature.id]?.status === "provisional" && <small className="table-caveat">Provisional assessment</small>}</td>)}</tr>)}<tr><th scope="row">A tradeoff to consider</th>{selectedGames.map((game) => <td key={game.id}>{game.tradeoffs[0]?.text || "Not assessed"}</td>)}</tr><tr><th scope="row">Edition / content scope</th>{selectedGames.map((game) => <td key={game.id}>{game.editionScope}</td>)}</tr><tr><th scope="row">Source</th>{selectedGames.map((game) => <td key={game.id}><a href={safeUrl(game.storeUrl)} target="_blank" rel="noreferrer noopener">Store description <span aria-hidden="true">↗</span></a></td>)}</tr></tbody></table></div></dialog>
    <style>{`:root{--tray-space:${`${trayHeight}px`}}`}</style>
  </>;
}
