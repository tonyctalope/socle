import { SOURCE_LIMITS } from '../limits.ts';
import { bundle, type BundleScope } from './bundle.ts';
import { BuildFailure, type BuildProblem, type SourceFiles } from './files.ts';

export const WEB_ENTRY = 'web/main.tsx';
const START = 'web/__socle_start.ts';

/** Where browsers load what the platform provides. One copy for every app, updated with the platform. */
export const VENDOR_PATH = '/_socle/vendor';

/** The only bare imports of an app's screens, and the module each one loads in the browser. */
export const WEB_MODULES: Record<string, string> = {
  react: `${VENDOR_PATH}/react.js`,
  'react/jsx-runtime': `${VENDOR_PATH}/react-jsx-runtime.js`,
  'react-dom': `${VENDOR_PATH}/react-dom.js`,
  'react-dom/client': `${VENDOR_PATH}/react-dom.js`,
  '@socle/sdk': `${VENDOR_PATH}/sdk.js`,
  '@socle/ui': `${VENDOR_PATH}/ui.js`,
};

export const WEB_SCOPE: BundleScope = {
  folders: ['web', 'shared'],
  provided: Object.fromEntries(Object.entries(WEB_MODULES).map(([name, url]) => [name, { external: url }])),
  outside: (folder) =>
    folder === 'server'
      ? 'screens cannot import server code: call it with api.<function>() or useQuery() from @socle/sdk, and put what both sides need in shared/'
      : `screens cannot import from ${folder}/`,
};

/**
 * The app's screens as one ES module. web/main.tsx exports the root component; the
 * platform mounts it (error screen, sign-in redirects and live updates come with it).
 */
export async function bundleWeb(files: SourceFiles): Promise<{ code: string; warnings: BuildProblem[] }> {
  if (!Object.hasOwn(files, WEB_ENTRY)) {
    throw new BuildFailure([
      { message: `the app needs ${WEB_ENTRY}, whose default export is its root React component` },
    ]);
  }
  const withStart = {
    ...files,
    [START]: `import App from './main.tsx';\nimport { start } from '@socle/sdk';\nstart(App);\n`,
  };
  let result;
  try {
    result = await bundle(withStart, START, WEB_SCOPE, {
      format: 'esm',
      platform: 'browser',
      target: ['es2022'],
      jsx: 'automatic',
      minify: true,
      define: { 'process.env.NODE_ENV': '"production"' },
    });
  } catch (error) {
    if (error instanceof BuildFailure) {
      for (const problem of error.problems) {
        if (problem.file === START) {
          problem.file = WEB_ENTRY;
          problem.line = undefined;
          problem.column = undefined;
          problem.message = `${WEB_ENTRY} must export the app's root component as its default export (export default function App() { … })`;
        }
      }
    }
    throw error;
  }
  if (Buffer.byteLength(result.code) > SOURCE_LIMITS.maxWebBytes) {
    throw new BuildFailure([{ file: WEB_ENTRY, message: 'the screens are too large once bundled (limit 3 MiB)' }]);
  }
  return result;
}
