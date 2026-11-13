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
/** The database its draft runs on: nothing a draft does reaches the published data. */
export const draftDatabase = (slug: string): string => `${slug}/draft`;

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

export type Target = 'live' | 'draft';

/** Where an app stands: what is published, and what its draft would change. */
export interface AppStatus {
  slug: string;
  name: string;
  description: string;
  live: { versionId: number; publishedAt: string | null } | null;
  draft: {
    /** The last draft that built, or null when none did yet. */
    versionId: number | null;
    updatedAt: string | null;
    /** What stopped the last build, or null when it built. */
    problems: BuildProblem[] | null;
    /** True when publishing would change something. */
    differs: boolean;
  };
}

export interface LogLine {
  at: string;
  target: Target;
  level: string;
  fn: string | null;
  message: string;
}

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
/** Apps an instance holds; creating one is a tool agents have. */
const MAX_APPS = 100;
/** Log lines kept per app, and how long one may be. */
const KEPT_LOGS = 300;
const MAX_LOG_LENGTH = 2000;
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
  /** Called after an app's draft was built again. */
  onDraft: (slug: string) => void = () => {};
  /** One build or publication at a time per app: the second waits for the first. */
  private readonly working = new Map<string, Promise<unknown>>();

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

  /** The last draft of an app that built, or null when it has none. */
  draft(slug: string): AppVersion | null {
    return this.version(
      get<{ draft_version: number | null }>(this.db, 'SELECT draft_version FROM apps WHERE slug = :slug', { slug })
        ?.draft_version,
    );
  }

  /** What one of the app's two addresses serves. */
  serving(slug: string, target: Target): AppVersion | null {
    return target === 'draft' ? this.draft(slug) : this.live(slug);
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

  /** Writes a built version down. `publishedAt` is null for a version that is only a draft so far. */
  private record(
    slug: string,
    files: Record<string, string>,
    built: Pick<BuiltApp, 'manifest' | 'web' | 'server' | 'migrations'>,
    createdBy: number | null,
    publishedAt: string | null,
  ): number {
    return run(
      this.db,
      `INSERT INTO app_versions (app, created_at, created_by, source_hash, asset_hash, files, manifest, web_js, web_css,
         server_bundle, bundle_hash, functions, migrations, published_at)
       VALUES (:app, :now, :by, :source, :asset, :files, :manifest, :js, :css, :bundle, :hash, :functions, :migrations,
         :published)`,
      {
        app: slug,
        now: new Date().toISOString(),
        by: createdBy,
        source: sourceHash(files),
        asset: assetHash(built.web),
        files: JSON.stringify(files),
        manifest: JSON.stringify(built.manifest),
        js: built.web.js,
        css: built.web.css,
        bundle: built.server?.bundle ?? null,
        hash: built.server ? sha256(built.server.bundle) : null,
        functions: JSON.stringify(built.server?.functions ?? []),
        migrations: JSON.stringify(built.migrations),
        published: publishedAt,
      },
    ).lastInsertRowid;
  }

  /** Points the app at a version as its published one, with the name and colors that version gives it. */
  private setLive(slug: string, versionId: number, manifest: BuiltApp['manifest'], now: string): void {
    // A version that names no color gets the platform's, not the previous version's.
    run(
      this.db,
      `UPDATE apps SET name = :name, description = :description, theme_color = :theme, background_color = :background,
         live_version = :id WHERE slug = :slug`,
      {
        slug,
        id: versionId,
        name: manifest.name,
        description: manifest.description,
        theme: manifest.themeColor ?? DEFAULT_COLOR,
        background: manifest.backgroundColor ?? DEFAULT_COLOR,
      },
    );
    run(this.db, 'UPDATE app_versions SET published_at = COALESCE(published_at, :now) WHERE id = :id', {
      id: versionId,
      now,
    });
  }

  /**
   * A version holds the sources and everything built from them. Kept: what the two addresses
   * serve, and the last few versions that were published (to come back to). A draft that was
   * built again and never published is not history.
   */
  private prune(slug: string): void {
    const old = all<{ id: number }>(
      this.db,
      `SELECT v.id FROM app_versions v JOIN apps a ON a.slug = v.app
       WHERE v.app = :slug AND v.id IS NOT a.live_version AND v.id IS NOT a.draft_version AND (
         v.published_at IS NULL OR v.id NOT IN (
           SELECT id FROM app_versions WHERE app = :slug AND published_at IS NOT NULL
           ORDER BY id DESC LIMIT ${KEPT_VERSIONS}))`,
      { slug },
    );
    for (const row of old) {
      run(this.db, 'DELETE FROM app_versions WHERE id = :id', { id: row.id });
      this.forget(row.id);
    }
  }

  /** Records a built version and publishes it. No runner involved: `deploy` is the usual way in. */
  publish(
    slug: string,
    files: Record<string, string>,
    built: Pick<BuiltApp, 'manifest' | 'web' | 'server' | 'migrations'>,
    createdBy: number | null,
  ): number {
    const now = new Date().toISOString();
    const id = transaction(this.db, () => {
      run(
        this.db,
        `INSERT INTO apps (slug, name, description, created_at) VALUES (:slug, :name, :description, :now)
         ON CONFLICT(slug) DO NOTHING`,
        { slug, name: built.manifest.name, description: built.manifest.description, now },
      );
      const versionId = this.record(slug, files, built, createdBy, now);
      this.setLive(slug, versionId, built.manifest, now);
      this.prune(slug);
      return versionId;
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

  /** Runs one piece of work per app at a time: a second build waits for the first. */
  private inTurn<T>(slug: string, work: () => Promise<T>): Promise<T> {
    const previous = this.working.get(slug) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.working.set(slug, next);
    void next
      .finally(() => {
        if (this.working.get(slug) === next) this.working.delete(slug);
      })
      .catch(() => {});
    return next;
  }

  // A build or a migration stopped at its deadline is an outcome like any other problem;
  // only a runner that is not there at all is an exception.
  private stopped(
    stage: 'build' | 'migrate',
    error: unknown,
  ): { ok: false; stage: typeof stage; problems: BuildProblem[] } {
    if (!(error instanceof RunnerUnavailable) || !['timeout', 'memory', 'crashed'].includes(error.code)) throw error;
    const what = stage === 'build' ? 'the build' : 'the migrations';
    const why =
      error.code === 'timeout' ? 'took too long' : error.code === 'memory' ? 'used too much memory' : 'failed';
    return {
      ok: false,
      stage,
      problems: [{ message: `${what} ${why} and ${stage === 'build' ? 'was' : 'were'} stopped` }],
    };
  }

  /** Builds the files and gives the runner their server code. */
  private async build(
    slug: string,
    files: Record<string, string>,
  ): Promise<{ ok: true; built: BuiltApp } | { ok: false; stage: 'build'; problems: BuildProblem[] }> {
    if (!isValidSlug(slug)) {
      return { ok: false, stage: 'build', problems: [{ message: `"${slug}" is not a valid app name` }] };
    }
    let outcome;
    try {
      outcome = await this.runner.build(files);
    } catch (error) {
      return this.stopped('build', error) as { ok: false; stage: 'build'; problems: BuildProblem[] };
    }
    if (!outcome.ok) return { ok: false, stage: 'build', problems: outcome.problems };
    // The runner keeps the server code itself; calls then name it by its hash. Given before any
    // database changes: if this fails, nothing has happened yet.
    if (outcome.app.server) await this.runner.install(slug, outcome.app.server.bundle);
    return { ok: true, built: outcome.app };
  }

  /** Brings one of the app's databases up to the schema of a version. */
  private async migrate(
    database: string,
    migrations: BuiltApp['migrations'],
    reset = false,
  ): Promise<{ ok: true; applied: string[] } | { ok: false; stage: 'migrate'; problems: BuildProblem[] }> {
    let migrated;
    try {
      migrated = await this.runner.migrate(database, migrations, { reset });
    } catch (error) {
      return this.stopped('migrate', error) as { ok: false; stage: 'migrate'; problems: BuildProblem[] };
    }
    if (migrated.ok) return { ok: true, applied: migrated.applied };
    const file = migrated.migration ? `migrations/${migrated.migration}` : undefined;
    return { ok: false, stage: 'migrate', problems: [{ file, message: migrated.message }] };
  }

  /** True when a version is exactly what these files build into. */
  private same(versionId: number | null | undefined, files: Record<string, string>, built: BuiltApp): boolean {
    if (versionId === null || versionId === undefined) return false;
    const row = get<{ source_hash: string; asset_hash: string; bundle_hash: string | null; manifest: string }>(
      this.db,
      'SELECT source_hash, asset_hash, bundle_hash, manifest FROM app_versions WHERE id = :id',
      { id: versionId },
    );
    return (
      row !== undefined &&
      row.source_hash === sourceHash(files) &&
      row.asset_hash === assetHash(built.web) &&
      row.bundle_hash === (built.server ? sha256(built.server.bundle) : null) &&
      row.manifest === JSON.stringify(built.manifest)
    );
  }

  /**
   * Builds the files, brings the app's database up to date, then publishes, in one go: for
   * apps that ship with the platform. The live version only changes when everything succeeded.
   */
  deploy(slug: string, files: Record<string, string>, createdBy: Pick<UserRow, 'id'> | null): Promise<DeployOutcome> {
    return this.inTurn(slug, async () => {
      const result = await this.build(slug, files);
      if (!result.ok) return result;
      const { built } = result;
      const migrated = await this.migrate(liveDatabase(slug), built.migrations);
      if (!migrated.ok) return migrated;
      // Same sources giving the same build as the live version: nothing to publish.
      const current = get<{ live_version: number | null }>(
        this.db,
        'SELECT live_version FROM apps WHERE slug = :slug',
        { slug },
      )?.live_version;
      if (current && this.same(current, files, built)) {
        return { ok: true, versionId: current, unchanged: true, applied: migrated.applied };
      }
      // The schema is now the new version's: publish at once, in the same step.
      const versionId = this.publish(slug, files, built, createdBy?.id ?? null);
      return { ok: true, versionId, unchanged: false, applied: migrated.applied };
    });
  }

  // ----- Drafts: what agents edit. Nothing here changes what members use until `publishDraft`.

  /** Registers a new app, without any version yet. */
  create(
    slug: string,
    card: { name: string; description: string },
    createdBy: Pick<UserRow, 'id'>,
  ): 'created' | 'exists' | 'invalid' | 'full' {
    if (!isValidSlug(slug)) return 'invalid';
    if (get(this.db, 'SELECT 1 AS found FROM apps WHERE slug = :slug', { slug })) return 'exists';
    if (get<{ n: number }>(this.db, 'SELECT COUNT(*) AS n FROM apps')!.n >= MAX_APPS) return 'full';
    run(
      this.db,
      `INSERT INTO apps (slug, name, description, created_at, created_by)
       VALUES (:slug, :name, :description, :now, :by)`,
      { slug, name: card.name, description: card.description, now: new Date().toISOString(), by: createdBy.id },
    );
    return 'created';
  }

  /** The source files of one of the app's versions. */
  private filesOf(versionId: number | null | undefined): Record<string, string> | null {
    if (versionId === null || versionId === undefined) return null;
    const row = get<{ files: string }>(this.db, 'SELECT files FROM app_versions WHERE id = :id', { id: versionId });
    return row ? (JSON.parse(row.files) as Record<string, string>) : null;
  }

  /** The files an agent reads and edits: the draft's, or the published version's while there is no draft. */
  files(slug: string, target: Target): Record<string, string> | null {
    const app = get<{ live_version: number | null }>(this.db, 'SELECT live_version FROM apps WHERE slug = :slug', {
      slug,
    });
    if (!app) return null;
    if (target === 'draft') {
      const draft = get<{ files: string }>(this.db, 'SELECT files FROM app_drafts WHERE app = :slug', { slug });
      if (draft) return JSON.parse(draft.files) as Record<string, string>;
    }
    return this.filesOf(app.live_version) ?? (target === 'draft' ? {} : null);
  }

  /**
   * Saves the draft's files and builds them. The files are kept even when they do not build:
   * the next edit starts from them. When they do, the draft address serves the result.
   * `resetData` empties the draft's database first (after a migration was rewritten).
   */
  saveDraft(
    slug: string,
    files: Record<string, string>,
    by: Pick<UserRow, 'id'> | null,
    options: { resetData?: boolean } = {},
  ): Promise<DeployOutcome> {
    return this.inTurn(slug, async () => {
      const remember = (problems: BuildProblem[] | null) =>
        run(
          this.db,
          `INSERT INTO app_drafts (app, files, updated_at, updated_by, problems)
           VALUES (:slug, :files, :now, :by, :problems)
           ON CONFLICT(app) DO UPDATE SET files = excluded.files, updated_at = excluded.updated_at,
             updated_by = excluded.updated_by, problems = excluded.problems`,
          {
            slug,
            files: JSON.stringify(files),
            now: new Date().toISOString(),
            by: by?.id ?? null,
            problems: problems ? JSON.stringify(problems) : null,
          },
        );
      if (!get(this.db, 'SELECT 1 AS found FROM apps WHERE slug = :slug', { slug })) {
        return { ok: false, stage: 'build', problems: [{ message: `there is no app named "${slug}"` }] };
      }
      const result = await this.build(slug, files);
      if (!result.ok) {
        remember(result.problems);
        return result;
      }
      const { built } = result;
      const migrated = await this.migrate(draftDatabase(slug), built.migrations, options.resetData === true);
      if (!migrated.ok) {
        remember(migrated.problems);
        return migrated;
      }
      const current = get<{ draft_version: number | null }>(
        this.db,
        'SELECT draft_version FROM apps WHERE slug = :slug',
        { slug },
      )?.draft_version;
      if (current && this.same(current, files, built)) {
        remember(null);
        return { ok: true, versionId: current, unchanged: true, applied: migrated.applied };
      }
      const versionId = transaction(this.db, () => {
        remember(null);
        const id = this.record(slug, files, built, by?.id ?? null, null);
        run(this.db, 'UPDATE apps SET draft_version = :id WHERE slug = :slug', { id, slug });
        this.prune(slug);
        return id;
      });
      this.onDraft(slug);
      return { ok: true, versionId, unchanged: false, applied: migrated.applied };
    });
  }

  /**
   * Makes the draft the published version: the published database gets the draft's migrations,
   * then members get its screens and functions. Nothing changes when a migration fails.
   */
  publishDraft(slug: string): Promise<DeployOutcome> {
    return this.inTurn(slug, async () => {
      const app = get<{ live_version: number | null; draft_version: number | null }>(
        this.db,
        'SELECT live_version, draft_version FROM apps WHERE slug = :slug',
        { slug },
      );
      const draft = get<{ problems: string | null }>(this.db, 'SELECT problems FROM app_drafts WHERE app = :slug', {
        slug,
      });
      if (!app?.draft_version || draft?.problems) {
        const message = draft?.problems ? 'the draft does not build' : 'there is no draft to publish';
        return { ok: false, stage: 'build', problems: [{ message }] };
      }
      const version = get<{ id: number; manifest: string; migrations: string }>(
        this.db,
        'SELECT id, manifest, migrations FROM app_versions WHERE id = :id',
        { id: app.draft_version },
      )!;
      const migrated = await this.migrate(liveDatabase(slug), JSON.parse(version.migrations) as BuiltApp['migrations']);
      if (!migrated.ok) return migrated;
      const unchanged = app.live_version === version.id;
      transaction(this.db, () => {
        this.setLive(slug, version.id, JSON.parse(version.manifest) as BuiltApp['manifest'], new Date().toISOString());
        // The draft is now what is published: the next edit starts from it.
        run(this.db, 'DELETE FROM app_drafts WHERE app = :slug', { slug });
        this.prune(slug);
      });
      if (!unchanged) this.onPublish(slug);
      return { ok: true, versionId: version.id, unchanged, applied: migrated.applied };
    });
  }

  /** Where an app stands, for the people and agents who work on it. */
  status(slug: string): AppStatus | null {
    const app = get<{
      name: string;
      description: string;
      live_version: number | null;
      draft_version: number | null;
      published_at: string | null;
      updated_at: string | null;
      problems: string | null;
      edited: number;
    }>(
      this.db,
      `SELECT a.name, a.description, a.live_version, a.draft_version, v.published_at, d.updated_at, d.problems,
         d.app IS NOT NULL AS edited
       FROM apps a LEFT JOIN app_versions v ON v.id = a.live_version LEFT JOIN app_drafts d ON d.app = a.slug
       WHERE a.slug = :slug`,
      { slug },
    );
    if (!app) return null;
    return {
      slug,
      name: app.name,
      description: app.description,
      live: app.live_version ? { versionId: app.live_version, publishedAt: app.published_at } : null,
      draft: {
        versionId: app.draft_version,
        updatedAt: app.updated_at,
        problems: app.problems ? (JSON.parse(app.problems) as BuildProblem[]) : null,
        differs: app.edited === 1 && (app.problems !== null || app.draft_version !== app.live_version),
      },
    };
  }

  /** Keeps a line of what an app's function printed or failed with. */
  log(slug: string, target: Target, level: string, fn: string | null, message: string): void {
    try {
      const { lastInsertRowid } = run(
        this.db,
        'INSERT INTO app_logs (app, target, at, level, fn, message) VALUES (:slug, :target, :at, :level, :fn, :message)',
        { slug, target, at: new Date().toISOString(), level, fn, message: message.slice(0, MAX_LOG_LENGTH) },
      );
      run(this.db, 'DELETE FROM app_logs WHERE app = :slug AND id <= :floor', {
        slug,
        floor: lastInsertRowid - KEPT_LOGS,
      });
    } catch {
      // A log line never fails the call it describes (the app may just have been removed).
    }
  }

  /** The most recent lines first. */
  logs(slug: string, target: Target, limit = 50): LogLine[] {
    return all<LogLine>(
      this.db,
      `SELECT at, target, level, fn, message FROM app_logs WHERE app = :slug AND target = :target
       ORDER BY id DESC LIMIT :limit`,
      { slug, target, limit: Math.min(Math.max(limit, 1), KEPT_LOGS) },
    );
  }
}
