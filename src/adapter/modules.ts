import * as fs from 'fs';
import * as path from 'path';
import { DebugProtocol } from '@vscode/debugprotocol';
import { hasWildcard, wildcardMatch } from './glob';

/** Module as reported by the data model script. */
export interface RawModule {
    name: string;
    base: string;
    size: number;
    symType?: string;
    symFile?: string;
}

/** Per-module details from `lmv`, keyed by base address (hex, no backtick). */
export interface ModuleDetails {
    shortName: string;
    imagePath?: string;
    version?: string;
    timestamp?: string;
}

export type SymbolKind = 'pdb' | 'deferred' | 'export' | 'none';

export interface WinDbgModule extends DebugProtocol.Module {
    /** Name cdb uses for the module in commands (`ld`, `lm m`). */
    shortName: string;
    symbolKind: SymbolKind;
    baseAddress: string;
    size: number;
}

/** Parses `lmv` output into details per module base address. */
export function parseModuleList(text: string): Map<string, ModuleDetails> {
    const map = new Map<string, ModuleDetails>();
    let current: ModuleDetails | undefined;
    for (const raw of text.split(/\r?\n/)) {
        const head = /^([0-9a-f]{8}`?[0-9a-f]{8})\s+[0-9a-f]{8}`?[0-9a-f]{8}\s+(\S+)/i.exec(raw);
        if (head) {
            current = { shortName: head[2] };
            map.set(head[1].replace(/`/g, '').replace(/^0+(?=.)/, ''), current);
            continue;
        }
        if (!current) {
            continue;
        }
        const field = /^\s+([A-Za-z ]+?):\s+(.*)$/.exec(raw);
        if (!field) {
            continue;
        }
        const value = field[2].trim();
        switch (field[1]) {
            case 'Image path':
                current.imagePath = value;
                break;
            case 'File version':
                current.version = value;
                break;
            case 'Timestamp':
                current.timestamp = value;
                break;
        }
    }
    return map;
}

export function symbolKind(symType: string | undefined): SymbolKind {
    const t = (symType ?? '').toLowerCase();
    if (t.startsWith('deferred')) {
        return 'deferred';
    }
    if (t.startsWith('export')) {
        return 'export';
    }
    if (t.startsWith('pdb') || t.includes('dia') || t.includes('codeview') || t.startsWith('sym')) {
        return 'pdb';
    }
    return 'none';
}

export function symbolStatus(kind: SymbolKind, symType: string | undefined): string {
    switch (kind) {
        case 'pdb':
            return /private/i.test(symType ?? '') ? 'Symbols loaded (private PDB)' : /public/i.test(symType ?? '') ? 'Symbols loaded (public PDB)' : 'Symbols loaded';
        case 'deferred':
            return 'Not loaded yet (deferred)';
        case 'export':
            return 'No PDB found (exports only)';
        default:
            return 'No symbols';
    }
}

function exists(p: string): boolean {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

/** cdb reports a few modules (the exe, ntdll) by file name only; find their full path. */
export function resolveImagePath(name: string, details: ModuleDetails | undefined, programPath: string | undefined): string {
    if (path.win32.isAbsolute(name)) {
        return name;
    }
    if (details?.imagePath && path.win32.isAbsolute(details.imagePath)) {
        return details.imagePath;
    }
    const base = path.win32.basename(name).toLowerCase();
    if (programPath && path.win32.basename(programPath).toLowerCase() === base) {
        return programPath;
    }
    const dirs = [programPath ? path.win32.dirname(programPath) : undefined, path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')];
    for (const d of dirs) {
        if (d && exists(path.win32.join(d, name))) {
            return path.win32.join(d, name);
        }
    }
    return name;
}

export function toModule(raw: RawModule, details: ModuleDetails | undefined, programPath: string | undefined, isUser: (shortName: string) => boolean): WinDbgModule {
    const fullPath = resolveImagePath(raw.name, details, programPath);
    const fileName = path.win32.basename(fullPath);
    const shortName = details?.shortName ?? fileName.replace(/\.[^.]+$/, '');
    const kind = symbolKind(raw.symType);
    const base = BigInt('0x' + (raw.base || '0'));
    const m: WinDbgModule = {
        id: raw.base,
        name: fileName,
        path: fullPath,
        shortName,
        baseAddress: raw.base,
        size: raw.size,
        symbolKind: kind,
        symbolStatus: symbolStatus(kind, raw.symType),
        isUserCode: isUser(shortName),
        addressRange: `0x${base.toString(16).padStart(16, '0')}-0x${(base + BigInt(raw.size)).toString(16).padStart(16, '0')}`,
    };
    if (raw.symFile && /\.pdb$/i.test(raw.symFile)) {
        m.symbolFilePath = raw.symFile;
    }
    if (details?.version) {
        m.version = details.version;
    }
    if (details?.timestamp) {
        m.dateTimeStamp = details.timestamp;
    }
    return m;
}

/**
 * The Modules view filter: space-separated terms, a module showing when one matches. A term is a
 * case-insensitive part of the file name or path, or with * and ? wildcards the whole file or short name.
 */
export function moduleMatchesFilter(m: WinDbgModule, filter: string): boolean {
    const terms = filter.trim().split(/\s+/).filter((t) => t);
    if (terms.length === 0) {
        return true;
    }
    const name = m.name.toLowerCase();
    const full = (m.path ?? '').toLowerCase();
    return terms.some((t) =>
        hasWildcard(t) ? wildcardMatch(t, m.name, true) || wildcardMatch(t, m.shortName, true) : name.includes(t.toLowerCase()) || full.includes(t.toLowerCase()),
    );
}
