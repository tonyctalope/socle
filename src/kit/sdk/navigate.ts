// A notification that is tapped while the app is open: the service worker brings the window
// forward and says which page the notification is about (`socle:navigate`).

/**
 * Where a message of the service worker asks this page to go: a path of this app, or null
 * when the message is something else, names another origin, or names the page already shown.
 */
export function pathToOpen(
  message: unknown,
  here: { origin: string; pathname: string; search: string; hash: string },
): string | null {
  if (typeof message !== 'object' || message === null) return null;
  const { type, url } = message as { type?: unknown; url?: unknown };
  if (type !== 'socle:navigate' || typeof url !== 'string') return null;
  let target: URL;
  try {
    target = new URL(url, here.origin);
  } catch {
    return null;
  }
  if (target.origin !== here.origin) return null;
  const path = target.pathname + target.search + target.hash;
  return path === here.pathname + here.search + here.hash ? null : path;
}
