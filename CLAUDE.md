# CLAUDE.md

Socle is the single platform behind the household's mini-apps: it owns sign-in, sessions, notifications and the
PWA plumbing once, so that an app is only its own screens and logic. One server answers on two kinds of hosts: the
**control plane** (`CONTROL_URL`) and **one host per app** (`https://<slug>.<APPS_DOMAIN>`).

The goal that shapes every decision: **one dependency tree to keep patched**. Apps never bring npm packages of
their own, server or browser side. Keep the platform's own tree small (4 production dependencies today).

## Commands

```bash
npm run dev          # node --watch, reads .env (see .env.example for the localhost settings)
npm test             # node --test (test/*.test.ts), no network except a fake Google on 127.0.0.1
npm run typecheck    # tsc, no emit
npm run format       # prettier
scripts/smoke-test.sh <image>   # what CI runs against the built image
```

Use Node 26 (`engines`). On Tony's machine `/usr/bin/node` is v22: prefix
`PATH=$HOME/.local/share/mise/installs/node/26.13.0/bin:$PATH`. Docker needs sudo there, so images are built by CI.

Local run: `CONTROL_URL=http://socle.localhost:8787 APPS_DOMAIN=apps.localhost NODE_ENV=development DEV_LOGIN=1
DEMO_APP=1`, then open `http://demo.apps.localhost:8787/` (browsers resolve `*.localhost` themselves).

## Architecture

- `src/app.ts` picks the handler from the request host: `src/control/app.ts` or `src/apphost/app.ts`. Any other host
  only gets `/healthz`. URLs are always built from the configuration (`appOrigin`), never from a request's Host.
- The server runs **TypeScript directly** (Node type stripping): only erasable syntax (no enums, no parameter
  properties, no namespaces), relative imports end in `.ts`, type-only imports use `import type`.
- `src/control/` — Google sign-in (`/auth/google/*`), the home page, `/sso/start`. Pages are server-rendered with
  `hono/html` (auto-escaping) and carry **no JavaScript**.
- `src/apphost/` — everything on an app host. The platform owns `/_socle/*` (sign-on, API, service worker, SDK,
  manifest, icons); the rest of the path space belongs to the app. The platform also writes the HTML document
  (`shell.ts`): apps never write `<head>`.
- `src/auth/` — `sessions.ts` (one row per browser and host, `scope` = `''` for the control plane or the app's
  slug, `family` = one sign-in on one browser), `sso.ts` (one-time codes from the control plane to an app host; the
  flow is described at the top of the file), `google.ts` (OIDC with openid-client).
- `src/push/` — Web Push, one subscription per browser **and per app** (each app is its own origin).
- `src/client/` — what browsers load from `/_socle/`: `sdk.js` (the API apps import) and `sw.js` (notifications).
  Plain JavaScript, served as-is. `src/demo/` is the built-in demo app (`DEMO_APP=1`).
- `src/db/` — `node:sqlite`, append-only `MIGRATIONS` (PRAGMA user_version), tiny `get/all/run` helpers with named
  params. `transaction()` callbacks must be synchronous.

## Invariants (security)

The control plane and every app are **sibling subdomains of one registrable domain** (Tony's decision). Browsers
treat siblings as the same site: SameSite cookies do not separate them, and a page of one app can set cookies for
the parent domain. Everything below exists because of that; none of it is optional.

- Cookies are `__Host-` prefixed, HttpOnly, host-only. **Never set a cookie with a `Domain` attribute**, and never
  read a cookie without the prefix in production (`readAppCookie`).
- Every state-changing, cookie-authenticated route checks the exact `Origin` and `Sec-Fetch-Site` (`isSameOrigin`).
  Private reads refuse requests started by another origin (`isOwnFetch`). GET routes have no side effects, except
  the sign-on steps, which only answer a top-level navigation (`isTopLevelNavigation`).
- A session is only valid on the host it was created for (`sessions.scope`). App hosts get theirs through a
  one-time code that is single-use, expires in a minute, is tied to one app and to the state cookie of the browser
  that started the flow.
- Sessions slide 30 days and end 180 days after creation. When the expiry slides, **the cookie must be sent again**
  (`ActiveSession.renewed`), otherwise the browser drops it at the old date.
- `family` = one browser, named by the `socle_device` cookie of the control plane (not a credential). Signing out
  anywhere deletes the family: sessions on every host, pending codes, push subscriptions. Signing in on a browser
  deletes what **another** member left in its family (`claimFamily`).
- A login in progress lives in the login cookie, not in the database: nothing an anonymous visitor does creates a
  row. Keep it that way (`sso_codes` rows need a signed-in member).
- `APP_CSP` goes on **every response of an app host**, not only pages: a worker takes its policy from its own script
  response, and a file opened directly is a document of its own. CSP cannot restrict navigations: an app can still
  send its own data away by navigating.
- Only `/_socle/sw.js` may be registered as a service worker (requests carrying `Service-Worker: script` are refused
  everywhere else): a worker written by an app could serve pages without the CSP. The platform worker must never
  `importScripts` or run anything an app provides.
- Without a session an app host only serves what a browser fetches without cookies to install a PWA (icons,
  manifest, service worker, SDK). App files and the API need the session of that host.
- Apps receive a user id and a display name, never the e-mail address.
- Secrets (session ids, sign-on codes) are random 256-bit and stored **only as SHA-256 hashes**. Never log query
  strings (the access log in `src/app.ts` drops them).
- The allowlist (`ALLOWED_EMAILS`) is checked at login and on every use of a session.
- Push endpoints are restricted to the browsers' push services (`parseSubscription`) and capped per member and app
  (`MAX_SUBSCRIPTIONS`), so a subscription can neither make the server call arbitrary URLs nor fan out without
  bound.
- Redirect targets go through `safeNextPath`, which resolves the path like a browser before checking it.

Known limits, accepted with the shared domain: a hostile app can sign the member out everywhere (its own logout
call, or by flooding the parent domain with cookies until requests are refused), can abort a sign-on in progress,
and anyone can learn which app names exist (public manifest).

## Tests

`test/helpers.ts` builds an in-memory platform with two apps (`demo`, `notes`) and a `Browser` with one cookie jar
per host that follows redirects from host to host. `sso.test.ts` and `isolation.test.ts` pin the invariants above;
`google-login.test.ts` runs a fake OIDC provider signing RS256 ID tokens. A security rule without a test is not
done. An independent review on 2026-11-12 found the CSP missing on non-HTML responses; its findings are fixed and
pinned by tests.

## Roadmap

1. **Done here**: kernel, sign-on per subdomain, PWA and notifications on the demo app.
2. Runner: a second container without network or secrets that builds apps (esbuild + Tailwind, in memory, no
   `npm install`) and runs their server functions in QuickJS, one SQLite file per app, one transaction per call.
3. MCP: one builder server on the control plane and one MCP server per app that marks functions as tools; drafts
   that Tony publishes, versions, rollback.
4. Port tasker, then tricount. 5. Port plantes.
