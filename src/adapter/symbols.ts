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

export function buildSourcePath(sourcePaths: string[] | undefined, sourceServer: boolean | undefined): string | undefined {
    const parts = [...(sourcePaths ?? [])].map((p) => p.trim()).filter((p) => p);
    if (sourceServer) {
        parts.unshift('srv*');
    }
    return parts.length > 0 ? parts.join(';') : undefined;
}
