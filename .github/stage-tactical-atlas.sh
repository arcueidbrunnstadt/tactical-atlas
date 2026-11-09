#!/usr/bin/env bash
# Build and test a pinned candidate on the local Linux Docker daemon.
# Uses one temporary container with no network, host ports, keys or mounted data.
set -Eeuo pipefail
umask 077

usage() {
  printf '%s\n' 'Usage: bash stage-candidate.sh [--diagnostics] <branch> <commit-sha> <tree-sha>' \
    '       bash stage-candidate.sh --diagnostics' >&2
  exit 64
}

diagnostics() {
  df -Pk /var/tmp
  if command -v free >/dev/null; then free -m; fi
}

if [[ ${1:-} == --diagnostics ]]; then
  diagnostics
  shift
  (( $# )) || exit 0
fi
[[ $# == 3 ]] || usage
branch=$1
commit=$2
tree=$3
[[ $branch =~ ^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$ && $commit =~ ^[0-9a-f]{40}$ && $tree =~ ^[0-9a-f]{40}$ ]] || usage
git check-ref-format "refs/heads/$branch" || usage
[[ $(uname -s) == Linux && $EUID == 0 ]] || { printf '%s\n' 'Expected an authorized Linux root session.' >&2; exit 1; }
for command in git docker timeout mktemp; do command -v "$command" >/dev/null || exit 69; done

docker=(docker --host unix:///var/run/docker.sock)
repo=https://github.com/arcueidbrunnstadt/tactical-atlas.git
run=$(mktemp -d /var/tmp/tactical-atlas-phase20-XXXXXXXX)
run_id=${run##*/}
src=$run/source
log=$run/staging.log
label=tactical-atlas.phase20-stage
container=
stage=source
image=tactical-atlas-app:phase20-${commit:0:12}-${run_id##*-}
exec 3>&1
printf 'STAGING_STARTED commit=%s private_run=%s\n' "$commit" "$run" >&3

cleanup() {
  local result=$? owned
  trap - EXIT
  set +e
  if [[ -z $container && $stage == isolated-container ]]; then
    container=$(timeout 15s "${docker[@]}" inspect --type container --format '{{.Id}}' "$run_id" 2>>"$log") || container=
  fi
  if [[ -n $container ]]; then
    owned=$(timeout 15s "${docker[@]}" inspect --type container --format '{{index .Config.Labels "tactical-atlas.phase20-stage"}}' "$container" 2>>"$log")
    if [[ $owned == "$run_id" ]]; then
      timeout 15s "${docker[@]}" logs "$container" >"$run/runtime.log" 2>&1
      timeout --kill-after=5s 30s "${docker[@]}" rm -f "$container" >>"$log" 2>&1 || result=1
    else
      result=1
    fi
  fi
  if (( result )); then
    printf 'STAGING_FAILED stage=%s private_log=%s\n' "$stage" "$log" >&2
  else
    printf 'STAGING_PASSED commit=%s tree=%s image=%s digest=%s private_run=%s\n' \
      "$commit" "$tree" "$image" "$digest" "$run" >&3
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
exec >>"$log" 2>&1

[[ $(timeout 15s "${docker[@]}" version --format '{{.Server.Os}}') == linux ]]
export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
git -c init.templateDir= init --quiet "$src"
timeout --kill-after=15s 300s git -C "$src" -c credential.helper= -c core.hooksPath=/dev/null \
  fetch --no-tags --depth=1 "$repo" "refs/heads/$branch"
[[ $(git -C "$src" rev-parse FETCH_HEAD) == "$commit" ]]
[[ $(git -C "$src" rev-parse "$commit^{tree}") == "$tree" ]]
git -C "$src" -c core.hooksPath=/dev/null checkout --quiet --detach "$commit"
[[ -z $(git -C "$src" status --porcelain --untracked-files=all) ]]
taxonomy=$(sed -nE 's/^export const TAXONOMY_VERSION = "([0-9]+(\.[0-9]+)+)";$/\1/p' "$src/lib/taxonomy.ts")
[[ $taxonomy =~ ^[0-9]+(\.[0-9]+)+$ ]]

stage=linux-build
export DOCKER_BUILDKIT=1
timeout --kill-after=30s 1800s "${docker[@]}" build \
  --label "org.opencontainers.image.revision=$commit" --label "tactical-atlas.source-tree=$tree" \
  --tag "$image" "$src"
digest=$(timeout 15s "${docker[@]}" image inspect --format '{{.Id}}' "$image")
[[ $digest =~ ^sha256:[0-9a-f]{64}$ ]]

stage=isolated-container
container=$(timeout --kill-after=5s 30s "${docker[@]}" create \
  --name "$run_id" --label "$label=$run_id" --network none \
  --env HOSTNAME=127.0.0.1 --env PORT=3000 \
  --env AI_ENABLED=false --env DEEPSEEK_API_KEY= --env AI_BILLING_CURRENCY=CNY \
  --env AI_PROVIDER=deepseek --env AI_MODEL=deepseek-flash \
  --env APP_ORIGIN=https://noctilucagame.com --env DATABASE_PATH=/data/atlas.sqlite \
  --env AI_CLIENT_IDENTITY_MODE=browser-session \
  --env AI_THROTTLE_SECRET=phase20-isolated-staging-test-key-never-production "$digest")
[[ $container =~ ^[0-9a-f]{64}$ ]]
[[ $(timeout 15s "${docker[@]}" inspect --type container --format '{{.Image}} {{.HostConfig.NetworkMode}} {{len .Mounts}} {{len .HostConfig.PortBindings}}' "$container") == "$digest none 0 0" ]]
timeout --kill-after=5s 30s "${docker[@]}" start "$container"

stage=isolated-checks
timeout --kill-after=10s 240s "${docker[@]}" exec -i "$container" node --input-type=module - "$taxonomy" \
  >"$run/staging-checks.json" 2>>"$log" <<'NODE'
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";

const taxonomyVersion = process.argv[2];
const base = "http://127.0.0.1:3000";
const origin = "https://noctilucagame.com";
const deadline = Date.now() + 90_000;
let ready = false;
while (!ready && Date.now() < deadline) {
  try {
    const response = await fetch(base + "/en", { redirect: "error", signal: AbortSignal.timeout(2_000) });
    ready = response.ok;
    await response.body?.cancel();
  } catch {
    // A fresh container can be applying its disposable database migrations.
  }
  if (!ready) await setTimeout(1000);
}
assert.ok(ready, "Staged server did not become ready");

async function request(path, status = 200, options = {}) {
  const response = await fetch(base + path, { ...options, redirect: "error", signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, status, path);
  return response;
}
const assets = new Set();
for (const [locale, lang] of [["en", "en"], ["zh", "zh-CN"]]) {
  const html = await (await request("/" + locale)).text();
  assert.ok(html.includes(`<html lang="${lang}"`), `HTML language for ${locale}`);
  assert.ok(html.includes(`rel="canonical" href="${origin}/${locale}"`), `Canonical URL for ${locale}`);
  assert.ok(html.includes("feedback-message") && html.includes("language-toggle"), `Interface markers for ${locale}`);
  const paths = [...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)].map(([, path]) => path.replaceAll("&amp;", "&"));
  assert.ok(paths.some((path) => /\.js(?:\?|$)/.test(path)), `Client bundle for ${locale}`);
  for (const path of paths) assets.add(path);
}
for (const path of assets) assert.ok((await (await request(path)).arrayBuffer()).byteLength > 0, path);

const catalogue = await (await request("/catalogue.json")).json();
const chinese = await (await request("/catalogue.zh.json")).json();
assert.equal(catalogue.length, 24);
assert.deepEqual(Object.keys(chinese).sort(), catalogue.map(({ id }) => id).sort());
for (const game of catalogue) {
  assert.ok(chinese[game.id].summary && chinese[game.id].editionScope, game.id);
  assert.deepEqual(Object.keys(chinese[game.id].evidence).sort(), game.evidence.map(({ id }) => id).sort(), game.id);
}
const artwork = await (await request("/artwork-manifest.json")).json();
assert.equal(Object.keys(artwork).length, 2);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const [game, item] of Object.entries(artwork)) {
  assert.ok(catalogue.some(({ id }) => id === game) && item.alt.en && item.alt.zh, game);
  assert.match(item.src, /^\/game-images\/[a-z0-9.-]+\.jpg$/);
  const image = await request(item.src);
  assert.match(image.headers.get("content-type") ?? "", /^image\/jpeg\b/);
  assert.equal(sha256(Buffer.from(await image.arrayBuffer())), sha256(readFileSync("/app/public" + item.src)), game);
}
for (const path of ["/game-images/ATTRIBUTION.md", "/game-images/GPL-2.0.txt"]) {
  assert.ok((await (await request(path)).text()).length > 0, path);
}

const status = await (await request("/api/status")).json();
assert.equal(status.mode, "manual");
assert.equal(status.enabled, false);
assert.equal(status.providerReady, false);
assert.equal(status.configurationReady, false);
const json = { "Content-Type": "application/json" };
const interpretation = await (await request("/api/interpret", 503, {
  method: "POST", headers: json,
  body: JSON.stringify({ query: "I need to control a tactical squad.", taxonomyVersion, requestId: randomUUID() }),
})).json();
assert.equal(interpretation.code, "AI_CONNECTION_PENDING");

const feedback = { requestId: randomUUID(), category: "usability", message: "Synthetic staging feedback for release verification." };
const body = JSON.stringify(feedback);
const headers = { ...json, Origin: origin, "Sec-Fetch-Site": "same-origin" };
const saved = await request("/api/feedback", 201, { method: "POST", headers, body });
assert.equal((await saved.json()).status, "saved");
const cookie = saved.headers.get("set-cookie")?.split(";")[0];
assert.ok(cookie?.startsWith("__Host-tactical-atlas-session="));
const duplicate = await request("/api/feedback", 200, { method: "POST", headers: { ...headers, Cookie: cookie }, body });
assert.equal((await duplicate.json()).status, "saved");
const rejected = await request("/api/feedback", 403, { method: "POST", headers: { ...headers, Origin: "https://example.invalid" }, body });
assert.equal((await rejected.json()).code, "FEEDBACK_ORIGIN_REJECTED");

const db = new DatabaseSync("/data/atlas.sqlite", { readOnly: true });
try {
  const count = (table) => db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total;
  assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  for (const table of ["ai_trial_budget", "ai_call_reservations", "ai_daily_usage", "ai_client_submissions", "node_trial_handoff"]) {
    assert.equal(count(table), 0, table);
  }
  assert.equal(count("feedback_messages"), 1);
  assert.equal(count("feedback_submission_guards"), 1);
  assert.equal(db.prepare("SELECT message FROM feedback_messages WHERE request_id = ?").get(feedback.requestId)?.message, feedback.message);
} finally {
  db.close();
}
console.log(JSON.stringify({
  ok: true, locales: ["en", "zh"], profiles: catalogue.length, clientAssets: assets.size, artwork: Object.keys(artwork).length,
  aiMode: status.mode, interpretationStatus: 503, feedbackStatuses: [201, 200, 403], feedbackRows: 1, aiRows: 0, generationRequests: 0,
}));
NODE

stage=complete
cat "$run/staging-checks.json" >&3
