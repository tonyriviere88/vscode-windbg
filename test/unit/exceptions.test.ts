import * as assert from 'assert';
import { describe, it } from 'node:test';
import { ExceptionPolicy } from '../../src/adapter/exceptions';
import { PsThread, buildParallelStacks } from '../../src/parallelStacksModel';

describe('exception policy', () => {
    it('breaks on C++ exceptions per filter, condition and override', () => {
        const p = new ExceptionPolicy();
        p.setFilters({ filters: [] });
        assert.ok(!p.breakOnCpp('std::runtime_error'));
        assert.ok(p.sxCommands().includes('sxd eh'));

        p.setFilters({ filters: ['cpp'] });
        assert.ok(p.breakOnCpp('std::runtime_error'));
        assert.ok(p.sxCommands().includes('sxe eh'));

        p.setFilters({ filters: [], filterOptions: [{ filterId: 'cpp', condition: 'MyNs::*, std::bad_alloc' }] });
        assert.ok(p.breakOnCpp('MyNs::Error'));
        assert.ok(p.breakOnCpp('std::bad_alloc'));
        assert.ok(!p.breakOnCpp('std::runtime_error'));

        p.setOverrides([{ category: 'cpp', id: 'MyNs::Ignored', enabled: false }, { category: 'cpp', id: 'std::runtime_error', enabled: true }]);
        assert.ok(!p.breakOnCpp('MyNs::Ignored'));
        assert.ok(p.breakOnCpp('std::runtime_error'));
    });

    it('needs C++ events when only an override asks to break', () => {
        const p = new ExceptionPolicy();
        p.setFilters({ filters: [] });
        p.setOverrides([{ category: 'cpp', id: 'Fatal', enabled: true }]);
        assert.ok(p.needCppEvents());
        assert.ok(p.breakOnCpp('Fatal'));
        assert.ok(!p.breakOnCpp('Other'));
    });

    it('maps Win32 filters and overrides to sx commands', () => {
        const p = new ExceptionPolicy();
        p.setFilters({ filters: ['av'] });
        assert.ok(p.breakOnWin32(0xc0000005));
        assert.ok(!p.breakOnWin32(0xc0000094));
        let cmds = p.sxCommands();
        assert.ok(cmds.includes('sxe av'));
        assert.ok(cmds.includes('sxd dz'));
        assert.ok(cmds.includes('sxd *'));

        p.setFilters({ filters: ['win32'] });
        assert.ok(!p.breakOnWin32(0xc0000005));
        assert.ok(p.breakOnWin32(0xc0000094));
        assert.ok(p.sxCommands().includes('sxe *'));

        p.setFilters({ filters: [], filterOptions: [{ filterId: 'win32', condition: '0xC00000FD, 12345678' }] });
        assert.ok(p.breakOnWin32(0xc00000fd));
        assert.ok(!p.breakOnWin32(0xc0000094));
        cmds = p.sxCommands();
        assert.ok(cmds.includes('sxe sov'));
        assert.ok(cmds.includes('sxe 0x12345678'));
        assert.ok(cmds.includes('sxd *'));

        p.setOverrides([{ category: 'win32', id: 'C0000005', enabled: false }]);
        p.setFilters({ filters: ['av'] });
        assert.ok(!p.breakOnWin32(0xc0000005));
        assert.ok(p.sxCommands().includes('sxd av'));
    });
});

describe('parallel stacks model', () => {
    const frame = (fn: string, user = true) => ({ module: 'app', fn, user, file: user ? 'a.cpp' : undefined, line: 1 });
    const thread = (id: number, fns: Array<[string, boolean?]>): PsThread => ({
        id,
        index: id,
        name: '',
        // fns are outermost first; frames[0] must be innermost.
        frames: fns
            .map(([fn, user]) => frame(fn, user ?? true))
            .reverse()
            .map((f, i) => ({ ...f, index: i })),
    });

    it('merges shared call paths and splits where threads diverge', () => {
        const threads = [
            thread(1, [['start', false], ['main'], ['run'], ['workA']]),
            thread(2, [['start', false], ['main'], ['run'], ['workB']]),
            thread(3, [['start', false], ['main'], ['run'], ['workB']]),
            thread(4, [['start', false], ['idle']]),
        ];
        const roots = buildParallelStacks(threads, false);
        assert.strictEqual(roots.length, 1);
        const root = roots[0];
        assert.deepStrictEqual(root.frames.map((f) => f.label), ['[External Code]']);
        assert.deepStrictEqual(root.threads.sort(), [1, 2, 3, 4]);
        const labels = root.children.map((c) => c.frames.map((f) => f.label).join(' > ')).sort();
        assert.deepStrictEqual(labels, ['app!idle', 'app!main > app!run']);
        const run = root.children.find((c) => c.frames.length === 2)!;
        assert.deepStrictEqual(run.children.map((c) => [c.frames[0].label, c.threads.length]).sort(), [
            ['app!workA', 1],
            ['app!workB', 2],
        ]);
        // Frame indices are kept per thread for navigation.
        const workB = run.children.find((c) => c.frames[0].label === 'app!workB')!;
        assert.deepStrictEqual(workB.frames[0].frames, { 2: 0, 3: 0 });
    });

    it('keeps external frames when asked', () => {
        const roots = buildParallelStacks([thread(1, [['start', false], ['inner', false], ['main']])], true);
        assert.deepStrictEqual(roots[0].frames.map((f) => f.label), ['app!start', 'app!inner', 'app!main']);
        const hidden = buildParallelStacks([thread(1, [['start', false], ['inner', false], ['main']])], false);
        assert.deepStrictEqual(hidden[0].frames.map((f) => f.label), ['[External Code]', 'app!main']);
    });
});
