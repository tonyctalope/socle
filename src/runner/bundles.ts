import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// The server code of each app, kept by the runner next to the app's data and named
// by its hash. A call then only says which code it wants: the code itself travels
// once, when the app is published, instead of with every call.

const APP = /^[a-z][a-z0-9-]{0,31}$/;
const HASH = /^[0-9a-f]{64}$/;
/** Versions kept per app: the published one, and a few before it for pages that are still open. */
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
