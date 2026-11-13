import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CallGate } from '../src/apphost/gate.ts';

// The gate in front of the runner: each app gets a bounded share of the workers and
// a bounded line behind them.

const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('the gate in front of the runner', () => {
  it('runs a few calls of an app at once and the others in order, never more', async () => {
    const gate = new CallGate({ perApp: 2, waitingPerApp: 10, maxWaitMs: 5_000 });
    let running = 0;
    let most = 0;
    const order: number[] = [];
    const gates = Array.from({ length: 6 }, deferred);
    const calls = gates.map((step, index) =>
      gate.run('app', undefined, async () => {
        running += 1;
        most = Math.max(most, running);
        order.push(index);
        await step.promise;
        running -= 1;
        return index;
      }),
    );
    await tick();
    assert.deepEqual(order, [0, 1]);
    // Another app is not held back by this one's line.
    assert.equal(await gate.run('other', undefined, async () => 'served'), 'served');
    for (const step of gates) {
      step.release();
      await tick();
    }
    assert.deepEqual(await Promise.all(calls), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(order, [0, 1, 2, 3, 4, 5]);
    assert.equal(most, 2);
  });

  it('refuses at once when the line is full, and after a while when the wait is long', async () => {
    const gate = new CallGate({ perApp: 1, waitingPerApp: 2, maxWaitMs: 60 });
    const stuck = deferred();
    const first = gate.run('app', undefined, () => stuck.promise.then(() => 'done'));
    const waiting = [gate.run('app', undefined, async () => 'second'), gate.run('app', undefined, async () => 'third')];
    assert.equal(await gate.run('app', undefined, async () => 'fourth'), 'busy');
    assert.deepEqual(await Promise.all(waiting), ['busy', 'busy'], 'gave up after the longest wait allowed');
    stuck.release();
    assert.equal(await first, 'done');
    assert.equal(await gate.run('app', undefined, async () => 'afterwards'), 'afterwards');
  });

  it('does not run a call whose caller left while it was waiting', async () => {
    const gate = new CallGate({ perApp: 1, waitingPerApp: 5, maxWaitMs: 5_000 });
    const stuck = deferred();
    const first = gate.run('app', undefined, () => stuck.promise);
    const leaving = new AbortController();
    let ran = false;
    const abandoned = gate.run('app', leaving.signal, async () => {
      ran = true;
    });
    const patient = gate.run('app', undefined, async () => 'patient');
    leaving.abort();
    assert.equal(await abandoned, 'gone');
    stuck.release();
    await first;
    assert.equal(await patient, 'patient');
    assert.equal(ran, false);
    const already = new AbortController();
    already.abort();
    const blocked = deferred();
    const holder = gate.run('app', undefined, () => blocked.promise);
    assert.equal(await gate.run('app', already.signal, async () => 'never'), 'gone');
    blocked.release();
    await holder;
  });

  it('keeps counting right when a call fails', async () => {
    const gate = new CallGate({ perApp: 1, waitingPerApp: 5, maxWaitMs: 5_000 });
    await assert.rejects(
      gate.run('app', undefined, () => Promise.reject(new Error('boom'))),
      /boom/,
    );
    const results = await Promise.all([
      gate.run('app', undefined, async () => 1),
      gate.run('app', undefined, () => Promise.reject(new Error('again'))).catch(() => 'failed'),
      gate.run('app', undefined, async () => 3),
    ]);
    assert.deepEqual(results, [1, 'failed', 3]);
  });
});
