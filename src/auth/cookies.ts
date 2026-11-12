import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Config } from '../config.ts';

// Cookies are HttpOnly + SameSite=Lax, and `__Host-` prefixed (Secure, Path=/,
// no Domain) whenever the platform is served over https. The prefix matters here:
// apps are sibling subdomains, and a sibling can neither read nor overwrite a
// `__Host-` cookie. Never set a cookie with a Domain attribute.

export function setAppCookie(c: Context, config: Config, name: string, value: string, maxAgeSec: number): void {
  setCookie(c, name, value, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'Lax',
    path: '/',
    maxAge: maxAgeSec,
    ...(config.secureCookies ? { prefix: 'host' as const } : {}),
  });
}

export function readAppCookie(c: Context, config: Config, name: string): string | undefined {
  return config.secureCookies ? getCookie(c, name, 'host') : getCookie(c, name);
}

export function clearAppCookie(c: Context, config: Config, name: string): void {
  deleteCookie(c, name, {
    path: '/',
    secure: config.secureCookies,
    ...(config.secureCookies ? { prefix: 'host' as const } : {}),
  });
}
