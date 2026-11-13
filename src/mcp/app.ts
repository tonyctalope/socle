import { fromJsonSchema, McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { functionCaller, type FunctionCaller } from '../apphost/calls.ts';
import { canAccess, type AppRow } from '../apps/registry.ts';
import { siteOf } from '../apps/slug.ts';
import type { AppVersion } from '../apps/store.ts';
import { displayName, type UserRow } from '../auth/users.ts';
import { appOrigin, localDate, type Config } from '../config.ts';
import type { FunctionInfo } from '../runner/sandbox/call.ts';
import type { Deps } from '../types.ts';

// An app's own MCP server: the functions its author marked `tool`, offered to the agent of a
// member who can open the app. It is what members connect for everyday use ("add bread to the
// list"); it runs the published version, on the published data, exactly as a screen would.

/** The canonical URI (RFC 8707 resource) of an app's MCP endpoint. Only the published address has one. */
export const appResource = (config: Config, slug: string): string => `${appOrigin(config, slug)}${APP_MCP_PATH}`;
export const APP_MCP_PATH = '/_socle/mcp';

/** The functions of a version an agent may call. */
export function toolsOf(version: AppVersion | null): FunctionInfo[] {
  return [...(version?.functions.values() ?? [])].filter((info) => info.tool !== null);
}

/** The app a resource URI names, when it is exactly the MCP endpoint of an app this member may use. */
export function appOfResource(deps: Deps, resource: string, user: UserRow, find: (slug: string) => AppRow | undefined) {
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return null;
  }
  const suffix = `.${deps.config.appsDomain}${deps.config.portSuffix}`;
  if (!url.host.endsWith(suffix)) return null;
  const app = find(url.host.slice(0, -suffix.length));
  if (!app || resource !== appResource(deps.config, app.slug) || !canAccess(user, app)) return null;
  return toolsOf(deps.apps.live(app.slug)).length > 0 ? app : null;
}

const text = (value: string, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: value }],
  ...(isError ? { isError: true } : {}),
});

export function buildAppServer(
  deps: Deps,
  app: AppRow,
  version: AppVersion | null,
  caller: UserRow,
  callFunction: FunctionCaller = functionCaller(deps),
): McpServer {
  const { config } = deps;
  const today = localDate(config, deps.now());
  const server = new McpServer(
    { name: `socle-${app.slug}`, title: app.name, version: String(version?.id ?? 0) },
    {
      instructions: [
        `${app.name}: ${app.description || 'an app of this Socle instance'}. It is used by a few people who know each other, on their phones, at ${appOrigin(config, app.slug)}/.`,
        `You act as ${displayName(caller)}: what you change is theirs, and the others see it at once. Today is ${today} (${config.timezone}).`,
        `The people who use it read ${config.locale === 'fr' ? 'French' : 'English'} (instance language: ${config.locale}): write what you add in that language.`,
      ].join('\n'),
    },
  );
  if (!version) return server;
  const site = siteOf(app.slug, false);
  for (const info of toolsOf(version)) {
    server.registerTool(
      info.name,
      {
        description: info.tool!,
        // The same description of the input the function checks its callers against.
        inputSchema: fromJsonSchema<Record<string, unknown>>(
          (info.input ?? { type: 'object', properties: {}, required: [], additionalProperties: false }) as never,
        ),
        annotations: { readOnlyHint: info.kind === 'query' },
      },
      async (input) => {
        let inputJson: string;
        try {
          inputJson = JSON.stringify(info.input ? input : null);
        } catch {
          return text('The input cannot be written as JSON.', true);
        }
        const result = await callFunction({
          app,
          site,
          version,
          info,
          inputJson,
          caller: { id: caller.id, name: displayName(caller) },
        });
        if (result === 'busy' || result === 'gone') return text('The app is busy; try again in a moment.', true);
        if (result === 'unavailable') return text('The app cannot answer right now; try again later.', true);
        if (!result.ok) {
          const { code, message } = result.error;
          // What the app says on purpose, and what it refuses as input, is for the agent to act on.
          if (code === 'invalid_input' || code.startsWith('user:')) return text(message, true);
          return text(code === 'timeout' ? 'The app took too long to answer.' : 'The app ran into an error.', true);
        }
        return text(result.json);
      },
    );
  }
  return server;
}
