import * as assert from 'assert';
import * as path from 'path';
import { afterEach, describe, it } from 'node:test';
import { CancelledError, Cdb, TimeoutError } from '../../src/adapter/cdb';

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

    it('fails a command still running at its deadline at once, and goes on with the next ones', async () => {
        const c = start();
        let interrupts = 0;
        // The real one sends Ctrl+Break to the console, which the test runner may share.
        c.interrupt = () => void interrupts++;
        const begin = Date.now();
        const slow = c.exec('sleep 600', { timeoutMs: 100 });
        await assert.rejects(slow, (e: Error) => e instanceof TimeoutError && /still working on it/.test(e.message));
        assert.ok(Date.now() - begin < 500, 'the timeout waited for cdb');
        assert.strictEqual(interrupts, 1);
        // What the interrupted command prints when it ends is not taken for the next command's output.
        assert.strictEqual(await c.exec('k'), 'ran k');
    });

    it('fails a command still queued at its deadline, naming what the debugger is busy with', async () => {
        const c = start();
        c.interrupt = () => undefined;
        const running = c.exec('sleep 400', { label: 'script allStacks' });
        const queued = c.exec('stack', { timeoutMs: 100 });
        const after = c.exec('bp');
        await assert.rejects(queued, (e: Error) => e instanceof TimeoutError && /busy with "script allStacks"/.test(e.message));
        await running;
        assert.strictEqual(await after, 'ran bp');
    });

    it('never reports a command that runs the target as slow', async () => {
        const c = start(100);
        const events: string[] = [];
        c.on('slow', (label: string) => events.push(label));
        await c.exec('sleep 300', { runsTarget: true });
        assert.deepStrictEqual(events, []);
    });
});
