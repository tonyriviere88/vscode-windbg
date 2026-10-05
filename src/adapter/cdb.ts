import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { stripPrompts } from './parsers';

export interface ExecOptions {
    /** Receives complete output lines while the command runs (used for g/p/t). */
    onLine?: (line: string) => void;
    /** Runs the target (g, p, t, ...): it may take any time, so it is never reported as slow. */
    runsTarget?: boolean;
    /** Only reads state for VS Code: dropped while still queued when the target resumes. */
    inspection?: boolean;
    /** Name used in slow command reports instead of the command text. */
    label?: string;
    /** Interrupts the command (Ctrl+Break) and fails it when it still runs after this long. */
    timeoutMs?: number;
}

/** Rejects a queued command that was dropped before it was sent. */
export class CancelledError extends Error {}

/** Rejects a command that was interrupted because it ran longer than its timeoutMs. */
export class TimeoutError extends Error {}

/** A command that has not finished after this long is reported through the 'slow' event. */
const SLOW_COMMAND_MS = 10000;
/** Interval of the following 'slow' reports for the same command. */
const SLOW_REPEAT_MS = 30000;

interface Pending {
    id: number;
    command: string;
    options: ExecOptions;
    resolve: (output: string) => void;
    reject: (err: Error) => void;
    begun: boolean;
    body: string;
    partial: string;
    sentAt?: number;
    slow?: boolean;
    timedOut?: boolean;
}

/**
 * A cdb.exe child process driven through stdin/stdout.
 *
 * Every command is framed by `.echo` markers so its output can be isolated:
 *
 *   .echo @@WDBG<n>B@@
 *   <command>
 *   .echo @@WDBG<n>E@@
 *
 * Commands run one at a time. While an execution command (g, p, t, ...) is in
 * flight, cdb does not read stdin, so later commands simply wait in the queue.
 *
 * Events: 'slow' (label, elapsedMs, queued) while a command takes long, 'slowDone' (label,
 * elapsedMs) when a command reported as slow finishes, and 'timeout' (label, timeoutMs) when a
 * command is interrupted for running longer than its timeoutMs.
 */
export class Cdb extends EventEmitter {
    private proc: ChildProcess | undefined;
    private queue: Pending[] = [];
    private current: Pending | undefined;
    private seq = 0;
    private buffer = '';
    private exitedFlag = false;
    private slowTimer: NodeJS.Timeout | undefined;
    private timeoutTimer: NodeJS.Timeout | undefined;
    /** Output received before the first command, i.e. the startup banner. */
    public startupOutput = '';

    constructor(
        private readonly log?: (direction: 'in' | 'out', text: string) => void,
        private readonly slowMs = SLOW_COMMAND_MS,
    ) {
        super();
    }

    get exited(): boolean {
        return this.exitedFlag;
    }

    get pid(): number | undefined {
        return this.proc?.pid;
    }

    start(cdbPath: string, commandLine: string, cwd: string | undefined, env: NodeJS.ProcessEnv): void {
        // The command line is passed verbatim so the target's arguments keep their exact quoting.
        this.proc = spawn(cdbPath, [commandLine], {
            argv0: `"${cdbPath}"`,
            cwd,
            env,
            shell: false,
            windowsHide: true,
            windowsVerbatimArguments: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.proc.stdout!.setEncoding('latin1');
        this.proc.stderr!.setEncoding('latin1');
        this.proc.stdout!.on('data', (d: string) => this.onData(d));
        this.proc.stderr!.on('data', (d: string) => {
            this.log?.('out', d);
            this.emit('stderr', d);
        });
        this.proc.on('error', (err) => this.onExit(undefined, err));
        this.proc.on('exit', (code) => this.onExit(code ?? undefined));
        this.proc.stdin!.on('error', () => {
            /* reported through 'exit' */
        });
    }

    /** Runs a command and resolves with its output (prompts removed). */
    exec(command: string, options: ExecOptions = {}): Promise<string> {
        if (this.exitedFlag) {
            return Promise.reject(new Error('The debugger process has exited.'));
        }
        return new Promise<string>((resolve, reject) => {
            this.queue.push({ id: ++this.seq, command, options, resolve, reject, begun: false, body: '', partial: '' });
            this.pump();
        });
    }

    get busy(): boolean {
        return this.current !== undefined;
    }

    /** Rejects the queued inspection commands that were not sent yet; returns how many. */
    cancelInspections(message: string): number {
        const dropped = this.queue.filter((p) => p.options.inspection);
        if (dropped.length === 0) {
            return 0;
        }
        this.queue = this.queue.filter((p) => !p.options.inspection);
        for (const p of dropped) {
            p.reject(new CancelledError(message));
        }
        return dropped.length;
    }

    kill(): void {
        try {
            this.proc?.kill();
        } catch {
            // already gone
        }
    }

    /** Writes raw text to cdb without framing (only used for 'q'). */
    writeRaw(text: string): void {
        if (!this.exitedFlag) {
            this.log?.('in', text);
            this.proc?.stdin?.write(text, 'latin1');
        }
    }

    private pump(): void {
        if (this.current || this.queue.length === 0 || !this.proc) {
            return;
        }
        this.current = this.queue.shift()!;
        const p = this.current;
        const text = `.echo @@WDBG${p.id}B@@\n${p.command}\n.echo @@WDBG${p.id}E@@\n`;
        this.log?.('in', p.command + '\n');
        this.proc.stdin!.write(text, 'latin1');
        this.watch(p);
    }

    private watch(p: Pending): void {
        if (p.options.runsTarget) {
            return;
        }
        p.sentAt = Date.now();
        const schedule = (delay: number) => {
            this.slowTimer = setTimeout(() => {
                p.slow = true;
                this.emit('slow', this.labelOf(p), Date.now() - p.sentAt!, this.queue.length);
                schedule(SLOW_REPEAT_MS);
            }, delay);
            this.slowTimer.unref?.();
        };
        schedule(this.slowMs);
        if (p.options.timeoutMs) {
            this.timeoutTimer = setTimeout(() => {
                if (this.current === p) {
                    p.timedOut = true;
                    this.emit('timeout', this.labelOf(p), p.options.timeoutMs);
                    this.interrupt();
                }
            }, p.options.timeoutMs);
            this.timeoutTimer.unref?.();
        }
    }

    /**
     * Interrupts the running command like Ctrl+Break in a cdb console: dbgeng aborts it (scripts
     * included: "Script execution aborted due to requested interruption") and reads the next one.
     * A Ctrl+Break reaching an idle cdb does nothing. The event goes to every process of cdb's
     * console, the target too when it shares it: the session makes the target ignore it.
     */
    interrupt(): void {
        const pid = this.proc?.pid;
        if (!pid || this.exitedFlag) {
            return;
        }
        // The helper attaches to cdb's console and receives the Ctrl+Break too, which ends it.
        const script =
            `Add-Type -Namespace W -Name C -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool FreeConsole(); ` +
            `[DllImport("kernel32.dll")] public static extern bool AttachConsole(uint p); ` +
            `[DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint e, uint g);'; ` +
            `[W.C]::FreeConsole() | Out-Null; if ([W.C]::AttachConsole(${pid})) { [W.C]::GenerateConsoleCtrlEvent(1, 0) | Out-Null }`;
        spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'ignore' }).on('error', () => {
            // The command keeps running; the 'slow' reports go on.
        });
    }

    private unwatch(p: Pending): void {
        clearTimeout(this.slowTimer);
        this.slowTimer = undefined;
        clearTimeout(this.timeoutTimer);
        this.timeoutTimer = undefined;
        if (p.slow) {
            this.emit('slowDone', this.labelOf(p), Date.now() - p.sentAt!);
        }
    }

    private labelOf(p: Pending): string {
        const text = p.options.label ?? p.command.split('\n')[0];
        return text.length > 80 ? `${text.slice(0, 77)}...` : text;
    }

    private onData(data: string): void {
        this.log?.('out', data);
        this.buffer += data;
        this.process();
    }

    private process(): void {
        for (;;) {
            const p = this.current;
            if (!p) {
                if (this.buffer) {
                    if (this.seq === 0) {
                        this.startupOutput += this.buffer;
                    } else {
                        this.emit('unsolicited', this.buffer);
                    }
                    this.buffer = '';
                }
                return;
            }
            if (!p.begun) {
                const marker = `@@WDBG${p.id}B@@`;
                const idx = this.buffer.indexOf(marker);
                if (idx < 0) {
                    return;
                }
                const nl = this.buffer.indexOf('\n', idx);
                if (nl < 0) {
                    return;
                }
                const before = this.buffer.slice(0, idx);
                if (before.trim()) {
                    if (p.id === 1) {
                        this.startupOutput += before;
                    } else {
                        this.emit('unsolicited', before);
                    }
                }
                this.buffer = this.buffer.slice(nl + 1);
                p.begun = true;
            }
            const endMarker = `@@WDBG${p.id}E@@`;
            const end = this.buffer.indexOf(endMarker);
            if (end < 0) {
                // Stream complete lines to the listener while the command is still running.
                if (p.options.onLine) {
                    const lastNl = this.buffer.lastIndexOf('\n');
                    if (lastNl >= 0) {
                        const chunk = this.buffer.slice(0, lastNl + 1);
                        this.buffer = this.buffer.slice(lastNl + 1);
                        p.body += chunk;
                        for (const line of stripPrompts(chunk).split('\n').slice(0, -1)) {
                            p.options.onLine(line.replace(/\r$/, ''));
                        }
                    }
                }
                return;
            }
            let tail = this.buffer.slice(0, end);
            const nl = this.buffer.indexOf('\n', end);
            this.buffer = nl < 0 ? '' : this.buffer.slice(nl + 1);
            if (p.options.onLine && tail) {
                for (const line of stripPrompts(tail).split('\n')) {
                    if (line.trim()) {
                        p.options.onLine(line.replace(/\r$/, ''));
                    }
                }
            }
            p.body += tail;
            tail = '';
            this.current = undefined;
            this.unwatch(p);
            if (p.timedOut) {
                p.reject(new TimeoutError(`Stopped after ${Math.round(p.options.timeoutMs! / 1000)} s: the debugger was still evaluating it.`));
            } else {
                p.resolve(stripPrompts(p.body).replace(/\r/g, '').replace(/\s+$/, ''));
            }
            this.pump();
        }
    }

    private onExit(code: number | undefined, err?: Error): void {
        if (this.exitedFlag) {
            return;
        }
        this.exitedFlag = true;
        clearTimeout(this.slowTimer);
        clearTimeout(this.timeoutTimer);
        const rest = this.buffer;
        this.buffer = '';
        const failure = new Error(err ? err.message : `The debugger process exited (code ${code ?? 'unknown'}).`);
        const all = this.current ? [this.current, ...this.queue] : [...this.queue];
        this.current = undefined;
        this.queue = [];
        for (const p of all) {
            (failure as Error & { output?: string }).output = stripPrompts(p.body + rest);
            p.reject(failure);
        }
        if (this.seq === 0 || all.some((p) => p.id === 1)) {
            this.startupOutput += rest;
        }
        this.emit('exit', code, err);
    }
}
