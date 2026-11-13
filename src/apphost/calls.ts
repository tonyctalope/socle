import { appMembers, type AppRow } from '../apps/registry.ts';
import type { Site } from '../apps/slug.ts';
import { draftDatabase, liveDatabase, type AppVersion } from '../apps/store.ts';
import { localDate } from '../config.ts';
import { RateLimiter } from '../lib/http.ts';
import { RunnerUnavailable } from '../runner/client.ts';
import type { CallResult, FunctionInfo, NotifyEffect } from '../runner/sandbox/call.ts';
import { allowlist, type Deps } from '../types.ts';
import { CallGate } from './gate.ts';

// One call of an app's server function, whoever asks for it: a screen of the app (HTTP),
// or an agent (MCP). Everything that must hold for every call is here: the share of the
// runner an app may use, which database the call runs on, what is logged, and what a
// successful change sets off (open pages refresh, notifications leave).

export interface FunctionCall {
  app: AppRow;
  /** Which of the app's two addresses the call belongs to: it runs that version, on that database. */
  site: Site;
  version: AppVersion;
  info: FunctionInfo;
  /** The input as JSON text: it is checked inside the sandbox, against what the function declared. */
  inputJson: string;
  caller: { id: number; name: string };
  /** Names the page that made the change, so that it does not refresh itself. */
  client?: string;
  /** Aborted when the caller left: a call still waiting for its turn is dropped. */
  signal?: AbortSignal;
}

/** `gone`: the caller left before its turn. `busy`: the app already uses its share. `unavailable`: no runner. */
export type FunctionOutcome = CallResult | 'busy' | 'gone' | 'unavailable';

export type FunctionCaller = (call: FunctionCall) => Promise<FunctionOutcome>;

const callers = new WeakMap<Deps, FunctionCaller>();

/**
 * The one caller of a platform: screens, the builder and the apps' own MCP endpoints share
 * its limits (how many notifications a member gets, how many calls an app runs at once).
 */
export function functionCaller(deps: Deps): FunctionCaller {
  let caller = callers.get(deps);
  if (!caller) {
    caller = createCaller(deps);
    callers.set(deps, caller);
  }
  return caller;
}

function createCaller(deps: Deps): FunctionCaller {
  const { config, db } = deps;
  const isAllowed = allowlist(config);
  deps.gate ??= new CallGate();
  const gate = deps.gate;
  const notifyLimiter = new RateLimiter(30, 60_000);

  /** Sends what a mutation asked for, to members of this app only. */
  const notify = (app: AppRow, site: Site, callerId: number, effects: NotifyEffect[]) => {
    if (effects.length === 0) return;
    const members = appMembers(db, app, isAllowed).map((member) => member.id);
    for (const [index, effect] of effects.entries()) {
      const wanted =
        effect.to === 'all' ? members : effect.to === 'others' ? members.filter((id) => id !== callerId) : effect.to;
      for (const userId of new Set(wanted)) {
        if (!members.includes(userId)) continue;
        if (!notifyLimiter.take(`${site.label}:${userId}`)) {
          console.warn(`[${site.label}] too many notifications for member ${userId}, dropped`);
          continue;
        }
        // A draft notifies the browsers that enabled notifications on the draft address, no one else.
        deps.push
          .sendToUser(userId, site.label, {
            title: effect.title,
            body: effect.body,
            url: effect.url,
            tag: `${site.label}-${deps.now().getTime()}-${index}`,
          })
          .catch((error: unknown) => console.warn(`[${site.label}] notification failed:`, (error as Error).message));
      }
    }
  };

  return async ({ app, site, version, info, inputJson, caller, client, signal }) => {
    const { bundleHash } = version;
    if (!bundleHash) {
      return { ok: false, error: { code: 'unknown_function', message: 'this app has no server functions' }, logs: [] };
    }
    const target = site.draft ? 'draft' : 'live';
    const send = () =>
      deps.runner.call({
        database: site.draft ? draftDatabase(app.slug) : liveDatabase(app.slug),
        bundleHash,
        fn: info.name,
        kind: info.kind,
        inputJson,
        user: caller,
        members: appMembers(db, app, isAllowed),
        now: deps.now().getTime(),
        today: localDate(config, deps.now()),
        locale: config.locale,
      });
    let result: CallResult | 'busy' | 'gone';
    try {
      // One budget for the app's two addresses; the draft may hold a single place of it.
      const turn = async () => {
        const first = await send();
        if (first.ok || first.error.code !== 'bundle_missing') return first;
        // The runner lost this app's code (a fresh volume, for instance): give it again, once.
        const bundle = deps.apps.bundleOf(version.id);
        if (bundle === null) return first;
        await deps.runner.install(app.slug, bundle);
        return send();
      };
      result = await gate.run(app.slug, signal, turn, site.draft ? 1 : undefined);
    } catch (error) {
      if (!(error instanceof RunnerUnavailable)) throw error;
      console.error(`runner unavailable (${error.code}): ${error.message}`);
      return 'unavailable';
    }
    if (result === 'gone' || result === 'busy') return result;
    for (const line of result.logs) {
      console.info(`[${site.label}] ${info.name}: ${line}`);
      // The sandbox hands each line over as "<level>: <text>".
      const printed = /^(log|info|warn|error|debug): ([\s\S]*)$/.exec(line);
      deps.apps.log(app.slug, target, printed?.[1] ?? 'log', info.name, printed?.[2] ?? line);
    }
    if (!result.ok) {
      const { code, message } = result.error;
      // What the app refused on purpose (its own `fail()`, an input it does not accept) is not a fault.
      if (code !== 'invalid_input' && !code.startsWith('user:')) {
        console.warn(`[${site.label}] ${info.name} failed (${code}): ${message}`);
        deps.apps.log(app.slug, target, 'error', info.name, `${code}: ${message}`);
      }
      return result;
    }
    if (result.kind === 'mutation') {
      deps.live.publish(site.label, 'change', { client: client && /^[a-z0-9]{1,40}$/.test(client) ? client : '' });
      notify(app, site, caller.id, result.effects);
    }
    return result;
  };
}
