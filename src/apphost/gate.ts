// Who gets to call the runner, and when. The runner has a few workers for every app
// together, and a function may hold one for as long as its deadline allows. Without
// this, one app (its own code in a member's browser is enough) could keep all of
// them busy and every other app would wait behind it.

export interface GateOptions {
  /** Calls of one app running at once. Must stay below the number of runner workers. */
  perApp: number;
  /** Calls of one app allowed to wait for their turn. */
  waitingPerApp: number;
  /** How long a call may wait before it is refused. */
  maxWaitMs: number;
}

export const DEFAULT_GATE: GateOptions = { perApp: 2, waitingPerApp: 16, maxWaitMs: 8_000 };

interface Lane {
  running: number;
  waiting: (() => void)[];
}

export class CallGate {
  private readonly options: GateOptions;
  private readonly lanes = new Map<string, Lane>();

  constructor(options: GateOptions = DEFAULT_GATE) {
    this.options = options;
  }

  /**
   * Runs `task` when it is this app's turn. Returns 'busy' without running it when too many
   * calls of the app are already waiting or the wait was too long, and 'gone' when whoever
   * asked has left in the meantime (`signal`).
   */
  async run<T>(app: string, signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T | 'busy' | 'gone'> {
    let lane = this.lanes.get(app);
    if (!lane) {
      lane = { running: 0, waiting: [] };
      this.lanes.set(app, lane);
    }
    if (lane.running >= this.options.perApp) {
      if (lane.waiting.length >= this.options.waitingPerApp) return 'busy';
      const waited = await this.wait(lane, signal);
      if (waited !== 'go') return waited;
      // The call that just finished handed its place over: `running` already counts this one.
    } else {
      lane.running += 1;
    }
    try {
      return await task();
    } finally {
      const next = lane.waiting.shift();
      if (next) {
        next();
      } else {
        lane.running -= 1;
        if (lane.running === 0) this.lanes.delete(app);
      }
    }
  }

  private wait(lane: Lane, signal: AbortSignal | undefined): Promise<'go' | 'busy' | 'gone'> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve('gone');
      const leave = (outcome: 'busy' | 'gone') => {
        const index = lane.waiting.indexOf(go);
        if (index < 0) return; // already had its turn
        lane.waiting.splice(index, 1);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(outcome);
      };
      const onAbort = () => leave('gone');
      const timer = setTimeout(() => leave('busy'), this.options.maxWaitMs);
      const go = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve('go');
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      lane.waiting.push(go);
    });
  }
}
