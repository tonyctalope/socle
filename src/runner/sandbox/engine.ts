import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import releaseSyncModule from '@jitl/quickjs-wasmfile-release-sync';
import { build } from 'esbuild';
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
} from 'quickjs-emscripten-core';
import type { Limits } from '../limits.ts';

// App code runs in QuickJS compiled to WebAssembly: an interpreter with no file,
// network or process API at all, inside a memory it cannot leave. Every call gets a
// brand-new WebAssembly instance (about a millisecond), so nothing survives from one
// call to the next, not even a corrupted interpreter heap.

const require = createRequire(import.meta.url);

type SyncVariant = Extract<Parameters<typeof newVariant>[0], { type: 'sync' }>;
// The package's types describe its CommonJS build; Node loads its ES module, whose default export is the variant.
const releaseSync = releaseSyncModule as unknown as SyncVariant;

interface Wasm {
  compile(bytes: Uint8Array): Promise<object>;
  Memory: new (limits: { initial: number; maximum: number }) => { readonly buffer: ArrayBuffer };
}
const wasm = (globalThis as unknown as { WebAssembly: Wasm }).WebAssembly;

const PAGE = 64 * 1024;
/** What the interpreter's module asks for at start (16 MiB); a smaller memory is refused. */
const INITIAL_PAGES = 256;

let compiled: Promise<object> | undefined;

/** The interpreter, compiled once per process; instances are then cheap. */
function compiledModule(): Promise<object> {
  compiled ??= wasm.compile(readFileSync(require.resolve('@jitl/quickjs-wasmfile-release-sync/wasm')));
  return compiled;
}

let prelude: Promise<string> | undefined;

/** The guest side of "@socle/server", bundled once per process into a script that defines __socle. */
export function guestPrelude(): Promise<string> {
  prelude ??= build({
    entryPoints: [fileURLToPath(new URL('./guest/std.ts', import.meta.url))],
    bundle: true,
    format: 'iife',
    globalName: '__std',
    target: 'es2023',
    write: false,
    logLevel: 'silent',
    footer: { js: 'globalThis.__socle = __std.socle; delete globalThis.__host;' },
  }).then(
    (result) => result.outputFiles[0]!.text,
    (error: unknown) => {
      prelude = undefined; // a failed attempt must not be remembered as the answer
      throw error;
    },
  );
  return prelude;
}

/** A failure of the app's code or of the sandbox around it, in words that can be shown to its author. */
export class GuestFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Answers one request from the guest; may throw a GuestFailure-free Error whose message the guest will see. */
export type HostBridge = (op: string, first: string, second: string) => string;

/** The platform's entry points inside the sandbox. */
type Entry = '__kind' | '__invoke' | '__describe';
const ENTRIES: readonly Entry[] = ['__kind', '__invoke', '__describe'];

export interface Sandbox {
  /** Runs the app's bundle for its side effects. */
  run(code: string, filename: string): void;
  /** Calls one of the platform's entry points with text arguments; returns its text, awaiting a promise if needed. */
  call(entry: Entry, args: string[], maxLength: number): string;
  dispose(): void;
}

interface GuestError {
  name: string;
  message: string;
  code?: string;
  stack: string;
}

/** What is kept of an error's text. An error is an answer too: it gets a size like any other. */
const MAX_ERROR_TEXT = 2_000;

/** `(text, max) => text.slice(0, max)`, made of references taken before any code of the app ran. */
const CUT = '((slice, apply) => (text, max) => apply(slice, text, [0, max]))(String.prototype.slice, Reflect.apply)';

/** A text property of a guest value, never longer than `max`: a long one is cut inside the sandbox, not copied out whole. */
function readText(vm: QuickJSContext, cut: QuickJSHandle, text: QuickJSHandle, max: number): string {
  const length = vm.getProp(text, 'length').consume((handle) => vm.getNumber(handle));
  if (length <= max) return vm.getString(text);
  const limit = vm.newNumber(max);
  const result = vm.callFunction(cut, vm.undefined, text, limit);
  limit.dispose();
  if (result.error) {
    result.error.dispose();
    return '';
  }
  return `${result.value.consume((handle) => vm.getString(handle))}…`;
}

/** Reads what the guest threw, one bounded property at a time (the value is the app's: anything can be in it). */
function readError(vm: QuickJSContext, cut: QuickJSHandle, thrown: QuickJSHandle): GuestError {
  const fallback = { name: 'Error', message: 'the function threw a value that cannot be read', stack: '' };
  try {
    const kind = vm.typeof(thrown);
    if (kind === 'string') return { name: 'Error', message: readText(vm, cut, thrown, MAX_ERROR_TEXT), stack: '' };
    if (kind !== 'object' && kind !== 'function') {
      return { name: 'Error', message: `thrown value: ${String(vm.dump(thrown)).slice(0, 100)}`, stack: '' };
    }
    const text = (property: string, max: number): string | undefined => {
      const value = vm.getProp(thrown, property);
      try {
        return vm.typeof(value) === 'string' ? readText(vm, cut, value, max) : undefined;
      } finally {
        value.dispose();
      }
    };
    return {
      name: text('name', 100) ?? 'Error',
      message: text('message', MAX_ERROR_TEXT) ?? 'the function threw something that is not an error',
      code: text('code', 100),
      stack: text('stack', MAX_ERROR_TEXT) ?? '',
    };
  } catch {
    return fallback;
  }
}

/** Where in the app's own code an error came from (the first frames, without the platform's). */
function origin(stack: string): string {
  const frames = stack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at ') && !line.includes('socle:std') && !line.includes('<anonymous>'))
    .slice(0, 3);
  return frames.length ? ` (${frames.join(' ← ')})` : '';
}

function failure(error: GuestError, deadline: number): GuestFailure {
  if (error.name === 'InternalError' && error.message === 'interrupted') {
    return new GuestFailure('timeout', 'the function ran for too long and was stopped');
  }
  if (error.message === 'out of memory') return new GuestFailure('memory', 'the function used too much memory');
  if (/stack overflow/.test(error.message)) {
    return new GuestFailure('stack_overflow', 'the function recursed too deeply');
  }
  if (Date.now() > deadline) return new GuestFailure('timeout', 'the function ran for too long and was stopped');
  if (error.name === 'UserError') {
    // The code is chosen by the app and ends up in HTTP answers: a short identifier, or the default.
    const code = error.code !== undefined && /^[A-Za-z0-9_.-]{1,40}$/.test(error.code) ? error.code : 'failed';
    return new GuestFailure(`user:${code}`, error.message);
  }
  if (error.name === 'InputError') return new GuestFailure('invalid_input', error.message);
  if (error.name === 'UnknownFunction') return new GuestFailure('unknown_function', error.message);
  return new GuestFailure('error', `${error.name}: ${error.message}${origin(error.stack)}`.slice(0, 2_000));
}

/**
 * A fresh interpreter with the platform's library loaded. `deadline` (epoch ms)
 * bounds everything run in it; `bridge` is the only thing the guest can reach.
 */
export async function createSandbox(limits: Limits, deadline: number, bridge: HostBridge): Promise<Sandbox> {
  // The memory of this call, and the real bound on what it can hold: WebAssembly refuses to
  // grow it past `maximum`, whatever the interpreter believes it has allocated.
  const pages = Math.max(INITIAL_PAGES + 16, Math.ceil(limits.guestMemory / PAGE));
  const memory = new wasm.Memory({ initial: INITIAL_PAGES, maximum: pages });
  const [quickjs, library] = await Promise.all([
    compiledModule().then((wasmModule) =>
      newQuickJSWASMModuleFromVariant(
        newVariant(releaseSync, { wasmModule: wasmModule as never, wasmMemory: memory as never }) as SyncVariant,
      ),
    ),
    guestPrelude(),
  ]);
  let runtime: QuickJSRuntime | undefined = quickjs.newRuntime();
  // Only refuses a single allocation larger than the whole budget; the memory above does the rest.
  runtime.setMemoryLimit(pages * PAGE);
  runtime.setMaxStackSize(limits.guestStack);
  runtime.setInterruptHandler(() => Date.now() > deadline);
  let vm: QuickJSContext | undefined = runtime.newContext();
  /** After a crash inside the interpreter its memory is in an unknown state: touch nothing, just drop it. */
  let broken = false;

  const host = vm.newFunction('__host', (opHandle, firstHandle, secondHandle) => {
    const context = vm!;
    try {
      const answer = bridge(
        context.getString(opHandle),
        context.getString(firstHandle),
        context.getString(secondHandle),
      );
      return context.newString(answer);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'the platform could not answer';
      return { error: context.newError({ name: 'Error', message }) };
    }
  });
  vm.setProp(vm.global, '__host', host);
  host.dispose();

  /** Runs `fn` and turns a crash of the interpreter itself into a GuestFailure. */
  const guarded = <T>(fn: (context: QuickJSContext, rt: QuickJSRuntime) => T): T => {
    if (broken || !vm || !runtime) throw new GuestFailure('internal', 'the sandbox is no longer usable');
    try {
      return fn(vm, runtime);
    } catch (error) {
      if (error instanceof GuestFailure) throw error;
      // The interpreter's native stack overflowed (deeply nested data or code), or it aborted.
      broken = true;
      if (error instanceof RangeError) throw new GuestFailure('stack_overflow', 'the function recursed too deeply');
      throw new GuestFailure('internal', 'the sandbox stopped unexpectedly');
    }
  };

  const run = (code: string, filename: string) =>
    guarded((context) => {
      const result = context.evalCode(code, filename, { type: 'global' });
      if (result.error) {
        const error = readError(context, cut!, result.error);
        result.error.dispose();
        throw failure(error, deadline);
      }
      result.value.dispose();
    });

  // The platform keeps its own references to its entry points, taken before any code of the
  // app runs: whatever the app does to the globals afterwards, these are what gets called.
  // (Making the global read-only would not do: this engine lets it be redefined anyway.)
  const entries = new Map<Entry, QuickJSHandle>();
  let cut: QuickJSHandle | undefined;
  try {
    cut = vm.unwrapResult(vm.evalCode(CUT, 'socle:cut'));
    run(library, 'socle:std');
    guarded((context) => {
      const socle = context.getProp(context.global, '__socle');
      for (const entry of ENTRIES) entries.set(entry, context.getProp(socle, entry));
      socle.dispose();
    });
  } catch (error) {
    for (const handle of entries.values()) handle.dispose();
    cut?.dispose();
    vm.dispose();
    runtime.dispose();
    throw error;
  }

  return {
    run,

    call(entry, args, maxLength) {
      return guarded((context, rt) => {
        const handles = args.map((arg) => context.newString(arg));
        const result = context.callFunction(entries.get(entry)!, context.undefined, ...handles);
        for (const handle of handles) handle.dispose();
        if (result.error) {
          const error = readError(context, cut!, result.error);
          result.error.dispose();
          throw failure(error, deadline);
        }
        let value = result.value;
        try {
          if (context.typeof(value) === 'object') {
            // An async function: run it to completion. There is no timer and no I/O in the
            // sandbox, so a promise still pending once the job queue is empty will never settle.
            const jobs = rt.executePendingJobs();
            if (jobs.error) {
              const error = readError(context, cut!, jobs.error);
              jobs.error.dispose();
              throw failure(error, deadline);
            }
            const state = context.getPromiseState(value);
            if (state.type === 'pending') {
              throw new GuestFailure(
                Date.now() > deadline ? 'timeout' : 'error',
                Date.now() > deadline
                  ? 'the function ran for too long and was stopped'
                  : 'the function returned a promise that never settles (there are no timers and no network in server functions)',
              );
            }
            if (state.type === 'rejected') {
              const error = readError(context, cut!, state.error);
              state.error.dispose();
              throw failure(error, deadline);
            }
            value.dispose();
            value = state.value;
          }
          if (context.typeof(value) !== 'string')
            throw new GuestFailure('internal', 'unexpected answer from the sandbox');
          const length = context.getProp(value, 'length').consume((handle) => context.getNumber(handle));
          if (length > maxLength) {
            throw new GuestFailure('result_too_large', `the function returned too much data (${length} characters)`);
          }
          return context.getString(value);
        } finally {
          value.dispose();
        }
      });
    },

    dispose() {
      const [context, rt] = [vm, runtime];
      vm = undefined;
      runtime = undefined;
      const grown = memory.buffer.byteLength > 2 * INITIAL_PAGES * PAGE;
      try {
        // After a crash inside the interpreter its memory is in an unknown state: just drop it.
        if (!broken) {
          for (const handle of entries.values()) handle.dispose();
          cut?.dispose();
          context?.dispose();
          rt?.dispose();
        }
      } catch {
        // a leaked handle after an error: the whole instance is dropped anyway
      }
      // A memory that grew is only given back when it is collected: do not wait for that
      // (worker processes run with --expose-gc; elsewhere the collector comes in its own time).
      if (grown) (globalThis as { gc?: () => void }).gc?.();
    },
  };
}
