import { Cdb, ExecOptions } from './cdb';

const MARK_PART = '@@WDBGJSON+@@';
const MARK_END = '@@WDBGJSON.@@';

export class BridgeError extends Error {}

/** Calls operations of dbgscript/vscode_windbg.js inside cdb. */
export class Bridge {
    constructor(private readonly cdb: Cdb) {}

    async load(scriptPath: string): Promise<void> {
        const out = await this.cdb.exec(`.scriptload ${scriptPath}`);
        if (!/successfully loaded/i.test(out)) {
            throw new BridgeError(`Could not load the debugger script ${scriptPath}:\n${out}`);
        }
        const pong = await this.call<string>('ping');
        if (pong !== 'pong') {
            throw new BridgeError('The debugger script did not answer.');
        }
    }

    async call<T>(op: string, args: Record<string, unknown> = {}, options: ExecOptions = {}): Promise<T> {
        const request = JSON.stringify({ op, ...args });
        const hex = Buffer.from(request, 'utf8').toString('hex');
        const out = await this.cdb.exec(`!vscwdbg "${hex}"`, { label: `script ${op}`, ...options });
        // The response comes in chunks because cdb truncates long debugLog lines.
        let json = '';
        let complete = false;
        for (const line of out.split('\n')) {
            const part = line.indexOf(MARK_PART);
            if (part >= 0) {
                json += line.slice(part + MARK_PART.length).replace(/\r$/, '');
            } else if (line.includes(MARK_END)) {
                complete = true;
                break;
            }
        }
        if (!complete) {
            throw new BridgeError(out.trim() || `No answer to ${op}`);
        }
        const res = JSON.parse(json) as { ok: boolean; r?: T; e?: string };
        if (!res.ok) {
            throw new BridgeError(res.e ?? 'error');
        }
        return res.r as T;
    }
}
