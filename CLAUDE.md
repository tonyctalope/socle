# CLAUDE.md

Socle is one self-hosted platform behind the small apps of a household, a team or a club: it owns sign-in,
sessions, notifications, the PWA plumbing, the build and the database once, so that an app is only its own screens
and logic. Apps are **written by agents** and arrive as a map of source files: treat their code as hostile.

It is a public project meant to be reused by others: nothing in the repository may be specific to one
installation (names, domains, a language, a sign-in provider). Code, comments, docs and commit messages are in
English; what the platform itself says to people goes through `src/i18n.ts` (server) or `words()` (kit).

Two processes, one image:

- **web** (`src/main.ts`) answers on the **control plane** (`CONTROL_URL`) and on **one host per app**
  (`https://<slug>.<APPS_DOMAIN>`). It holds every secret and never executes app code.
- **runner** (`src/runner/main.ts`) builds apps and runs their server functions. In production it is a second
  container with no network and no secret, reached over a Unix socket.

The goal that shapes every decision: **one dependency tree to keep patched**. Apps never bring npm packages of
their own, server or browser side. Keep the platform's own tree small (13 production dependencies today).

## Commands

```bash
npm run dev          # node --watch, reads .env (see .env.example for the localhost settings)
npm test             # node --test (test/*.test.ts), no network except a fake sign-in provider on 127.0.0.1
npm run typecheck    # tsc, no emit
npm run format       # prettier
scripts/smoke-test.sh <image>   # what CI runs against the built image: compose.yaml itself, with test names
```

Use Node 26 (`engines`); with mise: `mise exec node@26 -- npm test`.

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
- `src/control/` — sign-in (`/auth/start`, `/auth/callback`), the home page, `/sso/start`. Pages are server-rendered with
  `hono/html` (auto-escaping) and carry **no JavaScript**.
- `src/apphost/` — everything on an app host. The platform owns `/_socle/*` (sign-on, API, service worker, SDK,
  manifest, icons); the rest of the path space belongs to the app. The platform also writes the HTML document
  (`shell.ts`): apps never write `<head>`.
- `src/auth/` — `sessions.ts` (one row per browser and host, `scope` = `''` for the control plane or the app's
  slug, `family` = one sign-in on one browser), `sso.ts` (one-time codes from the control plane to an app host; the
  flow is described at the top of the file), `oidc.ts` (any OpenID Connect provider, found by discovery with openid-client; `OIDC_ISSUER`).
- `src/i18n.ts` — the platform's own words. The English sentence is the key (`t('Sign out')`), `APP_LOCALE`
  picks the table (`en`, `fr`); a test checks that every sentence the server says has its translation. The kit
  does the same in the browser with `words({ en, fr })` from `@socle/sdk`. Apps write their own text.
- `src/push/` — Web Push, one subscription per browser **and per app** (each app is its own origin).
- `src/client/sw.js` — the service worker (notifications), served as-is at `/_socle/sw.js`.
- `src/kit/` — what apps import in the browser: `sdk/` (`@socle/sdk`: `api`, `useQuery`, `useMe`, `usePush`,
  `start`) and `ui/` (`@socle/ui` components, `theme.css` tokens, `base.css`). `server.d.ts` describes
  `@socle/server`. The runner builds all of it once (`build/vendor.ts`) into ES modules served at
  `/_socle/vendor/*`, together with React: an app's bundle imports them by URL, so a page holds one React and a
  platform update reaches every app without rebuilding any.
- `src/apps/store.ts` — versions of an app (sources + what the runner built) in the platform database. An app has
  a **draft** (`app_drafts`: the files agents edit; `apps.draft_version`: the last build of them) and a published
  version (`apps.live_version`). `saveDraft()` builds and migrates the draft's database; `publishDraft()` runs the
  draft's migrations on the published database, then points `live_version` at it. `deploy()` does both at once for
  the demo app.
- `src/apps/slug.ts` — an app has **two addresses**: `<slug>.<APPS_DOMAIN>` and `<slug>--draft.<APPS_DOMAIN>`
  (`Site`). The label is what sessions, sign-on codes, notifications and the call gate are filed under, so the
  two never share anything; `c.get('site')` on an app host says which one a request is for.
- `src/apps/scheduler.ts` — scheduled functions (`schedule({ every, at, on, handler })`): every minute, for the
  published version of each app, the latest occurrence that has come is run once, as a mutation without a caller
  (`user` null). The occurrence is written down (`app_schedules`) before the call; a schedule seen for the first
  time starts with its next occurrence; screens and tools cannot call a scheduled function.
- `src/apphost/calls.ts` — one call of a server function, for a screen (HTTP) or an agent (MCP): gate, database
  of the right address, log, live update, notifications.
- `src/oauth/` — the authorization server MCP clients sign in with (OAuth 2.1, PKCE, dynamic registration and
  client metadata documents). One server for every MCP endpoint; a token is bound to one resource.
- `src/mcp/` — `http.ts` (an MCP endpoint behind those tokens), `builder.ts` (the tools that create and change
  apps, at `<CONTROL_URL>/mcp`), `guide.ts` (what an agent reads before writing an app: keep it exact), `app.ts`
  (an app's own endpoint, `https://<app host>/_socle/mcp`: its functions marked `tool`, run on the published
  version and data as the member; only exists while the published version offers a tool).
- `src/control/admin.ts` — `/admin/`: an administrator (`ADMIN_EMAILS`) publishes or discards drafts, and removes
  apps (the runner moves the app's folder to `<APPS_DIR>/.removed/` for a month; database handles notice a
  replaced file, so an app created again under the same name starts empty).
- `/admin/apps/<slug>/` — versions (`returnTo`: an earlier version comes back only when its migrations are
  exactly the published ones, since migrations never go backwards) and the access list (`apps.access`, read by
  `canAccess` alone).
- `src/control/connections.ts` — `/connections`: a member's connected applications (OAuth grants), and "Disconnect".
- `src/demo/` — the demo app, as the folder of sources an agent would send (`app.json`, `web/main.tsx`,
  `server/index.ts`, `migrations/*.sql`). It goes through the same build and sandbox as any app.
- `src/runner/` — see below.
- `src/db/` — `node:sqlite`, append-only `MIGRATIONS` (PRAGMA user_version), tiny `get/all/run` helpers with named
  params. `transaction()` callbacks must be synchronous.

## An app

A map of path → text (`src/runner/build/files.ts` checks its shape):

- `app.json` — name, description, colors. `icon.svg` — optional, the app's icon: the build renders it (resvg,
  WebAssembly, no fonts, nothing fetched) into the PNG sizes phones ask for, kept with the version.
- `web/main.tsx` — default-exports the root React component; the platform mounts it and writes the HTML document.
  May import `react`, `react-dom`, `@socle/sdk`, `@socle/ui`, and its own files in `web/` and `shared/`. Styling is
  Tailwind classes (+ optional `web/style.css`).
- `server/index.ts` — exports `query(...)`, `mutation(...)` and `schedule(...)` from `@socle/server`; imports only `server/` and
  `shared/`. A function gets `{ db, user, members, now, today, locale, notify }` and its input (checked against `v.…`).
- `migrations/NNN_name.sql` — applied once each, in name order, all new ones in one transaction.

Browser side, `useQuery('name', input)` reads a query and refetches it whenever any mutation of the app succeeds
(one event stream per open page: `src/apphost/live.ts`); `api.name(input)` calls any function.

## The runner (`src/runner/`)

- `build/` — esbuild fed from the in-memory map by a plugin that answers **every** import (`bundle.ts`), Tailwind's
  pure-JS `compile()` with `@plugin`/`@config` refused (`css.ts`). Nothing is installed, nothing is written.
  `files.ts` bounds what is accepted (bytes, line length, bracket nesting) before any parser reads it.
- `sandbox/engine.ts` — QuickJS compiled to WebAssembly; **a fresh WebAssembly instance, with its own capped
  memory, per call**. `sandbox/guest/std.ts` is `@socle/server`, loaded into each instance before the app.
- `sandbox/appdb.ts` — one SQLite file per app (`<APPS_DIR>/<slug>/live.db`), an authorizer, engine limits, and
  two handles: queries run on a read-only one. `sandbox/call.ts` — one transaction per call.
- `bundles.ts` — the runner keeps each app's server code on disk, named by its hash; a call names the hash. If the
  runner does not have it (`bundle_missing`), the web side sends it again from the platform database.
- `pool.ts` / `worker.ts` — two kinds of processes, all **killed when a job outlives its deadline**: a few workers
  that stay up and only serve calls, and **one fresh process per build, migration or backup**, gone afterwards
  (nothing a hostile source did to the bundler or the CSS compiler outlives its job).
- `supervisor.ts` / `client.ts` — the same jobs over a Unix socket (production) or in-process (development, tests).

## Invariants (security)

The control plane and every app are **sibling subdomains of one registrable domain** (so that one domain is enough to run an instance). Browsers
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
  manifest, service worker, SDK), and, for an app that offers tools, its MCP endpoint (`/_socle/mcp`, which only
  answers a bearer token) with the document that says where to get one
  (`/.well-known/oauth-protected-resource/_socle/mcp`: the one path the platform takes outside `/_socle/`).
  App files and the API need the session of that host.
- **An app's input schemas are data, never programs.** The build records nothing but the platform's small
  subset (`schemaProblem` refuses every other keyword: `pattern`, `$ref`…), inputs are checked in the sandbox,
  and the web process advertises a tool's schema to MCP clients without compiling or interpreting it.
- Apps receive a user id and a display name, never the e-mail address.
- Secrets (session ids, sign-on codes) are random 256-bit and stored **only as SHA-256 hashes**. Never log query
  strings (the access log in `src/app.ts` drops them).
- The allowlist (`ALLOWED_EMAILS`) is checked at login and on every use of a session or of an MCP token.
- **Agents never change what members use.** The builder's tools only touch drafts; there is no tool that
  publishes, deletes an app or empties published data (`migrate` with `reset` only accepts `*/draft`, in the
  runner itself). Publishing is a form of the control plane, admin-only, with the exact-origin check, and it
  names the draft version its page showed: a draft built again since is refused, not published in its place.
- **A draft's files are checked before they are kept** (`checkFiles` in `saveNow`, bounds in the tools' schemas):
  what is stored in `app_drafts` is read by every page and tool that shows the draft. Every operation on a draft
  (`saveDraft`, `editDraft`, `publishDraft`, `discardDraft`, `remove`) takes the app's turn (`inTurn`); an edit is
  merged inside its turn; one save runs, one waits, a third is refused.
- A draft is another origin with its own database: a draft's code never sees published data, and a session of
  one address is not a session of the other. Each address serves its own build files only
  (`byAssetHash` takes the address). The two share the app's places in the call gate (keyed by slug), the
  draft holding one at most.
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
  disabled at the engine level (`limits.attach = 0`). During a call a statement may only read tables that are in
  the app's schema; the tables SQLite builds in (`dbstat`, tokenizers…, listed from `PRAGMA module_list`) are
  refused by name everywhere.
- **Some things the authorizer never sees**, and are handled otherwise: VACUUM (a call is always inside the
  platform's transaction), and ROLLBACK as a _conflict clause_ (`INSERT OR ROLLBACK`, `RAISE(ROLLBACK)`), which
  would end that transaction: refused by name (`refuseRollback`), and `db.isTransaction` is checked after every
  statement of the app and before COMMIT. A call that lost its transaction gets no further statement and fails.
- **Nothing of an app may carry the `_socle_` prefix or hang on the platform's table** (a renamed table, a trigger
  on `_socle_migrations`): checked on the schema after each migration, because the platform's own writes there run
  unchecked.
- **A query cannot write** because its connection is read-only, not because of what it declared.
- **Time limits are enforced by killing the worker process.** The interpreter's own interrupt only fires between
  instructions (a slow built-in or a SQL statement is not interruptible) and is a courtesy, not the guarantee.
  An unfinished transaction is rolled back by SQLite when the file is next opened.
- **Memory**: what the app's JavaScript holds is bounded by the WebAssembly memory of the call
  (`limits.guestMemory`, enforced by the engine refusing to grow it; QuickJS's own `setMemoryLimit` cannot measure
  what it allocated in this build and must not be relied on). Everything else a job makes its process hold, SQLite's
  own memory above all (`hard_heap_limit` is ignored by Node's build), is bounded by the pool watching each working
  process and killing it past `limits.workerMemory`. Workers run with `--expose-gc` so a call's memory is released
  at once.
- **Disk is bounded per app**: database size (`max_page_count`), what one call may append to the write-ahead log
  (`walBytes`, checked after each write, the call is undone beyond it), and the size of the schema
  (`maxSchemaObjects`, `maxSchemaBytes`: every connection keeps the schema in memory and a backup pays for it).
- **A function runs as what it was published as**: the web side sends the kind recorded by the build, and the
  runner refuses a call whose code now says otherwise. A published query therefore always gets the read-only
  connection, even if its code decides at load time to call itself a mutation.
- **No virtual tables** (full-text search included) until an app needs one: it is a large native surface.
- **Nothing survives a call**: new WebAssembly instance, new interpreter, no shared state between apps or calls.
- **One app cannot starve the others**: `apphost/gate.ts` lets an app run 2 calls at once (the runner has 3
  workers) with 16 waiting, and refuses the rest at once; a caller that left while waiting is dropped. Keep
  `perApp` below the number of runner workers.
- **Calls are small, and so are their answers**: a call carries its input and a hash, never the app's code. Input
  and result cross every process boundary as JSON text (a deeply nested value may not survive being serialized
  again), input nesting is bounded, and what is read back from a failing function (name, message, code, stack) is
  cut inside the sandbox before it is copied out. The supervisor bounds how many requests it holds, the pool how
  many jobs wait, the client how large an answer it accepts.
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
and `isolation.test.ts` pin the step 1 invariants; `login.test.ts` runs a fake OIDC provider.

`sandbox.test.ts` is the list of things an app's server code must not be able to do (other apps' data, files,
endless loops, memory, recursion, forged answers); `runner.test.ts` covers the worker processes and the kills;
`apps.test.ts` goes from sources to HTTP with a real runner; `gate.test.ts` the sharing of workers between apps.
A security rule without a test is not done.

Independent reviews: 2026-11-12 (step 1), two on 2026-11-13 (step 2), one on 2026-11-13 (step 3: drafts, the
builder, the OAuth server). The last one found 22 things, the most serious being that publishing took the draft
as it was at the click rather than the one the page showed; all are fixed and pinned by `draft-rules.test.ts`
and additions to `oauth.test.ts`, `mcp.test.ts` and `drafts.test.ts`. Brief a review as a code review (the rules
of this file as the specification, findings written to a file as they come, a failing assertion as evidence).
A second one the same day covered what came after (per-app MCP endpoints, removal, connections, the fixes
themselves): 19 findings, the serious one being that an app could put a `pattern` in its input schema, which the
web process then compiled and ran. All fixed and pinned. Not reviewed yet: versions and return, access lists,
icons, scheduled functions.

## Roadmap

1. Done: kernel, sign-on per subdomain, PWA and notifications.
2. Done: the runner (build without install, server functions in a sandbox, one database per app, migrations,
   live updates), the SDK and UI kit, the demo app on that pipeline.
3. **Done here**: drafts with their own address and database, the builder MCP server and its OAuth server, the
   administration page where a person publishes.
4. Done: one MCP server per app (functions marked `tool`), removing an app, connected applications, versions
   and return to an earlier one, access lists, per-app icons.
5. Done: scheduled functions. Next: files and photos.
