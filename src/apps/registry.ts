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
  /** The last draft that built (app_versions.id), served on the draft address. */
  draft_version: number | null;
  created_by: number | null;
  /** Who can open the app: null for every member, else a JSON array of e-mail addresses. */
  access: string | null;
}

export const DEMO_SLUG = 'demo';

export function getApp(db: Db, slug: string): AppRow | undefined {
  return get<AppRow>(db, 'SELECT * FROM apps WHERE slug = :slug', { slug });
}

export function listApps(db: Db): AppRow[] {
  return all<AppRow>(db, 'SELECT * FROM apps ORDER BY name COLLATE NOCASE');
}

/** The e-mail addresses an app is limited to, or null when every member can open it. */
export function accessList(app: Pick<AppRow, 'access'>): string[] | null {
  if (app.access === null) return null;
  try {
    const list: unknown = JSON.parse(app.access);
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return []; // unreadable: nobody, rather than everybody
  }
}

/**
 * Who may open an app: every member, or the members an administrator listed for it. This is
 * the single place the list is read: sessions, sign-on, the home page, what an app is told
 * about its members and its MCP endpoint all ask here.
 */
export function canAccess(user: Pick<UserRow, 'email'>, app: Pick<AppRow, 'access'>): boolean {
  const list = accessList(app);
  return list === null || list.includes(user.email.toLowerCase());
}

/** Everyone who can open an app, as apps see them: an id and a display name, never the e-mail address. */
export function appMembers(db: Db, app: AppRow, isAllowed: (email: string) => boolean): { id: number; name: string }[] {
  return all<UserRow>(db, 'SELECT * FROM users ORDER BY id')
    .filter((user) => isAllowed(user.email) && canAccess(user, app))
    .map((user) => ({ id: user.id, name: displayName(user) }));
}
