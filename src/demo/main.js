// Demo app: checks, on a real phone, the three things every app gets from the
// platform — the sign-in, the home-screen install and the notifications.
import { install, logout, me, push } from '/_socle/sdk.js';

const root = document.getElementById('root');

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const PUSH_LABELS = {
  unsupported: 'Ce navigateur ne propose pas les notifications.',
  denied: 'Les notifications sont bloquées pour cette appli dans les réglages du navigateur.',
  off: 'Les notifications sont désactivées sur cet appareil.',
  on: 'Les notifications sont activées sur cet appareil.',
};

async function render() {
  const { user, app } = await me();
  const standalone = install.standalone();
  let state = await push.state();
  const needsInstall = state === 'unsupported' && install.needsHomeScreenForPush() && !standalone;

  const status = el('p', { className: 'status', role: 'status' });
  const say = (text, kind = '') => {
    status.textContent = text;
    status.dataset.kind = kind;
  };
  const run = (button, action) => async () => {
    button.disabled = true;
    try {
      await action();
    } catch (error) {
      say(error.message || 'Une erreur est survenue.', 'error');
    } finally {
      button.disabled = false;
    }
  };

  const toggle = el('button', { className: 'primary' });
  const test = el('button', { className: 'secondary', textContent: 'Envoyer une notification de test' });
  const pushLine = el('p');
  const refresh = () => {
    pushLine.textContent = needsInstall
      ? 'Sur iPhone et iPad, les notifications ne marchent qu’une fois l’appli ajoutée à l’écran d’accueil.'
      : PUSH_LABELS[state];
    toggle.textContent = state === 'on' ? 'Désactiver les notifications' : 'Activer les notifications';
    toggle.hidden = state === 'unsupported' || state === 'denied';
    test.hidden = state !== 'on';
  };
  toggle.onclick = run(toggle, async () => {
    state = state === 'on' ? await push.disable() : await push.enable();
    refresh();
    say('');
  });
  test.onclick = run(test, async () => {
    const { sent } = await push.test();
    say(sent > 0 ? 'Notification envoyée.' : 'Aucun appareil n’a accepté la notification.', sent > 0 ? 'ok' : 'error');
  });
  refresh();

  const out = el('button', { className: 'link', textContent: 'Se déconnecter' });
  out.onclick = run(out, logout);

  root.replaceChildren(
    el(
      'main',
      {},
      el('h1', { textContent: `Bonjour ${user.name}` }),
      el('p', { className: 'muted', textContent: `Tu es connecté à « ${app.name} » sur ${location.host}.` }),
      el(
        'section',
        {},
        el('h2', { textContent: 'Installation' }),
        el('p', {
          textContent: standalone
            ? 'L’appli est ouverte depuis l’écran d’accueil.'
            : 'L’appli est ouverte dans le navigateur. Pour l’installer, choisis « Ajouter à l’écran d’accueil » dans le menu du navigateur.',
        }),
      ),
      el('section', {}, el('h2', { textContent: 'Notifications' }), pushLine, toggle, test, status),
      out,
    ),
  );
}

render().catch((error) => {
  root.replaceChildren(el('main', {}, el('h1', { textContent: 'Erreur' }), el('p', { textContent: error.message })));
});
