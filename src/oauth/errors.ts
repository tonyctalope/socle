/** The only scope: using the protected resource the grant names, as the member who allowed it. */
export const SCOPE = 'socle';

/** An OAuth error response (RFC 6749 §5.2 / RFC 7591 §3.2.2). Descriptions are for machines: plain English. */
export class OAuthFailure extends Error {
  readonly code: string;
  readonly description: string;
  readonly status: 400 | 401 | 403 | 429;

  constructor(code: string, description: string, status: 400 | 401 | 403 | 429 = 400) {
    super(`${code}: ${description}`);
    this.code = code;
    this.description = description;
    this.status = status;
  }

  body(): { error: string; error_description: string } {
    return { error: this.code, error_description: this.description };
  }
}
