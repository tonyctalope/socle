import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
import { compile } from 'tailwindcss';
import { SOURCE_LIMITS } from '../limits.ts';
import { BuildFailure, type SourceFiles } from './files.ts';

// Tailwind's compiler is plain JavaScript: given a stylesheet and the class names
// found in the sources, it returns CSS. Nothing is read from the app except through
// the map of its files, and @plugin / @config (which would run code) are refused.

const require = createRequire(import.meta.url);
const tailwindDir = path.dirname(require.resolve('tailwindcss/package.json'));
const kitDir = fileURLToPath(new URL('../../kit/ui/', import.meta.url));

const cache = new Map<string, string>();
function platformFile(file: string): string {
  let text = cache.get(file);
  if (text === undefined) {
    text = readFileSync(file, 'utf8');
    cache.set(file, text);
  }
  return text;
}

/** Stylesheets the platform itself provides, by the name used in @import. */
const PLATFORM_SHEETS: Record<string, () => string> = {
  'tailwindcss/theme.css': () => platformFile(path.join(tailwindDir, 'theme.css')),
  'tailwindcss/preflight.css': () => platformFile(path.join(tailwindDir, 'preflight.css')),
  'tailwindcss/utilities.css': () => platformFile(path.join(tailwindDir, 'utilities.css')),
  'socle/theme.css': () => platformFile(path.join(kitDir, 'theme.css')),
  'socle/base.css': () => platformFile(path.join(kitDir, 'base.css')),
};

/**
 * An app's stylesheet only adds utilities: the theme's variables and the base styles
 * are emitted once, by the platform's own stylesheet (see PLATFORM_CSS), which every
 * app page loads first. `theme(reference)` makes the tokens usable without repeating them.
 */
const APP_HEAD = `@layer theme, base, components, utilities;
@import 'tailwindcss/theme.css' layer(theme) theme(reference);
@import 'socle/theme.css' theme(reference);
@import 'tailwindcss/utilities.css' layer(utilities);
`;

const PLATFORM_CSS = `@layer theme, base, components, utilities;
@import 'tailwindcss/theme.css' layer(theme) theme(static);
@import 'socle/theme.css' theme(static);
@import 'tailwindcss/preflight.css' layer(base);
@import 'socle/base.css' layer(base);
@import 'tailwindcss/utilities.css' layer(utilities);
`;

const APP_STYLE = 'web/style.css';
const MAX_CANDIDATES = 50_000;

/** Every token of the sources that could be a class name; Tailwind ignores the ones that are not. */
export function classCandidates(sources: Iterable<string>): string[] {
  const found = new Set<string>();
  for (const source of sources) {
    for (const token of source.split(/[\s"'`]+/)) {
      if (!token || token.length > 200) continue;
      found.add(token);
      // { hidden: !open } — an object key used as a class name.
      const bare = token.replace(/[:,;]+$/, '');
      if (bare !== token && bare) found.add(bare);
      if (found.size > MAX_CANDIDATES) return [...found];
    }
  }
  return [...found];
}

async function compileSheet(css: string, appFiles: SourceFiles, candidates: string[]): Promise<string> {
  const compiler = await compile(css, {
    base: 'web',
    loadStylesheet: async (id, base) => {
      const platform = PLATFORM_SHEETS[id] ?? PLATFORM_SHEETS[`${id}.css`];
      if (platform) return { path: id, base: 'platform', content: platform() };
      // Written out of habit at the top of a stylesheet: everything it would bring is already there.
      if (id === 'tailwindcss') return { path: id, base: 'platform', content: '' };
      if ((id.startsWith('./') || id.startsWith('../')) && base !== 'platform') {
        const file = path.posix.normalize(path.posix.join(base, id));
        if (file.startsWith('web/') && file.endsWith('.css') && Object.hasOwn(appFiles, file)) {
          return { path: file, base: path.posix.dirname(file), content: appFiles[file]! };
        }
      }
      throw new Error(`@import "${id}": only other .css files of web/ can be imported`);
    },
    loadModule: async (id) => {
      throw new Error(
        `@plugin and @config are not available (${id}): describe the theme with @theme { … } in web/style.css`,
      );
    },
  });
  const built = compiler.build(candidates);
  // Flattens nesting for older phones and minifies.
  const { code } = await transform(built, {
    loader: 'css',
    minify: true,
    target: ['chrome111', 'safari16.4', 'firefox128'],
    logLevel: 'silent',
  });
  return code;
}

/** The app's own CSS: utilities for the classes its screens use, plus web/style.css. */
export async function buildAppCss(files: SourceFiles): Promise<string> {
  const sources = Object.entries(files)
    .filter(([file]) => (file.startsWith('web/') || file.startsWith('shared/')) && !file.endsWith('.css'))
    .map(([, text]) => text);
  let css: string;
  try {
    css = await compileSheet(APP_HEAD + (files[APP_STYLE] ?? ''), files, classCandidates(sources));
  } catch (error) {
    throw new BuildFailure([
      { file: Object.hasOwn(files, APP_STYLE) ? APP_STYLE : undefined, message: (error as Error).message },
    ]);
  }
  if (Buffer.byteLength(css) > SOURCE_LIMITS.maxCssBytes) {
    throw new BuildFailure([
      { message: 'the stylesheet is too large once built (limit 1 MiB): use fewer distinct classes' },
    ]);
  }
  return css;
}

/** The stylesheet every app page loads first: theme variables, base styles, and what the UI kit needs. */
export function buildPlatformCss(kitSources: Iterable<string>): Promise<string> {
  return compileSheet(PLATFORM_CSS, {}, classCandidates(kitSources));
}
