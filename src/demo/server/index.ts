// The demo app's server functions. Each one runs in the sandbox, inside one
// transaction on the app's own database; `user` is whoever is signed in.
import { fail, mutation, query, v } from '@socle/server';
import { serverText } from '../shared/text.ts';

const MAX_ITEMS = 50;

export const list = query(({ db }) =>
  db.all('SELECT id, label, done, author FROM items ORDER BY done, id DESC LIMIT ?', MAX_ITEMS),
);

export const add = mutation({
  input: v.object({ label: v.string().min(1).max(80) }),
  handler: ({ db, user, now, notify, locale }, { label }) => {
    const say = serverText(locale);
    const text = label.trim();
    if (!text) fail(say.empty);
    const { n } = db.get('SELECT COUNT(*) AS n FROM items');
    if (n >= MAX_ITEMS) fail(say.full);
    const { lastInsertRowid } = db.run(
      'INSERT INTO items (label, author, created_at) VALUES (?, ?, ?)',
      text,
      user.id,
      now,
    );
    notify('others', { title: say.added(user.name, text), body: say.sharedList, url: '/' });
    return { id: lastInsertRowid };
  },
});

export const toggle = mutation({
  input: v.object({ id: v.int() }),
  handler: ({ db }, { id }) => db.run('UPDATE items SET done = 1 - done WHERE id = ?', id).changes,
});

export const remove = mutation({
  input: v.object({ id: v.int() }),
  handler: ({ db }, { id }) => db.run('DELETE FROM items WHERE id = ?', id).changes,
});
