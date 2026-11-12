import { bundle } from './bundle.ts';
import { BuildFailure, type BuildProblem, type SourceFiles } from './files.ts';

export const SERVER_ENTRY = 'server/index.ts';
const MAX_BUNDLE = 2 * 1024 * 1024;

/** "@socle/server" inside a bundle is whatever the sandbox provides at call time, not a copy frozen at build time. */
const SERVER_STD = `
const socle = globalThis.__socle;
export const query = socle.query;
export const mutation = socle.mutation;
export const v = socle.v;
export const fail = socle.fail;
export const UserError = socle.UserError;
`;

/**
 * The app's server functions as one script that defines the global `__app`. Left
 * readable (not minified) so that errors name the app's own functions.
 */
export async function bundleServer(files: SourceFiles): Promise<{ code: string; warnings: BuildProblem[] } | null> {
  if (!Object.hasOwn(files, SERVER_ENTRY)) {
    if (Object.keys(files).some((file) => file.startsWith('server/'))) {
      throw new BuildFailure([
        { message: `server code starts at ${SERVER_ENTRY}: export the app's functions from there` },
      ]);
    }
    return null;
  }
  const result = await bundle(
    files,
    SERVER_ENTRY,
    {
      folders: ['server', 'shared'],
      provided: { '@socle/server': { contents: SERVER_STD } },
      outside: (folder) =>
        folder === 'web'
          ? 'server code cannot import from web/: put what both sides need in shared/'
          : `server code cannot import from ${folder}/`,
    },
    { format: 'iife', globalName: '__app', target: 'es2023', platform: 'neutral' },
  );
  if (result.code.length > MAX_BUNDLE) {
    throw new BuildFailure([
      { file: SERVER_ENTRY, message: 'the server code is too large once bundled (limit 2 MiB)' },
    ]);
  }
  return result;
}
