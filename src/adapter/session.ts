import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
    Breakpoint,
    BreakpointEvent,
    ContinuedEvent,
    DebugSession,
    Event,
    ExitedEvent,
    InitializedEvent,
    InvalidatedEvent,
    OutputEvent,
    Scope,
    Source,
    StackFrame,
    StoppedEvent,
    TerminatedEvent,
    Thread,
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { Bridge } from './bridge';
import { CancelledError, Cdb, ExecOptions } from './cdb';
import {
    BREAKPOINT_CODE,
    CPP_EXCEPTION_CODE,
    EXCEPTION_FILTERS,
    ExceptionPolicy,
    SET_THREAD_NAME_CODE,
    WOW64_BREAKPOINT_CODE,
    WOW64_SINGLE_STEP_CODE,
    codeId,
    exceptionName,
} from './exceptions';
import { JustMyCode, moduleBaseName } from './jmc';
import { locateBreakin, locateCdb } from './locator';
import {
    HitCondition,
    LastEvent,
    executionCommand,
    hitConditionSatisfied,
    parseBreakpointList,
    parseDisassembly,
    parseExceptionRecord,
    parseFrameText,
    parseHitCondition,
    parseLastEvent,
    parseLogMessage,
} from './parsers';
import { ModuleDetails, RawModule, WinDbgModule, parseModuleList, toModule } from './modules';
import { buildSourcePath, buildSymbolPath } from './symbols';
import { AttachArguments, BridgeVar, ExceptionOverride, FrameInfo, LaunchArguments, NoLoadResult, ThreadInfo } from './types';

const SCRIPT_PATH = path.join(__dirname, '..', '..', '..', 'dbgscript', 'vscode_windbg.js');
/** Breakpoint ids owned by the adapter start here so they never collide with ones typed in the console. */
const FIRST_BREAKPOINT_ID = 1000;
/** Ids in [FIRST_BREAKPOINT_ID, FIRST_BREAKPOINT_ID + BREAKPOINT_ID_COUNT); cdb uses 10000+ internally (e.g. for `gu`). */
const BREAKPOINT_ID_COUNT = 9000;
const MAX_JMC_STEPS = 64;
/** Lines printed by `.symopt` ("Symbol options are 0x...", "0x00000200 - SYMOPT_FAIL_CRITICAL_ERRORS"). */
const SYMOPT_LISTING = /^\s*(Symbol options are|0x[0-9a-f]+ - SYMOPT_)/i;
const SYMOPT_NO_UNQUALIFIED_LOADS = 0x100;
/** DBG_CONTROL_BREAK: raised in a debugged console process on Ctrl+Break. */
const CONTROL_BREAK_CODE = 0x40010008;

type BpKind = 'source' | 'function' | 'data' | 'instruction' | 'entry';

interface BpRecord {
    kind: BpKind;
    dapId: number;
    cdbId: number;
    file?: string;
    line?: number;
    name?: string;
    condition?: string;
    hitCondition?: string;
    hit?: HitCondition;
    logMessage?: string;
    hits: number;
    verified: boolean;
    actualLine?: number;
    message?: string;
    dataId?: string;
    accessType?: string;
    instructionReference?: string;
    offset?: number;
}

type StepKind = 'over' | 'in' | 'out';

interface StepState {
    kind: StepKind;
    instruction: boolean;
    tid: number;
    startSp?: string;
    startFn?: string;
    startLine?: number;
    iterations: number;
    /** 'escape': stepping out of external code; 'finish': completing a step interrupted by an ignored stop. */
    phase: 'initial' | 'escape' | 'finish';
}

type StopDecision =
    | { kind: 'report'; reason: string; tid: number; text?: string; description?: string; hitIds?: number[]; hitCdbId?: number }
    | { kind: 'continue'; command: string; step?: StepState }
    | { kind: 'exit'; code: number }
    | { kind: 'halt' };

interface ExceptionState {
    code: number;
    id: string;
    category: 'cpp' | 'win32';
    typeName?: string;
    what?: string;
    description: string;
    firstChance: boolean;
}

interface Where {
    tid: number;
    frames: FrameInfo[];
}

interface UserCommand {
    output: string;
    /** Runs after the reply is sent: starts execution commands, refreshes caches after the others. */
    after: () => Promise<void>;
}

function normalizeKey(p: string): string {
    return path.normalize(p).toLowerCase();
}

function quoteArg(a: string): string {
    if (a.length > 0 && !/[\s"]/.test(a)) {
        return a;
    }
    // CommandLineToArgvW quoting rules.
    let out = '"';
    let backslashes = 0;
    for (const ch of a) {
        if (ch === '\\') {
            backslashes++;
        } else if (ch === '"') {
            out += '\\'.repeat(backslashes * 2 + 1) + '"';
            backslashes = 0;
        } else {
            out += '\\'.repeat(backslashes) + ch;
            backslashes = 0;
        }
    }
    return out + '\\'.repeat(backslashes * 2) + '"';
}

function spToBigInt(sp: string | undefined): bigint | undefined {
    if (!sp) {
        return undefined;
    }
    try {
        return BigInt('0x' + sp);
    } catch {
        return undefined;
    }
}

function errorText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

export class WinDbgSession extends DebugSession {
    private cdb: Cdb | undefined;
    private bridge: Bridge | undefined;
    private state: 'init' | 'stopped' | 'running' | 'terminated' = 'init';
    private args: LaunchArguments & AttachArguments = {};
    private isAttach = false;
    private isDump = false;
    private targetPid: number | undefined;
    private mainModule: string | undefined;
    private breakinPath: string | undefined;
    private jmc = new JustMyCode(false, undefined, undefined, {});
    private exceptions = new ExceptionPolicy();
    private showExternal = false;
    private hexDefault = false;
    /** Interrupts an evaluation still running after this long; 0: never. */
    private evaluationTimeoutMs = 10000;
    /** The launched target uses cdb's console, so it receives the Ctrl+Break of an interrupt too. */
    private consoleShared = false;

    private bpById = new Map<number, BpRecord>();
    private sourceBps = new Map<string, BpRecord[]>();
    private functionBps: BpRecord[] = [];
    private dataBps: BpRecord[] = [];
    private instructionBps: BpRecord[] = [];
    private entryBps: number[] = [];
    private nextCdbId = FIRST_BREAKPOINT_ID;
    private nextDapId = 1;

    private frames = new Map<number, { tid: number; index: number }>();
    private nextFrameId = 1;
    private threadsCache: DebugProtocol.Thread[] = [];
    /** Thread id -> cdb thread index, for the "0:003>" prompt. */
    private threadIndex = new Map<number, number>();
    private lastWhere: Where | undefined;
    private lastStopTid: number | undefined;
    private lastException: ExceptionState | undefined;
    private gotoTargets = new Map<number, string>();
    private modulesCache: WinDbgModule[] = [];

    /** Number of times the target stopped inside cdb, including stops the user never sees. */
    private stopCount = 0;
    /** `stopCount` when the last break-in was requested: one is enough until the target stops. */
    private breakinStop = -1;
    /** True while resume() holds the target stopped inside cdb: queued jobs run before it resumes. */
    private analyzing = false;
    private pauseRequested = false;
    private internalJobs: Array<() => Promise<void>> = [];
    private stopWaiters: Array<() => void> = [];
    private terminating = false;
    private terminatedSent = false;

    constructor() {
        super();
        this.setDebuggerLinesStartAt1(true);
        this.setDebuggerColumnsStartAt1(true);
    }

    // ------------------------------------------------------------ helpers

    private log(text: string, category: 'console' | 'stdout' | 'stderr' | 'important' = 'console'): void {
        this.sendEvent(new OutputEvent(text.endsWith('\n') ? text : text + '\n', category));
    }

    private trace(text: string): void {
        if (this.args.trace) {
            this.sendEvent(new OutputEvent(text, 'console'));
        }
    }

    private get engine(): { cdb: Cdb; bridge: Bridge } {
        if (!this.cdb || !this.bridge) {
            throw new Error('The debugger is not running.');
        }
        return { cdb: this.cdb, bridge: this.bridge };
    }

    private exec(command: string, options?: ExecOptions): Promise<string> {
        return this.engine.cdb.exec(command, options);
    }

    private call<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
        return this.engine.bridge.call<T>(op, args);
    }

    /** A script call that only reads state for VS Code: dropped if the target resumes before it is sent. */
    private inspect<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
        return this.engine.bridge.call<T>(op, args, { inspection: true });
    }

    /** An inspection evaluating expressions or values: interrupted when it runs too long. */
    private evaluation<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
        return this.engine.bridge.call<T>(op, args, { inspection: true, timeoutMs: this.evaluationTimeoutMs || undefined });
    }

    /**
     * Fails a request without a notification. VS Code shows the error where the request came from
     * (the watch, the hover, the console, the view), so a pop-up only repeats it.
     */
    private sendQuietError(response: DebugProtocol.Response, code: number, text: string): void {
        this.sendErrorResponse(response, { id: code, format: text, variables: {} });
    }

    private toLocalPath(file: string): string {
        const map = this.args.sourceFileMap;
        if (map) {
            const norm = file.replace(/\//g, '\\');
            for (const [from, to] of Object.entries(map)) {
                const f = from.replace(/\//g, '\\').replace(/\\$/, '');
                if (norm.toLowerCase().startsWith(f.toLowerCase() + '\\') || norm.toLowerCase() === f.toLowerCase()) {
                    return path.join(to, norm.slice(f.length));
                }
            }
        }
        return file;
    }

    private toCompiledPath(file: string): string {
        const map = this.args.sourceFileMap;
        const norm = path.win32.normalize(file);
        if (map) {
            for (const [from, to] of Object.entries(map)) {
                const t = path.win32.normalize(to).replace(/\\$/, '');
                if (norm.toLowerCase().startsWith(t.toLowerCase() + '\\')) {
                    return from.replace(/[\\/]$/, '') + '\\' + norm.slice(t.length + 1);
                }
            }
        }
        return norm;
    }

    private isUserFrame(f: FrameInfo): boolean {
        const parsed = parseFrameText(f.text ?? '');
        return this.jmc.isUserCode({ fn: f.fn ?? parsed.fn, module: f.mod ?? parsed.module, file: f.file });
    }

    // ------------------------------------------------------- initialize

    protected initializeRequest(response: DebugProtocol.InitializeResponse): void {
        response.body = {
            supportsConfigurationDoneRequest: true,
            supportsFunctionBreakpoints: true,
            supportsConditionalBreakpoints: true,
            supportsHitConditionalBreakpoints: true,
            supportsLogPoints: true,
            supportsEvaluateForHovers: true,
            supportsSetVariable: true,
            supportsExceptionInfoRequest: true,
            supportsExceptionFilterOptions: true,
            exceptionBreakpointFilters: EXCEPTION_FILTERS,
            supportsDataBreakpoints: true,
            supportsInstructionBreakpoints: true,
            supportsDisassembleRequest: true,
            supportsSteppingGranularity: true,
            supportsReadMemoryRequest: true,
            supportsWriteMemoryRequest: true,
            supportsTerminateRequest: true,
            supportsDelayedStackTraceLoading: true,
            supportsValueFormattingOptions: true,
            supportsClipboardContext: true,
            supportsGotoTargetsRequest: true,
            supportsModulesRequest: true,
        };
        this.sendResponse(response);
    }

    // ----------------------------------------------------------- launch

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchArguments): Promise<void> {
        this.args = args;
        this.isDump = !!args.dumpFile;
        try {
            if (!args.dumpFile && !args.program) {
                throw new Error('Set "program" (the executable to debug) or "dumpFile" in launch.json.');
            }
            const parts = ['-lines', '-hd'];
            let cwd: string | undefined;
            if (args.dumpFile) {
                parts.push('-z', quoteArg(args.dumpFile));
            } else {
                const program = args.program!;
                if (!fs.existsSync(program)) {
                    throw new Error(`The program "${program}" does not exist.`);
                }
                if (args.console !== 'internalConsole') {
                    parts.push('-2');
                } else {
                    this.consoleShared = true;
                }
                parts.push(quoteArg(program));
                if (typeof args.args === 'string') {
                    if (args.args.trim()) {
                        parts.push(args.args);
                    }
                } else {
                    for (const a of args.args ?? []) {
                        parts.push(quoteArg(a));
                    }
                }
                cwd = args.cwd || path.dirname(program);
            }
            await this.startEngine(parts.join(' '), cwd, args.env, args.program ? path.dirname(args.program) : args.dumpFile ? path.dirname(args.dumpFile) : undefined);
            this.sendResponse(response);
        } catch (e) {
            await this.shutdownQuietly();
            this.sendErrorResponse(response, 1001, errorText(e));
        }
    }

    protected async attachRequest(response: DebugProtocol.AttachResponse, args: AttachArguments): Promise<void> {
        this.args = args;
        this.isAttach = true;
        try {
            const parts = ['-lines'];
            const pid = typeof args.processId === 'string' ? parseInt(args.processId, 10) : args.processId;
            if (pid && !isNaN(pid)) {
                parts.push(args.nonInvasive ? '-pv' : '', '-p', String(pid));
            } else if (args.processName) {
                parts.push(args.nonInvasive ? '-pv' : '', '-pn', quoteArg(args.processName));
            } else {
                throw new Error('Set "processId" or "processName" in launch.json.');
            }
            await this.startEngine(parts.filter((p) => p).join(' '), undefined, undefined, undefined);
            this.sendResponse(response);
        } catch (e) {
            await this.shutdownQuietly();
            this.sendErrorResponse(response, 1002, errorText(e));
        }
    }

    private async startEngine(commandLine: string, cwd: string | undefined, env: Record<string, string | null> | undefined, programDir: string | undefined): Promise<void> {
        const args = this.args;
        const cdbPath = locateCdb(args.debuggerPath);
        if (!cdbPath) {
            throw new Error(
                args.debuggerPath
                    ? `cdb.exe was not found at "${args.debuggerPath}".`
                    : 'cdb.exe was not found. Install "Debugging Tools for Windows" (Windows SDK) or set "windbg.debuggerPath".',
            );
        }
        this.breakinPath = locateBreakin(cdbPath);
        this.jmc = new JustMyCode(args.justMyCode !== false, args.justMyCodeConfig, args.workspaceFolder);
        if (this.jmc.lastError) {
            this.log(`Just My Code: ${this.jmc.lastError}`, 'stderr');
        }
        this.showExternal = !!args.showExternalCode;
        this.hexDefault = !!args.hexadecimalDisplay;
        this.evaluationTimeoutMs = Math.max(0, args.evaluationTimeout ?? 10) * 1000;
        this.exceptions.setOverrides(args.exceptionOverrides);

        const childEnv: NodeJS.ProcessEnv = { ...process.env };
        delete childEnv.ELECTRON_RUN_AS_NODE;
        delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;
        for (const [k, v] of Object.entries(env ?? {})) {
            if (v === null || v === undefined) {
                delete childEnv[k];
            } else {
                childEnv[k] = String(v);
            }
        }

        const cdb = new Cdb(args.trace ? (dir, text) => this.trace(`${dir === 'in' ? '>> ' : ''}${text}`) : undefined);
        this.cdb = cdb;
        this.bridge = new Bridge(cdb);
        cdb.on('exit', () => {
            if (this.state !== 'terminated') {
                this.state = 'terminated';
                this.sendTerminated();
            }
        });
        cdb.on('slow', (label: string, ms: number, queued: number) => {
            const waiting = queued > 0 ? ` ${queued} more request${queued > 1 ? 's' : ''} waiting.` : '';
            this.log(`cdb has been busy with "${label}" for ${Math.round(ms / 1000)} s; the target stays stopped until it finishes.${waiting}`);
        });
        cdb.on('slowDone', (label: string, ms: number) => this.log(`cdb finished "${label}" after ${Math.round(ms / 1000)} s.`));
        cdb.on('timeout', (label: string, ms: number) =>
            this.log(`cdb was still busy with "${label}" after ${Math.round(ms / 1000)} s ("evaluationTimeout"): interrupting it.`, 'stderr'),
        );
        this.log(`WinDbg engine: ${cdbPath}`);
        cdb.start(cdbPath, commandLine, cwd, childEnv);

        try {
            await cdb.exec('.echo ready', { label: 'starting the target' });
        } catch (e) {
            const out = cdb.startupOutput.split(/\r?\n/).filter((l) => /error|cannot|unable|fail/i.test(l));
            throw new Error(`The debugger failed to start the target.\n${out.slice(-5).join('\n') || errorText(e)}`);
        }
        const failure = /Cannot (execute|debug)[^\n]*|Win32 error 0n\d+[^\n]*|Unable to (examine|attach)[^\n]*/i.exec(cdb.startupOutput);
        if (failure) {
            throw new Error(`The debugger could not start the target: ${failure[0].trim()}`);
        }

        const symbolPath = args.symbolPath?.trim() || buildSymbolPath(args.symbols ?? {}, programDir);
        const sourcePath = buildSourcePath(args.sourcePaths, args.sourceServer);
        const setup = ['.lines -e', 'l+t', 'l-s', 'n 10', `.sympath ${symbolPath}`];
        if (sourcePath) {
            setup.push(`.srcpath ${sourcePath}`);
        }
        if (args.symbols?.verbose) {
            setup.push('!sym noisy');
        }
        for (const c of setup) {
            await cdb.exec(c);
        }
        this.log(`Symbol path: ${symbolPath}`);
        this.log(
            args.consoleMode === 'expressions'
                ? 'Debug Console: C++ expressions. Prefix WinDbg commands with -exec, e.g. "-exec lm".'
                : 'Debug Console: WinDbg commands (k, lm, !analyze ...). Use "dx <expression>" for an expandable value.',
        );
        await this.bridge.load(SCRIPT_PATH.includes(' ') ? `"${SCRIPT_PATH}"` : SCRIPT_PATH);

        const natvis = [...(Array.isArray(args.visualizerFile) ? args.visualizerFile : args.visualizerFile ? [args.visualizerFile] : []), ...(args.natvis ?? [])];
        for (const file of [...new Set(natvis)]) {
            const out = await cdb.exec(`.nvload ${file.includes(' ') ? `"${file}"` : file}`);
            if (/error|fail|unable/i.test(out) && !/successfully loaded/i.test(out)) {
                this.log(`natvis ${file}: ${out.trim()}`, 'stderr');
            } else {
                this.log(`Loaded natvis: ${file}`);
            }
        }
        await this.applyExceptionPolicy();
        for (const c of args.initCommands ?? []) {
            const out = await cdb.exec(c);
            if (out.trim()) {
                this.log(out);
            }
        }
        const symopt = /Symbol options are 0x([0-9a-f]+)/i.exec(await cdb.exec('.symopt'));
        if (symopt && (parseInt(symopt[1], 16) & SYMOPT_NO_UNQUALIFIED_LOADS) === 0) {
            this.log(
                'Unqualified symbol loads are on (.symopt- 0x100): a Debug Console expression naming an unknown symbol loads the symbols of every module, which can take minutes.',
                'stderr',
            );
        }
        const proc = await this.call<{ pid: number; main?: string }>('process');
        this.targetPid = proc.pid;
        this.mainModule = proc.main ? moduleBaseName(proc.main) : undefined;
        // VS Code pauses the focused or first known thread: it must know threads before the first stop.
        await this.refreshThreads();
        this.state = 'stopped';
        this.sendEvent(new InitializedEvent());
    }

    protected async configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse): Promise<void> {
        this.sendResponse(response);
        if (this.isDump) {
            const where = await this.where();
            const le = parseLastEvent(await this.exec('.lastevent'));
            if (le.kind === 'exception') {
                this.lastException = await this.describeException(le);
            }
            this.reportStop({ kind: 'report', reason: le.kind === 'exception' ? 'exception' : 'entry', tid: where.tid, text: this.lastException?.description });
            return;
        }
        if (this.args.stopOnEntry && !this.isAttach && this.args.program) {
            const mod = moduleBaseName(this.args.program);
            for (const fn of ['main', 'wmain', 'WinMain', 'wWinMain']) {
                const id = this.allocateCdbId();
                await this.exec(`bu${id} /1 ${mod}!${fn}`);
                this.entryBps.push(id);
            }
        }
        void this.resume('g');
    }

    // ------------------------------------------------------- execution

    private onRunOutput(line: string): void {
        const mod = /^ModLoad: [0-9a-f`]+ [0-9a-f`]+\s+(.*)$/i.exec(line);
        if (mod) {
            this.log(`Loaded '${mod[1].trim()}'`);
            return;
        }
        const ex = /^\([0-9a-f]+\.[0-9a-f]+\): (.*) - code ([0-9a-f]+) \((first|second|!!! second) chance(?: !!!)?\)/i.exec(line);
        if (ex) {
            const code = parseInt(ex[2], 16) >>> 0;
            if (code !== BREAKPOINT_CODE && code !== WOW64_BREAKPOINT_CODE) {
                this.log(`Exception: ${ex[1]} (0x${codeId(code)}, ${ex[3].replace('!!! ', '')} chance)`);
            }
            return;
        }
        if (
            !line.trim() ||
            /^Breakpoint \d+ hit$/.test(line) ||
            /^First chance exceptions are reported before any exception handling\.$/.test(line) ||
            /^This exception may be expected and handled\.$/.test(line) ||
            /^\S+![^\s]*:$/.test(line) ||
            /^[0-9a-f]{8}`[0-9a-f]{8} [0-9a-f]+\s/i.test(line) ||
            /^\*\*\* WARNING: Unable to verify checksum/.test(line) ||
            /^@\$vscwdbg\(/.test(line) ||
            /^Last event:/.test(line) ||
            /^\s+debugger time:/.test(line)
        ) {
            return;
        }
        this.sendEvent(new OutputEvent(line + '\n', this.args.console === 'internalConsole' ? 'stdout' : 'console'));
    }

    private async where(depth = 16): Promise<Where> {
        return this.call<Where>('where', { depth });
    }

    /**
     * Leaves the stopped state for an execution request. False when the target already runs (a second
     * Continue or step while the first one is still being handled) or the session is over.
     */
    private beginRun(): boolean {
        if (this.state !== 'stopped') {
            return false;
        }
        this.state = 'running';
        // Jobs queued from now on run before the target moves; see runWhenStopped.
        this.analyzing = true;
        this.frames.clear();
        this.lastException = undefined;
        // What VS Code asked for at the stop is useless now, and cdb would hold the target until it is done.
        const dropped = this.engine.cdb.cancelInspections('The target is running.');
        if (dropped > 0) {
            this.trace(`[run] dropped ${dropped} queued inspection requests\n`);
        }
        return true;
    }

    private async resume(command: string, step?: StepState): Promise<void> {
        if (this.beginRun()) {
            await this.run(command, step);
        }
    }

    /** Runs execution commands until a stop has to be reported to VS Code. beginRun() must have succeeded. */
    private async run(command: string, step?: StepState): Promise<void> {
        if (this.state === 'terminated') {
            return;
        }
        let cmd = command;
        let currentStep = step;
        try {
            for (;;) {
                if (currentStep?.instruction) {
                    await this.exec('l-t');
                }
                await this.runInternalJobs();
                // No await between the last queue check and the command: later jobs need a break-in.
                this.analyzing = false;
                const out = await this.engine.cdb.exec(cmd, { onLine: (l) => this.onRunOutput(l), runsTarget: true });
                this.analyzing = true;
                this.stopCount++;
                if (currentStep?.instruction) {
                    await this.exec('l+t');
                }
                let decision = await this.analyzeStop(out, currentStep);
                await this.runInternalJobs();
                if (decision.kind === 'report' && decision.hitCdbId !== undefined && !this.bpById.has(decision.hitCdbId)) {
                    // A job queued during the analysis removed the breakpoint that was hit.
                    decision = this.resumeAfterIgnoredStop(currentStep);
                }
                this.trace(`[stop] ${JSON.stringify(decision)}
`);
                if (decision.kind === 'continue') {
                    cmd = decision.command;
                    currentStep = decision.step;
                    continue;
                }
                if (decision.kind === 'exit') {
                    this.state = 'terminated';
                    this.sendEvent(new ExitedEvent(decision.code));
                    this.log(`The program exited with code ${decision.code} (0x${(decision.code >>> 0).toString(16)}).`);
                    this.engine.cdb.writeRaw('q\n');
                    this.sendTerminated();
                    return;
                }
                if (decision.kind === 'halt') {
                    this.state = 'stopped';
                    this.notifyStopWaiters();
                    return;
                }
                this.reportStop(decision);
                return;
            }
        } catch (e) {
            if (this.engine.cdb.exited) {
                return;
            }
            this.log(`Debugger error: ${errorText(e)}`, 'stderr');
            this.stopAfterError(this.lastWhere?.tid ?? this.lastStopTid);
        } finally {
            this.analyzing = false;
            // Only non-empty when an error interrupted the loop.
            void this.runInternalJobs();
        }
    }

    /** Runs the jobs queued while the target was running, including ones queued meanwhile. */
    private async runInternalJobs(): Promise<void> {
        while (this.internalJobs.length > 0) {
            for (const job of this.internalJobs.splice(0)) {
                await job();
            }
        }
    }

    /** cdb holds the target after a failure: show it stopped instead of leaving VS Code showing it running. */
    private stopAfterError(tid: number | undefined): void {
        if (this.terminating || tid === undefined) {
            this.state = 'stopped';
            this.notifyStopWaiters();
            return;
        }
        this.reportStop({ kind: 'report', reason: 'pause', tid, description: 'Paused after a debugger error' });
    }

    private notifyStopWaiters(): void {
        const waiters = this.stopWaiters.splice(0);
        for (const w of waiters) {
            w();
        }
    }

    private reportStop(d: Extract<StopDecision, { kind: 'report' }>): void {
        this.state = 'stopped';
        this.lastStopTid = d.tid;
        this.jmc.reloadIfChanged();
        const ev = new StoppedEvent(d.reason, d.tid, d.text) as DebugProtocol.StoppedEvent;
        ev.body.allThreadsStopped = true;
        if (d.description) {
            ev.body.description = d.description;
        }
        if (d.hitIds) {
            ev.body.hitBreakpointIds = d.hitIds;
        }
        this.sendEvent(ev);
        if (d.reason === 'exception' && this.lastException) {
            const x = this.lastException;
            this.sendEvent(
                new Event('windbgException', {
                    category: x.category,
                    id: x.id,
                    label: x.category === 'cpp' ? x.typeName ?? 'C++ exception' : `${exceptionName(x.code) ?? x.description} (0x${x.id})`,
                    message: x.what,
                    firstChance: x.firstChance,
                }),
            );
        }
        this.notifyStopWaiters();
        void this.refreshPendingBreakpoints();
    }

    private isBreakinStop(where: Where): boolean {
        const top = (where.frames[0]?.text ?? '').toLowerCase();
        const second = (where.frames[1]?.text ?? '').toLowerCase();
        return top.includes('dbgbreakpoint') && (second.includes('dbguiremotebreakin') || where.frames.length <= 3);
    }

    private resumeAfterIgnoredStop(step: StepState | undefined): StopDecision {
        if (!step) {
            return { kind: 'continue', command: 'g' };
        }
        if (step.kind === 'in') {
            // The step was interrupted inside a call it would have entered anyway.
            return { kind: 'continue', command: 'g' };
        }
        return { kind: 'continue', command: 'gu', step: { ...step, phase: 'finish' } };
    }

    private async analyzeStop(_out: string, step: StepState | undefined): Promise<StopDecision> {
        await this.call('reset');
        const le = parseLastEvent(await this.exec('.lastevent'));
        await this.runInternalJobs();
        if (this.terminating) {
            return { kind: 'halt' };
        }
        if (le.kind === 'exit') {
            return { kind: 'exit', code: le.exitCode };
        }
        const where = await this.where(step ? MAX_JMC_STEPS : 16);
        this.lastWhere = where;
        const tid = where.tid;

        if (le.kind === 'exception' && (le.code === BREAKPOINT_CODE || le.code === WOW64_BREAKPOINT_CODE) && this.isBreakinStop(where)) {
            if (this.pauseRequested) {
                this.pauseRequested = false;
                const target = await this.pauseThread(tid);
                return { kind: 'report', reason: 'pause', tid: target };
            }
            return { kind: 'continue', command: 'g' };
        }

        if (le.kind === 'breakpoint') {
            if (this.entryBps.includes(le.id)) {
                await this.clearEntryBreakpoints();
                return { kind: 'report', reason: 'entry', tid };
            }
            const bp = this.bpById.get(le.id);
            if (!bp) {
                if (le.id >= FIRST_BREAKPOINT_ID && le.id < FIRST_BREAKPOINT_ID + BREAKPOINT_ID_COUNT) {
                    // Removed while the target ran: the hit came before the break-in that removed it.
                    return this.resumeAfterIgnoredStop(step);
                }
                if (step) {
                    // Internal breakpoint used by `gu`.
                    return this.continueStep(step, where);
                }
                return { kind: 'report', reason: 'breakpoint', tid, description: `Breakpoint ${le.id}` };
            }
            bp.hits++;
            if (bp.hit && !hitConditionSatisfied(bp.hit, bp.hits)) {
                return this.resumeAfterIgnoredStop(step);
            }
            if (bp.logMessage) {
                await this.emitLogpoint(bp, where);
                return this.resumeAfterIgnoredStop(step);
            }
            const reason = bp.kind === 'data' ? 'data breakpoint' : bp.kind === 'function' ? 'function breakpoint' : bp.kind === 'instruction' ? 'instruction breakpoint' : 'breakpoint';
            return { kind: 'report', reason, tid, hitIds: [bp.dapId], hitCdbId: bp.cdbId };
        }

        if (le.kind === 'exception') {
            if (le.code === WOW64_BREAKPOINT_CODE || le.code === WOW64_SINGLE_STEP_CODE || le.code === SET_THREAD_NAME_CODE) {
                return { kind: 'continue', command: 'g', step };
            }
            if (le.code === BREAKPOINT_CODE && le.firstChance && (await this.isRemovedBreakpointHit())) {
                return this.resumeAfterIgnoredStop(step);
            }
            const info = await this.describeException(le);
            if (le.firstChance && le.code !== BREAKPOINT_CODE) {
                const stop = info.category === 'cpp' ? this.exceptions.breakOnCpp(info.typeName) : this.exceptions.breakOnWin32(le.code);
                if (!stop) {
                    return this.resumeAfterIgnoredStop(step);
                }
            }
            this.lastException = info;
            return { kind: 'report', reason: 'exception', tid, text: info.description };
        }

        if (step) {
            return this.continueStep(step, where);
        }
        return { kind: 'report', reason: 'pause', tid };
    }

    /**
     * True when the int3 that raised the current breakpoint exception is gone: another thread hit a
     * breakpoint at the same time as the reported one, and it was removed before this queued event
     * arrived. dbgeng has already put the original instruction back. A hardcoded __debugbreak() or
     * DebugBreak() still has its 0xCC.
     */
    private async isRemovedBreakpointHit(): Promise<boolean> {
        try {
            const addr = parseExceptionRecord(await this.exec('.exr -1')).address;
            if (!addr) {
                return false;
            }
            const res = await this.call<{ hex: string }>('readMemory', { addr, count: 1 });
            return res.hex.length === 2 && res.hex.toLowerCase() !== 'cc';
        } catch {
            return false;
        }
    }

    private async pauseThread(breakinTid: number): Promise<number> {
        // The break-in thread is not interesting; show the previously stopped thread or the main thread.
        try {
            const t = await this.call<{ threads: ThreadInfo[] }>('threads');
            const candidates = t.threads.filter((x) => x.id !== breakinTid);
            const pick = candidates.find((x) => x.id === this.lastStopTid) ?? candidates[0];
            if (pick) {
                await this.call('switchTo', { tid: pick.id, frame: 0 });
                return pick.id;
            }
        } catch {
            // fall back to the break-in thread
        }
        return breakinTid;
    }

    private continueStep(step: StepState, where: Where): StopDecision {
        const top = where.frames[0];
        if (!top) {
            return { kind: 'report', reason: 'step', tid: where.tid };
        }
        step.iterations++;
        if (step.kind === 'in' && !step.instruction && !top.file && /!ILT\+|thunk|!j_/i.test(top.text ?? '') && step.iterations < MAX_JMC_STEPS) {
            // Incremental-linking and import thunks have no source; keep tracing into the target.
            return { kind: 'continue', command: 't', step };
        }
        if (step.phase === 'finish') {
            const sp = spToBigInt(top.sp);
            const start = spToBigInt(step.startSp);
            if (sp !== undefined && start !== undefined && sp < start && step.iterations < MAX_JMC_STEPS) {
                return { kind: 'continue', command: 'gu', step };
            }
            if (step.kind === 'over' && top.fn === step.startFn && top.line === step.startLine && step.iterations < MAX_JMC_STEPS) {
                return { kind: 'continue', command: 'p', step: { ...step, phase: 'initial' } };
            }
        }
        if (step.instruction || !this.jmc.enabled) {
            return { kind: 'report', reason: 'step', tid: where.tid };
        }
        if (this.isUserFrame(top)) {
            if (
                step.kind === 'in' &&
                step.phase === 'escape' &&
                top.sp === step.startSp &&
                top.fn === step.startFn &&
                top.line === step.startLine &&
                step.iterations < MAX_JMC_STEPS
            ) {
                // Back on the starting line after skipping external code: step into the next call on it.
                return { kind: 'continue', command: 't', step: { ...step, phase: 'initial' } };
            }
            return { kind: 'report', reason: 'step', tid: where.tid };
        }
        if (step.iterations >= MAX_JMC_STEPS) {
            return { kind: 'report', reason: 'step', tid: where.tid };
        }
        if (where.frames.slice(1).some((f) => this.isUserFrame(f))) {
            return { kind: 'continue', command: 'gu', step: { ...step, phase: 'escape' } };
        }
        // No user code on the stack: run until user code hits a breakpoint, like Visual Studio.
        return { kind: 'continue', command: 'g' };
    }

    private async describeException(le: Extract<LastEvent, { kind: 'exception' }>): Promise<ExceptionState> {
        const state: ExceptionState = {
            code: le.code,
            id: codeId(le.code),
            category: le.code === CPP_EXCEPTION_CODE ? 'cpp' : 'win32',
            description: le.description,
            firstChance: le.firstChance,
        };
        if (le.code === CPP_EXCEPTION_CODE) {
            try {
                const rec = parseExceptionRecord(await this.exec('.exr -1'));
                if (rec.params.length >= 3) {
                    const info = await this.call<{ types: string[]; what?: string }>('cppException', { params: rec.params });
                    if (info.types.length > 0) {
                        state.typeName = info.types[0];
                        state.id = info.types[0];
                    }
                    state.what = info.what;
                }
            } catch (e) {
                this.trace(`C++ exception decoding failed: ${errorText(e)}\n`);
            }
            state.description = `${le.firstChance ? 'Exception thrown' : 'Unhandled exception'}: ${state.typeName ?? 'C++ exception'}${state.what ? ` - ${state.what}` : ''}`;
        } else {
            const name = exceptionName(le.code) ?? le.description;
            state.description = `${le.firstChance ? 'Exception thrown' : 'Unhandled exception'}: ${name} (0x${state.id})`;
        }
        return state;
    }

    private async emitLogpoint(bp: BpRecord, where: Where): Promise<void> {
        const parts = parseLogMessage(bp.logMessage ?? '');
        const exprs = parts.filter((p): p is { expr: string } => 'expr' in p).map((p) => p.expr);
        let values: Array<{ ok: boolean; value: string }> = [];
        if (exprs.length > 0) {
            try {
                values = await this.engine.bridge.call('format', { tid: where.tid, frame: 0, exprs }, { timeoutMs: this.evaluationTimeoutMs || undefined });
            } catch (e) {
                values = exprs.map(() => ({ ok: false, value: errorText(e) }));
            }
        }
        const top = where.frames[0];
        const caller = where.frames[1];
        const fnName = (f: FrameInfo | undefined) => (f ? f.fn ?? parseFrameText(f.text ?? '').fn ?? f.text ?? '' : '');
        const keywords: Record<string, () => string> = {
            $FUNCTION: () => fnName(top),
            $CALLER: () => fnName(caller),
            $CALLSTACK: () => '\n' + where.frames.map((f) => `\t${f.text ?? ''}`).join('\n'),
            $TID: () => `0x${where.tid.toString(16)}`,
            $PID: () => `0x${(this.targetPid ?? 0).toString(16)}`,
            $ADDRESS: () => (top?.ip ? `0x${top.ip}` : ''),
            $FILEPOS: () => (top?.file ? `${top.file}(${top.line})` : ''),
        };
        let i = 0;
        const text = parts
            .map((p) => {
                if ('expr' in p) {
                    const v = values[i++];
                    return v ? (v.ok ? v.value : `<${v.value}>`) : '';
                }
                return p.text.replace(/\$(FUNCTION|CALLER|CALLSTACK|TID|PID|ADDRESS|FILEPOS)\b/g, (k) => keywords[k]?.() ?? k);
            })
            .join('');
        const out = new OutputEvent(text + '\n', 'console') as DebugProtocol.OutputEvent;
        if (top?.file) {
            out.body.source = new Source(path.basename(top.file), this.toLocalPath(top.file));
            out.body.line = top.line;
        }
        this.sendEvent(out);
    }

    /** Breaks into the running target; retries once with DebugBreakProcess if it does not stop. */
    private breakIn(): void {
        if (!this.targetPid || this.isDump) {
            return;
        }
        const at = this.stopCount;
        this.breakinStop = at;
        this.spawnBreakin(this.breakinPath);
        const timer = setTimeout(() => {
            if (this.state === 'running' && this.stopCount === at) {
                this.trace('Break-in did not stop the target yet; retrying with DebugBreakProcess.\n');
                this.spawnBreakin(undefined);
            }
        }, 2000);
        timer.unref?.();
    }

    private spawnBreakin(breakinPath: string | undefined): void {
        if (breakinPath) {
            spawn(breakinPath, [String(this.targetPid)], { windowsHide: true, stdio: 'ignore' }).on('error', (e) => this.log(`breakin failed: ${e.message}`, 'stderr'));
            return;
        }
        const script =
            `Add-Type -Namespace W -Name K -MemberDefinition '[DllImport("kernel32.dll")] public static extern System.IntPtr OpenProcess(int a, bool b, int p); ` +
            `[DllImport("kernel32.dll")] public static extern bool DebugBreakProcess(System.IntPtr h);'; [W.K]::DebugBreakProcess([W.K]::OpenProcess(0x1F0FFF, $false, ${this.targetPid}))`;
        spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'ignore' }).on('error', (e) =>
            this.log(`DebugBreakProcess failed: ${e.message}`, 'stderr'),
        );
    }

    /** Runs a job while the target is stopped, breaking in (and resuming afterwards) if it is running. */
    private runWhenStopped<T>(job: () => Promise<T>): Promise<T> {
        if (this.state !== 'running') {
            return job();
        }
        return new Promise<T>((resolve, reject) => {
            this.internalJobs.push(async () => {
                try {
                    resolve(await job());
                } catch (e) {
                    reject(e);
                }
            });
            // While analyzing, resume() runs the queue before the target moves again.
            if (!this.analyzing && this.breakinStop !== this.stopCount) {
                this.breakIn();
            }
        });
    }

    private waitForStop(timeoutMs: number): Promise<boolean> {
        if (this.state !== 'running') {
            return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), timeoutMs);
            this.stopWaiters.push(() => {
                clearTimeout(timer);
                resolve(true);
            });
        });
    }

    protected async continueRequest(response: DebugProtocol.ContinueResponse): Promise<void> {
        if (this.isDump) {
            this.sendErrorResponse(response, 1010, 'A dump file cannot be executed.');
            return;
        }
        response.body = { allThreadsContinued: true };
        this.sendResponse(response);
        void this.resume('g');
    }

    private async startStep(kind: StepKind, threadId: number, granularity: DebugProtocol.SteppingGranularity | undefined): Promise<void> {
        if (!this.beginRun()) {
            return;
        }
        const instruction = granularity === 'instruction';
        let where = this.lastWhere;
        try {
            if (!where || where.tid !== threadId) {
                await this.call('switchTo', { tid: threadId, frame: 0 });
                where = await this.where(MAX_JMC_STEPS);
            } else {
                await this.call('switchTo', { tid: threadId, frame: 0 });
            }
        } catch (e) {
            this.log(`Debugger error: ${errorText(e)}`, 'stderr');
            this.analyzing = false;
            this.stopAfterError(threadId);
            void this.runInternalJobs();
            return;
        }
        const top = where.frames[0];
        const step: StepState = {
            kind,
            instruction,
            tid: threadId,
            startSp: top?.sp,
            startFn: top?.fn,
            startLine: top?.line,
            iterations: 0,
            phase: 'initial',
        };
        let command = kind === 'over' ? 'p' : kind === 'in' ? 't' : 'gu';
        if (!instruction && this.jmc.enabled && top && !this.isUserFrame(top) && where.frames.slice(1).some((f) => this.isUserFrame(f))) {
            // Stepping from external code goes straight back to user code.
            command = 'gu';
            step.phase = 'escape';
        }
        void this.run(command, step);
    }

    protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): Promise<void> {
        this.sendResponse(response);
        await this.startStep('over', args.threadId, args.granularity);
    }

    protected async stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): Promise<void> {
        this.sendResponse(response);
        await this.startStep('in', args.threadId, args.granularity);
    }

    protected async stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): Promise<void> {
        this.sendResponse(response);
        await this.startStep('out', args.threadId, args.granularity);
    }

    protected pauseRequest(response: DebugProtocol.PauseResponse): void {
        if (this.state === 'running') {
            this.pauseRequested = true;
            this.breakIn();
        }
        this.sendResponse(response);
    }

    protected async gotoTargetsRequest(response: DebugProtocol.GotoTargetsResponse, args: DebugProtocol.GotoTargetsArguments): Promise<void> {
        try {
            const file = this.toCompiledPath(args.source.path ?? '');
            const out = await this.exec(`? \`${file}:${args.line}\``);
            const m = /=\s*([0-9a-f]{8}`?[0-9a-f]{0,8})/i.exec(out);
            if (!m) {
                throw new Error(out.trim() || 'No code at this line.');
            }
            const id = this.gotoTargets.size + 1;
            this.gotoTargets.set(id, m[1].replace(/`/g, ''));
            response.body = { targets: [{ id, label: `Line ${args.line}`, line: args.line }] };
            this.sendResponse(response);
        } catch (e) {
            this.sendErrorResponse(response, 1020, errorText(e));
        }
    }

    protected async gotoRequest(response: DebugProtocol.GotoResponse, args: DebugProtocol.GotoArguments): Promise<void> {
        const addr = this.gotoTargets.get(args.targetId);
        if (!addr) {
            this.sendErrorResponse(response, 1021, 'Unknown target.');
            return;
        }
        try {
            await this.call('switchTo', { tid: args.threadId, frame: 0 });
            await this.exec(`r @$ip = 0x${addr}`);
            this.sendResponse(response);
            await this.call('reset');
            this.lastWhere = await this.where();
            this.reportStop({ kind: 'report', reason: 'goto', tid: args.threadId });
        } catch (e) {
            this.sendErrorResponse(response, 1022, errorText(e));
        }
    }

    // ------------------------------------------------------ termination

    private sendTerminated(): void {
        if (!this.terminatedSent) {
            this.terminatedSent = true;
            this.sendEvent(new TerminatedEvent());
        }
    }

    private async stopEngine(terminateDebuggee: boolean): Promise<void> {
        const cdb = this.cdb;
        if (!cdb || cdb.exited) {
            return;
        }
        this.terminating = true;
        if (this.state === 'running') {
            this.breakIn();
            await this.waitForStop(3000);
        }
        const exited = new Promise<void>((resolve) => cdb.once('exit', () => resolve()));
        cdb.writeRaw(terminateDebuggee || this.isDump ? 'q\n' : 'qd\n');
        const timer = new Promise<void>((resolve) => setTimeout(resolve, 5000));
        await Promise.race([exited, timer]);
        if (!cdb.exited) {
            cdb.kill();
        }
        this.state = 'terminated';
    }

    private async shutdownQuietly(): Promise<void> {
        try {
            this.terminatedSent = true;
            await this.stopEngine(true);
        } catch {
            this.cdb?.kill();
        }
    }

    protected async disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): Promise<void> {
        const terminate = args?.terminateDebuggee ?? !this.isAttach;
        try {
            await this.stopEngine(terminate);
        } catch (e) {
            this.cdb?.kill();
        }
        this.sendResponse(response);
        this.shutdown();
    }

    protected async terminateRequest(response: DebugProtocol.TerminateResponse): Promise<void> {
        try {
            await this.stopEngine(true);
        } catch {
            this.cdb?.kill();
        }
        this.sendResponse(response);
        this.sendTerminated();
    }

    // ------------------------------------------------------ breakpoints

    private toDapBreakpoint(rec: BpRecord): DebugProtocol.Breakpoint {
        const bp = new Breakpoint(rec.verified, rec.actualLine ?? rec.line) as DebugProtocol.Breakpoint;
        bp.id = rec.dapId;
        if (rec.message) {
            bp.message = rec.message;
        }
        if (rec.kind === 'source' && rec.file) {
            bp.source = new Source(path.basename(rec.file), rec.file);
        }
        if (rec.instructionReference) {
            bp.instructionReference = rec.instructionReference;
            bp.offset = rec.offset;
        }
        return bp;
    }

    private conditionClause(condition: string | undefined): string {
        if (!condition?.trim()) {
            return '';
        }
        return ` /w "${condition.trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }

    /** Next free id in the adapter's range, rotating so a removed id is not reused soon. */
    private allocateCdbId(): number {
        for (let i = 0; i < BREAKPOINT_ID_COUNT; i++) {
            const id = FIRST_BREAKPOINT_ID + ((this.nextCdbId - FIRST_BREAKPOINT_ID + i) % BREAKPOINT_ID_COUNT);
            if (!this.bpById.has(id) && !this.entryBps.includes(id)) {
                this.nextCdbId = id + 1;
                return id;
            }
        }
        throw new Error('Too many breakpoints.');
    }

    private newRecord(kind: BpKind, init: Partial<BpRecord>): BpRecord {
        const rec: BpRecord = { kind, dapId: this.nextDapId++, cdbId: this.allocateCdbId(), hits: 0, verified: false, ...init };
        if (rec.hitCondition?.trim()) {
            rec.hit = parseHitCondition(rec.hitCondition);
            if (!rec.hit) {
                rec.message = `Invalid hit count "${rec.hitCondition}". Use N, ==N, >=N, >N, <N or %N.`;
            }
        }
        this.bpById.set(rec.cdbId, rec);
        return rec;
    }

    private async createInCdb(rec: BpRecord, command: string): Promise<void> {
        const out = await this.exec(command);
        const problem = out
            .split('\n')
            .filter((l) => !SYMOPT_LISTING.test(l))
            .find((l) => !l.startsWith('*') && /error|couldn't|could not|syntax|invalid|not found|unable/i.test(l) && !/deferred/i.test(l));
        if (problem) {
            rec.message = problem.trim();
        }
    }

    private async deleteFromCdb(recs: BpRecord[]): Promise<void> {
        if (recs.length === 0) {
            return;
        }
        for (const r of recs) {
            this.bpById.delete(r.cdbId);
        }
        await this.exec(`bc ${recs.map((r) => r.cdbId).join(' ')}`);
    }

    private async verify(recs: BpRecord[]): Promise<void> {
        if (recs.length === 0) {
            return;
        }
        const list = parseBreakpointList(await this.exec('bl'));
        for (const r of recs) {
            const e = list.get(r.cdbId);
            if (!e) {
                r.verified = false;
                r.message = r.message ?? 'The breakpoint could not be set.';
                continue;
            }
            r.verified = !e.unresolved && !r.message?.startsWith('Invalid hit count');
            if (r.verified) {
                if (!r.message?.startsWith('Invalid')) {
                    r.message = undefined;
                }
                if (r.kind === 'source' && e.line) {
                    r.actualLine = e.line;
                }
            } else if (!r.message) {
                r.message = 'The breakpoint will be set when its module is loaded (no code found yet).';
            }
        }
    }

    private async refreshPendingBreakpoints(): Promise<void> {
        const pending = [...this.bpById.values()].filter((r) => !r.verified && r.kind !== 'entry' && !r.message?.startsWith('Invalid'));
        if (pending.length === 0 || this.state !== 'stopped') {
            return;
        }
        try {
            await this.verify(pending);
            for (const r of pending) {
                if (r.verified) {
                    this.sendEvent(new BreakpointEvent('changed', this.toDapBreakpoint(r)));
                }
            }
        } catch {
            // best effort
        }
    }

    private async clearEntryBreakpoints(): Promise<void> {
        if (this.entryBps.length > 0) {
            await this.exec(`bc ${this.entryBps.join(' ')}`);
            this.entryBps = [];
        }
    }

    protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
        const file = args.source.path;
        if (!file || !this.cdb) {
            response.body = { breakpoints: (args.breakpoints ?? []).map(() => new Breakpoint(false)) };
            this.sendResponse(response);
            return;
        }
        try {
            const recs = await this.runWhenStopped(async () => {
                const key = normalizeKey(file);
                const old = this.sourceBps.get(key) ?? [];
                const used = new Set<BpRecord>();
                const reqs = args.breakpoints ?? [];
                const reused = reqs.map((req) => {
                    const same = old.find(
                        (o) => !used.has(o) && o.line === req.line && (o.condition ?? '') === (req.condition ?? '') && (o.hitCondition ?? '') === (req.hitCondition ?? '') && (o.logMessage ?? '') === (req.logMessage ?? ''),
                    );
                    if (same) {
                        used.add(same);
                    }
                    return same;
                });
                // Delete first: dbgeng merges a new breakpoint into an existing one at the same address.
                await this.deleteFromCdb(old.filter((o) => !used.has(o)));
                const result: BpRecord[] = [];
                const created: BpRecord[] = [];
                for (let i = 0; i < reqs.length; i++) {
                    const req = reqs[i];
                    if (reused[i]) {
                        result.push(reused[i]!);
                        continue;
                    }
                    const rec = this.newRecord('source', { file, line: req.line, condition: req.condition, hitCondition: req.hitCondition, logMessage: req.logMessage });
                    await this.createInCdb(rec, `bu${rec.cdbId}${this.conditionClause(req.condition)} \`${this.toCompiledPath(file)}:${req.line}\``);
                    result.push(rec);
                    created.push(rec);
                }
                await this.verify(created);
                this.sourceBps.set(key, result);
                return result;
            });
            response.body = { breakpoints: recs.map((r) => this.toDapBreakpoint(r)) };
            this.sendResponse(response);
        } catch (e) {
            this.sendErrorResponse(response, 1030, errorText(e));
        }
    }

    protected async setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments): Promise<void> {
        try {
            const recs = await this.runWhenStopped(async () => {
                await this.deleteFromCdb(this.functionBps);
                const result: BpRecord[] = [];
                for (const req of args.breakpoints) {
                    const rec = this.newRecord('function', { name: req.name, condition: req.condition, hitCondition: req.hitCondition });
                    const name = req.name.trim();
                    const bu = (expr: string) => `bu${rec.cdbId}${this.conditionClause(req.condition)} ${expr}`;
                    if (name.includes('!') || !this.mainModule) {
                        await this.createInCdb(rec, bu(name));
                    } else {
                        // Unqualified names do not load symbols: try the main module, then all modules.
                        await this.createInCdb(rec, bu(`${this.mainModule}!${name}`));
                        await this.verify([rec]);
                        if (!rec.verified) {
                            await this.exec(`bc ${rec.cdbId}`);
                            rec.message = undefined;
                            // One cdb command: no other request (a hover...) can run while unqualified
                            // loads are on, and they cannot stay on if the command fails.
                            await this.createInCdb(rec, `.symopt- 0x100\n${bu(name)}\n.symopt+ 0x100`);
                        }
                    }
                    result.push(rec);
                }
                await this.verify(result);
                this.functionBps = result;
                return result;
            });
            response.body = { breakpoints: recs.map((r) => this.toDapBreakpoint(r)) };
            this.sendResponse(response);
        } catch (e) {
            this.sendErrorResponse(response, 1031, errorText(e));
        }
    }

    protected async setInstructionBreakpointsRequest(response: DebugProtocol.SetInstructionBreakpointsResponse, args: DebugProtocol.SetInstructionBreakpointsArguments): Promise<void> {
        try {
            const recs = await this.runWhenStopped(async () => {
                await this.deleteFromCdb(this.instructionBps);
                const result: BpRecord[] = [];
                for (const req of args.breakpoints) {
                    const addr = BigInt(req.instructionReference) + BigInt(req.offset ?? 0);
                    const rec = this.newRecord('instruction', {
                        instructionReference: req.instructionReference,
                        offset: req.offset,
                        condition: req.condition,
                        hitCondition: req.hitCondition,
                    });
                    await this.createInCdb(rec, `bp${rec.cdbId}${this.conditionClause(req.condition)} 0x${addr.toString(16)}`);
                    result.push(rec);
                }
                await this.verify(result);
                this.instructionBps = result;
                return result;
            });
            response.body = { breakpoints: recs.map((r) => this.toDapBreakpoint(r)) };
            this.sendResponse(response);
        } catch (e) {
            this.sendErrorResponse(response, 1032, errorText(e));
        }
    }

    protected async dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments): Promise<void> {
        try {
            let info: { addr: string; size: number };
            if (args.variablesReference) {
                info = await this.call('dataInfo', { ref: args.variablesReference, name: args.name });
            } else {
                const fr = args.frameId !== undefined ? this.frames.get(args.frameId) : undefined;
                info = await this.call('dataInfo', { expr: args.name, tid: fr?.tid, frame: fr?.index ?? 0 });
            }
            const size = [8, 4, 2, 1].find((s) => s <= info.size) ?? 1;
            response.body = {
                dataId: `${info.addr}:${size}`,
                description: `${args.name} (${size} bytes at 0x${info.addr})`,
                accessTypes: ['write', 'readWrite'],
                canPersist: false,
            };
        } catch (e) {
            response.body = { dataId: null, description: errorText(e) };
        }
        this.sendResponse(response);
    }

    protected async setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments): Promise<void> {
        try {
            const recs = await this.runWhenStopped(async () => {
                await this.deleteFromCdb(this.dataBps);
                const result: BpRecord[] = [];
                for (const req of args.breakpoints) {
                    const [addr, size] = req.dataId.split(':');
                    const access = req.accessType === 'write' || !req.accessType ? 'w' : 'r';
                    const rec = this.newRecord('data', { dataId: req.dataId, accessType: req.accessType, condition: req.condition, hitCondition: req.hitCondition });
                    await this.createInCdb(rec, `ba${rec.cdbId}${this.conditionClause(req.condition)} ${access}${size} 0x${addr}`);
                    result.push(rec);
                }
                await this.verify(result);
                this.dataBps = result;
                return result;
            });
            response.body = { breakpoints: recs.map((r) => this.toDapBreakpoint(r)) };
            this.sendResponse(response);
        } catch (e) {
            this.sendErrorResponse(response, 1033, errorText(e));
        }
    }

    private async applyExceptionPolicy(): Promise<void> {
        for (const c of this.exceptions.sxCommands()) {
            await this.exec(c);
        }
        if (this.consoleShared) {
            // Interrupting an evaluation sends Ctrl+Break to cdb's console, which the target shares:
            // handle the target's Control-Break exception silently so it never sees it.
            await this.exec(`sxi 0x${CONTROL_BREAK_CODE.toString(16)}`);
            await this.exec(`sxe -h 0x${CONTROL_BREAK_CODE.toString(16)}`);
        }
    }

    protected async setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments): Promise<void> {
        this.exceptions.setFilters(args);
        try {
            if (this.cdb) {
                await this.runWhenStopped(() => this.applyExceptionPolicy());
            }
            const count = (args.filters?.length ?? 0) + (args.filterOptions?.length ?? 0);
            response.body = { breakpoints: Array.from({ length: count }, () => ({ verified: true })) };
            this.sendResponse(response);
        } catch (e) {
            this.sendErrorResponse(response, 1034, errorText(e));
        }
    }

    protected exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse): void {
        const x = this.lastException;
        if (!x) {
            this.sendErrorResponse(response, 1040, 'No exception.');
            return;
        }
        response.body = {
            exceptionId: x.category === 'cpp' ? x.typeName ?? 'C++ exception' : `0x${x.id}`,
            description:
                (x.what ?? exceptionName(x.code) ?? x.description) +
                (x.firstChance ? '\n\nTo stop breaking on this exception, use the WinDbg Exceptions view or the notification.' : ''),
            breakMode: x.firstChance ? 'always' : 'unhandled',
            details: {
                message: x.what,
                typeName: x.typeName ?? exceptionName(x.code),
                fullTypeName: x.category === 'cpp' ? x.typeName : `0x${x.id}`,
            },
        };
        this.sendResponse(response);
    }

    // ---------------------------------------------------- stack/threads

    protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {
        if (this.state !== 'stopped' || !this.bridge) {
            response.body = { threads: this.threadsCache };
            this.sendResponse(response);
            return;
        }
        await this.refreshThreads();
        response.body = { threads: this.threadsCache };
        this.sendResponse(response);
    }

    private async refreshThreads(): Promise<void> {
        try {
            const t = await this.inspect<{ threads: ThreadInfo[] }>('threads');
            this.threadsCache = t.threads.map((x) => new Thread(x.id, `${x.name ? x.name : `Thread #${x.index}`} (0x${x.id.toString(16)})`));
            this.threadIndex = new Map(t.threads.map((x) => [x.id, x.index]));
        } catch {
            // keep the previous list
        }
    }

    private toDapFrame(f: FrameInfo, tid: number): DebugProtocol.StackFrame {
        const id = this.nextFrameId++;
        this.frames.set(id, { tid, index: f.i });
        const parsed = parseFrameText(f.text ?? '');
        const module = parsed.module ?? (f.mod ? moduleBaseName(f.mod) : undefined);
        const fn = f.fn ?? parsed.fn;
        let name = fn ? (module ? `${module}!${fn}` : fn) : f.text ?? '<unknown>';
        if (!f.file && parsed.offset) {
            name += `+${parsed.offset}`;
        }
        if (f.inl) {
            name += ' [Inline Frame]';
        }
        const user = this.isUserFrame(f);
        let source: DebugProtocol.Source | undefined;
        if (f.file) {
            const local = this.toLocalPath(f.file);
            source = new Source(path.basename(local), local);
            if (!user) {
                source.presentationHint = 'deemphasize';
            }
        }
        const sf = new StackFrame(id, name, source as Source | undefined, f.line ?? 0, f.file ? 1 : 0) as DebugProtocol.StackFrame;
        if (f.ip) {
            sf.instructionPointerReference = `0x${f.ip}`;
        }
        if (module) {
            sf.moduleId = module;
        }
        if (!user) {
            sf.presentationHint = 'subtle';
        }
        return sf;
    }

    protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {
        if (this.state !== 'stopped') {
            this.sendQuietError(response, 1050, 'The target is running.');
            return;
        }
        try {
            const collapse = this.jmc.enabled && !this.showExternal;
            const start = args.startFrame ?? 0;
            if (collapse && start > 0) {
                response.body = { stackFrames: [], totalFrames: 0 };
                this.sendResponse(response);
                return;
            }
            const levels = collapse ? 1000 : args.levels || 1000;
            const res = await this.inspect<{ frames: FrameInfo[]; total: number }>('stack', { tid: args.threadId, start, levels });
            let frames: DebugProtocol.StackFrame[];
            if (collapse) {
                frames = [];
                let externalRun = false;
                res.frames.forEach((f, idx) => {
                    const user = this.isUserFrame(f);
                    if (user || idx === 0) {
                        frames.push(this.toDapFrame(f, args.threadId));
                        externalRun = false;
                    } else if (!externalRun) {
                        const id = this.nextFrameId++;
                        this.frames.set(id, { tid: args.threadId, index: f.i });
                        const label = new StackFrame(id, '[External Code]') as DebugProtocol.StackFrame;
                        label.presentationHint = 'label';
                        frames.push(label);
                        externalRun = true;
                    }
                });
                response.body = { stackFrames: frames, totalFrames: frames.length };
            } else {
                frames = res.frames.map((f) => this.toDapFrame(f, args.threadId));
                response.body = { stackFrames: frames, totalFrames: res.total };
            }
            this.sendResponse(response);
        } catch (e) {
            this.sendQuietError(response, 1051, errorText(e));
        }
    }

    protected async scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): Promise<void> {
        const fr = this.frames.get(args.frameId);
        if (!fr) {
            response.body = { scopes: [] };
            this.sendResponse(response);
            return;
        }
        try {
            const s = await this.inspect<{ locals: number; registers: number }>('scopes', { tid: fr.tid, frame: fr.index });
            const locals = new Scope('Locals', s.locals, false) as DebugProtocol.Scope;
            locals.presentationHint = 'locals';
            const regs = new Scope('Registers', s.registers, true) as DebugProtocol.Scope;
            regs.presentationHint = 'registers';
            response.body = { scopes: [locals, regs] };
            this.sendResponse(response);
        } catch (e) {
            this.sendQuietError(response, 1060, errorText(e));
        }
    }

    // -------------------------------------------------------- variables

    private toDapVariable(v: BridgeVar): DebugProtocol.Variable {
        const out: DebugProtocol.Variable = { name: v.name, value: v.value, variablesReference: v.ref ?? 0 };
        if (v.type) {
            out.type = v.type;
        }
        if (v.evalName) {
            out.evaluateName = v.evalName;
        }
        if (v.indexed !== undefined) {
            out.indexedVariables = v.indexed;
        }
        if (v.mem) {
            out.memoryReference = `0x${v.mem}`;
        }
        return out;
    }

    protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void> {
        if (this.state !== 'stopped') {
            response.body = { variables: [] };
            this.sendResponse(response);
            return;
        }
        try {
            const res = await this.evaluation<{ vars?: BridgeVar[] } & NoLoadResult>('children', {
                ref: args.variablesReference,
                filter: args.filter,
                start: args.start,
                count: args.count,
                hex: args.format?.hex ?? this.hexDefault,
            });
            this.reportNoLoad(res, undefined);
            if (res.failed !== undefined) {
                throw new Error(res.failed);
            }
            response.body = { variables: (res.vars ?? []).map((v) => this.toDapVariable(v)) };
            this.sendResponse(response);
        } catch (e) {
            this.sendQuietError(response, 1070, errorText(e));
        }
    }

    protected async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): Promise<void> {
        try {
            const v = await this.call<BridgeVar>('setValue', { ref: args.variablesReference, name: args.name, value: args.value, hex: args.format?.hex ?? false });
            response.body = { value: v.value, type: v.type, variablesReference: v.ref ?? 0, indexedVariables: v.indexed };
            this.sendResponse(response);
        } catch (e) {
            this.sendErrorResponse(response, 1071, errorText(e));
        }
    }

    protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
        const fr = args.frameId !== undefined ? this.frames.get(args.frameId) : undefined;
        const text = args.expression.trim();
        if (args.context === 'repl') {
            let command: string | undefined;
            const exec = /^-exec\s+(.*)$/s.exec(text);
            if (exec) {
                command = exec[1];
            } else if (this.args.consoleMode !== 'expressions') {
                const dx = /^dx\s+(?!-)(.+)$/s.exec(text);
                if (!dx) {
                    command = text;
                } else {
                    args = { ...args, expression: dx[1] };
                }
            }
            if (command !== undefined) {
                await this.runConsoleCommand(response, command, fr);
                return;
            }
        }
        if (this.state !== 'stopped') {
            this.sendQuietError(response, 1080, 'The target is running.');
            return;
        }
        try {
            const v = await this.evaluation<BridgeVar & NoLoadResult>('evaluate', {
                tid: fr?.tid ?? this.lastStopTid,
                frame: fr?.index ?? 0,
                expr: args.expression.trim(),
                hex: args.format?.hex ?? this.hexDefault,
                context: args.context,
            });
            this.reportNoLoad(v, args.expression.trim());
            if (v.failed !== undefined) {
                throw new Error(v.failed);
            }
            response.body = {
                result: v.value,
                type: v.type,
                variablesReference: v.ref ?? 0,
                indexedVariables: v.indexed,
                memoryReference: v.mem ? `0x${v.mem}` : undefined,
            };
            this.sendResponse(response);
        } catch (e) {
            this.sendQuietError(response, 1081, errorText(e));
        }
    }

    /**
     * A hover never loads symbols: the extension offers to load the modules it would have needed.
     * Modules loaded anyway (natvis naming another module) are logged, as they explain a slow hover.
     */
    private reportNoLoad(r: NoLoadResult, expression: string | undefined): void {
        if (r.needSymbols && r.needSymbols.length > 0) {
            this.sendEvent(new Event('windbgNeedSymbols', { expression, modules: r.needSymbols }));
        }
        if (r.loadedSymbols && r.loadedSymbols.length > 0) {
            this.log(`Showing ${expression ? `"${expression}"` : 'a hover value'} loaded the symbols of ${r.loadedSymbols.join(', ')} (a natvis visualizer refers to them).`);
        }
    }

    private async runConsoleCommand(response: DebugProtocol.EvaluateResponse, command: string, fr: { tid: number; index: number } | undefined): Promise<void> {
        let run: UserCommand;
        try {
            run = await this.userCommand(command, fr);
        } catch (e) {
            this.sendQuietError(response, 1090, errorText(e));
            return;
        }
        response.body = { result: run.output, variablesReference: 0 };
        this.sendResponse(response);
        await this.afterUserCommand(run);
    }

    /** Runs a WinDbg command typed in the Debug Console or the command window, in the given frame. */
    private async userCommand(command: string, fr: { tid: number; index: number } | undefined): Promise<UserCommand> {
        const kind = executionCommand(command);
        if (kind === 'unsupported') {
            throw new Error(`"${command}" is not supported here; use the debug toolbar.`);
        }
        if (this.state !== 'stopped') {
            throw new Error(kind ? 'The target is running.' : 'The target is running. Pause it to run debugger commands.');
        }
        if (kind) {
            const tid = fr?.tid ?? this.lastStopTid ?? 0;
            // Started once the reply is sent, so the reply comes before the 'continued' event.
            return {
                output: '',
                after: async () => {
                    switch (kind) {
                        case 'continue':
                            this.sendEvent(new ContinuedEvent(tid, true));
                            void this.resume('g');
                            break;
                        case 'next':
                        case 'stepIn':
                        case 'stepOut':
                            this.sendEvent(new ContinuedEvent(tid, true));
                            await this.startStep(kind === 'next' ? 'over' : kind === 'stepIn' ? 'in' : 'out', tid, undefined);
                            break;
                        case 'quit':
                            await this.stopEngine(!/^(qd|.detach)/i.test(command.trim()));
                            this.sendTerminated();
                            break;
                    }
                },
            };
        }
        if (fr) {
            await this.call('switchTo', { tid: fr.tid, frame: fr.index });
        }
        const output = await this.exec(command);
        return {
            output,
            after: async () => {
                // The command may have changed breakpoints or memory.
                await this.call('reset');
                this.sendEvent(new InvalidatedEvent(['variables']));
            },
        };
    }

    private async afterUserCommand(run: UserCommand): Promise<void> {
        try {
            await run.after();
        } catch (e) {
            this.log(`Debugger error: ${errorText(e)}`, 'stderr');
        }
    }

    // ---------------------------------------------- memory/disassembly

    protected async readMemoryRequest(response: DebugProtocol.ReadMemoryResponse, args: DebugProtocol.ReadMemoryArguments): Promise<void> {
        try {
            const addr = BigInt(args.memoryReference) + BigInt(args.offset ?? 0);
            const count = Math.min(args.count, 1024 * 1024);
            const res = await this.call<{ hex: string; unreadable: number }>('readMemory', { addr: addr.toString(16), count });
            response.body = { address: `0x${addr.toString(16)}`, data: Buffer.from(res.hex, 'hex').toString('base64'), unreadableBytes: res.unreadable };
            this.sendResponse(response);
        } catch (e) {
            this.sendErrorResponse(response, 1100, errorText(e));
        }
    }

    protected async writeMemoryRequest(response: DebugProtocol.WriteMemoryResponse, args: DebugProtocol.WriteMemoryArguments): Promise<void> {
        try {
            const addr = BigInt(args.memoryReference) + BigInt(args.offset ?? 0);
            const hex = Buffer.from(args.data, 'base64').toString('hex');
            const res = await this.call<{ written: number }>('writeMemory', { addr: addr.toString(16), hex });
            response.body = { bytesWritten: res.written };
            this.sendResponse(response);
            this.sendEvent(new InvalidatedEvent(['variables']));
        } catch (e) {
            this.sendErrorResponse(response, 1101, errorText(e));
        }
    }

    protected async disassembleRequest(response: DebugProtocol.DisassembleResponse, args: DebugProtocol.DisassembleArguments): Promise<void> {
        try {
            const base = BigInt(args.memoryReference) + BigInt(args.offset ?? 0);
            const before = Math.max(0, -(args.instructionOffset ?? 0));
            const skip = Math.max(0, args.instructionOffset ?? 0);
            const lines: ReturnType<typeof parseDisassembly> = [];
            if (before > 0) {
                const ub = parseDisassembly(await this.exec(`ub 0x${base.toString(16)} L${before}`));
                while (ub.length < before) {
                    ub.unshift({ address: '0', bytes: '', text: '??' });
                }
                lines.push(...ub.slice(-before));
            }
            const after = args.instructionCount - lines.length + skip;
            if (after > 0) {
                const u = parseDisassembly(await this.exec(`u 0x${base.toString(16)} L${after}`));
                lines.push(...u.slice(skip));
            }
            const instructions: DebugProtocol.DisassembledInstruction[] = lines.slice(0, args.instructionCount).map((l) => {
                const ins: DebugProtocol.DisassembledInstruction = {
                    address: l.address === '0' ? '0x0' : `0x${l.address}`,
                    instruction: l.text,
                    instructionBytes: l.bytes,
                };
                if (l.address === '0') {
                    ins.presentationHint = 'invalid';
                }
                if (l.symbol) {
                    ins.symbol = l.symbol;
                }
                if (l.file) {
                    const local = this.toLocalPath(l.file);
                    ins.location = new Source(path.basename(local), local);
                    ins.line = l.line;
                }
                return ins;
            });
            while (instructions.length < args.instructionCount) {
                instructions.push({ address: '0x0', instruction: '??', presentationHint: 'invalid' });
            }
            response.body = { instructions };
            this.sendResponse(response);
        } catch (e) {
            this.sendErrorResponse(response, 1110, errorText(e));
        }
    }

    // -------------------------------------------------------- modules

    private async listModules(inspection = false): Promise<WinDbgModule[]> {
        const raw = await this.engine.bridge.call<RawModule[]>('modules', {}, { inspection });
        let details = new Map<string, ModuleDetails>();
        try {
            details = parseModuleList(await this.exec('lmv', { inspection }));
        } catch (e) {
            if (e instanceof CancelledError) {
                throw e;
            }
            // versions are optional
        }
        const program = this.isAttach || this.isDump ? undefined : this.args.program;
        this.modulesCache = raw.map((m) => toModule(m, details.get(m.base.replace(/^0+(?=.)/, '')), program && path.win32.normalize(program), (name) => this.jmc.isUserModule(name)));
        return this.modulesCache;
    }

    protected async modulesRequest(response: DebugProtocol.ModulesResponse, args: DebugProtocol.ModulesArguments): Promise<void> {
        try {
            let all = this.modulesCache;
            if (this.state === 'stopped' && this.bridge) {
                try {
                    all = await this.listModules(true);
                } catch (e) {
                    if (!(e instanceof CancelledError)) {
                        throw e;
                    }
                }
            }
            const start = args.startModule ?? 0;
            const count = args.moduleCount ? args.moduleCount : all.length;
            response.body = { modules: all.slice(start, start + count), totalModules: all.length };
            this.sendResponse(response);
        } catch (e) {
            this.sendQuietError(response, 1120, errorText(e));
        }
    }

    // --------------------------------------------------------- custom

    protected async customRequest(command: string, response: DebugProtocol.Response, args: any): Promise<void> {
        try {
            switch (command) {
                case 'modules':
                    // Standard DAP request that @vscode/debugadapter does not dispatch itself.
                    await this.modulesRequest(response as DebugProtocol.ModulesResponse, (args ?? {}) as DebugProtocol.ModulesArguments);
                    return;
                case 'parallelStacks': {
                    if (this.state !== 'stopped') {
                        throw new Error('The target is running.');
                    }
                    const res = await this.inspect<{ threads: Array<ThreadInfo & { frames: FrameInfo[] }>; current?: number }>('allStacks', { maxFrames: args?.maxFrames ?? 200 });
                    response.body = {
                        current: this.lastStopTid ?? res.current,
                        threads: res.threads.map((t) => ({
                            id: t.id,
                            index: t.index,
                            name: t.name,
                            frames: t.frames.map((f) => {
                                const parsed = parseFrameText(f.text ?? '');
                                const module = parsed.module ?? (f.mod ? moduleBaseName(f.mod) : undefined);
                                return {
                                    index: f.i,
                                    module,
                                    fn: f.fn ?? parsed.fn ?? f.text,
                                    file: f.file ? this.toLocalPath(f.file) : undefined,
                                    line: f.line,
                                    user: this.isUserFrame(f),
                                };
                            }),
                        })),
                        showExternalCode: this.showExternal || !this.jmc.enabled,
                    };
                    break;
                }
                case 'selectFrame':
                    await this.call('switchTo', { tid: args.threadId, frame: args.frameIndex ?? 0 });
                    response.body = {};
                    break;
                case 'runCommand': {
                    // The command window: like the Debug Console, but always a WinDbg command.
                    const fr = args?.frameId !== undefined ? this.frames.get(args.frameId) : undefined;
                    const run = await this.userCommand(String(args?.command ?? ''), fr);
                    response.body = { output: run.output };
                    this.sendResponse(response);
                    await this.afterUserCommand(run);
                    return;
                }
                case 'commandWindowState': {
                    // Answered from caches: it is asked at every stop, even with the window closed.
                    const fr = args?.frameId !== undefined ? this.frames.get(args.frameId) : undefined;
                    const tid = fr?.tid ?? this.lastStopTid;
                    const index = tid !== undefined ? this.threadIndex.get(tid) : undefined;
                    // After a pause, lastWhere is the break-in thread's, not the reported one's.
                    const top = this.state === 'stopped' && this.lastWhere?.tid === this.lastStopTid ? this.lastWhere?.frames[0] : undefined;
                    response.body = {
                        state: this.isDump && this.state === 'stopped' ? 'dump' : this.state,
                        prompt: this.state === 'stopped' && index !== undefined ? `0:${String(index).padStart(3, '0')}>` : undefined,
                        location: top
                            ? `${(top.text ?? top.fn ?? '').replace(/ \+ /, '+')}${top.file ? ` [${this.toLocalPath(top.file)} @ ${top.line}]` : ''}`
                            : undefined,
                    };
                    break;
                }
                case 'setExceptionOverrides': {
                    this.exceptions.setOverrides(args?.overrides as ExceptionOverride[]);
                    if (this.cdb && this.state !== 'terminated') {
                        await this.runWhenStopped(() => this.applyExceptionPolicy());
                    }
                    response.body = {};
                    break;
                }
                case 'setShowExternalCode':
                    this.showExternal = !!args?.show;
                    response.body = {};
                    this.sendEvent(new InvalidatedEvent(['stacks']));
                    break;
                case 'viewString': {
                    if (this.state !== 'stopped') {
                        throw new Error('The target is running.');
                    }
                    const fr = args?.frameId !== undefined ? this.frames.get(args.frameId) : undefined;
                    const res =
                        args?.variablesReference !== undefined
                            ? await this.inspect<{ text: string }>('viewString', { ref: args.variablesReference, name: args.name })
                            : await this.inspect<{ text: string }>('viewString', { expr: args.expression, tid: fr?.tid ?? this.lastStopTid, frame: fr?.index ?? 0 });
                    response.body = res;
                    break;
                }
                case 'loadSymbols': {
                    // args.module: a module's short name, or undefined for all modules.
                    const target = typeof args?.module === 'string' && args.module ? args.module : '*';
                    const out = await this.runWhenStopped(() => this.exec(`ld ${target}`));
                    response.body = { output: out, modules: await this.runWhenStopped(() => this.listModules()) };
                    break;
                }
                case 'symbolLoadInfo': {
                    // Reloads one module with symbol diagnostics on, like Visual Studio's "Symbol Load Information".
                    const image = String(args?.image ?? '');
                    if (!image) {
                        throw new Error('No module given.');
                    }
                    const out = await this.runWhenStopped(async () => {
                        await this.exec('!sym noisy');
                        try {
                            return await this.exec(`.reload /f ${image.includes(' ') ? `"${image}"` : image}`);
                        } finally {
                            await this.exec(this.args.symbols?.verbose ? '!sym noisy' : '!sym quiet');
                        }
                    });
                    const sympath = await this.runWhenStopped(() => this.exec('.sympath'));
                    response.body = { output: `${sympath}\n\n${out}`, modules: await this.runWhenStopped(() => this.listModules()) };
                    break;
                }
                case 'reloadSymbols': {
                    const out = await this.runWhenStopped(() => this.exec('.reload'));
                    response.body = { output: out };
                    break;
                }
                case 'setHexDisplay':
                    this.hexDefault = !!args?.hex;
                    response.body = {};
                    this.sendEvent(new InvalidatedEvent(['variables']));
                    break;
                default:
                    super.customRequest(command, response, args);
                    return;
            }
            this.sendResponse(response);
        } catch (e) {
            this.sendQuietError(response, 1200, errorText(e));
        }
    }
}
