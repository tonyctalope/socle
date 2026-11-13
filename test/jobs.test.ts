import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { openDatabase, run } from '../src/db/database.ts';
import { backupDatabase } from '../src/jobs.ts';
import { purgeRemoved, removeApp } from '../src/runner/bundles.ts';

describe('the nightly copy of the platform database', () => {
  it('writes one consistent copy a day, away from the thread that answers requests, and keeps two weeks', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'socle-backup-'));
    try {
      const db = openDatabase(path.join(dataDir, 'socle.db'));
      run(db, "INSERT INTO settings (key, value) VALUES ('probe', 'kept')");
      const file = await backupDatabase(dataDir, '2027-03-01');
      assert.equal(file, path.join(dataDir, 'backups', 'socle-2027-03-01.db'));
      const copy = new DatabaseSync(file!, { readOnly: true });
      assert.deepEqual({ ...copy.prepare("SELECT value FROM settings WHERE key = 'probe'").get() }, { value: 'kept' });
      copy.close();
      assert.equal(await backupDatabase(dataDir, '2027-03-01'), null); // once a day
      assert.deepEqual(readdirSync(path.join(dataDir, 'backups')), ['socle-2027-03-01.db']); // nothing half-written

      // What an earlier copy left half-written is swept by the next one.
      writeFileSync(path.join(dataDir, 'backups', 'socle-2027-02-27.db.partial'), 'cut short');
      for (let day = 2; day <= 20; day++) {
        writeFileSync(path.join(dataDir, 'backups', `socle-2027-03-${String(day).padStart(2, '0')}.db`), '');
      }
      await backupDatabase(dataDir, '2027-03-21');
      const kept = readdirSync(path.join(dataDir, 'backups')).sort();
      assert.ok(!kept.some((name) => name.endsWith('.partial')));
      assert.equal(kept.length, 14);
      assert.equal(kept[0], 'socle-2027-03-08.db');
      assert.equal(kept.at(-1), 'socle-2027-03-21.db');
      db.close();

      // A copy that cannot be made is an error for the caller, and leaves no file that looks like a backup.
      rmSync(path.join(dataDir, 'socle.db'), { force: true });
      rmSync(path.join(dataDir, 'socle.db-wal'), { force: true });
      rmSync(path.join(dataDir, 'socle.db-shm'), { force: true });
      await assert.rejects(backupDatabase(dataDir, '2027-03-22'));
      assert.ok(!readdirSync(path.join(dataDir, 'backups')).includes('socle-2027-03-22.db'));
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('deletes what a removal set aside a month later, and nothing sooner or else', () => {
    const appsDir = mkdtempSync(path.join(tmpdir(), 'socle-removed-'));
    try {
      const day = 24 * 3600 * 1000;
      const start = Date.parse('2027-03-01T00:00:00Z');
      mkdirSync(path.join(appsDir, 'tasks'));
      writeFileSync(path.join(appsDir, 'tasks', 'live.db'), 'data');
      mkdirSync(path.join(appsDir, 'other'));
      assert.equal(removeApp(appsDir, 'tasks', start), true);
      assert.equal(removeApp(appsDir, 'tasks', start), false); // nothing left to move
      for (const name of ['../outside', '.removed', 'a/b', 'Tasks', 'tasks\n', '']) {
        assert.throws(() => removeApp(appsDir, name, start), /invalid app name/, JSON.stringify(name));
      }
      purgeRemoved(appsDir, start + 29 * day);
      assert.equal(readdirSync(path.join(appsDir, '.removed')).length, 1);
      purgeRemoved(appsDir, start + 31 * day);
      assert.deepEqual(readdirSync(path.join(appsDir, '.removed')), []);
      assert.deepEqual(readdirSync(appsDir).sort(), ['.removed', 'other']);
      purgeRemoved(path.join(appsDir, 'nowhere')); // an instance that never removed anything
    } finally {
      rmSync(appsDir, { recursive: true, force: true });
    }
  });
});
