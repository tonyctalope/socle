import { Hono } from 'hono';
import { html } from 'hono/html';
import { listApps } from '../apps/registry.ts';
import { siteOf } from '../apps/slug.ts';
import { appOrigin } from '../config.ts';
import { translator } from '../i18n.ts';
import { clientIp, isSameOrigin, RateLimiter } from '../lib/http.ts';
import { messagePage, page } from '../pages/layout.ts';
import { isAdmin, type ControlEnv, type Deps } from '../types.ts';

/**
 * The administration pages. Agents edit drafts; an administrator, a person, decides what
 * members get: publishing is only ever done from here, never by a tool.
 */
export function adminRoutes(deps: Deps): Hono<ControlEnv> {
  const { config, db } = deps;
  const t = translator(config.locale);
  const app = new Hono<ControlEnv>();
  const limiter = new RateLimiter(30, 60_000);

  app.use('/admin/*', async (c, next) => {
    const session = c.get('session');
    if (!session) return c.redirect(`/auth/start?next=${encodeURIComponent('/admin/')}`, 302);
    if (!isAdmin(config, session.user)) {
      return c.html(
        messagePage(config.locale, t('Access restricted'), t('Only an administrator can open this page.'), {
          href: '/',
          label: t('Home'),
        }),
        403,
      );
    }
    c.header('Cache-Control', 'no-store');
    await next();
  });

  app.get('/admin', (c) => c.redirect('/admin/', 302));

  app.get('/admin/', (c) => {
    const notice = c.req.query('published')
      ? t('{name} is published.', { name: c.req.query('published')! })
      : c.req.query('discarded')
        ? t('The draft of {name} was discarded.', { name: c.req.query('discarded')! })
        : null;
    const rows = listApps(db).map((row) => ({
      row,
      status: deps.apps.status(row.slug)!,
      changes: deps.apps.changes(row.slug),
    }));
    return c.html(
      page(
        config.locale,
        t('Administration'),
        html`<h1>${t('Administration')}</h1>
          ${notice ? html`<p class="notice">${notice}</p>` : ''}
          ${rows.length === 0 ? html`<p class="muted">${t('No app yet.')}</p>` : ''}
          ${rows.map(({ row, status, changes }) => {
            const draftUrl = `${appOrigin(config, siteOf(row.slug, true).label)}/`;
            const waiting = status.draft.differs;
            return html`<section class="app">
              <h2>${row.name} <span class="muted">${row.slug}</span></h2>
              <p class="muted">
                ${
                  status.live
                    ? html`<a href="${appOrigin(config, row.slug)}/">${t('Published')}</a>`
                    : t('Never published')
                }
                · ${status.draft.versionId ? html`<a href="${draftUrl}">${t('Open the draft')}</a>` : t('No draft')}
              </p>
              ${
                status.draft.problems
                  ? html`<p class="error">${t('The draft does not build:')}</p>
                      <ul>
                        ${status.draft.problems
                          .slice(0, 10)
                          .map(
                            (problem) => html`<li>${problem.file ? `${problem.file}: ` : ''}${problem.message}</li>`,
                          )}
                      </ul>`
                  : ''
              }
              ${
                waiting && changes
                  ? html`<details>
                        <summary>${t('What publishing would change')}</summary>
                        <ul>
                          ${changes.added.map((file) => html`<li>+ ${file}</li>`)}
                          ${changes.changed.map((file) => html`<li>~ ${file}</li>`)}
                          ${changes.removed.map((file) => html`<li>− ${file}</li>`)}
                        </ul>
                      </details>
                      <form class="actions" method="post" action="/admin/apps/${row.slug}/publish">
                        <button class="primary" type="submit" ${status.draft.problems ? 'disabled' : ''}>
                          ${t('Publish the draft')}
                        </button>
                      </form>
                      ${
                        status.live
                          ? html`<form class="actions" method="post" action="/admin/apps/${row.slug}/discard">
                              <button class="secondary" type="submit">${t('Discard the draft')}</button>
                            </form>`
                          : ''
                      }`
                  : ''
              }
            </section>`;
          })}
          <p class="actions"><a class="button secondary" href="/">${t('Home')}</a></p>`,
      ),
    );
  });

  app.post('/admin/apps/:slug/:action', async (c) => {
    if (!isSameOrigin(c, config.controlOrigin)) return c.text('Unexpected origin', 403);
    if (!limiter.take(clientIp(c))) return c.text('Too many requests', 429);
    const slug = c.req.param('slug');
    const action = c.req.param('action');
    const status = deps.apps.status(slug);
    if (!status || (action !== 'publish' && action !== 'discard')) return c.text('Not found', 404);
    const back = { href: '/admin/', label: t('Administration') };
    if (action === 'discard') {
      deps.apps.discardDraft(slug);
      return c.redirect(`/admin/?discarded=${encodeURIComponent(status.name)}`, 303);
    }
    const outcome = await deps.apps.publishDraft(slug);
    if (!outcome.ok) {
      const reasons = outcome.problems.map((problem) => `${problem.file ? `${problem.file}: ` : ''}${problem.message}`);
      console.warn(`[${slug}] publication refused: ${reasons.join('; ')}`);
      return c.html(
        messagePage(
          config.locale,
          t('Not published'),
          `${t('Nothing changed for the members.')} ${reasons.slice(0, 5).join(' — ')}`,
          back,
        ),
        409,
      );
    }
    console.info(`[${slug}] version ${outcome.versionId} published by ${c.get('session')!.user.email}`);
    return c.redirect(`/admin/?published=${encodeURIComponent(deps.apps.status(slug)!.name)}`, 303);
  });

  return app;
}
