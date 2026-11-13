import path from 'node:path';
import { parseSite, type Site } from './apps/slug.ts';
import { isLocale, LOCALES, type Locale } from './i18n.ts';
import { loadOAuthConfig, type OAuthConfig } from './oauth/config.ts';

export interface Config {
  /** Origin of the control plane (sign-in, SSO), e.g. https://socle.example.com (no trailing slash). */
  controlOrigin: string;
  /** Its host as browsers send it (with the port when it is not the default one). */
  controlHost: string;
  /** Apps live on https://<slug>.<appsDomain>. */
  appsDomain: string;
  /** ":8787" in local development, empty behind the reverse proxy. */
  portSuffix: string;
  port: number;
  host: string;
  dataDir: string;
  /** The OpenID Connect provider members sign in with. `name` is what the sign-in button calls it. */
  oidc: { issuer: string; clientId: string; clientSecret: string; name: string | null };
  allowedEmails: ReadonlySet<string>;
  /** Members who publish apps and manage the instance. */
  adminEmails: ReadonlySet<string>;
  vapid: { publicKey: string | null; privateKey: string | null; subject: string };
  /** Serves the built-in demo app on demo.<appsDomain>. */
  demoApp: boolean;
  /** Local development only: /auth/dev-login signs in any allowlisted e-mail. */
  devLogin: boolean;
  secureCookies: boolean;
  /** Unix socket of the runner (a separate container). Null: the runner's workers are started by this process. */
  runnerSocket: string | null;
  /** Where the members live: "today" for an app's server functions. */
  timezone: string;
  /** Language of the platform's own pages and messages. */
  locale: Locale;
  /** The authorization server agents (MCP clients) sign in with. */
  oauth: OAuthConfig;
}

export class ConfigError extends Error {}

const list = (value: string | undefined): string[] =>
  (value ?? '')
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);

const flag = (value: string | undefined): boolean => value === '1' || value === 'true';

const isLoopbackHost = (hostname: string) =>
  hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '[::1]';

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new ConfigError(`${name} must be a positive integer`);
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawUrl = env.CONTROL_URL;
  if (!rawUrl) throw new ConfigError('CONTROL_URL is required (e.g. https://socle.example.com)');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConfigError(`CONTROL_URL is not a valid URL: ${rawUrl}`);
  }
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ConfigError('CONTROL_URL must use https:// (http:// is only accepted for localhost)');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new ConfigError('CONTROL_URL must be an origin without path, e.g. https://socle.example.com');
  }

  const appsDomain = (env.APPS_DOMAIN ?? '').trim().toLowerCase();
  if (!appsDomain) throw new ConfigError('APPS_DOMAIN is required (apps are served on <app>.APPS_DOMAIN)');
  if (!HOSTNAME.test(appsDomain)) throw new ConfigError(`APPS_DOMAIN is not a valid domain name: ${appsDomain}`);
  if (url.hostname === appsDomain || url.hostname.endsWith(`.${appsDomain}`)) {
    throw new ConfigError('CONTROL_URL must not be inside APPS_DOMAIN: an app could then take its place');
  }
  if (loopback !== isLoopbackHost(appsDomain)) {
    throw new ConfigError('CONTROL_URL and APPS_DOMAIN must both be public, or both be localhost names');
  }

  const allowedEmails = new Set(list(env.ALLOWED_EMAILS).map((email) => email.toLowerCase()));
  if (allowedEmails.size === 0) throw new ConfigError('ALLOWED_EMAILS must list at least one e-mail address');
  for (const email of allowedEmails) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ConfigError(`ALLOWED_EMAILS: invalid address ${email}`);
  }

  // Without ADMIN_EMAILS the first allowed address administers the instance: someone has to.
  const adminEmails = new Set(list(env.ADMIN_EMAILS).map((email) => email.toLowerCase()));
  if (adminEmails.size === 0) adminEmails.add([...allowedEmails][0]!);
  for (const email of adminEmails) {
    if (!allowedEmails.has(email)) throw new ConfigError(`ADMIN_EMAILS: ${email} is not in ALLOWED_EMAILS`);
  }

  const devLogin = flag(env.DEV_LOGIN);
  if (devLogin && (!loopback || env.NODE_ENV !== 'development')) {
    throw new ConfigError('DEV_LOGIN is only allowed with NODE_ENV=development and a localhost CONTROL_URL');
  }

  const issuer = env.OIDC_ISSUER ?? '';
  const clientId = env.OIDC_CLIENT_ID ?? '';
  const clientSecret = env.OIDC_CLIENT_SECRET ?? '';
  if (!devLogin && (!issuer || !clientId || !clientSecret)) {
    throw new ConfigError('OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET are required');
  }
  if (issuer) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(issuer);
    } catch {
      // reported below
    }
    if (
      !parsed ||
      (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)))
    ) {
      throw new ConfigError(`OIDC_ISSUER must be an https:// URL: ${issuer}`);
    }
  }

  const vapidPublic = env.VAPID_PUBLIC_KEY || null;
  const vapidPrivate = env.VAPID_PRIVATE_KEY || null;
  if (Boolean(vapidPublic) !== Boolean(vapidPrivate)) {
    throw new ConfigError('Set both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, or neither (keys are then generated)');
  }
  const secure = url.protocol === 'https:';
  // Push services want an https: or mailto: contact; a plain-http dev origin is neither.
  const vapidSubject = env.VAPID_SUBJECT || (secure ? url.origin : 'mailto:dev@socle.invalid');
  if (!/^(https:\/\/|mailto:)\S+$/.test(vapidSubject)) {
    throw new ConfigError('VAPID_SUBJECT must be an https:// URL or a mailto: address');
  }

  // In production the code that builds and runs what agents wrote lives in its own
  // container, without network or secrets. Starting it here is for development only.
  const runnerSocket = env.RUNNER_SOCKET ? path.resolve(env.RUNNER_SOCKET) : null;
  if (!runnerSocket && env.NODE_ENV === 'production') {
    throw new ConfigError(
      'RUNNER_SOCKET is required in production: the runner is a separate container (see compose.yaml)',
    );
  }
  const timezone = env.APP_TIMEZONE || 'UTC';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
  } catch {
    throw new ConfigError(`APP_TIMEZONE is not a known timezone: ${timezone}`);
  }
  const locale = (env.APP_LOCALE || 'en').toLowerCase();
  if (!isLocale(locale)) throw new ConfigError(`APP_LOCALE must be one of: ${LOCALES.join(', ')}`);

  return {
    controlOrigin: url.origin,
    controlHost: url.host,
    appsDomain,
    portSuffix: url.port ? `:${url.port}` : '',
    port: positiveInt(env.PORT, 8787, 'PORT'),
    // With DEV_LOGIN anyone who reaches the port can sign in: stay on this machine by default.
    host: env.HOST || (devLogin ? '127.0.0.1' : '0.0.0.0'),
    dataDir: path.resolve(env.DATA_DIR || 'data'),
    oidc: { issuer, clientId, clientSecret, name: env.OIDC_NAME?.trim() || null },
    allowedEmails,
    adminEmails,
    vapid: { publicKey: vapidPublic, privateKey: vapidPrivate, subject: vapidSubject },
    demoApp: flag(env.DEMO_APP),
    devLogin,
    secureCookies: secure,
    runnerSocket,
    timezone,
    locale,
    oauth: loadOAuthConfig(env),
  };
}

/** Origin of an app. Always built from the configuration, never from a request's Host header. */
export function appOrigin(config: Config, slug: string): string {
  return `${config.secureCookies ? 'https' : 'http'}://${slug}.${config.appsDomain}${config.portSuffix}`;
}

/** The address of an app (published or draft) a request host names: exactly one label in front of the apps domain. */
export function appSiteFromHost(config: Config, host: string): Site | null {
  const suffix = `.${config.appsDomain}${config.portSuffix}`;
  if (!host.endsWith(suffix)) return null;
  return parseSite(host.slice(0, -suffix.length));
}

/** The calendar date (YYYY-MM-DD) where the members live. */
export function localDate(config: Config, date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
