import type { UserRow } from '../auth/users.ts';
import { all, get, run, type Db } from '../db/database.ts';

export interface AppRow {
  slug: string;
  name: string;
  description: string;
  theme_color: string;
  background_color: string;
  created_at: string;
}

export const DEMO_SLUG = 'demo';

export function getApp(db: Db, slug: string): AppRow | undefined {
  return get<AppRow>(db, 'SELECT * FROM apps WHERE slug = :slug', { slug });
}

export function listApps(db: Db): AppRow[] {
  return all<AppRow>(db, 'SELECT * FROM apps ORDER BY name COLLATE NOCASE');
}

/**
 * Who may open an app. Every signed-in household member for now; per-app access
 * lists arrive with app creation, and this is the single place they will be read.
 */
export function canAccess(_user: UserRow, _app: AppRow): boolean {
  return true;
}

/** The built-in demo app exists exactly while DEMO_APP is on. */
export function syncDemoApp(db: Db, enabled: boolean): void {
  if (!enabled) {
    run(db, 'DELETE FROM apps WHERE slug = :slug', { slug: DEMO_SLUG });
    return;
  }
  run(
    db,
    `INSERT INTO apps (slug, name, description, created_at) VALUES (:slug, 'Démo', :description, :now)
     ON CONFLICT(slug) DO NOTHING`,
    {
      slug: DEMO_SLUG,
      description: 'Vérifie la connexion, l’installation sur l’écran d’accueil et les notifications.',
      now: new Date().toISOString(),
    },
  );
}
