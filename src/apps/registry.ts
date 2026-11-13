import { displayName, type UserRow } from '../auth/users.ts';
import { all, get, type Db } from '../db/database.ts';

export interface AppRow {
  slug: string;
  name: string;
  description: string;
  theme_color: string;
  background_color: string;
  created_at: string;
  /** The published version (app_versions.id), or null while the app has none. */
  live_version: number | null;
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

/** Everyone who can open an app, as apps see them: an id and a display name, never the e-mail address. */
export function appMembers(db: Db, app: AppRow, isAllowed: (email: string) => boolean): { id: number; name: string }[] {
  return all<UserRow>(db, 'SELECT * FROM users ORDER BY id')
    .filter((user) => isAllowed(user.email) && canAccess(user, app))
    .map((user) => ({ id: user.id, name: displayName(user) }));
}
