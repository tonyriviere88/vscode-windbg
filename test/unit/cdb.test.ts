import * as assert from 'assert';
import * as path from 'path';
import { afterEach, describe, it } from 'node:test';
import { CancelledError, Cdb } from '../../src/adapter/cdb';

const FAKE_CDB = path.join(__dirname, 'fakeCdb.js');

describe('Cdb queue', () => {
    let cdb: Cdb | undefined;
    afterEach(() => cdb?.kill());

    function start(slowMs?: number): Cdb {
        cdb = new Cdb(undefined, slowMs);
        cdb.start(process.execPath, `"${FAKE_CDB}"`, undefined, process.env);
        return cdb;
    }

    it('drops queued inspection commands and keeps the others', async () => {
        const c = start();
        const running = c.exec('sleep 300');
        const inspection = c.exec('stack', { inspection: true });
        const breakpoint = c.exec('bp');
        assert.strictEqual(c.cancelInspections('The target is running.'), 1);
        await assert.rejects(inspection, (e: Error) => e instanceof CancelledError && e.message === 'The target is running.');
        await running;
        assert.strictEqual(await breakpoint, 'ran bp');
    });

    it('does not drop the inspection command already sent', async () => {
        const c = start();
        const sent = c.exec('stack', { inspection: true });
        assert.strictEqual(c.cancelInspections('The target is running.'), 0);
        assert.strictEqual(await sent, 'ran stack');
    });

    it('reports a slow command, then when it finishes', async () => {
        const c = start(100);
        const events: string[] = [];
        c.on('slow', (label: string, _ms: number, queued: number) => events.push(`slow ${label} (${queued} queued)`));
        c.on('slowDone', (label: string) => events.push(`done ${label}`));
        const slow = c.exec('sleep 400', { label: 'script allStacks' });
        const next = c.exec('k');
        await slow;
        assert.strictEqual(await next, 'ran k');
        assert.deepStrictEqual(events, ['slow script allStacks (1 queued)', 'done script allStacks']);
    });

    it('never reports a command that runs the target as slow', async () => {
        const c = start(100);
        const events: string[] = [];
        c.on('slow', (label: string) => events.push(label));
        await c.exec('sleep 300', { runsTarget: true });
        assert.deepStrictEqual(events, []);
    });
});
