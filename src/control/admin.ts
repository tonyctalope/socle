import { Hono } from 'hono';
import { html } from 'hono/html';
import { accessList, DEMO_SLUG, getApp, listApps } from '../apps/registry.ts';
import type { DeployOutcome } from '../apps/store.ts';
import { siteOf } from '../apps/slug.ts';
import { appOrigin } from '../config.ts';
import { translator } from '../i18n.ts';
import { clientIp, isSameOrigin, RateLimiter } from '../lib/http.ts';
import { appResource } from '../mcp/app.ts';
import { revokeResource } from '../oauth/tokens.ts';
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

  // The demo app comes back at every start while DEMO_APP is on: removing it would be undone.
  const removable = (slug: string) => !(config.demoApp && slug === DEMO_SLUG);

  app.get('/admin/', (c) => {
    // The address only names an app: what the notice says is read from the app's own state, so
    // that a link from elsewhere cannot make this page announce what did not happen.
    const done = (param: string) => deps.apps.status(c.req.query(param) ?? '');
    const published = done('published');
    const discarded = done('discarded');
    const settled = (status: typeof published) => status?.live && !status.draft.differs;
    const notice = settled(published)
      ? t('{name} is published.', { name: published!.name })
      : settled(discarded)
        ? t('The draft of {name} was discarded.', { name: discarded!.name })
        : c.req.query('removed') && !done('removed')
          ? t('The app was removed.')
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
                        <input type="hidden" name="version" value="${status.draft.versionId ?? ''}" />
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
              <p class="muted"><a href="/admin/apps/${row.slug}/">${t('Versions, access, removal…')}</a></p>
            </section>`;
          })}
          <p class="actions"><a class="button secondary" href="/">${t('Home')}</a></p>`,
      ),
    );
  });

  const when = new Intl.DateTimeFormat(config.locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: config.timezone,
  });

  // One app: the versions members had, who can open it, and its removal.
  app.get('/admin/apps/:slug/', (c) => {
    const row = getApp(db, c.req.param('slug'));
    if (!row) return c.text('Not found', 404);
    const versions = deps.apps.versions(row.slug);
    const limited = accessList(row);
    const saved = c.req.query('saved') !== undefined;
    return c.html(
      page(
        config.locale,
        row.name,
        html`<h1>${row.name} <span class="muted">${row.slug}</span></h1>
          ${saved ? html`<p class="notice">${t('Saved.')}</p>` : ''}
          <h2>${t('Published versions')}</h2>
          ${versions.length === 0 ? html`<p class="muted">${t('Never published')}</p>` : ''}
          <ul class="plain">
            ${versions.map(
              (version) =>
                html`<li>
                  ${when.format(new Date(version.publishedAt))}
                  ${
                    version.live
                      ? html`<strong>· ${t('published now')}</strong>`
                      : version.canReturn
                        ? html`<form class="inline" method="post" action="/admin/apps/${row.slug}/return">
                            <input type="hidden" name="version" value="${version.id}" />
                            <button class="link" type="submit">${t('Come back to this version')}</button>
                          </form>`
                        : html`<span class="muted">· ${t('the data changed shape since')}</span>`
                  }
                </li>`,
            )}
          </ul>
          <p class="muted">
            ${t(
              'Coming back to a version brings back its screens and functions; what people put in the app stays as it is.',
            )}
          </p>
          <h2>${t('Who can open it')}</h2>
          <form method="post" action="/admin/apps/${row.slug}/access">
            <label class="choice">
              <input type="radio" name="who" value="everyone" ${limited === null ? 'checked' : ''} />
              ${t('Every member')}
            </label>
            <label class="choice">
              <input type="radio" name="who" value="some" ${limited === null ? '' : 'checked'} />
              ${t('Only these members:')}
            </label>
            ${[...config.allowedEmails].sort().map(
              (email) =>
                html`<label class="choice indent">
                  <input type="checkbox" name="email" value="${email}" ${limited?.includes(email) ? 'checked' : ''} />
                  ${email}
                </label>`,
            )}
            <p class="actions"><button class="secondary" type="submit">${t('Save')}</button></p>
          </form>
          ${
            removable(row.slug)
              ? html`<p class="muted"><a href="/admin/apps/${row.slug}/remove">${t('Remove this app…')}</a></p>`
              : ''
          }
          <p class="actions"><a class="button secondary" href="/admin/">${t('Administration')}</a></p>`,
      ),
    );
  });

  // Removing asks twice: this page, then its button.
  app.get('/admin/apps/:slug/remove', (c) => {
    const status = deps.apps.status(c.req.param('slug'));
    if (!status || !removable(status.slug)) return c.text('Not found', 404);
    return c.html(
      page(
        config.locale,
        t('Remove {name}?', { name: status.name }),
        html`<h1>${t('Remove {name}?', { name: status.name })}</h1>
          <p>
            ${t(
              'The app disappears for everyone, with its draft and everything people put in it. Its data stays on the server for a month, out of reach of the app, then is deleted.',
            )}
          </p>
          <form class="actions" method="post" action="/admin/apps/${status.slug}/remove">
            <button class="danger" type="submit">${t('Remove {name}', { name: status.name })}</button>
          </form>
          <p class="actions"><a class="button secondary" href="/admin/">${t('Cancel')}</a></p>`,
      ),
    );
  });

  app.post('/admin/apps/:slug/:action', async (c) => {
    if (!isSameOrigin(c, config.controlOrigin)) return c.text('Unexpected origin', 403);
    if (!limiter.take(clientIp(c))) return c.text('Too many requests', 429);
    const slug = c.req.param('slug');
    const action = c.req.param('action');
    const status = deps.apps.status(slug);
    if (!status || !['publish', 'discard', 'remove', 'return', 'access'].includes(action)) {
      return c.text('Not found', 404);
    }
    const back = { href: '/admin/', label: t('Administration') };
    if (action === 'remove') {
      if (!removable(slug)) return c.text('Not found', 404);
      const removed = await deps.apps.remove(slug);
      if (!removed.ok) {
        console.warn(`[${slug}] removal refused: ${removed.message}`);
        return c.html(messagePage(config.locale, t('Not removed'), t('The app is still there, unchanged.'), back), 409);
      }
      // An app created later under the same name is another app: nobody stays connected to it.
      revokeResource(db, appResource(config, slug));
      console.info(`[${slug}] removed by ${c.get('session')!.user.email}`);
      return c.redirect(`/admin/?removed=${slug}`, 303);
    }
    const refusal = (title: string, outcome: Extract<DeployOutcome, { ok: false }>) => {
      const reasons = outcome.problems.map((problem) => `${problem.file ? `${problem.file}: ` : ''}${problem.message}`);
      console.warn(`[${slug}] ${action} refused: ${reasons.join('; ')}`);
      return c.html(
        messagePage(
          config.locale,
          title,
          `${t('Nothing changed for the members.')} ${reasons.slice(0, 5).join(' — ')}`,
          back,
        ),
        409,
      );
    };
    if (action === 'discard') {
      const discarding = await deps.apps.discardDraft(slug);
      if (!discarding.ok) return refusal(t('Not discarded'), discarding);
      return c.redirect(`/admin/?discarded=${slug}`, 303);
    }
    const form = await c.req.parseBody({ all: true }).catch(() => ({}) as Record<string, unknown>);
    if (action === 'access') {
      // Only addresses of the allowlist can be listed: the form cannot name anyone else.
      const chosen = [form.email].flat().filter((email): email is string => typeof email === 'string');
      const emails =
        form.who === 'some' ? chosen.filter((email) => config.allowedEmails.has(email.toLowerCase())) : null;
      deps.apps.setAccess(slug, emails);
      console.info(
        `[${slug}] access set by ${c.get('session')!.user.email}: ${emails ? `${emails.length} member(s)` : 'every member'}`,
      );
      return c.redirect(`/admin/apps/${slug}/?saved`, 303);
    }
    if (action === 'return') {
      const target = Number(form.version);
      if (!Number.isInteger(target) || target <= 0) return c.text('Invalid request', 400);
      const returning = await deps.apps.returnTo(slug, target);
      if (!returning.ok) return refusal(t('Not changed'), returning);
      console.info(`[${slug}] back to version ${target}, by ${c.get('session')!.user.email}`);
      return c.redirect(`/admin/apps/${slug}/?saved`, 303);
    }
    // The form names the draft version its page showed: a draft built again since is not
    // published in its place.
    const shown = Number(form.version);
    if (!Number.isInteger(shown) || shown <= 0) return c.text('Invalid request', 400);
    const outcome = await deps.apps.publishDraft(slug, shown);
    if (!outcome.ok) return refusal(t('Not published'), outcome);
    console.info(`[${slug}] version ${outcome.versionId} published by ${c.get('session')!.user.email}`);
    return c.redirect(`/admin/?published=${slug}`, 303);
  });

  return app;
}
