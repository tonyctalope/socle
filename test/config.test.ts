import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isValidSlug } from '../src/apps/slug.ts';
import { appOrigin, appSlugFromHost, ConfigError, loadConfig } from '../src/config.ts';
import { safeNextPath } from '../src/lib/http.ts';
import { testConfig } from './helpers.ts';

const base = {
  CONTROL_URL: 'https://socle.example.com',
  APPS_DOMAIN: 'apps.example.com',
  ALLOWED_EMAILS: 'a@example.com',
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
};

describe('configuration', () => {
  it('derives the control host and the app origins', () => {
    const config = loadConfig(base);
    assert.equal(config.controlOrigin, 'https://socle.example.com');
    assert.equal(config.controlHost, 'socle.example.com');
    assert.equal(appOrigin(config, 'tricount'), 'https://tricount.apps.example.com');
    assert.equal(config.secureCookies, true);
  });

  it('keeps the port for local development', () => {
    const config = loadConfig({
      ...base,
      CONTROL_URL: 'http://socle.localhost:8787',
      APPS_DOMAIN: 'apps.localhost',
      NODE_ENV: 'development',
      DEV_LOGIN: '1',
      GOOGLE_CLIENT_ID: '',
    });
    assert.equal(appOrigin(config, 'demo'), 'http://demo.apps.localhost:8787');
    assert.equal(appSlugFromHost(config, 'demo.apps.localhost:8787'), 'demo');
    assert.equal(appSlugFromHost(config, 'demo.apps.localhost'), null);
    assert.equal(config.secureCookies, false);
  });

  it('refuses unsafe or inconsistent settings', () => {
    const refused = (env: Record<string, string>, message: RegExp) =>
      assert.throws(
        () => loadConfig({ ...base, ...env }),
        (error) => error instanceof ConfigError && message.test(error.message),
      );
    refused({ CONTROL_URL: 'http://socle.example.com' }, /https/);
    refused({ CONTROL_URL: 'https://socle.example.com/admin' }, /origin without path/);
    refused({ APPS_DOMAIN: '' }, /APPS_DOMAIN is required/);
    refused({ APPS_DOMAIN: 'apps_example' }, /not a valid domain/);
    // The control plane must not be reachable as an app: an app named like it would replace it.
    refused({ CONTROL_URL: 'https://socle.apps.example.com' }, /must not be inside APPS_DOMAIN/);
    refused({ CONTROL_URL: 'https://apps.example.com' }, /must not be inside APPS_DOMAIN/);
    refused({ APPS_DOMAIN: 'apps.localhost' }, /both be public, or both be localhost/);
    refused({ DEV_LOGIN: '1' }, /DEV_LOGIN is only allowed/);
    refused({ GOOGLE_CLIENT_SECRET: '' }, /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/);
    refused({ ALLOWED_EMAILS: '' }, /at least one/);
    refused({ VAPID_PUBLIC_KEY: 'only-one' }, /both VAPID/);
  });
});

describe('which app a host belongs to', () => {
  const config = testConfig();

  it('accepts exactly one valid label in front of the apps domain', () => {
    assert.equal(appSlugFromHost(config, 'demo.apps.test'), 'demo');
    assert.equal(appSlugFromHost(config, 'tri-count2.apps.test'), 'tri-count2');
  });

  it('refuses everything else', () => {
    for (const host of [
      'apps.test',
      'socle.test',
      'a.demo.apps.test', // nested label
      'demo.apps.test.evil.example', // suffix in the middle
      'demoapps.test',
      'demo.apps.test:8443', // unexpected port
      'x.apps.test', // too short
      '-demo.apps.test',
      'demo-.apps.test',
      'de--mo.apps.test',
      'DEMO.apps.test', // callers lowercase first
      'admin.apps.test', // reserved
      'login.apps.test',
      `${'a'.repeat(33)}.apps.test`,
    ]) {
      assert.equal(appSlugFromHost(config, host), null, host);
    }
  });

  it('validates slugs', () => {
    assert.equal(isValidSlug('plantes'), true);
    assert.equal(isValidSlug('a1'), true);
    assert.equal(isValidSlug('1a'), false);
    assert.equal(isValidSlug('socle'), false);
    assert.equal(isValidSlug('a.b'), false);
  });
});

describe('redirect targets', () => {
  it('only accepts local paths outside the platform prefix', () => {
    assert.equal(safeNextPath('/depenses/12?tab=2'), '/depenses/12?tab=2');
    assert.equal(safeNextPath('/a/../b'), '/b'); // returned as a browser would resolve it
    assert.equal(safeNextPath('/_socleil'), '/_socleil'); // only the exact prefix is reserved
    for (const next of [
      undefined,
      '',
      'https://evil.example/',
      '//evil.example/',
      '/\\evil.example',
      '/a\nb',
      '/\t/evil.example',
      '/_socle/login?next=/',
      '/_socle',
      '/./_socle/api/me',
      '/x/../_socle/sso?code=abc',
      '/%5Fsocle/login',
      '/%5fsocle/login',
      '/%E0%A4%A', // malformed escape
      `/${'a'.repeat(600)}`,
    ]) {
      assert.equal(safeNextPath(next), '/', String(next));
    }
  });
});
