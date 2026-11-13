import { Hono } from 'hono';
import { appHostApp } from './apphost/app.ts';
import { appSiteFromHost } from './config.ts';
import { controlApp } from './control/app.ts';
import { onError } from './lib/security.ts';
import type { Deps } from './types.ts';

/**
 * One server, two kinds of hosts: the control plane and one host per app. The
 * request host picks the handler; anything else gets nothing but /healthz.
 */
export function createApp(deps: Deps): Hono {
  const { config } = deps;
  const control = controlApp(deps);
  const apps = appHostApp(deps);
  const root = new Hono();

  root.all('*', async (c) => {
    const started = Date.now();
    const url = new URL(c.req.url);
    const host = url.host.toLowerCase();
    const slug = appSiteFromHost(config, host)?.label;
    let response: Response;
    if (host === config.controlHost) response = await control.fetch(c.req.raw, c.env);
    else if (slug) response = await apps.fetch(c.req.raw, c.env);
    else if (url.pathname === '/healthz') return c.json({ ok: true });
    else return c.text('Not found', 404);
    // Access log without query strings: they carry sign-on codes.
    if (url.pathname !== '/healthz' && !url.pathname.includes('/icons/')) {
      console.info(`${c.req.method} ${slug ?? 'control'} ${url.pathname} ${response.status} ${Date.now() - started}ms`);
    }
    return response;
  });

  root.onError(onError);
  return root;
}
