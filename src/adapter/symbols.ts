import { execFileSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { SymbolOptions } from './types';

export const MICROSOFT_SYMBOL_SERVER = 'https://msdl.microsoft.com/download/symbols';

export function defaultSymbolCache(): string {
    const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'vscode-windbg', 'SymbolCache');
}

/**
 * Builds a dbgeng symbol path:
 *   <exe dir>;<search paths>;srv*<cache>*<server>...;<_NT_SYMBOL_PATH>
 * Flat directories come first so local PDBs win without being copied to the cache.
 */
export function buildSymbolPath(opts: SymbolOptions, programDir?: string, env: NodeJS.ProcessEnv = process.env): string {
    const parts: string[] = [];
    const add = (p: string | undefined) => {
        const t = p?.trim();
        if (t && !parts.some((x) => x.toLowerCase() === t.toLowerCase())) {
            parts.push(t);
        }
    };
    if (programDir) {
        add(programDir);
    }
    for (const p of opts.searchPaths ?? []) {
        add(p);
    }
    const cache = opts.cachePath?.trim() || defaultSymbolCache();
    const servers = [...(opts.servers ?? [])];
    if (opts.useMicrosoftSymbolServer !== false && !servers.some((s) => s.toLowerCase().includes('msdl.microsoft.com'))) {
        servers.push(MICROSOFT_SYMBOL_SERVER);
    }
    for (const s of servers) {
        const t = s.trim();
        if (!t) {
            continue;
        }
        add(/^(srv|symsrv|cache)\*/i.test(t) ? t : `srv*${cache}*${t}`);
    }
    if (servers.length === 0) {
        add(`cache*${cache}`);
    }
    if (opts.inheritNtSymbolPath !== false) {
        for (const p of (env._NT_SYMBOL_PATH ?? '').split(';')) {
            add(p);
        }
    }
    return parts.join(';');
}

/** Drive letters (upper case) mapped to a network share in `net use` output, which is localized: only its shape is read. */
export function parseNetUse(text: string): Set<string> {
    const drives = new Set<string>();
    for (const m of text.matchAll(/(?:^|\s)([A-Za-z]):\s+\\\\/gm)) {
        drives.add(m[1].toUpperCase());
    }
    return drives;
}

/** The drives mapped to a network share, connected or not; `net use` only runs when the path names a drive. */
export function networkDrives(symbolPath: string): Set<string> {
    if (!/(^|[;*])[A-Za-z]:/.test(symbolPath)) {
        return new Set();
    }
    try {
        return parseNetUse(execFileSync('net', ['use'], { encoding: 'latin1', timeout: 5000, windowsHide: true }));
    } catch {
        return new Set();
    }
}

/** A symbol store or directory reached over the network: an http(s) server, a UNC path or a mapped network drive. */
function isRemote(location: string, drives: ReadonlySet<string>): boolean {
    return (
        /^https?:/i.test(location) ||
        location.startsWith('\\\\') ||
        location.startsWith('//') ||
        (/^[A-Za-z]:/.test(location) && drives.has(location[0].toUpperCase()))
    );
}

/**
 * The symbol path used while debugging: `full` without anything reached over the network.
 * `srv*<cache>*<server>` keeps its local cache (`srv*<cache>`), so PDBs downloaded before are
 * still found. Servers are only searched by an explicit load (Load Symbols...).
 */
export function localSymbolPath(full: string, drives: ReadonlySet<string> = new Set()): string {
    const parts: string[] = [];
    for (const raw of full.split(';')) {
        const e = raw.trim();
        let keep: string | undefined;
        const store = /^(srv|symsrv\*[^*]*)\*(.*)$/i.exec(e);
        if (store) {
            const local = store[2].split('*').filter((s) => s.trim() && !isRemote(s.trim(), drives));
            keep = local.length > 0 ? `srv*${local.join('*')}` : undefined;
        } else if (/^cache\*/i.test(e)) {
            keep = isRemote(e.slice(6), drives) ? undefined : e;
        } else if (e && !isRemote(e, drives)) {
            keep = e;
        }
        if (keep && !parts.some((p) => p.toLowerCase() === keep!.toLowerCase())) {
            parts.push(keep);
        }
    }
    return parts.join(';');
}

export function buildSourcePath(sourcePaths: string[] | undefined, sourceServer: boolean | undefined): string | undefined {
    const parts = [...(sourcePaths ?? [])].map((p) => p.trim()).filter((p) => p);
    if (sourceServer) {
        parts.unshift('srv*');
    }
    return parts.length > 0 ? parts.join(';') : undefined;
}
