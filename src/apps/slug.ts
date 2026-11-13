// An app's slug is its subdomain: <slug>.<APPS_DOMAIN>.

/** Names that would read like a part of the platform itself in an address bar. */
const RESERVED = new Set(['admin', 'api', 'auth', 'login', 'socle', 'static', 'www']);

/** 2 to 32 characters: a letter first, then lowercase letters, digits or single hyphens, no trailing hyphen. */
export function isValidSlug(slug: string): boolean {
  return /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(slug) && !slug.includes('--') && !RESERVED.has(slug);
}

// An app is served on two addresses: <slug>.<APPS_DOMAIN> for its published version and
// <slug>--draft.<APPS_DOMAIN> for its draft. They are two origins, so two sets of cookies,
// two installable apps and two sets of notifications: trying a draft never touches the
// published app. A slug cannot contain "--", so the two never collide.

const DRAFT_SUFFIX = '--draft';

/** One of the two addresses of an app, named by the label in front of the apps domain. */
export interface Site {
  slug: string;
  draft: boolean;
  /** The host label, and what sessions, sign-on codes and notifications are filed under. */
  label: string;
}

export function siteOf(slug: string, draft: boolean): Site {
  return { slug, draft, label: draft ? `${slug}${DRAFT_SUFFIX}` : slug };
}

export function parseSite(label: string): Site | null {
  const draft = label.endsWith(DRAFT_SUFFIX);
  const slug = draft ? label.slice(0, -DRAFT_SUFFIX.length) : label;
  return isValidSlug(slug) ? siteOf(slug, draft) : null;
}
