import * as assert from 'assert';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

// End-to-end checks run inside VS Code: the extension, the inline adapter and cdb together,
// driven through the same commands as the debug toolbar.

const sampleDir = path.resolve(__dirname, '..', '..', '..', 'test', 'sample');
const source = path.join(sampleDir, 'sample.cpp');
const program = path.join(sampleDir, 'out', 'sample.exe');
const TIMEOUT = 30000;

const sourceLines = fs.readFileSync(source, 'utf8').split(/\r?\n/);
function lineOf(text: string): number {
    const i = sourceLines.findIndex((l) => l.includes(text));
    assert.ok(i >= 0, text);
    return i + 1;
}

interface Message {
    type: string;
    event?: string;
    command?: string;
    body?: any;
}

/** Records every DAP message so checks can wait for events and failures can show what happened. */
class Recorder {
    messages: Message[] = [];
    private waiters: Array<() => void> = [];

    constructor() {
        vscode.debug.registerDebugAdapterTrackerFactory('windbg', {
            createDebugAdapterTracker: () => ({
                onDidSendMessage: (m: Message) => {
                    this.messages.push(m);
                    for (const w of this.waiters.splice(0)) {
                        w();
                    }
                },
            }),
        });
    }

    mark(): number {
        return this.messages.length;
    }

    async waitEvent(name: string, from: number, timeout = TIMEOUT, predicate: (body: any) => boolean = () => true): Promise<any> {
        const deadline = Date.now() + timeout;
        for (;;) {
            const found = this.messages.slice(from).find((m) => m.type === 'event' && m.event === name && predicate(m.body));
            if (found) {
                return found.body;
            }
            const left = deadline - Date.now();
            if (left <= 0) {
                const tail = this.messages
                    .slice(from)
                    .filter((m) => m.type === 'event')
                    .map((m) => `${m.event} ${JSON.stringify(m.body ?? {}).slice(0, 200)}`)
                    .slice(-15)
                    .join('\n  ');
                throw new Error(`Timed out waiting for '${name}'. Events since:\n  ${tail}`);
            }
            await new Promise<void>((resolve) => {
                const t = setTimeout(resolve, Math.min(left, 200));
                this.waiters.push(() => {
                    clearTimeout(t);
                    resolve();
                });
            });
        }
    }

    output(from: number): string[] {
        return this.messages.slice(from).filter((m) => m.type === 'event' && m.event === 'output').map((m) => String(m.body.output));
    }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until VS Code has focused a frame of the stopped thread, so toolbar commands act on it. */
async function settled(threadId: number): Promise<void> {
    const deadline = Date.now() + TIMEOUT;
    while (Date.now() < deadline) {
        const item = vscode.debug.activeStackItem;
        if (item && 'frameId' in item && item.threadId === threadId) {
            await sleep(100);
            return;
        }
        await sleep(50);
    }
    throw new Error('VS Code did not focus the stopped thread');
}

async function top(session: vscode.DebugSession, threadId: number): Promise<{ id: number; name: string; line: number }> {
    const st = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 20 });
    return st.stackFrames[0];
}

async function variables(session: vscode.DebugSession, ref: number): Promise<Array<{ name: string; value: string; variablesReference: number }>> {
    return (await session.customRequest('variables', { variablesReference: ref })).variables;
}

async function locals(session: vscode.DebugSession, frameId: number) {
    const scopes = await session.customRequest('scopes', { frameId });
    return { ref: scopes.scopes[0].variablesReference as number, vars: await variables(session, scopes.scopes[0].variablesReference) };
}

function find<T extends { name: string }>(list: T[], name: string): T {
    const v = list.find((x) => x.name === name);
    assert.ok(v, `${name} not in [${list.map((x) => x.name).join(', ')}]`);
    return v!;
}

function bp(text: string, options: { condition?: string; hitCondition?: string; logMessage?: string } = {}): vscode.SourceBreakpoint {
    return new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(source), new vscode.Position(lineOf(text) - 1, 0)), true, options.condition, options.hitCondition, options.logMessage);
}

/** Runs a toolbar command and returns the next stopped event. */
async function act(rec: Recorder, command: string): Promise<any> {
    const from = rec.mark();
    await vscode.commands.executeCommand(command);
    const stopped = await rec.waitEvent('stopped', from);
    await settled(stopped.threadId);
    return stopped;
}

async function startSession(config: Record<string, unknown>): Promise<vscode.DebugSession> {
    const folder = vscode.workspace.workspaceFolders![0];
    const ok = await vscode.debug.startDebugging(folder, { type: 'windbg', name: 'e2e', ...config } as vscode.DebugConfiguration);
    assert.ok(ok, 'debugging did not start');
    const s = vscode.debug.activeDebugSession;
    assert.ok(s && s.type === 'windbg');
    return s!;
}

async function endSession(rec: Recorder, session: vscode.DebugSession): Promise<void> {
    const from = rec.mark();
    const ended = new Promise<void>((resolve) => {
        const d = vscode.debug.onDidTerminateDebugSession((s) => {
            if (s.id === session.id) {
                d.dispose();
                resolve();
            }
        });
    });
    await vscode.commands.executeCommand('workbench.action.debug.stop');
    await Promise.race([ended, rec.waitEvent('terminated', from)]);
    await sleep(300);
}

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

const results: string[] = [];
async function check(name: string, f: () => Promise<void>): Promise<void> {
    const t0 = Date.now();
    try {
        await f();
        results.push(`  ok   ${name} (${Date.now() - t0} ms)`);
    } catch (e) {
        results.push(`  FAIL ${name}: ${(e as Error).message}`);
        throw e;
    }
}

async function launchScenario(rec: Recorder, dumpFile: string): Promise<void> {
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    let session!: vscode.DebugSession;
    let tid = 0;

    await check('launch with the default console and stop on entry', async () => {
        const from = rec.mark();
        session = await startSession({ request: 'launch', program: '${workspaceFolder}/out/sample.exe', args: ['wait'], stopOnEntry: true });
        const stopped = await rec.waitEvent('stopped', from);
        assert.strictEqual(stopped.reason, 'entry');
        tid = stopped.threadId;
        await settled(tid);
        assert.match((await top(session, tid)).name, /!main$/);
    });

    await check('continue to a source breakpoint added from VS Code', async () => {
        vscode.debug.addBreakpoints([bp('int result = app::compute(shape);')]);
        await sleep(300);
        const stopped = await act(rec, 'workbench.action.debug.continue');
        assert.strictEqual(stopped.reason, 'breakpoint');
        assert.strictEqual((await top(session, tid)).line, lineOf('int result = app::compute(shape);'));
        vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
        await sleep(300);
    });

    await check('step into (Just My Code skips the ILT thunk)', async () => {
        await act(rec, 'workbench.action.debug.stepInto');
        assert.match((await top(session, tid)).name, /app::compute/);
    });

    await check('step over', async () => {
        const before = (await top(session, tid)).line;
        await act(rec, 'workbench.action.debug.stepOver');
        const after = await top(session, tid);
        assert.match(after.name, /app::compute/);
        assert.ok(after.line > before, `line ${before} -> ${after.line}`);
    });

    await check('logpoint, condition and hit count', async () => {
        vscode.debug.addBreakpoints([bp('int sum = a + b;', { logMessage: 'sum of {a} and {b} in $FUNCTION' }), bp('return sum;', { condition: 'sum > 10', hitCondition: '2' })]);
        await sleep(300);
        const from = rec.mark();
        const stopped = await act(rec, 'workbench.action.debug.continue');
        assert.strictEqual(stopped.reason, 'breakpoint');
        const frame = await top(session, tid);
        assert.strictEqual(frame.line, lineOf('return sum;'));
        assert.strictEqual(find((await locals(session, frame.id)).vars, 'sum').value, '44');
        const logs = rec.output(from).filter((o) => o.startsWith('sum of'));
        assert.deepStrictEqual(logs, ['sum of 0 and 2 in app::add\n', 'sum of 2 and 12 in app::add\n', 'sum of 14 and 30 in app::add\n']);
        vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
        await sleep(300);
    });

    await check('step out twice back to main', async () => {
        await act(rec, 'workbench.action.debug.stepOut');
        assert.match((await top(session, tid)).name, /app::compute/);
        await act(rec, 'workbench.action.debug.stepOut');
        assert.match((await top(session, tid)).name, /!main$/);
        // Back in the middle of the calling line; finish it so `result` is assigned.
        await act(rec, 'workbench.action.debug.stepOver');
        assert.strictEqual((await top(session, tid)).line, lineOf('std::printf("result=%d\\n", result);'));
    });

    await check('locals, natvis from the workspace, watch and set value', async () => {
        const frame = await top(session, tid);
        const { ref, vars } = await locals(session, frame.id);
        assert.strictEqual(find(vars, 'result').value, '44');
        const shape = find(vars, 'shape');
        const members = await variables(session, shape.variablesReference);
        assert.strictEqual(find(members, 'name').value, '"triangle"');
        const points = await variables(session, find(members, 'points').variablesReference);
        assert.strictEqual(find(points, '[0]').value, '(1, 2)');
        const w = await session.customRequest('evaluate', { expression: 'shape.area * 2', frameId: frame.id, context: 'watch' });
        assert.strictEqual(w.result, '25');
        const set = await session.customRequest('setVariable', { variablesReference: ref, name: 'result', value: '44' });
        assert.strictEqual(set.value, '44');
    });

    await check('View String opens the full string in an editor', async () => {
        const frame = await top(session, tid);
        const shape = find((await locals(session, frame.id)).vars, 'shape');
        await vscode.commands.executeCommand('windbg.viewString', { container: { variablesReference: shape.variablesReference }, variable: { name: 'name' } });
        await sleep(300);
        assert.strictEqual(vscode.window.activeTextEditor?.document.getText(), 'triangle');
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    });

    await check('Debug Console commands and dx', async () => {
        const frame = await top(session, tid);
        const k = await session.customRequest('evaluate', { expression: 'k 3', frameId: frame.id, context: 'repl' });
        assert.match(k.result, /sample!main/);
        const dx = await session.customRequest('evaluate', { expression: 'dx shape.points', frameId: frame.id, context: 'repl' });
        assert.ok(dx.variablesReference > 0);
        const dump = await session.customRequest('evaluate', { expression: `.dump /ma /o "${dumpFile}"`, frameId: frame.id, context: 'repl' });
        assert.match(dump.result, /Dump successfully written/i);
    });

    await check('disassembly and memory', async () => {
        const st = await session.customRequest('stackTrace', { threadId: tid, startFrame: 0, levels: 1 });
        const ip = st.stackFrames[0].instructionPointerReference;
        const dis = await session.customRequest('disassemble', { memoryReference: ip, instructionOffset: -3, instructionCount: 8 });
        assert.strictEqual(dis.instructions.length, 8);
        const mem = await session.customRequest('readMemory', { memoryReference: ip, count: 16 });
        assert.strictEqual(Buffer.from(mem.data, 'base64').length, 16);
    });

    await check('C++ exception breaks with its type, and can be unchecked', async () => {
        await session.customRequest('setExceptionBreakpoints', { filters: ['cpp', 'av'] });
        const custom = new Promise<any>((resolve) => {
            const d = vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => {
                if (e.event === 'windbgException') {
                    d.dispose();
                    resolve(e.body);
                }
            });
        });
        const stopped = await act(rec, 'workbench.action.debug.continue');
        assert.strictEqual(stopped.reason, 'exception');
        const info = await session.customRequest('exceptionInfo', { threadId: stopped.threadId });
        assert.strictEqual(info.exceptionId, 'std::runtime_error');
        assert.match(info.description, /value too large/);
        const ev = await custom;
        assert.strictEqual(ev.id, 'std::runtime_error');
        await session.customRequest('setExceptionOverrides', { overrides: [{ category: 'cpp', id: 'std::runtime_error', enabled: false }] });
        await settled(stopped.threadId);
        tid = stopped.threadId;
    });

    await check('function breakpoint on another thread, threads and Parallel Stacks', async () => {
        vscode.debug.addBreakpoints([new vscode.FunctionBreakpoint('app::worker')]);
        await sleep(300);
        const stopped = await act(rec, 'workbench.action.debug.continue');
        assert.strictEqual(stopped.reason, 'function breakpoint', JSON.stringify(stopped));
        assert.notStrictEqual(stopped.threadId, tid, 'worker runs on its own thread');
        assert.match((await top(session, stopped.threadId)).name, /app::worker/);
        const threads = (await session.customRequest('threads')).threads;
        assert.ok(threads.length >= 3, JSON.stringify(threads));
        assert.match((await top(session, tid)).name, /.+/);
        const ps = await session.customRequest('parallelStacks', {});
        assert.ok(ps.threads.some((t: any) => t.frames.some((f: any) => /app::worker/.test(f.fn))));
        await vscode.commands.executeCommand('windbg.parallelStacks');
        await vscode.commands.executeCommand('windbg.showExternalCode');
        await vscode.commands.executeCommand('windbg.hideExternalCode');
        await vscode.commands.executeCommand('windbg.commandWindow');
        await sleep(300);
        const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
        assert.ok(tabs.includes('WinDbg Command'), tabs.join(', '));
        const state = await session.customRequest('commandWindowState', {});
        assert.match(state.prompt, /^0:\d{3}>$/);
        const all = await session.customRequest('runCommand', { command: '~* k 3' });
        assert.match(all.output, /app::worker/);
        // The transcript is fed by the adapter tracker: Debug Console commands, output and stops.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const transcript = require('../../src/commandWindow').CommandWindow.transcript as Array<{ kind: string; text: string }>;
        const dump = transcript.map((e) => `${e.kind}: ${e.text}`).join('').slice(-3000);
        assert.ok(transcript.some((e) => e.kind === 'command' && e.text === 'k 3'), dump);
        assert.ok(transcript.some((e) => e.kind === 'result' && /sample!main/.test(e.text)), dump);
        assert.ok(transcript.some((e) => e.kind === 'event' && /^Function breakpoint hit\nsample!app::worker(\+0x[0-9a-f]+)? \[.*sample\.cpp @ \d+\]/.test(e.text)), dump);
        vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
        await sleep(300);
    });

    await check('modules view: location and PDB state', async () => {
        const mods = (await session.customRequest('modules', {})).modules as Array<{ name: string; path: string; symbolKind: string }>;
        const exe = find(mods, 'sample.exe');
        assert.strictEqual(exe.path.toLowerCase(), program.toLowerCase());
        assert.strictEqual(exe.symbolKind, 'pdb');
        await vscode.commands.executeCommand('windbg.modules.focus');
        await vscode.commands.executeCommand('windbg.modules.refresh');
    });

    await check('pause with the toolbar command', async () => {
        await vscode.commands.executeCommand('workbench.action.debug.continue');
        await sleep(1500);
        const stopped = await act(rec, 'workbench.action.debug.pause');
        assert.strictEqual(stopped.reason, 'pause');
        assert.ok((await session.customRequest('stackTrace', { threadId: stopped.threadId, startFrame: 0, levels: 5 })).stackFrames.length > 0);
    });

    await check('breakpoint added while the target runs', async () => {
        await vscode.commands.executeCommand('workbench.action.debug.continue');
        await sleep(800);
        const from = rec.mark();
        vscode.debug.addBreakpoints([bp('Sleep(100);')]);
        const stopped = await rec.waitEvent('stopped', from);
        assert.strictEqual(stopped.reason, 'breakpoint');
        await settled(stopped.threadId);
        vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
        await sleep(300);
    });

    await check('stop ends the session and the program', async () => {
        const procInfo = (await session.customRequest('evaluate', { expression: '|.', context: 'repl' })).result as string;
        const pid = parseInt(/id:\s*([0-9a-f]+)/i.exec(procInfo)?.[1] ?? '0', 16);
        await endSession(rec, session);
        if (pid) {
            await sleep(500);
            assert.ok(!processAlive(pid), 'program still running');
        }
    });
}

async function attachScenario(rec: Recorder): Promise<void> {
    let child: ChildProcess | undefined;
    await check('attach to a running process, pause, detach', async () => {
        child = spawn(program, ['wait'], { stdio: 'ignore', windowsHide: true });
        await sleep(1000);
        const from = rec.mark();
        const session = await startSession({ request: 'attach', processId: String(child.pid) });
        await sleep(1500);
        const stopped = await act(rec, 'workbench.action.debug.pause');
        assert.strictEqual(stopped.reason, 'pause');
        const st = await session.customRequest('stackTrace', { threadId: stopped.threadId, startFrame: 0, levels: 30 });
        assert.ok(st.stackFrames.length > 0);
        const threads = (await session.customRequest('threads')).threads as Array<{ id: number }>;
        let sawMain = false;
        for (const t of threads) {
            const frames = (await session.customRequest('stackTrace', { threadId: t.id, startFrame: 0, levels: 30 })).stackFrames as Array<{ name: string }>;
            sawMain ||= frames.some((f) => /!main$/.test(f.name));
        }
        assert.ok(sawMain, 'main thread not found');
        assert.ok(rec.messages.slice(from).some((m) => m.type === 'event' && m.event === 'initialized'));
        await endSession(rec, session);
        await sleep(500);
        assert.ok(processAlive(child.pid!), 'detaching must leave the process running');
    });
    if (child?.pid && processAlive(child.pid)) {
        child.kill();
    }
}

async function dumpScenario(rec: Recorder, dumpFile: string): Promise<void> {
    await check('open a crash dump', async () => {
        assert.ok(fs.existsSync(dumpFile), 'no dump was written');
        const from = rec.mark();
        const session = await startSession({ request: 'launch', dumpFile, symbols: { searchPaths: [path.dirname(program)] } });
        const stopped = await rec.waitEvent('stopped', from);
        await settled(stopped.threadId);
        const threads = (await session.customRequest('threads')).threads as Array<{ id: number }>;
        let sawMain = false;
        for (const t of threads) {
            const frames = (await session.customRequest('stackTrace', { threadId: t.id, startFrame: 0, levels: 30 })).stackFrames as Array<{ id: number; name: string }>;
            const main = frames.find((f) => /!main$/.test(f.name));
            if (main) {
                sawMain = true;
                const vars = (await locals(session, main.id)).vars;
                assert.strictEqual(find(vars, 'result').value, '44');
            }
        }
        assert.ok(sawMain, 'main not found in the dump');
        await endSession(rec, session);
    });
}

async function exitScenario(rec: Recorder): Promise<void> {
    await check('program runs to completion and reports its exit code', async () => {
        vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
        const from = rec.mark();
        await startSession({ request: 'launch', program: '${workspaceFolder}/out/sample.exe', console: 'internalConsole' });
        const exited = await rec.waitEvent('exited', from);
        assert.strictEqual(exited.exitCode, 0);
        await rec.waitEvent('terminated', from);
        assert.ok(rec.output(from).some((o) => o.includes('result=44')), 'program output missing from the Debug Console');
        await sleep(500);
    });
}

export async function run(): Promise<void> {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'vscode-windbg');
    assert.ok(ext, 'extension not found');
    await ext!.activate();
    const rec = new Recorder();
    const dumpFile = path.join(os.tmpdir(), `windbg-e2e-${process.pid}.dmp`);
    try {
        await launchScenario(rec, dumpFile);
        await attachScenario(rec);
        await dumpScenario(rec, dumpFile);
        await exitScenario(rec);
    } finally {
        console.log('E2E results:\n' + results.join('\n'));
        fs.rmSync(dumpFile, { force: true });
        vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    }
    console.log('E2E: all checks passed');
}
