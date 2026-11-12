// An app's slug is its subdomain: <slug>.<APPS_DOMAIN>.

/** Names that would read like a part of the platform itself in an address bar. */
const RESERVED = new Set(['admin', 'api', 'auth', 'login', 'socle', 'static', 'www']);

/** 2 to 32 characters: a letter first, then lowercase letters, digits or single hyphens, no trailing hyphen. */
export function isValidSlug(slug: string): boolean {
  return /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(slug) && !slug.includes('--') && !RESERVED.has(slug);
}
