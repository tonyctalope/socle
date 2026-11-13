import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { functionCaller } from '../apphost/calls.ts';
import { DEMO_SLUG, getApp, listApps } from '../apps/registry.ts';
import { isValidSlug, siteOf } from '../apps/slug.ts';
import type { AppStatus, DeployOutcome } from '../apps/store.ts';
import { starterFiles } from '../apps/template.ts';
import { displayName, type UserRow } from '../auth/users.ts';
import { appOrigin } from '../config.ts';
import { SOURCE_LIMITS } from '../runner/limits.ts';
import type { Deps } from '../types.ts';
import { appResource, toolsOf } from './app.ts';
import { GUIDE } from './guide.ts';

// The builder: the tools an agent uses to create and change apps. Everything it does lands
// in an app's draft (its own address, its own database). It has no tool that publishes, and
// none that deletes: what members use only changes when an administrator decides so, on the
// administration page.

const VERSION = '1.0.0';
/** What `read_files` returns in one answer; beyond it, the agent asks for the paths it needs. */
const MAX_READ_BYTES = 200 * 1024;

const slugShape = z.string().max(32).describe('The app, by its short name (as in list_apps), e.g. "groceries".');
/** The same bounds the build applies to an app's files, so that nothing larger even reaches the store. */
const pathShape = z.string().min(1).max(SOURCE_LIMITS.maxPathLength);
const contentShape = z.string().max(SOURCE_LIMITS.maxFileBytes);

const text = (value: string, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: value }],
  ...(isError ? { isError: true } : {}),
});
const json = (value: unknown): CallToolResult => text(JSON.stringify(value, null, 2));

export function buildBuilderServer(deps: Deps, caller: UserRow): McpServer {
  const { config, db } = deps;
  const callFunction = functionCaller(deps);
  const liveUrl = (slug: string) => `${appOrigin(config, slug)}/`;
  const draftUrl = (slug: string) => `${appOrigin(config, siteOf(slug, true).label)}/`;
  const adminUrl = `${config.controlOrigin}/admin/`;

  const describe = (status: AppStatus) => ({
    app: status.slug,
    name: status.name,
    description: status.description,
    published: status.live
      ? {
          url: liveUrl(status.slug),
          since: status.live.publishedAt,
          // Where the app's own tools (its functions marked `tool`) are offered, if it has any.
          mcp_url: toolsOf(deps.apps.live(status.slug)).length > 0 ? appResource(config, status.slug) : null,
        }
      : null,
    draft: {
      url: status.draft.versionId ? draftUrl(status.slug) : null,
      builds: status.draft.problems === null,
      problems: status.draft.problems ?? [],
      waiting_for_publication: status.draft.differs && status.draft.problems === null,
    },
  });
  const unknown = (slug: string) => text(`There is no app named "${slug}". Call list_apps, or create_app.`, true);
  const shipped = () =>
    text(
      'The demo app ships with the platform and is rewritten at every start: it cannot be edited. Create another app.',
      true,
    );
  /** A tool never answers with what an unexpected failure says (SQL, paths): that goes to the log. */
  const guarded =
    <A>(name: string, handler: (args: A) => Promise<CallToolResult>) =>
    async (args: A): Promise<CallToolResult> => {
      try {
        return await handler(args);
      } catch (error) {
        console.error(`builder tool ${name} failed:`, (error as Error).message);
        return text('The platform could not do this right now. Try again in a moment.', true);
      }
    };

  /** What the agent is told after its files were saved: whether they build, and what happens next. */
  const afterSave = (slug: string, outcome: DeployOutcome): CallToolResult => {
    const status = deps.apps.status(slug)!;
    if (!outcome.ok && outcome.stage === 'refused') {
      return text(
        JSON.stringify(
          {
            saved: false,
            built: false,
            problems: outcome.problems,
            next: 'Nothing was saved. Fix what is listed and call write_files again.',
          },
          null,
          2,
        ),
        true,
      );
    }
    if (!outcome.ok) {
      return json({
        saved: true,
        built: false,
        stage: outcome.stage,
        problems: outcome.problems,
        next:
          outcome.stage === 'migrate'
            ? 'The files are saved but the draft database refused a migration. If you rewrote a migration that had already run in the draft, call write_files again with reset_draft_data: true; otherwise fix the SQL.'
            : 'The files are saved but do not build. Fix the problems and call write_files again; the draft address still shows the last version that built.',
      });
    }
    const version = deps.apps.draft(slug);
    return json({
      saved: true,
      built: true,
      migrations_applied_to_draft: outcome.applied,
      draft_url: draftUrl(slug),
      functions: [...(version?.functions.values() ?? [])].map((info) => ({
        name: info.name,
        kind: info.kind,
        offered_as_tool: info.tool !== null,
        ...(info.schedule ? { runs: info.schedule } : {}),
      })),
      would_change_on_publication: deps.apps.changes(slug),
      next: status.draft.differs
        ? `The draft is ready to try at draft_url (people sign in as usual; it has its own data). You cannot publish: an administrator publishes it at ${adminUrl}.`
        : 'The draft is identical to the published version: there is nothing to publish.',
    });
  };

  const server = new McpServer(
    { name: 'socle-builder', title: 'Socle — app builder', version: VERSION },
    {
      instructions: [
        `This server creates and changes the apps of a Socle instance (${config.controlOrigin}). You are connected as ${displayName(caller)}.`,
        'Call read_guide before writing any app code: an app is a set of source files with its own rules (no packages, the platform provides sign-in, database, notifications).',
        "Everything you write goes to the app's draft, which has its own address and its own data. Nothing changes for the people who use an app until an administrator publishes the draft; you cannot publish and you cannot delete an app.",
        `The people who use these apps read ${config.locale === 'fr' ? 'French' : 'English'} (instance language: ${config.locale}): write the apps' texts in that language unless asked otherwise.`,
      ].join('\n'),
    },
  );

  server.registerTool(
    'read_guide',
    {
      title: 'How to write an app',
      description:
        'The rules for writing an app on this platform: files, imports, server functions, screens, UI components, limits. Read it once before writing or changing app code.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => text(GUIDE),
  );

  server.registerTool(
    'list_apps',
    {
      title: 'List the apps',
      description: 'Every app of the instance: its addresses, whether it is published, and where its draft stands.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      json({
        instance_language: config.locale,
        administration_url: adminUrl,
        apps: listApps(db).map((row) => describe(deps.apps.status(row.slug)!)),
      }),
  );

  server.registerTool(
    'create_app',
    {
      title: 'Create an app',
      description:
        'Creates a new app with a minimal draft that builds. Its address will be https://<app>.<apps domain>, so choose the short name with the person. Then write its files with write_files.',
      inputSchema: z.object({
        app: z
          .string()
          .describe(
            'Short name used in the address: 2 to 32 lowercase letters, digits or single hyphens, starting with a letter.',
          ),
        name: z.string().trim().min(1).max(40).describe('The name people see on their Home Screen.'),
        description: z.string().trim().max(200).optional().describe('One sentence saying what the app is for.'),
      }),
    },
    guarded('create_app', async ({ app, name, description }) => {
      if (!isValidSlug(app)) {
        return text(
          `"${app}" cannot be an app's short name: 2 to 32 lowercase letters, digits or single hyphens, starting with a letter and not a reserved word.`,
          true,
        );
      }
      if (app === DEMO_SLUG)
        return text('"demo" is the name of the app that ships with the platform. Choose another.', true);
      const card = { name, description: description ?? '' };
      const created = deps.apps.create(app, card, caller);
      if (created === 'exists') return text(`An app named "${app}" already exists. Call read_files to see it.`, true);
      if (created !== 'created') return text('This instance already holds as many apps as it allows.', true);
      console.info(`[${app}] created by ${caller.email}`);
      return afterSave(app, await deps.apps.saveDraft(app, starterFiles(card), caller));
    }),
  );

  server.registerTool(
    'read_files',
    {
      title: 'Read an app’s files',
      description:
        'Without paths: the list of the app\'s files with their sizes. With paths: their contents. Reads the draft (what write_files changes) unless source is "published".',
      inputSchema: z.object({
        app: slugShape,
        paths: z.array(pathShape).max(100).optional().describe('Files to read, e.g. ["web/main.tsx"].'),
        source: z.enum(['draft', 'published']).optional().describe('Default: draft.'),
      }),
      annotations: { readOnlyHint: true },
    },
    guarded('read_files', async ({ app, paths, source }) => {
      const files = deps.apps.files(app, source === 'published' ? 'live' : 'draft');
      if (!getApp(db, app)) return unknown(app);
      if (!files) return text(`"${app}" has no published version yet. Read its draft instead.`, true);
      const status = describe(deps.apps.status(app)!);
      if (!paths?.length) {
        return json({
          ...status,
          files: Object.keys(files)
            .sort()
            .map((path) => ({ path, bytes: Buffer.byteLength(files[path]!) })),
        });
      }
      const missing = paths.filter((path) => !Object.hasOwn(files, path));
      if (missing.length) return text(`No such file: ${missing.join(', ')}. Call read_files without paths.`, true);
      let bytes = 0;
      const contents: Record<string, string> = {};
      for (const path of paths) {
        bytes += Buffer.byteLength(files[path]!);
        if (bytes > MAX_READ_BYTES) {
          return text(
            `These files are too large to return together (limit ${MAX_READ_BYTES / 1024} KiB). Ask for fewer paths at a time.`,
            true,
          );
        }
        contents[path] = files[path]!;
      }
      return json({ app, source: source ?? 'draft', files: contents });
    }),
  );

  server.registerTool(
    'write_files',
    {
      title: 'Write files to an app’s draft',
      description:
        "Saves files to the app's draft (each file whole, not a diff) and/or deletes some, then builds the draft. Returns the build problems, or the draft's address to try it. Nothing changes for the people using the app until an administrator publishes.",
      inputSchema: z.object({
        app: slugShape,
        files: z
          .array(z.object({ path: pathShape, content: contentShape }))
          .max(SOURCE_LIMITS.maxFiles)
          .optional()
          .describe('Files to create or replace, each with its full content.'),
        delete: z.array(pathShape).max(SOURCE_LIMITS.maxFiles).optional().describe('Paths to remove from the draft.'),
        reset_draft_data: z
          .boolean()
          .optional()
          .describe(
            "Empties the draft's database and runs every migration again. Needed after rewriting a migration that had already run in the draft. Never touches published data.",
          ),
      }),
    },
    guarded('write_files', async ({ app, files, delete: removed, reset_draft_data }) => {
      if (!getApp(db, app)) return unknown(app);
      if (app === DEMO_SLUG) return shipped();
      if (!files?.length && !removed?.length && !reset_draft_data) {
        return text('Nothing to do: give files to write, paths to delete, or reset_draft_data.', true);
      }
      // The draft is read and changed in the app's turn: two calls at once both land.
      const outcome = await deps.apps.editDraft(
        app,
        { set: Object.fromEntries((files ?? []).map((file) => [file.path, file.content])), remove: removed ?? [] },
        caller,
        { resetData: reset_draft_data === true },
      );
      console.info(`[${app}] draft edited by ${caller.email}: ${outcome.ok ? 'built' : `${outcome.stage}`}`);
      return afterSave(app, outcome);
    }),
  );

  server.registerTool(
    'call_function',
    {
      title: 'Call a function of the draft',
      description:
        "Runs one server function of the app's draft, as you (the connected person), on the draft's own data: to check your server code. Returns its result, or how it failed.",
      inputSchema: z.object({
        app: slugShape,
        function: z.string().max(64).describe('Its export name in server/index.ts.'),
        input: z.unknown().optional().describe("The function's input, as JSON."),
      }),
    },
    guarded('call_function', async (args) => {
      const row = getApp(db, args.app);
      if (!row) return unknown(args.app);
      const version = deps.apps.draft(args.app);
      if (!version) return text('This app has no draft that builds yet. Call write_files first.', true);
      const info = version.functions.get(args.function);
      if (!info) {
        const names = [...version.functions.keys()].join(', ') || 'none';
        return text(`The draft has no function named "${args.function}". Its functions: ${names}.`, true);
      }
      let inputJson: string;
      try {
        inputJson = JSON.stringify(args.input ?? null);
      } catch {
        return text('The input cannot be written as JSON.', true);
      }
      const result = await callFunction({
        app: row,
        site: siteOf(row.slug, true),
        version,
        info,
        inputJson,
        // A scheduled function runs as the platform will run it: without a caller.
        caller: info.schedule ? null : { id: caller.id, name: displayName(caller) },
      });
      if (result === 'busy' || result === 'gone') return text('The app is busy; try again in a moment.', true);
      if (result === 'unavailable') return text('The platform cannot run functions right now; try again later.', true);
      if (!result.ok) return json({ ok: false, error: result.error, logs: result.logs });
      return json({
        ok: true,
        kind: result.kind,
        result: JSON.parse(result.json) as unknown,
        notifications: result.effects.length,
        logs: result.logs,
      });
    }),
  );

  server.registerTool(
    'read_logs',
    {
      title: 'Read an app’s log',
      description:
        "What the app's functions printed (console.log) and how they failed, most recent first. The draft's log by default.",
      inputSchema: z.object({
        app: slugShape,
        source: z.enum(['draft', 'published']).optional().describe('Default: draft.'),
        limit: z.number().int().min(1).max(200).optional().describe('Default: 50 lines.'),
      }),
      annotations: { readOnlyHint: true },
    },
    guarded('read_logs', async ({ app, source, limit }) => {
      if (!getApp(db, app)) return unknown(app);
      return json({ app, lines: deps.apps.logs(app, source === 'published' ? 'live' : 'draft', limit ?? 50) });
    }),
  );

  return server;
}
