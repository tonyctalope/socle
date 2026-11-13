import { html, raw } from 'hono/html';

// Server-rendered pages (sign-in, home, errors): no JavaScript, and every
// interpolation is escaped by hono/html.

const STYLE = raw(`<style>
:root{color-scheme:light dark;--bg:#f4f1ea;--card:#fffdf8;--ink:#1f2430;--muted:#5f6675;--line:#dcd6c8;--accent:#2f5d8a;--accent-ink:#fff;--danger:#a3341f}
@media (prefers-color-scheme:dark){:root{--bg:#12151b;--card:#1b1f27;--ink:#e7ebf2;--muted:#a2abbb;--line:#2d3340;--accent:#8ab4e6;--accent-ink:#0f1620;--danger:#ff8a73}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px 16px}
main{width:100%;max-width:460px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:28px 24px;box-shadow:0 10px 30px rgb(0 0 0/.06)}
.logo{width:48px;height:48px;border-radius:12px;display:block;margin-bottom:10px}h1{font-size:1.35rem;margin:.2em 0 .6em;line-height:1.25}h2{font-size:1rem;margin:1.4em 0 .5em;color:var(--muted);font-weight:600}p{margin:.6em 0}.muted{color:var(--muted);font-size:.93rem}
.apps{list-style:none;margin:0;padding:0;display:grid;gap:10px}.apps a{display:flex;gap:12px;align-items:center;padding:12px 14px;border:1px solid var(--line);border-radius:14px;color:inherit;text-decoration:none}
.apps img{width:44px;height:44px;border-radius:11px;flex:none}.apps strong{display:block}.apps span{color:var(--muted);font-size:.9rem;display:block}
.actions{margin-top:20px}
button,.button{display:block;width:100%;border:0;border-radius:12px;padding:13px 16px;font:600 1rem system-ui,sans-serif;cursor:pointer;text-align:center;text-decoration:none}
.primary{background:var(--accent);color:var(--accent-ink)}.secondary{background:transparent;color:var(--ink);border:1px solid var(--line)}
a:focus-visible,button:focus-visible,.button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.error{color:var(--danger);font-weight:600}.notice{border:1px solid var(--line);border-radius:12px;padding:10px 14px}
.app{border-top:1px solid var(--line);margin-top:18px}.app h2{color:var(--ink);font-size:1.1rem}.app h2 span{font-weight:400;font-size:.9rem}
details{margin:.6em 0}summary{cursor:pointer;color:var(--muted)}.actions+.actions{margin-top:10px}button:disabled{opacity:.5;cursor:default}a{color:var(--accent)}ul{padding-left:1.2em}li{margin:.25em 0}
</style>`);

/**
 * `iconPrefix` is where the platform icons live on the host that renders the page:
 * /icons on the control plane, /_socle/icons on an app host.
 */
export function page(lang: string, title: string, body: unknown, iconPrefix = '/icons') {
  return html`<!doctype html>
    <html lang="${lang}">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>${title} · Socle</title>
        <link rel="icon" href="${iconPrefix}/icon-192.png" type="image/png" />
        ${STYLE}
      </head>
      <body>
        <main>${body}</main>
      </body>
    </html>`;
}

export function messagePage(
  lang: string,
  title: string,
  message: string,
  link?: { href: string; label: string },
  iconPrefix = '/icons',
) {
  return page(
    lang,
    title,
    html`<img class="logo" src="${iconPrefix}/icon-192.png" alt="" />
      <h1>${title}</h1>
      <p>${message}</p>
      ${link ? html`<p class="actions"><a class="button primary" href="${link.href}">${link.label}</a></p>` : ''}`,
    iconPrefix,
  );
}
