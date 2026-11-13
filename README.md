# Socle

One self-hosted platform for the small apps of a household, a team or a club. Socle provides once what every small
app otherwise rebuilds on its own: sign-in, sessions, notifications, the Home Screen install, the build and the
database. An app is then only its screens and its logic, sent as source files — written by a person or by an AI
agent — and there is a single service to keep up to date.

It is made for a few people who know each other: an allowlist of e-mail addresses decides who gets in.

## Status

| Step | What                                                                                   | State   |
| ---- | -------------------------------------------------------------------------------------- | ------- |
| 1    | Sign-in (OpenID Connect), one session per subdomain, PWA and notifications, a demo app | done    |
| 2    | Apps built without `npm install`, one SQLite database per app, sandboxed functions     | done    |
| 3    | Agents create apps over MCP: drafts, an administrator publishes                        | done    |
| 4    | One MCP server per app (its functions as tools)                                        | done    |
| 4b   | Versions and rollback, per-app icons and access lists                                  | done    |
| 5    | Scheduled functions, files and photos                                                  | planned |

## How it works

One server answers on two kinds of addresses:

- **The control plane** (`CONTROL_URL`, for example `https://socle.example.com`): sign-in with your OpenID Connect
  provider (Google, Microsoft, Keycloak, Authentik…), restricted to the addresses in `ALLOWED_EMAILS`, and a home
  page that lists the apps.
- **One address per app** (`https://<app>.<APPS_DOMAIN>`): each app is its own origin, so its own installable PWA,
  with its own notifications.

When someone opens an app without being signed in, the browser goes through the control plane, which sends back a
single-use code, valid one minute, for that app only. The app trades the code for its own session cookie. Signing
out from any app signs out of all of them on that browser, and stays in that app: signing in again comes back to it.

On every app, the platform serves under `/_socle/`:

| Path                           | Role                                                                        |
| ------------------------------ | --------------------------------------------------------------------------- |
| `/_socle/vendor/*`             | React, the SDK (`@socle/sdk`) and the components (`@socle/ui`), served once |
| `/_socle/api/fn/<name>`        | The app's server functions                                                  |
| `/_socle/api/events`           | The stream that tells open pages when data changed                          |
| `/_socle/sw.js`                | The service worker (notifications), the same for every app                  |
| `/_socle/manifest.webmanifest` | The install manifest, generated from the app's description                  |
| `/_socle/login`, `/_socle/sso` | Sign-on                                                                     |

## An app

An app is a folder of source files. It installs no package: everything it imports comes from its own files or from
the platform.

| File                   | Content                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| `app.json`             | Name, description, colors                                               |
| `icon.svg`             | The app's icon, as one square SVG picture (optional)                    |
| `web/main.tsx`         | The screens, in React and Tailwind classes; exports the root component  |
| `server/index.ts`      | The server functions: `query` to read, `mutation` to change             |
| `migrations/NNN_*.sql` | The schema of the app's database, each file applied once, in name order |
| `shared/`              | What the screens and the server have in common                          |

```ts
// server/index.ts
import { mutation, query, v } from '@socle/server';

export const list = query(({ db }) => db.all('SELECT id, label FROM items ORDER BY id'));

export const add = mutation({
  input: v.object({ label: v.string().min(1).max(80) }),
  handler: ({ db, user, notify }, { label }) => {
    db.run('INSERT INTO items (label, author) VALUES (?, ?)', label, user.id);
    notify('others', { title: `${user.name} added ${label}` });
  },
});
```

```tsx
// web/main.tsx
import { api, useQuery } from '@socle/sdk';
import { Button, List, ListItem, Page } from '@socle/ui';

export default function App() {
  const items = useQuery<{ id: number; label: string }[]>('list');
  return (
    <Page title="Groceries">
      <List>
        {items.data?.map((item) => (
          <ListItem key={item.id}>{item.label}</ListItem>
        ))}
      </List>
      <Button onClick={() => api.add({ label: 'Bread' })}>Add bread</Button>
    </Page>
  );
}
```

Each function runs in one transaction on the app's database: if it fails, nothing is written. After a successful
change, every open page of the app reloads what it shows. `src/demo/` is a complete app written this way
(`DEMO_APP=1`, served on `demo.<APPS_DOMAIN>`): it checks, on a real phone, sign-in, install, notifications and a
shared list.

## Creating apps with an agent

The control plane is also an MCP server, at `<CONTROL_URL>/mcp`. Add it as a connector in Claude (or any MCP client
that signs in with OAuth): the member signs in with their usual account and their agent gets the builder's tools.

| Tool            | What it does                                                                |
| --------------- | --------------------------------------------------------------------------- |
| `read_guide`    | The rules for writing an app (files, imports, server functions, UI kit)     |
| `list_apps`     | Every app, its addresses and where its draft stands                         |
| `create_app`    | A new app, with a minimal draft that builds                                 |
| `read_files`    | The files of an app's draft or of its published version                     |
| `write_files`   | Saves files to the draft and builds it; returns the problems or its address |
| `call_function` | Runs a server function of the draft, to check it                            |
| `read_logs`     | What the app's functions printed and how they failed                        |

Everything an agent writes goes to the app's **draft**, served at `https://<app>--draft.<APPS_DOMAIN>` on a
database of its own: members can try it, and nothing changes in the app they use. There is no tool that publishes
and none that deletes. An administrator (`ADMIN_EMAILS`) publishes a draft from `<CONTROL_URL>/admin/`, after
seeing which files it changes; the published database then gets the draft's migrations. The same pages bring back an
earlier version (when the data did not change shape since), choose which members can open an app, and remove an
app (its data is kept aside on the server for a month). Each member sees the applications they connected, and can
disconnect them, at `<CONTROL_URL>/connections`.

### Using an app from a conversation

An app's author can mark some of its functions as tools:

```ts
export const add = mutation({
  tool: 'Adds an item to the shopping list.',
  input: v.object({ label: v.string().min(1).describe('What to buy') }),
  handler: ({ db }, { label }) => db.run('INSERT INTO items (label) VALUES (?)', label).lastInsertRowid,
});
```

Once published, the app has an MCP endpoint of its own, `https://<app>.<APPS_DOMAIN>/_socle/mcp`, that a member
adds as a connector: their assistant then acts in the app as they would, with the published version and the
published data. It shares the control plane's sign-in, and a connection to one app gives nothing on another.

## Security

The control plane and the apps are sibling subdomains of one domain. For a browser, siblings are one “site”:
`SameSite` cookies do not separate them. The separation therefore rests on four rules, all covered by tests:

- **`__Host-` cookies only**: tied to a single address, unreadable from JavaScript, impossible to replace from a
  sibling address.
- **Exact origin**: any request that changes something is refused unless it comes from a page of the same address.
- **Confined app pages**: a content security policy forbids them from calling any address but their own, and only
  the platform's service worker can be registered.
- **Sessions per address**: the session of an app is accepted nowhere else.

Known limits: an app can still send its own data elsewhere by navigating the browser away, set cookies visible to
the other services of the parent domain, and sign the person out of every app.

App code may be written by agents: the platform treats it as hostile.

- **Two containers**: `web` holds the secrets and never executes app code. `runner` builds the apps and runs their
  functions, with no network, no secret and no access to the platform's database.
- **Sandbox**: server functions run in a JavaScript interpreter compiled to WebAssembly, which has no file, network
  or process API. Every call gets a fresh interpreter.
- **One database per app**: a function can only name the tables of its own app. A read cannot write.
- **Limits** on time, memory and size: a call that outlives its deadline is stopped by killing the process that
  runs it, and its transaction is rolled back. Every call has its own capped memory.
- **Sharing**: one app can only occupy part of the runner's processes; the other apps keep answering while it is
  stuck.
- **Build without install**: the code is assembled in memory from the files that were sent; importing a package or
  a file from outside is a build error.

Socle is young and has not been audited by a third party. Run it for people you trust.

## Development

Node 26 runs the TypeScript sources directly, without a build step.

```bash
npm install
cp .env.example .env    # then enable the "Local development" block
npm run dev             # http://socle.localhost:8787 and http://demo.apps.localhost:8787
npm test
npm run typecheck
npm run format
```

Browsers resolve `*.localhost` by themselves. `DEV_LOGIN=1` replaces the sign-in provider with a page that lists
the allowed addresses; the server refuses to start with it outside `localhost`. In development the server starts
the runner's processes itself.

## Deployment

The image `ghcr.io/tonyctalope/socle` is built by CI (amd64 and arm64). You need:

1. Two DNS entries pointing at the server: the control plane's, and a wildcard `*.<APPS_DOMAIN>`.
2. A reverse proxy that terminates TLS, with a certificate for the control plane and a wildcard certificate for
   `*.<APPS_DOMAIN>` (DNS-01 challenge). `compose.yaml` is an example behind Traefik; any proxy that forwards the
   `Host` header unchanged works.
3. A client at your OpenID Connect provider (“web application”), with `<CONTROL_URL>/auth/callback` as authorized
   redirect URI. The provider must return a verified e-mail address.
4. A `.env` file next to `compose.yaml` (see `.env.example`).
5. The data folders, created before the first start by the user who runs the containers (`SOCLE_UID`):
   `mkdir -p data/apps data/run`.

`compose.yaml` starts two containers from the same image: `socle` (web) and `socle-runner`, which has no network
and does not receive the `.env` file.

Settings worth knowing:

| Variable         | Role                                                               | Default |
| ---------------- | ------------------------------------------------------------------ | ------- |
| `ALLOWED_EMAILS` | Who can sign in                                                    | —       |
| `ADMIN_EMAILS`   | Who publishes apps (default: the first allowed address)            | —       |
| `APP_LOCALE`     | Language of the platform's own pages and messages (`en`, `fr`)     | `en`    |
| `APP_TIMEZONE`   | Where the members live: what “today” means for the apps            | `UTC`   |
| `OIDC_NAME`      | What the sign-in button calls the provider (“Sign in with Google”) | —       |
| `DEMO_APP`       | Serves the demo app on `demo.<APPS_DOMAIN>`                        | off     |

The platform's database is `data/socle.db`, each app's is `data/apps/<app>/live.db`. A copy of each is written every
night (`data/backups/` and `data/apps/<app>/backups/`, 14 kept).

## Updates

- Dependabot opens one grouped pull request a week; minor and patch updates are merged automatically once CI passes.
- CI rebuilds the image every night, which also picks up the fixes of the base image.
- The “Known vulnerabilities” job fails as soon as a production dependency has a high or critical advisory.

## License

MIT.
