import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { WebPushError } from 'web-push';
import { all, get } from '../src/db/database.ts';
import { pathToOpen } from '../src/kit/sdk/navigate.ts';
import { createPushService, saveSubscription } from '../src/push/push.ts';
import { Browser, DEMO, NOTES, setup, signIn, subscription, BOB } from './helpers.ts';

describe('push subscriptions', () => {
  it('belong to one user on one app', async () => {
    const ctx = setup();
    const browser = new Browser(ctx.app);
    const { userId } = signIn(ctx, browser, BOB);
    await browser.navigate(`${DEMO}/`);
    await browser.navigate(`${NOTES}/`);

    const url = `${DEMO}/_socle/api/push/subscriptions`;
    const mine = subscription();
    assert.equal((await browser.fetch(url, { method: 'POST', json: mine })).status, 204);
    assert.equal((await browser.fetch(url, { method: 'POST', json: mine })).status, 204); // idempotent
    const count = async (origin: string) =>
      ((await (await browser.fetch(`${origin}/_socle/api/me`)).json()) as { push: { subscriptions: number } }).push
        .subscriptions;
    assert.equal(await count(DEMO), 1);
    assert.equal(await count(NOTES), 0);

    const test = await browser.fetch(`${DEMO}/_socle/api/push/test`, { method: 'POST' });
    assert.deepEqual(await test.json(), { sent: 1 });
    assert.equal(ctx.push.sent.length, 1);
    assert.equal(ctx.push.sent[0]!.userId, userId);
    assert.equal(ctx.push.sent[0]!.app, 'demo');
    assert.equal(ctx.push.sent[0]!.message.url, '/');

    // Another app cannot remove it; its own app can.
    const remove = (origin: string) =>
      browser.fetch(`${origin}/_socle/api/push/subscriptions`, { method: 'DELETE', json: { endpoint: mine.endpoint } });
    assert.equal((await remove(NOTES)).status, 204);
    assert.equal(await count(DEMO), 1);
    assert.equal((await remove(DEMO)).status, 204);
    assert.equal(await count(DEMO), 0);
    ctx.cleanup();
  });

  it('refuses endpoints that are not a browser push service, and malformed bodies', async () => {
    const ctx = setup();
    const browser = new Browser(ctx.app);
    signIn(ctx, browser, BOB);
    await browser.navigate(`${DEMO}/`);
    const url = `${DEMO}/_socle/api/push/subscriptions`;
    const post = (json: unknown) => browser.fetch(url, { method: 'POST', json });
    assert.equal((await post(subscription('internal.example'))).status, 400); // would make the server call any URL
    assert.equal((await post(subscription('fcm.googleapis.com.evil.example'))).status, 400);
    assert.equal((await post({ ...subscription(), endpoint: 'http://fcm.googleapis.com/x' })).status, 400);
    assert.equal((await post({ endpoint: subscription().endpoint })).status, 400);
    assert.equal((await post({ ...subscription(), keys: { p256dh: 'short', auth: 'short' } })).status, 400);
    assert.equal((await post('not an object')).status, 400);
    const text = await browser.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      json: subscription(),
    });
    assert.equal(text.status, 400); // JSON sent as a "simple" content type is not read
    assert.equal((await post(subscription('updates.push.services.mozilla.com'))).status, 204);
    assert.equal((await post(subscription('web.push.apple.com'))).status, 204);
    ctx.cleanup();
  });

  it('keeps at most ten devices per member and app, and limits how fast they are added', async () => {
    const ctx = setup();
    const browser = new Browser(ctx.app);
    const { userId } = signIn(ctx, browser, BOB);
    await browser.navigate(`${DEMO}/`);
    const url = `${DEMO}/_socle/api/push/subscriptions`;
    const sent = [];
    for (let i = 0; i < 14; i++) {
      const one = subscription();
      sent.push(one.endpoint);
      assert.equal((await browser.fetch(url, { method: 'POST', json: one })).status, 204);
    }
    const kept = all<{ endpoint: string }>(
      ctx.deps.db,
      'SELECT endpoint FROM push_subscriptions WHERE user_id = :user ORDER BY id',
      { user: userId },
    );
    assert.deepEqual(
      kept.map((row) => row.endpoint),
      sent.slice(-10), // the oldest made room
    );
    const statuses = [];
    for (let i = 0; i < 20; i++) {
      statuses.push((await browser.fetch(url, { method: 'POST', json: subscription() })).status);
    }
    assert.deepEqual(statuses, [...Array(16).fill(204), 429, 429, 429, 429]); // 30 per minute
    assert.equal(kept.length, 10);
    ctx.cleanup();
  });

  it('stops notifying a browser once it is signed out, without touching the other devices', async () => {
    const ctx = setup();
    const phone = new Browser(ctx.app);
    const laptop = new Browser(ctx.app);
    for (const browser of [phone, laptop]) {
      signIn(ctx, browser, BOB);
      await browser.navigate(`${DEMO}/`);
      await browser.navigate(`${NOTES}/`);
      for (const origin of [DEMO, NOTES]) {
        const added = await browser.fetch(`${origin}/_socle/api/push/subscriptions`, {
          method: 'POST',
          json: subscription(),
        });
        assert.equal(added.status, 204);
      }
    }
    const count = () => get<{ n: number }>(ctx.deps.db, 'SELECT COUNT(*) AS n FROM push_subscriptions')!.n;
    assert.equal(count(), 4);
    assert.equal((await phone.fetch(`${DEMO}/_socle/api/logout`, { method: 'POST' })).status, 200);
    assert.equal(count(), 2); // the phone's two apps; the laptop keeps its own
    ctx.cleanup();
  });

  it('limits test notifications', async () => {
    const ctx = setup();
    const browser = new Browser(ctx.app);
    signIn(ctx, browser, BOB);
    await browser.navigate(`${DEMO}/`);
    const statuses = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await browser.fetch(`${DEMO}/_socle/api/push/test`, { method: 'POST' })).status);
    }
    assert.deepEqual(statuses, [...Array(10).fill(200), 429, 429]);
    ctx.cleanup();
  });
});

describe('push delivery', () => {
  it('sends to the devices of that user for that app, and forgets dead subscriptions', async () => {
    const ctx = setup();
    const { userId } = signIn(ctx, new Browser(ctx.app), BOB);
    const alive = subscription();
    const gone = subscription();
    const elsewhere = subscription();
    saveSubscription(ctx.deps.db, { userId, app: 'demo', family: 'f1' }, alive, 'phone');
    saveSubscription(ctx.deps.db, { userId, app: 'demo', family: 'f2' }, gone, 'old phone');
    saveSubscription(ctx.deps.db, { userId, app: 'notes', family: 'f1' }, elsewhere, 'phone');

    const calls: { endpoint: string; payload: string; subject: string }[] = [];
    const service = createPushService(ctx.deps.db, ctx.deps.config, async (target, payload, options) => {
      calls.push({ endpoint: target.endpoint, payload: String(payload), subject: options!.vapidDetails!.subject });
      if (target.endpoint === gone.endpoint) throw new WebPushError('gone', 410, {}, '', target.endpoint);
      return { statusCode: 201, body: '', headers: {} };
    });
    const delivered = await service.sendToUser(userId, 'demo', { title: 'T', body: 'B', url: '/x', tag: 't' });

    assert.equal(delivered, 1);
    assert.deepEqual(calls.map((call) => call.endpoint).sort(), [alive.endpoint, gone.endpoint].sort());
    assert.deepEqual(JSON.parse(calls[0]!.payload), { title: 'T', body: 'B', url: '/x', tag: 't' });
    assert.equal(calls[0]!.subject, 'https://socle.test');
    const left = all<{ endpoint: string }>(ctx.deps.db, 'SELECT endpoint FROM push_subscriptions ORDER BY id');
    assert.deepEqual(
      left.map((row) => row.endpoint),
      [alive.endpoint, elsewhere.endpoint],
    );
    assert.match(service.publicKey, /^[A-Za-z0-9_-]{80,100}$/); // generated once, then read back
    assert.equal(createPushService(ctx.deps.db, ctx.deps.config).publicKey, service.publicKey);
    ctx.cleanup();
  });
});

describe('a notification that is tapped', () => {
  it('opens the page it is about in the app that is already open', () => {
    const here = { origin: 'https://demo.apps.test', pathname: '/list', search: '?tab=mine', hash: '' };
    const asked = (url: unknown, type: unknown = 'socle:navigate') => pathToOpen({ type, url }, here);
    assert.equal(asked('/items/42?from=push#top'), '/items/42?from=push#top');
    assert.equal(asked('/'), '/');
    // Already there: nothing to load again.
    assert.equal(asked('/list?tab=mine'), null);
    // Only ever a page of this app, and only that message.
    assert.equal(asked('https://elsewhere.example/items/42'), null);
    assert.equal(asked('//elsewhere.example/items/42'), null);
    assert.equal(asked(42), null);
    assert.equal(asked('/items/42', 'something-else'), null);
    assert.equal(pathToOpen('socle:navigate', here), null);
    assert.equal(pathToOpen(null, here), null);
    // What the worker says is what the page listens to.
    assert.match(readFileSync('src/client/sw.js', 'utf8'), /postMessage\(\{ type: 'socle:navigate', url: path \}\)/);
    assert.match(readFileSync('src/kit/sdk/platform.ts', 'utf8'), /pathToOpen\(event\.data, location\)/);
  });
});
