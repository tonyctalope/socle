import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { appMembers, canAccess, getApp, type AppRow } from '../apps/registry.ts';
import { liveDatabase, type AppVersion } from '../apps/store.ts';
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
import { appOrigin, appSlugFromHost, localDate } from '../config.ts';
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
import { RunnerUnavailable } from '../runner/client.ts';
import type { CallResult, NotifyEffect } from '../runner/sandbox/call.ts';
import { allowlist, type AppHostEnv, type Deps } from '../types.ts';
import { CallGate } from './gate.ts';
import { appManifest } from './manifest.ts';
import { shellPage } from './shell.ts';

const ICONS = '/_socle/icons';
const SW_PATH = '/_socle/sw.js';
const VENDOR = '/_socle/vendor';
/** A function's input travels as JSON in the request body. */
const MAX_BODY = 300 * 1024;
/** How often an open event stream proves it is alive, and its session still valid. */
const STREAM_PING_MS = 25_000;

/** What the browser is told when a function fails for a reason that is not the user's to fix. */
const APP_ERROR = 'L’appli a rencontré une erreur.';

/**
 * Everything served on <slug>.<APPS_DOMAIN>. The platform owns /_socle/*; the rest
 * of the path space belongs to the app. Only what a browser fetches without
 * cookies to install a PWA is public (icons, manifest, service worker, SDK): app
 * files and the API require the session of THIS host.
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
  deps.gate ??= new CallGate();
  const notifyLimiter = new RateLimiter(30, 60_000);

  const send = (c: Context, file: StaticFile, headers: Record<string, string> = {}) =>
    c.body(file.body, 200, { 'Content-Type': file.type, 'Cache-Control': 'no-cache', ...headers });
  const problem = (
    c: Context,
    status: 400 | 401 | 403 | 404 | 422 | 429 | 500 | 503 | 504,
    error: string,
    message: string,
  ) => c.json({ error, message }, status);

  app.use('*', securityHeaders(config, APP_CSP));
  app.use('*', bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.text('Requête trop volumineuse', 413) }));

  // Only the platform's own service worker may be registered on an app origin: a worker
  // written by an app could answer page requests itself and drop the headers that confine it.
  app.use('*', async (c, next) => {
    if (c.req.header('service-worker') !== undefined && c.req.path !== SW_PATH) {
      return c.text('Service worker refusé', 403);
    }
    await next();
  });

  app.get(`${ICONS}/:file`, (c) => {
    const file = icons.get(`/${c.req.param('file')}`);
    if (!file) return c.text('Introuvable', 404);
    return send(c, file, { 'Cache-Control': 'public, max-age=86400' });
  });

  app.use('*', async (c, next) => {
    const slug = appSlugFromHost(config, new URL(c.req.url).host.toLowerCase());
    const row = slug ? getApp(db, slug) : undefined;
    if (!row) {
      return c.html(messagePage('Appli introuvable', 'Aucune appli à cette adresse.', undefined, ICONS), 404);
    }
    c.set('app', row);
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
    if (!asset) return c.text('Introuvable', 404);
    const headers = { 'Content-Type': asset.type, 'Cache-Control': 'no-cache', ETag: asset.etag };
    if (c.req.header('if-none-match') === asset.etag) return c.body(null, 304, headers);
    return c.body(asset.body, 200, headers);
  });
  app.get('/_socle/manifest.webmanifest', (c) =>
    c.body(JSON.stringify(appManifest(c.get('app'))), 200, {
      'Content-Type': 'application/manifest+json',
      'Cache-Control': 'no-cache',
    }),
  );

  app.use('*', async (c, next) => {
    const token = readAppCookie(c, config, APP_COOKIE);
    const found = token ? resolveSession(db, token, c.get('app').slug, isAllowed) : null;
    const session = found && canAccess(found.user, c.get('app')) ? found : null;
    if (token && session?.renewed) setAppCookie(c, config, APP_COOKIE, token, SESSION_TTL_MS / 1000);
    c.set('session', session);
    await next();
  });

  // Sign-on, app side: see src/auth/sso.ts for the whole flow.
  app.get('/_socle/login', (c) => {
    if (!isTopLevelNavigation(c)) return c.text('Navigation attendue', 400);
    const next = safeNextPath(c.req.query('next'), 300);
    if (c.get('session')) return c.redirect(next, 302);
    if (!loginLimiter.take(clientIp(c))) {
      return c.html(messagePage('Trop de tentatives', 'Réessaie dans une minute.', undefined, ICONS), 429);
    }
    const state = randomToken();
    setAppCookie(c, config, SSO_COOKIE, state, SSO_STATE_TTL_SEC);
    const target = new URL('/sso/start', config.controlOrigin);
    target.searchParams.set('app', c.get('app').slug);
    target.searchParams.set('state', state);
    target.searchParams.set('next', next);
    c.header('Cache-Control', 'no-store');
    return c.redirect(target.href, 302);
  });

  app.get('/_socle/sso', (c) => {
    if (!isTopLevelNavigation(c)) return c.text('Navigation attendue', 400);
    const state = readAppCookie(c, config, SSO_COOKIE);
    clearAppCookie(c, config, SSO_COOKIE);
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    const grant = takeSsoCode(db, { code: c.req.query('code') ?? '', app: c.get('app').slug, state }, deps.now());

    // Another tab finished signing in first (two tabs restored together): the code brings
    // nothing new, it only says where this tab wanted to go.
    const current = c.get('session');
    if (current) return c.redirect(grant?.userId === current.user.id ? grant.nextPath : '/', 303);

    const user = grant?.stateMatches ? getUser(db, grant.userId) : undefined;
    if (!grant || !user || !isAllowed(user.email) || !canAccess(user, c.get('app'))) {
      // Shown instead of redirecting again, so a browser that drops cookies cannot loop.
      return c.html(
        messagePage(
          'Connexion interrompue',
          'Le lien de connexion a expiré ou les cookies sont bloqués pour ce site.',
          { href: '/_socle/login', label: 'Réessayer' },
          ICONS,
        ),
        400,
      );
    }
    const { token } = createSession(db, {
      userId: user.id,
      scope: c.get('app').slug,
      family: grant.family,
      userAgent: c.req.header('user-agent') ?? null,
    });
    setAppCookie(c, config, APP_COOKIE, token, SESSION_TTL_MS / 1000);
    return c.redirect(grant.nextPath, 303);
  });

  // From here on, a session of this host is required.
  app.use('*', async (c, next) => {
    if (c.get('session')) return next();
    if (c.req.path.startsWith('/_socle/api/')) return problem(c, 401, 'unauthenticated', 'Connexion requise.');
    if (isNavigation(c)) {
      const url = new URL(c.req.url);
      const back = safeNextPath(url.pathname + url.search, 300);
      return c.redirect(`/_socle/login?next=${encodeURIComponent(back)}`, 302);
    }
    return c.text('Connexion requise', 401);
  });

  app.use('/_socle/api/*', async (c, next) => {
    const read = c.req.method === 'GET' || c.req.method === 'HEAD';
    const own = read ? isOwnFetch(c) : isSameOrigin(c, appOrigin(config, c.get('app').slug));
    if (!own) return problem(c, 403, 'forbidden', 'Origine inattendue.');
    c.header('Cache-Control', 'no-store');
    await next();
  });

  const target = (c: Context<AppHostEnv>) => ({ userId: c.get('session')!.user.id, app: c.get('app').slug });
  const limitKey = (c: Context<AppHostEnv>) => `${c.get('app').slug}:${c.get('session')!.user.id}`;
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
  });

  app.get('/_socle/api/me', (c) => {
    const data = boot(c);
    return c.json({ ...data, push: { ...data.push, subscriptions: countSubscriptions(db, target(c)) } });
  });

  app.post('/_socle/api/push/subscriptions', async (c) => {
    if (!subscribeLimiter.take(limitKey(c))) return problem(c, 429, 'rate_limited', 'Trop de requêtes.');
    const subscription = parseSubscription(await jsonBody(c));
    if (!subscription) return problem(c, 400, 'invalid_subscription', 'Abonnement push non reconnu.');
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
    if (typeof body?.endpoint !== 'string') return problem(c, 400, 'invalid_request', 'Requête invalide.');
    deleteSubscription(db, target(c), body.endpoint);
    return c.body(null, 204);
  });

  app.post('/_socle/api/push/test', async (c) => {
    if (!testLimiter.take(limitKey(c))) {
      return problem(c, 429, 'rate_limited', 'Trop de notifications de test, réessaie dans une minute.');
    }
    const sent = await deps.push.sendToUser(c.get('session')!.user.id, c.get('app').slug, {
      title: `${c.get('app').name} : ça marche`,
      body: 'Les notifications de cette appli arriveront ici.',
      url: '/',
      tag: 'socle-test',
    });
    return c.json({ sent });
  });

  // Ends the sign-in on this browser for the control plane and every app, and its notifications.
  app.post('/_socle/api/logout', (c) => {
    deleteFamily(db, c.get('session')!.family);
    clearAppCookie(c, config, APP_COOKIE);
    return c.json({ url: `${config.controlOrigin}/` });
  });

  /** Sends what a mutation asked for, to members of this app only. */
  const notify = (row: AppRow, callerId: number, effects: NotifyEffect[]) => {
    if (effects.length === 0) return;
    const members = appMembers(db, row, isAllowed).map((member) => member.id);
    for (const [index, effect] of effects.entries()) {
      const wanted =
        effect.to === 'all' ? members : effect.to === 'others' ? members.filter((id) => id !== callerId) : effect.to;
      for (const userId of new Set(wanted)) {
        if (!members.includes(userId)) continue;
        if (!notifyLimiter.take(`${row.slug}:${userId}`)) {
          console.warn(`[${row.slug}] too many notifications for member ${userId}, dropped`);
          continue;
        }
        deps.push
          .sendToUser(userId, row.slug, {
            title: effect.title,
            body: effect.body,
            url: effect.url,
            tag: `${row.slug}-${deps.now().getTime()}-${index}`,
          })
          .catch((error: unknown) => console.warn(`[${row.slug}] notification failed:`, (error as Error).message));
      }
    }
  };

  const failure = (c: Context<AppHostEnv>, fn: string, result: Extract<CallResult, { ok: false }>) => {
    const { code, message } = result.error;
    if (code === 'invalid_input') return problem(c, 400, code, message);
    if (code === 'unknown_function') return problem(c, 404, code, 'Fonction inconnue.');
    // An error the app raised on purpose, with a message written for its users.
    if (code.startsWith('user:')) return problem(c, 422, code.slice('user:'.length), message);
    console.warn(`[${c.get('app').slug}] ${fn} failed (${code}): ${message}`);
    // While developing, the reason is more useful than a polite sentence.
    const detail = config.devLogin ? `${APP_ERROR} (${code}: ${message})` : APP_ERROR;
    if (code === 'timeout')
      return problem(c, 504, code, config.devLogin ? detail : 'L’appli a mis trop de temps à répondre.');
    if (code === 'busy') return problem(c, 503, code, 'L’appli est occupée, réessaie dans un instant.');
    return problem(c, 500, 'app_error', detail);
  };

  // One server function of the app. Queries and mutations both arrive as POST: the exact-origin
  // check above applies, and whether a function may write is decided by how the app declared it.
  app.post('/_socle/api/fn/:name', async (c) => {
    if (!functionLimiter.take(limitKey(c))) return problem(c, 429, 'rate_limited', 'Trop de requêtes.');
    const row = c.get('app');
    const version = deps.apps.live(row.slug);
    const info = version?.functions.get(c.req.param('name'));
    if (!version?.bundleHash || !info) return problem(c, 404, 'unknown_function', 'Fonction inconnue.');
    const body = (await jsonBody(c)) as { input?: unknown; query?: unknown } | undefined;
    if (typeof body !== 'object' || body === null) return problem(c, 400, 'invalid_request', 'Requête invalide.');
    // A screen that only displays must never trigger a write by mistake.
    if (body.query === true && info.kind !== 'query') {
      return problem(c, 400, 'not_a_query', `${info.name} modifie des données : appelle-la avec api.${info.name}().`);
    }
    // From here to the function the input travels as text.
    let inputJson: string;
    try {
      inputJson = JSON.stringify(body.input ?? null);
    } catch {
      return problem(c, 400, 'invalid_input', 'input: nested too deeply');
    }
    const caller = self(c);
    const { bundleHash } = version;
    const send = () =>
      deps.runner.call({
        database: liveDatabase(row.slug),
        bundleHash,
        fn: info.name,
        kind: info.kind,
        inputJson,
        user: caller,
        members: appMembers(db, row, isAllowed),
        now: deps.now().getTime(),
        today: localDate(config, deps.now()),
      });
    let result: CallResult | 'busy' | 'gone';
    try {
      result = await deps.gate!.run(row.slug, c.req.raw.signal, async () => {
        const first = await send();
        if (first.ok || first.error.code !== 'bundle_missing') return first;
        // The runner lost this app's code (a fresh volume, for instance): give it again, once.
        const bundle = deps.apps.bundleOf(version.id);
        if (bundle === null) return first;
        await deps.runner.install(row.slug, bundle);
        return send();
      });
    } catch (error) {
      if (!(error instanceof RunnerUnavailable)) throw error;
      console.error(`runner unavailable (${error.code}): ${error.message}`);
      return problem(c, 503, 'unavailable', 'Le service est momentanément indisponible.');
    }
    if (result === 'gone') return c.body(null, 204); // nobody is listening any more
    if (result === 'busy') return problem(c, 503, 'busy', 'L’appli est occupée, réessaie dans un instant.');
    for (const line of result.logs) console.info(`[${row.slug}] ${info.name}: ${line}`);
    if (!result.ok) return failure(c, info.name, result);
    if (result.kind === 'mutation') {
      const client = c.req.header('x-socle-client') ?? '';
      deps.live.publish(row.slug, 'change', { client: /^[a-z0-9]{1,40}$/.test(client) ? client : '' });
      notify(row, caller.id, result.effects);
    }
    // The result is already JSON text, checked by the runner: it is passed on, not rebuilt.
    return c.body(`{"kind":"${result.kind}","value":${result.json}}`, 200, { 'Content-Type': 'application/json' });
  });

  // Live updates: one long-lived stream per open page (see live.ts).
  app.get('/_socle/api/events', (c) => {
    // HEAD is routed here too: it would open a stream that nobody reads or closes.
    if (c.req.method !== 'GET') return c.body(null, 405, { Allow: 'GET' });
    const session = c.get('session')!;
    const { slug } = c.get('app');
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
        // A stream outlives the request that opened it: the session is checked again on every beat.
        const beat = setInterval(() => {
          if (!sessionStillValid(db, session, isAllowed)) close();
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

  app.all('/_socle/*', (c) => c.text('Introuvable', 404));

  // The files of a version never change, so browsers keep them for good. A page opened
  // before a publication keeps finding its own files under the hash it was given.
  app.get('/assets/:hash/:file', (c) => {
    const version: AppVersion | null = deps.apps.byAssetHash(c.get('app').slug, c.req.param('hash'));
    const file = c.req.param('file');
    const body = file === 'main.js' ? version?.js : file === 'style.css' ? version?.css : undefined;
    if (!body) return c.text('Introuvable', 404);
    return c.body(body, 200, {
      'Content-Type': file === 'main.js' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
  });

  // Every other path is a screen of the app: the platform writes the document around it.
  app.get('*', (c) => {
    if (!isNavigation(c)) return c.text('Introuvable', 404);
    const version = deps.apps.live(c.get('app').slug);
    if (!version) {
      return c.html(
        messagePage(c.get('app').name, 'Cette appli n’a pas encore de version publiée.', undefined, ICONS),
        404,
      );
    }
    return c.html(shellPage(c.get('app'), version.assetHash, boot(c)), 200, { 'Cache-Control': 'no-store' });
  });

  app.notFound((c) => c.text('Introuvable', 404));
  app.onError(onError);
  return app;
}
