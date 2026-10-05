import { DebugProtocol } from '@vscode/debugprotocol';
import { hasWildcard, wildcardMatch } from './glob';
import { ExceptionOverride } from './types';

export const CPP_EXCEPTION_CODE = 0xe06d7363;
export const BREAKPOINT_CODE = 0x80000003;
export const SINGLE_STEP_CODE = 0x80000004;
export const WOW64_BREAKPOINT_CODE = 0x4000001f;
export const WOW64_SINGLE_STEP_CODE = 0x4000001e;
export const SET_THREAD_NAME_CODE = 0x406d1388;
export const ACCESS_VIOLATION_CODE = 0xc0000005;

export interface KnownException {
    code: number;
    name: string;
    /** cdb event filter name, when cdb has one. */
    filter?: string;
}

/** Win32 exceptions the debugger controls individually (the rest use the `*` filter). */
export const KNOWN_WIN32_EXCEPTIONS: KnownException[] = [
    { code: 0xc0000005, name: 'Access violation', filter: 'av' },
    { code: 0xc0000006, name: 'In-page I/O error', filter: 'ip' },
    { code: 0xc0000008, name: 'Invalid handle', filter: 'ch' },
    { code: 0xc000001d, name: 'Illegal instruction', filter: 'ii' },
    { code: 0xc0000025, name: 'Noncontinuable exception' },
    { code: 0xc000008c, name: 'Array bounds exceeded' },
    { code: 0xc000008d, name: 'Floating-point denormal operand' },
    { code: 0xc000008e, name: 'Floating-point division by zero' },
    { code: 0xc000008f, name: 'Floating-point inexact result' },
    { code: 0xc0000090, name: 'Floating-point invalid operation' },
    { code: 0xc0000091, name: 'Floating-point overflow' },
    { code: 0xc0000092, name: 'Floating-point stack check' },
    { code: 0xc0000093, name: 'Floating-point underflow' },
    { code: 0xc0000094, name: 'Integer division by zero', filter: 'dz' },
    { code: 0xc0000095, name: 'Integer overflow', filter: 'iov' },
    { code: 0xc0000096, name: 'Privileged instruction' },
    { code: 0xc00000fd, name: 'Stack overflow', filter: 'sov' },
    { code: 0xc0000374, name: 'Heap corruption' },
    { code: 0xc0000409, name: 'Stack buffer overrun / fail fast', filter: 'sbo' },
    { code: 0xc0000417, name: 'Invalid C runtime parameter' },
    { code: 0xc0000420, name: 'Assertion failure', filter: 'asrt' },
    { code: 0x80000001, name: 'Guard page violation', filter: 'gp' },
    { code: 0x80000002, name: 'Datatype misalignment' },
    { code: 0xe0434352, name: 'CLR exception', filter: 'clr' },
];

export function exceptionName(code: number): string | undefined {
    if (code === CPP_EXCEPTION_CODE) {
        return 'C++ exception';
    }
    if (code === BREAKPOINT_CODE) {
        return 'Breakpoint instruction';
    }
    return KNOWN_WIN32_EXCEPTIONS.find((e) => e.code === code)?.name;
}

export function codeId(code: number): string {
    return (code >>> 0).toString(16).padStart(8, '0');
}

export const EXCEPTION_FILTERS: DebugProtocol.ExceptionBreakpointsFilter[] = [
    {
        filter: 'cpp',
        label: 'C++ Exceptions',
        description: 'Break when a C++ exception is thrown',
        default: false,
        supportsCondition: true,
        conditionDescription: 'Comma-separated type names to break on, e.g. std::runtime_error, MyNs::*',
    },
    {
        filter: 'av',
        label: 'Access Violations',
        description: 'Break when an access violation (0xC0000005) is raised, before any handler runs',
        default: true,
    },
    {
        filter: 'win32',
        label: 'Other Win32 Exceptions',
        description: 'Break when any other structured exception is raised (first chance)',
        default: false,
        supportsCondition: true,
        conditionDescription: 'Comma-separated exception codes to break on, e.g. c0000094, c00000fd',
    },
];

function splitList(text: string | undefined): string[] {
    return (text ?? '')
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter((s) => s);
}

function normalizeCode(text: string): string | undefined {
    const t = text.trim().replace(/^0x/i, '');
    if (!/^[0-9a-f]{1,8}$/i.test(t)) {
        return undefined;
    }
    return codeId(parseInt(t, 16));
}

function typeMatches(pattern: string, typeName: string): boolean {
    const p = pattern.replace(/\s+/g, '');
    const t = typeName.replace(/\s+/g, '');
    return hasWildcard(p) ? wildcardMatch(p, t) : p === t;
}

/** Decides, for every first-chance exception, whether the debugger should stop. */
export class ExceptionPolicy {
    private cpp = false;
    private cppTypes: string[] = [];
    private av = true;
    private win32 = false;
    private win32Codes: string[] = [];
    private overrides: ExceptionOverride[] = [];

    setFilters(args: DebugProtocol.SetExceptionBreakpointsArguments): void {
        const enabled = new Map<string, string | undefined>();
        for (const f of args.filters ?? []) {
            enabled.set(f, undefined);
        }
        for (const o of args.filterOptions ?? []) {
            enabled.set(o.filterId, o.condition);
        }
        this.cpp = enabled.has('cpp');
        this.cppTypes = splitList(enabled.get('cpp'));
        this.av = enabled.has('av');
        this.win32 = enabled.has('win32');
        this.win32Codes = splitList(enabled.get('win32'))
            .map(normalizeCode)
            .filter((c): c is string => c !== undefined);
    }

    setOverrides(overrides: ExceptionOverride[] | undefined): void {
        this.overrides = (overrides ?? []).map((o) => (o.category === 'win32' ? { ...o, id: normalizeCode(o.id) ?? o.id } : o));
    }

    private win32Override(code: number): boolean | undefined {
        const id = codeId(code);
        return this.overrides.find((o) => o.category === 'win32' && o.id === id)?.enabled;
    }

    /** Should a first-chance Win32 exception with this code stop the debugger? */
    breakOnWin32(code: number): boolean {
        const o = this.win32Override(code);
        if (o !== undefined) {
            return o;
        }
        if (code === ACCESS_VIOLATION_CODE) {
            return this.av;
        }
        if (!this.win32) {
            return false;
        }
        return this.win32Codes.length === 0 || this.win32Codes.includes(codeId(code));
    }

    /** Should a thrown C++ exception of this (most derived) type stop the debugger? */
    breakOnCpp(typeName: string | undefined): boolean {
        if (typeName) {
            const o = this.overrides.find((x) => x.category === 'cpp' && typeMatches(x.id, typeName));
            if (o) {
                return o.enabled;
            }
        }
        if (!this.cpp) {
            return false;
        }
        if (this.cppTypes.length === 0) {
            return true;
        }
        return typeName !== undefined && this.cppTypes.some((p) => typeMatches(p, typeName));
    }

    /** True when cdb must report C++ exceptions so the adapter can decide per type. */
    needCppEvents(): boolean {
        return this.cpp || this.overrides.some((o) => o.category === 'cpp' && o.enabled);
    }

    /** cdb `sx` commands that implement this policy. Second-chance exceptions always break. */
    sxCommands(): string[] {
        const cmds: string[] = [];
        cmds.push(this.needCppEvents() ? 'sxe eh' : 'sxd eh');
        for (const e of KNOWN_WIN32_EXCEPTIONS) {
            if (e.code === 0xe0434352) {
                continue;
            }
            const target = e.filter ?? `0x${codeId(e.code)}`;
            cmds.push(`${this.breakOnWin32(e.code) ? 'sxe' : 'sxd'} ${target}`);
        }
        for (const o of this.overrides) {
            if (o.category === 'win32' && !KNOWN_WIN32_EXCEPTIONS.some((e) => codeId(e.code) === o.id)) {
                cmds.push(`${o.enabled ? 'sxe' : 'sxd'} 0x${o.id}`);
            }
        }
        for (const c of this.win32Codes) {
            if (!KNOWN_WIN32_EXCEPTIONS.some((e) => codeId(e.code) === c) && !this.overrides.some((o) => o.category === 'win32' && o.id === c)) {
                cmds.push(`sxe 0x${c}`);
            }
        }
        cmds.push(this.win32 && this.win32Codes.length === 0 ? 'sxe *' : 'sxd *');
        return cmds;
    }
}
