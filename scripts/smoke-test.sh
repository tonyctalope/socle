#!/usr/bin/env bash
# Starts an image exactly as the deployment does, from compose.yaml (a web container and a
# runner container without network), and checks it from the outside.
#   usage: scripts/smoke-test.sh <image>
set -euo pipefail
image=${1:?usage: smoke-test.sh <image>}
here=$(cd "$(dirname "$0")/.." && pwd)
web=socle-smoke-$$
runner=$web-runner
port=${SMOKE_PORT:-8787}
base=http://localhost:$port
demo=http://demo.apps.localhost:$port
resolve=(--resolve "socle.localhost:$port:127.0.0.1" --resolve "demo.apps.localhost:$port:127.0.0.1")
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
expect() { [ "$2" = "$3" ] && echo "ok   $1" || { echo "FAIL $1: expected $2, got $3" >&2; exit 1; }; }

# A deployment folder of its own: the repository's compose.yaml, a .env, the data folders.
dir=$(mktemp -d)
data=$dir/data
cp "$here/compose.yaml" "$dir/compose.yaml"
mkdir -p "$data/apps" "$data/run"
chmod -R 777 "$data" # the image's user is not the one running this script
cat > "$dir/.env" <<ENV
CONTROL_URL=http://socle.localhost:$port
APPS_DOMAIN=apps.localhost
ALLOWED_EMAILS=ci@example.com
OIDC_ISSUER=https://accounts.example.com
OIDC_CLIENT_ID=ci
OIDC_CLIENT_SECRET=ci
DEMO_APP=1
SOCLE_CONTROL_HOST=socle.localhost
ENV
# Only what a test must change: the image under test, names that cannot clash with a real
# deployment on the same machine, a port to reach it without a reverse proxy (which is told
# to ignore it).
cat > "$dir/compose.smoke.yaml" <<YAML
services:
  socle:
    image: $image
    container_name: $web
    ports: ['127.0.0.1:$port:8787']
    labels:
      - traefik.enable=false
  runner:
    image: $image
    container_name: $runner
YAML
compose() { docker compose -p "$web" --project-directory "$dir" -f "$dir/compose.yaml" -f "$dir/compose.smoke.yaml" "$@"; }
# compose.yaml joins the reverse proxy's network, which a deployment already has.
made_network=
if ! docker network inspect frontend >/dev/null 2>&1; then
  docker network create frontend >/dev/null
  made_network=1
fi
cleanup() {
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  [ -n "$made_network" ] && docker network rm frontend >/dev/null 2>&1 || true
  docker run --rm -v "$data:/data" --entrypoint sh "$image" -c 'rm -rf /data/* 2>/dev/null' >/dev/null 2>&1 || true
  rm -rf "$dir" 2>/dev/null || true
}
trap cleanup EXIT

compose up -d >/dev/null
for _ in $(seq 1 30); do curl -fsS "$base/healthz" >/dev/null 2>&1 && break; sleep 1; done
# The demo app is built by the runner container right after start.
for _ in $(seq 1 30); do docker logs "$web" 2>&1 | grep -q 'demo app published' && break; sleep 1; done

expect "health check by IP" 200 "$(status "$base/healthz")"
expect "unknown host gets nothing" 404 "$(status "$base/")"
expect "control plane home" 200 "$(status "${resolve[@]}" "http://socle.localhost:$port/")"
expect "the web container reaches the runner" '{"ok":true,"runner":true}' "$(curl -s "${resolve[@]}" "http://socle.localhost:$port/healthz")"
expect "the runner built and published the demo app" 1 "$(docker logs "$web" 2>&1 | grep -c 'demo app published')"
expect "the runner built the platform's browser modules" 200 "$(status "${resolve[@]}" "$demo/_socle/vendor/react-dom.js")"
expect "app page sends anonymous visitors to sign in" 302 "$(status "${resolve[@]}" -H 'Accept: text/html' "$demo/")"
expect "app API needs a session" 401 "$(status "${resolve[@]}" "$demo/_socle/api/me")"
expect "app functions need a session" 401 "$(status "${resolve[@]}" -X POST -H 'Content-Type: application/json' -H "Origin: $demo" -d '{}' "$demo/_socle/api/fn/list")"
expect "app files need a session" 401 "$(status "${resolve[@]}" "$demo/assets/0000000000000000/main.js")"
expect "manifest is public" 200 "$(status "${resolve[@]}" "$demo/_socle/manifest.webmanifest")"
expect "unknown app" 404 "$(status "${resolve[@]/demo/ghost}" "http://ghost.apps.localhost:$port/")"

# What the runner container is: no network, no secret, no platform database.
expect "the runner has no network interface but loopback" lo "$(docker exec "$runner" ls /sys/class/net | tr '\n' ' ' | xargs)"
expect "the runner knows no secret" 0 "$(docker exec "$runner" env | grep -ciE 'oidc|vapid|allowed|secret' || true)"
expect "the web container's database exists" 1 "$(docker exec "$web" sh -c "ls /data/socle.db | wc -l")"
expect "the runner does not see the platform database" 0 "$(docker exec "$runner" sh -c "find / \\( -path /proc -o -path /sys -o -path /dev \\) -prune -o -name 'socle.db*' -print 2>/dev/null | wc -l")"
expect "the demo app has its own database" 1 "$(docker exec "$runner" sh -c 'ls /apps/demo/live.db | wc -l')"
docker logs "$web" 2>&1 | tail -5
docker logs "$runner" 2>&1 | tail -3

# Refuses to start without its configuration, with a readable message.
if out=$(docker run --rm "$image" 2>&1); then echo "FAIL expected a configuration error" >&2; exit 1; fi
case "$out" in *"Configuration error"*) echo "ok   refuses to start unconfigured";; *) echo "FAIL $out" >&2; exit 1;; esac
# Production never runs agent-written code in the web container itself.
if out=$(docker run --rm -e CONTROL_URL=https://socle.example.com -e APPS_DOMAIN=apps.example.com \
  -e ALLOWED_EMAILS=ci@example.com -e OIDC_ISSUER=https://accounts.example.com -e OIDC_CLIENT_ID=ci -e OIDC_CLIENT_SECRET=ci "$image" 2>&1); then
  echo "FAIL expected a refusal without RUNNER_SOCKET" >&2; exit 1
fi
case "$out" in *"RUNNER_SOCKET is required"*) echo "ok   refuses to start without a separate runner";; *) echo "FAIL $out" >&2; exit 1;; esac
