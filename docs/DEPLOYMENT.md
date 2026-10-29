# Hosting your own copy

For the Node/SQLite branch, use [the independent-host guide](INDEPENDENT_HOST.md). The Sites instructions below describe the original Cloudflare deployment path.

The repository is a clean source snapshot. It does not contain the production Site identity, database, account keys, private feedback or the research workspace's Git history.

Local browsing, criteria editing and comparison work without a key; see the README. To host an AI-enabled copy, provision your own Sites project and D1 binding, apply the committed migrations, and configure the server secrets documented in `.env.example`. Register your own project identity rather than copying the production deployment's settings. Hosting and provider billing belong to the operator of that copy.

The hosted demo uses one cumulative US$10 trial. Its ledger must stay in place across migrations and provider changes. A fork has its own database; it must not be used as a second counter for paid development against the demo's approved allowance.

The exported `.openai/hosting.json` retains the storage bindings and omits `project_id`. The production checkout retains its real manifest. The private release checkpoint records the deployed source commit and corresponding public GitHub commit.

Before enabling live AI, confirm the provider account's currency and available quota, review the current peak prices and foreign-exchange bound, and keep the seven-day reference-expiry guard. Run a small bounded check; never put a provider key in client code or public environment variables.

The preview's source and core assets are served locally by the app. Availability from a particular region still depends on the selected host and real visitor networks. A successful provider request does not establish that visitors can reach the website.
