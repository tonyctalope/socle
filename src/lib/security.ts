import type { Context, MiddlewareHandler } from 'hono';
import type { Config } from '../config.ts';

/** Control-plane pages are server-rendered and carry no script at all. */
export const CONTROL_CSP = [
  "default-src 'none'",
  "img-src 'self'",
  "style-src 'unsafe-inline'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

/**
 * App pages and their workers may only talk to their own origin: no request to another
 * app, to the control plane or to the outside (connect-src, form-action), and nothing
 * loaded from elsewhere. Navigations cannot be restricted by CSP.
 */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-src 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

export function securityHeaders(config: Config, pageCsp: string): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const apply = (headers: Headers) => {
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('X-Frame-Options', 'DENY');
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Resource-Policy', 'same-origin');
      headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
      if (!headers.has('Referrer-Policy')) headers.set('Referrer-Policy', 'same-origin');
      if (config.secureCookies) headers.set('Strict-Transport-Security', 'max-age=31536000');
      // On every response, not only pages: a worker takes its policy from its own script
      // response, and an SVG file opened directly is a document of its own.
      headers.set('Content-Security-Policy', pageCsp);
    };
    try {
      apply(c.res.headers);
    } catch {
      c.res = new Response(c.res.body, c.res); // immutable headers (e.g. Response.redirect)
      apply(c.res.headers);
    }
  };
}

export function onError(error: Error, c: Context): Response {
  console.error('unhandled error:', error);
  return c.text('Erreur interne', 500);
}
