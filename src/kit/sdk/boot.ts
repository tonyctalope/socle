// What the platform wrote into the page before the app's code runs.

export interface Member {
  id: number;
  name: string;
}

export interface Boot {
  /** Who is signed in. */
  user: Member;
  app: { slug: string; name: string };
  /** Everyone who can open this app, the signed-in user included. */
  members: Member[];
  push: { publicKey: string };
  /** Language of the platform's own words, e.g. "en". */
  locale: string;
  /** Where the members live, as an IANA timezone name. */
  timezone?: string;
  /** True when this page is the app's draft, not what is published. */
  draft?: boolean;
}

function read(): Boot {
  const text = document.getElementById('socle-boot')?.textContent;
  if (!text) throw new Error('socle: this page was not served by the platform');
  return JSON.parse(text) as Boot;
}

export const boot: Boot = read();

/**
 * The language the instance is set to ("en", "fr"…): what the platform's own components
 * speak, and a good default for `toLocaleDateString(locale)`.
 */
export const locale: string = boot.locale || 'en';

/**
 * The instance's timezone ("Europe/Paris"…), the one `today` is counted in on the server: pass it as
 * `timeZone` to `toLocaleDateString` and friends so that every phone shows the same day.
 */
export const timezone: string = boot.timezone || 'UTC';

/** Picks the platform's words for that language; English when there is no translation. */
export function words<T>(all: { en: T } & Record<string, T>): T {
  return all[locale] ?? all.en;
}
