/** Parsers for cdb's textual output. */

export type LastEvent =
    | { kind: 'breakpoint'; id: number; pid?: number; tid?: number }
    | { kind: 'exception'; code: number; description: string; firstChance: boolean; pid?: number; tid?: number }
    | { kind: 'exit'; exitCode: number }
    | { kind: 'none' }
    | { kind: 'other'; text: string; pid?: number; tid?: number };

const PROMPT = /^(\|\|\d+:)?\d+:\d+(:[A-Za-z0-9_]+)?> /;

/** Removes the "0:000> " prompts cdb prints in front of command output. */
export function stripPrompts(text: string): string {
    return text
        .split(/\r?\n/)
        .map((l) => {
            let line = l;
            while (PROMPT.test(line)) {
                line = line.replace(PROMPT, '');
            }
            return line;
        })
        .join('\n');
}

export function parseLastEvent(text: string): LastEvent {
    const m = /Last event:\s*(.*)/.exec(text);
    if (!m) {
        return { kind: 'none' };
    }
    const body = m[1].trim();
    if (body.startsWith('<no event>')) {
        return { kind: 'none' };
    }
    const exit = /Exit process [0-9a-f]+:[0-9a-f]+, code ([0-9a-f]+)/i.exec(body);
    if (exit) {
        return { kind: 'exit', exitCode: parseInt(exit[1], 16) | 0 };
    }
    let pid: number | undefined;
    let tid: number | undefined;
    let rest = body;
    const ids = /^([0-9a-f]+)\.([0-9a-f]+):\s*(.*)$/i.exec(body);
    if (ids) {
        pid = parseInt(ids[1], 16);
        tid = parseInt(ids[2], 16);
        rest = ids[3];
    }
    const bp = /Hit breakpoint (\d+)/i.exec(rest);
    if (bp) {
        return { kind: 'breakpoint', id: parseInt(bp[1], 10), pid, tid };
    }
    const ex = /^(.*?)\s*-\s*code ([0-9a-f]+) \((first|second|!!! second) chance(?: !!!)?\)/i.exec(rest);
    if (ex) {
        return {
            kind: 'exception',
            code: parseInt(ex[2], 16) >>> 0,
            description: ex[1].trim(),
            firstChance: ex[3].toLowerCase() === 'first',
            pid,
            tid,
        };
    }
    return { kind: 'other', text: rest, pid, tid };
}

export interface ExceptionRecord {
    address?: string;
    code?: number;
    flags?: number;
    params: string[];
}

export function parseExceptionRecord(text: string): ExceptionRecord {
    const rec: ExceptionRecord = { params: [] };
    const addr = /ExceptionAddress:\s*([0-9a-f`]+)/i.exec(text);
    if (addr) {
        rec.address = addr[1].replace(/`/g, '');
    }
    const code = /ExceptionCode:\s*([0-9a-f]+)/i.exec(text);
    if (code) {
        rec.code = parseInt(code[1], 16) >>> 0;
    }
    const flags = /ExceptionFlags:\s*([0-9a-f]+)/i.exec(text);
    if (flags) {
        rec.flags = parseInt(flags[1], 16);
    }
    const re = /Parameter\[(\d+)\]:\s*([0-9a-f`]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
        rec.params[parseInt(m[1], 10)] = m[2].replace(/`/g, '');
    }
    return rec;
}

export interface BreakpointListEntry {
    id: number;
    enabled: boolean;
    unresolved: boolean;
    address?: string;
    file?: string;
    line?: number;
    symbol?: string;
}

/** Parses `bl` output (with `.lines -e`). */
export function parseBreakpointList(text: string): Map<number, BreakpointListEntry> {
    const map = new Map<number, BreakpointListEntry>();
    for (const raw of text.split(/\r?\n/)) {
        const m = /^\s*(\d+)\s+([ed])(u?)\s+(.*)$/.exec(raw);
        if (!m) {
            continue;
        }
        const entry: BreakpointListEntry = {
            id: parseInt(m[1], 10),
            enabled: m[2] === 'e',
            unresolved: m[3] === 'u',
        };
        const rest = m[4];
        if (!entry.unresolved) {
            const a = /^([0-9a-f]{8}`?[0-9a-f]{0,8})/i.exec(rest);
            if (a) {
                entry.address = a[1].replace(/`/g, '');
            }
            const src = /\[(.+) @ (\d+)\]/.exec(rest);
            if (src) {
                entry.file = src[1];
                entry.line = parseInt(src[2], 10);
            }
            const sym = /\d+:\*{4}\s+(\S+)/.exec(rest);
            if (sym) {
                entry.symbol = sym[1];
            }
        }
        map.set(entry.id, entry);
    }
    return map;
}

/** Parses the first line of `ln` output, e.g. "D:\src\a.cpp(35)". */
export function parseLnSourceLine(text: string): { file: string; line: number } | undefined {
    for (const raw of text.split(/\r?\n/)) {
        const m = /^\s*(.+)\((\d+)\)\s*(\+0x[0-9a-f]+)?\s*$/i.exec(raw);
        if (m && !m[1].startsWith('(')) {
            return { file: m[1], line: parseInt(m[2], 10) };
        }
    }
    return undefined;
}

export interface DisassemblyLine {
    address: string;
    bytes: string;
    text: string;
    symbol?: string;
    file?: string;
    line?: number;
}

/** Parses `u` / `ub` output. Symbol headers apply to the instructions that follow. */
export function parseDisassembly(text: string): DisassemblyLine[] {
    const out: DisassemblyLine[] = [];
    let symbol: string | undefined;
    let file: string | undefined;
    let line: number | undefined;
    let fresh = false;
    for (const raw of text.split(/\r?\n/)) {
        const header = /^(\S.*?)(?:\s+\[(.+) @ (\d+)\])?:\s*$/.exec(raw);
        const instr = /^([0-9a-f]{8}`[0-9a-f]{8}|[0-9a-f]{8,16})\s+([0-9a-f]+)\s+(.*)$/i.exec(raw);
        if (instr) {
            const entry: DisassemblyLine = {
                address: instr[1].replace(/`/g, ''),
                bytes: instr[2],
                text: instr[3].replace(/\s+/g, ' ').trim(),
            };
            if (fresh) {
                entry.symbol = symbol;
                entry.file = file;
                entry.line = line;
                fresh = false;
            }
            out.push(entry);
        } else if (header && !raw.startsWith(' ')) {
            symbol = header[1];
            file = header[2];
            line = header[3] ? parseInt(header[3], 10) : undefined;
            fresh = true;
        }
    }
    return out;
}

/** "sample!app::compute + 0x82" -> { module: "sample", fn: "app::compute", offset: "0x82" } */
export function parseFrameText(text: string): { module?: string; fn?: string; offset?: string } {
    const m = /^([^!\s]+)!(.*?)(?:\s*\+\s*(0x[0-9a-f]+))?$/i.exec(text.trim());
    if (!m) {
        return {};
    }
    return { module: m[1], fn: m[2], offset: m[3] };
}

export type HitCondition = { op: '==' | '>=' | '>' | '<' | '<=' | '%'; value: number };

/** Hit count expressions: "5" or "==5" (exactly), ">=5", ">5", "<5", "<=5", "%5" (every 5th hit). */
export function parseHitCondition(text: string | undefined): HitCondition | undefined {
    if (!text || !text.trim()) {
        return undefined;
    }
    const m = /^\s*(==|=|>=|<=|>|<|%)?\s*(\d+)\s*$/.exec(text);
    if (!m) {
        return undefined;
    }
    const op = (m[1] === '=' || !m[1] ? '==' : m[1]) as HitCondition['op'];
    return { op, value: parseInt(m[2], 10) };
}

export function hitConditionSatisfied(cond: HitCondition, hits: number): boolean {
    switch (cond.op) {
        case '==':
            return hits === cond.value;
        case '>=':
            return hits >= cond.value;
        case '>':
            return hits > cond.value;
        case '<':
            return hits < cond.value;
        case '<=':
            return hits <= cond.value;
        case '%':
            return cond.value > 0 && hits % cond.value === 0;
    }
}

/** Splits a logpoint message into literal text and {expression} parts. */
export function parseLogMessage(message: string): Array<{ text: string } | { expr: string }> {
    const parts: Array<{ text: string } | { expr: string }> = [];
    let i = 0;
    let literal = '';
    while (i < message.length) {
        const ch = message[i];
        if (ch === '{' && message[i + 1] === '{') {
            literal += '{';
            i += 2;
        } else if (ch === '}' && message[i + 1] === '}') {
            literal += '}';
            i += 2;
        } else if (ch === '{') {
            let depth = 1;
            let j = i + 1;
            while (j < message.length && depth > 0) {
                if (message[j] === '{') {
                    depth++;
                } else if (message[j] === '}') {
                    depth--;
                }
                j++;
            }
            if (depth !== 0) {
                literal += message.slice(i);
                break;
            }
            if (literal) {
                parts.push({ text: literal });
                literal = '';
            }
            parts.push({ expr: message.slice(i + 1, j - 1).trim() });
            i = j;
        } else {
            literal += ch;
            i++;
        }
    }
    if (literal) {
        parts.push({ text: literal });
    }
    return parts;
}

/** cdb commands that resume or end execution; they are not allowed as raw console commands. */
export function executionCommand(cmd: string): 'continue' | 'next' | 'stepIn' | 'stepOut' | 'quit' | 'unsupported' | undefined {
    const c = cmd.trim();
    if (/^(g|gh|gn)(\s|$)/i.test(c)) {
        return 'continue';
    }
    if (/^p(\s|$)/i.test(c)) {
        return 'next';
    }
    if (/^t(\s|$)/i.test(c)) {
        return 'stepIn';
    }
    if (/^gu(\s|$)/i.test(c)) {
        return 'stepOut';
    }
    if (/^(q|qq|qd|\.kill|\.detach)(\s|$)/i.test(c)) {
        return 'quit';
    }
    if (/^(pa|pc|pct|ph|pt|ta|tb|tc|tct|th|tt|wt|\.restart|\.create|\.attach)(\s|$)/i.test(c)) {
        return 'unsupported';
    }
    return undefined;
}
