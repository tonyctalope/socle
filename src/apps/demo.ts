import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, type Db } from '../db/database.ts';
import type { Locale } from '../i18n.ts';
import type { AppStore, DeployOutcome } from './store.ts';

// The demo app ships with the platform as a folder of sources (src/demo) and goes
// through the same build and the same sandbox as any app an agent would send.

export const DEMO_SLUG = 'demo';

const DEMO_CARD: Record<Locale, { name: string; description: string }> = {
  en: JSON.parse(readFileSync(new URL('../demo/app.json', import.meta.url), 'utf8')) as {
    name: string;
    description: string;
  },
  fr: {
    name: 'Démo',
    description: 'Vérifie la connexion, l’installation sur l’écran d’accueil, les notifications et une liste partagée.',
  },
};

/** A folder of the repository as the map of files an agent would send. */
export function readSourceFolder(relativeToSrc: string): Record<string, string> {
  const root = fileURLToPath(new URL(`../${relativeToSrc}/`, import.meta.url));
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else files[path.relative(root, full).split(path.sep).join('/')] = readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return files;
}

/** The demo app exists exactly while DEMO_APP is on, and always runs the sources of this version of the platform. */
export async function syncDemoApp(
  db: Db,
  apps: AppStore,
  enabled: boolean,
  locale: Locale = 'en',
): Promise<DeployOutcome | null> {
  if (!enabled) {
    run(db, 'DELETE FROM apps WHERE slug = :slug', { slug: DEMO_SLUG });
    return null;
  }
  const files = readSourceFolder('demo');
  // An app's name and description are plain text: the demo's are written in the instance's language.
  files['app.json'] = JSON.stringify(DEMO_CARD[locale]);
  return apps.deploy(DEMO_SLUG, files, null);
}
