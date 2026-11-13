import * as oidc from 'openid-client';
import type { Config } from '../config.ts';
import { translator } from '../i18n.ts';
import { safeEqual } from '../lib/crypto.ts';

/** Holds a login in progress (see `Pending`) in the browser that started it. */
export const LOGIN_COOKIE = 'socle_login';
export const LOGIN_TTL_SEC = 600;
/** Where the provider sends the browser back: the redirect URI to register with it is CONTROL_URL + this path. */
export const CALLBACK_PATH = '/auth/callback';

export interface Identity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

export interface IdentityProvider {
  /**
   * Starts a login: the URL to send the browser to, and the value to keep in the
   * login cookie until the provider sends the browser back.
   */
  start(nextPath: string): Promise<{ url: string; pending: string }>;
  /** Completes it from the callback URL and the login cookie; throws on any failure. */
  finish(callbackUrl: URL, pending: string): Promise<{ identity: Identity; nextPath: string }>;
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

/** Sign-in with any OpenID Connect provider (Google, Microsoft, Keycloak, Authentik…), found by discovery. */
export function createOidcProvider(config: Config, options: { allowInsecure?: boolean } = {}): IdentityProvider {
  const t = translator(config.locale);
  let discovered: Promise<oidc.Configuration> | null = null;
  const configuration = () => {
    discovered ??= oidc
      .discovery(
        new URL(config.oidc.issuer),
        config.oidc.clientId,
        config.oidc.clientSecret,
        undefined,
        options.allowInsecure ? { execute: [oidc.allowInsecureRequests] } : undefined,
      )
      .catch((error: unknown) => {
        discovered = null; // retry discovery on the next login
        throw error;
      });
    return discovered;
  };
  const redirectUri = `${config.controlOrigin}${CALLBACK_PATH}`;

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
        throw new LoginError(t('This sign-in attempt is no longer valid. Start again.'));
      }
      const server = await configuration();
      const tokens = await oidc.authorizationCodeGrant(server, callbackUrl, {
        pkceCodeVerifier: pending.verifier,
        expectedState: pending.state,
        expectedNonce: pending.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims || typeof claims.email !== 'string') {
        throw new LoginError(t('The sign-in service did not provide an e-mail address.'));
      }
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
