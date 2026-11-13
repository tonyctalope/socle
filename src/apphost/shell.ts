import { html, raw } from 'hono/html';
import type { AppRow } from '../apps/registry.ts';
import type { Translate } from '../i18n.ts';

/** What the platform tells the app's code about who is looking at it (read by @socle/sdk). */
export interface BootData {
  user: { id: number; name: string };
  app: { slug: string; name: string };
  members: { id: number; name: string }[];
  push: { publicKey: string };
  /** Language of the platform's own words (the kit's components follow it). */
  locale: string;
}

const VENDOR = '/_socle/vendor';
/** Fetched in parallel with the app's own script instead of one after the other. */
const PRELOADED = ['react.js', 'react-jsx-runtime.js', 'react-dom.js', 'sdk.js', 'ui.js'];

/** JSON that can sit inside a <script> element: nothing in it can close the element or start markup. */
function embeddedJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * The HTML document of an app. Apps never write it themselves: the platform owns the
 * <head> (manifest, icons, theme) and the loading of scripts, so every app installs
 * the same way and no inline script is ever needed. The boot data is a JSON block:
 * browsers do not execute it, the SDK reads it.
 */
export function shellPage(app: AppRow, assetHash: string, boot: BootData, t: Translate, draft = false) {
  const title = draft ? `${app.name} (draft)` : app.name;
  return html`<!doctype html>
    <html lang="${boot.locale}">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>${title}</title>
        <meta name="description" content="${app.description}" />
        <meta name="robots" content="noindex" />
        <meta name="color-scheme" content="light dark" />
        <meta name="theme-color" content="${app.theme_color}" />
        <link rel="manifest" href="/_socle/manifest.webmanifest" />
        <link rel="icon" href="/_socle/icons/icon-192.png" type="image/png" />
        <link rel="apple-touch-icon" href="/_socle/icons/apple-touch-icon.png" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="${title}" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <link rel="stylesheet" href="${VENDOR}/ui.css" />
        <link rel="stylesheet" href="/assets/${assetHash}/style.css" />
        ${PRELOADED.map((file) => html`<link rel="modulepreload" href="${VENDOR}/${file}" />`)}
      </head>
      <body>
        <div id="root"></div>
        <noscript>${t('{name} needs JavaScript to work.', { name: app.name })}</noscript>
        <script id="socle-boot" type="application/json">
          ${raw(embeddedJson(boot))}
        </script>
        <script type="module" src="/assets/${assetHash}/main.js"></script>
      </body>
    </html>`;
}
