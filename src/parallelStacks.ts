import * as vscode from 'vscode';
import { PsThread, buildParallelStacks } from './parallelStacksModel';

interface ParallelStacksResponse {
    current?: number;
    threads: PsThread[];
    showExternalCode: boolean;
}

const frameHighlight = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.focusedStackFrameHighlightBackground'),
});

/** The "Parallel Stacks" window: one box per group of threads sharing a call path. */
export class ParallelStacksPanel {
    private static instance: ParallelStacksPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private showExternal = false;

    static show(extensionUri: vscode.Uri): void {
        if (ParallelStacksPanel.instance) {
            ParallelStacksPanel.instance.panel.reveal(vscode.ViewColumn.Beside, true);
            void ParallelStacksPanel.instance.refresh();
            return;
        }
        ParallelStacksPanel.instance = new ParallelStacksPanel(extensionUri);
    }

    static refreshIfOpen(): void {
        void ParallelStacksPanel.instance?.refresh();
    }

    static setRunning(): void {
        void ParallelStacksPanel.instance?.panel.webview.postMessage({ type: 'running' });
    }

    private constructor(private readonly extensionUri: vscode.Uri) {
        this.panel = vscode.window.createWebviewPanel('windbg.parallelStacks', 'Parallel Stacks', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
        });
        this.panel.webview.html = this.html();
        this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
        this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), undefined, this.disposables);
        vscode.debug.onDidChangeActiveDebugSession(() => this.refresh(), undefined, this.disposables);
    }

    private dispose(): void {
        ParallelStacksPanel.instance = undefined;
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables = [];
    }

    private session(): vscode.DebugSession | undefined {
        const s = vscode.debug.activeDebugSession;
        return s && s.type === 'windbg' ? s : undefined;
    }

    async refresh(): Promise<void> {
        const session = this.session();
        if (!session) {
            void this.panel.webview.postMessage({ type: 'empty', text: 'No WinDbg debug session is active.' });
            return;
        }
        try {
            const res = (await session.customRequest('parallelStacks', { maxFrames: 256 })) as ParallelStacksResponse;
            const show = this.showExternal || res.showExternalCode;
            const roots = buildParallelStacks(res.threads, show);
            const names: Record<number, string> = {};
            for (const t of res.threads) {
                names[t.id] = t.name ? `${t.name} (0x${t.id.toString(16)})` : `Thread #${t.index} (0x${t.id.toString(16)})`;
            }
            void this.panel.webview.postMessage({ type: 'graph', roots, current: res.current, names, showExternal: this.showExternal });
        } catch (e) {
            void this.panel.webview.postMessage({ type: 'empty', text: (e as Error).message });
        }
    }

    private async onMessage(m: { type: string; threadId?: number; frameIndex?: number; file?: string; line?: number; show?: boolean }): Promise<void> {
        if (m.type === 'ready' || m.type === 'refresh') {
            await this.refresh();
            return;
        }
        if (m.type === 'showExternal') {
            this.showExternal = !!m.show;
            await this.refresh();
            return;
        }
        if (m.type === 'select') {
            const session = this.session();
            if (session && m.threadId !== undefined) {
                try {
                    await session.customRequest('selectFrame', { threadId: m.threadId, frameIndex: m.frameIndex ?? 0 });
                } catch {
                    // the frame may be gone
                }
            }
            if (m.file && m.line) {
                try {
                    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(m.file));
                    const range = new vscode.Range(m.line - 1, 0, m.line - 1, 0);
                    const editor = await vscode.window.showTextDocument(doc, { selection: range, viewColumn: vscode.ViewColumn.One, preserveFocus: false });
                    editor.setDecorations(frameHighlight, [range]);
                    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                } catch (e) {
                    void vscode.window.showWarningMessage(`Cannot open ${m.file}: ${(e as Error).message}`);
                }
            }
        }
    }

    private html(): string {
        const webview = this.panel.webview;
        const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'parallelStacks.js'));
        const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'parallelStacks.css'));
        const nonce = Math.random().toString(36).slice(2);
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style}" rel="stylesheet">
<title>Parallel Stacks</title>
</head>
<body>
<div class="toolbar">
  <label><input type="checkbox" id="showExternal"> Show External Code</label>
  <button id="refresh" title="Refresh">Refresh</button>
  <span id="status"></span>
</div>
<div id="stage">
  <div id="viewport"><div id="canvas"></div></div>
  <div id="minimap" hidden><canvas id="minimapGraph"></canvas><div id="minimapView"></div></div>
</div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
    }
}
