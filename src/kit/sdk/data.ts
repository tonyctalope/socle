import { useSyncExternalStore } from 'react';
import { ApiError, request } from './http.ts';

// The app's server functions, from the browser. `api.addExpense(input)` calls one;
// `useQuery('listExpenses')` keeps a screen in sync with one: every query on screen
// is fetched again after a change, whoever made it (this phone or another one).

/** Names this page in the live-update stream, so it can skip the echo of its own changes. */
const CLIENT = Math.random().toString(36).slice(2) + Date.now().toString(36);

interface FunctionResult {
  kind: 'query' | 'mutation';
  value: unknown;
}

async function callFunction(name: string, input: unknown, queryOnly: boolean): Promise<unknown> {
  const result = await request<FunctionResult>(
    'POST',
    `/fn/${encodeURIComponent(name)}`,
    { input: input ?? null, ...(queryOnly ? { query: true } : {}) },
    { 'X-Socle-Client': CLIENT },
  );
  if (result.kind === 'mutation') refreshAll();
  return result.value;
}

/** Every server function of the app: `await api.addExpense({ label, cents })`. Throws an ApiError. */
export const api: Record<string, (input?: unknown) => Promise<any>> = new Proxy(
  {},
  { get: (_target, name) => (input?: unknown) => callFunction(String(name), input, false) },
);

export interface QueryState<T> {
  /** The last result; kept while a newer one loads. Undefined until the first answer. */
  data: T | undefined;
  error: ApiError | null;
  /** True until the first answer (or error) arrives. */
  loading: boolean;
  /** Fetches again now. */
  reload: () => void;
}

interface Entry {
  name: string;
  input: unknown;
  state: QueryState<unknown>;
  listeners: Set<() => void>;
  /** Stable functions for useSyncExternalStore (a new one at each render would resubscribe, and refetch). */
  subscribe: (listener: () => void) => () => void;
  snapshot: () => QueryState<unknown>;
  /** Bumped at each fetch, so a slow answer never overwrites a newer one. */
  generation: number;
  evict: ReturnType<typeof setTimeout> | undefined;
}

const entries = new Map<string, Entry>();

/** JSON with sorted keys: the same input always gives the same cache key. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : item,
  );
}

function publish(entry: Entry, patch: Partial<QueryState<unknown>>): void {
  entry.state = { ...entry.state, ...patch };
  for (const listener of entry.listeners) listener();
}

function load(entry: Entry): void {
  const generation = ++entry.generation;
  callFunction(entry.name, entry.input, true).then(
    (data) => {
      if (generation !== entry.generation) return;
      publish(entry, { data, error: null, loading: false });
    },
    (error: unknown) => {
      if (generation !== entry.generation) return;
      const known =
        error instanceof ApiError ? error : new ApiError(String((error as Error)?.message ?? error), 0, 'error');
      publish(entry, { error: known, loading: false });
    },
  );
}

function entryFor(name: string, input: unknown): Entry {
  const key = `${name}\n${stable(input ?? null)}`;
  let entry = entries.get(key);
  if (!entry) {
    const created: Entry = {
      name,
      input: input ?? null,
      state: { data: undefined, error: null, loading: true, reload: () => load(created) },
      listeners: new Set(),
      subscribe: (listener) => {
        clearTimeout(created.evict);
        created.listeners.add(listener);
        if (created.listeners.size === 1) {
          entries.set(key, created);
          listen();
          load(created); // also refreshes what was kept from a previous screen
        }
        return () => {
          created.listeners.delete(listener);
          // Kept for a few minutes: coming back to a screen shows the last data at once.
          if (created.listeners.size === 0) created.evict = setTimeout(() => entries.delete(key), 5 * 60_000);
        };
      },
      snapshot: () => created.state,
      generation: 0,
      evict: undefined,
    };
    entry = created;
    entries.set(key, entry);
  }
  return entry;
}

/** Fetches again every query currently on screen. */
export function refreshAll(): void {
  for (const entry of entries.values()) {
    if (entry.listeners.size > 0) load(entry);
  }
}

const IDLE: QueryState<unknown> = { data: undefined, error: null, loading: false, reload: () => {} };
const never = () => () => {};
const idle = () => IDLE;

/**
 * Reads a query function of the app and keeps the result up to date:
 *   const { data, loading, error } = useQuery('listExpenses', { month });
 * Pass { enabled: false } to wait (for instance until an id is known).
 */
export function useQuery<T = unknown>(name: string, input?: unknown, options?: { enabled?: boolean }): QueryState<T> {
  const enabled = options?.enabled !== false;
  const entry = entryFor(name, input);
  return useSyncExternalStore(enabled ? entry.subscribe : never, enabled ? entry.snapshot : idle) as QueryState<T>;
}

// Live updates: the platform says "something changed" after each successful mutation.
let stream: EventSource | undefined;
let hiddenAt = 0;

function listen(): void {
  if (stream || typeof EventSource === 'undefined') return;
  let opened = false;
  stream = new EventSource('/_socle/api/events');
  stream.addEventListener('change', (event) => {
    let from = '';
    try {
      from = (JSON.parse((event as MessageEvent<string>).data) as { client?: string }).client ?? '';
    } catch {
      // an event without details still means "refresh"
    }
    if (from !== CLIENT) refreshAll();
  });
  stream.addEventListener('open', () => {
    // After a reconnection, changes may have been missed.
    if (opened) refreshAll();
    opened = true;
  });
  // A phone suspends pages in the background: catch up when the app comes back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 5_000) refreshAll();
  });
}
