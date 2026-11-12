import * as oidc from 'openid-client';
import type { Config } from '../config.ts';
import { safeEqual } from '../lib/crypto.ts';

/** Holds a login in progress (see `Pending`) in the browser that started it. */
export const LOGIN_COOKIE = 'socle_login';
export const LOGIN_TTL_SEC = 600;

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

export interface IdentityProvider {
  /**
   * Starts a login: the URL to send the browser to, and the value to keep in the
   * login cookie until Google sends the browser back.
   */
  start(nextPath: string): Promise<{ url: string; pending: string }>;
  /** Completes it from the callback URL and the login cookie; throws on any failure. */
  finish(callbackUrl: URL, pending: string): Promise<{ identity: GoogleIdentity; nextPath: string }>;
}

export class LoginError extends Error {}

// A login in progress lives in the browser, not in the database: an anonymous
// visitor cannot fill a table and lock everyone else out of signing in. The cookie
// is HttpOnly and `__Host-`, so only this host ever sees these values.
interface Pending {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  expires: number;
}

function encodePending(pending: Pending): string {
  return Buffer.from(JSON.stringify(pending)).toString('base64url');
}

function decodePending(value: string): Pending | null {
  try {
    const data = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    const { state, nonce, verifier, next, expires } = data;
    if (
      typeof state !== 'string' ||
      typeof nonce !== 'string' ||
      typeof verifier !== 'string' ||
      typeof next !== 'string' ||
      typeof expires !== 'number'
    ) {
      return null;
    }
    return { state, nonce, verifier, next, expires };
  } catch {
    return null;
  }
}

export function createGoogleProvider(config: Config, options: { allowInsecure?: boolean } = {}): IdentityProvider {
  let discovered: Promise<oidc.Configuration> | null = null;
  const configuration = () => {
    discovered ??= oidc
      .discovery(
        new URL(config.google.issuer),
        config.google.clientId,
        config.google.clientSecret,
        undefined,
        options.allowInsecure ? { execute: [oidc.allowInsecureRequests] } : undefined,
      )
      .catch((error: unknown) => {
        discovered = null; // retry discovery on the next login
        throw error;
      });
    return discovered;
  };
  const redirectUri = `${config.controlOrigin}/auth/google/callback`;

  return {
    async start(nextPath) {
      const server = await configuration();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const verifier = oidc.randomPKCECodeVerifier();
      const url = oidc.buildAuthorizationUrl(server, {
        redirect_uri: redirectUri,
        scope: 'openid email profile',
        response_type: 'code',
        state,
        nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
        prompt: 'select_account',
      });
      const expires = Date.now() + LOGIN_TTL_SEC * 1000;
      return { url: url.href, pending: encodePending({ state, nonce, verifier, next: nextPath, expires }) };
    },

    async finish(callbackUrl, pendingValue) {
      const pending = decodePending(pendingValue);
      const state = callbackUrl.searchParams.get('state') ?? '';
      if (!pending || pending.expires <= Date.now() || !safeEqual(pending.state, state)) {
        throw new LoginError('La tentative de connexion a expiré, recommence.');
      }
      const server = await configuration();
      const tokens = await oidc.authorizationCodeGrant(server, callbackUrl, {
        pkceCodeVerifier: pending.verifier,
        expectedState: pending.state,
        expectedNonce: pending.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims || typeof claims.email !== 'string') throw new LoginError('Google n’a pas fourni d’adresse e-mail.');
      return {
        identity: {
          sub: claims.sub,
          email: claims.email.toLowerCase(),
          emailVerified: claims.email_verified === true,
          name: typeof claims.name === 'string' ? claims.name : null,
        },
        nextPath: pending.next,
      };
    },
  };
}
