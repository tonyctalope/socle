import { get, run, type Db } from '../db/database.ts';

export interface UserRow {
  id: number;
  google_sub: string | null;
  email: string;
  name: string | null;
  created_at: string;
  last_login_at: string | null;
}

export function upsertUser(db: Db, input: { sub: string | null; email: string; name: string | null }): UserRow {
  const now = new Date().toISOString();
  const email = input.email.toLowerCase();
  const existing =
    (input.sub ? get<UserRow>(db, 'SELECT * FROM users WHERE google_sub = :sub', { sub: input.sub }) : undefined) ??
    get<UserRow>(db, 'SELECT * FROM users WHERE email = :email', { email });
  if (existing) {
    run(
      db,
      `UPDATE users SET google_sub = COALESCE(:sub, google_sub), email = :email, name = COALESCE(:name, name),
         last_login_at = :now WHERE id = :id`,
      { sub: input.sub, email, name: input.name, now, id: existing.id },
    );
    return getUser(db, existing.id)!;
  }
  const { lastInsertRowid } = run(
    db,
    `INSERT INTO users (google_sub, email, name, created_at, last_login_at) VALUES (:sub, :email, :name, :now, :now)`,
    { sub: input.sub, email, name: input.name, now },
  );
  return getUser(db, lastInsertRowid)!;
}

export function getUser(db: Db, id: number): UserRow | undefined {
  return get<UserRow>(db, 'SELECT * FROM users WHERE id = :id', { id });
}

export function displayName(user: Pick<UserRow, 'name' | 'email'>): string {
  return user.name?.trim() || user.email.split('@')[0]!;
}
