import type { LiveHub } from '../apphost/live.ts';
import type { FileStore } from '../files/store.ts';
import { siteOf } from './slug.ts';
import type { AppStore } from './store.ts';

/**
 * What follows from a change to an app, wherever the platform is put together (the server,
 * the tests): open pages reload when their version changes, and what an address held (its
 * streams, its files) goes when the address or its data does.
 */
export function wireApps(apps: AppStore, live: LiveHub, files: FileStore): void {
  apps.onPublish = (slug) => live.publish(slug, 'version');
  apps.onDraft = (slug) => live.publish(siteOf(slug, true).label, 'version');
  // A draft whose data starts again has no use for the files its old data named, and its open
  // pages show rows that are gone: they read again, whether or not the build changed.
  apps.onDraftReset = (slug) => {
    const draft = siteOf(slug, true);
    files.clear(draft);
    live.publish(draft.label, 'change', { client: '' });
  };
  apps.onRemove = (slug) => {
    const sites = [siteOf(slug, false), siteOf(slug, true)];
    for (const site of sites) {
      // Open pages learn they must reload, then their streams end.
      live.publish(site.label, 'version');
      live.close(site.label);
    }
    files.setAside(sites);
  };
}
