// The demo app's server functions. Each one runs in the sandbox, inside one
// transaction on the app's own database; `user` is whoever is signed in.
import { fail, mutation, query, v } from '@socle/server';
import { serverText } from '../shared/text.ts';

const MAX_ITEMS = 50;

// `tool` offers a function to the members' AI assistants, at the app's own MCP endpoint.
export const list = query({
  tool: 'Lists the items of the shared list of the demo: `done` is 1 once ticked, `author` is the id of the member who added it.',
  handler: ({ db }) =>
    db.all('SELECT id, label, done, author, photo FROM items ORDER BY done, id DESC LIMIT ?', MAX_ITEMS),
});

export const add = mutation({
  tool: 'Adds an item to the shared list of the demo. The other members get a notification.',
  input: v.object({
    label: v.string().min(1).max(80).describe('The item to add, 80 characters at most'),
    photo: v.string().max(32).optional().describe('The id of a photo sent from the app, if the item has one'),
  }),
  handler: ({ db, user, now, notify, locale }, { label, photo }) => {
    const say = serverText(locale);
    const text = label.trim();
    if (!text) fail(say.empty);
    const { n } = db.get('SELECT COUNT(*) AS n FROM items');
    if (n >= MAX_ITEMS) fail(say.full);
    const { lastInsertRowid } = db.run(
      'INSERT INTO items (label, author, created_at, photo) VALUES (?, ?, ?, ?)',
      text,
      user.id,
      now,
      photo ?? null,
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
  handler: ({ db, files }, { id }) => {
    // The photo goes with its item: the platform deletes the file once this has succeeded.
    const item = db.get('SELECT photo FROM items WHERE id = ?', id);
    if (item?.photo) files.remove(item.photo);
    return db.run('DELETE FROM items WHERE id = ?', id).changes;
  },
});
