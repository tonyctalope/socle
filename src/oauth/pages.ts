import { html } from 'hono/html';
import type { Locale, Translate } from '../i18n.ts';
import { page } from '../pages/layout.ts';

// The two pages of the authorization flow. Like every page of the control plane they
// carry no JavaScript, and every value is escaped by hono/html: the client's name and
// the redirect host come from whoever registered the client.

export interface ConsentView {
  /** Null when the client declared no name. */
  clientName: string | null;
  /** The host that publishes the client's metadata document, when there is one. */
  verifiedHost: string | null;
  redirect: { kind: 'web'; host: string } | { kind: 'loopback'; host: string };
  email: string;
  requestId: string;
  /** What the client asks to use, in the words of whoever owns that resource. */
  resource: { name: string; description: string };
}

export function consentPage(locale: Locale, t: Translate, view: ConsentView) {
  const client = view.clientName ?? t('An application');
  const identity = view.verifiedHost
    ? t('The identity of this application is published by {host}.', { host: view.verifiedHost })
    : view.clientName
      ? t('The application chose this name itself: nothing verifies it.')
      : t('This application did not give its name.');
  const destination =
    view.redirect.kind === 'web'
      ? t('Your answer is sent to {host}.', { host: view.redirect.host })
      : t('Your answer is sent to an application on this device ({host}).', { host: view.redirect.host });
  const decision = (value: 'allow' | 'deny', style: 'primary' | 'secondary', label: string) =>
    html`<form class="actions" method="post" action="/oauth/authorize">
      <input type="hidden" name="request" value="${view.requestId}" />
      <button class="${style}" name="decision" value="${value}" type="submit">${label}</button>
    </form>`;
  return page(
    locale,
    t('Authorize access'),
    html`<img class="logo" src="/icons/icon-192.png" alt="" />
      <h1>${t('{client} wants to use {name}', { client, name: view.resource.name })}</h1>
      ${view.resource.description ? html`<p>${view.resource.description}</p>` : ''}
      <ul class="muted">
        <li>${t('You are signed in as {email}.', { email: view.email })}</li>
        <li>${identity}</li>
        <li>${destination}</li>
      </ul>
      ${
        view.redirect.kind === 'loopback'
          ? html`<p>
              <strong
                >${t(
                  'Only allow this if you have just started the connection yourself, from an application on this device.',
                )}</strong
              >
            </p>`
          : ''
      }
      ${decision('allow', 'primary', t('Allow'))} ${decision('deny', 'secondary', t('Deny'))}`,
  );
}

/**
 * The page that takes the browser back to the client with the answer. The address is
 * followed by the page itself (a refresh, and a link for browsers that do not follow
 * it): see `handOver` in routes.ts for why this is not an HTTP redirect.
 */
export function handOverPage(locale: Locale, t: Translate, url: string) {
  return page(
    locale,
    t('Back to the application'),
    html`<meta http-equiv="refresh" content="0;url=${url}" />
      <img class="logo" src="/icons/icon-192.png" alt="" />
      <h1>${t('Back to the application')}</h1>
      <p>${t('You are being sent back to the application.')}</p>
      <p class="actions"><a class="button primary" href="${url}">${t('Continue')}</a></p>`,
  );
}
