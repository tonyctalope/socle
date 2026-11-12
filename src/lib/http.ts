import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

/**
 * Rate-limit key for the client. Behind Traefik the right-most X-Forwarded-For
 * entry is the address Traefik saw; without a proxy we use the socket. IPv6
 * clients are grouped by /64 (one subscriber usually owns a whole /64).
 */
export function clientIp(c: Context): string {
  let address = 'unknown';
  const forwarded = c.req.header('x-forwarded-for');
  const last = forwarded
    ?.split(',')
    .map((hop) => hop.trim())
    .filter(Boolean)
    .at(-1);
  if (last) {
    address = last;
  } else {
    try {
      address = getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      // not running on node-server (tests)
    }
  }
  return rateLimitKey(address);
}

export function rateLimitKey(address: string): string {
  const ip = address.replace(/^::ffff:/i, '');
  if (!ip.includes(':')) return ip;
  // Expand "::" and keep the first four hextets (the /64 prefix).
  const [head = '', tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::')
    ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
    : left;
  return `${groups.slice(0, 4).join(':')}::/64`;
}

/** Fixed-window in-memory limiter with bounded memory: enough for one small instance. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private nextSweep = 0;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Returns false when the key is over its budget for the current window. */
  take(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (entry && entry.resetAt > now) {
      entry.count++;
      return entry.count <= this.limit;
    }
    if (now >= this.nextSweep) {
      for (const [stale, value] of this.hits) if (value.resetAt <= now) this.hits.delete(stale);
      this.nextSweep = now + this.windowMs;
    }
    if (this.hits.size >= 50_000) return false; // under a flood, new keys wait for the next sweep
    this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
    return true;
  }
}

/**
 * Local path safe to redirect to: no scheme, no host, nothing under the platform's own
 * prefix. The path is resolved the way a browser would resolve it before it is checked,
 * so "/./_socle/…", "/x/../_socle/…" or "/%5Fsocle/…" do not slip through.
 */
export function safeNextPath(next: string | undefined | null, maxLength = 500): string {
  if (!next || next.length > maxLength || !next.startsWith('/') || /[\u0000-\u001f\\]/.test(next)) return '/';
  const base = 'http://local.invalid';
  let url: URL;
  let pathname: string;
  try {
    url = new URL(next, base);
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return '/';
  }
  if (url.origin !== base) return '/'; // "//host/…"
  if (pathname === '/_socle' || pathname.startsWith('/_socle/')) return '/';
  return url.pathname + url.search;
}

/**
 * True when a state-changing request really comes from a page of exactly this origin.
 *
 * Every app is a sibling subdomain of the others, so browsers treat them as the same
 * site and attach SameSite cookies to requests between them. The exact Origin (and
 * Sec-Fetch-Site when the browser sends it) is what tells our own pages apart.
 */
export function isSameOrigin(c: Context, origin: string): boolean {
  if (c.req.header('origin') !== origin) return false;
  const site = c.req.header('sec-fetch-site');
  return site === undefined || site === 'same-origin';
}

/** For private reads: refuses requests started by another origin, sibling subdomains included. */
export function isOwnFetch(c: Context): boolean {
  const site = c.req.header('sec-fetch-site');
  return site === undefined || site === 'same-origin' || site === 'none';
}

/** A browser navigating to a page, as opposed to a script or an asset request. */
export function isNavigation(c: Context): boolean {
  if (c.req.method !== 'GET') return false;
  const mode = c.req.header('sec-fetch-mode');
  if (mode !== undefined) return mode === 'navigate';
  return (c.req.header('accept') ?? '').includes('text/html');
}

/**
 * The sign-on endpoints only make sense as the page a tab navigates to. Refusing
 * everything else (fetch, images, frames) keeps scripts of a sibling origin from
 * driving them in the background.
 */
export function isTopLevelNavigation(c: Context): boolean {
  const mode = c.req.header('sec-fetch-mode');
  const dest = c.req.header('sec-fetch-dest');
  return (mode === undefined || mode === 'navigate') && (dest === undefined || dest === 'document');
}
