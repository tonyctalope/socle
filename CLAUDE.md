# CLAUDE.md

Socle is the single platform behind the household's mini-apps: it owns sign-in, sessions, notifications, the PWA
plumbing, the build and the database once, so that an app is only its own screens and logic. Apps are **written by
agents** and arrive as a map of source files: treat their code as hostile.

Two processes, one image:

- **web** (`src/main.ts`) answers on the **control plane** (`CONTROL_URL`) and on **one host per app**
  (`https://<slug>.<APPS_DOMAIN>`). It holds every secret and never executes app code.
- **runner** (`src/runner/main.ts`) builds apps and runs their server functions. In production it is a second
  container with no network and no secret, reached over a Unix socket.

The goal that shapes every decision: **one dependency tree to keep patched**. Apps never bring npm packages of
their own, server or browser side. Keep the platform's own tree small (10 production dependencies today).

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
DEMO_APP=1`, then open `http://demo.apps.localhost:8787/` (browsers resolve `*.localhost` themselves). Without
`RUNNER_SOCKET` (development only) the server starts the runner's worker processes itself.

`npm run typecheck` runs two projects: `tsconfig.json` (server, tests) and `tsconfig.kit.json` (what browsers and
the sandbox load: `src/kit`, `src/demo`).

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
- `src/client/sw.js` — the service worker (notifications), served as-is at `/_socle/sw.js`.
- `src/kit/` — what apps import in the browser: `sdk/` (`@socle/sdk`: `api`, `useQuery`, `useMe`, `usePush`,
  `start`) and `ui/` (`@socle/ui` components, `theme.css` tokens, `base.css`). `server.d.ts` describes
  `@socle/server`. The runner builds all of it once (`build/vendor.ts`) into ES modules served at
  `/_socle/vendor/*`, together with React: an app's bundle imports them by URL, so a page holds one React and a
  platform update reaches every app without rebuilding any.
- `src/apps/store.ts` — versions of an app (sources + what the runner built) in the platform database;
  `deploy()` = build, migrate the app's database, then point `apps.live_version` at the new version.
- `src/demo/` — the demo app, as the folder of sources an agent would send (`app.json`, `web/main.tsx`,
  `server/index.ts`, `migrations/*.sql`). It goes through the same build and sandbox as any app.
- `src/runner/` — see below.
- `src/db/` — `node:sqlite`, append-only `MIGRATIONS` (PRAGMA user_version), tiny `get/all/run` helpers with named
  params. `transaction()` callbacks must be synchronous.

## An app

A map of path → text (`src/runner/build/files.ts` checks its shape):

- `app.json` — name, description, colors.
- `web/main.tsx` — default-exports the root React component; the platform mounts it and writes the HTML document.
  May import `react`, `react-dom`, `@socle/sdk`, `@socle/ui`, and its own files in `web/` and `shared/`. Styling is
  Tailwind classes (+ optional `web/style.css`).
- `server/index.ts` — exports `query(...)` and `mutation(...)` from `@socle/server`; imports only `server/` and
  `shared/`. A function gets `{ db, user, members, now, today, notify }` and its input (checked against `v.…`).
- `migrations/NNN_name.sql` — applied once each, in name order, all new ones in one transaction.

Browser side, `useQuery('name', input)` reads a query and refetches it whenever any mutation of the app succeeds
(one event stream per open page: `src/apphost/live.ts`); `api.name(input)` calls any function.

## The runner (`src/runner/`)

- `build/` — esbuild fed from the in-memory map by a plugin that answers **every** import (`bundle.ts`), Tailwind's
  pure-JS `compile()` with `@plugin`/`@config` refused (`css.ts`). Nothing is installed, nothing is written.
- `sandbox/engine.ts` — QuickJS compiled to WebAssembly; **a fresh WebAssembly instance per call**.
  `sandbox/guest/std.ts` is `@socle/server`, bundled at start and loaded into each instance before the app.
- `sandbox/appdb.ts` — one SQLite file per app (`<APPS_DIR>/<slug>/live.db`), an authorizer, engine limits, and
  two handles: queries run on a read-only one. `sandbox/call.ts` — one transaction per call.
- `pool.ts` / `worker.ts` — worker processes, one job at a time each, **killed when a job outlives its deadline**.
- `supervisor.ts` / `client.ts` — the same jobs over a Unix socket (production) or in-process (development, tests).

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

### What an app's code can reach

- **Server code only sees `db` and what the call was given.** It runs in an interpreter with no file, network or
  process API; the single bridge function passes text. The platform keeps its own references to its entry points
  inside the sandbox, taken before the app's code loads (in QuickJS a read-only global can still be redefined).
- **SQL is checked when it is compiled** (`decide()` in `appdb.ts`, an allowlist): own tables only, no PRAGMA,
  ATTACH, transaction statement, temporary object or extension; schema changes only in migrations. ATTACH is also
  disabled at the engine level (`limits.attach = 0`). The authorizer does not see VACUUM: what stops it is that a
  call is always inside the platform's transaction, which the app cannot end.
- **A query cannot write** because its connection is read-only, not because of what it declared.
- **Time limits are enforced by killing the worker process.** The interpreter's own interrupt only fires between
  instructions (a slow built-in or a SQL statement is not interruptible) and is a courtesy, not the guarantee.
  An unfinished transaction is rolled back by SQLite when the file is next opened.
- **Nothing survives a call**: new WebAssembly instance, new interpreter, no shared state between apps or calls.
- The web process never opens an app database and never evaluates app code; the runner never sees the platform
  database, a session or a secret (it has no `env_file`, no network, and its workers get an empty environment).
- App screens are confined by step 1's rules (CSP on every response, host-only cookies). The function endpoint is
  a cookie-authenticated POST: exact `Origin` check like every other write, and `{ query: true }` from
  `useQuery` refuses to run a mutation.
- The page shell embeds per-member data as a JSON block (`type="application/json"`, escaped by `embeddedJson`):
  it is `no-store`, and it is the only inline `<script>` — never add an executable one (the CSP forbids it anyway).
- What a function returns to the browser on failure: its own `fail()` message, or a generic sentence. Details go
  to the log, not to the page (except with `DEV_LOGIN`).

Known limits, accepted with the shared domain: a hostile app can sign the member out everywhere (its own logout
call, or by flooding the parent domain with cookies until requests are refused), can abort a sign-on in progress,
and anyone can learn which app names exist (public manifest).

## Tests

`test/helpers.ts` builds an in-memory platform with two apps (`demo`, published from fake build output, and `notes`,
unpublished) and a `Browser` with one cookie jar per host that follows redirects from host to host. `sso.test.ts`
and `isolation.test.ts` pin the step 1 invariants; `google-login.test.ts` runs a fake OIDC provider.

`sandbox.test.ts` is the list of things an app's server code must not be able to do (other apps' data, files,
endless loops, memory, recursion, forged answers); `runner.test.ts` covers the worker processes and the kills;
`apps.test.ts` goes from sources to HTTP with a real runner. A security rule without a test is not done.
Independent reviews on 2026-11-12 (step 1) and 2026-11-13 (step 2): their findings are fixed and pinned by tests.

## Roadmap

1. Done: kernel, sign-on per subdomain, PWA and notifications.
2. **Done here**: the runner (build without install, server functions in a sandbox, one database per app,
   migrations, live updates), the SDK and UI kit, the demo app on that pipeline.
3. MCP: one builder server on the control plane and one MCP server per app that offers the functions marked
   `tool` (their input schemas already come out of the build); drafts with their own database that Tony
   publishes, versions, rollback; an app log the agent can read; per-app icons and access lists.
4. Port tasker, then tricount (needs scheduled functions: `user` is null for those). 5. Port plantes (photos).
