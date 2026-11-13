import { useEffect, useState } from 'react';
import { boot, words } from './boot.ts';
import { request } from './http.ts';
import { pathToOpen } from './navigate.ts';

const TEXT = words({ en: { failed: 'Something went wrong.' }, fr: { failed: 'Une erreur est survenue.' } });

// What every app gets from the platform besides its own functions: who is signed
// in, signing out, the home-screen install state and notifications.

/** Who is signed in, which app this is, and everyone who can open it. */
export function useMe(): { user: typeof boot.user; app: typeof boot.app; members: typeof boot.members } {
  return boot;
}

/** Ends the sign-in on this browser, for every app, then shows this app's signed-out page. */
export async function logout(): Promise<void> {
  const { url } = await request<{ url: string }>('POST', '/logout');
  location.assign(url);
}

export const install = {
  /** True when the app runs from the home screen rather than in a browser tab. */
  standalone: (): boolean =>
    matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true,
  /** iPhone and iPad only deliver notifications to apps added to the home screen. */
  needsHomeScreenForPush: (): boolean =>
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1),
};

// The platform's service worker (notifications). Registered once per page load.
const registration: Promise<ServiceWorkerRegistration | null> =
  'serviceWorker' in navigator
    ? navigator.serviceWorker.register('/_socle/sw.js', { scope: '/' }).catch((error: unknown) => {
        console.warn('socle: service worker not registered', error);
        return null;
      })
    : Promise.resolve(null);

// A notification tapped while this page is open: go to the page it is about.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const path = pathToOpen(event.data, location);
    if (path !== null) location.assign(path);
  });
}

// A browser subscription can outlive what the server knows (sign-out, another member
// signing in, an endpoint that changed): tell the server again on every page load.
void registration
  .then(async (worker) => {
    if (!worker || !('PushManager' in window) || Notification.permission !== 'granted') return;
    const subscription = await worker.pushManager.getSubscription();
    if (subscription) await request('POST', '/push/subscriptions', subscription.toJSON());
  })
  .catch(() => {});

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

export type PushState = 'unsupported' | 'denied' | 'off' | 'on';

export const push = {
  supported: (): boolean => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,

  /** Whether this browser receives the notifications of this app. */
  async state(): Promise<PushState> {
    if (!push.supported()) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    const worker = await registration;
    return worker && (await worker.pushManager.getSubscription()) ? 'on' : 'off';
  },

  /** Asks for the permission if needed and subscribes this browser. Call it from a tap. */
  async enable(): Promise<PushState> {
    if (!push.supported()) return 'unsupported';
    if ((await Notification.requestPermission()) !== 'granted') return 'denied';
    await registration;
    const worker = await navigator.serviceWorker.ready;
    const options = { userVisibleOnly: true, applicationServerKey: keyBytes(boot.push.publicKey) };
    let subscription = await worker.pushManager.getSubscription();
    if (!subscription) {
      subscription = await worker.pushManager.subscribe(options);
    } else if (subscription.options.applicationServerKey) {
      // A subscription made with an older server key no longer works: start over.
      const current = new Uint8Array(subscription.options.applicationServerKey);
      const wanted = options.applicationServerKey;
      if (current.length !== wanted.length || current.some((byte, index) => byte !== wanted[index])) {
        await subscription.unsubscribe();
        subscription = await worker.pushManager.subscribe(options);
      }
    }
    await request('POST', '/push/subscriptions', subscription.toJSON());
    return 'on';
  },

  async disable(): Promise<PushState> {
    const worker = await registration;
    const subscription = await worker?.pushManager.getSubscription();
    if (!subscription) return 'off';
    await request('DELETE', '/push/subscriptions', { endpoint: subscription.endpoint });
    await subscription.unsubscribe();
    return 'off';
  },

  /** Sends a test notification to the signed-in user's devices. */
  test: (): Promise<{ sent: number }> => request('POST', '/push/test'),
};

/**
 * Notifications of this app on this device, for a settings screen:
 *   const { state, toggle, busy } = usePush();
 * `state` is null until known; `needsInstall` is true on an iPhone whose app is not on the home screen yet.
 */
export function usePush(): {
  state: PushState | null;
  needsInstall: boolean;
  busy: boolean;
  error: string | null;
  toggle: () => Promise<void>;
  test: () => Promise<number>;
} {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void push.state().then((value) => alive && setState(value));
    return () => {
      alive = false;
    };
  }, []);
  const run = async <T>(action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch (failure) {
      setError((failure as Error).message || TEXT.failed);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return {
    state,
    needsInstall: state === 'unsupported' && install.needsHomeScreenForPush() && !install.standalone(),
    busy,
    error,
    toggle: async () => {
      const next = await run(() => (state === 'on' ? push.disable() : push.enable()));
      if (next) setState(next);
    },
    test: async () => (await run(() => push.test()))?.sent ?? 0,
  };
}
