import { createHash } from 'node:crypto';

/** RFC 7636 S256 code challenge of a PKCE verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** RFC 7636 §4.1: 43–128 characters from the unreserved set. */
export function isValidPkceVerifier(verifier: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier);
}

/** S256 challenges are base64url SHA-256 digests: exactly 43 characters. */
export function isValidPkceChallenge(challenge: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(challenge);
}
