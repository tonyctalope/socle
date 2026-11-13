import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { html } from 'hono/html';
import { canAccess, getApp, listApps } from '../apps/registry.ts';
import { parseSite } from '../apps/slug.ts';
import { clearAppCookie, readAppCookie, setAppCookie } from '../auth/cookies.ts';
import { CALLBACK_PATH, LOGIN_COOKIE, LOGIN_TTL_SEC, LoginError } from '../auth/oidc.ts';
import {
  claimFamily,
  CONTROL_COOKIE,
  CONTROL_SCOPE,
  createSession,
  deleteFamily,
  DEVICE_COOKIE,
  DEVICE_TTL_SEC,
  resolveSession,
  SESSION_TTL_MS,
} from '../auth/sessions.ts';
import { createSsoCode, isToken } from '../auth/sso.ts';
import { displayName, upsertUser, type UserRow } from '../auth/users.ts';
import { appOrigin } from '../config.ts';
import { get } from '../db/database.ts';
import { translator } from '../i18n.ts';
import { randomToken } from '../lib/crypto.ts';
import { clientIp, isSameOrigin, isTopLevelNavigation, RateLimiter, safeNextPath } from '../lib/http.ts';
import { CONTROL_CSP, onError, securityHeaders } from '../lib/security.ts';
import { loadStaticFiles } from '../lib/static.ts';
import { messagePage, page } from '../pages/layout.ts';
import { allowlist, isAdmin, type ControlEnv, type Deps } from '../types.ts';
import { appOfResource } from '../mcp/app.ts';
import { buildBuilderServer } from '../mcp/builder.ts';
import { builderResource, mcpCors, mcpEndpoint } from '../mcp/http.ts';
import { protectedResourceMetadata } from '../oauth/metadata.ts';
import { oauthRoutes } from '../oauth/routes.ts';
import { adminRoutes } from './admin.ts';
import { connectionRoutes } from './connections.ts';

/** Long enough for the way back to an app page (its path, encoded once more). */
const NEXT_MAX = 1500;

/** The control plane: sign-in, the home page, and sign-on towards app hosts. */
export function controlApp(deps: Deps): Hono<ControlEnv> {
  const { config, db } = deps;
  const isAllowed = allowlist(config);
  const t = translator(config.locale);
  const message = (title: string, text: string, link?: { href: string; label: string }) =>
    messagePage(config.locale, title, text, link);
  const tooMany = () => message(t('Too many attempts'), t('Try again in a minute.'));
  const app = new Hono<ControlEnv>();
  const icons = loadStaticFiles('assets/icons');
  const loginLimiter = new RateLimiter(30, 60_000);
  const ssoLimiter = new RateLimiter(120, 60_000);

  app.use('*', securityHeaders(config, CONTROL_CSP));
  // Small bodies everywhere, except the MCP endpoint: an app's files travel through it, and
  // the MCP handler has its own limit, applied once the bearer token is verified.
  const smallBody = bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.text('Request too large', 413) });
  app.use('*', (c, next) => (c.req.path === '/mcp' ? next() : smallBody(c, next)));

  // The builder: the MCP endpoint agents create and change apps through. It is authenticated by
  // a bearer token of the platform's authorization server, never by a cookie.
  const builder = builderResource(config);
  const builderCard = () => ({
    name: t('the app builder'),
    description: t('It will be able to create apps and change their drafts. It cannot publish: an administrator does.'),
  });
  const mcp = mcpEndpoint(deps, builder, (caller) => buildBuilderServer(deps, caller));
  app.use('/mcp', mcpCors);
  app.all('/mcp', (c) => mcp(c));
  app.use('/.well-known/oauth-protected-resource/*', mcpCors);
  app.get('/.well-known/oauth-protected-resource/mcp', (c) =>
    c.json(protectedResourceMetadata(config, builder, 'Socle')),
  );

  app.get('/healthz', async (c) => {
    get(db, 'SELECT 1 AS ok');
    // The runner being away does not make this process unhealthy: restarting it would not help.
    return c.json({ ok: true, runner: await deps.runner.healthy() });
  });

  app.get('/icons/:file', (c) => {
    const file = icons.get(`/${c.req.param('file')}`);
    if (!file) return c.text('Not found', 404);
    return c.body(file.body, 200, { 'Content-Type': file.type, 'Cache-Control': 'public, max-age=86400' });
  });

  app.use('*', async (c, next) => {
    const token = readAppCookie(c, config, CONTROL_COOKIE);
    const session = token ? resolveSession(db, token, CONTROL_SCOPE, isAllowed) : null;
    if (token && session?.renewed) setAppCookie(c, config, CONTROL_COOKIE, token, SESSION_TTL_MS / 1000);
    c.set('session', session);
    await next();
  });

  const signIn = (c: Context<ControlEnv>, user: UserRow) => {
    // The device cookie names this browser across sign-ins. Whatever another member
    // left on it (sessions on app hosts, notifications) ends here.
    const known = readAppCookie(c, config, DEVICE_COOKIE);
    const family = known && isToken(known) ? known : randomToken();
    claimFamily(db, family, user.id);
    setAppCookie(c, config, DEVICE_COOKIE, family, DEVICE_TTL_SEC);
    const { token } = createSession(db, {
      userId: user.id,
      scope: CONTROL_SCOPE,
      family,
      userAgent: c.req.header('user-agent') ?? null,
    });
    setAppCookie(c, config, CONTROL_COOKIE, token, SESSION_TTL_MS / 1000);
  };

  app.get('/', (c) => {
    const session = c.get('session');
    if (!session) {
      return c.html(
        message('Socle', t('Sign in to open your apps.'), {
          href: '/auth/start',
          label: config.oidc.name ? t('Sign in with {name}', { name: config.oidc.name }) : t('Sign in'),
        }),
      );
    }
    // An app that was never published only exists for those who work on it (see /admin).
    const apps = listApps(db).filter((row) => row.live_version !== null && canAccess(session.user, row));
    return c.html(
      page(
        config.locale,
        t('Home'),
        html`<img class="logo" src="/icons/icon-192.png" alt="" />
          <h1>${t('Hello {name}', { name: displayName(session.user) })}</h1>
          ${
            apps.length
              ? html`<ul class="apps">
                  ${apps.map(
                    (row) =>
                      html`<li>
                        <a href="${appOrigin(config, row.slug)}/">
                          <img src="/icons/icon-192.png" alt="" />
                          <div><strong>${row.name}</strong><span>${row.description}</span></div>
                        </a>
                      </li>`,
                  )}
                </ul>`
              : html`<p class="muted">${t('No app yet.')}</p>`
          }
          <p class="muted">
            ${t('To install an app on your phone, open it, then choose “Add to Home Screen” in the browser menu.')}
          </p>
          ${
            isAdmin(config, session.user)
              ? html`<p class="actions"><a class="button secondary" href="/admin/">${t('Administration')}</a></p>`
              : ''
          }
          <p class="muted"><a href="/connections">${t('Connected applications')}</a></p>
          <form class="actions" method="post" action="/auth/logout">
            <button class="secondary" type="submit">${t('Sign out')}</button>
          </form>`,
      ),
    );
  });

  app.get('/auth/start', async (c) => {
    if (!loginLimiter.take(clientIp(c))) {
      return c.html(tooMany(), 429);
    }
    const next = safeNextPath(c.req.query('next'), NEXT_MAX);
    if (config.devLogin) return c.redirect(`/auth/dev-login?next=${encodeURIComponent(next)}`, 302);
    try {
      const { url, pending } = await deps.identity.start(next);
      setAppCookie(c, config, LOGIN_COOKIE, pending, LOGIN_TTL_SEC);
      return c.redirect(url, 302);
    } catch (error) {
      console.error('sign-in start failed:', (error as Error).message);
      return c.html(
        message(t('Sign-in unavailable'), t('The sign-in service is not answering. Try again in a moment.')),
        502,
      );
    }
  });

  app.get(CALLBACK_PATH, async (c) => {
    if (!loginLimiter.take(clientIp(c))) {
      return c.html(tooMany(), 429);
    }
    const retry = { href: '/auth/start', label: t('Try again') };
    const pending = readAppCookie(c, config, LOGIN_COOKIE);
    clearAppCookie(c, config, LOGIN_COOKIE);
    if (c.req.query('error')) {
      return c.html(message(t('Sign-in cancelled'), t('The sign-in was cancelled.'), retry), 400);
    }
    if (!pending) {
      return c.html(
        message(t('Sign-in expired'), t('This sign-in attempt is no longer valid. Start again.'), retry),
        400,
      );
    }
    // Rebuild the URL as the provider saw it (we sit behind a TLS-terminating proxy).
    const callbackUrl = new URL(`${CALLBACK_PATH}${new URL(c.req.url).search}`, config.controlOrigin);
    let result;
    try {
      result = await deps.identity.finish(callbackUrl, pending);
    } catch (error) {
      const reason =
        error instanceof LoginError ? error.message : t('The answer of the sign-in service could not be verified.');
      console.warn('sign-in failed:', (error as Error).message);
      return c.html(message(t('Sign-in failed'), reason, retry), 400);
    }
    const { identity, nextPath } = result;
    if (!identity.emailVerified || !isAllowed(identity.email)) {
      console.warn(`login refused for ${identity.email} (verified=${identity.emailVerified})`);
      return c.html(
        message(
          t('Access restricted'),
          t('{email} is not allowed here. Ask the administrator to add it, or sign in with another account.', {
            email: identity.email,
          }),
          { href: '/auth/start', label: t('Choose another account') },
        ),
        403,
      );
    }
    const user = upsertUser(db, { sub: identity.sub, email: identity.email, name: identity.name });
    signIn(c, user);
    console.info(`login: ${user.email}`);
    return c.redirect(safeNextPath(nextPath, NEXT_MAX), 303);
  });

  app.post('/auth/logout', (c) => {
    if (!isSameOrigin(c, config.controlOrigin)) return c.text('Unexpected origin', 403);
    const session = c.get('session');
    if (session) deleteFamily(db, session.family);
    clearAppCookie(c, config, CONTROL_COOKIE);
    return c.redirect('/', 303);
  });

  if (config.devLogin) {
    // Local development without a sign-in provider (refused by loadConfig outside localhost + NODE_ENV=development).
    app.get('/auth/dev-login', (c) => {
      const email = c.req.query('email')?.toLowerCase();
      const next = safeNextPath(c.req.query('next'), NEXT_MAX);
      if (!email) {
        return c.html(
          page(
            config.locale,
            'Dev login',
            html`<h1>Dev login</h1>
              <ul>
                ${[...config.allowedEmails].map(
                  (address) =>
                    html`<li>
                      <a href="/auth/dev-login?email=${encodeURIComponent(address)}&next=${encodeURIComponent(next)}"
                        >${address}</a
                      >
                    </li>`,
                )}
              </ul>`,
          ),
        );
      }
      if (!isAllowed(email)) return c.text('not allowlisted', 403);
      signIn(c, upsertUser(db, { sub: null, email, name: email.split('@')[0]! }));
      return c.redirect(next, 303);
    });
  }

  app.route('/', adminRoutes(deps));
  // Which MCP endpoints exist, and who may get a token for each: the builder, and the endpoint
  // of every published app that offers tools, for the members who can open that app.
  const resourceCard = (resource: string, user: UserRow) => {
    if (resource === builder) return builderCard();
    const target = appOfResource(deps, resource, user, (slug) => getApp(db, slug));
    if (!target) return null;
    return {
      name: target.name,
      description: t('It will be able to use this app in your name: read what it holds and change it.'),
    };
  };
  app.route('/', oauthRoutes(deps, resourceCard));
  app.route(
    '/',
    connectionRoutes(deps, (resource, user) => resourceCard(resource, user)?.name ?? null),
  );

  // Sign-on towards an app host: see src/auth/sso.ts for the whole flow.
  app.get('/sso/start', (c) => {
    if (!isTopLevelNavigation(c)) return c.text('Navigation expected', 400);
    if (!ssoLimiter.take(clientIp(c))) {
      return c.html(tooMany(), 429);
    }
    const home = { href: '/', label: t('Home') };
    // `app` names one of an app's two addresses: the published one or its draft's.
    const site = parseSite(c.req.query('app') ?? '');
    const state = c.req.query('state') ?? '';
    const next = safeNextPath(c.req.query('next'), 300);
    if (!site || !isToken(state)) {
      return c.html(message(t('Invalid link'), t('This sign-in link is incomplete.'), home), 400);
    }
    const session = c.get('session');
    if (!session) {
      const back = `/sso/start?app=${site.label}&state=${state}&next=${encodeURIComponent(next)}`;
      return c.redirect(`/auth/start?next=${encodeURIComponent(back)}`, 302);
    }
    const target = getApp(db, site.slug);
    if (!target) return c.html(message(t('App not found'), t('This app does not exist.'), home), 404);
    if (!canAccess(session.user, target)) {
      return c.html(
        message(t('Access restricted'), t('You do not have access to {name}.', { name: target.name }), home),
        403,
      );
    }
    const code = createSsoCode(
      db,
      { userId: session.user.id, app: site.label, family: session.family, state, nextPath: next },
      deps.now(),
    );
    if (!code) return c.html(message(t('Too many sign-ins in progress'), t('Try again in a minute.')), 503);
    c.header('Cache-Control', 'no-store');
    return c.redirect(`${appOrigin(config, site.label)}/_socle/sso?code=${code}`, 302);
  });

  app.notFound((c) =>
    c.html(message(t('Page not found'), t('This page does not exist.'), { href: '/', label: t('Home') }), 404),
  );
  app.onError(onError);
  return app;
}
