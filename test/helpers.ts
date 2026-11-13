import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Hono } from 'hono';
import { createApp } from '../src/app.ts';
import { LiveHub } from '../src/apphost/live.ts';
import type { VendorAsset } from '../src/apphost/vendor.ts';
import { AppStore } from '../src/apps/store.ts';
import { wireApps } from '../src/apps/wiring.ts';
import { FileStore } from '../src/files/store.ts';
import type { IdentityProvider } from '../src/auth/oidc.ts';
import { CONTROL_SCOPE, createSession } from '../src/auth/sessions.ts';
import { upsertUser } from '../src/auth/users.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { openDatabase, run } from '../src/db/database.ts';
import type { PushMessage, PushService } from '../src/push/push.ts';
import { localRunner } from '../src/runner/client.ts';
import { DEFAULT_LIMITS, type Limits } from '../src/runner/limits.ts';
import type { Deps } from '../src/types.ts';

// The access log and login lines would drown the test report.
console.info = () => {};
console.warn = () => {};

export const BOB = 'bob@example.com';
export const ALICE = 'alice@example.org';
export const STRANGER = 'mallory@example.net';

export const CONTROL = 'https://socle.test';
/** The built-in demo app. */
export const DEMO = 'https://demo.apps.test';
/** A second app, to check that nothing crosses from one app to another. */
export const NOTES = 'https://notes.apps.test';

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    CONTROL_URL: CONTROL,
    APPS_DOMAIN: 'apps.test',
    ALLOWED_EMAILS: `${BOB}, ${ALICE}`,
    OIDC_ISSUER: 'https://accounts.example.com',
    OIDC_CLIENT_ID: 'socle-client',
    OIDC_CLIENT_SECRET: 'socle-secret',
    DEMO_APP: '1',
    ...env,
  });
}

export class FakePush implements PushService {
  readonly publicKey = 'BFakePublicKey';
  readonly sent: { userId: number; app: string; message: PushMessage }[] = [];
  async sendToUser(userId: number, app: string, message: PushMessage): Promise<number> {
    this.sent.push({ userId, app, message });
    return 1;
  }
}

export const unusedIdentity: IdentityProvider = {
  start: () => Promise.reject(new Error('identity provider not available in this test')),
  finish: () => Promise.reject(new Error('identity provider not available in this test')),
};

/** Stands in for the files the runner builds once for every app (React, the SDK, the UI kit). */
const fakeVendor = {
  async get(name: string): Promise<VendorAsset | undefined> {
    if (name !== 'sdk.js') return undefined;
    return { body: new TextEncoder().encode('export {};'), type: 'text/javascript; charset=utf-8', etag: '"test"' };
  },
  warm: () => Promise.resolve(),
};

export interface TestContext {
  deps: Deps;
  app: Hono;
  push: FakePush;
  clock: { now: Date };
  /** URL prefix of the demo app's published files, e.g. "/assets/0123456789abcdef". */
  assets: string;
  cleanup: () => void;
}

/** Publishes a version without building anything: enough for everything that is not about the build. */
export function publishFake(apps: AppStore, slug: string, name: string): void {
  apps.publish(
    slug,
    { 'app.json': JSON.stringify({ name }), 'web/main.tsx': 'export default () => null;' },
    {
      manifest: { name, description: '', themeColor: null, backgroundColor: null },
      web: { js: `console.log(${JSON.stringify(slug)});`, css: 'body{}' },
      server: null,
      migrations: [],
    },
    null,
  );
}

export function setup(
  options: { env?: Record<string, string>; identity?: IdentityProvider; limits?: Limits } = {},
): TestContext {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'socle-test-'));
  const config = testConfig({ DATA_DIR: dataDir, ...options.env });
  const db = openDatabase(':memory:');
  // Worker processes only start if a test builds an app or calls a function.
  const runner = localRunner({ appsDir: path.join(dataDir, 'apps'), limits: options.limits ?? DEFAULT_LIMITS });
  const apps = new AppStore(db, runner);
  const live = new LiveHub();
  const files = new FileStore(db, dataDir);
  wireApps(apps, live, files);
  publishFake(apps, 'demo', 'Demo');
  // A second app, registered but without a published version.
  run(db, `INSERT INTO apps (slug, name, created_at) VALUES ('notes', 'Notes', :now)`, {
    now: new Date().toISOString(),
  });
  const push = new FakePush();
  const clock = { now: new Date() };
  const deps: Deps = {
    config,
    db,
    identity: options.identity ?? unusedIdentity,
    push,
    runner,
    apps,
    files,
    live,
    vendor: fakeVendor,
    now: () => clock.now,
  };
  return {
    deps,
    app: createApp(deps),
    push,
    clock,
    assets: `/assets/${apps.live('demo')!.assetHash}`,
    cleanup: () => {
      live.closeAll();
      db.close();
      void runner.close().finally(() => rmSync(dataDir, { recursive: true, force: true }));
    },
  };
}

/** What a browser keeps from one Set-Cookie header. */
interface StoredCookie {
  value: string;
  attributes: string;
}

/**
 * A minimal browser: one cookie jar per host (cookies are host-only, as `__Host-`
 * cookies always are), navigations that follow redirects from host to host, and
 * fetches that carry the page's Origin.
 */
export class Browser {
  readonly app: Hono;
  /** Every Set-Cookie header received, to assert on attributes. */
  readonly setCookies: string[] = [];
  /** Requests for these origins go to the network instead of the app (the fake sign-in provider). */
  readonly external: string[] = [];
  private readonly jars = new Map<string, Map<string, StoredCookie>>();

  constructor(app: Hono) {
    this.app = app;
  }

  private jar(host: string): Map<string, StoredCookie> {
    let jar = this.jars.get(host);
    if (!jar) {
      jar = new Map();
      this.jars.set(host, jar);
    }
    return jar;
  }

  cookie(origin: string, name: string): string | undefined {
    return this.jar(new URL(origin).host).get(name)?.value;
  }

  setCookie(origin: string, name: string, value: string): void {
    this.jar(new URL(origin).host).set(name, { value, attributes: '' });
  }

  deleteCookie(origin: string, name: string): void {
    this.jar(new URL(origin).host).delete(name);
  }

  async request(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string | ReadableStream<Uint8Array> } = {},
  ) {
    const target = new URL(url);
    const cookies = [...this.jar(target.host)].map(([name, cookie]) => `${name}=${cookie.value}`).join('; ');
    const headers = { ...(cookies ? { cookie: cookies } : {}), ...init.headers };
    const response = this.external.includes(target.origin)
      ? await fetch(target, { method: init.method, headers, body: init.body as string, redirect: 'manual' })
      : await this.app.request(target.href, {
          method: init.method,
          headers,
          body: init.body,
          // A body sent as it comes, without saying how long it will be.
          ...(init.body instanceof ReadableStream ? { duplex: 'half' } : {}),
        } as RequestInit);
    for (const header of response.headers.getSetCookie()) {
      this.setCookies.push(header);
      const [pair = '', ...attributes] = header.split(';');
      const name = pair.slice(0, pair.indexOf('=')).trim();
      const value = pair.slice(pair.indexOf('=') + 1);
      if (/max-age=0/i.test(header) || value === '') this.jar(target.host).delete(name);
      else this.jar(target.host).set(name, { value, attributes: attributes.join(';') });
    }
    return response;
  }

  /** Types a URL in the address bar and follows redirects; returns the final response and every URL visited. */
  async navigate(url: string, maxHops = 12): Promise<{ response: Response; url: string; hops: string[] }> {
    const hops = [url];
    let current = url;
    for (let hop = 0; hop < maxHops; hop++) {
      const response = await this.request(current, {
        headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
      });
      const location = response.headers.get('location');
      if (response.status < 300 || response.status >= 400 || !location) return { response, url: current, hops };
      current = new URL(location, current).href;
      hops.push(current);
    }
    throw new Error(`too many redirects: ${hops.join(' → ')}`);
  }

  /** A fetch() made by a page of `pageOrigin` (same-origin by default). */
  fetch(
    url: string,
    init: { method?: string; json?: unknown; pageOrigin?: string; headers?: Record<string, string> } = {},
  ) {
    const method = init.method ?? 'GET';
    const pageOrigin = init.pageOrigin ?? new URL(url).origin;
    const sameOrigin = pageOrigin === new URL(url).origin;
    return this.request(url, {
      method,
      headers: {
        accept: 'application/json',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': sameOrigin ? 'same-origin' : 'same-site',
        ...(method === 'GET' && sameOrigin ? {} : { origin: pageOrigin }),
        ...(init.json === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    });
  }
}

/** Signs a user in on the control plane without going through the sign-in provider. */
export function signIn(ctx: TestContext, browser: Browser, email: string): { userId: number; family: string } {
  const user = upsertUser(ctx.deps.db, { sub: `sub-${email}`, email, name: email.split('@')[0]! });
  const family = `family-${randomBytes(6).toString('hex')}`;
  const { token } = createSession(ctx.deps.db, { userId: user.id, scope: CONTROL_SCOPE, family, userAgent: 'test' });
  browser.setCookie(CONTROL, '__Host-socle_session', token);
  return { userId: user.id, family };
}

/** A push subscription as a browser would send it. */
export function subscription(host = 'fcm.googleapis.com') {
  return {
    endpoint: `https://${host}/fcm/send/${randomBytes(12).toString('hex')}`,
    keys: { p256dh: randomBytes(65).toString('base64url'), auth: randomBytes(16).toString('base64url') },
  };
}
