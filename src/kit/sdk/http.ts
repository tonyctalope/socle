// Calls to the platform's API of this app (same origin, session cookie).

const API = '/_socle/api';

export class ApiError extends Error {
  /** HTTP status, and the machine-readable reason given by the platform or by the app's function. */
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** Sends the browser through sign-on and back to the current page. */
export function toLogin(): Promise<never> {
  location.assign(`/_socle/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  return new Promise(() => {}); // the page is navigating away
}

export async function request<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(API + path, {
      method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Pas de connexion au serveur.', 0, 'offline');
  }
  if (response.status === 401) return toLogin();
  if (response.status === 204) return null as T;
  const data = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
  if (!response.ok) {
    throw new ApiError(data?.message || `Erreur ${response.status}`, response.status, data?.error || 'error');
  }
  return data as T;
}
