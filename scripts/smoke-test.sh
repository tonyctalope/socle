#!/usr/bin/env bash
# Starts an image and checks it from the outside: usage  scripts/smoke-test.sh <image>
set -euo pipefail
image=${1:?usage: smoke-test.sh <image>}
name=socle-smoke-$$
port=${SMOKE_PORT:-8787}
base=http://localhost:$port
resolve=(--resolve "socle.localhost:$port:127.0.0.1" --resolve "demo.apps.localhost:$port:127.0.0.1")
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
expect() { [ "$2" = "$3" ] && echo "ok   $1" || { echo "FAIL $1: expected $2, got $3" >&2; exit 1; }; }
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

docker run -d --name "$name" -p "$port:8787" \
  -e CONTROL_URL="http://socle.localhost:$port" -e APPS_DOMAIN=apps.localhost \
  -e ALLOWED_EMAILS=ci@example.com -e GOOGLE_CLIENT_ID=ci -e GOOGLE_CLIENT_SECRET=ci -e DEMO_APP=1 \
  -e PORT=8787 "$image" >/dev/null
for _ in $(seq 1 30); do curl -fsS "$base/healthz" >/dev/null 2>&1 && break; sleep 1; done

expect "health check by IP" 200 "$(status "$base/healthz")"
expect "unknown host gets nothing" 404 "$(status "$base/")"
expect "control plane home" 200 "$(status "${resolve[@]}" "http://socle.localhost:$port/")"
expect "app page sends anonymous visitors to sign in" 302 "$(status "${resolve[@]}" -H 'Accept: text/html' "http://demo.apps.localhost:$port/")"
expect "app API needs a session" 401 "$(status "${resolve[@]}" "http://demo.apps.localhost:$port/_socle/api/me")"
expect "app files need a session" 401 "$(status "${resolve[@]}" "http://demo.apps.localhost:$port/assets/main.js")"
expect "manifest is public" 200 "$(status "${resolve[@]}" "http://demo.apps.localhost:$port/_socle/manifest.webmanifest")"
expect "unknown app" 404 "$(status "${resolve[@]/demo/ghost}" "http://ghost.apps.localhost:$port/")"
docker logs "$name" 2>&1 | tail -5

# Refuses to start without its configuration, with a readable message.
if out=$(docker run --rm "$image" 2>&1); then echo "FAIL expected a configuration error" >&2; exit 1; fi
case "$out" in *"Configuration error"*) echo "ok   refuses to start unconfigured";; *) echo "FAIL $out" >&2; exit 1;; esac
