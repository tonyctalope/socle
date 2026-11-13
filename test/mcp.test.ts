import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { serve, type ServerType } from '@hono/node-server';
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientInformationContext,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthTokens,
} from '@modelcontextprotocol/client';
import { CONTROL_SCOPE, createSession } from '../src/auth/sessions.ts';
import { upsertUser } from '../src/auth/users.ts';
import { GUIDE } from '../src/mcp/guide.ts';
import { DEFAULT_LIMITS } from '../src/runner/limits.ts';
import { ALICE, BOB, setup, type TestContext } from './helpers.ts';

// The builder, end to end, with the official MCP client over real HTTP: discovery, registration,
// consent in a browser, PKCE, then the tools an agent creates an app with.

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

class TestProvider implements OAuthClientProvider {
  private readonly creds = new Map<string, OAuthClientInformationMixed>();
  private stored?: OAuthTokens;
  private verifier?: string;
  private discovery?: OAuthDiscoveryState;
  lastState?: string;
  authorizationUrl?: URL;
  readonly redirectUrl = 'http://127.0.0.1:43123/callback';
  readonly clientMetadata: OAuthClientMetadata = {
    client_name: 'Test agent',
    redirect_uris: [this.redirectUrl],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    application_type: 'native',
  };
  clientInformation(context?: OAuthClientInformationContext) {
    return context ? this.creds.get(context.issuer) : undefined;
  }
  saveClientInformation(info: OAuthClientInformationMixed, context?: OAuthClientInformationContext) {
    if (context) this.creds.set(context.issuer, info);
  }
  tokens() {
    return this.stored;
  }
  saveTokens(tokens: OAuthTokens) {
    this.stored = tokens;
  }
  state() {
    this.lastState = randomUUID();
    return this.lastState;
  }
  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.discovery = state;
  }
  discoveryState() {
    return this.discovery;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    if (!this.verifier) throw new Error('no verifier');
    return this.verifier;
  }
}

const NAVIGATION = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };

describe('the builder: an agent creates an app over MCP', () => {
  let ctx: TestContext;
  let server: ServerType;
  let origin: string;
  let client: Client;
  let aliceCookie: string;

  /** A signed-in browser of the control plane, as its cookie header. */
  const browserOf = (email: string) => {
    const user = upsertUser(ctx.deps.db, { sub: `sub-${email}`, email, name: email.split('@')[0]! });
    const { token } = createSession(ctx.deps.db, {
      userId: user.id,
      scope: CONTROL_SCOPE,
      family: `family-${randomUUID()}`,
      userAgent: 'test',
    });
    return `socle_session=${token}`;
  };

  /** What the member's browser does: open the authorization URL, allow, follow the way back. */
  async function approve(authorizationUrl: URL, cookie: string): Promise<URLSearchParams> {
    // In process: Node's fetch always says it is not a navigation, and the server checks.
    const start = await ctx.app.request(authorizationUrl, { headers: { cookie, ...NAVIGATION } });
    assert.equal(start.status, 302, await start.text());
    const consentUrl = new URL(start.headers.get('location')!, origin);
    const page = await (await ctx.app.request(consentUrl, { headers: { cookie, ...NAVIGATION } })).text();
    assert.match(page, /Test agent[\s\S]*wants to use the app builder/);
    const request = /name="request" value="([^"]+)"/.exec(page)![1]!;
    const answer = await ctx.app.request(new URL('/oauth/authorize', origin), {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded', ...NAVIGATION },
      body: new URLSearchParams({ request, decision: 'allow' }),
    });
    assert.equal(answer.status, 200);
    const target = /http-equiv="refresh" content="0;url=([^"]+)"/.exec(await answer.text())![1]!;
    return new URL(target.replaceAll('&amp;', '&')).searchParams;
  }

  async function connect(cookie: string): Promise<Client> {
    const provider = new TestProvider();
    const mcpUrl = new URL('/mcp', origin);
    const first = new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider });
    await assert.rejects(new Client({ name: 'test', version: '1.0.0' }).connect(first), UnauthorizedError);
    assert.equal(provider.authorizationUrl?.pathname, '/oauth/authorize');
    assert.equal(provider.authorizationUrl?.searchParams.get('resource'), `${origin}/mcp`);
    const params = await approve(provider.authorizationUrl!, cookie);
    assert.equal(params.get('state'), provider.lastState);
    assert.equal(params.get('iss'), origin);
    await first.finishAuth(params);
    const connected = new Client({ name: 'test', version: '1.0.0' });
    await connected.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider }));
    return connected;
  }

  const tool = async (name: string, args: Record<string, unknown> = {}, from: Client = client) => {
    const result = await from.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text?: string }[]).find((item) => item.type === 'text')?.text ?? '';
    return { isError: result.isError === true, text, json: <T = any>() => JSON.parse(text) as T };
  };

  before(async () => {
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    ctx = setup({
      limits: { ...DEFAULT_LIMITS, callMs: 1_500, killGraceMs: 300 },
      env: { CONTROL_URL: origin, APPS_DOMAIN: 'apps.localhost' },
    });
    server = serve({ fetch: ctx.app.fetch, port, hostname: '127.0.0.1' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    aliceCookie = browserOf(ALICE); // a member who does not administer the instance
    client = await connect(aliceCookie);
  });
  after(async () => {
    await client?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ctx.cleanup();
  });

  it('refuses whoever has no token, and says where to get one', async () => {
    const anonymous = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(anonymous.status, 401);
    assert.match(
      anonymous.headers.get('www-authenticate') ?? '',
      new RegExp(`resource_metadata="${origin}/\\.well-known/oauth-protected-resource/mcp"`),
    );
    const metadata = (await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json()) as {
      resource: string;
      authorization_servers: string[];
    };
    assert.deepEqual(metadata.authorization_servers, [origin]);
    assert.equal(metadata.resource, `${origin}/mcp`);
    // A session cookie is not a way in: the endpoint only knows bearer tokens.
    const withCookie = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: aliceCookie },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(withCookie.status, 401);
  });

  it('offers the tools to write apps, and none that publishes or deletes', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((entry) => entry.name).sort(), [
      'call_function',
      'create_app',
      'list_apps',
      'read_files',
      'read_guide',
      'read_logs',
      'write_files',
    ]);
    assert.match(client.getInstructions() ?? '', /cannot publish/);
    assert.equal((await tool('read_guide')).text, GUIDE);
  });

  it('describes in its guide the kit as it is', async () => {
    // Every component and SDK function the guide names exists, and no component is left out.
    const ui = await import('node:fs').then((fs) => fs.readFileSync('src/kit/ui/index.tsx', 'utf8'));
    const components = [...ui.matchAll(/^export function (\w+)/gm)].map((match) => match[1]!);
    assert.ok(components.length > 10);
    for (const name of components)
      assert.match(GUIDE, new RegExp(`\\b${name}\\b`), `${name} is missing from the guide`);
    const variants = /const BUTTON_VARIANTS = \{([\s\S]*?)\};/.exec(ui)![1]!;
    for (const variant of variants.matchAll(/^\s+(\w+):/gm)) assert.match(GUIDE, new RegExp(`'${variant[1]}'`));
    const sdk = await import('node:fs').then((fs) => fs.readFileSync('src/kit/sdk/index.ts', 'utf8'));
    for (const name of ['api', 'useQuery', 'useMe', 'logout', 'locale', 'words', 'usePush', 'install', 'ApiError']) {
      assert.match(sdk, new RegExp(`\\b${name}\\b`));
      assert.match(GUIDE, new RegExp(`\\b${name}\\b`));
    }
  });

  it('creates an app, writes it, fixes what does not build and tries its functions', async () => {
    assert.equal((await tool('create_app', { app: 'Bad Name', name: 'X' })).isError, true);
    const created = await tool('create_app', { app: 'chores', name: 'Chores', description: 'Who does what' });
    assert.equal(created.isError, false, created.text);
    assert.equal(created.json().built, true);
    assert.equal(
      created.json().draft_url,
      'http://chores--draft.apps.localhost' + origin.slice(origin.lastIndexOf(':')) + '/',
    );
    assert.equal((await tool('create_app', { app: 'chores', name: 'Again' })).isError, true);

    const listing = (await tool('read_files', { app: 'chores' })).json();
    assert.deepEqual(
      listing.files.map((file: { path: string }) => file.path),
      ['app.json', 'web/main.tsx'],
    );
    assert.equal(listing.published, null);

    // A first attempt that does not build: the problems come back, the files are kept.
    const broken = await tool('write_files', {
      app: 'chores',
      files: [
        {
          path: 'migrations/001_init.sql',
          content: 'CREATE TABLE chores (id INTEGER PRIMARY KEY, label TEXT NOT NULL);',
        },
        {
          path: 'server/index.ts',
          content:
            "import { query } from '@socle/server';\nimport fs from 'node:fs';\nexport const list = query(() => fs);",
        },
      ],
    });
    assert.equal(broken.json().built, false);
    assert.match(JSON.stringify(broken.json().problems), /node:fs/);
    const kept = (await tool('read_files', { app: 'chores', paths: ['server/index.ts'] })).json();
    assert.match(kept.files['server/index.ts'], /node:fs/);

    const fixed = await tool('write_files', {
      app: 'chores',
      files: [
        {
          path: 'server/index.ts',
          content: `import { mutation, query, v } from '@socle/server';
            export const list = query(({ db }) => db.all('SELECT id, label FROM chores ORDER BY id'));
            export const add = mutation({
              input: v.object({ label: v.string().min(1) }),
              handler: ({ db, user }, { label }) => {
                console.log('added by', user.name);
                return db.run('INSERT INTO chores (label) VALUES (?)', label).lastInsertRowid;
              },
            });`,
        },
      ],
    });
    assert.equal(fixed.json().built, true, fixed.text);
    assert.deepEqual(fixed.json().migrations_applied_to_draft, ['001_init.sql']);
    assert.deepEqual(
      fixed.json().functions.map((info: { name: string }) => info.name),
      ['add', 'list'],
    );
    assert.match(fixed.json().next, /administrator publishes it at http.*\/admin\//);

    assert.deepEqual(
      (await tool('call_function', { app: 'chores', function: 'add', input: { label: 'Dishes' } })).json(),
      {
        ok: true,
        kind: 'mutation',
        result: 1,
        notifications: 0,
        logs: ['log: added by alice'],
      },
    );
    assert.deepEqual((await tool('call_function', { app: 'chores', function: 'list' })).json().result, [
      { id: 1, label: 'Dishes' },
    ]);
    const refused = (await tool('call_function', { app: 'chores', function: 'add', input: { label: '' } })).json();
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'invalid_input');
    assert.equal((await tool('call_function', { app: 'chores', function: 'nope' })).isError, true);
    const logs = (await tool('read_logs', { app: 'chores' })).json();
    assert.deepEqual(
      logs.lines.map((line: { fn: string; message: string }) => [line.fn, line.message]),
      [['add', 'added by alice']],
    );

    const removed = await tool('write_files', { app: 'chores', delete: ['nope.ts'] });
    assert.equal(removed.isError, true);
    assert.equal((await tool('read_files', { app: 'ghost' })).isError, true);
  });

  it('leaves the publication to an administrator', async () => {
    // Nothing the agent did is visible to members: the app has no published version.
    const before = (await tool('list_apps')).json();
    const chores = before.apps.find((app: { app: string }) => app.app === 'chores');
    assert.equal(chores.published, null);
    assert.equal(chores.draft.waiting_for_publication, true);
    assert.equal(ctx.deps.apps.status('chores')!.live, null);

    // The member whose agent wrote the app cannot publish it either; the administrator can.
    const publish = (cookie: string) =>
      fetch(`${origin}/admin/apps/chores/publish`, { method: 'POST', headers: { cookie, origin }, redirect: 'manual' });
    assert.equal((await publish(aliceCookie)).status, 403);
    assert.equal((await publish(browserOf(BOB))).status, 303);
    const after = (await tool('list_apps')).json().apps.find((app: { app: string }) => app.app === 'chores');
    assert.ok(after.published.url.startsWith('http://chores.apps.localhost'));
    assert.equal(after.draft.waiting_for_publication, false);
    // The published app starts with its own, empty data.
    assert.deepEqual(ctx.deps.apps.files('chores', 'live'), ctx.deps.apps.files('chores', 'draft'));
  });

  it('stops answering a member who left the allowlist', async () => {
    const allowed = ctx.deps.config.allowedEmails as Set<string>;
    allowed.delete(ALICE);
    try {
      await assert.rejects(client.listTools());
    } finally {
      allowed.add(ALICE);
    }
  });

  it('lets a member disconnect an application from the platform itself', async () => {
    const connected = await connect(aliceCookie);
    const page = await (await fetch(`${origin}/connections`, { headers: { cookie: aliceCookie } })).text();
    assert.match(page, /Test agent[\s\S]*the app builder/);
    const grant = /action="\/connections\/([^"]+)\/revoke"/.exec(page)![1]!;
    const revoke = (cookie: string, from = origin) =>
      fetch(`${origin}/connections/${grant}/revoke`, {
        method: 'POST',
        headers: { cookie, origin: from },
        redirect: 'manual',
      });
    // Not another member's to end, and not a page of an app's either.
    assert.equal((await revoke(browserOf(BOB))).status, 404);
    assert.equal((await revoke(aliceCookie, 'http://chores.apps.localhost')).status, 403);
    assert.equal((await tool('list_apps', {}, connected)).isError, false);
    assert.equal((await revoke(aliceCookie)).status, 303);
    await assert.rejects(connected.listTools());
    assert.match(
      await (await fetch(`${origin}/connections`, { headers: { cookie: aliceCookie } })).text(),
      /No application is connected\./,
    );
  });
});
