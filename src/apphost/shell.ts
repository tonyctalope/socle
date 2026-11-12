import { html } from 'hono/html';
import type { AppRow } from '../apps/registry.ts';

/**
 * The HTML document of an app. Apps never write it themselves: the platform owns the
 * <head> (manifest, icons, theme), so every app installs the same way and no inline
 * script is ever needed.
 */
export function shellPage(app: AppRow, entry: { script: string; style: string | null }) {
  return html`<!doctype html>
    <html lang="fr">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>${app.name}</title>
        <meta name="description" content="${app.description}" />
        <meta name="robots" content="noindex" />
        <meta name="color-scheme" content="light dark" />
        <meta name="theme-color" content="${app.theme_color}" />
        <link rel="manifest" href="/_socle/manifest.webmanifest" />
        <link rel="icon" href="/_socle/icons/icon-192.png" type="image/png" />
        <link rel="apple-touch-icon" href="/_socle/icons/apple-touch-icon.png" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="${app.name}" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        ${entry.style ? html`<link rel="stylesheet" href="${entry.style}" />` : ''}
      </head>
      <body>
        <div id="root"></div>
        <noscript>${app.name} a besoin de JavaScript pour fonctionner.</noscript>
        <script type="module" src="${entry.script}"></script>
      </body>
    </html>`;
}
