import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { html } from 'hono/html';
import { canAccess, getApp, listApps } from '../apps/registry.ts';
import { isValidSlug } from '../apps/slug.ts';
import { clearAppCookie, readAppCookie, setAppCookie } from '../auth/cookies.ts';
import { LOGIN_COOKIE, LOGIN_TTL_SEC, LoginError } from '../auth/google.ts';
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
import { randomToken } from '../lib/crypto.ts';
import { clientIp, isSameOrigin, isTopLevelNavigation, RateLimiter, safeNextPath } from '../lib/http.ts';
import { CONTROL_CSP, onError, securityHeaders } from '../lib/security.ts';
import { loadStaticFiles } from '../lib/static.ts';
import { messagePage, page } from '../pages/layout.ts';
import { allowlist, type ControlEnv, type Deps } from '../types.ts';

/** Long enough for the way back to an app page (its path, encoded once more). */
const NEXT_MAX = 1500;

/** The control plane: sign-in with Google, the home page, and sign-on towards app hosts. */
export function controlApp(deps: Deps): Hono<ControlEnv> {
  const { config, db } = deps;
  const isAllowed = allowlist(config);
  const app = new Hono<ControlEnv>();
  const icons = loadStaticFiles('assets/icons');
  const loginLimiter = new RateLimiter(30, 60_000);
  const ssoLimiter = new RateLimiter(120, 60_000);

  app.use('*', securityHeaders(config, CONTROL_CSP));
  app.use('*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.text('Requête trop volumineuse', 413) }));

  app.get('/healthz', (c) => {
    get(db, 'SELECT 1 AS ok');
    return c.json({ ok: true });
  });

  app.get('/icons/:file', (c) => {
    const file = icons.get(`/${c.req.param('file')}`);
    if (!file) return c.text('Introuvable', 404);
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
        messagePage('Socle', 'Les applis de la maison. Connecte-toi pour les ouvrir.', {
          href: '/auth/google/start',
          label: 'Se connecter avec Google',
        }),
      );
    }
    const apps = listApps(db).filter((row) => canAccess(session.user, row));
    return c.html(
      page(
        'Accueil',
        html`<img class="logo" src="/icons/icon-192.png" alt="" />
          <h1>Bonjour ${displayName(session.user)}</h1>
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
              : html`<p class="muted">Aucune appli pour l’instant.</p>`
          }
          <p class="muted">
            Pour installer une appli sur ton téléphone, ouvre-la puis choisis « Ajouter à l’écran d’accueil » dans le
            menu du navigateur.
          </p>
          <form class="actions" method="post" action="/auth/logout">
            <button class="secondary" type="submit">Se déconnecter</button>
          </form>`,
      ),
    );
  });

  app.get('/auth/google/start', async (c) => {
    if (!loginLimiter.take(clientIp(c))) {
      return c.html(messagePage('Trop de tentatives', 'Réessaie dans une minute.'), 429);
    }
    const next = safeNextPath(c.req.query('next'), NEXT_MAX);
    if (config.devLogin) return c.redirect(`/auth/dev-login?next=${encodeURIComponent(next)}`, 302);
    try {
      const { url, pending } = await deps.identity.start(next);
      setAppCookie(c, config, LOGIN_COOKIE, pending, LOGIN_TTL_SEC);
      return c.redirect(url, 302);
    } catch (error) {
      console.error('google login start failed:', (error as Error).message);
      return c.html(messagePage('Connexion indisponible', 'Google ne répond pas, réessaie dans un instant.'), 502);
    }
  });

  app.get('/auth/google/callback', async (c) => {
    if (!loginLimiter.take(clientIp(c))) {
      return c.html(messagePage('Trop de tentatives', 'Réessaie dans une minute.'), 429);
    }
    const retry = { href: '/auth/google/start', label: 'Réessayer' };
    const pending = readAppCookie(c, config, LOGIN_COOKIE);
    clearAppCookie(c, config, LOGIN_COOKIE);
    if (c.req.query('error')) {
      return c.html(messagePage('Connexion annulée', 'La connexion Google a été annulée.', retry), 400);
    }
    if (!pending) {
      return c.html(
        messagePage('Connexion expirée', 'Cette tentative de connexion n’est plus valide, recommence.', retry),
        400,
      );
    }
    // Rebuild the URL as Google saw it (we sit behind a TLS-terminating proxy).
    const callbackUrl = new URL(`/auth/google/callback${new URL(c.req.url).search}`, config.controlOrigin);
    let result;
    try {
      result = await deps.identity.finish(callbackUrl, pending);
    } catch (error) {
      const message = error instanceof LoginError ? error.message : 'La réponse de Google n’a pas pu être vérifiée.';
      console.warn('google login failed:', (error as Error).message);
      return c.html(messagePage('Connexion impossible', message, retry), 400);
    }
    const { identity, nextPath } = result;
    if (!identity.emailVerified || !isAllowed(identity.email)) {
      console.warn(`login refused for ${identity.email} (verified=${identity.emailVerified})`);
      return c.html(
        messagePage(
          'Accès réservé',
          `L’adresse ${identity.email} n’est pas autorisée ici. Demande à l’administrateur de l’ajouter, ou connecte-toi avec un autre compte Google.`,
          { href: '/auth/google/start', label: 'Choisir un autre compte' },
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
    if (!isSameOrigin(c, config.controlOrigin)) return c.text('Origine inattendue', 403);
    const session = c.get('session');
    if (session) deleteFamily(db, session.family);
    clearAppCookie(c, config, CONTROL_COOKIE);
    return c.redirect('/', 303);
  });

  if (config.devLogin) {
    // Local development without Google (refused by loadConfig outside localhost + NODE_ENV=development).
    app.get('/auth/dev-login', (c) => {
      const email = c.req.query('email')?.toLowerCase();
      const next = safeNextPath(c.req.query('next'), NEXT_MAX);
      if (!email) {
        return c.html(
          page(
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

  // Sign-on towards an app host: see src/auth/sso.ts for the whole flow.
  app.get('/sso/start', (c) => {
    if (!isTopLevelNavigation(c)) return c.text('Navigation attendue', 400);
    if (!ssoLimiter.take(clientIp(c))) {
      return c.html(messagePage('Trop de tentatives', 'Réessaie dans une minute.'), 429);
    }
    const home = { href: '/', label: 'Accueil' };
    const slug = c.req.query('app') ?? '';
    const state = c.req.query('state') ?? '';
    const next = safeNextPath(c.req.query('next'), 300);
    if (!isValidSlug(slug) || !isToken(state)) {
      return c.html(messagePage('Lien invalide', 'Ce lien de connexion est incomplet.', home), 400);
    }
    const session = c.get('session');
    if (!session) {
      const back = `/sso/start?app=${slug}&state=${state}&next=${encodeURIComponent(next)}`;
      return c.redirect(`/auth/google/start?next=${encodeURIComponent(back)}`, 302);
    }
    const target = getApp(db, slug);
    if (!target) return c.html(messagePage('Appli introuvable', 'Cette appli n’existe pas.', home), 404);
    if (!canAccess(session.user, target)) {
      return c.html(messagePage('Accès réservé', `Tu n’as pas accès à ${target.name}.`, home), 403);
    }
    const code = createSsoCode(
      db,
      { userId: session.user.id, app: slug, family: session.family, state, nextPath: next },
      deps.now(),
    );
    if (!code) return c.html(messagePage('Trop de connexions en cours', 'Réessaie dans une minute.'), 503);
    c.header('Cache-Control', 'no-store');
    return c.redirect(`${appOrigin(config, slug)}/_socle/sso?code=${code}`, 302);
  });

  app.notFound((c) =>
    c.html(messagePage('Page introuvable', 'Cette page n’existe pas.', { href: '/', label: 'Accueil' }), 404),
  );
  app.onError(onError);
  return app;
}
