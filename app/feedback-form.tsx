"use client";

import { useRef, useState, type FormEvent } from "react";
import styles from "./feedback-form.module.css";

export default function FeedbackForm() {
  const [category, setCategory] = useState("idea");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState(false);
  const active = useRef(false);
  const attempt = useRef<{ signature: string; requestId: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active.current) return;
    const text = message.trim();
    const characters = Array.from(text).length;
    if (characters < 20 || characters > 2000) { setSaved(false); setNotice("Please write between 20 and 2,000 characters."); return; }
    const signature = JSON.stringify([category, text]);
    if (attempt.current?.signature !== signature) attempt.current = { signature, requestId: crypto.randomUUID() };
    active.current = true; setBusy(true); setNotice(""); setSaved(false);
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 30_000);
    try {
      const response = await fetch("/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: attempt.current.requestId, category, message: text }), signal: abort.signal });
      const data = await response.json() as { status?: string; message?: string };
      if (!response.ok || data.status !== "saved") throw new Error(typeof data.message === "string" ? data.message : "Feedback could not be saved. Please try again later.");
      setSaved(true); setNotice("Thank you. Your feedback was saved privately for the project maintainer.");
      setMessage(""); attempt.current = null;
    } catch (error) {
      setNotice(error instanceof Error && error.name !== "AbortError" ? error.message
        : "The connection timed out. Your text is still here; you can submit it again safely.");
    } finally { clearTimeout(timeout); active.current = false; setBusy(false); }
  }

  return <div className={styles.panel} id="feedback">
    <h3>Share one useful thought.</h3>
    <p>No account needed. English or Chinese is welcome. This form cannot provide replies; use the project's GitHub issues for public follow-up.</p>
    <form onSubmit={submit}>
      <label htmlFor="feedback-category">What would you like to share?</label>
      <select id="feedback-category" value={category} onChange={(event) => setCategory(event.target.value)} disabled={busy}>
        <option value="idea">An idea for the project</option><option value="search">A search result or interpretation</option>
        <option value="missing-game">A missing game</option><option value="usability">A problem using the website</option>
      </select>
      <label htmlFor="feedback-message">Your feedback</label>
      <textarea id="feedback-message" value={message} onChange={(event) => setMessage(Array.from(event.target.value).slice(0, 2000).join(""))}
        maxLength={4000} required rows={5} disabled={busy} aria-describedby="feedback-privacy feedback-length" />
      <span id="feedback-length" className={styles.length}>{Array.from(message).length}/2,000 characters · at least 20</span>
      <p id="feedback-privacy" className={styles.privacy}>Your message is saved privately for the project maintainer, not posted to GitHub or sent to AI. Please include no personal details, passwords or API keys. Cleanup removes messages older than 90 days when later feedback arrives.</p>
      <button className="button-primary" type="submit" disabled={busy}>{busy ? "Saving feedback…" : "Send feedback"}</button>
      {notice && <p role={saved ? "status" : "alert"} className={saved ? styles.success : styles.error}>{notice}</p>}
    </form>
  </div>;
}
