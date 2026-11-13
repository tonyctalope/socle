// What an agent needs to know to write an app. Returned by the builder's `read_guide` tool:
// keep it exact (it is checked against the kit by test/mcp.test.ts) and short.

export const GUIDE = `# Writing an app for this platform

An app is a set of text files. It installs nothing: no package.json, no npm package, no build step of its own.
The platform provides sign-in, the HTML page, the database, notifications and the install on the Home Screen.

## Files

- \`app.json\` (required): \`{ "name": "…", "description": "…", "themeColor": "#rrggbb", "backgroundColor": "#rrggbb" }\`.
  The name (40 characters at most) is what people see on their Home Screen. Colors are optional.
- \`icon.svg\` (optional): the app's icon on the Home Screen and in notifications, as one square SVG picture
  (\`viewBox="0 0 100 100"\` for instance). Draw shapes and paths that fill the square; no text (no font is
  available), no external or embedded bitmap image. Without it the app gets the platform's icon.
- \`web/main.tsx\` (required): the screens. Its default export is the root React component; the platform mounts it.
  Other files go in \`web/\` (\`.tsx\`, \`.ts\`, \`.css\`, \`.svg\`…). Optional \`web/style.css\` for Tailwind \`@theme\` additions.
- \`server/index.ts\`: the server functions (see below). Other files go in \`server/\`.
- \`migrations/NNN_name.sql\`: the database schema. Each file runs once, in name order (001_init.sql, 002_….sql).
  Never edit or delete a migration that was already applied: add a new one (the save is refused otherwise).
  In a draft you may rewrite or remove one that is not published yet and pass \`reset_draft_data: true\` to
  \`write_files\`; the published data cannot be reset, so a published migration stays as it is for good.
- \`shared/\`: code both sides import (types, constants).

Limits: 300 files, 512 KiB per file, 3 MiB in total, lines of 5000 characters at most.

## Imports

Screens may import \`react\`, \`react-dom\`, \`@socle/sdk\`, \`@socle/ui\`, and the app's own files in \`web/\` and \`shared/\`
(relative paths with their extension: \`./List.tsx\`, \`../shared/types.ts\`). Server files may import \`@socle/server\`
and the app's own files in \`server/\` and \`shared/\`. Anything else is a build error: there is no fetch to other
sites, no Node API, no third-party library. Write what you need.

## Server functions (\`server/index.ts\`)

\`\`\`ts
import { fail, mutation, query, v } from '@socle/server';

export const list = query(({ db }) => db.all('SELECT id, label, done FROM items ORDER BY id'));

export const add = mutation({
  input: v.object({ label: v.string().min(1).max(80) }),
  handler: ({ db, user, notify }, { label }) => {
    const { lastInsertRowid } = db.run('INSERT INTO items (label, author) VALUES (?, ?)', label, user.id);
    notify('others', { title: \`\${user.name} added \${label}\`, url: '/' });
    return lastInsertRowid;
  },
});
\`\`\`

- \`query\` reads and cannot write; \`mutation\` runs in one transaction, undone entirely if it throws.
- Every exported \`query\`/\`mutation\` of \`server/index.ts\` is callable by the screens under its export name.
- The handler gets \`{ db, user, members, now, today, time, locale, notify }\` and the input.
  \`user\` and \`members\` are \`{ id: number, name: string }\` (no e-mail address; store \`user.id\` in an INTEGER
  column, and look names up in \`members\` rather than copying them); \`now\` is epoch milliseconds; \`today\` is
  YYYY-MM-DD and \`time\` HH:MM (24 hours) in the instance's timezone; \`locale\` is the instance's language
  ("en", "fr"…).
- \`db.all<Row>(sql, ...params)\` → rows, \`db.get<Row>(sql, ...params)\` → first row or null, \`db.run(sql, ...params)\` →
  \`{ changes, lastInsertRowid }\`. Parameters are positional (\`?\`) or one object of named ones (\`:name\`). Always
  use parameters, never build SQL from input.
- Input is checked before the handler runs: \`v.string()\`, \`v.number()\`, \`v.int()\`, \`v.boolean()\`, \`v.any()\`,
  \`v.enum(['a', 'b'])\`, \`v.array(item)\`, \`v.object({ … })\`, \`v.union(a, b)\`, each with \`.min()\`, \`.max()\`,
  \`.date()\` (YYYY-MM-DD text), \`.optional()\`, \`.nullable()\`, \`.describe('…')\`.
- \`fail('message for the person', 'optional_code')\` stops the function; the screen receives the message.
- \`notify(to, { title, body?, url? })\`: \`to\` is a member id, a list of ids, \`'others'\` or \`'all'\`. Sent once the
  mutation succeeded. \`url\` is a path of the app.
- \`tool: 'what it does, for an agent'\` (10 to 1000 characters, next to \`input\` and \`handler\`) offers the function
  to the members' own AI assistants: once the app is published, its tools are served by an MCP endpoint of its own
  (\`mcp_url\` in \`list_apps\`) that a member connects like this builder. Mark the few functions that make sense
  in a conversation ("add milk to the list", "what is due this week?"), give each input a \`.describe()\`, and
  return what an assistant needs to answer. A tool's input is \`v.object({ … })\` or nothing.
- \`schedule({ every: 'day', at: '08:00', handler })\` (import it from \`@socle/server\` like \`query\`) is a function
  the platform runs by itself, once published: \`{ every: 'hour' }\`, \`{ every: 'day', at: 'HH:MM' }\` or
  \`{ every: 'week', on: 'monday', at: 'HH:MM' }\`, in the instance's timezone. It is a mutation with no input and
  no caller (\`user\` is null; \`notify('all', …)\` reaches everyone): reminders, recurring entries, clean-up. An
  occurrence missed while the platform was down runs once afterwards, so write it to be safe to run late (decide
  from \`today\` and what the database holds, not from "it is 08:00"). Screens cannot call it; \`call_function\`
  can, on the draft, to test it. Ten per app at most.
- Photos and documents: a screen sends the file to the platform and gets an id (see \`files\` below); pass the id
  to a mutation and store it in a TEXT column. \`files.remove(id)\` in the handler's context deletes the file once
  the mutation has succeeded: call it when the row that names the file goes.
- \`console.log\` lines go to the app's log (\`read_logs\`).
- A function has a couple of seconds, a bounded memory, and nothing but its database: no network, no files, no
  timers, no state kept between calls, no \`Intl\`. Dates: use \`now\`/\`today\`/\`time\` from the context (keep the local
  day next to a timestamp when you will need it later: a function cannot convert between timezones).

SQL is SQLite. The app sees only its own tables. Not available: PRAGMA, ATTACH, transaction statements,
temporary tables, virtual tables (no full-text search), \`INSERT OR ROLLBACK\`. Schema changes only in migrations.
Table names must not start with \`_socle_\`. Store dates as ISO text or epoch numbers, booleans as 0/1.

## Screens (\`web/main.tsx\`)

\`\`\`tsx
import { useState } from 'react';
import { api, useQuery } from '@socle/sdk';
import { Button, Empty, ErrorNote, Input, List, ListItem, Page, Spinner } from '@socle/ui';

export default function App() {
  const items = useQuery<{ id: number; label: string }[]>('list');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = () => api.add({ label }).then(() => setLabel(''), (failure: Error) => setError(failure.message));
  return (
    <Page title="Groceries">
      <form onSubmit={(event) => { event.preventDefault(); void add(); }} className="flex gap-2">
        <Input value={label} onChange={(event) => setLabel(event.target.value)} />
        <Button type="submit">Add</Button>
      </form>
      <ErrorNote>{error ?? items.error?.message}</ErrorNote>
      {items.loading ? <Spinner /> : !items.data?.length ? <Empty title="Nothing yet" /> : (
        <List>{items.data.map((item) => <ListItem key={item.id}>{item.label}</ListItem>)}</List>
      )}
    </Page>
  );
}
\`\`\`

\`@socle/sdk\`:
- \`useQuery<T>(name, input?, { enabled? })\` → \`{ data, loading, error }\`. It refetches by itself after any
  successful mutation of the app, on every open phone: screens stay in sync without any code.
- \`api.<name>(input)\` calls any function and returns a promise of its result; it rejects with an \`ApiError\`
  (\`message\`, \`code\`, \`status\`).
- \`files.uploadImage(file)\` → \`{ id, url, type, bytes }\` sends a photo picked from the camera or the gallery,
  made smaller first; \`files.upload(file)\` sends a file as it is (JPEG, PNG, WebP, GIF or PDF, 8 MB at most);
  \`files.url(id)\` is its address, for \`<img src>\` or a link. Files are kept per app and only its members see them.
- \`useMe()\` → \`{ user, app: { slug, name }, members }\` (ids are numbers); \`logout()\`; \`locale\`; \`words({ en: {…}, fr: {…} })\` picks texts for the
  instance's language; \`timezone\` (the instance's, e.g. "Europe/Paris": give it as \`timeZone\` when formatting a
  date, so that every phone shows the day the server counts); \`install.standalone()\`; \`usePush()\` / \`push\` for notification settings.

\`@socle/ui\` (use these first: they follow light and dark mode and feel like the other apps):
\`Page({ title, back?, actions?, children })\`, \`Card({ title?, children })\`,
\`Button({ variant?: 'primary' | 'secondary' | 'ghost' | 'danger', small?, …button props })\`,
\`Field({ label, hint?, error?, children })\`, \`Input\`, \`Textarea\`, \`Select\`, \`Checkbox({ label, … })\`,
\`List\`, \`ListItem({ end?, onClick?, children })\`, \`Badge({ tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' })\`,
\`Empty({ title, children? })\`, \`Spinner({ label? })\`, \`ErrorNote\`, \`Avatar({ name })\`,
\`PhotoButton({ onPhoto, children? })\` (takes or picks a photo and sends it; \`onPhoto\` gets \`{ id, url }\`),
\`Photo({ id, alt?, className? })\` (shows one from its id),
\`NotificationSettings()\` (a ready-made card, titled, to turn notifications on: place it as it is, not inside
a \`Card\`; every app that notifies needs it somewhere),
\`LogoutButton()\`.

Styling is Tailwind CSS 4 classes. Use the platform's colors so that dark mode works: \`bg-bg\`, \`bg-card\`,
\`text-ink\`, \`text-muted\`, \`border-line\`, \`bg-accent\`, \`text-accent\`, \`text-accent-ink\`, \`text-danger\`, \`text-ok\`,
\`text-warn\`. Design for a phone first: one column, large touch targets.

The platform writes the HTML document; an app never writes \`<html>\`, \`<head>\` or a \`<script>\` tag. Every path of
the app's address shows the app: use \`location.pathname\` and \`history.pushState\` if you want several URLs, or
plain React state. Pages cannot call other websites or load remote scripts, images or fonts: put assets in \`web/\`.

## Working on an app

1. \`list_apps\`, then \`read_files\` to see what exists. A new app: \`create_app\`.
2. \`write_files\` saves your changes to the app's **draft** and builds it. Fix the problems it reports until it
   builds. The draft has its own address and its own database: nothing changes for the people using the app.
3. \`call_function\` runs a function of the draft so that you can check your server code; \`read_logs\` shows what
   functions printed and how they failed.
4. Give the person the draft's address to try it. You cannot publish: an administrator does, from the
   administration page whose address \`write_files\` returns. Say so, and what the publication will change.

Write the app's texts in the language of the people who use it (the instance's language is in \`list_apps\`).
`;
