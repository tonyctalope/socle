import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Static files are few and small: they are loaded once into memory and looked up
// by exact URL path, so a request path never reaches the filesystem.

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

export interface StaticFile {
  body: Uint8Array<ArrayBuffer>;
  type: string;
}

/** Loads a directory of the repository (given relative to src/) as a map of "/path" → file. */
export function loadStaticFiles(relativeToSrc: string): Map<string, StaticFile> {
  const root = fileURLToPath(new URL(`../${relativeToSrc}/`, import.meta.url));
  const files = new Map<string, StaticFile>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const type = TYPES[path.extname(entry).toLowerCase()];
      if (!type) continue;
      const url = `/${path.relative(root, full).split(path.sep).join('/')}`;
      files.set(url, { body: new Uint8Array(readFileSync(full)), type });
    }
  };
  walk(root);
  return files;
}
