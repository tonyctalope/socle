import type { AppRow } from '../apps/registry.ts';

/** Web app manifest of one app. Each app is its own origin, so id, scope and start URL are all "/". */
export function appManifest(app: AppRow, lang: string, draft = false, iconStamp = ''): Record<string, unknown> {
  // Installed side by side, the draft must not be mistaken for the app itself.
  const name = draft ? `${app.name} (draft)` : app.name;
  const icon = (file: string, size: number, purpose: 'any' | 'maskable') => ({
    // The stamp changes with the icon: a phone that installed the app fetches the new picture.
    src: `/_socle/icons/${file}${iconStamp}`,
    sizes: `${size}x${size}`,
    type: 'image/png',
    purpose,
  });
  return {
    id: '/',
    name,
    short_name: name,
    description: app.description,
    lang,
    dir: 'ltr',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: app.background_color,
    theme_color: app.theme_color,
    icons: [
      icon('icon-192.png', 192, 'any'),
      icon('icon-512.png', 512, 'any'),
      icon('icon-maskable-192.png', 192, 'maskable'),
      icon('icon-maskable-512.png', 512, 'maskable'),
    ],
  };
}
