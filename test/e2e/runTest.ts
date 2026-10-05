import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

// Runs the extension inside VS Code against test/sample.
// Uses the VS Code given by VSCODE_EXECUTABLE, or downloads one.
async function main(): Promise<void> {
    const root = path.resolve(__dirname, '..', '..', '..');
    // When started from a VS Code terminal or extension host, Code.exe would otherwise run as plain Node.
    delete process.env.ELECTRON_RUN_AS_NODE;
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'windbg-e2e-'));
    try {
        await runTests({
            vscodeExecutablePath: process.env.VSCODE_EXECUTABLE || undefined,
            extensionDevelopmentPath: root,
            extensionTestsPath: path.join(__dirname, 'suite.js'),
            launchArgs: [path.join(root, 'test', 'sample'), '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--user-data-dir', userData],
        });
    } finally {
        fs.rmSync(userData, { recursive: true, force: true });
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
