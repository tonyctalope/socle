import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// The server code of each app, kept by the runner next to the app's data and named
// by its hash. A call then only says which code it wants: the code itself travels
// once, when the app is published, instead of with every call.

const APP = /^[a-z][a-z0-9-]{0,31}$/;
const HASH = /^[0-9a-f]{64}$/;
/**
 * Bundles kept per app: the most recent installs, drafts included. A published bundle that
 * drafts pushed out is not lost: the web side sends it again when a call names it.
 */
const KEEP = 6;
const MAX_CACHED = 16;

export const bundleHash = (code: string): string => createHash('sha256').update(code).digest('hex');

export class BundleStore {
  private readonly appsDir: string;
  private readonly cache = new Map<string, string>();

  constructor(appsDir: string) {
    this.appsDir = appsDir;
  }

  private dir(app: string): string {
    if (!APP.test(app)) throw new Error(`invalid app name: ${app}`);
    return path.join(this.appsDir, app, 'bundles');
  }

  /** Stores the code and returns its hash. */
  install(app: string, code: string): string {
    const dir = this.dir(app);
    const hash = bundleHash(code);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${hash}.js`);
    // Written under another name first: a reader never sees half a file.
    const partial = `${file}.${process.pid}.partial`;
    writeFileSync(partial, code);
    renameSync(partial, file);
    const old = readdirSync(dir)
      .filter((entry) => HASH.test(entry.slice(0, -3)) && entry.endsWith('.js') && entry !== `${hash}.js`)
      .map((entry) => ({ entry, time: statSync(path.join(dir, entry)).mtimeMs }))
      .sort((a, b) => b.time - a.time)
      .slice(KEEP - 1);
    for (const { entry } of old) rmSync(path.join(dir, entry), { force: true });
    return hash;
  }

  /** The code with that hash, or null when this runner does not have it (the caller sends it again). */
  load(app: string, hash: string): string | null {
    if (!HASH.test(hash)) return null;
    const key = `${app}/${hash}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    let code: string;
    try {
      code = readFileSync(path.join(this.dir(app), `${hash}.js`), 'utf8');
    } catch {
      return null;
    }
    if (bundleHash(code) !== hash) return null; // damaged on disk: ask for it again
    this.cache.set(key, code);
    if (this.cache.size > MAX_CACHED) this.cache.delete(this.cache.keys().next().value!);
    return code;
  }
}

/** Where removed apps wait before they are deleted for good. The name can never be an app's. */
const REMOVED = '.removed';
const REMOVED_DAYS = 30;

/**
 * Takes an app's folder (its databases, their copies, its code) out of service by moving
 * it aside: a deletion asked by mistake can be undone by hand for a month. Returns false
 * when the runner had nothing for that app.
 */
export function removeApp(appsDir: string, app: string, now = Date.now()): boolean {
  if (!APP.test(app)) throw new Error(`invalid app name: ${app}`);
  const aside = path.join(appsDir, REMOVED);
  mkdirSync(aside, { recursive: true });
  for (const entry of readdirSync(aside)) {
    const full = path.join(aside, entry);
    if (now - statSync(full).mtimeMs > REMOVED_DAYS * 24 * 3600 * 1000) rmSync(full, { recursive: true, force: true });
  }
  const dir = path.join(appsDir, app);
  try {
    statSync(dir);
  } catch {
    return false;
  }
  const target = path.join(aside, `${app}-${new Date(now).toISOString().replace(/[:.]/g, '-')}`);
  renameSync(dir, target);
  // The folder's own date says when it was removed, whatever its files' dates are.
  utimesSync(target, new Date(now), new Date(now));
  return true;
}
