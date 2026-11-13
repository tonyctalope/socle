import { SOURCE_LIMITS, type Limits } from '../limits.ts';
import type { Migration } from '../sandbox/appdb.ts';
import { describeBundle, type FunctionInfo } from '../sandbox/call.ts';
import { GuestFailure } from '../sandbox/engine.ts';
import { buildAppCss } from './css.ts';
import { BuildFailure, checkFiles, type BuildProblem, type SourceFiles } from './files.ts';
import { buildIcons, ICON_FILE, type AppIcons } from './icons.ts';
import { bundleServer, SERVER_ENTRY } from './server.ts';
import { bundleWeb } from './web.ts';

/** app.json: how the app presents itself. */
export interface AppManifest {
  name: string;
  description: string;
  /** Colors of the browser bar and of the splash screen, as #rrggbb. Null: the platform's. */
  themeColor: string | null;
  backgroundColor: string | null;
}

export interface BuiltApp {
  manifest: AppManifest;
  web: { js: string; css: string };
  /** Null when the app has no server code. */
  server: { bundle: string; functions: FunctionInfo[] } | null;
  migrations: Migration[];
  /** The app's own icon in the sizes phones ask for (base64 PNG). Null: the platform's icon. */
  icons: AppIcons | null;
  warnings: BuildProblem[];
}

export type BuildOutcome = { ok: true; app: BuiltApp } | { ok: false; problems: BuildProblem[] };

const MANIFEST = 'app.json';
/** Behind an icon that names no color: the platform's own background. */
const PLATFORM_BACKGROUND = '#f4f1ea';
const COLOR = /^#[0-9a-fA-F]{6}$/;

function readManifest(files: SourceFiles): AppManifest {
  const fail = (message: string): never => {
    throw new BuildFailure([{ file: MANIFEST, message }]);
  };
  if (!Object.hasOwn(files, MANIFEST)) fail('the app needs an app.json: { "name": "…", "description": "…" }');
  let raw: unknown;
  try {
    raw = JSON.parse(files[MANIFEST]!);
  } catch (error) {
    fail(`not valid JSON: ${(error as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('expected an object');
  const given = raw as Record<string, unknown>;
  const known = ['name', 'description', 'themeColor', 'backgroundColor'];
  const unknown = Object.keys(given).filter((key) => !known.includes(key));
  if (unknown.length) fail(`unknown field(s): ${unknown.join(', ')} (known: ${known.join(', ')})`);
  const name = typeof given.name === 'string' ? given.name.trim() : '';
  if (!name || name.length > 40)
    fail('"name" is required: the app\'s name as shown on the home screen, 40 characters at most');
  const description = given.description ?? '';
  if (typeof description !== 'string' || description.length > 200)
    fail('"description" must be text, 200 characters at most');
  const color = (key: 'themeColor' | 'backgroundColor'): string | null => {
    const value = given[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || !COLOR.test(value)) fail(`"${key}" must be a color written #rrggbb`);
    return (value as string).toLowerCase();
  };
  return {
    name,
    description: (description as string).trim(),
    themeColor: color('themeColor'),
    backgroundColor: color('backgroundColor'),
  };
}

function readMigrations(files: SourceFiles): Migration[] {
  const names = Object.keys(files)
    .filter((file) => file.startsWith('migrations/'))
    .sort();
  if (names.length > SOURCE_LIMITS.maxMigrations) {
    throw new BuildFailure([{ message: `too many migrations (limit ${SOURCE_LIMITS.maxMigrations})` }]);
  }
  return names.map((file) => {
    if (!files[file]!.trim()) throw new BuildFailure([{ file, message: 'this migration is empty' }]);
    return { name: file.slice('migrations/'.length), sql: files[file]! };
  });
}

/**
 * Turns the files an agent sent into what the platform serves and runs. Nothing is
 * installed, nothing touches the disk, and every refusal comes back as a message
 * the agent can act on.
 */
export async function buildApp(files: unknown, limits: Limits): Promise<BuildOutcome> {
  const problems = checkFiles(files);
  if (problems.length) return { ok: false, problems };
  const sources = files as SourceFiles;
  try {
    const manifest = readManifest(sources);
    const migrations = readMigrations(sources);
    const [web, css, server, icons] = await Promise.all([
      bundleWeb(sources),
      buildAppCss(sources),
      bundleServer(sources),
      Object.hasOwn(sources, ICON_FILE)
        ? buildIcons(sources[ICON_FILE]!, manifest.backgroundColor ?? manifest.themeColor ?? PLATFORM_BACKGROUND)
        : null,
    ]);
    let functions: FunctionInfo[] = [];
    if (server) {
      try {
        functions = await describeBundle(server.code, limits);
      } catch (error) {
        if (!(error instanceof GuestFailure)) throw error;
        throw new BuildFailure([{ file: SERVER_ENTRY, message: `the server code does not load: ${error.message}` }]);
      }
      if (functions.length > SOURCE_LIMITS.maxFunctions) {
        throw new BuildFailure([
          { file: SERVER_ENTRY, message: `too many server functions (limit ${SOURCE_LIMITS.maxFunctions})` },
        ]);
      }
    }
    return {
      ok: true,
      app: {
        manifest,
        web: { js: web.code, css },
        server: server ? { bundle: server.code, functions } : null,
        migrations,
        icons,
        warnings: [...web.warnings, ...(server?.warnings ?? [])],
      },
    };
  } catch (error) {
    if (error instanceof BuildFailure) return { ok: false, problems: error.problems };
    throw error;
  }
}
