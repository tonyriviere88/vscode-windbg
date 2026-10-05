// Stands in for cdb.exe in the Cdb queue tests. Like cdb, it reads the next line only when the
// previous command is done: `.echo <text>` prints <text>, `sleep <ms>` is a command that takes time.
import * as readline from 'readline';

const lines: string[] = [];
let busy = false;

async function drain(): Promise<void> {
    if (busy) {
        return;
    }
    busy = true;
    while (lines.length > 0) {
        const line = lines.shift()!.trim();
        const sleep = /^sleep (\d+)$/.exec(line);
        if (sleep) {
            await new Promise((r) => setTimeout(r, Number(sleep[1])));
        } else if (line.startsWith('.echo ')) {
            process.stdout.write(`${line.slice(6)}\n`);
        } else if (line === 'q') {
            process.exit(0);
        } else {
            process.stdout.write(`ran ${line}\n`);
        }
    }
    process.stdout.write('0:000> ');
    busy = false;
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
    lines.push(line);
    void drain();
});
