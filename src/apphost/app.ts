import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { appMembers, canAccess, getApp } from '../apps/registry.ts';
import type { Site } from '../apps/slug.ts';
import { DEFAULT_COLOR, type AppVersion } from '../apps/store.ts';
import { clearAppCookie, readAppCookie, setAppCookie } from '../auth/cookies.ts';
import {
  APP_COOKIE,
  createSession,
  deleteFamily,
  resolveSession,
  SESSION_TTL_MS,
  sessionStillValid,
} from '../auth/sessions.ts';
import { SSO_COOKIE, SSO_STATE_TTL_SEC, takeSsoCode } from '../auth/sso.ts';
import { displayName, getUser } from '../auth/users.ts';
import { appOrigin, appSiteFromHost } from '../config.ts';
import { randomToken } from '../lib/crypto.ts';
import {
  clientIp,
  isNavigation,
  isOwnFetch,
  isSameOrigin,
  isTopLevelNavigation,
  RateLimiter,
  safeNextPath,
} from '../lib/http.ts';
import { APP_CSP, onError, securityHeaders } from '../lib/security.ts';
import { loadStaticFiles, type StaticFile } from '../lib/static.ts';
import { messagePage } from '../pages/layout.ts';
import { countSubscriptions, deleteSubscription, parseSubscription, saveSubscription } from '../push/push.ts';
import type { CallResult } from '../runner/sandbox/call.ts';
import { allowlist, type AppHostEnv, type Deps } from '../types.ts';
import { APP_MCP_PATH, appResource, buildAppServer, toolsOf } from '../mcp/app.ts';
import { mcpCors, mcpEndpoint } from '../mcp/http.ts';
import { protectedResourceMetadata } from '../oauth/metadata.ts';
import { functionCaller } from './calls.ts';
import { appManifest } from './manifest.ts';
import { FILE_LIMITS } from '../files/store.ts';
import { translator } from '../i18n.ts';
import { shellPage } from './shell.ts';

const ICONS = '/_socle/icons';
const SW_PATH = '/_socle/sw.js';
const VENDOR = '/_socle/vendor';
const SIGNED_OUT_PATH = '/_socle/signed-out';
/** A function's input travels as JSON in the request body. */
const MAX_BODY = 300 * 1024;
const FILES = '/_socle/files';
const FILES_API = '/_socle/api/files';
/** Files received at once: by the whole instance, and from one member on one address. */
const MAX_RECEIVING = 6;
const MAX_RECEIVING_EACH = 2;
/** How often an open event stream proves it is alive, and its session still valid. */
const STREAM_PING_MS = 25_000;

/**
 * Everything served on <slug>.<APPS_DOMAIN>. The platform owns /_socle/*; the rest
 * of the path space belongs to the app. Public: what a browser fetches without cookies
 * to install a PWA (icons, manifest, service worker, SDK), and the MCP endpoint of an app
 * that offers tools, which only answers a bearer token (with the one document outside
 * /_socle/ that says where to get it). App files and the API require the session of THIS host.
 */
export function appHostApp(deps: Deps): Hono<AppHostEnv> {
  const { config, db } = deps;
  const isAllowed = allowlist(config);
  const app = new Hono<AppHostEnv>();
  const icons = loadStaticFiles('assets/icons');
  const client = loadStaticFiles('client');
  const loginLimiter = new RateLimiter(60, 60_000);
  const subscribeLimiter = new RateLimiter(30, 60_000);
  const testLimiter = new RateLimiter(10, 60_000);
  const functionLimiter = new RateLimiter(600, 60_000);
  const callFunction = functionCaller(deps);
  const uploadLimiter = new RateLimiter(60, 60_000);
  /** Files being received: each is held in memory until it is written, so only a few are at a time. */
  const receiving = new Map<string, number>();
  let receivingNow = 0;
  const tooLarge = () =>
    t('This file is too large ({limit} MB at most).', { limit: String(FILE_LIMITS.maxBytes / 1024 / 1024) });

  const send = (c: Context, file: StaticFile, headers: Record<string, string> = {}) =>
    c.body(file.body, 200, { 'Content-Type': file.type, 'Cache-Control': 'no-cache', ...headers });
  const problem = (
    c: Context,
    status: 400 | 401 | 403 | 404 | 413 | 415 | 422 | 429 | 500 | 503 | 504 | 507,
    error: string,
    message: string,
  ) => c.json({ error, message }, status);

  const t = translator(config.locale);
  const message = (title: string, text: string, link?: { href: string; label: string }) =>
    messagePage(config.locale, title, text, link, ICONS);
  /** What the browser is told when a function fails for a reason that is not the user's to fix. */
  const APP_ERROR = t('The app ran into an error.');

  app.use('*', securityHeaders(config, APP_CSP));
  // Small bodies everywhere, except where a member sends a file: that route has its own limit,
  // applied once the sender is known (a body without a declared length is read to be measured,
  // and nothing that large is read for a stranger).
  const smallBody = bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.text('Request too large', 413) });
  const fileBody = bodyLimit({
    maxSize: FILE_LIMITS.maxBytes,
    onError: (c) => c.json({ error: 'too_large', message: tooLarge() }, 413),
  });
  app.use('*', (c, next) => (c.req.path === FILES_API && c.req.method === 'POST' ? next() : smallBody(c, next)));

  // Only the platform's own service worker may be registered on an app origin: a worker
  // written by an app could answer page requests itself and drop the headers that confine it.
  app.use('*', async (c, next) => {
    if (c.req.header('service-worker') !== undefined && c.req.path !== SW_PATH) {
      return c.text('Service worker refused', 403);
    }
    await next();
  });

  /** What the address serves now: the draft's last build, or the published version. */
  const servedAt = (site: Site) => deps.apps.serving(site.slug, site.draft ? 'draft' : 'live');
  /** Added to icon addresses: it changes when the app's icon may have. */
  const iconStamp = (site: Site) => {
    const version = servedAt(site);
    return version?.icons ? `?v=${version.id}` : '';
  };

  // Icons are fetched without cookies (to install the app, to show a notification): the app's
  // own when its version has one, the platform's otherwise, and on pages shown for no app.
  app.get(`${ICONS}/:file`, (c) => {
    const name = c.req.param('file');
    const site = appSiteFromHost(config, new URL(c.req.url).host.toLowerCase());
    const own = site ? servedAt(site)?.icons?.get(name) : undefined;
    if (own) return c.body(own, 200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    const file = icons.get(`/${name}`);
    if (!file) return c.text('Not found', 404);
    return send(c, file, { 'Cache-Control': 'public, max-age=86400' });
  });

  app.use('*', async (c, next) => {
    const site = appSiteFromHost(config, new URL(c.req.url).host.toLowerCase());
    const row = site ? getApp(db, site.slug) : undefined;
    if (!site || !row) {
      return c.html(message(t('App not found'), t('There is no app at this address.')), 404);
    }
    // The draft's address shows what the draft's app.json says: a new name or new colors are
    // tried like the rest. Everything else about the app is the app's.
    const card = site.draft ? deps.apps.draft(row.slug)?.manifest : undefined;
    c.set(
      'app',
      card
        ? {
            ...row,
            name: card.name,
            description: card.description,
            theme_color: card.themeColor ?? DEFAULT_COLOR,
            background_color: card.backgroundColor ?? DEFAULT_COLOR,
          }
        : row,
    );
    c.set('site', site);
    await next();
  });

  app.get(SW_PATH, (c) => send(c, client.get('/sw.js')!, { 'Service-Worker-Allowed': '/' }));

  // React, the SDK, the UI kit and the base stylesheet: the same files for every app,
  // revalidated at each load so a platform update reaches every app at once.
  app.get(`${VENDOR}/:file`, async (c) => {
    let asset;
    try {
      asset = await deps.vendor.get(c.req.param('file'));
    } catch (error) {
      console.error('vendor files unavailable:', (error as Error).message);
      return c.text('Indisponible pour le moment', 503, { 'Retry-After': '5' });
    }
    if (!asset) return c.text('Not found', 404);
    const headers = { 'Content-Type': asset.type, 'Cache-Control': 'no-cache', ETag: asset.etag };
    if (c.req.header('if-none-match') === asset.etag) return c.body(null, 304, headers);
    return c.body(asset.body, 200, headers);
  });
  app.get('/_socle/manifest.webmanifest', (c) =>
    c.body(
      JSON.stringify(appManifest(c.get('app'), config.locale, c.get('site').draft, iconStamp(c.get('site')))),
      200,
      {
        'Content-Type': 'application/manifest+json',
        'Cache-Control': 'no-cache',
      },
    ),
  );

  app.use('*', async (c, next) => {
    const token = readAppCookie(c, config, APP_COOKIE);
    const found = token ? resolveSession(db, token, c.get('site').label, isAllowed) : null;
    const session = found && canAccess(found.user, c.get('app')) ? found : null;
    if (token && session?.renewed) setAppCookie(c, config, APP_COOKIE, token, SESSION_TTL_MS / 1000);
    c.set('session', session);
    await next();
  });

  // Sign-on, app side: see src/auth/sso.ts for the whole flow.
  app.get('/_socle/login', (c) => {
    if (!isTopLevelNavigation(c)) return c.text('Navigation expected', 400);
    const next = safeNextPath(c.req.query('next'), 300);
    if (c.get('session')) return c.redirect(next, 302);
    if (!loginLimiter.take(clientIp(c))) {
      return c.html(message(t('Too many attempts'), t('Try again in a minute.')), 429);
    }
    const state = randomToken();
    setAppCookie(c, config, SSO_COOKIE, state, SSO_STATE_TTL_SEC);
    const target = new URL('/sso/start', config.controlOrigin);
    target.searchParams.set('app', c.get('site').label);
    target.searchParams.set('state', state);
    target.searchParams.set('next', next);
    c.header('Cache-Control', 'no-store');
    return c.redirect(target.href, 302);
  });

  app.get('/_socle/sso', (c) => {
    if (!isTopLevelNavigation(c)) return c.text('Navigation expected', 400);
    const state = readAppCookie(c, config, SSO_COOKIE);
    clearAppCookie(c, config, SSO_COOKIE);
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    const grant = takeSsoCode(db, { code: c.req.query('code') ?? '', app: c.get('site').label, state }, deps.now());

    // Another tab finished signing in first (two tabs restored together): the code brings
    // nothing new, it only says where this tab wanted to go.
    const current = c.get('session');
    if (current) return c.redirect(grant?.userId === current.user.id ? grant.nextPath : '/', 303);

    const user = grant?.stateMatches ? getUser(db, grant.userId) : undefined;
    if (!grant || !user || !isAllowed(user.email) || !canAccess(user, c.get('app'))) {
      // Shown instead of redirecting again, so a browser that drops cookies cannot loop.
      return c.html(
        message(t('Sign-in interrupted'), t('The sign-in link expired, or cookies are blocked for this site.'), {
          href: '/_socle/login',
          label: t('Try again'),
        }),
        400,
      );
    }
    const { token } = createSession(db, {
      userId: user.id,
      scope: c.get('site').label,
      family: grant.family,
      userAgent: c.req.header('user-agent') ?? null,
    });
    setAppCookie(c, config, APP_COOKIE, token, SESSION_TTL_MS / 1000);
    return c.redirect(grant.nextPath, 303);
  });

  // Where signing out from an app lands: a page of the app itself. An installed app stays
  // itself (leaving for the control plane would open a browser over it), and signing in
  // again from here comes back to this app.
  app.get(SIGNED_OUT_PATH, (c) => {
    if (c.get('session')) return c.redirect('/', 302);
    c.header('Cache-Control', 'no-store');
    return c.html(
      message(c.get('app').name, t('You are signed out.'), { href: '/_socle/login?next=%2F', label: t('Sign in') }),
    );
  });

  // The app's own MCP endpoint (src/mcp/app.ts): the functions it offers as tools, for the agent
  // of a member. Bearer tokens of the platform's authorization server only, never the session
  // cookie; only the published address has one, and only while the app offers a tool.
  const endpoints = new Map<string, ReturnType<typeof mcpEndpoint>>();
  const endpointOf = (slug: string) => {
    let endpoint = endpoints.get(slug);
    if (!endpoint) {
      endpoint = mcpEndpoint(deps, appResource(config, slug), (caller) => {
        // Read at every request: the app may be gone, or closed to this member, since the token was issued.
        const row = getApp(db, slug);
        if (!row || !canAccess(caller, row)) return null;
        return buildAppServer(deps, row, deps.apps.live(slug), caller, callFunction);
      });
      // One per app that was ever asked for its tools: names come and go, the map does not grow with them.
      if (endpoints.size >= 200) endpoints.clear();
      endpoints.set(slug, endpoint);
    }
    return endpoint;
  };
  const offersTools = (c: Context<AppHostEnv>) =>
    !c.get('site').draft && toolsOf(deps.apps.live(c.get('app').slug)).length > 0;
  app.use(APP_MCP_PATH, mcpCors);
  app.all(APP_MCP_PATH, async (c) => (offersTools(c) ? endpointOf(c.get('app').slug)(c) : c.text('Not found', 404)));
  app.use('/.well-known/oauth-protected-resource/*', mcpCors);
  app.get(`/.well-known/oauth-protected-resource${APP_MCP_PATH}`, (c) =>
    offersTools(c)
      ? c.json(protectedResourceMetadata(config, appResource(config, c.get('app').slug), c.get('app').name))
      : c.text('Not found', 404),
  );

  // From here on, a session of this host is required.
  app.use('*', async (c, next) => {
    if (c.get('session')) return next();
    if (c.req.path.startsWith('/_socle/api/')) return problem(c, 401, 'unauthenticated', t('Sign-in required.'));
    if (isNavigation(c)) {
      const url = new URL(c.req.url);
      const back = safeNextPath(url.pathname + url.search, 300);
      return c.redirect(`/_socle/login?next=${encodeURIComponent(back)}`, 302);
    }
    return c.text('Sign-in required', 401);
  });

  app.use('/_socle/api/*', async (c, next) => {
    const read = c.req.method === 'GET' || c.req.method === 'HEAD';
    const own = read ? isOwnFetch(c) : isSameOrigin(c, appOrigin(config, c.get('site').label));
    if (!own) return problem(c, 403, 'forbidden', t('Unexpected origin.'));
    c.header('Cache-Control', 'no-store');
    await next();
  });

  const target = (c: Context<AppHostEnv>) => ({ userId: c.get('session')!.user.id, app: c.get('site').label });
  const limitKey = (c: Context<AppHostEnv>) => `${c.get('site').label}:${c.get('session')!.user.id}`;
  const jsonBody = async (c: Context): Promise<unknown> => {
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) return undefined;
    return c.req.json().catch(() => undefined);
  };

  const self = (c: Context<AppHostEnv>) => {
    const { user } = c.get('session')!;
    // Apps get a stable id and a display name, not the e-mail address.
    return { id: user.id, name: displayName(user) };
  };
  const boot = (c: Context<AppHostEnv>) => ({
    user: self(c),
    app: { slug: c.get('app').slug, name: c.get('app').name },
    members: appMembers(db, c.get('app'), isAllowed),
    push: { publicKey: deps.push.publicKey },
    locale: config.locale,
    timezone: config.timezone,
    draft: c.get('site').draft,
  });

  app.get('/_socle/api/me', (c) => {
    const data = boot(c);
    return c.json({ ...data, push: { ...data.push, subscriptions: countSubscriptions(db, target(c)) } });
  });

  app.post('/_socle/api/push/subscriptions', async (c) => {
    if (!subscribeLimiter.take(limitKey(c))) return problem(c, 429, 'rate_limited', t('Too many requests.'));
    const subscription = parseSubscription(await jsonBody(c));
    if (!subscription) return problem(c, 400, 'invalid_subscription', t('Unrecognised push subscription.'));
    saveSubscription(
      db,
      { ...target(c), family: c.get('session')!.family },
      subscription,
      c.req.header('user-agent') ?? null,
    );
    return c.body(null, 204);
  });

  app.delete('/_socle/api/push/subscriptions', async (c) => {
    const body = (await jsonBody(c)) as { endpoint?: unknown } | undefined;
    if (typeof body?.endpoint !== 'string') return problem(c, 400, 'invalid_request', t('Invalid request.'));
    deleteSubscription(db, target(c), body.endpoint);
    return c.body(null, 204);
  });

  app.post('/_socle/api/push/test', async (c) => {
    if (!testLimiter.take(limitKey(c))) {
      return problem(c, 429, 'rate_limited', t('Too many test notifications. Try again in a minute.'));
    }
    const sent = await deps.push.sendToUser(c.get('session')!.user.id, c.get('site').label, {
      title: t('{name}: it works', { name: c.get('app').name }),
      body: t('Notifications from this app will arrive here.'),
      url: '/',
      tag: 'socle-test',
    });
    return c.json({ sent });
  });

  // A member adds a file to the app: the body is the file itself. What it is is read from its
  // first bytes, not from what the browser says; the answer is the id the app keeps.
  app.post(
    FILES_API,
    async (c, next) => {
      const key = limitKey(c);
      if (!uploadLimiter.take(key)) return problem(c, 429, 'rate_limited', t('Too many requests.'));
      const mine = receiving.get(key) ?? 0;
      if (mine >= MAX_RECEIVING_EACH || receivingNow >= MAX_RECEIVING) {
        c.header('Retry-After', '5');
        return problem(c, 503, 'busy', t('The app is busy. Try again in a moment.'));
      }
      receiving.set(key, mine + 1);
      receivingNow += 1;
      try {
        return await fileBody(c, next);
      } finally {
        receivingNow -= 1;
        if (mine === 0) receiving.delete(key);
        else receiving.set(key, mine);
      }
    },
    async (c) => {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const stored = deps.files.save(c.get('site'), c.get('session')!.user.id, bytes);
      if (!stored.ok) {
        if (stored.reason === 'too_large') return problem(c, 413, 'too_large', tooLarge());
        if (stored.reason === 'full') return problem(c, 507, 'full', t('This app has no room left for files.'));
        return problem(c, 415, 'unsupported_type', t('Only pictures (JPEG, PNG, WebP, GIF) and PDF files are kept.'));
      }
      const { id, type, bytes: size } = stored.file;
      return c.json({ id, type, bytes: size, url: `${FILES}/${id}` }, 201);
    },
  );

  // A file of this address, for the members of the app. Its address never changes content, so
  // a browser keeps it; but it asks before showing it again (a 304, without the content): what
  // a browser kept is only shown to someone who is still signed in and may still open the app.
  app.get(`${FILES}/:id`, (c) => {
    const site = c.get('site');
    const file = deps.files.find(site, c.req.param('id'));
    if (!file) return c.text('Not found', 404);
    const etag = `"${file.id}"`;
    const headers = {
      'Content-Type': file.type,
      'Cache-Control': 'private, no-cache',
      ETag: etag,
      // A document is saved, not opened in the app's origin; pictures are shown where the app puts them.
      ...(file.type.startsWith('image/') ? {} : { 'Content-Disposition': 'attachment' }),
    };
    if (c.req.header('if-none-match') === etag) return c.body(null, 304, headers);
    // HEAD is routed here too, and its answer has no body: nothing is opened for it.
    if (c.req.method !== 'GET') return c.body(null, 200, { ...headers, 'Content-Length': String(file.bytes) });
    const content = deps.files.content(site, file);
    if (!content) return c.text('Not found', 404);
    return c.body(content, 200, { ...headers, 'Content-Length': String(file.bytes) });
  });

  // Ends the sign-in on this browser for the control plane and every app, and its notifications.
  app.post('/_socle/api/logout', (c) => {
    deleteFamily(db, c.get('session')!.family);
    clearAppCookie(c, config, APP_COOKIE);
    return c.json({ url: SIGNED_OUT_PATH });
  });

  const failure = (c: Context<AppHostEnv>, result: Extract<CallResult, { ok: false }>) => {
    const { code, message } = result.error;
    if (code === 'invalid_input') return problem(c, 400, code, message);
    if (code === 'unknown_function') return problem(c, 404, code, t('Unknown function.'));
    // An error the app raised on purpose, with a message written for its users.
    if (code.startsWith('user:')) return problem(c, 422, code.slice('user:'.length), message);
    // While developing, the reason is more useful than a polite sentence.
    const detail = config.devLogin ? `${APP_ERROR} (${code}: ${message})` : APP_ERROR;
    if (code === 'timeout') {
      return problem(c, 504, code, config.devLogin ? detail : t('The app took too long to answer.'));
    }
    if (code === 'busy') return problem(c, 503, code, t('The app is busy. Try again in a moment.'));
    return problem(c, 500, 'app_error', detail);
  };

  // One server function of the app. Queries and mutations both arrive as POST: the exact-origin
  // check above applies, and whether a function may write is decided by how the app declared it.
  app.post('/_socle/api/fn/:name', async (c) => {
    if (!functionLimiter.take(limitKey(c))) return problem(c, 429, 'rate_limited', t('Too many requests.'));
    const row = c.get('app');
    const site = c.get('site');
    const version = deps.apps.serving(row.slug, site.draft ? 'draft' : 'live');
    const info = version?.functions.get(c.req.param('name'));
    // What the platform runs on a schedule is nobody's to call.
    if (!version?.bundleHash || !info || info.schedule) {
      return problem(c, 404, 'unknown_function', t('Unknown function.'));
    }
    const body = (await jsonBody(c)) as { input?: unknown; query?: unknown } | undefined;
    if (typeof body !== 'object' || body === null) return problem(c, 400, 'invalid_request', t('Invalid request.'));
    // A screen that only displays must never trigger a write by mistake.
    if (body.query === true && info.kind !== 'query') {
      return problem(c, 400, 'not_a_query', `${info.name} changes data: call it with api.${info.name}().`);
    }
    // From here to the function the input travels as text.
    let inputJson: string;
    try {
      inputJson = JSON.stringify(body.input ?? null);
    } catch {
      return problem(c, 400, 'invalid_input', 'input: nested too deeply');
    }
    const result = await callFunction({
      app: row,
      site,
      version,
      info,
      inputJson,
      caller: self(c),
      client: c.req.header('x-socle-client'),
      signal: c.req.raw.signal,
    });
    if (result === 'unavailable') {
      return problem(c, 503, 'unavailable', t('The service is temporarily unavailable.'));
    }
    if (result === 'gone') return c.body(null, 204); // nobody is listening any more
    if (result === 'busy') return problem(c, 503, 'busy', t('The app is busy. Try again in a moment.'));
    if (!result.ok) return failure(c, result);
    // The result is already JSON text, checked by the runner: it is passed on, not rebuilt.
    return c.body(`{"kind":"${result.kind}","value":${result.json}}`, 200, { 'Content-Type': 'application/json' });
  });

  // Live updates: one long-lived stream per open page (see live.ts).
  app.get('/_socle/api/events', (c) => {
    // HEAD is routed here too: it would open a stream that nobody reads or closes.
    if (c.req.method !== 'GET') return c.body(null, 405, { Allow: 'GET' });
    const session = c.get('session')!;
    const slug = c.get('site').label;
    const appSlug = c.get('app').slug;
    const encoder = new TextEncoder();
    let release = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (text: string) => {
          // A page that stopped reading (a phone asleep with the connection still up) is let go
          // rather than buffered for; it reconnects and refreshes when it wakes up.
          if ((controller.desiredSize ?? 0) < -200) close();
          else controller.enqueue(encoder.encode(text));
        };
        const close = () => {
          release();
          try {
            controller.close();
          } catch {
            // already closed by the browser
          }
        };
        const unsubscribe = deps.live.subscribe(
          slug,
          session.user.id,
          (event, data) => write(`event: ${event}\ndata: ${data}\n\n`),
          close,
        );
        if (!unsubscribe) {
          // Too many open pages for this member: tell the browser not to come back at once.
          write('retry: 60000\n\n');
          controller.close();
          return;
        }
        // A stream outlives the request that opened it: on every beat the session is checked
        // again, and that the app is still this member's to open.
        const beat = setInterval(() => {
          const row = getApp(db, appSlug);
          if (!row || !canAccess(session.user, row) || !sessionStillValid(db, session, isAllowed)) close();
          else write(': ping\n\n');
        }, deps.streamPingMs ?? STREAM_PING_MS);
        release = () => {
          clearInterval(beat);
          unsubscribe();
          release = () => {};
        };
        write('retry: 3000\n\n');
      },
      cancel() {
        release();
      },
    });
    // Through the context, so that what earlier middleware prepared (a renewed session cookie) is sent.
    return c.body(stream, 200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
  });

  app.all('/_socle/*', (c) => c.text('Not found', 404));

  // The files of a version never change, so browsers keep them for good. A page opened
  // before a publication keeps finding its own files under the hash it was given.
  app.get('/assets/:hash/:file', (c) => {
    const version: AppVersion | null = deps.apps.byAssetHash(
      c.get('app').slug,
      c.req.param('hash'),
      c.get('site').draft ? 'draft' : 'live',
    );
    const file = c.req.param('file');
    const body = file === 'main.js' ? version?.js : file === 'style.css' ? version?.css : undefined;
    if (!body) return c.text('Not found', 404);
    return c.body(body, 200, {
      'Content-Type': file === 'main.js' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
  });

  // Every other path is a screen of the app: the platform writes the document around it.
  app.get('*', (c) => {
    if (!isNavigation(c)) return c.text('Not found', 404);
    const { draft } = c.get('site');
    const version = deps.apps.serving(c.get('app').slug, draft ? 'draft' : 'live');
    if (!version) {
      const why = draft ? t('This app has no draft that builds yet.') : t('This app has no published version yet.');
      return c.html(message(c.get('app').name, why), 404);
    }
    return c.html(shellPage(c.get('app'), version.assetHash, boot(c), t, draft, iconStamp(c.get('site'))), 200, {
      'Cache-Control': 'no-store',
    });
  });

  app.notFound((c) => c.text('Not found', 404));
  app.onError(onError);
  return app;
}
