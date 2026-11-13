import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { siteOf } from '../src/apps/slug.ts';
import { FILE_LIMITS, recognise } from '../src/files/store.ts';
import { DEFAULT_LIMITS } from '../src/runner/limits.ts';
import { ALICE, BOB, Browser, CONTROL, DEMO, setup, signIn, type TestContext } from './helpers.ts';

// Photos and documents members add to an app.

const LIVE = 'https://album.apps.test';
const DRAFT = 'https://album--draft.apps.test';
const TEST_LIMITS = { ...DEFAULT_LIMITS, callMs: 1_500, killGraceMs: 300 };

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 2, 3, 4, 5]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n');
const text = (value: string) => new TextEncoder().encode(value);

const album = () => ({
  'app.json': JSON.stringify({ name: 'Album' }),
  'web/main.tsx': 'export default function App() { return null; }',
  'migrations/001_init.sql': 'CREATE TABLE photos (id INTEGER PRIMARY KEY, file TEXT NOT NULL);',
  'server/index.ts': `
    import { mutation, query, v } from '@socle/server';
    export const list = query(({ db }) => db.all('SELECT file FROM photos ORDER BY id').map((row) => row.file));
    export const keep = mutation({
      input: v.object({ file: v.string() }),
      handler: ({ db }, { file }) => db.run('INSERT INTO photos (file) VALUES (?)', file).lastInsertRowid,
    });
    export const forget = mutation({
      input: v.object({ file: v.string(), fail: v.boolean().optional() }),
      handler: ({ db, files }, { file, fail }) => {
        db.run('DELETE FROM photos WHERE file = ?', file);
        files.remove(file);
        if (fail) throw new Error('changed my mind');
      },
    });`,
});

describe('files of an app', () => {
  let ctx: TestContext;
  let bob: Browser;
  let alice: Browser;
  let bobId: number;

  before(async () => {
    ctx = setup({ limits: TEST_LIMITS });
    bob = new Browser(ctx.app);
    alice = new Browser(ctx.app);
    bobId = signIn(ctx, bob, BOB).userId;
    signIn(ctx, alice, ALICE);
    ctx.deps.apps.create('album', { name: 'Album', description: '' }, { id: bobId });
    assert.ok((await ctx.deps.apps.saveDraft('album', album(), { id: bobId })).ok);
    assert.ok((await ctx.deps.apps.publishDraft('album', ctx.deps.apps.status('album')!.draft.versionId)).ok);
    for (const browser of [bob, alice]) {
      await browser.navigate(`${LIVE}/`);
      await browser.navigate(`${DRAFT}/`);
    }
    await bob.navigate(`${DEMO}/`);
  });
  after(() => ctx.cleanup());

  const upload = (browser: Browser, origin: string, bytes: Uint8Array, pageOrigin = origin) =>
    browser.request(`${origin}/_socle/api/files`, {
      method: 'POST',
      headers: {
        origin: pageOrigin,
        'sec-fetch-site': pageOrigin === origin ? 'same-origin' : 'same-site',
        'content-type': 'image/png',
      },
      body: bytes as unknown as string,
    });
  const stored = async (response: Response) => {
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()) as { id: string; type: string; bytes: number; url: string };
  };
  const fetchFile = (browser: Browser, origin: string, id: string) => browser.request(`${origin}/_socle/files/${id}`);
  const call = (origin: string, name: string, input: unknown) =>
    bob.fetch(`${origin}/_socle/api/fn/${name}`, { method: 'POST', json: { input } });

  it('knows what a file is from its first bytes, not from what it is called', () => {
    assert.equal(recognise(JPEG), 'image/jpeg');
    assert.equal(recognise(PNG), 'image/png');
    assert.equal(recognise(PDF), 'application/pdf');
    assert.equal(recognise(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), 'image/gif');
    assert.equal(recognise(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), 'image/webp');
    for (const other of ['<svg xmlns="http://www.w3.org/2000/svg"/>', '<!doctype html><script>1</script>', 'GIF', '']) {
      assert.equal(recognise(text(other)), null, other);
    }
  });

  it('keeps a photo a member sends and shows it to the members of that app, under the type it recognised', async () => {
    const photo = await stored(await upload(bob, LIVE, JPEG));
    assert.match(photo.id, /^[0-9a-f]{32}$/);
    assert.deepEqual(
      { ...photo, id: '' },
      { id: '', type: 'image/jpeg', bytes: JPEG.length, url: `/_socle/files/${photo.id}` },
    );
    const shown = await fetchFile(alice, LIVE, photo.id);
    assert.equal(shown.status, 200);
    assert.equal(shown.headers.get('content-type'), 'image/jpeg'); // not the image/png the request claimed
    assert.equal(shown.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.equal(shown.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(shown.headers.get('content-disposition'), null);
    assert.deepEqual(new Uint8Array(await shown.arrayBuffer()), JPEG);
    // A document is handed over as a download, never opened in the app's origin.
    const pdf = await stored(await upload(bob, LIVE, PDF));
    assert.equal((await fetchFile(bob, LIVE, pdf.id)).headers.get('content-disposition'), 'attachment');
  });

  it('shows a file to nobody else: no session, another app, the app’s other address, a member without access', async () => {
    const photo = await stored(await upload(bob, LIVE, PNG));
    assert.equal((await fetchFile(new Browser(ctx.app), LIVE, photo.id)).status, 401);
    assert.equal((await fetchFile(bob, DEMO, photo.id)).status, 404);
    assert.equal((await fetchFile(bob, DRAFT, photo.id)).status, 404);
    assert.equal((await fetchFile(bob, LIVE, 'f'.repeat(32))).status, 404);
    assert.equal((await fetchFile(bob, LIVE, '..%2f..%2fsocle.db')).status, 404);
    ctx.deps.apps.setAccess('album', [BOB]);
    assert.equal((await fetchFile(alice, LIVE, photo.id)).status, 401);
    assert.equal((await upload(alice, LIVE, PNG)).status, 401);
    ctx.deps.apps.setAccess('album', null);
    assert.equal((await fetchFile(alice, LIVE, photo.id)).status, 200);
  });

  it('refuses what it does not keep, what is too large, and what does not come from the app’s own pages', async () => {
    for (const body of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<html>',
      'plain text',
    ]) {
      const refused = await upload(bob, LIVE, text(body));
      assert.equal(refused.status, 415, body);
    }
    assert.equal((await upload(bob, LIVE, new Uint8Array(0))).status, 415);
    const large = new Uint8Array(FILE_LIMITS.maxBytes + 1);
    large.set(JPEG);
    assert.equal((await upload(bob, LIVE, large)).status, 413);
    // A page of the draft, or of another app, cannot add files to the published app.
    assert.equal((await upload(bob, LIVE, JPEG, DRAFT)).status, 403);
    assert.equal((await upload(bob, LIVE, JPEG, DEMO)).status, 403);
    assert.equal((await new Browser(ctx.app).request(`${LIVE}/_socle/api/files`, { method: 'POST' })).status, 401);
  });

  it('stops when an app holds as much as it may', async () => {
    const before = { ...FILE_LIMITS };
    const held = ctx.deps.files.usage(siteOf('album', false));
    Object.assign(FILE_LIMITS, { siteFiles: held.files + 1 });
    try {
      await stored(await upload(bob, LIVE, JPEG));
      const full = await upload(bob, LIVE, JPEG);
      assert.equal(full.status, 507);
      assert.equal(((await full.json()) as { error: string }).error, 'full');
      Object.assign(FILE_LIMITS, { siteFiles: before.siteFiles, siteBytes: held.bytes + JPEG.length + 1 });
      assert.equal((await upload(bob, LIVE, JPEG)).status, 507);
    } finally {
      Object.assign(FILE_LIMITS, before);
    }
  });

  it('lets a function delete a file of its app once it has succeeded, and only then', async () => {
    const photo = await stored(await upload(bob, LIVE, JPEG));
    assert.equal((await call(LIVE, 'keep', { file: photo.id })).status, 200);
    // A mutation that fails deleted nothing: its row is back, so is its file.
    assert.equal((await call(LIVE, 'forget', { file: photo.id, fail: true })).status, 500);
    assert.equal((await fetchFile(bob, LIVE, photo.id)).status, 200);
    assert.equal((await call(LIVE, 'forget', { file: photo.id })).status, 200);
    assert.equal((await fetchFile(bob, LIVE, photo.id)).status, 404);
    // Not the files of the app's other address, whatever id it is given; and an id is an id.
    const other = await stored(await upload(bob, DRAFT, JPEG));
    assert.equal((await call(LIVE, 'forget', { file: other.id })).status, 200);
    assert.equal((await fetchFile(bob, DRAFT, other.id)).status, 200);
    assert.equal((await call(LIVE, 'forget', { file: '../../socle.db' })).status, 500);
  });

  it('lets a draft’s files go with the draft’s data, and an app’s with the app', async () => {
    const draftPhoto = await stored(await upload(bob, DRAFT, JPEG));
    const livePhoto = await stored(await upload(bob, LIVE, JPEG));
    assert.ok((await ctx.deps.apps.saveDraft('album', album(), { id: bobId }, { resetData: true })).ok);
    assert.equal((await fetchFile(bob, DRAFT, draftPhoto.id)).status, 404);
    assert.equal((await fetchFile(bob, LIVE, livePhoto.id)).status, 200);

    const removed = await bob.request(`${CONTROL}/admin/apps/album/remove`, {
      method: 'POST',
      headers: { origin: CONTROL },
    });
    assert.equal(removed.status, 303);
    assert.equal(ctx.deps.files.usage(siteOf('album', false)).files, 0);
    const root = path.join(ctx.deps.config.dataDir, 'files');
    assert.equal(existsSync(path.join(root, 'album')), false);
    // Set aside like the app's data: there for a month, then gone.
    const aside = readdirSync(path.join(root, '.removed'));
    assert.equal(aside.length, 1);
    assert.match(aside[0]!, /^album-\d{4}-/);
    ctx.deps.files.purge(Date.now() + 29 * 24 * 3600 * 1000);
    assert.equal(readdirSync(path.join(root, '.removed')).length, 1);
    ctx.deps.files.purge(Date.now() + 32 * 24 * 3600 * 1000);
    assert.deepEqual(readdirSync(path.join(root, '.removed')), []);
  });
});
