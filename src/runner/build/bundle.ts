import path from 'node:path';
import { build, type BuildOptions, type Loader, type Message, type Plugin } from 'esbuild';
import { BuildFailure, extension, type BuildProblem, type SourceFiles } from './files.ts';

// esbuild fed from the in-memory map only. The plugin below answers every import
// itself, so the bundler never looks at the disk: no node_modules, no tsconfig, no
// file outside the app. An app brings no package: the few bare imports it may use
// are the ones the platform provides.

const NAMESPACE = 'app';
const MAX_WARNINGS = 20;

const LOADERS: Record<string, Loader> = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.jsx': 'jsx',
  '.json': 'json',
  '.svg': 'dataurl',
};

export interface BundleScope {
  /** Folders this bundle may read, e.g. ['web', 'shared']. */
  folders: readonly string[];
  /** Bare imports the platform provides: specifier → what to do with it. */
  provided: Record<string, { external: string } | { contents: string }>;
  /** Shown when the app imports from a folder outside its scope. */
  outside: (folder: string) => string;
}

function resolveInApp(files: SourceFiles, importer: string, specifier: string): string | null {
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  if (target.startsWith('..') || target.startsWith('/')) return null;
  const candidates = [
    target,
    ...['.ts', '.tsx', '.js', '.jsx', '.json'].map((suffix) => target + suffix),
    `${target}/index.ts`,
    `${target}/index.tsx`,
  ];
  return candidates.find((candidate) => Object.hasOwn(files, candidate)) ?? null;
}

function virtualFiles(files: SourceFiles, scope: BundleScope): Plugin {
  return {
    name: 'socle-app-files',
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') return { path: args.path, namespace: NAMESPACE };
        const specifier = args.path;
        if (specifier.startsWith('./') || specifier.startsWith('../')) {
          if (args.namespace !== NAMESPACE) return { errors: [{ text: `cannot resolve ${specifier}` }] };
          const found = resolveInApp(files, args.importer, specifier);
          if (!found) return { errors: [{ text: `file not found in the app: ${specifier}` }] };
          const folder = found.split('/')[0]!;
          if (!scope.folders.includes(folder)) return { errors: [{ text: scope.outside(folder) }] };
          if (extension(found) === '.css') {
            return {
              errors: [
                { text: 'styles are not imported from code: use Tailwind classes, or put CSS in web/style.css' },
              ],
            };
          }
          return { path: found, namespace: NAMESPACE };
        }
        const provided = Object.hasOwn(scope.provided, specifier) ? scope.provided[specifier] : undefined;
        if (provided && 'external' in provided) return { path: provided.external, external: true };
        if (provided) return { path: specifier, namespace: 'socle-provided' };
        const names = Object.keys(scope.provided).join(', ');
        return {
          errors: [
            {
              text: `"${specifier}" is not available: apps cannot install packages. Import from the app's own files (./…) or from: ${names}`,
            },
          ],
        };
      });
      builder.onLoad({ filter: /.*/, namespace: NAMESPACE }, (args) => {
        const loader = LOADERS[extension(args.path)];
        if (!loader || !Object.hasOwn(files, args.path)) return { errors: [{ text: `cannot load ${args.path}` }] };
        return { contents: files[args.path], loader, resolveDir: undefined };
      });
      builder.onLoad({ filter: /.*/, namespace: 'socle-provided' }, (args) => {
        const provided = scope.provided[args.path];
        return provided && 'contents' in provided
          ? { contents: provided.contents, loader: 'js' }
          : { errors: [{ text: `cannot load ${args.path}` }] };
      });
    },
  };
}

function toProblem(message: Message): BuildProblem {
  const location = message.location;
  // Our own namespace prefix ("app:web/main.tsx") is noise for whoever reads the error.
  const file = location?.file.replace(/^app:/, '');
  return { file: file || undefined, line: location?.line, column: location?.column, message: message.text };
}

export async function bundle(
  files: SourceFiles,
  entry: string,
  scope: BundleScope,
  options: BuildOptions,
): Promise<{ code: string; warnings: BuildProblem[] }> {
  try {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      logLevel: 'silent',
      charset: 'utf8',
      legalComments: 'none',
      tsconfigRaw: '{}',
      plugins: [virtualFiles(files, scope)],
      ...options,
    });
    const output = result.outputFiles?.[0];
    if (!output) throw new BuildFailure([{ file: entry, message: 'the bundler produced nothing' }]);
    // A file made of small mistakes is answered with the first few, not with all of them.
    return { code: output.text, warnings: result.warnings.slice(0, MAX_WARNINGS).map(toProblem) };
  } catch (error) {
    if (error instanceof BuildFailure) throw error;
    const errors = (error as { errors?: Message[] }).errors;
    if (Array.isArray(errors) && errors.length) throw new BuildFailure(errors.slice(0, 20).map(toProblem));
    throw error;
  }
}
