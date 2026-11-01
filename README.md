# Tactical Atlas

An experimental way to discover games through the choices you enjoy: describe your preferences, edit the interpretation, and explore source-linked mechanics and tradeoffs.

This development branch contains **24 bilingual tactical-combat and party-RPG profiles**, editable hard/preferred criteria, game exclusions, explained ordering, source dossiers and two/three-game comparison. Shareable `/en` and `/zh` pages offer an English/简体中文 toggle that preserves the current search and selections without an AI request. Mobile refinements enlarge controls and text, improve narrow-screen navigation and contain comparison scrolling. Two games have permitted screenshots; the other 22 use title graphics. See [artwork sources and licences](docs/ARTWORK.md).

**Deployment pending:** these improvements are implemented on `codex/bilingual-mobile-catalogue`; the live site still serves the previous 12-game release. This implementation used no new paid AI calls and keeps the original cumulative **US$10** application allowance unchanged. The preview remains a working concept, not a general accuracy evaluation or a comprehensive game database.

[Try the preview](https://noctilucagame.com/) · [Report an issue or propose a contribution](https://github.com/arcueidbrunnstadt/tactical-atlas/issues) · [Roadmap](docs/ROADMAP.md)

The preview runs on an independent Hong Kong host with HTTPS and live DeepSeek interpretation. A Chinese search and duplicate-request protection passed on 1 November 2026; the owner also reported successful website access and search in response to a direct mainland test request. This is one owner observation, not a survey of networks. The website and its private feedback form require no account. See [the hosting issue](https://github.com/arcueidbrunnstadt/tactical-atlas/issues/1) for the original access problem.

## Run locally

This version targets **Node.js 24** and persistent SQLite. See [the independent-host guide](docs/INDEPENDENT_HOST.md) for standalone/Docker packaging and the required existing-ledger handoff. The previous Sites preview is kept as a manual-only fallback with AI disabled.

Use Node.js 24 with npm:

```sh
npm ci
npm run dev
```

Open the loopback URL printed by the server. No API key is needed to browse, edit criteria and compare. This mode is labelled clearly and does not simulate a live AI response.

```sh
node --experimental-strip-types --test tests/*.test.ts
npx tsc --noEmit
npm run build
```

## How search works

The live path sends only the request, the fixed vocabulary and catalogue identities to the provider. The model returns structured criteria and exclusions; application code validates them and matches the public JSON catalogue. Edits rerank without another model call. Result explanations resolve to profile evidence. Provisional judgments and unknowns do not establish a factual must-have pass.

The experimental catalogue includes games with turn-based tactical combat, including party RPGs. It is not a comprehensive library or a set of overall quality ratings. Store-reported mechanics are distinguished from provisional interpretation; current offline behavior is unassessed throughout the initial catalogue.

## Hosted API setup

For this branch, follow [the independent-host guide](docs/INDEPENDENT_HOST.md). Node hosting uses the SQLite adapter and requires a validated handoff of the existing trial before AI can run. A fresh database cannot start a second paid counter.

Configure an absolute persistent `DATABASE_PATH` and apply the committed migrations. Set `APP_ORIGIN` to the actual public HTTPS origin. Configure `DEEPSEEK_API_KEY` as a **server secret**, never as a public variable. Set `AI_PROVIDER=deepseek`, `AI_MODEL=deepseek-flash`, and `AI_BILLING_CURRENCY=USD` or `CNY` to match the account. Keep `AI_ENABLED=false` until the old host is disabled, a fresh ledger handoff is imported, account readiness and the price/currency envelope are verified. Thinking, tools and streaming are explicitly disabled; there are no automatic retries.

All paid development and public requests must use the same hosted ledger. Each DeepSeek call atomically reserves **three US cents** from the cumulative 1,000-cent trial and a 100-call UTC-day allowance. The migration preserves the three legacy one-cent reservations and the original counter. Reservations are not refunded after dispatch. Never run a second independent paid local counter. At the end of the allowance the app retains browsing/manual controls. This bound covers this application's requests, not unrelated key use or hosting charges.

The envelope uses peak, cache-miss prices plus headroom. CNY billing uses whole-fen rounding and a conservative 6.0 CNY/USD floor, below the checked 29 October 2026 SAFE reference of 6.7147. This is an application-usage bound, not an invoice exchange-rate promise. Pricing and currency references expire after seven days; review them before re-enabling. Unsupported/unconfirmed currency or stale references fail closed. See [current prices](https://api-docs.deepseek.com/quick_start/pricing/) and [billing sources](server/billing.ts).

`/api/status` performs a free, cached account-metadata check even while generation is switched off, once configuration is complete. A successful check verifies key acceptance, an unambiguous matching currency and the provider's availability flag. It returns no balances or credentials. Search repeats that check before consuming a paid reservation. Only completed sanitized metadata is cached, never an in-flight I/O promise. The model is called once per paid explicit submission.

The request text is sent to DeepSeek when live interpretation is enabled. Application quota records contain no raw requests, interpretations, names, emails or raw IP addresses. DeepSeek's stateless Responses interface does not establish zero provider retention; provider and hosting policies still apply. See [DeepSeek's privacy policy](https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html).

Submission throttling uses a separate server secret (`AI_THROTTLE_SECRET`, at least 32 random characters) to derive a pseudonymous client identifier. Accepted submissions are limited to 3 in a rolling 60 seconds and 20 per UTC day before the shared paid allowance is reserved. Only the hash, server attempt ID, UTC day and timestamp are stored; records older than 24 hours are deleted on subsequent submissions. Missing configuration, trusted identity or storage fails closed for AI; manual browsing stays available.

The Node host supports `AI_CLIENT_IDENTITY_MODE=browser-session` only. It uses a server-issued, signed first-party cookie with Secure, HttpOnly and SameSite=Lax attributes and UTC-day expiry. No visitor account is required. Clearing cookies or using another browser can reset this best-effort client allowance; the shared cumulative and global daily budget guards remain authoritative. Sites/Cloudflare identity headers, arbitrary client IDs and `X-Forwarded-For` are not trusted on this independent host.

## Contribute

See [CONTRIBUTING.md](CONTRIBUTING.md) and [the roadmap](docs/ROADMAP.md). Useful starting points include adding one contrasting sourced profile, improving an interpretation case, or making uncertainty easier to understand. Keep the code runnable without a key and distinguish a fake-provider test from a live result.

The on-site feedback form accepts optional English or Chinese notes without an account. Messages are stored privately for the project maintainer; they are not sent to DeepSeek or published to GitHub. The form collects no contact field and cannot provide replies. Please include no personal details or secrets. On later submissions, the app removes messages older than 90 days and guard records older than 24 hours; this is opportunistic cleanup, not a guaranteed deletion timer. Feedback uses a separate pseudonym and submission allowance, with no AI calls or API-budget reservations.

The public export removes the production Site identity while preserving source, migrations and notices. See [hosting your own copy](docs/DEPLOYMENT.md).

Original code is MIT licensed; preserve bundled/vendor dependency notices. Catalogue entries retain source attribution. The two bundled screenshots retain their own licences and credits; see [ARTWORK.md](docs/ARTWORK.md). External webpages and recordings are not redistributed or relicensed by this repository.
