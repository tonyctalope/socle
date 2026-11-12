// Socle browser SDK, served by the platform at /_socle/sdk.js on every app host.
// Apps import it from there and never bundle it, so updating the platform updates
// every app. Plain JavaScript on purpose: it is served as-is, with no build step.

const API = '/_socle/api';

/** Sends the browser through sign-on and comes back to the current page. */
function toLogin() {
  location.assign(`/_socle/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  return new Promise(() => {}); // the page is navigating away
}

async function call(method, path, body) {
  const response = await fetch(API + path, {
    method,
    credentials: 'same-origin',
    headers:
      body === undefined
        ? { Accept: 'application/json' }
        : { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401) return toLogin();
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw Object.assign(new Error(data?.message || `HTTP ${response.status}`), {
      status: response.status,
      code: data?.error,
    });
  }
  return data;
}

/** Who is signed in and which app this is: { user: { id, name }, app: { slug, name }, push }. */
export const me = () => call('GET', '/me');

/** Ends the sign-in on this browser, for every app, then leaves for the home page. */
export async function logout() {
  const { url } = await call('POST', '/logout');
  location.assign(url);
}

// The platform's service worker (notifications). Registered once per page load.
const registration =
  'serviceWorker' in navigator
    ? navigator.serviceWorker.register('/_socle/sw.js', { scope: '/' }).catch((error) => {
        console.warn('socle: service worker not registered', error);
        return null;
      })
    : Promise.resolve(null);

// A browser subscription can outlive what the server knows (sign-out, another member
// signing in, an endpoint that changed): tell the server again on every page load.
registration
  .then(async (worker) => {
    if (!worker || !('PushManager' in window) || Notification.permission !== 'granted') return;
    const subscription = await worker.pushManager.getSubscription();
    if (!subscription) return;
    await fetch(`${API}/push/subscriptions`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription.toJSON()),
    });
  })
  .catch(() => {});

export const install = {
  /** True when the app runs from the home screen rather than in a browser tab. */
  standalone: () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
  /** iPhone and iPad only deliver notifications to apps added to the home screen. */
  needsHomeScreenForPush: () =>
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1),
};

function keyBytes(base64url) {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

export const push = {
  supported: () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,

  /** 'unsupported' | 'denied' | 'off' | 'on' for this browser and this app. */
  async state() {
    if (!push.supported()) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    const worker = await registration;
    return worker && (await worker.pushManager.getSubscription()) ? 'on' : 'off';
  },

  /** Asks for the permission if needed and subscribes this browser. Call it from a tap. */
  async enable() {
    if (!push.supported()) return 'unsupported';
    if ((await Notification.requestPermission()) !== 'granted') return 'denied';
    await registration;
    const worker = await navigator.serviceWorker.ready;
    const { push: server } = await me();
    const options = { userVisibleOnly: true, applicationServerKey: keyBytes(server.publicKey) };
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
    await call('POST', '/push/subscriptions', subscription.toJSON());
    return 'on';
  },

  async disable() {
    const worker = await registration;
    const subscription = await worker?.pushManager.getSubscription();
    if (!subscription) return 'off';
    await call('DELETE', '/push/subscriptions', { endpoint: subscription.endpoint });
    await subscription.unsubscribe();
    return 'off';
  },

  /** Sends a test notification to the signed-in user's devices: { sent: number }. */
  test: () => call('POST', '/push/test'),
};
