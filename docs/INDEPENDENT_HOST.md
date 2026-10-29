# Independent-host trial

This branch prepares the preview for a Node.js 24 Linux host with persistent SQLite storage. The existing Sites deployment is a separate checkout and stays unchanged. The initial infrastructure planning ceiling is US$30 for a domain year and one host month; no domain, host account or purchase is created by these files.

The interface, catalogue, interpretation validation and cumulative API allowance are retained. Copying the former Cloudflare build to a generic server is insufficient: this branch replaces the runtime/storage binding and supplies a Node standalone build. Mainland reachability remains an observed test to perform after hosting, not a property guaranteed by the build or region.

## Local preparation

Use Node.js 24 and npm, with no provider key:

```sh
npm ci
npm test
npm run typecheck
npm run build
npm start
```

`npm run build` builds with the installed Next.js version and runs `postbuild` to copy public assets, static bundles, migrations and startup helpers into `.next/standalone`. `npm start` applies schema migrations and starts the generated standalone server; `npm run dev` does the same preflight before its loopback development server. The SQLite path is made absolute before the generated server changes its working directory. The default is `data/atlas.sqlite`; set `DATABASE_PATH` explicitly for another persistent location.

Set `APP_ORIGIN` to the exact origin used by your browser, such as `http://127.0.0.1:3000` for a loopback check. Production must use the actual HTTPS origin. Feedback compares against this configured value rather than trusting visitor-supplied forwarded headers. The Node host uses signed browser sessions; it does not trust Sites or Cloudflare identity headers as visitor authorization.

Fresh storage can serve browsing and private feedback, but it cannot authorize a paid search until a validated trial handoff is imported. Keep `AI_ENABLED=false` throughout preparation. Local synthetic tests must not become a second paid development counter.

## Host packaging

The repository includes a multi-stage `Dockerfile`, `deploy/compose.yaml` and `deploy/Caddyfile`. Build dependencies are installed inside the target Linux build image; a workstation's `node_modules` is excluded. The runtime image contains the standalone server and migration helpers, runs the app as a non-root user, and keeps SQLite in the `atlas_data` volume.

Use a host with Docker Engine and Compose available. Once a domain and a one-month host configuration have been selected, configure the domain's DNS to the host and allow its HTTPS/HTTP ports. Copy `deploy/.env.example` to a private `deploy/.env`, enter the domain and a separate random throttle secret, and leave AI off. Do not put keys in build arguments, Git or chat.

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build -d
```

Caddy accepts traffic on ports 80/443 and forwards to the app over the private Compose network. Port 3000 is not published to the host. Its certificate state persists in named volumes. The app origin is set to `https://SITE_DOMAIN`; DNS and certificate issuance must actually succeed before calling the host ready.

Review the final regional checkout and included bandwidth before buying. A domain-only change on the old host is not a promised remedy for the reported block. An independent host also needs direct mainland connection checks. Start with one server month; this repository does not enable a vendor subscription or auto-renewal.

## Preserve the existing API trial at cutover

1. Keep the replacement's AI off. Confirm browsing, source profiles, editable criteria, exclusions, comparison and feedback over the new HTTPS URL.
2. Disable AI on the old hosted preview before the final ledger export. Keep it disabled after cutover so two independent paid counters cannot run.
3. Export the final four AI tables using the owner's authorized database access. Keep the handoff JSON outside Git, the image build context and public directories. Use the importer format documented with the runtime adapter; do not reset the budget or omit consumed reservations.
4. Import into the replacement's persistent volume. An example Linux command, after placing the final JSON in a private directory, is:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml run --rm --no-deps \
  --entrypoint node -v /srv/tactical-atlas/private:/handoff:ro app \
  --experimental-strip-types scripts/node-import-ledger.mjs /handoff/final-ledger.json
```

5. Verify the imported budget, reservation identities and daily history against the final old-host snapshot. Import validation creates the handoff marker required by the Node runtime. The last earlier checkpoint is not a substitute for a fresh export after old AI is disabled.
6. Configure the provider key privately at runtime, confirm CNY and current pricing/FX references, then enable the replacement only. Make one bounded live request through the same remaining allowance. Retain old feedback records privately; do not copy them into the public repository.

The original US$10 API allowance is separate from domain/host costs. Browsing remains available when API references expire, the provider is unavailable or the allowance is exhausted.

The handoff envelope has `schemaVersion: 1`, `source: "tactical-atlas-sites"`, a fresh UTC `capturedAt`, an operator attestation `sourceAiDisabled: true`, and `tables` containing exactly `ai_trial_budget`, `ai_daily_usage`, `ai_call_reservations` and `ai_client_submissions`. Keep the actual exported columns and rows intact. The importer checks freshness within one hour, counter consistency and an empty destination; the attestation is not remote proof that old AI was switched off. An identical import can be retried without resetting later usage. Feedback content is not part of this envelope.

## Verification boundaries

A successful local Next build is not proof that a Linux Docker image was built, a certificate was issued, a vendor plan was purchased, or a mainland network can reach the host. Record each actual check separately. A workstation dependency junction can also be retained in local standalone output; the preparation script warns about it. The Docker build installs its own modules instead of using that linked directory. Do not treat an undeployed configuration example as a functioning migration.

Relevant framework references: [Next standalone output](https://nextjs.org/docs/app/api-reference/config/next-config-js/output), [Next CLI](https://nextjs.org/docs/app/api-reference/cli/next), [Docker's Next.js guide](https://docs.docker.com/guides/nextjs/).
