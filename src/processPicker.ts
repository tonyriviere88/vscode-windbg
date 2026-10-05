import { execFile } from 'child_process';
import * as vscode from 'vscode';

interface ProcessEntry {
    name: string;
    pid: number;
    session: string;
    memory: string;
}

function parseCsvLine(line: string): string[] {
    const out: string[] = [];
    const re = /"([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
        out.push(m[1]);
    }
    return out;
}

function listProcesses(): Promise<ProcessEntry[]> {
    return new Promise((resolve, reject) => {
        execFile('tasklist.exe', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
            if (err) {
                reject(err);
                return;
            }
            const entries: ProcessEntry[] = [];
            for (const line of stdout.split(/\r?\n/)) {
                const cols = parseCsvLine(line);
                if (cols.length >= 5) {
                    entries.push({ name: cols[0], pid: parseInt(cols[1], 10), session: cols[2], memory: cols[4] });
                }
            }
            resolve(entries);
        });
    });
}

/** Lets the user choose a process; returns its id as a string (for ${command:windbg.pickProcess}). */
export async function pickProcess(): Promise<string | undefined> {
    let processes: ProcessEntry[];
    try {
        processes = await listProcesses();
    } catch (e) {
        void vscode.window.showErrorMessage(`Cannot list processes: ${(e as Error).message}`);
        return undefined;
    }
    const items = processes
        .filter((p) => p.pid !== 0 && p.pid !== process.pid)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => ({ label: p.name, description: `${p.pid}`, detail: `Session: ${p.session}    Memory: ${p.memory}`, pid: p.pid }));
    const pick = await vscode.window.showQuickPick(items, { title: 'Attach WinDbg to process', matchOnDescription: true, matchOnDetail: false, placeHolder: 'Process name or id' });
    return pick ? String(pick.pid) : undefined;
}
