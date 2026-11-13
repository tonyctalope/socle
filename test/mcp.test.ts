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
  async function approve(authorizationUrl: URL, cookie: string, shows: RegExp): Promise<URLSearchParams> {
    // In process: Node's fetch always says it is not a navigation, and the server checks.
    const start = await ctx.app.request(authorizationUrl, { headers: { cookie, ...NAVIGATION } });
    assert.equal(start.status, 302, await start.text());
    const consentUrl = new URL(start.headers.get('location')!, origin);
    const page = await (await ctx.app.request(consentUrl, { headers: { cookie, ...NAVIGATION } })).text();
    assert.match(page, shows);
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

  /** The access token each connected client holds. */
  const providers = new WeakMap<Client, TestProvider>();

  /**
   * Every request of the client goes straight to the platform, whatever host its URL names:
   * an app's endpoint is on the app's own host, which no DNS knows here.
   */
  const inProcess: typeof fetch = async (input, init) => ctx.app.fetch(new Request(input, init));

  async function connect(
    cookie: string,
    mcpUrl = new URL('/mcp', origin),
    shows = /Test agent[\s\S]*wants to use the app builder/,
  ): Promise<Client> {
    const provider = new TestProvider();
    const transport = () => new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider, fetch: inProcess });
    const first = transport();
    await assert.rejects(new Client({ name: 'test', version: '1.0.0' }).connect(first), UnauthorizedError);
    assert.equal(provider.authorizationUrl?.origin, origin); // one authorization server for every endpoint
    assert.equal(provider.authorizationUrl?.pathname, '/oauth/authorize');
    assert.equal(provider.authorizationUrl?.searchParams.get('resource'), mcpUrl.href);
    const params = await approve(provider.authorizationUrl!, cookie, shows);
    assert.equal(params.get('state'), provider.lastState);
    assert.equal(params.get('iss'), origin);
    await first.finishAuth(params);
    const connected = new Client({ name: 'test', version: '1.0.0' });
    await connected.connect(transport());
    providers.set(connected, provider);
    return connected;
  }

  /** An administrator's click on "Publish the draft": the form carries the draft version its page showed. */
  const publishChores = (cookie: string) =>
    fetch(`${origin}/admin/apps/chores/publish`, {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: `version=${ctx.deps.apps.status('chores')!.draft.versionId}`,
      redirect: 'manual',
    });

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

    // Files of the wrong shape are refused before anything is kept: the draft is what it was.
    const before = ctx.deps.apps.files('chores', 'draft');
    const outside = await tool('write_files', {
      app: 'chores',
      files: [{ path: '../../outside.txt', content: 'x' }],
    });
    assert.equal(outside.isError, true);
    assert.equal(outside.json().saved, false);
    assert.deepEqual(ctx.deps.apps.files('chores', 'draft'), before);
    const longPath = await tool('write_files', { app: 'chores', files: [{ path: 'p'.repeat(500), content: 'x' }] });
    assert.equal(longPath.isError, true);
    const huge = await tool('write_files', {
      app: 'chores',
      files: [{ path: 'shared/big.ts', content: 'x'.repeat(600 * 1024) }],
    });
    assert.equal(huge.isError, true);
    assert.deepEqual(ctx.deps.apps.files('chores', 'draft'), before);

    // Two edits at once both land: each is applied to the draft as it is when its turn comes.
    const [one, two] = await Promise.all([
      tool('write_files', { app: 'chores', files: [{ path: 'shared/a.ts', content: 'export const a = 1;' }] }),
      tool('write_files', { app: 'chores', files: [{ path: 'shared/b.ts', content: 'export const b = 2;' }] }),
    ]);
    assert.equal(one.json().built, true, one.text);
    assert.equal(two.json().built, true, two.text);
    const both = ctx.deps.apps.files('chores', 'draft')!;
    assert.equal(both['shared/a.ts'], 'export const a = 1;');
    assert.equal(both['shared/b.ts'], 'export const b = 2;');
    // A third one while one runs and one waits is told to come back, and changes nothing.
    const burst = await Promise.all(
      ['c', 'd', 'e'].map((name) =>
        tool('write_files', { app: 'chores', files: [{ path: `shared/${name}.ts`, content: 'export {};' }] }),
      ),
    );
    assert.deepEqual(
      burst.map((answer) => answer.json().saved),
      [true, true, false],
    );
    assert.match(burst[2]!.text, /already waiting for its turn/);
    assert.equal(Object.hasOwn(ctx.deps.apps.files('chores', 'draft')!, 'shared/e.ts'), false);

    // The demo app is the platform's: no agent creates or edits an app of that name.
    assert.equal((await tool('create_app', { app: 'demo', name: 'Mine' })).isError, true);
    assert.equal(
      (await tool('write_files', { app: 'demo', files: [{ path: 'app.json', content: '{}' }] })).isError,
      true,
    );
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
    assert.equal((await publishChores(aliceCookie)).status, 403);
    assert.equal((await publishChores(browserOf(BOB))).status, 303);
    const after = (await tool('list_apps')).json().apps.find((app: { app: string }) => app.app === 'chores');
    assert.ok(after.published.url.startsWith('http://chores.apps.localhost'));
    assert.equal(after.draft.waiting_for_publication, false);
    // The published app starts with its own, empty data.
    assert.deepEqual(ctx.deps.apps.files('chores', 'live'), ctx.deps.apps.files('chores', 'draft'));
  });

  it('keeps an app limited to other members out of reach of a member’s agent', async () => {
    const names = async (from: Client) =>
      ((await tool('list_apps', {}, from)).json().apps as { app: string }[]).map((app) => app.app);
    const listed = await connect(browserOf(BOB));
    ctx.deps.apps.log('chores', 'live', 'log', 'list', 'what a listed member did');
    ctx.deps.apps.setAccess('chores', [BOB]);
    try {
      assert.ok(!(await names(client)).includes('chores'));
      const before = ctx.deps.apps.files('chores', 'draft');
      // Its code, its log, its draft's data and its draft: as if the app were not there.
      for (const [name, args] of [
        ['read_files', { app: 'chores' }],
        ['read_files', { app: 'chores', source: 'published' }],
        ['read_logs', { app: 'chores', source: 'published' }],
        ['read_logs', { app: 'chores' }],
        ['call_function', { app: 'chores', function: 'list' }],
        ['write_files', { app: 'chores', files: [{ path: 'web/main.tsx', content: 'export default () => null;' }] }],
        ['write_files', { app: 'chores', reset_draft_data: true }],
      ] as const) {
        const refused = await tool(name, args);
        assert.equal(refused.isError, true, name);
        assert.match(refused.text, /There is no app named "chores"/, name);
        assert.doesNotMatch(refused.text, /listed member/);
      }
      assert.deepEqual(ctx.deps.apps.files('chores', 'draft'), before);
      // The name stays taken, without saying more.
      const taken = await tool('create_app', { app: 'chores', name: 'Mine' });
      assert.equal(taken.isError, true);
      assert.doesNotMatch(taken.text, /read_files/);

      // The member who is on the list works on it as before.
      assert.ok((await names(listed)).includes('chores'));
      assert.match((await tool('read_logs', { app: 'chores', source: 'published' }, listed)).text, /listed member/);
      assert.equal((await tool('read_files', { app: 'chores' }, listed)).isError, false);
    } finally {
      ctx.deps.apps.setAccess('chores', null);
      await listed.close();
    }
    assert.ok((await names(client)).includes('chores'));
    assert.equal((await tool('read_files', { app: 'chores' })).isError, false);
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

  it('offers an app’s own tools at the app’s address, to the agent of a member who can open it', async () => {
    const port = origin.slice(origin.lastIndexOf(':'));
    const appMcp = new URL(`http://chores.apps.localhost${port}/_socle/mcp`);
    const rpc = (url: URL | string, headers: Record<string, string> = {}) =>
      inProcess(String(url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    // The published app offers no tool yet: it has no endpoint, and no token can be asked for it.
    assert.equal((await rpc(appMcp)).status, 404);
    const builder = await connect(aliceCookie);

    // A tool takes named arguments: the build says so.
    const server = (addInput: string) => `import { mutation, query, v } from '@socle/server';
      export const list = query({
        tool: 'Lists the chores of the household, oldest first.',
        handler: ({ db }) => db.all('SELECT id, label FROM chores ORDER BY id'),
      });
      export const add = mutation({
        tool: 'Adds a chore to the shared list.',
        input: ${addInput},
        handler: ({ db, user }, input) => {
          const label = typeof input === 'string' ? input : input.label;
          if (label === 'nothing') throw new Error('secret detail');
          return { id: db.run('INSERT INTO chores (label) VALUES (?)', label).lastInsertRowid, by: user.name };
        },
      });
      export const purge = mutation(({ db }) => db.run('DELETE FROM chores').changes);`;
    const write = (addInput: string) =>
      tool('write_files', { app: 'chores', files: [{ path: 'server/index.ts', content: server(addInput) }] }, builder);
    const refused = (await write('v.string()')).json();
    assert.equal(refused.built, false);
    assert.match(JSON.stringify(refused.problems), /offered as a tool takes v\.object/);
    const built = (await write("v.object({ label: v.string().min(1).describe('What has to be done') })")).json();
    assert.equal(built.built, true, JSON.stringify(built));
    assert.deepEqual(
      built.functions.map((info: { name: string; offered_as_tool: boolean }) => [info.name, info.offered_as_tool]),
      [
        ['add', true],
        ['list', true],
        ['purge', false],
      ],
    );
    // Still a draft: nothing is offered until an administrator publishes.
    assert.equal((await rpc(appMcp)).status, 404);
    assert.equal((await publishChores(browserOf(BOB))).status, 303);
    const listed = (await tool('list_apps', {}, builder)).json();
    assert.equal(listed.apps.find((app: { app: string }) => app.app === 'chores').published.mcp_url, appMcp.href);

    // The endpoint says where to sign in: the control plane, for this app and no other.
    const challenge = await rpc(appMcp);
    assert.equal(challenge.status, 401);
    assert.match(
      challenge.headers.get('www-authenticate') ?? '',
      /chores\.apps\.localhost[^"]*\/\.well-known\/oauth-protected-resource\/_socle\/mcp"/,
    );
    const metadata = (await (
      await inProcess(`http://chores.apps.localhost${port}/.well-known/oauth-protected-resource/_socle/mcp`)
    ).json()) as { resource: string; authorization_servers: string[] };
    assert.deepEqual(metadata, { ...metadata, resource: appMcp.href, authorization_servers: [origin] });
    // The draft's address has no endpoint, and an app without tools none either.
    assert.equal((await rpc(`http://chores--draft.apps.localhost${port}/_socle/mcp`)).status, 404);
    assert.equal((await rpc(`http://demo.apps.localhost${port}/_socle/mcp`)).status, 404);

    const agent = await connect(aliceCookie, appMcp, /Test agent[\s\S]*wants to use Chores/);
    const { tools } = await agent.listTools();
    assert.deepEqual(
      tools.map((entry) => [entry.name, entry.description, entry.annotations?.readOnlyHint]),
      [
        ['add', 'Adds a chore to the shared list.', false],
        ['list', 'Lists the chores of the household, oldest first.', true],
      ],
    );
    assert.match(JSON.stringify(tools[0]!.inputSchema), /What has to be done/);
    assert.match(agent.getInstructions() ?? '', /Chores[\s\S]*You act as alice/);

    // It runs the published version on the published data, as the member.
    const added = await tool('add', { label: 'Water the plants' }, agent);
    assert.deepEqual(added.json(), { id: 1, by: 'alice' });
    assert.deepEqual((await tool('list', {}, agent)).json(), [{ id: 1, label: 'Water the plants' }]);
    assert.equal((await tool('add', { label: '' }, agent)).isError, true);
    const failed = await tool('add', { label: 'nothing' }, agent);
    assert.equal(failed.isError, true);
    assert.equal(failed.text, 'The app ran into an error.'); // what went wrong stays in the app's log
    await assert.rejects(agent.callTool({ name: 'purge', arguments: {} })); // not offered, so not callable

    // A token is good at one endpoint only, each way; a session cookie at none.
    const tokenOf = (connected: Client) => providers.get(connected)!.tokens()!.access_token;
    const builderToken = tokenOf(builder);
    const appToken = tokenOf(agent);
    assert.equal((await rpc(appMcp, { authorization: `Bearer ${appToken}` })).status, 200);
    assert.equal((await rpc(appMcp, { authorization: `Bearer ${builderToken}` })).status, 401);
    assert.equal((await rpc(`${origin}/mcp`, { authorization: `Bearer ${appToken}` })).status, 401);
    assert.equal((await rpc(appMcp, { cookie: aliceCookie })).status, 401);

    // Both connections are the member's to end, by name.
    const page = await (await fetch(`${origin}/connections`, { headers: { cookie: aliceCookie } })).text();
    assert.match(page, /Chores/);
    assert.match(page, /the app builder/);

    // Removing the app ends the connections to it: an app of the same name later is another app.
    const removed = await fetch(`${origin}/admin/apps/chores/remove`, {
      method: 'POST',
      headers: { cookie: browserOf(BOB), origin },
      redirect: 'manual',
    });
    assert.equal(removed.status, 303);
    assert.equal((await rpc(appMcp, { authorization: `Bearer ${appToken}` })).status, 404);
    const grants = ctx.deps.db
      .prepare('SELECT COUNT(*) AS n FROM oauth_grants WHERE resource = ? AND revoked_at IS NULL')
      .get(appMcp.href) as { n: number };
    assert.equal(grants.n, 0);
    await builder.close();
  });
});
