import { ConfigError, type Config } from '../config.ts';
import type { Deps } from '../types.ts';

export interface OAuthConfig {
  /** Exact https redirect URIs accepted for MCP clients (besides loopback). */
  redirectUris: readonly string[];
  /** Hosts trusted to serve Client ID Metadata Documents (".example.com" = its subdomains). */
  cimdHosts: readonly string[];
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
}

/** The platform's dependencies, with the authorization server's settings on `config.oauth`. */
export type OAuthDeps = Omit<Deps, 'config'> & {
  config: Config & { oauth: OAuthConfig };
  /** Fetches client metadata documents; tests replace it. Defaults to the global fetch. */
  fetch?: typeof fetch;
};

const list = (value: string): string[] =>
  value
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new ConfigError(`${name} must be a positive integer`);
  return parsed;
}

/** Where Claude (web, desktop and mobile) receives authorization codes. */
const DEFAULT_REDIRECT_URIS = 'https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback';
const DEFAULT_CIMD_HOSTS = 'claude.ai,claude.com,anthropic.com';

export function loadOAuthConfig(env: NodeJS.ProcessEnv): OAuthConfig {
  const redirectUris = list(env.OAUTH_REDIRECT_URIS ?? DEFAULT_REDIRECT_URIS).map((uri) => {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new ConfigError(`OAUTH_REDIRECT_URIS: invalid URL ${uri}`);
    }
    if (parsed.protocol !== 'https:' || parsed.hash) {
      throw new ConfigError(`OAUTH_REDIRECT_URIS: ${uri} must be an https:// URL without fragment`);
    }
    return parsed.href;
  });
  return {
    redirectUris,
    cimdHosts: list(env.OAUTH_CIMD_HOSTS ?? DEFAULT_CIMD_HOSTS).map((host) => host.toLowerCase()),
    accessTokenTtlSec: positiveInt(env.OAUTH_ACCESS_TOKEN_TTL, 3600, 'OAUTH_ACCESS_TOKEN_TTL'),
    refreshTokenTtlSec: positiveInt(env.OAUTH_REFRESH_TOKEN_TTL, 90 * 24 * 3600, 'OAUTH_REFRESH_TOKEN_TTL'),
  };
}
