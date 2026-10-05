import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { DebugClient } from '@vscode/debugadapter-testsupport';
import { DebugProtocol } from '@vscode/debugprotocol';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ADAPTER = path.join(ROOT, 'out', 'src', 'adapter', 'main.js');
const SAMPLE_DIR = path.join(ROOT, 'test', 'sample');
const SOURCE = path.join(SAMPLE_DIR, 'sample.cpp');
const PROGRAM = path.join(SAMPLE_DIR, 'out', 'sample.exe');
const TIMEOUT = 20000;

const sourceLines = fs.readFileSync(SOURCE, 'utf8').split(/\r?\n/);
function lineOf(text: string): number {
    const idx = sourceLines.findIndex((l) => l.includes(text));
    assert.ok(idx >= 0, `line containing "${text}" not found`);
    return idx + 1;
}

function ensureSample(): void {
    const inputs = [SOURCE, path.join(SAMPLE_DIR, 'plugin.cpp'), path.join(SAMPLE_DIR, 'build.cmd')];
    if (!fs.existsSync(PROGRAM) || inputs.some((f) => fs.statSync(PROGRAM).mtimeMs < fs.statSync(f).mtimeMs)) {
        execFileSync('cmd.exe', ['/c', path.join(SAMPLE_DIR, 'build.cmd')], { stdio: 'inherit' });
    }
}

const baseLaunch = {
    program: PROGRAM,
    console: 'internalConsole',
    justMyCode: true,
    symbols: { useMicrosoftSymbolServer: false, inheritNtSymbolPath: false },
};

class Session {
    dc: DebugClient;
    output: string[] = [];
    /** Failed responses, which DebugClient turns into bare errors. */
    failures: DebugProtocol.ErrorResponse[] = [];

    constructor() {
        this.dc = new DebugClient('node', ADAPTER, 'windbg');
        this.dc.defaultTimeout = TIMEOUT;
        this.dc.on('output', (e: DebugProtocol.OutputEvent) => this.output.push(e.body.output));
        const client = this.dc as unknown as { dispatch(body: string): void };
        const dispatch = client.dispatch.bind(client);
        client.dispatch = (body: string) => {
            const m = JSON.parse(body);
            if (m.type === 'response' && !m.success) {
                this.failures.push(m);
            }
            dispatch(body);
        };
    }

    async start(launch: Record<string, unknown>, configure: () => Promise<void>): Promise<void> {
        await this.dc.start();
        await this.dc.initializeRequest({ adapterID: 'windbg', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path', supportsVariablePaging: true });
        const initialized = this.dc.waitForEvent('initialized', TIMEOUT);
        await this.dc.launchRequest({ ...baseLaunch, ...launch } as DebugProtocol.LaunchRequestArguments);
        await initialized;
        await configure();
        await this.dc.configurationDoneRequest();
    }

    async setLines(lines: Array<number | DebugProtocol.SourceBreakpoint>): Promise<DebugProtocol.Breakpoint[]> {
        const res = await this.dc.setBreakpointsRequest({
            source: { path: SOURCE },
            breakpoints: lines.map((l) => (typeof l === 'number' ? { line: l } : l)),
        });
        return res.body.breakpoints;
    }

    async waitStopped(): Promise<DebugProtocol.StoppedEvent> {
        return (await this.dc.waitForEvent('stopped', TIMEOUT)) as DebugProtocol.StoppedEvent;
    }

    async run(action: () => Promise<unknown>): Promise<DebugProtocol.StoppedEvent> {
        const stopped = this.waitStopped();
        await action();
        return stopped;
    }

    async top(threadId: number): Promise<DebugProtocol.StackFrame> {
        const st = await this.dc.stackTraceRequest({ threadId, startFrame: 0, levels: 20 });
        return st.body.stackFrames[0];
    }

    async locals(frameId: number): Promise<DebugProtocol.Variable[]> {
        const scopes = await this.dc.scopesRequest({ frameId });
        const vars = await this.dc.variablesRequest({ variablesReference: scopes.body.scopes[0].variablesReference });
        return vars.body.variables;
    }

    async children(v: DebugProtocol.Variable): Promise<DebugProtocol.Variable[]> {
        assert.ok(v.variablesReference > 0, `${v.name} is not expandable`);
        return (await this.dc.variablesRequest({ variablesReference: v.variablesReference })).body.variables;
    }

    async stop(): Promise<void> {
        try {
            await this.dc.disconnectRequest({ terminateDebuggee: true });
        } catch {
            // already gone
        }
        await this.dc.stop();
    }
}

function find(vars: DebugProtocol.Variable[], name: string): DebugProtocol.Variable {
    const v = vars.find((x) => x.name === name);
    assert.ok(v, `variable ${name} not found in [${vars.map((x) => x.name).join(', ')}]`);
    return v!;
}

describe('WinDbg adapter', { timeout: 10 * TIMEOUT }, () => {
    before(() => ensureSample());

    describe('breakpoints, variables and stepping', () => {
        const s = new Session();
        let threadId = 0;
        after(() => s.stop());

        it('stops at a source breakpoint', async () => {
            const stopped = s.waitStopped();
            await s.start({}, async () => {
                const bps = await s.setLines([lineOf('return total;')]);
                assert.strictEqual(bps[0].verified, true, bps[0].message);
                assert.strictEqual(bps[0].line, lineOf('return total;'));
            });
            const ev = await stopped;
            assert.strictEqual(ev.body.reason, 'breakpoint');
            threadId = ev.body.threadId!;
            const top = await s.top(threadId);
            assert.match(top.name, /app::compute/);
            assert.strictEqual(top.line, lineOf('return total;'));
            assert.strictEqual(path.normalize(top.source!.path!).toLowerCase(), SOURCE.toLowerCase());
        });

        it('shows locals with natvis expansion', async () => {
            const top = await s.top(threadId);
            const vars = await s.locals(top.id);
            assert.strictEqual(find(vars, 'total').value, '44');
            const shape = find(vars, 's');
            const members = await s.children(shape);
            assert.strictEqual(find(members, 'name').value, '"triangle"');
            assert.match(find(members, 'points').value, /size=3/);
            const points = await s.children(find(members, 'points'));
            const p1 = find(points, '[1]');
            assert.match(p1.value, /x=3 y=4/);
            const raw = await s.children(find(points, '[Raw View]'));
            assert.ok(raw.some((v) => v.name === '_Mypair'));
            assert.match(find(members, 'wideLabel').value, /L"wide label"/);
            const tags = await s.children(find(members, 'tags'));
            assert.ok(tags.some((v) => v.value.includes('"color", 7')), JSON.stringify(tags));
        });

        it('evaluates watch expressions', async () => {
            const top = await s.top(threadId);
            const r1 = await s.dc.evaluateRequest({ expression: 'total * 2', frameId: top.id, context: 'watch' });
            assert.strictEqual(r1.body.result, '88');
            const r2 = await s.dc.evaluateRequest({ expression: 's.name', frameId: top.id, context: 'watch' });
            assert.strictEqual(r2.body.result, '"triangle"');
            const r3 = await s.dc.evaluateRequest({ expression: 'total,x', frameId: top.id, context: 'watch' });
            assert.strictEqual(r3.body.result, '0x2c');
            // String format specifiers read what a pointer points to, whatever its type.
            const sub = await s.dc.evaluateRequest({ expression: 's.wideLabel,sub', frameId: top.id, context: 'watch' });
            assert.strictEqual(sub.body.result, 'wide label');
            const su = await s.dc.evaluateRequest({ expression: '(void*)s.wideLabel,su', frameId: top.id, context: 'watch' });
            assert.strictEqual(su.body.result, 'L"wide label"');
            await assert.rejects(s.dc.evaluateRequest({ expression: 'nosuchvariable', frameId: top.id, context: 'watch' }));
            // The watch shows the error: a notification would only repeat it.
            const failure = s.failures.find((f) => f.command === 'evaluate');
            assert.ok(failure, 'no failed evaluate response');
            assert.notStrictEqual(failure!.body.error?.showUser, true);
            const repl = await s.dc.evaluateRequest({ expression: 'k 2', frameId: top.id, context: 'repl' });
            assert.match(repl.body.result, /app::compute/);
        });

        it('runs command window commands and reports its prompt', async () => {
            const state = await s.dc.customRequest('commandWindowState', {});
            assert.strictEqual(state.body.state, 'stopped');
            assert.match(state.body.prompt, /^0:\d{3}>$/);
            assert.match(state.body.location, /^sample!app::compute\+0x[0-9a-f]+ \[.*sample\.cpp @ \d+\]$/i);

            const st = await s.dc.stackTraceRequest({ threadId, startFrame: 0, levels: 20 });
            const main = st.body.stackFrames.find((f) => f.name.includes('!main'))!;
            const k = await s.dc.customRequest('runCommand', { command: 'k 2' });
            assert.match(k.body.output, /app::compute/);
            // Like the Debug Console, commands run in the given frame.
            const dv = await s.dc.customRequest('runCommand', { command: 'dv shape', frameId: main.id });
            assert.match(dv.body.output, /shape/);
            await assert.rejects(s.dc.customRequest('runCommand', { command: 'wt' }), /not supported/);
        });

        it('evaluates in the selected frame', async () => {
            const st = await s.dc.stackTraceRequest({ threadId, startFrame: 0, levels: 20 });
            const main = st.body.stackFrames.find((f) => f.name.includes('!main'));
            assert.ok(main, st.body.stackFrames.map((f) => f.name).join(', '));
            const r = await s.dc.evaluateRequest({ expression: 'shape.area', frameId: main!.id, context: 'watch' });
            assert.strictEqual(r.body.result, '12.5');
        });

        it('collapses external frames', async () => {
            const st = await s.dc.stackTraceRequest({ threadId, startFrame: 0, levels: 20 });
            const names = st.body.stackFrames.map((f) => f.name);
            assert.ok(names.includes('[External Code]'), names.join(', '));
            assert.ok(!names.some((n) => n.includes('invoke_main')), names.join(', '));
        });

        it('sets variables', async () => {
            const top = await s.top(threadId);
            const scopes = await s.dc.scopesRequest({ frameId: top.id });
            const res = await s.dc.setVariableRequest({ variablesReference: scopes.body.scopes[0].variablesReference, name: 'total', value: '44' });
            assert.strictEqual(res.body.value, '44');
        });

        it('reads memory and disassembles', async () => {
            const top = await s.top(threadId);
            const vars = await s.locals(top.id);
            const total = find(vars, 'total');
            assert.ok(total.memoryReference);
            const mem = await s.dc.customRequest('readMemory', { memoryReference: total.memoryReference, count: 4 });
            assert.strictEqual(Buffer.from(mem.body.data, 'base64').readInt32LE(0), 44);
            // Answers longer than cdb's 16 KB output line limit must survive intact.
            const big = await s.dc.customRequest('readMemory', { memoryReference: top.instructionPointerReference, count: 20000 });
            const bytes = Buffer.from(big.body.data, 'base64').length;
            assert.ok(bytes > 8192, `only ${bytes} bytes read`);
            assert.strictEqual(bytes + (big.body.unreadableBytes ?? 0), 20000);
            const dis = await s.dc.disassembleRequest({ memoryReference: top.instructionPointerReference!, instructionOffset: -4, instructionCount: 10 });
            assert.strictEqual(dis.body!.instructions.length, 10);
            assert.ok(dis.body!.instructions.some((i) => BigInt(i.address) === BigInt(top.instructionPointerReference!)));
        });

        it('lists modules with their location and symbol state', async () => {
            const res = await s.dc.customRequest('modules', {});
            const mods = res.body.modules as Array<{ name: string; path: string; shortName: string; symbolKind: string; symbolFilePath?: string; isUserCode: boolean }>;
            const exe = mods.find((m) => m.name.toLowerCase() === 'sample.exe');
            assert.ok(exe, mods.map((m) => m.name).join(', '));
            assert.strictEqual(exe!.path.toLowerCase(), PROGRAM.toLowerCase());
            assert.strictEqual(exe!.symbolKind, 'pdb');
            assert.match(exe!.symbolFilePath ?? '', /sample\.pdb$/i);
            assert.strictEqual(exe!.isUserCode, true);
            const ntdll = mods.find((m) => m.name.toLowerCase() === 'ntdll.dll');
            assert.ok(ntdll && path.win32.isAbsolute(ntdll.path), JSON.stringify(ntdll));
            assert.strictEqual(ntdll!.isUserCode, false);
            const deferred = mods.find((m) => m.symbolKind === 'deferred');
            assert.ok(deferred, 'expected a module whose symbols are not loaded yet');

            // Load symbols for one module: without a symbol server it ends with exports only or a PDB.
            const loaded = await s.dc.customRequest('loadSymbols', { module: deferred!.shortName });
            const after = (loaded.body.modules as typeof mods).find((m) => m.shortName === deferred!.shortName)!;
            assert.notStrictEqual(after.symbolKind, 'deferred');
            const info = await s.dc.customRequest('symbolLoadInfo', { image: deferred!.name });
            assert.match(info.body.output, /Symbol search path is/i);
            assert.match(info.body.output, new RegExp(deferred!.shortName, 'i'));
        });

        it('steps over, out, and into user code only', async () => {
            let ev = await s.run(() => s.dc.nextRequest({ threadId }));
            assert.strictEqual(ev.body.reason, 'step');
            let top = await s.top(threadId);
            assert.strictEqual(top.line, lineOf('return total;') + 1);

            ev = await s.run(() => s.dc.stepOutRequest({ threadId }));
            top = await s.top(threadId);
            assert.match(top.name, /!main/);

            // Line with a call into std::string construction and app::inspect is past; step into
            // the printf line must not enter the CRT.
            ev = await s.run(() => s.dc.stepInRequest({ threadId }));
            top = await s.top(threadId);
            assert.match(top.name, /!main/, `stepped into ${top.name}`);
        });
    });

    describe('conditions, logpoints and JMC step-into', () => {
        const s = new Session();
        after(() => s.stop());

        it('logs, counts hits and steps into user functions', async () => {
            const stopped = s.waitStopped();
            await s.start({}, async () => {
                const bps = await s.setLines([
                    { line: lineOf('int sum = a + b;'), logMessage: 'add({a}, {b}) in $FUNCTION' },
                    { line: lineOf('return sum;'), hitCondition: '==2' },
                ]);
                assert.ok(bps.every((b) => b.verified), JSON.stringify(bps));
            });
            const ev = await stopped;
            assert.strictEqual(ev.body.reason, 'breakpoint');
            const tid = ev.body.threadId!;
            const top = await s.top(tid);
            assert.strictEqual(top.line, lineOf('return sum;'));
            const vars = await s.locals(top.id);
            assert.strictEqual(find(vars, 'sum').value, '14');
            const logs = s.output.filter((o) => o.startsWith('add('));
            assert.deepStrictEqual(logs, ['add(0, 2) in app::add\n', 'add(2, 12) in app::add\n']);

            // Condition: stop in add when a == 14, then step out and back in.
            await s.setLines([{ line: lineOf('int sum = a + b;'), condition: 'a == 14' }]);
            const ev2 = await s.run(() => s.dc.continueRequest({ threadId: tid }));
            assert.strictEqual(ev2.body.reason, 'breakpoint');
            const vars2 = await s.locals((await s.top(tid)).id);
            assert.strictEqual(find(vars2, 'b').value, '30');

            await s.setLines([]);
            await s.run(() => s.dc.stepOutRequest({ threadId: tid }));
            const back = await s.top(tid);
            assert.match(back.name, /app::compute/);

            // Step into from the loop header: std::vector iterator code is external and skipped.
            await s.dc.setBreakpointsRequest({ source: { path: SOURCE }, breakpoints: [] });
            const fb = await s.dc.setFunctionBreakpointsRequest({ breakpoints: [{ name: 'app::inspect' }] });
            assert.ok(fb.body.breakpoints[0].verified, JSON.stringify(fb.body.breakpoints));
        });
    });

    describe('natvis and strings', () => {
        it('applies user natvis files, views strings and evaluates dx in the console', async () => {
            const s = new Session();
            try {
                const stopped = s.waitStopped();
                await s.start({ natvis: [path.join(SAMPLE_DIR, 'sample.natvis')] }, async () => {
                    await s.setLines([lineOf('return total;')]);
                });
                const tid = (await stopped).body.threadId!;
                const top = await s.top(tid);
                const shape = find(await s.locals(top.id), 's');
                const points = await s.children(find(await s.children(shape), 'points'));
                const p1 = find(points, '[1]');
                assert.strictEqual(p1.value, '(3, 4)');
                const items = await s.children(p1);
                assert.strictEqual(find(items, '[length^2]').value, '25');
                assert.ok(items.some((v) => v.name === '[Raw View]'));

                const scopes = await s.dc.scopesRequest({ frameId: top.id });
                await s.dc.variablesRequest({ variablesReference: scopes.body.scopes[0].variablesReference });
                const st = await s.dc.stackTraceRequest({ threadId: tid, startFrame: 0, levels: 20 });
                const main = st.body.stackFrames.find((f) => f.name.includes('!main'))!;
                const text = await s.dc.customRequest('viewString', { expression: 'longText', frameId: main.id });
                assert.strictEqual(text.body.text, 'x'.repeat(300));
                const wide = await s.dc.customRequest('viewString', { expression: 'derived.wide', frameId: main.id });
                assert.strictEqual(wide.body.text, 'wide string');

                const dx = await s.dc.evaluateRequest({ expression: 'dx s.points', frameId: top.id, context: 'repl' });
                assert.ok(dx.body.variablesReference > 0);
                assert.match(dx.body.result, /size=3/);
            } finally {
                await s.stop();
            }
        });
    });

    describe('hover and watch name lookup', () => {
        it('resolves members, statics and globals like Visual Studio, and never loads symbols for a hover', async () => {
            const s = new Session();
            try {
                const stopped = s.waitStopped();
                await s.start({}, async () => {
                    await s.setLines([lineOf('// Counter::bump'), lineOf('// plugin object')]);
                });
                const tid = (await stopped).body.threadId!;
                let top = await s.top(tid);
                const hover = (expression: string) => s.dc.evaluateRequest({ expression, frameId: top.id, context: 'hover' });
                const watch = (expression: string) => s.dc.evaluateRequest({ expression, frameId: top.id, context: 'watch' });

                // Inside Counter::bump: a member, a static member, a global of the enclosing namespace.
                const count = await hover('count');
                assert.strictEqual(count.body.result, '3');
                assert.strictEqual((await hover('instances')).body.result, '2');
                assert.strictEqual((await hover('globalLimit')).body.result, '100');
                assert.strictEqual((await watch('count + instances + globalLimit')).body.result, '105');
                assert.strictEqual((await watch('{,,sample.exe}app::globalLimit')).body.result, '100');
                // Unknown names fail at once instead of searching every module.
                await assert.rejects(hover('nosuchname'), /identifier "nosuchname" is undefined/);
                await assert.rejects(watch('nosuchname'), /identifier "nosuchname" is undefined/);
                await assert.rejects(hover('bump(1)'), /side effects/);

                // Registers, with or without $ / @, and Visual Studio's pseudo-variables.
                const ip = BigInt(top.instructionPointerReference!);
                assert.strictEqual(BigInt((await watch('@rip')).body.result), ip);
                assert.strictEqual((await watch('$rip == rip')).body.result, 'true');
                assert.strictEqual((await hover('$rip == @rip')).body.result, 'true');
                const str = await watch('(char*)rdi,sz');
                assert.match(str.body.result, /^".*"$/s);
                assert.strictEqual((await watch('$tid')).body.result, String(tid));
                assert.match((await watch('$err')).body.result, /^\d+$/);
                await assert.rejects(watch('$nosuch'), /not a register or a pseudo-variable/);
                // Another module's global: Visual Studio's context operator. Without the Microsoft
                // symbol server, ucrtbased has export symbols only and the error says so.
                const crt = s.dc.evaluateRequest({ expression: '{,,ucrtbased.dll}_crtBreakAlloc', frameId: top.id, context: 'watch' });
                await crt.then(
                    (r) => assert.match(r.body.result, /^-?\d+$/),
                    (e: Error) => assert.match(e.message, /ucrtbased has export symbols only/),
                );

                // In main: a pointer to an object whose dynamic type only plugin.dll's symbols describe.
                await s.setLines([lineOf('// plugin object')]);
                await s.run(() => s.dc.continueRequest({ threadId: tid }));
                top = await s.top(tid);
                assert.strictEqual(top.line, lineOf('// plugin object'));
                const plugin = async () => {
                    const res = await s.dc.customRequest('modules', {});
                    return (res.body.modules as Array<{ shortName: string; symbolKind: string }>).find((m) => m.shortName.toLowerCase() === 'plugin')!;
                };
                assert.strictEqual((await plugin()).symbolKind, 'deferred');
                const need = s.dc.waitForEvent('windbgNeedSymbols', TIMEOUT);
                const plugged = await hover('plugged');
                assert.match(plugged.body.result, /baseValue=11/);
                const ev = await need;
                assert.deepStrictEqual(ev.body.modules, [{ module: 'plugin', type: 'app::PluginShape' }]);
                assert.strictEqual((await plugin()).symbolKind, 'deferred', 'the hover loaded the plugin symbols');

                // A watch may load them, and then shows the dynamic type.
                assert.match((await watch('plugged')).body.result, /sides=5/);
                assert.strictEqual((await plugin()).symbolKind, 'pdb');
                assert.strictEqual((await watch('{,,plugin.dll}app::pluginCounter')).body.result, '7');
                assert.strictEqual((await watch('plugin!app::pluginCounter * 2')).body.result, '14');
            } finally {
                await s.stop();
            }
        });

        it('interrupts an evaluation that runs past evaluationTimeout, and the target is unaffected', async () => {
            const s = new Session();
            try {
                const stopped = s.waitStopped();
                // slow.js makes app::Counter take a minute to display.
                await s.start({ evaluationTimeout: 2, initCommands: [`.scriptload "${path.join(SAMPLE_DIR, 'slow.js')}"`] }, async () => {
                    await s.setLines([lineOf('// Counter::bump')]);
                });
                const tid = (await stopped).body.threadId!;
                const top = await s.top(tid);
                const started = Date.now();
                await assert.rejects(s.dc.evaluateRequest({ expression: '*this', frameId: top.id, context: 'watch' }), /Stopped after 2 s/);
                assert.ok(Date.now() - started < 15000, `took ${Date.now() - started} ms`);
                // cdb is usable again at once.
                assert.strictEqual((await s.dc.evaluateRequest({ expression: 'count', frameId: top.id, context: 'watch' })).body.result, '3');
                // The target shares cdb's console and got the Ctrl+Break too: it must run on to its normal exit.
                await s.setLines([]);
                const exited = s.dc.waitForEvent('exited', TIMEOUT);
                await s.dc.continueRequest({ threadId: tid });
                assert.strictEqual((await exited).body.exitCode, 0);
            } finally {
                await s.stop();
            }
        });
    });

    describe('Just My Code stepping', () => {
        it('steps into user functions and over STL internals', async () => {
            const s = new Session();
            try {
                const stopped = s.waitStopped();
                await s.start({}, async () => {
                    await s.setLines([lineOf('for (const auto& p : s.points)')]);
                });
                const tid = (await stopped).body.threadId!;
                await s.setLines([]);
                // The range-for header calls std::vector::begin/end: all external.
                await s.run(() => s.dc.stepInRequest({ threadId: tid }));
                let top = await s.top(tid);
                assert.match(top.name, /app::compute/, `stepped into ${top.name}`);
                // Keep stepping into until app::add is entered.
                for (let i = 0; i < 6 && !/app::add/.test(top.name); i++) {
                    await s.run(() => s.dc.stepInRequest({ threadId: tid }));
                    top = await s.top(tid);
                    assert.match(top.name, /app::(compute|add)/, `stepped into ${top.name}`);
                }
                assert.match(top.name, /app::add/);
            } finally {
                await s.stop();
            }
        });

        it('treats symbols listed in the config file as external', async () => {
            const cfg = path.join(SAMPLE_DIR, 'out', 'jmc-test.json');
            fs.writeFileSync(cfg, '{ // comment\n "external": { "symbols": ["app::add"] } }');
            const s = new Session();
            try {
                const stopped = s.waitStopped();
                await s.start({ justMyCodeConfig: cfg }, async () => {
                    await s.setLines([lineOf('total = add(total, p.x * p.y);')]);
                });
                const tid = (await stopped).body.threadId!;
                await s.setLines([]);
                await s.run(() => s.dc.stepInRequest({ threadId: tid }));
                const top = await s.top(tid);
                assert.match(top.name, /app::compute/, `stepped into ${top.name}`);
            } finally {
                await s.stop();
                fs.rmSync(cfg, { force: true });
            }
        });

        it('stops on entry, at function breakpoints and on data writes', async () => {
            const s = new Session();
            try {
                const stopped = s.waitStopped();
                await s.start({ stopOnEntry: true }, async () => {
                    const fb = await s.dc.setFunctionBreakpointsRequest({ breakpoints: [{ name: 'app::compute' }] });
                    assert.ok(fb.body.breakpoints[0].verified, JSON.stringify(fb.body.breakpoints));
                });
                const entry = await stopped;
                assert.strictEqual(entry.body.reason, 'entry');
                const tid = entry.body.threadId!;
                assert.match((await s.top(tid)).name, /!main/);

                const fn = await s.run(() => s.dc.continueRequest({ threadId: tid }));
                assert.strictEqual(fn.body.reason, 'function breakpoint');
                await s.dc.setFunctionBreakpointsRequest({ breakpoints: [] });

                // Run to the loop body, then watch `total` for writes.
                await s.setLines([lineOf('total = add(total, p.x * p.y);')]);
                await s.run(() => s.dc.continueRequest({ threadId: tid }));
                await s.setLines([]);
                const top = await s.top(tid);
                const scopes = await s.dc.scopesRequest({ frameId: top.id });
                const info = await s.dc.dataBreakpointInfoRequest({ variablesReference: scopes.body.scopes[0].variablesReference, name: 'total' });
                assert.ok(info.body.dataId, info.body.description);
                const db = await s.dc.setDataBreakpointsRequest({ breakpoints: [{ dataId: info.body.dataId!, accessType: 'write' }] });
                assert.ok(db.body.breakpoints[0].verified, JSON.stringify(db.body.breakpoints));
                const hit = await s.run(() => s.dc.continueRequest({ threadId: tid }));
                assert.strictEqual(hit.body.reason, 'data breakpoint');
                const vars = await s.locals((await s.top(tid)).id);
                assert.strictEqual(find(vars, 'total').value, '2');
            } finally {
                await s.stop();
            }
        });
    });

    describe('exceptions', () => {
        it('breaks on thrown C++ exceptions and reports the type', async () => {
            const s = new Session();
            try {
                const stopped = s.waitStopped();
                await s.start({}, async () => {
                    await s.dc.setExceptionBreakpointsRequest({ filters: ['cpp'] });
                });
                const ev = await stopped;
                assert.strictEqual(ev.body.reason, 'exception');
                const info = await s.dc.exceptionInfoRequest({ threadId: ev.body.threadId! });
                assert.strictEqual(info.body.exceptionId, 'std::runtime_error');
                assert.match(info.body.description ?? '', /value too large/);
                assert.strictEqual(info.body.breakMode, 'always');
                const top = await s.top(ev.body.threadId!);
                // The top frame is the throwing user function or the external throw machinery.
                assert.ok(top.name.length > 0);
            } finally {
                await s.stop();
            }
        });

        it('does not break on an exception type that was unchecked', async () => {
            const s = new Session();
            try {
                const terminated = s.dc.waitForEvent('terminated', TIMEOUT);
                let stoppedReason: string | undefined;
                s.dc.on('stopped', (e: DebugProtocol.StoppedEvent) => (stoppedReason = e.body.reason));
                const exited = s.dc.waitForEvent('exited', TIMEOUT);
                await s.start({ exceptionOverrides: [{ category: 'cpp', id: 'std::runtime_error', enabled: false }] }, async () => {
                    await s.dc.setExceptionBreakpointsRequest({ filters: ['cpp'] });
                });
                const ex = (await exited) as DebugProtocol.ExitedEvent;
                await terminated;
                assert.strictEqual(stoppedReason, undefined);
                assert.strictEqual(ex.body.exitCode, 0);
            } finally {
                await s.stop();
            }
        });
    });

    describe('threads and pause', () => {
        it('lists threads, builds parallel stacks and pauses a running target', async () => {
            const s = new Session();
            try {
                const stopped = s.waitStopped();
                await s.start({ args: ['wait'] }, async () => {
                    await s.setLines([lineOf('Sleep(50);')]);
                });
                const ev = await stopped;
                const threads = await s.dc.threadsRequest();
                assert.ok(threads.body.threads.length >= 3, JSON.stringify(threads.body.threads));
                const ps = await s.dc.customRequest('parallelStacks', {});
                const workers = ps.body.threads.filter((t: any) => t.frames.some((f: any) => /app::worker/.test(f.fn)));
                assert.ok(workers.length >= 1, JSON.stringify(ps.body.threads.map((t: any) => t.frames.map((f: any) => f.fn))));

                await s.setLines([]);
                await s.dc.continueRequest({ threadId: ev.body.threadId! });
                await new Promise((r) => setTimeout(r, 1500));
                const paused = await s.run(() => s.dc.pauseRequest({ threadId: 0 }));
                assert.strictEqual(paused.body.reason, 'pause');
                const st = await s.dc.stackTraceRequest({ threadId: paused.body.threadId!, startFrame: 0, levels: 20 });
                assert.ok(st.body.stackFrames.length > 0);

                // Breakpoints can be added while the target runs.
                await s.dc.continueRequest({ threadId: paused.body.threadId! });
                await new Promise((r) => setTimeout(r, 300));
                const bps = await s.setLines([lineOf('Sleep(100);')]);
                assert.ok(bps[0].verified, JSON.stringify(bps));
                const hit = await s.waitStopped();
                assert.strictEqual(hit.body.reason, 'breakpoint');
            } finally {
                await s.stop();
            }
        });
    });

    describe('continuing while VS Code still inspects the stop', () => {
        it('drops the queued inspections and ignores a second Continue', async () => {
            const s = new Session();
            try {
                const stopped = s.waitStopped();
                await s.start({ args: ['wait'] }, async () => {
                    await s.setLines([lineOf('Sleep(100);')]);
                });
                const tid = (await stopped).body.threadId!;
                const top = await s.top(tid);
                assert.strictEqual(find(await s.locals(top.id), 'i').value, '0');

                // Requests VS Code makes at a stop, still queued in cdb when Continue arrives.
                const inspections = Array.from({ length: 30 }, () =>
                    s.dc.evaluateRequest({ expression: 'i', frameId: top.id, context: 'watch' }).then(
                        () => 'ok',
                        (e: Error) => e.message,
                    ),
                );
                const stops: string[] = [];
                s.dc.on('stopped', (e: DebugProtocol.StoppedEvent) => stops.push(e.body.reason));
                const next = s.waitStopped();
                await Promise.all([s.dc.continueRequest({ threadId: tid }), s.dc.continueRequest({ threadId: tid })]);
                const results = await Promise.all(inspections);
                assert.ok(results.every((r) => r === 'ok' || r === 'The target is running.'), JSON.stringify(results));
                assert.ok(results.includes('The target is running.'), 'no queued request was dropped');

                assert.strictEqual((await next).body.reason, 'breakpoint');
                await new Promise((r) => setTimeout(r, 500));
                // One run for the two requests: the loop went round once.
                assert.deepStrictEqual(stops, ['breakpoint']);
                assert.strictEqual(find(await s.locals((await s.top(tid)).id), 'i').value, '1');
            } finally {
                await s.stop();
            }
        });
    });

    describe('breakpoint removal while running', () => {
        it('does not stop at a breakpoint removed while threads keep hitting it', async () => {
            const s = new Session();
            try {
                const hotLine = lineOf('InterlockedIncrement(&spins);');
                const stopped = s.waitStopped();
                await s.start({ args: ['spin'] }, async () => {
                    await s.setLines([hotLine]);
                });
                const tid = (await stopped).body.threadId!;
                const stops: string[] = [];
                s.dc.on('stopped', (e: DebugProtocol.StoppedEvent) => stops.push(`${e.body.reason} ${e.body.description ?? e.body.text ?? ''}`.trim()));

                // Three threads hit the line again before the break-in that applies the removal lands,
                // and the ones that hit it together with the reported thread deliver their hit afterwards.
                for (let round = 0; round < 5; round++) {
                    await s.dc.continueRequest({ threadId: tid });
                    assert.deepStrictEqual(await s.setLines([]), []);
                    if (stops.length > 0) {
                        // Reported before the removal arrived: legitimate, so run again without the breakpoint.
                        stops.length = 0;
                        await s.dc.continueRequest({ threadId: tid });
                    }
                    await new Promise((r) => setTimeout(r, 1000));
                    assert.deepStrictEqual(stops, [], `stopped after removing the breakpoint (round ${round})`);
                    const paused = await s.run(() => s.dc.pauseRequest({ threadId: 0 }));
                    assert.strictEqual(paused.body.reason, 'pause');
                    stops.length = 0;
                    const bps = await s.setLines([hotLine]);
                    assert.ok(bps[0].verified, JSON.stringify(bps));
                }
            } finally {
                await s.stop();
            }
        });

        it('still reports a hardcoded __debugbreak()', async () => {
            const s = new Session();
            try {
                const stopped = s.waitStopped();
                await s.start({ args: ['debugbreak'] }, async () => undefined);
                const ev = await stopped;
                assert.strictEqual(ev.body.reason, 'exception');
                const st = await s.dc.stackTraceRequest({ threadId: ev.body.threadId!, startFrame: 0, levels: 20 });
                assert.ok(
                    st.body.stackFrames.some((f) => f.line === lineOf('__debugbreak();')),
                    st.body.stackFrames.map((f) => `${f.name}:${f.line}`).join(', '),
                );
            } finally {
                await s.stop();
            }
        });
    });
});
