import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';
import { buildPlatformCss } from './css.ts';
import { VENDOR_PATH, WEB_MODULES } from './web.ts';

// What the platform serves once for every app: React, its own SDK and UI kit, and
// the base stylesheet. Built from the platform's own dependencies (trusted code),
// as ES modules that import each other by URL, so a page holds exactly one React.

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const kitDir = fileURLToPath(new URL('../../kit/', import.meta.url));

export interface VendorFile {
  type: string;
  text: string;
}

/** File name under /_socle/vendor/ → content. */
export type VendorFiles = Record<string, VendorFile>;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** `export const a = source.a, …` for every property of a CommonJS module. */
function reexport(specifiers: string[]): string {
  const lines: string[] = [];
  const taken = new Set<string>();
  specifiers.forEach((specifier, index) => {
    lines.push(`import module${index} from ${JSON.stringify(specifier)};`);
    for (const name of Object.keys(require(specifier) as object)) {
      if (name === 'default' || !IDENTIFIER.test(name) || taken.has(name)) continue;
      taken.add(name);
      lines.push(`export const ${name} = module${index}.${name};`);
    }
  });
  lines.push(`export default { ${specifiers.map((_, index) => `...module${index}`).join(', ')} };`);
  return lines.join('\n');
}

interface VendorModule {
  file: string;
  /** The bare imports this file answers. */
  provides: string[];
  entry: { contents: string } | { file: string };
}

const MODULES: VendorModule[] = [
  { file: 'react.js', provides: ['react'], entry: { contents: reexport(['react']) } },
  {
    file: 'react-jsx-runtime.js',
    provides: ['react/jsx-runtime'],
    entry: { contents: reexport(['react/jsx-runtime']) },
  },
  {
    file: 'react-dom.js',
    provides: ['react-dom', 'react-dom/client'],
    entry: { contents: reexport(['react-dom', 'react-dom/client']) },
  },
  { file: 'sdk.js', provides: ['@socle/sdk'], entry: { file: path.join(kitDir, 'sdk/index.ts') } },
  { file: 'ui.js', provides: ['@socle/ui'], entry: { file: path.join(kitDir, 'ui/index.tsx') } },
];

/** Imports of another vendor module become imports of its URL. */
function linkVendor(own: readonly string[]): Plugin {
  return {
    name: 'socle-vendor-links',
    setup(builder) {
      const names = Object.keys(WEB_MODULES).filter((name) => !own.includes(name));
      const filter = new RegExp(`^(${names.map((name) => name.replace(/[/@.-]/g, '\\$&')).join('|')})$`);
      builder.onResolve({ filter }, (args) => {
        const url = WEB_MODULES[args.path]!;
        // require('react') from a CommonJS file: go through a small ES module, since an
        // external URL cannot be require()d.
        if (args.kind === 'require-call') return { path: url, namespace: 'socle-vendor-cjs' };
        return { path: url, external: true };
      });
      builder.onResolve({ filter: /^\/_socle\/vendor\//, namespace: 'socle-vendor-cjs' }, (args) => ({
        path: args.path,
        external: true,
      }));
      builder.onLoad({ filter: /.*/, namespace: 'socle-vendor-cjs' }, (args) => ({
        contents: `export * from ${JSON.stringify(args.path)};\nexport { default } from ${JSON.stringify(args.path)};`,
        loader: 'js',
      }));
    },
  };
}

function kitSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return kitSources(full);
    return /\.tsx?$/.test(entry.name) ? [readFileSync(full, 'utf8')] : [];
  });
}

export async function buildVendor(): Promise<VendorFiles> {
  const files: VendorFiles = {};
  await Promise.all(
    MODULES.map(async (module) => {
      const result = await build({
        ...('contents' in module.entry
          ? { stdin: { contents: module.entry.contents, resolveDir: root, loader: 'js' as const } }
          : { entryPoints: [module.entry.file] }),
        absWorkingDir: root,
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'browser',
        target: ['es2022'],
        jsx: 'automatic',
        minify: true,
        legalComments: 'none',
        logLevel: 'silent',
        tsconfigRaw: '{}',
        define: { 'process.env.NODE_ENV': '"production"' },
        plugins: [linkVendor(module.provides)],
      });
      files[module.file] = { type: 'text/javascript; charset=utf-8', text: result.outputFiles[0]!.text };
    }),
  );
  files['ui.css'] = { type: 'text/css; charset=utf-8', text: await buildPlatformCss(kitSources(kitDir)) };
  return files;
}

/** The URL of a vendor file, for the HTML shell. */
export const vendorUrl = (file: string): string => `${VENDOR_PATH}/${file}`;
