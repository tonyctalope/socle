import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Site } from '../apps/slug.ts';
import { all, get, run, type Db } from '../db/database.ts';

// The files of the apps: photos and documents that members add. They are kept by the web
// process, next to the platform database, one folder per address of an app (a draft's
// files are not the published app's). The platform never looks inside a file beyond its
// first bytes, which say what it is; it stores it, and serves it back to the members of
// that app with the type it recognised.

export const FILE_LIMITS = {
  /** One file. A photo is resized by the browser before it is sent, so this is generous. */
  maxBytes: 8 * 1024 * 1024,
  /** Everything one address of an app holds. */
  siteBytes: 1024 * 1024 * 1024,
  siteFiles: 20_000,
};

/** What is accepted, recognised from the first bytes: pictures browsers display as they are, and PDF. */
const SIGNATURES: { type: string; matches: (bytes: Uint8Array) => boolean }[] = [
  { type: 'image/jpeg', matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/png', matches: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { type: 'image/gif', matches: (b) => startsWith(b, [0x47, 0x49, 0x46, 0x38]) },
  {
    type: 'image/webp',
    matches: (b) => startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b.subarray(8), [0x57, 0x45, 0x42, 0x50]),
  },
  { type: 'application/pdf', matches: (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]) },
];

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

/** The type of a file from its content, or null for anything the platform does not keep. */
export function recognise(bytes: Uint8Array): string | null {
  return SIGNATURES.find((signature) => signature.matches(bytes))?.type ?? null;
}

export interface StoredFile {
  id: string;
  type: string;
  bytes: number;
  createdAt: string;
}

export type Stored = { ok: true; file: StoredFile } | { ok: false; reason: 'empty' | 'too_large' | 'type' | 'full' };

const ID = /^[0-9a-f]{32}$/;
const REMOVED = '.removed';
const REMOVED_DAYS = 30;

export class FileStore {
  private readonly db: Db;
  private readonly root: string;

  constructor(db: Db, dataDir: string) {
    this.db = db;
    this.root = path.join(dataDir, 'files');
  }

  private dir(site: Site): string {
    return path.join(this.root, site.label);
  }

  /** Keeps a file a member sent, if it is of a kind the platform keeps and the app has room. */
  save(site: Site, userId: number, bytes: Uint8Array): Stored {
    if (bytes.byteLength === 0) return { ok: false, reason: 'empty' };
    if (bytes.byteLength > FILE_LIMITS.maxBytes) return { ok: false, reason: 'too_large' };
    const type = recognise(bytes);
    if (!type) return { ok: false, reason: 'type' };
    const held = get<{ files: number; bytes: number }>(
      this.db,
      'SELECT COUNT(*) AS files, COALESCE(SUM(bytes), 0) AS bytes FROM app_files WHERE site = :site',
      { site: site.label },
    )!;
    if (held.files >= FILE_LIMITS.siteFiles || held.bytes + bytes.byteLength > FILE_LIMITS.siteBytes) {
      return { ok: false, reason: 'full' };
    }
    const id = randomBytes(16).toString('hex');
    const createdAt = new Date().toISOString();
    const dir = this.dir(site);
    mkdirSync(dir, { recursive: true });
    // Written under another name first: a file that is listed is whole.
    const partial = path.join(dir, `${id}.partial`);
    writeFileSync(partial, bytes);
    renameSync(partial, path.join(dir, id));
    run(
      this.db,
      `INSERT INTO app_files (id, site, app, user_id, type, bytes, created_at)
       VALUES (:id, :site, :app, :user, :type, :bytes, :now)`,
      { id, site: site.label, app: site.slug, user: userId, type, bytes: bytes.byteLength, now: createdAt },
    );
    return { ok: true, file: { id, type, bytes: bytes.byteLength, createdAt } };
  }

  /** A file of this address, with its content. Null for an id of another address, or of none. */
  read(site: Site, id: string): (StoredFile & { content: Uint8Array<ArrayBuffer> }) | null {
    if (!ID.test(id)) return null;
    const row = get<{ type: string; bytes: number; created_at: string }>(
      this.db,
      'SELECT type, bytes, created_at FROM app_files WHERE id = :id AND site = :site',
      { id, site: site.label },
    );
    if (!row) return null;
    try {
      const content = new Uint8Array(readFileSync(path.join(this.dir(site), id)));
      return { id, type: row.type, bytes: row.bytes, createdAt: row.created_at, content };
    } catch {
      return null; // listed, but its content is gone (a restore without the files, for instance)
    }
  }

  /** Deletes files of this address (ids of another address are ignored). */
  remove(site: Site, ids: readonly string[]): number {
    let removed = 0;
    for (const id of ids) {
      if (!ID.test(id)) continue;
      const { changes } = run(this.db, 'DELETE FROM app_files WHERE id = :id AND site = :site', {
        id,
        site: site.label,
      });
      if (changes === 0) continue;
      rmSync(path.join(this.dir(site), id), { force: true });
      removed += 1;
    }
    return removed;
  }

  /** Deletes everything one address holds: a draft whose data starts again. */
  clear(site: Site): void {
    run(this.db, 'DELETE FROM app_files WHERE site = :site', { site: site.label });
    rmSync(this.dir(site), { recursive: true, force: true });
  }

  /** Sets aside the files of an app that was removed (its rows went with the app). */
  setAside(sites: readonly Site[], now = Date.now()): void {
    for (const site of sites) {
      const dir = this.dir(site);
      try {
        statSync(dir);
      } catch {
        continue;
      }
      const aside = path.join(this.root, REMOVED);
      mkdirSync(aside, { recursive: true });
      const target = path.join(aside, `${site.label}-${new Date(now).toISOString().replace(/[:.]/g, '-')}`);
      renameSync(dir, target);
    }
  }

  /** Deletes for good what was set aside more than a month ago, and half-written files. */
  purge(now = Date.now()): void {
    const aside = path.join(this.root, REMOVED);
    let entries: string[] = [];
    try {
      entries = readdirSync(aside);
    } catch {
      // nothing was ever removed
    }
    for (const entry of entries) {
      const full = path.join(aside, entry);
      // The name carries the date of the removal; the folder's own date is its files'.
      const stamp = /-(\d{4}-\d{2}-\d{2})T/.exec(entry)?.[1];
      const removedAt = stamp ? Date.parse(`${stamp}T00:00:00Z`) : statSync(full).mtimeMs;
      if (now - removedAt > REMOVED_DAYS * 24 * 3600 * 1000) rmSync(full, { recursive: true, force: true });
    }
  }

  /** How much one address holds. */
  usage(site: Site): { files: number; bytes: number } {
    return get<{ files: number; bytes: number }>(
      this.db,
      'SELECT COUNT(*) AS files, COALESCE(SUM(bytes), 0) AS bytes FROM app_files WHERE site = :site',
      { site: site.label },
    )!;
  }

  /** Ids of the files of an address, most recent first (for tests and tools). */
  list(site: Site, limit = 100): StoredFile[] {
    return all<{ id: string; type: string; bytes: number; created_at: string }>(
      this.db,
      'SELECT id, type, bytes, created_at FROM app_files WHERE site = :site ORDER BY created_at DESC, id LIMIT :limit',
      { site: site.label, limit },
    ).map((row) => ({ id: row.id, type: row.type, bytes: row.bytes, createdAt: row.created_at }));
  }
}
