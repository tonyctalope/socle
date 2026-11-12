import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { canAccess, DEMO_SLUG, getApp } from '../apps/registry.ts';
import { clearAppCookie, readAppCookie, setAppCookie } from '../auth/cookies.ts';
import { APP_COOKIE, createSession, deleteFamily, resolveSession, SESSION_TTL_MS } from '../auth/sessions.ts';
import { SSO_COOKIE, SSO_STATE_TTL_SEC, takeSsoCode } from '../auth/sso.ts';
import { displayName, getUser } from '../auth/users.ts';
import { appOrigin, appSlugFromHost } from '../config.ts';
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
import { allowlist, type AppHostEnv, type Deps } from '../types.ts';
import { appManifest } from './manifest.ts';
import { shellPage } from './shell.ts';

const ICONS = '/_socle/icons';
const SW_PATH = '/_socle/sw.js';

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
  const demoFiles = loadStaticFiles('demo');
  const loginLimiter = new RateLimiter(60, 60_000);
  const subscribeLimiter = new RateLimiter(30, 60_000);
  const testLimiter = new RateLimiter(10, 60_000);

  const send = (c: Context, file: StaticFile, headers: Record<string, string> = {}) =>
    c.body(file.body, 200, { 'Content-Type': file.type, 'Cache-Control': 'no-cache', ...headers });
  const problem = (c: Context, status: 400 | 401 | 403 | 404 | 429, error: string, message: string) =>
    c.json({ error, message }, status);

  app.use('*', securityHeaders(config, APP_CSP));
  app.use('*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.text('Requête trop volumineuse', 413) }));

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
  app.get('/_socle/sdk.js', (c) => send(c, client.get('/sdk.js')!));
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

  app.get('/_socle/api/me', (c) => {
    const { user } = c.get('session')!;
    return c.json({
      // Apps get a stable id and a display name, not the e-mail address.
      user: { id: user.id, name: displayName(user) },
      app: { slug: c.get('app').slug, name: c.get('app').name },
      push: { publicKey: deps.push.publicKey, subscriptions: countSubscriptions(db, target(c)) },
    });
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

  app.all('/_socle/*', (c) => c.text('Introuvable', 404));

  // The app's own files. Only the demo ships with the platform for now.
  app.get('*', (c) => {
    const files = c.get('app').slug === DEMO_SLUG ? demoFiles : null;
    const pathname = new URL(c.req.url).pathname;
    if (pathname.startsWith('/assets/')) {
      const file = files?.get(pathname.slice('/assets'.length));
      return file ? send(c, file) : c.text('Introuvable', 404);
    }
    if (!isNavigation(c)) return c.text('Introuvable', 404);
    if (!files?.has('/main.js')) {
      return c.html(
        messagePage(c.get('app').name, 'Cette appli n’a pas encore de version publiée.', undefined, ICONS),
        404,
      );
    }
    const entry = { script: '/assets/main.js', style: files.has('/style.css') ? '/assets/style.css' : null };
    return c.html(shellPage(c.get('app'), entry), 200, { 'Cache-Control': 'no-cache' });
  });

  app.notFound((c) => c.text('Introuvable', 404));
  app.onError(onError);
  return app;
}
