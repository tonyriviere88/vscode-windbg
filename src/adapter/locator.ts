import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function archDir(): { kits: string; app: string } {
    switch (os.arch()) {
        case 'arm64':
            return { kits: 'arm64', app: 'arm64' };
        case 'ia32':
            return { kits: 'x86', app: 'x86' };
        default:
            return { kits: 'x64', app: 'amd64' };
    }
}

function isFile(p: string): boolean {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

/** Candidate cdb.exe locations, most specific first. */
export function cdbCandidates(configured?: string): string[] {
    const out: string[] = [];
    if (configured) {
        out.push(configured.toLowerCase().endsWith('.exe') ? configured : path.join(configured, 'cdb.exe'));
    }
    const arch = archDir();
    for (const root of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, 'C:\\Program Files (x86)', 'C:\\Program Files']) {
        if (root) {
            out.push(path.join(root, 'Windows Kits', '10', 'Debuggers', arch.kits, 'cdb.exe'));
        }
    }
    // WinDbg from the Microsoft Store ships its own cdb.exe.
    const apps = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'WindowsApps');
    try {
        const dirs = fs
            .readdirSync(apps)
            .filter((d) => d.toLowerCase().startsWith('microsoft.windbg_'))
            .sort()
            .reverse();
        for (const d of dirs) {
            out.push(path.join(apps, d, arch.app, 'cdb.exe'));
        }
    } catch {
        // WindowsApps is usually not listable; ignore.
    }
    for (const dir of (process.env.PATH ?? '').split(';')) {
        if (dir) {
            out.push(path.join(dir, 'cdb.exe'));
        }
    }
    return out;
}

export function locateCdb(configured?: string): string | undefined {
    if (configured) {
        const explicit = cdbCandidates(configured)[0];
        return isFile(explicit) ? explicit : undefined;
    }
    return cdbCandidates().find(isFile);
}

export function locateBreakin(cdbPath: string): string | undefined {
    const p = path.join(path.dirname(cdbPath), 'breakin.exe');
    return isFile(p) ? p : undefined;
}
