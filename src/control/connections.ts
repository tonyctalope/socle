import { Hono } from 'hono';
import { html } from 'hono/html';
import { localDate } from '../config.ts';
import { translator } from '../i18n.ts';
import { clientIp, isSameOrigin, RateLimiter } from '../lib/http.ts';
import type { UserRow } from '../auth/users.ts';
import { listGrants, revokeGrant } from '../oauth/tokens.ts';
import { page } from '../pages/layout.ts';
import type { ControlEnv, Deps } from '../types.ts';

/**
 * "Connected applications": the MCP clients a member let in, and the way to take that back
 * from the platform's side (the client's own "disconnect" is not the only door).
 * `describe` names a resource, or returns null for one that no longer exists.
 */
export function connectionRoutes(
  deps: Deps,
  describe: (resource: string, user: UserRow) => string | null,
): Hono<ControlEnv> {
  const { config, db } = deps;
  const t = translator(config.locale);
  const app = new Hono<ControlEnv>();
  const limiter = new RateLimiter(30, 60_000);

  app.get('/connections', (c) => {
    const session = c.get('session');
    if (!session) return c.redirect(`/auth/start?next=${encodeURIComponent('/connections')}`, 302);
    const grants = listGrants(db, session.user.id);
    c.header('Cache-Control', 'no-store');
    return c.html(
      page(
        config.locale,
        t('Connected applications'),
        html`<h1>${t('Connected applications')}</h1>
          <p class="muted">${t('The applications you allowed to act here in your name.')}</p>
          ${grants.length === 0 ? html`<p>${t('No application is connected.')}</p>` : ''}
          ${grants.map(
            (grant) =>
              html`<section class="app">
                <h2>${grant.clientName ?? t('An application')}</h2>
                <p class="muted">
                  ${describe(grant.resource, session.user) ?? grant.resource} ·
                  ${
                    grant.lastUsedAt
                      ? t('last used on {date}', { date: localDate(config, new Date(grant.lastUsedAt)) })
                      : t('never used')
                  }
                </p>
                <form class="actions" method="post" action="/connections/${grant.id}/revoke">
                  <button class="secondary" type="submit">${t('Disconnect')}</button>
                </form>
              </section>`,
          )}
          <p class="actions"><a class="button secondary" href="/">${t('Home')}</a></p>`,
      ),
    );
  });

  app.post('/connections/:id/revoke', (c) => {
    if (!isSameOrigin(c, config.controlOrigin)) return c.text('Unexpected origin', 403);
    if (!limiter.take(clientIp(c))) return c.text('Too many requests', 429);
    const session = c.get('session');
    if (!session) return c.text('Sign-in required', 401);
    // Only one's own: another member's connection is "not found", like one that does not exist.
    if (!revokeGrant(db, c.req.param('id'), session.user.id)) return c.text('Not found', 404);
    console.info(`oauth: ${session.user.email} disconnected an application`);
    return c.redirect('/connections', 303);
  });

  return app;
}
