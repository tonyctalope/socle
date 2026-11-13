import { createHash } from 'node:crypto';
import type { UserRow } from '../auth/users.ts';
import { all, get, run, transaction, type Db } from '../db/database.ts';
import type { BuiltApp } from '../runner/build/build.ts';
import type { BuildProblem } from '../runner/build/files.ts';
import { RunnerUnavailable, type Runner } from '../runner/client.ts';
import type { FunctionInfo } from '../runner/sandbox/call.ts';
import { isValidSlug } from './slug.ts';

// Apps as the web process keeps them: versions of source files and what the runner
// built from them, in the platform database. The runner itself keeps nothing but
// each app's own data.

/** The database of an app's published version, as the runner names it. */
export const liveDatabase = (slug: string): string => `${slug}/live`;

/** What is needed to serve one version of an app. */
export interface AppVersion {
  id: number;
  /** Names the version's files in URLs: /assets/<assetHash>/main.js never changes. */
  assetHash: string;
  js: Uint8Array<ArrayBuffer>;
  css: Uint8Array<ArrayBuffer>;
  /** Names the app's server code in the runner. Null when the app has none. */
  bundleHash: string | null;
  functions: Map<string, FunctionInfo>;
}

export type DeployOutcome =
  | { ok: true; versionId: number; unchanged: boolean; applied: string[] }
  | { ok: false; stage: 'build'; problems: BuildProblem[] }
  | { ok: false; stage: 'migrate'; problems: BuildProblem[] };

interface VersionRow {
  id: number;
  asset_hash: string;
  web_js: string;
  web_css: string;
  bundle_hash: string | null;
  functions: string;
}

const VERSION_COLUMNS = 'v.id, v.asset_hash, v.web_js, v.web_css, v.bundle_hash, v.functions';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** The same files always give the same hash, whatever order they were sent in. */
export function sourceHash(files: Record<string, string>): string {
  const hash = createHash('sha256');
  for (const name of Object.keys(files).sort()) hash.update(`${name}\0${files[name]!.length}\0${files[name]}\0`);
  return hash.digest('hex');
}

const assetHash = (web: { js: string; css: string }) => sha256(`${web.js}\0${web.css}`).slice(0, 16);

/** Versions kept per app: the published one, and enough before it to come back to. */
const KEPT_VERSIONS = 20;
/** The colors of an app that names none (the platform's own background). */
const DEFAULT_COLOR = '#f4f1ea';

/** Memory the cache of built versions may hold (their screens and stylesheets). */
const CACHE_BYTES = 48 * 1024 * 1024;

export class AppStore {
  private readonly db: Db;
  private readonly runner: Runner;
  private readonly cache = new Map<number, AppVersion>();
  private cachedBytes = 0;
  /** Called after an app's published version changed. */
  onPublish: (slug: string) => void = () => {};
  /** One deployment at a time per app: the second waits for the first. */
  private readonly deploying = new Map<string, Promise<unknown>>();

  constructor(db: Db, runner: Runner) {
    this.db = db;
    this.runner = runner;
  }

  /** A version by id. Its files are only read from the database when they are not in memory. */
  private version(id: number | null | undefined): AppVersion | null {
    if (id === null || id === undefined) return null;
    const cached = this.cache.get(id);
    if (cached) {
      // Re-insert: the map stays ordered by last use.
      this.cache.delete(id);
      this.cache.set(id, cached);
      return cached;
    }
    const row = get<VersionRow>(this.db, `SELECT ${VERSION_COLUMNS} FROM app_versions v WHERE v.id = :id`, { id });
    if (!row) return null;
    const encoder = new TextEncoder();
    const version: AppVersion = {
      id: row.id,
      assetHash: row.asset_hash,
      js: encoder.encode(row.web_js),
      css: encoder.encode(row.web_css),
      bundleHash: row.bundle_hash,
      functions: new Map((JSON.parse(row.functions) as FunctionInfo[]).map((info) => [info.name, info])),
    };
    this.cache.set(id, version);
    this.cachedBytes += version.js.length + version.css.length;
    for (const [other, old] of this.cache) {
      if (this.cachedBytes <= CACHE_BYTES || other === id) break;
      this.cache.delete(other);
      this.cachedBytes -= old.js.length + old.css.length;
    }
    return version;
  }

  /** The server code of a version, read from the database when the runner asks for it again. */
  bundleOf(versionId: number): string | null {
    return (
      get<{ server_bundle: string | null }>(this.db, 'SELECT server_bundle FROM app_versions WHERE id = :id', {
        id: versionId,
      })?.server_bundle ?? null
    );
  }

  /** The published version of an app, or null when it has none yet. */
  live(slug: string): AppVersion | null {
    return this.version(
      get<{ live_version: number | null }>(this.db, 'SELECT live_version FROM apps WHERE slug = :slug', { slug })
        ?.live_version,
    );
  }

  /** A version by the hash in its file URLs: a page opened before a publication keeps loading its own files. */
  byAssetHash(slug: string, assetHash: string): AppVersion | null {
    if (!/^[0-9a-f]{16}$/.test(assetHash)) return null;
    return this.version(
      get<{ id: number }>(
        this.db,
        'SELECT id FROM app_versions WHERE app = :slug AND asset_hash = :hash ORDER BY id DESC LIMIT 1',
        { slug, hash: assetHash },
      )?.id,
    );
  }

  /** Records a built version and publishes it. No runner involved: `deploy` is the usual way in. */
  publish(
    slug: string,
    files: Record<string, string>,
    built: Pick<BuiltApp, 'manifest' | 'web' | 'server' | 'migrations'>,
    createdBy: number | null,
  ): number {
    const now = new Date().toISOString();
    const { manifest } = built;
    const id = transaction(this.db, () => {
      run(
        this.db,
        `INSERT INTO apps (slug, name, description, created_at) VALUES (:slug, :name, :description, :now)
         ON CONFLICT(slug) DO UPDATE SET name = excluded.name, description = excluded.description`,
        { slug, name: manifest.name, description: manifest.description, now },
      );
      // A version that names no color gets the platform's, not the previous version's.
      run(this.db, 'UPDATE apps SET theme_color = :theme, background_color = :background WHERE slug = :slug', {
        slug,
        theme: manifest.themeColor ?? DEFAULT_COLOR,
        background: manifest.backgroundColor ?? DEFAULT_COLOR,
      });
      const { lastInsertRowid } = run(
        this.db,
        `INSERT INTO app_versions (app, created_at, created_by, source_hash, asset_hash, files, manifest, web_js, web_css,
           server_bundle, bundle_hash, functions, migrations)
         VALUES (:app, :now, :by, :source, :asset, :files, :manifest, :js, :css, :bundle, :hash, :functions, :migrations)`,
        {
          app: slug,
          now,
          by: createdBy,
          source: sourceHash(files),
          asset: assetHash(built.web),
          files: JSON.stringify(files),
          manifest: JSON.stringify(manifest),
          js: built.web.js,
          css: built.web.css,
          bundle: built.server?.bundle ?? null,
          hash: built.server ? sha256(built.server.bundle) : null,
          functions: JSON.stringify(built.server?.functions ?? []),
          migrations: JSON.stringify(built.migrations),
        },
      );
      run(this.db, 'UPDATE apps SET live_version = :id WHERE slug = :slug', { id: lastInsertRowid, slug });
      // A version holds the sources and everything built from them: only the last few are kept.
      const old = all<{ id: number }>(
        this.db,
        `SELECT id FROM app_versions WHERE app = :slug AND id NOT IN (
           SELECT id FROM app_versions WHERE app = :slug ORDER BY id DESC LIMIT ${KEPT_VERSIONS})`,
        { slug },
      );
      for (const row of old) {
        run(this.db, 'DELETE FROM app_versions WHERE id = :id', { id: row.id });
        this.forget(row.id);
      }
      return lastInsertRowid;
    });
    this.onPublish(slug);
    return id;
  }

  private forget(id: number): void {
    const cached = this.cache.get(id);
    if (!cached) return;
    this.cache.delete(id);
    this.cachedBytes -= cached.js.length + cached.css.length;
  }

  /**
   * Builds the files, brings the app's database up to date, then publishes. The live
   * version only changes when everything succeeded.
   */
  deploy(slug: string, files: Record<string, string>, createdBy: Pick<UserRow, 'id'> | null): Promise<DeployOutcome> {
    const previous = this.deploying.get(slug) ?? Promise.resolve();
    const next = previous.then(
      () => this.deployNow(slug, files, createdBy),
      () => this.deployNow(slug, files, createdBy),
    );
    this.deploying.set(slug, next);
    void next
      .finally(() => {
        if (this.deploying.get(slug) === next) this.deploying.delete(slug);
      })
      .catch(() => {});
    return next;
  }

  private async deployNow(
    slug: string,
    files: Record<string, string>,
    createdBy: Pick<UserRow, 'id'> | null,
  ): Promise<DeployOutcome> {
    if (!isValidSlug(slug)) {
      return { ok: false, stage: 'build', problems: [{ message: `"${slug}" is not a valid app name` }] };
    }
    // A build or a migration stopped at its deadline is an outcome of this deployment like
    // any other problem; only a runner that is not there at all is an exception.
    const stopped = (stage: 'build' | 'migrate', error: unknown): DeployOutcome => {
      if (!(error instanceof RunnerUnavailable) || !['timeout', 'memory', 'crashed'].includes(error.code)) throw error;
      const what = stage === 'build' ? 'the build' : 'the migrations';
      const why =
        error.code === 'timeout' ? 'took too long' : error.code === 'memory' ? 'used too much memory' : 'failed';
      return {
        ok: false,
        stage,
        problems: [{ message: `${what} ${why} and ${stage === 'build' ? 'was' : 'were'} stopped` }],
      };
    };

    let outcome;
    try {
      outcome = await this.runner.build(files);
    } catch (error) {
      return stopped('build', error);
    }
    if (!outcome.ok) return { ok: false, stage: 'build', problems: outcome.problems };
    const built = outcome.app;
    // The runner keeps the server code itself; calls then name it by its hash. Given before the
    // database changes: if this fails, nothing has happened yet.
    if (built.server) await this.runner.install(slug, built.server.bundle);
    let migrated;
    try {
      migrated = await this.runner.migrate(liveDatabase(slug), built.migrations);
    } catch (error) {
      return stopped('migrate', error);
    }
    if (!migrated.ok) {
      const file = migrated.migration ? `migrations/${migrated.migration}` : undefined;
      return { ok: false, stage: 'migrate', problems: [{ file, message: migrated.message }] };
    }
    // Same sources giving the same build as the live version: nothing to publish.
    const current = get<{
      id: number;
      source_hash: string;
      asset_hash: string;
      bundle_hash: string | null;
      manifest: string;
    }>(
      this.db,
      `SELECT v.id, v.source_hash, v.asset_hash, v.bundle_hash, v.manifest
       FROM apps a JOIN app_versions v ON v.id = a.live_version WHERE a.slug = :slug`,
      { slug },
    );
    if (
      current &&
      current.source_hash === sourceHash(files) &&
      current.asset_hash === assetHash(built.web) &&
      current.bundle_hash === (built.server ? sha256(built.server.bundle) : null) &&
      current.manifest === JSON.stringify(built.manifest)
    ) {
      return { ok: true, versionId: current.id, unchanged: true, applied: migrated.applied };
    }
    // The schema is now the new version's: publish at once, in the same step.
    const versionId = this.publish(slug, files, built, createdBy?.id ?? null);
    return { ok: true, versionId, unchanged: false, applied: migrated.applied };
  }
}
