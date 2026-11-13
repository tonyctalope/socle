import { functionCaller } from '../apphost/calls.ts';
import type { Config } from '../config.ts';
import { get, run } from '../db/database.ts';
import type { Schedule, Weekday } from '../runner/sandbox/call.ts';
import type { Deps } from '../types.ts';
import { listApps } from './registry.ts';
import { siteOf } from './slug.ts';

// Scheduled functions: what an app asked the platform to run by itself ("every day at 08:00").
// Only the published version's are run, on the published data, as a mutation without a
// caller. Each occurrence (a "slot") runs at most once: it is written down before the
// function is called. An occurrence that passed while the platform was down runs once
// when it is back; older ones are not replayed.

/** In the order of `Date.getUTCDay()`. */
const WEEKDAYS: Weekday[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** The date and time it is for the members (APP_TIMEZONE). */
function localParts(timezone: string, at: Date): { date: string; hour: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    hour: part('hour'),
    time: `${part('hour')}:${part('minute')}`,
  };
}

/**
 * The latest occurrence of a schedule that is not in the future, named so that a later
 * occurrence always sorts after an earlier one.
 */
export function slotOf(schedule: Schedule, timezone: string, now: Date): string {
  const today = localParts(timezone, now);
  if (schedule.every === 'hour') return `${today.date}T${today.hour}`;
  // Going back one day of the calendar at a time until the day and the time fit: today if its
  // time has come. Dates are counted as dates, not as 24 hours: the day the clocks change is
  // 23 or 25 hours long.
  const [year, month, dayOfMonth] = today.date.split('-').map(Number) as [number, number, number];
  for (let back = today.time >= schedule.at ? 0 : 1; back <= 7; back++) {
    const day = new Date(Date.UTC(year, month - 1, dayOfMonth - back));
    if (schedule.every === 'day' || WEEKDAYS[day.getUTCDay()] === schedule.on) return day.toISOString().slice(0, 10);
  }
  return today.date; // not reachable: a week always holds the day asked for
}

interface ScheduleRow {
  slot: string;
}

/** Runs what is due now. Called every minute; one round at a time. */
export async function runSchedules(deps: Deps): Promise<number> {
  const { db } = deps;
  const config: Config = deps.config;
  const callFunction = functionCaller(deps);
  let ran = 0;
  for (const app of listApps(db)) {
    const version = deps.apps.live(app.slug);
    if (!version) continue;
    for (const info of version.functions.values()) {
      if (!info.schedule) continue;
      const slot = slotOf(info.schedule, config.timezone, deps.now());
      const key = { app: app.slug, fn: info.name };
      const known = get<ScheduleRow>(db, 'SELECT slot FROM app_schedules WHERE app = :app AND fn = :fn', key);
      const remember = (value: string) =>
        run(
          db,
          `INSERT INTO app_schedules (app, fn, slot, ran_at) VALUES (:app, :fn, :slot, :now)
           ON CONFLICT(app, fn) DO UPDATE SET slot = excluded.slot, ran_at = excluded.ran_at`,
          { ...key, slot: value, now: deps.now().toISOString() },
        );
      if (!known) {
        // A schedule seen for the first time starts with its next occurrence, not with one that passed.
        remember(slot);
        continue;
      }
      if (known.slot >= slot) continue;
      // Written down first: whatever happens to the call, this occurrence is not run twice.
      remember(slot);
      const result = await callFunction({
        app,
        site: siteOf(app.slug, false),
        version,
        info,
        inputJson: 'null',
        caller: null,
      });
      if (typeof result === 'string' || (!result.ok && result.error.code === 'busy')) {
        // The platform could not make the call at all (no place, no runner, every worker of the
        // runner taken): the function did not start, so try again next minute.
        remember(known.slot);
        continue;
      }
      ran += 1;
      console.info(
        `[${app.slug}] scheduled ${info.name} (${slot}): ${result.ok ? 'done' : `failed (${result.error.code})`}`,
      );
    }
  }
  return ran;
}
